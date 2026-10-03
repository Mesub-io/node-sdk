/** `@mesub/node/nest`: `RequirePlan()` and `@MesubAccess()`. */
import {
    type CanActivate,
    createParamDecorator,
    type ExecutionContext,
    HttpException,
    mixin,
    type Type,
} from '@nestjs/common';

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
    type MesubAccess as Access,
    type PlanOption,
    plansOf,
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';
import type { HeaderSource } from './webhooks.js';

export { MesubError } from './errors.js';
export type { CustomerOption, Denial, DenialReason, PlanOption } from './guard.js';
export type { Asked } from './customer.js';
export type { Customer } from './answer.js';

/** Who is asking and what Mesub answered, as `@MesubAccess()` gives it. */
export type MesubAccess = Access;

/** An Express or Fastify request, as far as the guard reads and writes it. */
export interface MesubRequest {
    headers: HeaderSource;
    /** Set by `RequirePlan` when the request is let through. */
    mesub?: MesubAccess;
}

/**
 * `Req` is your request as your own auth guard leaves it: name it to read
 * `req.user` in `customer` without a cast,
 * `RequirePlan<AuthedRequest>('pro', { customer: (req) => ... })`.
 */
export interface RequirePlanOptions<Req extends MesubRequest = MesubRequest> {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Who is asking, from your own auth:
     * `(req) => ({ external_id: req.user.id })`, a wallet or an email. Null when
     * nobody is signed in. It must come from a session you verified, never
     * from the request itself.
     */
    customer: CustomerOption<Req>;
    /**
     * Answer a refusal yourself by throwing your own exception, with your own
     * status and body. It may be async: what it returns is awaited, and a
     * rejection is thrown like a throw. If it returns, the default refusal
     * is thrown.
     */
    onDenied?: (denial: Denial, request: Req) => unknown;
}

/** Express has `setHeader`, a Fastify reply has `header`. */
interface HeaderSink {
    setHeader?: (name: string, value: string) => unknown;
    header?: (name: string, value: string) => unknown;
}

function setHeader(response: HeaderSink, name: string, value: string) {
    if (typeof response.setHeader === 'function') response.setHeader(name, value);
    else if (typeof response.header === 'function') response.header(name, value);
}

/**
 * A guard letting a request through only for a subscriber with access to that
 * plan: `@UseGuards(RequirePlan('pro', { customer }))` on a controller or a
 * route. The plan is a slug, a list of which any one will do
 * (`['pro', 'team']`), or either worked out per request. `@MesubAccess()` says
 * which one let it through.
 *
 * Who is asking is who `customer` says, from your own auth. Refusals throw an
 * `HttpException` of 401 (nobody signed in), 402 (Mesub said no) or 503 with
 * Retry-After (Mesub unreachable, with no answer known for that subscriber).
 * Integration errors are thrown as they are, for Nest to log and answer 500.
 */
export function RequirePlan<Req extends MesubRequest = MesubRequest>(
    plan: PlanOption<Req>,
    options: RequirePlanOptions<Req>,
): Type<CanActivate> {
    checkPlan(plan);
    checkCustomer(options);

    class MesubPlanGuard implements CanActivate {
        async canActivate(context: ExecutionContext): Promise<boolean> {
            const http = context.switchToHttp();
            const request = http.getRequest<Req>();
            const client = options.client ?? defaultClient();
            const outcome = await guard(client, await askerOf(request, options.customer), () =>
                plansOf(plan, request),
            );

            if (outcome.allowed) {
                request.mesub = accessOf(outcome);

                return true;
            }

            const denial = denialOf(outcome);

            await options.onDenied?.(denial, request);

            if (outcome.reason === 'unavailable') {
                setHeader(
                    http.getResponse<HeaderSink>(),
                    'Retry-After',
                    String(UNAVAILABLE_RETRY_AFTER_S),
                );
            }

            throw new HttpException(denialBody(outcome), denial.status);
        }
    }

    return mixin(MesubPlanGuard);
}

/** The `MesubAccess` that `RequirePlan` left on the request, as a handler parameter. */
export const MesubAccess = createParamDecorator(
    (_data: unknown, context: ExecutionContext): MesubAccess | undefined =>
        context.switchToHttp().getRequest<MesubRequest>().mesub,
);
