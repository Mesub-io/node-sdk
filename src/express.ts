/** `@mesub/node/express`: `requirePlan()`. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

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
export type { WidgetPayment, WidgetRoutesOptions, WidgetSubscriptionDetail } from './routes.js';
export type { CustomerOption, Denial, DenialReason, MesubAccess, PlanOption } from './guard.js';
export type { Asked } from './customer.js';
export type { Customer } from './answer.js';

/** What `requirePlan` leaves on `res.locals.mesub` for the route. */
export type MesubLocals = MesubAccess;

export interface RequirePlanOptions {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Who is asking, from your own auth:
     * `(req) => ({ external_id: req.user.id })`, a wallet or an email. Null when
     * nobody is signed in. It must come from a session you verified, never
     * from the request itself.
     */
    customer: CustomerOption<Request>;
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
 * Who is asking is who `customer` says, from your own auth. Refusals answer
 * 401 (nobody signed in), 402 (Mesub said no) or 503 with Retry-After (Mesub
 * unreachable, with no answer known for that subscriber). Integration errors
 * go to `next(err)`.
 */
export function requirePlan(
    plan: PlanOption<Request>,
    options: RequirePlanOptions,
): RequestHandler {
    checkPlan(plan);
    checkCustomer(options);

    return async (req, res, next) => {
        try {
            const client = options.client ?? defaultClient();
            const outcome = await guard(client, await askerOf(req, options.customer), () =>
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

/** The most a widget request's body may weigh: a signed transaction is under 2 kB. */
const MAX_BODY_BYTES = 64 * 1024;

/** The JSON body, from `express.json()` when it ran, read here otherwise. */
async function jsonBody(req: Request): Promise<unknown> {
    const parsed: unknown = (req as { body?: unknown }).body;

    if (parsed !== undefined && !(typeof parsed === 'string' && parsed === '')) return parsed;
    if (req.method === 'GET') return undefined;

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new RangeError('The body is too large.');
        chunks.push(bytes);
    }

    if (size === 0) return undefined;

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * The routes `@mesub/react` calls, mounted on your server:
 * `app.use('/api/mesub', mesubRoutes({ customer: (req) => ... }))`. Under
 * Nest, the same line with `app.use` in `main.ts`.
 *
 * `customer` says who is asking from your own verified auth, so put your
 * login before it. A request it cannot answer goes to `next()`, a 404 of
 * yours; an integration error goes to `next(err)`.
 */
export function mesubRoutes(options: WidgetRoutesOptions<Request>): RequestHandler {
    checkWidgetOptions(options);

    return async (req, res, next) => {
        try {
            let body: unknown;

            try {
                body = await jsonBody(req);
            } catch (error) {
                const tooLarge = error instanceof RangeError;

                res.status(tooLarge ? 413 : 400).json({
                    error: {
                        code: tooLarge ? 'payload_too_large' : 'invalid_request',
                        message: tooLarge ? 'The body is too large.' : 'The body is not JSON.',
                    },
                });
                return;
            }

            // A plan is public: nobody needs to be signed in to read a price.
            const publicRead = req.method === 'GET' && req.path.startsWith('/plans/');
            const asked = publicRead ? null : await widgetCustomer(req, options.customer);
            const email = asked && options.email ? await options.email(req) : undefined;
            const answer = await handleWidget(
                options.client ?? defaultClient(),
                {
                    method: req.method,
                    path: req.path,
                    body,
                    contentType: req.get('content-type') ?? null,
                },
                asked,
                { email, ...(options.plans && { plans: options.plans }) },
            );

            for (const [name, value] of Object.entries(answer.headers ?? {})) {
                res.setHeader(name, value);
            }
            // Per customer, and it moves: never a shared cache's to keep.
            res.setHeader('Cache-Control', 'no-store');
            res.status(answer.status).json(answer.body);
        } catch (error) {
            next(error);
        }
    };
}
