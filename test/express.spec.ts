import express, {
    type NextFunction,
    type Request as ExpressRequest,
    type Response as ExpressResponse,
} from 'express';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
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
const PROJECT = 'proj_1';
const WALLET = 'SysvarRent111111111111111111111111111111111';

let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' };
});

function answer(over: Partial<AccessAnswer> = {}): AccessAnswer {
    return {
        wallet: WALLET,
        plan: 'pro',
        access: true,
        status: 'active',
        paused: false,
        end_reason: null,
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

/** A merchant's own session JWT, sent as a bearer on every request: not a Mesub token. */
function theirs() {
    return new SignJWT({ role: 'admin' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('merchant_user_9')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('the-merchant-own-secret-32-bytes!!'));
}

async function token(over: { aud?: string; exp?: string } = {}) {
    return new SignJWT({ wallet: WALLET })
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setSubject('user_1')
        .setAudience(over.aud ?? PROJECT)
        .setIssuer(BASE)
        .setIssuedAt()
        .setExpirationTime(over.exp ?? '1h')
        .sign(privateKey);
}

interface Mesh {
    /** What /v1/access answers, per call. */
    access?: (init?: RequestInit, url?: URL) => Response | Promise<Response>;
    /** What the JWKS and /v1/project answer; healthy by default. */
    keys?: () => Response;
    project?: () => Response;
}

/** A Mesub whose API is a function, so each test says what it answers. */
function mesub(mesh: Mesh = {}, options: MesubOptions = {}) {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        calls.push(url.pathname);
        if (url.pathname === '/.well-known/jwks.json')
            return mesh.keys?.() ?? Response.json({ keys: [jwk] });
        if (url.pathname === '/v1/project')
            return mesh.project?.() ?? Response.json({ id: PROJECT });
        if (url.pathname === '/v1/access')
            return (mesh.access ?? (() => Response.json(answer())))(init, url);
        throw new Error(`unexpected ${url.pathname}`);
    });
    const client = new Mesub({
        apiKey: 'SUB_test',
        baseUrl: BASE,
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 0,
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

/** An app with one guarded route that echoes res.locals.mesub. */
function app(
    client: Mesub,
    options: Omit<RequirePlanOptions, 'client'> = {},
    plan: PlanOption<ExpressRequest> = 'pro',
) {
    const server = express();
    server.get('/pro', requirePlan(plan, { ...options, client }), (_req, res) => {
        res.json(res.locals['mesub'] as MesubLocals);
    });
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

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
        });

        it('leaves who they are and the answer on res.locals.mesub', async () => {
            const { client } = mesub();

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.body).toEqual({
                userId: 'user_1',
                wallet: WALLET,
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        it('reads the token from the mesub-token cookie', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Cookie', `mesub-token=${await token()}`)
                .expect(200);
        });

        // The wallet asked about is the token's, never one the request names.
        it('asks Mesub about the wallet in the token', async () => {
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
                .set('Authorization', `Bearer ${await token()}`)
                .set('x-wallet', 'Attacker111111111111111111111111111111111111');

            expect(asked).toBe(WALLET);
            spy.mockRestore();
        });
    });

    describe('401, not signed in', () => {
        it.each([
            ['no token at all', {} as Record<string, string>],
            ['another scheme', { Authorization: 'Basic abc' }],
        ])('answers 401 on %s', async (_label, headers) => {
            const { client } = mesub();

            const response = await request(app(client)).get('/pro').set(headers);

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
        });

        it('answers 401 on a token for another project', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ aud: 'proj_2' })}`)
                .expect(401);
        });

        it('answers 401 on an expired token', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ exp: '-10s' })}`)
                .expect(401);
        });

        it('answers 401 on something that is not a token', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', 'Bearer not-a-token')
                .expect(401);
        });

        it('answers 401, not 500, on a cookie that is not valid percent-encoding', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Cookie', 'mesub-token=%E0%A4%A')
                .expect(401);
        });

        it('never asks /v1/access without a valid token', async () => {
            const { client, calls } = mesub();

            await request(app(client)).get('/pro');

            expect(calls).not.toContain('/v1/access');
        });
    });

    // A merchant's own `Authorization: Bearer` must not hide the cookie (#36).
    describe('a bearer that is not a Mesub token', () => {
        it('falls back on the mesub-token cookie', async () => {
            const { client } = mesub();

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .set('Cookie', `mesub-token=${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body.wallet).toBe(WALLET);
        });

        it('falls back on the cookie when the bearer is an expired Mesub token', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ exp: '-10s' })}`)
                .set('Cookie', `mesub-token=${await token()}`)
                .expect(200);
        });

        it('answers 401 when there is no cookie behind it', async () => {
            const { client, calls } = mesub();

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`);

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
            expect(calls).not.toContain('/v1/access');
        });

        it('answers 401 when the cookie does not verify either', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .set('Cookie', `mesub-token=${await token({ aud: 'proj_2' })}`)
                .expect(401);
        });

        // An outage is not a bad token: the next one would meet the same outage.
        it('never tries the cookie once the keys could not be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });
            const verify = vi.spyOn(client, 'verifyToken');

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .set('Cookie', `mesub-token=${await token({ exp: '2h' })}`);

            expect(response.status).toBe(503);
            expect(verify).toHaveBeenCalledOnce();
        });
    });

    describe('token option', () => {
        it('reads the token where it says', async () => {
            const { client } = mesub();

            await request(app(client, { token: (req: ExpressRequest) => req.get('x-mesub-token') }))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .set('x-mesub-token', await token())
                .expect(200);
        });

        it('is then the only place looked at', async () => {
            const { client } = mesub();

            await request(app(client, { token: () => null }))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .set('Cookie', `mesub-token=${await token()}`)
                .expect(401);
        });

        it('forwards a throw to next(err)', async () => {
            const { client } = mesub();

            const response = await request(
                app(client, {
                    token: () => {
                        throw new MesubError('boom', { status: null, code: 'unexpected' });
                    },
                }),
            ).get('/pro');

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'unexpected' });
        });
    });

    describe('402, no access', () => {
        it('answers 402 with the status for a subscriber without access', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'stopped' })),
            });

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

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
            const bearer = `Bearer ${await token()}`;
            await request(server).get('/pro').set('Authorization', bearer).expect(200);

            down = true;
            const response = await request(server).get('/pro').set('Authorization', bearer);

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

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        it('answers 503 with Retry-After when the keys cannot be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        // A guard holds a request for guardTimeout at most, never for an outage (#24).
        it('answers 503 with Retry-After when Mesub does not answer within guardTimeout', async () => {
            const { client } = mesub({ access: hang }, { guardTimeout: 50 });

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

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
            const bearer = `Bearer ${await token()}`;
            await request(server).get('/pro').set('Authorization', bearer).expect(200);

            down = true;
            const response = await request(server).get('/pro').set('Authorization', bearer);

            expect(response.status).toBe(200);
            expect(response.body.stale).toBe(true);
        });

        it('answers 503 when the project id cannot be fetched', async () => {
            const { client } = mesub({
                project: () => Response.json({ message: 'down' }, { status: 503 }),
            });

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(503);
        });

        // A token of another project must not get in when the id is missing (#27).
        it.each([
            ['no id', {}],
            ['an empty id', { id: '' }],
        ])('answers 503, never 200, when /v1/project answers %s', async (_label, body) => {
            const { client } = mesub({ project: () => Response.json(body) });

            await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ aud: 'proj_other' })}`)
                .expect(503);
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
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ plan: 'team', answer: { plan: 'team' } });
        });

        it('prefers the earlier plan when several grant', async () => {
            const { client } = mesub({ access: perPlan({ pro: yes('pro'), team: yes('team') }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.body.plan).toBe('pro');
        });

        it('does not wait for the plans after the one that grants', async () => {
            const { client } = mesub(
                { access: perPlan({ pro: yes('pro'), team: hang }) },
                { guardTimeout: 5_000 },
            );
            const started = Date.now();

            await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(200);

            expect(Date.now() - started).toBeLessThan(1_000);
        });

        // A guard holds a request for guardTimeout at most, whatever the number of plans.
        it('asks every plan within one guardTimeout', async () => {
            const { client } = mesub(
                { access: perPlan({ a: hang, b: hang, c: hang }) },
                { guardTimeout: 100 },
            );
            const started = Date.now();

            await request(app(client, {}, ['a', 'b', 'c']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(503);

            expect(Date.now() - started).toBeLessThan(250);
        });

        it("answers 402 with the first plan's status when none grants", async () => {
            const { client } = mesub({
                access: perPlan({ pro: no('pro', 'stopped'), team: no('team') }),
            });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

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
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
        });

        it('lets through on a later plan when Mesub fails an earlier one', async () => {
            const { client } = mesub({ access: perPlan({ pro: down, team: yes('team') }) });

            const response = await request(app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

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
            const bearer = `Bearer ${await token()}`;
            await request(server).get('/pro').set('Authorization', bearer).expect(200);

            outage = true;
            const response = await request(server).get('/pro').set('Authorization', bearer);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ plan: 'team', stale: true });
        });

        it('asks about the plan a function picks for the request', async () => {
            const { client } = mesub({ access: perPlan({ team: yes('team') }) });
            const decide = vi.spyOn(client, 'decide');

            const response = await request(app(client, {}, (req) => String(req.query['tier'])))
                .get('/pro?tier=team')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body.plan).toBe('team');
            expect(decide).toHaveBeenCalledExactlyOnceWith(WALLET, 'team');
        });

        it('takes a list from a function too', async () => {
            const { client } = mesub({ access: perPlan({ pro: no('pro'), team: yes('team') }) });

            await request(app(client, {}, () => ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(200);
        });

        it('asks each plan once', async () => {
            const { client } = mesub();
            const decide = vi.spyOn(client, 'decide');

            await request(app(client, {}, ['pro', 'pro']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
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
                .set('Authorization', `Bearer ${await token()}`);

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

            expect(() => requirePlan(plan, { client })).toThrow(TypeError);
        });

        // Each plan is one call to Mesub on every request: three, what a Dev project holds.
        it('counts a plan listed twice once against the three', () => {
            const { client } = mesub();

            expect(() =>
                requirePlan(['pro', 'pro', 'team', 'team', 'max'], { client }),
            ).not.toThrow();
        });

        it('forwards a function giving more than three plans to next(err), asking none', async () => {
            const { client } = mesub();
            const decide = vi.spyOn(client, 'decide');

            const response = await request(app(client, {}, (req) => req.query['tier'] as string[]))
                .get('/pro?tier=a&tier=b&tier=c&tier=d')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: 'other' });
            expect(decide).not.toHaveBeenCalled();
        });

        it('never runs the function for a request without a Mesub token', async () => {
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
                .set('Authorization', `Bearer ${await token()}`);

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

            const response = await request(app(client, { onDenied }))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

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

            await request(app(client, { onDenied }))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(200);
            expect(onDenied).not.toHaveBeenCalled();
        });
    });

    // A broken integration must reach the merchant's error handler, not look like a denial.
    describe('integration errors', () => {
        it.each([
            ['a bad secret key', 401, 'unauthorized'],
            ['an unknown plan', 404, 'plan_not_found'],
        ])('forwards %s to next(err)', async (_label, status, code) => {
            const { client } = mesub({
                access: () =>
                    Response.json({ message: 'nope', statusCode: status, code }, { status }),
            });

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: code });
        });
    });
});
