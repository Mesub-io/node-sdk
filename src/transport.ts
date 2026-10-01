import { MesubError, codeForStatus } from './errors.js';
import { VERSION } from './version.js';

export type QueryValue = string | number | boolean | undefined;

export interface TransportConfig {
    apiKey: string;
    baseUrl: string;
    fetch: typeof fetch;
    timeout: number;
    maxRetries: number;
}

/** What one call may change from the client's configuration. */
export interface CallOptions {
    maxRetries?: number;
    /**
     * Epoch ms by which the call settles, retries and waits included: each
     * attempt is cut at it, and a wait that would outlast it is not waited.
     */
    deadline?: number;
}

/** The errors of calls that gave up because their deadline came, not because Mesub said no. */
const outOfTime = new WeakSet<MesubError>();

/** Whether a call gave up on its deadline, rather than on Mesub's answer. */
export function ranOutOfTime(error: unknown): boolean {
    return error instanceof MesubError && outOfTime.has(error);
}

function givenUp(error: MesubError): MesubError {
    outOfTime.add(error);
    return error;
}

const INITIAL_RETRY_DELAY = 500;
const MAX_RETRY_DELAY = 8_000;
const MAX_RETRY_AFTER = 60_000;

type Attempt =
    | { ok: true; body: unknown }
    | { ok: false; error: MesubError; retry: boolean; retryAfter: number | null };

/** @internal Authenticated JSON calls to the Mesub API, with timeouts and retries. */
export class Transport {
    readonly #config: TransportConfig;

    constructor(config: TransportConfig) {
        this.#config = config;
    }

    async get(
        path: string,
        query: Record<string, QueryValue> = {},
        options: CallOptions = {},
    ): Promise<unknown> {
        const url = new URL(this.#config.baseUrl + path);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const maxRetries = options.maxRetries ?? this.#config.maxRetries;
        const { deadline } = options;

        for (let retry = 0; ; retry++) {
            const attempt = await this.#attempt(url, deadline);
            if (attempt.ok) return attempt.body;
            if (!attempt.retry || retry >= maxRetries) throw attempt.error;

            const wait = attempt.retryAfter ?? backoff(retry);
            // Not even a Retry-After is waited past the deadline: the caller
            // falls back now rather than at the end of a wait it cannot afford.
            if (deadline !== undefined && Date.now() + wait >= deadline) {
                throw givenUp(attempt.error);
            }
            await sleep(wait);
        }
    }

    async #attempt(url: URL, deadline: number | undefined): Promise<Attempt> {
        const left = deadline === undefined ? Infinity : deadline - Date.now();

        if (left <= 0) {
            const error = new MesubError('No time was left to call Mesub.', {
                status: null,
                code: 'unavailable',
            });
            return { ok: false, error: givenUp(error), retry: false, retryAfter: null };
        }

        // Cut at the deadline when it comes before the attempt's own timeout.
        const timeout = Math.min(this.#config.timeout, left);
        const cutByDeadline = timeout < this.#config.timeout;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await this.#config.fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.#config.apiKey}`,
                    Accept: 'application/json',
                    'User-Agent': `@mesub/node/${VERSION}`,
                },
                signal: controller.signal,
            });
            const text = await response.text();

            if (response.ok) {
                try {
                    return { ok: true, body: JSON.parse(text) };
                } catch (cause) {
                    const error = new MesubError('Mesub answered with a body that is not JSON.', {
                        status: response.status,
                        code: 'unexpected',
                        cause,
                    });
                    return { ok: false, error, retry: false, retryAfter: null };
                }
            }

            const error =
                response.status === 404 && !isMesubErrorBody(text)
                    ? new MesubError(
                          `${url.pathname} answered 404 with no Mesub error: is baseUrl ` +
                              `(${this.#config.baseUrl}) the Mesub API?`,
                          { status: 404, code: 'unexpected' },
                      )
                    : new MesubError(messageFrom(text, response.status), {
                          status: response.status,
                          code: codeForStatus(response.status),
                      });
            return {
                ok: false,
                error,
                retry: shouldRetry(response),
                retryAfter: retryAfter(response.headers.get('retry-after')),
            };
        } catch (cause) {
            if (controller.signal.aborted && cutByDeadline) {
                const error = new MesubError(
                    `Mesub did not answer within the ${Math.round(timeout)} ms left before the deadline.`,
                    { status: null, code: 'unavailable', cause },
                );
                return { ok: false, error: givenUp(error), retry: false, retryAfter: null };
            }

            const message = controller.signal.aborted
                ? `Mesub did not answer within ${this.#config.timeout} ms.`
                : `Could not reach Mesub: ${cause instanceof Error ? cause.message : String(cause)}`;
            const error = new MesubError(message, { status: null, code: 'unavailable', cause });
            return { ok: false, error, retry: true, retryAfter: null };
        } finally {
            clearTimeout(timer);
        }
    }
}

// Same rules as the Stainless-generated clients (OpenAI, Anthropic).
function shouldRetry(response: Response): boolean {
    const header = response.headers.get('x-should-retry');
    if (header === 'true') return true;
    if (header === 'false') return false;
    const { status } = response;
    return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Milliseconds from a `Retry-After` in seconds or as an HTTP date, capped. */
function retryAfter(header: string | null): number | null {
    if (header === null || header.trim() === '') return null;
    const seconds = Number(header);
    const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
    if (Number.isNaN(ms) || ms < 0) return null;
    return Math.min(ms, MAX_RETRY_AFTER);
}

/** 500 ms, then 1 s, ... up to 8 s, minus up to 25% of jitter. */
function backoff(retry: number): number {
    const delay = Math.min(INITIAL_RETRY_DELAY * 2 ** retry, MAX_RETRY_DELAY);
    return delay * (1 - Math.random() * 0.25);
}

/** The NestJS error body is `{ message, error, statusCode }`, `message` a string or a list. */
function messageFrom(text: string, status: number): string {
    const fallback = `Mesub answered with HTTP ${status}.`;
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return fallback;
    }
    if (typeof body !== 'object' || body === null) return fallback;

    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message !== '') return message;
    if (Array.isArray(message)) {
        const parts = message.filter((part): part is string => typeof part === 'string');
        if (parts.length > 0) return parts.join('; ');
    }
    if (typeof error === 'string' && error !== '') return error;
    return fallback;
}

/**
 * Whether a 404 came from the Mesub API rather than from whatever else lives
 * at a wrong `baseUrl`: a JSON error body, as Nest writes it (`statusCode`
 * and `message`) or with a `code`. Nest's own answer for a route it does not
 * have (`Cannot GET /api/v1/access`) is not one: a path prefix too many.
 */
function isMesubErrorBody(text: string): boolean {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return false;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;

    const { code, statusCode, message } = body as Record<string, unknown>;
    if (typeof code === 'string') return true;
    if (typeof statusCode !== 'number') return false;

    return !(typeof message === 'string' && /^Cannot [A-Z]+ \//.test(message));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
