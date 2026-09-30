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
} from './guard.js';

export { MesubError } from './errors.js';
export type { Denial, DenialReason, MesubAccess } from './guard.js';

export interface WithMesubOptions {
    plan: string;
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /** Answer a refusal yourself: a redirect, a page, your own JSON. */
    onDenied?: (denial: Denial, request: Request) => Response | Promise<Response>;
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
 * header or the `mesub-token` cookie. Refusals answer 401 (no valid token),
 * 402 (no access) or 503 with Retry-After (Mesub unreachable while nobody
 * could be identified yet). Integration errors are thrown, for Next to log
 * and answer 500. Not for `middleware.ts`, server components or pages.
 */
export function withMesub<Context = unknown>(
    handler: MesubRouteHandler<Context>,
    options: WithMesubOptions,
): (request: Request, context: Context) => Promise<Response> {
    return async (request, context) => {
        const outcome = await guard(
            options.client ?? defaultClient(),
            request.headers,
            options.plan,
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
