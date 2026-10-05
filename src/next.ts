/** `@mesub/node/next`: `withMesub()`. Web `Request`/`Response` only, nothing imported from `next`. */
import type { Mesub } from './client.js';
import {
    accessOf,
    askerOf,
    checkCustomer,
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
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';

import {
    checkWidgetOptions,
    handleWidget,
    widgetCustomer,
    type WidgetRoutesOptions,
} from './routes.js';

export { MesubError } from './errors.js';
export type {
    WidgetPayment,
    WidgetRoutesOptions,
    WidgetSubscriptionDetail,
    WidgetSubscriptionList,
} from './routes.js';
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
     * Who is asking, from your own auth:
     * `(req) => ({ external_id: session.userId })`, a wallet or an email. Null when
     * nobody is signed in. It must come from a session you verified, never
     * from the request itself.
     */
    customer: CustomerOption<Request>;
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
 * Who is asking is who `customer` says, from your own auth. Refusals answer
 * 401 (nobody signed in), 402 (Mesub said no) or 503 with Retry-After (Mesub
 * unreachable, with no answer known for that subscriber). Integration errors
 * are thrown, for Next to log and answer 500. Not for `middleware.ts`, server
 * components or pages.
 */
export function withMesub<Context = unknown>(
    handler: MesubRouteHandler<Context>,
    options: WithMesubOptions,
): (request: Request, context: Context) => Promise<Response> {
    checkPlan(options.plan);
    checkCustomer(options);

    return async (request, context) => {
        const client = options.client ?? defaultClient();
        const outcome = await guard(client, await askerOf(request, options.customer), () =>
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

/** Next's `context` of a catch-all route: `params` is a promise since Next 15. */
interface CatchAllContext {
    params?: Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** The path after the mount point, from the catch-all segment: `/subscriptions/sub_1/cancel`. */
async function pathOf(context: CatchAllContext | undefined): Promise<string> {
    const params = (await context?.params) ?? {};
    const segments = Object.values(params).find((value) => Array.isArray(value)) as
        unknown[] | undefined;

    return `/${(segments ?? []).map((segment) => encodeURIComponent(String(segment))).join('/')}`;
}

/**
 * The routes `@mesub/react` calls, as an App Router catch-all:
 *
 *     // app/api/mesub/[...mesub]/route.ts
 *     export const { GET, POST } = mesubRouteHandlers({ customer: async (request) => ... });
 *
 * `customer` says who is asking from your own verified session. Integration
 * errors are thrown, for Next to log and answer 500.
 */
export function mesubRouteHandlers(options: WidgetRoutesOptions<Request>): {
    GET: (request: Request, context?: CatchAllContext) => Promise<Response>;
    POST: (request: Request, context?: CatchAllContext) => Promise<Response>;
} {
    checkWidgetOptions(options);

    const handle = async (request: Request, context?: CatchAllContext): Promise<Response> => {
        const path = await pathOf(context);
        let body: unknown;

        if (request.method !== 'GET') {
            const text = await request.text();

            if (text.length > 64 * 1024) {
                return Response.json(
                    { error: { code: 'payload_too_large', message: 'The body is too large.' } },
                    { status: 413 },
                );
            }
            try {
                body = text === '' ? undefined : (JSON.parse(text) as unknown);
            } catch {
                return Response.json(
                    { error: { code: 'invalid_request', message: 'The body is not JSON.' } },
                    { status: 400 },
                );
            }
        }

        // A plan is public: nobody needs to be signed in to read a price.
        const publicRead = request.method === 'GET' && path.startsWith('/plans/');
        const asked = publicRead ? null : await widgetCustomer(request, options.customer);
        const email = asked && options.email ? await options.email(request) : undefined;
        const answer = await handleWidget(
            options.client ?? defaultClient(),
            {
                method: request.method,
                path,
                body,
                contentType: request.headers.get('content-type'),
            },
            asked,
            { email, ...(options.plans && { plans: options.plans }) },
        );

        return Response.json(answer.body, {
            status: answer.status,
            // Per customer, and it moves: never a shared cache's to keep.
            headers: { 'Cache-Control': 'no-store', ...answer.headers },
        });
    };

    return { GET: handle, POST: handle };
}
