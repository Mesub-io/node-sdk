/** `@mesub/node/express`: `requirePlan()`. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

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

/** What `requirePlan` leaves on `res.locals.mesub` for the route. */
export type MesubLocals = MesubAccess;

export interface RequirePlanOptions {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Where the Mesub access token is, when not in the bearer or the
     * `mesub-token` cookie: `(req) => req.get('x-mesub-token')`. Then the
     * only place looked at.
     */
    token?: TokenOption<Request>;
    /**
     * Who is asking, from your own auth, instead of a Mesub token:
     * `(req) => ({ external_id: req.user.id })`, a wallet or an email. Null when
     * nobody is signed in. It must come from a session you verified, never
     * from the request itself. Not with `token`.
     */
    customer?: CustomerOption<Request>;
    /**
     * Answer a refusal yourself: a redirect, a page, your own JSON. It may be
     * async: what it returns is awaited, and a throw or a rejection goes to
     * `next(err)`, under Express 4 as under 5.
     */
    onDenied?: (denial: Denial, req: Request, res: Response, next: NextFunction) => unknown;
}

/**
 * Lets a request through only for a subscriber with access to that plan: a
 * slug, a list of which any one will do (`['pro', 'team']`), or either worked
 * out per request from a list you wrote, never read from the request itself.
 * `res.locals.mesub.plan` says which one let it through.
 *
 * With `customer`, who is asking is who your own auth says, and no Mesub
 * token is read. Otherwise the subscriber is who the Mesub access token says, from the Authorization
 * header or the `mesub-token` cookie (tried too when the bearer is not a Mesub
 * token), or where `token` says. Refusals answer 401 (nobody signed in),
 * 402 (Mesub said no) or 503 with Retry-After (Mesub unreachable, with no
 * answer known for that subscriber). Integration errors go to `next(err)`.
 */
export function requirePlan(
    plan: PlanOption<Request>,
    options: RequirePlanOptions = {},
): RequestHandler {
    checkPlan(plan);
    checkAsker(options);

    return async (req, res, next) => {
        try {
            const client = options.client ?? defaultClient();
            const outcome = await guard(client, await askerOf(client, req, options), () =>
                plansOf(plan, req),
            );

            if (outcome.allowed) {
                const locals: MesubLocals = accessOf(outcome);
                res.locals['mesub'] = locals;

                return next();
            }

            const denial = denialOf(outcome);

            if (options.onDenied) {
                // Awaited here, inside the try: Express 4 drops a rejected promise.
                await options.onDenied(denial, req, res, next);

                return;
            }

            if (outcome.reason === 'unavailable') {
                res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
            }

            res.status(denial.status).json(denialBody(outcome));
        } catch (error) {
            next(error);
        }
    };
}
