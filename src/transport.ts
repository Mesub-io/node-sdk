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

/** What any one call may set for itself. */
export interface RequestOptions {
    /** Per attempt, in milliseconds. Defaults to the client's `timeout`. */
    timeout?: number;
    /**
     * Stops the call, and any wait for a retry: it then rejects with the
     * signal's reason, and is never sent again.
     */
    signal?: AbortSignal;
}

/** What one GET may change from the client's configuration. */
export interface CallOptions extends RequestOptions {
    maxRetries?: number;
    /**
     * Epoch ms by which the call settles, retries and waits included: each
     * attempt is cut at it, and a wait that would outlast it is not waited.
     */
    deadline?: number;
}

const INITIAL_RETRY_DELAY = 500;
const MAX_RETRY_DELAY = 8_000;
const MAX_RETRY_AFTER = 60_000;

type Method = 'GET' | 'POST';

type ErrorBody = Record<string, unknown>;

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
        return this.#send('GET', url, undefined, options);
    }

    /**
     * A POST with a JSON body, sent once: never retried, whatever the status,
     * a timeout or a network error. A write that got no answer may still have
     * been done, so its caller reads the state back rather than sends it again.
     */
    async post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
        return this.#send('POST', new URL(this.#config.baseUrl + path), body, options);
    }

    async #send(method: Method, url: URL, body: unknown, options: CallOptions): Promise<unknown> {
        const maxRetries = method === 'POST' ? 0 : (options.maxRetries ?? this.#config.maxRetries);
        const { deadline, signal } = options;

        for (let retry = 0; ; retry++) {
            const attempt = await this.#attempt(method, url, body, options);
            if (attempt.ok) return attempt.body;
            if (!attempt.retry || retry >= maxRetries) throw attempt.error;

            const wait = attempt.retryAfter ?? backoff(retry);
            // Not even a Retry-After is waited past the deadline: the caller
            // falls back now rather than at the end of a wait it cannot afford.
            if (deadline !== undefined && Date.now() + wait >= deadline) {
                throw attempt.error;
            }
            await sleep(wait, signal);
        }
    }

    async #attempt(
        method: Method,
        url: URL,
        body: unknown,
        { deadline, signal, ...options }: CallOptions,
    ): Promise<Attempt> {
        // The caller's abort is theirs to handle: thrown as is, never retried.
        signal?.throwIfAborted();

        const perAttempt = options.timeout ?? this.#config.timeout;
        const left = deadline === undefined ? Infinity : deadline - Date.now();

        if (left <= 0) {
            const error = new MesubError('No time was left to call Mesub.', {
                status: null,
                code: 'unavailable',
            });
            return { ok: false, error, retry: false, retryAfter: null };
        }

        // Cut at the deadline when it comes before the attempt's own timeout.
        const timeout = Math.min(perAttempt, left);
        const cutByDeadline = timeout < perAttempt;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const stop = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', stop, { once: true });

        try {
            const response = await this.#config.fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${this.#config.apiKey}`,
                    Accept: 'application/json',
                    'User-Agent': `@mesub/node/${VERSION}`,
                    ...(body !== undefined && { 'Content-Type': 'application/json' }),
                },
                ...(body !== undefined && { body: JSON.stringify(body) }),
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

            const errorBody = objectFrom(text);
            const error =
                response.status === 404 && !isMesubErrorBody(errorBody)
                    ? new MesubError(
                          `${url.pathname} answered 404 with no Mesub error: is baseUrl ` +
                              `(${this.#config.baseUrl}) the Mesub API?`,
                          { status: 404, code: 'unexpected' },
                      )
                    : new MesubError(messageFrom(errorBody, response.status), {
                          status: response.status,
                          code: codeForStatus(response.status),
                      });
            return {
                ok: false,
                error,
                retry: shouldRetry(response, errorBody),
                retryAfter: retryAfter(response.headers.get('retry-after')),
            };
        } catch (cause) {
            if (signal?.aborted) throw signal.reason;

            if (controller.signal.aborted && cutByDeadline) {
                const error = new MesubError(
                    `Mesub did not answer within the ${Math.round(timeout)} ms left before the deadline.`,
                    { status: null, code: 'unavailable', cause },
                );
                return { ok: false, error, retry: false, retryAfter: null };
            }

            const message = controller.signal.aborted
                ? `Mesub did not answer within ${perAttempt} ms.`
                : `Could not reach Mesub: ${cause instanceof Error ? cause.message : String(cause)}`;
            const error = new MesubError(message, { status: null, code: 'unavailable', cause });
            return { ok: false, error, retry: true, retryAfter: null };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
        }
    }
}

/**
 * Whether a GET is sent again: the rules of the Stainless-generated clients
 * (OpenAI, Anthropic), except that a 409 is final, and that the body's
 * `retryable` (Mesub-io/backend#180), when there is one, decides over the status.
 */
function shouldRetry(response: Response, body: ErrorBody | null): boolean {
    const header = response.headers.get('x-should-retry');
    if (header === 'true') return true;
    if (header === 'false') return false;
    if (typeof body?.['retryable'] === 'boolean') return body['retryable'];
    const { status } = response;
    return status === 408 || status === 429 || status >= 500;
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

/** An error body that is a JSON object, or null for anything else. */
function objectFrom(text: string): ErrorBody | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return body as ErrorBody;
}

/**
 * The NestJS error body is `{ message, error, statusCode }`, `message` a
 * string or a list, and Mesub adds `code` and `retryable`.
 */
function messageFrom(body: ErrorBody | null, status: number): string {
    const fallback = `Mesub answered with HTTP ${status}.`;
    if (body === null) return fallback;

    const { message, error } = body;
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
function isMesubErrorBody(body: ErrorBody | null): boolean {
    if (body === null) return false;

    const { code, statusCode, message } = body;
    if (typeof code === 'string') return true;
    if (typeof statusCode !== 'number') return false;

    return !(typeof message === 'string' && /^Cannot [A-Z]+ \//.test(message));
}

/** Rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', stop);
            resolve();
        }, ms);
        signal?.addEventListener('abort', stop, { once: true });
    });
}
