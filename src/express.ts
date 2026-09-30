/** `@mesub/node/express`: `requirePlan()`. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AccessAnswer } from './answer.js';
import type { Mesub } from './client.js';
import {
    DENIAL_STATUS,
    type DenialReason,
    defaultClient,
    denialBody,
    guard,
    UNAVAILABLE_RETRY_AFTER_S,
} from './guard.js';

export { MesubError } from './errors.js';
export type { DenialReason } from './guard.js';

/** What `requirePlan` leaves on `res.locals.mesub` for the route. */
export interface MesubLocals {
    userId: string;
    wallet: string;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback. */
    stale: boolean;
}

/** A refusal, as `onDenied` receives it. */
export interface Denial {
    reason: DenialReason;
    /** 401, 402 or 503: what would be answered without `onDenied`. */
    status: number;
    answer: AccessAnswer | null;
}

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
                const locals: MesubLocals = {
                    userId: outcome.subscriber.userId,
                    wallet: outcome.subscriber.wallet,
                    answer: outcome.decision.answer,
                    stale: outcome.decision.stale,
                };
                res.locals['mesub'] = locals;

                return next();
            }

            const status = DENIAL_STATUS[outcome.reason];

            if (options.onDenied) {
                return options.onDenied(
                    { reason: outcome.reason, status, answer: outcome.decision?.answer ?? null },
                    req,
                    res,
                    next,
                );
            }

            if (outcome.reason === 'unavailable') {
                res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
            }

            res.status(status).json(denialBody(outcome));
        } catch (error) {
            next(error);
        }
    };
}
