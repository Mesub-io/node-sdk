/** `@mesub/node/express`: `requirePlan()`. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

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

/** What `requirePlan` leaves on `res.locals.mesub` for the route. */
export type MesubLocals = MesubAccess;

export interface RequirePlanOptions {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /** Answer a refusal yourself: a redirect, a page, your own JSON. */
    onDenied?: (denial: Denial, req: Request, res: Response, next: NextFunction) => void;
}

/**
 * Lets a request through only for a subscriber with access to that plan.
 *
 * The subscriber is who the Mesub access token says, from the Authorization
 * header or the `mesub-token` cookie. Refusals answer 401 (no valid token),
 * 402 (no access) or 503 with Retry-After (Mesub unreachable while nobody
 * could be identified yet). Integration errors go to `next(err)`.
 */
export function requirePlan(plan: string, options: RequirePlanOptions = {}): RequestHandler {
    return async (req, res, next) => {
        try {
            const outcome = await guard(options.client ?? defaultClient(), req.headers, plan);

            if (outcome.allowed) {
                const locals: MesubLocals = accessOf(outcome);
                res.locals['mesub'] = locals;

                return next();
            }

            const denial = denialOf(outcome);

            if (options.onDenied) return options.onDenied(denial, req, res, next);

            if (outcome.reason === 'unavailable') {
                res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
            }

            res.status(denial.status).json(denialBody(outcome));
        } catch (error) {
            next(error);
        }
    };
}
