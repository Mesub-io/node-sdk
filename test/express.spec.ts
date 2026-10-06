import express, {
    type NextFunction,
    type Request as ExpressRequest,
    type Response as ExpressResponse,
} from 'express';
import request from 'supertest';

import type { AccessAnswer, SubscriptionStatus } from '../src/answer.js';
import {
    MesubError,
    requirePlan,
    type MesubLocals,
    type PlanOption,
    type RequirePlanOptions,
} from '../src/express.js';
import { Mesub, type MesubOptions } from '../src/index.js';

const BASE = 'https://api.mesub.test';
const WALLET = 'SysvarRent111111111111111111111111111111111';

/** Stands for the merchant's own verified session: who it says is signed in. */
const SESSION = 'x-test-session';
const SIGNED_IN = { [SESSION]: WALLET };
const session = (req: ExpressRequest) => req.get(SESSION) ?? null;

function answer(over: Partial<AccessAnswer> = {}): AccessAnswer {
    return {
        wallet: WALLET,
        plan: 'pro',
        access: true,
        status: 'active',
        paused: false,
        end_reason: null,
        late_reason: null,
        payment_status: 'paid',
        subscribed_since: null,
        first_subscribed_at: null,
        current_period_end: null,
        cancelled_at: null,
        access_until: null,
        next_charge_at: null,
        next_retry_at: null,
        retry_deadline: null,
        revalidate_after: 60,
        ...over,
    };
}

interface Mesh {
    /** What /v1/access answers, per call. */
    access?: (init?: RequestInit, url?: URL) => Response | Promise<Response>;
}

/** A Mesub whose API is a function, so each test says what it answers. */
function mesub(mesh: Mesh = {}, options: MesubOptions = {}) {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        calls.push(url.pathname);
        if (url.pathname === '/v1/access')
            return (mesh.access ?? (() => Response.json(answer())))(init, url);
        throw new Error(`unexpected ${url.pathname}`);
    });
    const client = new Mesub({
        apiKey: 'SUB_test',
        baseUrl: BASE,
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 0,
        // The default budget is 2 s: on a busy machine it would decide a test that is not about it.
        guardTimeout: 30_000,
        ...options,
    });

    return { client, calls };
}

/** What /v1/access answers, per plan asked. */
function perPlan(
    answers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): NonNullable<Mesh['access']> {
    return (init, url) => answers[url!.searchParams.get('plan')!]!(init);
}

/** Mesub not answering at all, until the call gives up. */
function hang(init?: RequestInit) {
    return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
}

/**
 * An app with one guarded route that echoes res.locals.mesub. Signed in by
 * the test session, unless `customer` is given.
 */
function app(
    client: Mesub,
    options: Partial<Omit<RequirePlanOptions, 'client'>> = {},
    plan: PlanOption<ExpressRequest> = 'pro',
) {
    const server = express();
    server.get(
        '/pro',
        requirePlan(plan, { customer: session, ...options, client }),
        (_req, res) => {
            res.json(res.locals['mesub'] as MesubLocals);
        },
    );
    // Integration errors land here, through next(err).
    server.use(
        (error: unknown, _req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
            res.status(500).json({ forwarded: error instanceof MesubError ? error.code : 'other' });
        },
    );
    return server;
}

