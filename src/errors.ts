/**
 * Stable codes to branch on, one per kind of failure; `apiCode` tells the
 * causes within one apart. `unexpected` covers any status without its own
 * code (408, 413, a 2xx whose body is not JSON or not of the shape the SDK
 * reads, a 404 whose body is not a Mesub error, so a wrong `baseUrl`, ...).
 * `invalid_token` is an access token that fails verification: forged,
 * expired, or for another project.
 */
export type MesubErrorCode =
    | 'invalid_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'plan_not_found'
    | 'conflict'
    | 'rate_limited'
    | 'unavailable'
    | 'invalid_token'
    | 'unexpected';

export interface MesubErrorOptions {
    status: number | null;
    code: MesubErrorCode;
    /** The back's own code, from the error body. Defaults to null. */
    apiCode?: string | null;
    /** Defaults to true for `unavailable` and `rate_limited`, false otherwise. */
    retryable?: boolean;
    /** What Mesub answered, when it answered. */
    body?: unknown;
    /** Milliseconds, from the response's `Retry-After`. Defaults to null. */
    retryAfter?: number | null;
    cause?: unknown;
}

/** Every failure of a call to the Mesub API, after retries. */
export class MesubError extends Error {
    override readonly name = 'MesubError';
    /** The HTTP status, or `null` when no response came back (network error, timeout). */
    readonly status: number | null;
    readonly code: MesubErrorCode;
    /**
     * The code Mesub's error body names (`subscription_not_found`,
     * `pending_cap_reached`, ...), finer than `code` and as stable: never
     * renamed nor reused, though new ones get added. Null when no Mesub error
     * came back: a network error, a timeout, a body that is not Mesub's.
     */
    readonly apiCode: string | null;
    /**
     * Whether the same call, sent again unchanged, may succeed later without
     * anybody doing anything: Mesub's own `retryable` when it sent one. Not
     * "at once": the SDK has already retried what it retries.
     */
    readonly retryable: boolean;
    /**
     * The body Mesub answered, parsed when it is JSON, the text otherwise;
     * undefined when no response came back.
     */
    readonly body: unknown;
    /**
     * How long Mesub asked to wait before the same call is sent again, in
     * milliseconds, from the response's `Retry-After`, as sent: a 429
     * (`rate_limited`, or `pending_cap_reached` on create, which may be most
     * of an hour) or a 503 (`network_unavailable`, about 10 s). Null when
     * the response had none, or none came back.
     */
    readonly retryAfter: number | null;

    constructor(message: string, options: MesubErrorOptions) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.status = options.status;
        this.code = options.code;
        this.apiCode = options.apiCode ?? null;
        this.retryable =
            options.retryable ??
            (options.code === 'unavailable' || options.code === 'rate_limited');
        this.body = options.body;
        this.retryAfter = options.retryAfter ?? null;
    }
}

/**
 * The SDK's code for an error Mesub answered: its status, but for
 * `plan_not_found`, which keeps its own code from before the back had codes.
 * Every other 404 (`subscription_not_found`, a route Mesub does not have)
 * is `not_found`.
 */
export function codeFor(status: number, apiCode: string | null): MesubErrorCode {
    if (status === 404 && apiCode === 'plan_not_found') return 'plan_not_found';
    if (status === 400) return 'invalid_request';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'unavailable';
    return 'unexpected';
}
