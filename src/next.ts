/** `@mesub/node/next`: `withMesub()`. Web `Request`/`Response` only, nothing imported from `next`. */
import type { Mesub } from './client.js';
import {
    accessOf,
    type Denial,
    defaultClient,
    denialBody,
    denialOf,
    guard,
    type MesubAccess,
    UNAVAILABLE_RETRY_AFTER_S,
    type WalletResolver,
} from './guard.js';

export { MesubError } from './errors.js';
export type { Denial, DenialReason, MesubAccess, WalletResult } from './guard.js';

export interface WithMesubOptions {
    plan: string;
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /** Answer a refusal yourself: a redirect, a page, your own JSON. */
    onDenied?: (denial: Denial, request: Request) => Response | Promise<Response>;
    /**
     * Take the wallet from your own auth instead of a Mesub access token, which
     * is then never read. Return the wallet of the signed-in user, from your
     * **verified** session, never from the query, the body or a header the
     * caller sets. `null` or `undefined` answers 401; a string that is not a
     * Solana address throws a `MesubError` `invalid_request`.
     */
    wallet?: WalletResolver<[request: Request]>;
}

/** Your route handler, with who is asking and Mesub's answer as the second argument. */
export type MesubRouteHandler<Context = unknown> = (
    request: Request,
    mesub: MesubAccess,
    context: Context,
) => Response | Promise<Response>;

/**
 * Wraps an App Router route handler so it runs only for a subscriber with
 * access to `plan`. Next's `context` (with `params`) is passed through as is.
 *
 * The subscriber is who the Mesub access token says, from the Authorization
 * header or the `mesub-token` cookie, or who your `wallet` option says when
 * given. Refusals answer 401 (no valid token, or no wallet), 402 (no access)
 * or 503 with Retry-After (Mesub unreachable while nobody could be identified
 * yet). Integration errors are thrown, for Next to log and answer 500. Not
 * for `middleware.ts`, server components or pages.
 */
export function withMesub<Context = unknown>(
    handler: MesubRouteHandler<Context>,
    options: WithMesubOptions,
): (request: Request, context: Context) => Promise<Response> {
    const { wallet } = options;

    return async (request, context) => {
        const outcome = await guard(
            options.client ?? defaultClient(),
            request.headers,
            options.plan,
            wallet && (() => wallet(request)),
        );

        if (outcome.allowed) return handler(request, accessOf(outcome), context);

        const denial = denialOf(outcome);

        if (options.onDenied) return options.onDenied(denial, request);

        const headers: Record<string, string> =
            outcome.reason === 'unavailable'
                ? { 'Retry-After': String(UNAVAILABLE_RETRY_AFTER_S) }
                : {};

        return Response.json(denialBody(outcome), { status: denial.status, headers });
    };
}
