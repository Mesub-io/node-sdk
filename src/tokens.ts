import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify } from 'jose';

import { MesubError } from './errors.js';

/** Where `@mesub/react` also writes the access token, for page loads and server rendering. */
export const TOKEN_COOKIE = 'mesub-token';

/** Who an access token is about. */
export interface VerifiedToken {
    userId: string;
    /** The subscriber's current wallet: what `hasAccess` is asked about. */
    wallet: string;
}

/** A Fetch `Headers` (Next, route handlers) or Node's plain object (Express). */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

/** One header from either shape, lowercase name. The first value when Node gives an array. */
export function headerOf(headers: HeaderSource, name: string): string | undefined {
    if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name) ?? undefined;
    }

    const value = (headers as Record<string, string | string[] | undefined>)[name];

    return Array.isArray(value) ? value[0] : value;
}

/**
 * The access token a request carries: `Authorization: Bearer <token>` first,
 * the `mesub-token` cookie otherwise, null when neither is there.
 */
export function tokenFrom(request: { headers: HeaderSource }): string | null {
    const [scheme, token] = (headerOf(request.headers, 'authorization') ?? '').split(' ');

    if (scheme?.toLowerCase() === 'bearer' && token) return token;

    // 'theme=dark; mesub-token=eyJ...; lang=fr': the token is the part after `mesub-token=`.
    const prefix = `${TOKEN_COOKIE}=`;
    const cookie = (headerOf(request.headers, 'cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix));
    const fromCookie = cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';

    return fromCookie || null;
}

/**
 * The jose error codes that mean the token itself is bad. Every other one,
 * `ERR_JOSE_GENERIC` and `ERR_JWKS_TIMEOUT` first, means the keys could not be
 * fetched, which is an outage and not a forged token.
 */
export const BAD_TOKEN = new Set([
    'ERR_JWT_INVALID',
    'ERR_JWS_INVALID',
    'ERR_JWT_EXPIRED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JOSE_NOT_SUPPORTED',
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

function invalidToken(cause?: unknown): MesubError {
    return new MesubError('That access token is not valid.', {
        status: null,
        code: 'invalid_token',
        ...(cause === undefined ? {} : { cause }),
    });
}

export interface TokenVerifierConfig {
    baseUrl: string;
    fetch: typeof fetch;
    /** The key's project id, fetched once: what `aud` must be. */
    projectId: () => Promise<string>;
}

/**
 * Verifies access tokens locally, with Mesub's public keys. The keys come from
 * `/.well-known/jwks.json`, which jose caches and fetches again only for a
 * `kid` it has not seen, so a rotation needs nothing from the merchant.
 */
export class TokenVerifier {
    private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
    private readonly issuer: string;

    constructor(private readonly config: TokenVerifierConfig) {
        this.issuer = config.baseUrl;
        this.jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', config.baseUrl), {
            [customFetch]: config.fetch,
            timeoutDuration: 5_000,
        });
    }

    async verify(token: string): Promise<VerifiedToken> {
        // Outside the try: when it fails, it already throws the right MesubError.
        const audience = await this.config.projectId();

        try {
            // Signature, expiry, project and issuer, all at once. `algorithms`
            // is what refuses a token signed HS256, or not signed at all.
            const { payload } = await jwtVerify(token, this.jwks, {
                algorithms: ['ES256'],
                audience,
                issuer: this.issuer,
            });

            if (typeof payload.sub !== 'string' || typeof payload['wallet'] !== 'string') {
                throw invalidToken();
            }

            return { userId: payload.sub, wallet: payload['wallet'] };
        } catch (error) {
            if (error instanceof MesubError) throw error;

            if (error instanceof joseErrors.JOSEError && BAD_TOKEN.has(error.code)) {
                throw invalidToken(error);
            }

            // Mesub did not answer for its keys, or answered an error: an outage.
            throw new MesubError('Could not fetch the Mesub public keys.', {
                status: null,
                code: 'unavailable',
                cause: error,
            });
        }
    }
}
