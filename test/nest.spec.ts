import 'reflect-metadata';

import {
    Controller,
    type ExecutionContext,
    Get,
    HttpException,
    type INestApplication,
    Query,
    UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import request from 'supertest';

import type { AccessAnswer } from '../src/answer.js';
import { Mesub, type MesubOptions } from '../src/index.js';
import {
    MesubAccess,
    MesubError,
    type MesubRequest,
    type PlanOption,
    RequirePlan,
    type RequirePlanOptions,
} from '../src/nest.js';

const BASE = 'https://api.mesub.test';
const PROJECT = 'proj_1';
const WALLET = 'SysvarRent111111111111111111111111111111111';
const ATTACKER = 'Attacker111111111111111111111111111111111111';

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

const apps: INestApplication[] = [];

afterEach(async () => {
    await Promise.all(apps.splice(0).map((nest) => nest.close()));
});

/** A Nest app with a guarded route echoing `@MesubAccess()`, and a guarded controller. */
async function app(
    client: Mesub,
    options: Omit<RequirePlanOptions, 'client'> = {},
    plan: PlanOption<MesubRequest> = 'pro',
) {
    @Controller()
    class RouteController {
        @Get('pro')
        @UseGuards(RequirePlan(plan, { ...options, client }))
        pro(@MesubAccess() mesub: MesubAccess, @Query('wallet') _wallet?: string) {
            return mesub;
        }

        @Get('open')
        open() {
            return { open: true };
        }
    }

    @Controller('reports')
    @UseGuards(RequirePlan('pro', { ...options, client }))
    class ReportsController {
        @Get()
        list(@MesubAccess() mesub: MesubAccess) {
            return { wallet: mesub.wallet };
        }
    }

    const module = await Test.createTestingModule({
        controllers: [RouteController, ReportsController],
    }).compile();
    const nest = module.createNestApplication({ logger: false });
    await nest.init();
    apps.push(nest);

    return nest.getHttpServer();
}

describe('RequirePlan', () => {
    describe('letting through', () => {
        it('lets a subscriber with access reach the route', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(200);
        });

        it('gives who they are and the answer through @MesubAccess()', async () => {
            const { client } = mesub();

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.body).toEqual({
                userId: 'user_1',
                wallet: WALLET,
                customer: { kind: 'wallet', value: WALLET },
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        it('reads the token from the mesub-token cookie', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Cookie', `mesub-token=${await token()}`)
                .expect(200);
        });

        // The wallet asked about is the token's, never one the request names.
        it('asks Mesub about the wallet in the token', async () => {
            const { client } = mesub();
            const decide = vi.spyOn(client, 'decide');

            const response = await request(await app(client))
                .get(`/pro?wallet=${ATTACKER}`)
                .set('Authorization', `Bearer ${await token()}`)
                .set('x-wallet', ATTACKER);

            expect(decide).toHaveBeenCalledWith(WALLET, 'pro');
            expect(response.body.wallet).toBe(WALLET);
        });

        it('leaves unguarded routes alone', async () => {
            const { client, calls } = mesub();

            await request(await app(client))
                .get('/open')
                .expect(200);
            expect(calls).toEqual([]);
        });
    });

    describe('401, not signed in', () => {
        it.each([
            ['no token at all', {} as Record<string, string>],
            ['another scheme', { Authorization: 'Basic abc' }],
        ])('answers 401 on %s', async (_label, headers) => {
            const { client } = mesub();

            const response = await request(await app(client))
                .get('/pro')
                .set(headers);

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
        });

        it('answers 401 on a token for another project', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ aud: 'proj_2' })}`)
                .expect(401);
        });

        it('answers 401 on an expired token', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token({ exp: '-10s' })}`)
                .expect(401);
        });

        it('answers 401 on something that is not a token', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Authorization', 'Bearer not-a-token')
                .expect(401);
        });

        it('never asks /v1/access without a valid token', async () => {
            const { client, calls } = mesub();

            await request(await app(client)).get('/pro');

            expect(calls).not.toContain('/v1/access');
        });
    });

    // A merchant's own `Authorization: Bearer` must not hide the cookie (#36).
    describe('a bearer that is not a Mesub token', () => {
        it('falls back on the mesub-token cookie', async () => {
            const { client } = mesub();

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .set('Cookie', `mesub-token=${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body.wallet).toBe(WALLET);
        });

        it('answers 401 when there is no cookie behind it', async () => {
            const { client } = mesub();

            await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .expect(401);
        });

        it('never tries the cookie once the keys could not be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });
            const verify = vi.spyOn(client, 'verifyToken');

            await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .set('Cookie', `mesub-token=${await token({ exp: '2h' })}`)
                .expect(503);
            expect(verify).toHaveBeenCalledOnce();
        });

        it('reads the token where the token option says, and only there', async () => {
            const { client } = mesub();
            const server = await app(client, {
                token: (request) => (request.headers as Record<string, string>)['x-mesub-token'],
            });

            await request(server)
                .get('/pro')
                .set('Authorization', `Bearer ${await theirs()}`)
                .set('x-mesub-token', await token())
                .expect(200);
            await request(server)
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(401);
        });
    });

    describe('customer option: who is asking, from the merchant own auth', () => {
        it('lets a customer through by external id, with no Mesub token at all', async () => {
            const queries: Record<string, string>[] = [];
            const { client, calls } = mesub({
                access: (_init, url) => {
                    queries.push(Object.fromEntries(url!.searchParams));
                    return Response.json(answer());
                },
            });

            const response = await request(
                await app(client, { customer: () => ({ external_id: 'user_42' }) }),
            ).get('/pro');

            expect(response.status).toBe(200);
            expect(queries).toEqual([{ external_id: 'user_42', plan: 'pro' }]);
            expect(calls).toEqual(['/v1/access']);
            expect(response.body).toEqual({
                userId: null,
                wallet: WALLET,
                customer: { kind: 'external_id', value: 'user_42' },
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        it('may be async, and guards a whole controller too', async () => {
            const { client } = mesub();

            const response = await request(
                await app(client, { customer: async () => ({ email: 'ada@example.com' }) }),
            ).get('/reports');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ wallet: WALLET });
        });

        it.each([null, undefined])(
            'answers 401 when it returns %s, a Mesub token or not',
            async (none) => {
                const { client, calls } = mesub();

                const response = await request(await app(client, { customer: () => none }))
                    .get('/pro')
                    .set('Authorization', `Bearer ${await token()}`);

                expect(response.status).toBe(401);
                expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
                expect(calls).toEqual([]);
            },
        );

        it('answers 402 when Mesub says no for that customer', async () => {
            const { client } = mesub({
                access: () =>
                    Response.json(answer({ access: false, status: 'none', wallet: null })),
            });

            await request(await app(client, { customer: () => WALLET }))
                .get('/pro')
                .expect(402);
        });

        it('answers 500 for what cannot be asked about: a broken integration, not a refusal', async () => {
            const { client } = mesub();

            await request(
                await app(client, {
                    customer: () => ({ external_id: 'u', email: 'a@b.co' }) as never,
                }),
            )
                .get('/pro')
                .expect(500);
        });

        it('refuses to be built with a token too', () => {
            const { client } = mesub();

            expect(() =>
                RequirePlan('pro', { client, customer: () => null, token: () => null }),
            ).toThrow(TypeError);
        });
    });

    describe('402, no access', () => {
        it('answers 402 with the status for a subscriber without access', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'stopped' })),
            });

            const response = await request(await app(client))
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
            const server = await app(client);
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

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        it('answers 503 with Retry-After when the keys cannot be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        // A guard holds a request for guardTimeout at most, never for an outage (#24).
        it('answers 503 with Retry-After when Mesub does not answer within guardTimeout', async () => {
            const { client } = mesub({ access: hang }, { guardTimeout: 50 });

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
            expect(response.body).toEqual({ access: false, reason: 'unavailable' });
        });

        it('answers 503 when the project id cannot be fetched', async () => {
            const { client } = mesub({
                project: () => Response.json({ message: 'down' }, { status: 503 }),
            });

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(503);
            expect(response.headers['retry-after']).toBe('30');
        });

        // A Fastify reply has `header`, not `setHeader`.
        it('sets Retry-After on a Fastify reply too', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });
            const reply = { header: vi.fn() };
            const headers = { authorization: `Bearer ${await token()}` };
            const context = {
                switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => reply }),
            } as unknown as ExecutionContext;
            const guard = new (RequirePlan('pro', { client }))();

            const thrown = await (guard.canActivate(context) as Promise<boolean>).catch(
                (error: unknown) => error,
            );

            expect(thrown).toBeInstanceOf(HttpException);
            expect((thrown as HttpException).getStatus()).toBe(503);
            expect(reply.header).toHaveBeenCalledWith('Retry-After', '30');
        });

        it('sends no Retry-After on other refusals', async () => {
            const { client } = mesub();

            const response = await request(await app(client)).get('/pro');

            expect(response.headers['retry-after']).toBeUndefined();
        });
    });

    // #38: any one of several plans, or the plan worked out per request.
    describe('which plan', () => {
        const no = () => Response.json(answer({ access: false, status: 'none' }));
        const yes = () => Response.json(answer({ plan: 'team' }));

        it('lets through on the first plan of the list that grants, and says which', async () => {
            const { client } = mesub({ access: perPlan({ pro: no, team: yes }) });

            const response = await request(await app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ plan: 'team', answer: { plan: 'team' } });
        });

        it('answers 402 when none grants', async () => {
            const { client } = mesub({ access: perPlan({ pro: no, team: no }) });

            await request(await app(client, {}, ['pro', 'team']))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(402);
        });

        it('asks about the plan a function picks for the request', async () => {
            const { client } = mesub({ access: perPlan({ team: yes }) });
            const tier = (request: MesubRequest) =>
                (request.headers as Record<string, string>)['x-tier'] ?? 'pro';

            const response = await request(await app(client, {}, tier))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .set('x-tier', 'team');

            expect(response.status).toBe(200);
            expect(response.body.plan).toBe('team');
        });

        it('refuses an empty list when built, and answers 500 on one a function gives', async () => {
            const { client } = mesub();

            expect(() => RequirePlan([], { client })).toThrow(TypeError);
            await request(await app(client, {}, () => []))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(500);
        });

        it('refuses more than three plans, and never runs the function without a token', async () => {
            const { client } = mesub();
            const plan = vi.fn(() => ['pro', 'team', 'max', 'org']);

            expect(() => RequirePlan(['pro', 'team', 'max', 'org'], { client })).toThrow(TypeError);
            await request(await app(client, {}, plan))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(500);

            plan.mockClear();
            await request(await app(client, {}, plan))
                .get('/pro')
                .expect(401);
            expect(plan).not.toHaveBeenCalled();
        });
    });

    describe('onDenied', () => {
        it('lets the merchant throw their own exception', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'none' })),
            });
            const onDenied = vi.fn((denial) => {
                throw new HttpException({ upgrade: `/subscribe?why=${denial.reason}` }, 403);
            });

            const response = await request(await app(client, { onDenied }))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(403);
            expect(response.body).toEqual({ upgrade: '/subscribe?why=no_access' });
            expect(onDenied.mock.calls[0]![0]).toMatchObject({
                reason: 'no_access',
                status: 402,
                answer: { status: 'none' },
            });
        });

        it('hands it the 401 and the request', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(() => {
                throw new HttpException('teapot', 418);
            });

            await request(await app(client, { onDenied }))
                .get('/pro')
                .set('x-trace', 'abc')
                .expect(418);
            expect(onDenied.mock.calls[0]).toMatchObject([
                { reason: 'unauthenticated', status: 401, answer: null },
                { headers: { 'x-trace': 'abc' } },
            ]);
        });

        it('falls back to the default refusal when it returns', async () => {
            const { client } = mesub();
            const onDenied = vi.fn();

            const response = await request(await app(client, { onDenied })).get('/pro');

            expect(onDenied).toHaveBeenCalledOnce();
            expect(response.status).toBe(401);
            expect(response.body).toEqual({ access: false, reason: 'unauthenticated' });
        });

        // #45: an async onDenied is awaited, its exception answered, not dropped.
        it('answers the exception an async one throws', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                throw new HttpException({ upgrade: '/subscribe' }, 403);
            });

            const response = await request(await app(client, { onDenied })).get('/pro');

            expect(response.status).toBe(403);
            expect(response.body).toEqual({ upgrade: '/subscribe' });
        });

        it('throws the default refusal only once an async one has returned', async () => {
            const { client } = mesub();
            let finished = false;
            const guard = new (RequirePlan('pro', {
                client,
                onDenied: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    finished = true;
                },
            }))();
            const context = {
                switchToHttp: () => ({
                    getRequest: () => ({ headers: {} }),
                    getResponse: () => ({}),
                }),
            } as unknown as ExecutionContext;

            const thrown = await (guard.canActivate(context) as Promise<boolean>).catch(
                (error: unknown) => error,
            );

            expect(finished).toBe(true);
            expect((thrown as HttpException).getStatus()).toBe(401);
        });

        it('is never called for a subscriber with access', async () => {
            const { client } = mesub();
            const onDenied = vi.fn();

            await request(await app(client, { onDenied }))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`)
                .expect(200);
            expect(onDenied).not.toHaveBeenCalled();
        });
    });

    // A broken integration must reach Nest as an error, not look like a denial.
    describe('integration errors', () => {
        it.each([
            ['a bad secret key', 401],
            ['an unknown plan', 404],
        ])('answers 500 on %s', async (_label, status) => {
            const { client } = mesub({
                access: () => Response.json({ message: 'nope', statusCode: status }, { status }),
            });

            const response = await request(await app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(500);
            expect(response.body).not.toHaveProperty('access');
        });

        it('rethrows the MesubError untouched', async () => {
            const { client } = mesub({
                access: () =>
                    Response.json(
                        { message: 'nope', statusCode: 404, code: 'plan_not_found' },
                        { status: 404 },
                    ),
            });
            const guard = new (RequirePlan('pro', { client }))();
            const headers = { authorization: `Bearer ${await token()}` };
            const context = {
                switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
            } as unknown as ExecutionContext;

            const thrown = await (guard.canActivate(context) as Promise<boolean>).catch(
                (error: unknown) => error,
            );

            expect(thrown).toBeInstanceOf(MesubError);
            expect(thrown).toMatchObject({ code: 'plan_not_found' });
        });
    });

    describe('on a whole controller', () => {
        it('guards every route of it', async () => {
            const { client } = mesub();
            const server = await app(client);

            await request(server).get('/reports').expect(401);
            const response = await request(server)
                .get('/reports')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ wallet: WALLET });
        });
    });
});
