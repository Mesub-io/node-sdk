import { MesubError, codeFor } from './errors.js';
import { VERSION } from './version.js';

export type QueryValue = string | number | boolean | undefined;

export interface TransportConfig {
    apiKey: string;
    baseUrl: string;
    /** Sent with every call, before the SDK's own, which they never replace. */
    headers: Record<string, string>;
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
        const url = endpoint(this.#config.baseUrl, path);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }
        return this.#send('GET', url, undefined, options);
    }

    /**
     * A POST with a JSON body, sent once: never retried here, whatever the
     * status, a timeout or a network error. A write that got no answer may
     * still have been done: its caller decides, knowing the route, whether
     * the same body may be sent again (`submit` does, Mesub-io/backend#190)
     * or the state read back.
     */
    async post(
        path: string,
        body: unknown,
        options: Omit<CallOptions, 'maxRetries'> = {},
    ): Promise<unknown> {
        return this.#send('POST', endpoint(this.#config.baseUrl, path), body, options);
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
                    ...this.#config.headers,
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
                        body: text,
                        cause,
                    });
                    return { ok: false, error, retry: false, retryAfter: null };
                }
            }

            const answered = parsed(text);
            const asked = retryAfter(response.headers.get('retry-after'));
            const error =
                response.status === 404 && !isMesubErrorBody(answered)
                    ? new MesubError(
                          `${url.pathname} answered 404 with no Mesub error: is baseUrl ` +
                              `(${this.#config.baseUrl}) the Mesub API?`,
                          { status: 404, code: 'unexpected', body: answered, retryAfter: asked },
                      )
                    : errorFrom(response.status, answered, asked);

            return {
                ok: false,
                error,
                retry: shouldRetry(response, error),
                retryAfter: asked === null ? null : Math.min(asked, MAX_RETRY_AFTER),
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
 * @internal A path under the base URL, which may carry its own path:
 * `https://proxy.example.com/mesub` and `/v1/access` make
 * `https://proxy.example.com/mesub/v1/access`. Never `new URL(path, base)`,
 * which drops the base's path for a path starting with `/`.
 */
export function endpoint(baseUrl: string, path: string): URL {
    return new URL(baseUrl + path);
}

/**
 * Whether a GET is sent again (a POST never is): `x-should-retry` first, as
 * the Stainless-generated clients (OpenAI, Anthropic) read it, then the
 * error's own `retryable`, which is Mesub's flag when the body has one and
 * the status's otherwise. The pending cap (`pending_cap_reached`) is only
 * ever a create's, a POST, so it needs no rule of its own here.
 */
function shouldRetry(response: Response, error: MesubError): boolean {
    const header = response.headers.get('x-should-retry');
    if (header === 'true') return true;
    if (header === 'false') return false;
    return error.retryable;
}

/**
 * The error a Mesub error body describes since the back's error codes
 * (Mesub-io/backend#180): Nest's `statusCode`, `error` and `message`, plus a
 * stable `code` and a `retryable` flag. Without them, as from a proxy in
 * front, the status alone decides.
 */
function errorFrom(status: number, body: unknown, retryAfter: number | null): MesubError {
    const { code, retryable } = isRecord(body) ? body : {};
    const apiCode = typeof code === 'string' ? code : null;

    return new MesubError(messageFrom(body, status), {
        status,
        code: codeFor(status, apiCode),
        apiCode,
        retryable: typeof retryable === 'boolean' ? retryable : retryableStatus(status),
        body,
        retryAfter,
    });
}

/**
 * What the status says, when the body does not: the Stainless clients' rules,
 * but for a 409, which is Mesub's final word on a state, never a race to retry.
 */
function retryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

/**
 * Milliseconds from a `Retry-After` in seconds or as an HTTP date, as sent:
 * what the error carries. A GET waits it capped at `MAX_RETRY_AFTER`.
 */
function retryAfter(header: string | null): number | null {
    if (header === null || header.trim() === '') return null;
    const seconds = Number(header);
    const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms;
}

/** 500 ms, then 1 s, ... up to 8 s, minus up to 25% of jitter. */
function backoff(retry: number): number {
    const delay = Math.min(INITIAL_RETRY_DELAY * 2 ** retry, MAX_RETRY_DELAY);
    return delay * (1 - Math.random() * 0.25);
}

/** The NestJS error body is `{ message, error, statusCode }`, `message` a string or a list. */
function messageFrom(body: unknown, status: number): string {
    const fallback = `Mesub answered with HTTP ${status}.`;
    if (!isRecord(body)) return fallback;

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
 * have (`Cannot GET /api/v1/access`) is not one, though the back now codes it
 * `not_found`: a path prefix too many.
 */
function isMesubErrorBody(body: unknown): boolean {
    if (!isRecord(body)) return false;

    const { code, statusCode, message } = body;
    if (typeof message === 'string' && /^Cannot [A-Z]+ \//.test(message)) return false;

    return typeof code === 'string' || typeof statusCode === 'number';
}

/** The body as JSON when it parses, the text as it came otherwise. */
function parsed(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @internal Rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
