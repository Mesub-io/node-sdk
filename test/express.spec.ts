import express, {
    type NextFunction,
    type Request as ExpressRequest,
    type Response as ExpressResponse,
} from 'express';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import request from 'supertest';

import type { AccessAnswer } from '../src/answer.js';
import { MesubError, requirePlan, type MesubLocals } from '../src/express.js';
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
        payment_status: 'paid',
        subscribed_since: null,
        first_subscribed_at: null,
        current_period_end: null,
        cancelled_at: null,
        access_until: null,
        next_charge_at: null,
        next_retry_at: null,
        revalidate_after: 60,
        ...over,
    };
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
    access?: (init?: RequestInit) => Response | Promise<Response>;
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
            return (mesh.access ?? (() => Response.json(answer())))(init);
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

/** Mesub not answering at all, until the call gives up. */
function hang(init?: RequestInit) {
    return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
}

/** An app with one guarded route that echoes res.locals.mesub. */
function app(client: Mesub, options: Omit<Parameters<typeof requirePlan>[1], 'client'> = {}) {
    const server = express();
    server.get('/pro', requirePlan('pro', { ...options, client }), (_req, res) => {
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
            let asked: string | null = null;
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
                .set('Authorization', `Bearer ${await token({ exp: '-1s' })}`)
                .expect(401);
        });

        it('answers 401 on something that is not a token', async () => {
            const { client } = mesub();

            await request(app(client))
                .get('/pro')
                .set('Authorization', 'Bearer not-a-token')
                .expect(401);
        });

        it('never asks /v1/access without a valid token', async () => {
            const { client, calls } = mesub();

            await request(app(client)).get('/pro');

            expect(calls).not.toContain('/v1/access');
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
                access: () => Response.json({ message: 'nope', statusCode: status }, { status }),
            });

            const response = await request(app(client))
                .get('/pro')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ forwarded: code });
        });
    });
});
