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

    async get(path: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
        const url = new URL(this.#config.baseUrl + path);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }

        for (let retry = 0; ; retry++) {
            const attempt = await this.#attempt(url);
            if (attempt.ok) return attempt.body;
            if (!attempt.retry || retry >= this.#config.maxRetries) throw attempt.error;
            await sleep(attempt.retryAfter ?? backoff(retry));
        }
    }

    async #attempt(url: URL): Promise<Attempt> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#config.timeout);

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

            const error = new MesubError(messageFrom(text, response.status), {
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
