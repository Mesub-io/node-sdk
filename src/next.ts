/** `@mesub/node/next`: `withMesub()`. Web `Request`/`Response` only, nothing imported from `next`. */
import type { Mesub } from './client.js';
import {
    accessOf,
    askerOf,
    checkAsker,
    checkPlan,
    type CustomerOption,
    type Denial,
    defaultClient,
    denialBody,
    denialOf,
    guard,
    type MesubAccess,
    type PlanOption,
    plansOf,
    type TokenOption,
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';

export { MesubError } from './errors.js';
export type { CustomerOption, Denial, DenialReason, MesubAccess, PlanOption } from './guard.js';
export type { Asked } from './customer.js';
export type { Customer } from './answer.js';

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
     * Who is asking, from your own auth, instead of a Mesub token:
     * `(req) => ({ external_id: session.userId })`, a wallet or an email. Null when
     * nobody is signed in. It must come from a session you verified, never
     * from the request itself. Not with `token`.
     */
    customer?: CustomerOption<Request>;
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
 * With `customer`, who is asking is who your own auth says, and no Mesub
 * token is read. Otherwise the subscriber is who the Mesub access token says, from the Authorization
 * header or the `mesub-token` cookie (tried too when the bearer is not a Mesub
 * token), or where `token` says. Refusals answer 401 (nobody signed in),
 * 402 (Mesub said no) or 503 with Retry-After (Mesub unreachable, with no
 * answer known for that subscriber). Integration errors are thrown, for Next to log
 * and answer 500. Not for `middleware.ts`, server components or pages.
 */
export function withMesub<Context = unknown>(
    handler: MesubRouteHandler<Context>,
    options: WithMesubOptions,
): (request: Request, context: Context) => Promise<Response> {
    checkPlan(options.plan);
    checkAsker(options);

    return async (request, context) => {
        const client = options.client ?? defaultClient();
        const outcome = await guard(client, await askerOf(client, request, options), () =>
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