describe('requirePlan', () => {
    describe('letting through', () => {
        it('lets a subscriber with access reach the route', async () => {
            const { client } = mesub();

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(200);
        });

        it('leaves who they are and the answer on res.locals.mesub', async () => {
            const { client } = mesub();

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.body).toEqual({
                wallet: WALLET,
                customer: { kind: 'wallet', value: WALLET },
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        // Who is asked about is who `customer` names, never one the request names.
        it('asks Mesub about the wallet the session names', async () => {
            let asked: unknown = null;
            const { client } = mesub({
                access: () => Response.json(answer()),
            });
            const spy = vi.spyOn(client, 'decide').mockImplementation(async (wallet) => {
                asked = wallet;
                return { access: true, answer: answer(), stale: false };
            });

            await request(app(client))
                .get('/pro?wallet=Attacker111111111111111111111111111111111111')
                .set(SIGNED_IN)
                .set('x-wallet', 'Attacker111111111111111111111111111111111111');

            expect(asked).toBe(WALLET);
            spy.mockRestore();
        });
    });

    describe('401, not signed in', () => {
        it.each([
            ['no session at all', {} as Record<string, string>],
            // Only `customer` says who is asking: nothing else of the request is read.
            [
                'a bearer and a cookie the guard does not read',
                { Authorization: `Bearer ${WALLET}`, Cookie: `wallet=${WALLET}` },
            ],
        ])('answers 401 on %s', async (_label, headers) => {
            const { client, calls } = mesub();

            const response = await request(app(client)).get('/pro').set(headers);

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
            expect(calls).toEqual([]);
        });

        it('never asks Mesub when nobody is signed in', async () => {
            const { client, calls } = mesub();

            await request(app(client)).get('/pro');

            expect(calls).toEqual([]);
        });
    });

    describe('customer option: who is asking, from the merchant own auth', () => {
        /** What /v1/access was asked, as its query. */
        function asked() {
            const queries: Record<string, string>[] = [];
            const access: NonNullable<Mesh['access']> = (_init, url) => {
                queries.push(Object.fromEntries(url!.searchParams));
                return Response.json(answer());
            };

            return { queries, access };
        }

        it('lets a customer through by external id', async () => {
            const { queries, access } = asked();
            const { client, calls } = mesub({ access });

            const response = await request(
                app(client, { customer: () => ({ external_id: 'user_42' }) }),
            ).get('/pro');

            expect(response.status).toBe(200);
            expect(queries).toEqual([{ external_id: 'user_42', plan: 'pro' }]);
            // The access check is the only call to Mesub.
            expect(calls).toEqual(['/v1/access']);
        });

        it.each([
            ['a wallet as a string', WALLET, { wallet: WALLET }],
            ['a wallet as an object', { wallet: WALLET }, { wallet: WALLET }],
            ['an email, normalised', { email: ' Ada@Example.com ' }, { email: 'ada@example.com' }],
            ['an external id, trimmed', { external_id: ' u1 ' }, { external_id: 'u1' }],
        ])('asks Mesub about %s', async (_name, named, query) => {
            const { queries, access } = asked();
            const { client } = mesub({ access });

            await request(app(client, { customer: () => named }))
                .get('/pro')
                .expect(200);

            expect(queries).toEqual([{ ...query, plan: 'pro' }]);
        });

        it('may be async', async () => {
            const { client } = mesub();

            await request(app(client, { customer: async () => ({ external_id: 'user_42' }) }))
                .get('/pro')
                .expect(200);
        });

        it('reads it from the request the merchant verified', async () => {
            const { queries, access } = asked();
            const { client } = mesub({ access });
            const server = express();
            server.use((req, _res, next) => {
                (req as ExpressRequest & { user?: { id: string } }).user = { id: 'user_7' };
                next();
            });
            server.get(
                '/pro',
                requirePlan('pro', {
                    client,
                    customer: (req) => ({
                        external_id: (req as ExpressRequest & { user: { id: string } }).user.id,
                    }),
                }),
                (_req, res) => res.json({ ok: true }),
            );

            await request(server).get('/pro').expect(200);

            expect(queries).toEqual([{ external_id: 'user_7', plan: 'pro' }]);
        });

        it.each([null, undefined])(
            'answers 401 when it returns %s: nobody is signed in',
            async (none) => {
                const { client, calls } = mesub();

                const response = await request(app(client, { customer: () => none })).get('/pro');

                expect(response.status).toBe(401);
                expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
                expect(calls).toEqual([]);
            },
        );

        it('leaves the customer and the wallet Mesub answered with', async () => {
            const { client } = mesub();

            const response = await request(
                app(client, { customer: () => ({ external_id: 'user_42' }) }),
            ).get('/pro');

            expect(response.body).toEqual({
                wallet: WALLET,
                customer: { kind: 'external_id', value: 'user_42' },
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        it('answers 402 when Mesub says no for that customer', async () => {
            const { client } = mesub({
                access: () =>
                    Response.json(answer({ access: false, status: 'none', wallet: null })),
            });

            const response = await request(
                app(client, { customer: () => ({ email: 'ada@example.com' }) }),
            ).get('/pro');

            expect(response.status).toBe(402);
            expect(response.body).toEqual({ access: false, reason: 'no_access', status: 'none' });
        });

        it('answers 503 with Retry-After when Mesub is down and nothing is cached', async () => {
            const { client } = mesub({ access: () => new Response('down', { status: 503 }) });

            const response = await request(
                app(client, { customer: () => ({ external_id: 'user_42' }) }),
            ).get('/pro');

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
        });

        it('does not work out the plan for nobody', async () => {
            const { client } = mesub();
            const plan = vi.fn(() => 'pro');

            await request(app(client, { customer: () => null }, plan))
                .get('/pro')
                .expect(401);

            expect(plan).not.toHaveBeenCalled();
        });

        it.each([
            ['two identifiers', { external_id: 'u1', email: 'a@b.co' }],
            ['none', {}],
            ['a value that is not a string', { external_id: 42 }],
            ['an empty string', ''],
            ['an empty external id', { external_id: '  ' }],
            ['a number', 42],
        ])(
            'forwards %s to next(err): a broken integration, not a refusal',
            async (_name, named) => {
                const { client, calls } = mesub();

                const response = await request(app(client, { customer: () => named as never })).get(
                    '/pro',
                );

                expect(response.status).toBe(500);
                expect(response.body).toEqual({ forwarded: 'other' });
                expect(calls).toEqual([]);
            },
        );

        it('forwards a throw, and a rejection, to next(err)', async () => {
            const { client } = mesub();
            const boom = () => {
                throw new MesubError('boom', { status: null, code: 'unexpected' });
            };

            for (const customer of [boom, async () => boom()]) {
                const response = await request(app(client, { customer })).get('/pro');

                expect(response.status).toBe(500);
                expect(response.body).toEqual({ forwarded: 'unexpected' });
            }
        });

        it.each([
            ['no options at all', undefined],
            ['options without it', {}],
            ['one that is not a function', { customer: { external_id: 'u1' } }],
        ])('refuses %s when built, and says what to pass', (_name, options) => {
            const { client } = mesub();
            const build = () =>
                options === undefined
                    ? (requirePlan as (plan: string) => unknown)('pro')
                    : requirePlan('pro', { client, ...options } as never);

            expect(build).toThrow(TypeError);
            expect(build).toThrow(/needs `customer`: a function of the request/);
        });

        it('keeps one customer apart from another: no shared cached answer', async () => {
            const { queries, access } = asked();
            const { client } = mesub({ access });
            let who = 'user_1';
            const server = app(client, { customer: () => ({ external_id: who }) });

            await request(server).get('/pro').expect(200);
            who = 'user_2';
            await request(server).get('/pro').expect(200);

            expect(queries.map((query) => query['external_id'])).toEqual(['user_1', 'user_2']);
        });
    });

    describe('402, no access', () => {
        it('answers 402 with the status for a subscriber without access', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'stopped' })),
            });

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(402);
            expect(response.body).toEqual({
                access: false,
                reason: 'no_access',
                status: 'stopped',
            });
        });

        // Mesub down, but this wallet was seen and had access: it stays in.
        it('keeps a known subscriber in during an outage', async () => {
            let down = false;
            const { client } = mesub({
                access: () =>
                    down
                        ? Response.json({ message: 'down' }, { status: 503 })
                        : Response.json(answer({ revalidate_after: 0 })),
            });
            const server = app(client);
            await request(server).get('/pro').set(SIGNED_IN).expect(200);

            down = true;
            const response = await request(server).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body.stale).toBe(true);
        });
    });

    describe('503, nobody knows yet', () => {
        // 402 only means Mesub said no: failing, it said nothing about this wallet.
        it.each([
            ['an outage', 503],
            ['a rate limit', 429],
        ])('answers 503 with Retry-After for an unseen wallet on %s', async (_label, status) => {
            const { client } = mesub({
                access: () => Response.json({ message: 'down' }, { status }),
            });

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        // A guard holds a request for guardTimeout at most, never for an outage (#24).
        it('answers 503 with Retry-After when Mesub does not answer within guardTimeout', async () => {
            const { client } = mesub({ access: hang }, { guardTimeout: 50 });

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        it('keeps a known subscriber in when the budget runs out', async () => {
            let down = false;
            const { client } = mesub(
                {
                    access: (init) =>
                        down ? hang(init) : Response.json(answer({ revalidate_after: 0 })),
                },
                { guardTimeout: 50 },
            );
            const server = app(client);
            // Seen once outside the guard, with no budget: 50 ms is short on a busy machine.
            await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            down = true;
            const response = await request(server).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body.stale).toBe(true);
        });
    });

    // #38: any one of several plans, or the plan worked out per request.
    describe('which plan', () => {
        const yes = (plan: string) => () => Response.json(answer({ plan }));
        const no =
            (plan: string, status: SubscriptionStatus = 'none') =>
            () =>
                Response.json(answer({ plan, access: false, status }));
        const down = () => Response.json({ message: 'down' }, { status: 503 });

        it('lets through on the first plan of the list that grants, and says which', async () => {
            const { client } = mesub({ access: perPlan({ pro: no('pro'), team: yes('team') }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ plan: 'team', answer: { plan: 'team' } });
        });

        it('prefers the earlier plan when several grant', async () => {
            const { client } = mesub({ access: perPlan({ pro: yes('pro'), team: yes('team') }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.body.plan).toBe('pro');
        });

        it('does not wait for the plans after the one that grants', async () => {
            let gaveUp = false;
            const team = (init?: RequestInit) => {
                init?.signal?.addEventListener('abort', () => (gaveUp = true));
                return hang(init);
            };
            const { client } = mesub({ access: perPlan({ pro: yes('pro'), team }) });

            await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN)
                .expect(200);

            // No clock read: `team` is still out, with its whole budget ahead, when the answer is in.
            expect(gaveUp).toBe(false);
        });

        // A guard holds a request for guardTimeout at most, whatever the number of plans.
        it('asks every plan within one guardTimeout', async () => {
            let out = 0;
            const outAtGiveUp: number[] = [];
            const slow = (init?: RequestInit) => {
                out += 1;
                init?.signal?.addEventListener('abort', () => outAtGiveUp.push(out));
                return hang(init);
            };
            const { client } = mesub(
                { access: perPlan({ a: slow, b: slow, c: slow }) },
                { guardTimeout: 500 },
            );

            await request(app(client, {}, ['a', 'b', 'c']))
                .get('/pro')
                .set(SIGNED_IN)
                .expect(503);

            // No clock read: one after the other, the first would give up before the next is asked.
            expect(outAtGiveUp).toEqual([3, 3, 3]);
        });

        it("answers 402 with the first plan's status when none grants", async () => {
            const { client } = mesub({
                access: perPlan({ pro: no('pro', 'stopped'), team: no('team') }),
            });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(402);
            expect(response.body).toEqual({
                access: false,
                reason: 'no_access',
                status: 'stopped',
            });
        });

        // 402 only means Mesub said no, for every plan: one it said nothing about is a 503.
        it('answers 503 when one says no and Mesub fails the other on an unseen wallet', async () => {
            const { client } = mesub({ access: perPlan({ pro: no('pro'), team: down }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
        });

        it('lets through on a later plan when Mesub fails an earlier one', async () => {
            const { client } = mesub({ access: perPlan({ pro: down, team: yes('team') }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body.plan).toBe('team');
        });

        // The outage fallback is per plan: the one known to grant keeps them in.
        it('keeps a subscriber in on the plan cached as granting during an outage', async () => {
            let outage = false;
            const { client } = mesub({
                access: perPlan({
                    pro: () => (outage ? down() : no('pro')()),
                    team: () =>
                        outage
                            ? down()
                            : Response.json(answer({ plan: 'team', revalidate_after: 0 })),
                }),
            });
            const server = app(client, {}, ['pro', 'team']);
            await request(server).get('/pro').set(SIGNED_IN).expect(200);

            outage = true;
            const response = await request(server).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ plan: 'team', stale: true });
        });

        it('asks about the plan a function picks for the request', async () => {
            const { client } = mesub({ access: perPlan({ team: yes('team') }) });
            const decide = vi.spyOn(client, 'decide');

            const response = await request(app(client, {}, (req) => String(req.query['tier'])))
                .get('/pro?tier=team')
                .set(SIGNED_IN);

            expect(response.status).toBe(200);
            expect(response.body.plan).toBe('team');
            expect(decide).toHaveBeenCalledExactlyOnceWith(WALLET, 'team');
        });

        it('takes a list from a function too', async () => {
            const { client } = mesub({ access: perPlan({ pro: no('pro'), team: yes('team') }) });

            await request(app(client, {}, () => ['pro', 'team']))
                .get('/pro')
                .set(SIGNED_IN)
                .expect(200);
        });

        it('asks each plan once', async () => {
            const { client } = mesub();
            const decide = vi.spyOn(client, 'decide');

            await request(app(client, {}, ['pro', 'pro']))
                .get('/pro')
                .set(SIGNED_IN)
                .expect(200);

            expect(decide).toHaveBeenCalledOnce();
        });

        // An unknown plan is a broken integration, unless an earlier plan already let them in.
        it('forwards an unknown plan after one that said no to next(err)', async () => {
            const unknown = () =>
                Response.json(
                    { message: 'nope', statusCode: 404, code: 'plan_not_found' },
                    { status: 404 },
                );
            const { client } = mesub({ access: perPlan({ pro: no('pro'), typo: unknown }) });

            const response = await request(app(client, {}, ['pro', 'typo']))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'plan_not_found' });
        });

        it.each([
            ['an empty list', []],
            ['an empty slug', ''],
            ['an empty slug in the list', ['pro', '']],
            ['more than three plans', ['pro', 'team', 'max', 'org']],
        ])('refuses %s when the guard is built', (_label, plan) => {
            const { client } = mesub();

            expect(() => requirePlan(plan, { client, customer: session })).toThrow(/plan/);
        });

        // Each plan is one call to Mesub on every request: three, what a Dev project holds.
        it('counts a plan listed twice once against the three', () => {
            const { client } = mesub();

            expect(() =>
                requirePlan(['pro', 'pro', 'team', 'team', 'max'], { client, customer: session }),
            ).not.toThrow();
        });

        it('forwards a function giving more than three plans to next(err), asking none', async () => {
            const { client } = mesub();
            const decide = vi.spyOn(client, 'decide');

            const response = await request(app(client, {}, (req) => req.query['tier'] as string[]))
                .get('/pro?tier=a&tier=b&tier=c&tier=d')
                .set(SIGNED_IN);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'other' });
            expect(decide).not.toHaveBeenCalled();
        });

        it('never runs the function for a request nobody is signed in on', async () => {
            const { client } = mesub();
            const plan = vi.fn(() => {
                throw new Error('should not run');
            });

            await request(app(client, {}, plan))
                .get('/pro?tier=a&tier=b&tier=c&tier=d')
                .expect(401);
            expect(plan).not.toHaveBeenCalled();
        });

        it('forwards a function giving no plan to next(err)', async () => {
            const { client } = mesub();

            const response = await request(app(client, {}, () => []))
                .get('/pro')
                .set(SIGNED_IN);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'other' });
        });
    });

    describe('onDenied', () => {
        it('lets the merchant answer a refusal', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'none' })),
            });
            const onDenied = vi.fn((denial, _req, res: ExpressResponse) =>
                res.redirect(302, `/subscribe?why=${denial.reason}`),
            );

            const response = await request(app(client, { onDenied })).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(302);
            expect(response.headers['location']).toBe('/subscribe?why=no_access');
            expect(onDenied.mock.calls[0]![0]).toMatchObject({
                reason: 'no_access',
                status: 402,
                answer: { status: 'none' },
            });
        });

        it('hands it the 401 too', async () => {
            const { client } = mesub();
            const onDenied = vi.fn((_denial, _req, res: ExpressResponse) => res.status(418).end());

            await request(app(client, { onDenied })).get('/pro').expect(418);
            expect(onDenied.mock.calls[0]![0]).toMatchObject({
                reason: 'unauthenticated',
                status: 401,
                answer: null,
            });
        });

        // #45: an async onDenied is awaited, and its failure reaches next(err).
        it('waits for an async one before the request ends', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(async (_denial, _req, res: ExpressResponse) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                res.status(418).json({ waited: true });
            });

            const response = await request(app(client, { onDenied })).get('/pro');

            expect(response.status).toBe(418);
            expect(response.body).toEqual({ waited: true });
        });

        it.each([
            [
                'a throw',
                () => {
                    throw new MesubError('boom', { status: null, code: 'unexpected' });
                },
            ],
            [
                'a rejection',
                async () => {
                    await Promise.resolve();
                    throw new MesubError('boom', { status: null, code: 'unexpected' });
                },
            ],
        ])('forwards %s to next(err)', async (_label, onDenied) => {
            const { client } = mesub();

            const response = await request(app(client, { onDenied })).get('/pro');

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'unexpected' });
        });

        // Express 4 ignores the promise a middleware returns: it must never reject.
        it('never leaves a rejected promise behind, as Express 4 would drop it', async () => {
            const { client } = mesub();
            const failure = new Error('onDenied failed');
            const middleware = requirePlan('pro', {
                client,
                customer: () => null,
                onDenied: async () => {
                    throw failure;
                },
            });
            const next = vi.fn();

            await expect(
                (middleware as unknown as (...args: unknown[]) => Promise<void>)(
                    { headers: {} },
                    {},
                    next,
                ),
            ).resolves.toBeUndefined();
            expect(next).toHaveBeenCalledExactlyOnceWith(failure);
        });

        it('is never called for a subscriber with access', async () => {
            const { client } = mesub();
            const onDenied = vi.fn();

            await request(app(client, { onDenied })).get('/pro').set(SIGNED_IN).expect(200);
            expect(onDenied).not.toHaveBeenCalled();
        });
    });

    // A broken integration must reach the merchant's error handler, not look like a denial.
    describe('integration errors', () => {
        it.each([
            ['a bad API key', 401, 'unauthorized'],
            ['an unknown plan', 404, 'plan_not_found'],
        ])('forwards %s to next(err)', async (_label, status, code) => {
            const { client } = mesub({
                access: () =>
                    Response.json({ message: 'nope', statusCode: status, code }, { status }),
            });

            const response = await request(app(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: code });
        });

        /** The same route with no error handler of the app's own: Express's answers. */
        function bare(client: Mesub, options: Partial<Omit<RequirePlanOptions, 'client'>> = {}) {
            const server = express();
            server.get('/pro', requirePlan('pro', { customer: session, ...options, client }));
            return server;
        }

        /** The same route, keeping what its error handler was handed. */
        function caught(client: Mesub, options: Partial<Omit<RequirePlanOptions, 'client'>> = {}) {
            const seen: unknown[] = [];
            const server = bare(client, options);
            server.use(
                (
                    error: unknown,
                    _req: ExpressRequest,
                    res: ExpressResponse,
                    _next: NextFunction,
                ) => {
                    seen.push(error);
                    res.status(500).end();
                },
            );
            return { server, seen };
        }

        // #120: Express's own handler answers an error's `status`, and a 401 reads as "not signed in".
        it.each([
            ['a bad API key', 401, 'invalid_api_key'],
            ['an unknown plan', 404, 'plan_not_found'],
        ])('answers 500 on %s with no error handler', async (_label, status, code) => {
            const { client } = mesub({
                access: () =>
                    Response.json({ message: 'nope', statusCode: status, code }, { status }),
            });

            const response = await request(bare(client)).get('/pro').set(SIGNED_IN);

            expect(response.status).toBe(500);
            expect(response.body).not.toHaveProperty('access');
        });

        it('hands the error handler a MesubError of status 500, the original as its cause', async () => {
            const { client } = mesub({
                access: () =>
                    Response.json(
                        { message: 'nope', statusCode: 401, code: 'invalid_api_key' },
                        { status: 401, headers: { 'Retry-After': '7' } },
                    ),
            });
            const { server, seen } = caught(client);

            await request(server).get('/pro').set(SIGNED_IN).expect(500);

            const [error] = seen as [MesubError];
            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({
                status: 500,
                code: 'unauthorized',
                apiCode: 'invalid_api_key',
                retryable: false,
                retryAfter: 7000,
                body: { code: 'invalid_api_key' },
            });
            expect(error.cause).toBeInstanceOf(MesubError);
            expect(error.cause).toMatchObject({
                status: 401,
                code: 'unauthorized',
                apiCode: 'invalid_api_key',
            });
        });

        it.each([
            ['a MesubError of a 5xx', new MesubError('down', { status: 503, code: 'unavailable' })],
            [
                'a MesubError of no status',
                new MesubError('cut', { status: null, code: 'unavailable' }),
            ],
            ["an error that is not Mesub's", new TypeError('yours')],
            ['an error of yours with a status', Object.assign(new Error('gone'), { status: 410 })],
        ])('hands %s to next(err) as it is', async (_label, thrown) => {
            const { client } = mesub();
            const { server, seen } = caught(client, {
                customer: () => {
                    throw thrown;
                },
            });

            await request(server).get('/pro').expect(500);

            expect(seen).toEqual([thrown]);
            expect(seen[0]).toBe(thrown);
        });
    });
});
