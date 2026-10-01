/**
 * Stable codes to branch on. `unexpected` covers any status without its own
 * code (403, 409, a 2xx whose body is not JSON, a 404 whose body is not a
 * Mesub error, so a wrong `baseUrl`, ...). `invalid_token` is an
 * access token that fails verification: forged, expired, or for another project.
 */
export type MesubErrorCode =
    | 'invalid_request'
    | 'unauthorized'
    | 'plan_not_found'
    | 'rate_limited'
    | 'unavailable'
    | 'invalid_token'
    | 'unexpected';

export interface MesubErrorOptions {
    status: number | null;
    code: MesubErrorCode;
    cause?: unknown;
}

/** Every failure of a call to the Mesub API, after retries. */
export class MesubError extends Error {
    override readonly name = 'MesubError';
    /** The HTTP status, or `null` when no response came back (network error, timeout). */
    readonly status: number | null;
    readonly code: MesubErrorCode;

    constructor(message: string, options: MesubErrorOptions) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.status = options.status;
        this.code = options.code;
    }
}

export function codeForStatus(status: number): MesubErrorCode {
    if (status === 400) return 'invalid_request';
    if (status === 401) return 'unauthorized';
    if (status === 404) return 'plan_not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'unavailable';
    return 'unexpected';
}
