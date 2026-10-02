/** `@mesub/node/next`: `withMesub()`. Web `Request`/`Response` only, nothing imported from `next`. */
import type { Mesub } from './client.js';
import {
    accessOf,
    checkPlan,
    type Denial,
    defaultClient,
    denialBody,
    denialOf,
    guard,
    type MesubAccess,
    type PlanOption,
    plansOf,
    type TokenOption,
    tokensOf,
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';

export { MesubError } from './errors.js';
export type { Denial, DenialReason, MesubAccess, PlanOption } from './guard.js';

export interface WithMesubOptions {
    /**
     * A slug, a list of which any one will do (`['pro', 'team']`), or either
     * worked out per request. `mesub.plan` says which one let it through.
     */
    plan: PlanOption<Request>;
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Where the Mesub access token is, when not in the bearer or the
     * `mesub-token` cookie: `(request) => request.headers.get('x-mesub-token')`.
     * Then the only place looked at.
     */
    token?: TokenOption<Request>;
    /**
     * Answer a refusal yourself: a redirect, a page, your own JSON. It may be
     * async; a throw or a rejection is thrown, for Next to answer 500.
     */
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
 * header or the `mesub-token` cookie (tried too when the bearer is not a Mesub
 * token), or where `token` says. Refusals answer 401 (no valid token),
 * 402 (Mesub said no) or 503 with Retry-After (Mesub unreachable, with no
 * answer known for that subscriber). Integration errors are thrown, for Next to log
 * and answer 500. Not for `middleware.ts`, server components or pages.
 */
export function withMesub<Context = unknown>(
    handler: MesubRouteHandler<Context>,
    options: WithMesubOptions,
): (request: Request, context: Context) => Promise<Response> {
    checkPlan(options.plan);

    return async (request, context) => {
        const outcome = await guard(
            options.client ?? defaultClient(),
            tokensOf(request, options.token),
            plansOf(options.plan, request),
        );

        if (outcome.allowed) return handler(request, accessOf(outcome), context);

        const denial = denialOf(outcome);

        if (options.onDenied) return await options.onDenied(denial, request);

        const headers: Record<string, string> =
            outcome.reason === 'unavailable'
                ? { 'Retry-After': String(UNAVAILABLE_RETRY_AFTER_S) }
                : {};

        return Response.json(denialBody(outcome), { status: denial.status, headers });
    };
}
