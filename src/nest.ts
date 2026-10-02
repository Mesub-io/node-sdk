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
    type Denial,
    defaultClient,
    denialBody,
    denialOf,
    guard,
    type MesubAccess as Access,
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';
import type { HeaderSource } from './tokens.js';

export { MesubError } from './errors.js';
export type { Denial, DenialReason } from './guard.js';

/** Who is asking and what Mesub answered, as `@MesubAccess()` gives it. */
export type MesubAccess = Access;

/** An Express or Fastify request, as far as the guard reads and writes it. */
export interface MesubRequest {
    headers: HeaderSource;
    /** Set by `RequirePlan` when the request is let through. */
    mesub?: MesubAccess;
}

export interface RequirePlanOptions {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Answer a refusal yourself by throwing your own exception, with your own
     * status and body. If it returns, the default refusal is thrown.
     */
    onDenied?: (denial: Denial, request: MesubRequest) => void;
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
 * plan: `@UseGuards(RequirePlan('pro'))` on a controller or a route.
 *
 * The subscriber is who the Mesub access token says, from the Authorization
 * header or the `mesub-token` cookie. Refusals throw an `HttpException` of 401
 * (no valid token), 402 (Mesub said no) or 503 with Retry-After (Mesub
 * unreachable, with no answer known for that subscriber). Integration errors
 * are thrown as they are, for Nest to log and answer 500.
 */
export function RequirePlan(plan: string, options: RequirePlanOptions = {}): Type<CanActivate> {
    class MesubPlanGuard implements CanActivate {
        async canActivate(context: ExecutionContext): Promise<boolean> {
            const http = context.switchToHttp();
            const request = http.getRequest<MesubRequest>();
            const outcome = await guard(options.client ?? defaultClient(), request.headers, plan);

            if (outcome.allowed) {
                request.mesub = accessOf(outcome);

                return true;
            }

            const denial = denialOf(outcome);

            options.onDenied?.(denial, request);

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
