import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

import type { AccessAnswer } from '../src/answer.js';
import { Mesub, type MesubOptions } from '../src/index.js';
import { MesubError, withMesub, type MesubAccess, type WithMesubOptions } from '../src/next.js';

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

interface Ctx {
    params: Promise<{ id: string }>;
}

/** A guarded route handler that echoes what it was handed. */
function route(client: Mesub, options: Omit<WithMesubOptions, 'client' | 'plan'> = {}) {
    return withMesub<Ctx>(
        async (_request, mesub: MesubAccess, context) =>
            Response.json({ mesub, params: await context.params }),
        { plan: 'pro', client, ...options },
    );
}

function get(headers: Record<string, string> = {}, path = '/api/pro/42') {
    return new Request(`https://shop.test${path}`, { headers });
}

const context: Ctx = { params: Promise.resolve({ id: '42' }) };

async function bearer(over: Parameters<typeof token>[0] = {}) {
    return { Authorization: `Bearer ${await token(over)}` };
}

describe('withMesub', () => {
    describe('letting through', () => {
        it('hands the handler who is asking, the answer and the untouched context', async () => {
            const { client } = mesub();

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                mesub: { userId: 'user_1', wallet: WALLET, answer: answer(), stale: false },
                params: { id: '42' },
            });
        });

        it('passes the same request and context objects through', async () => {
            const { client } = mesub();
            const handler = vi.fn(
                (_request: Request, _mesub: MesubAccess, _context: Ctx) => new Response('ok'),
            );
            const request = get(await bearer());

            await withMesub(handler, { plan: 'pro', client })(request, context);

            expect(handler.mock.calls[0]![0]).toBe(request);
            expect(handler.mock.calls[0]![2]).toBe(context);
        });

        it('reads the token from the mesub-token cookie', async () => {
            const { client } = mesub();

            const response = await route(client)(
                get({ Cookie: `theme=dark; mesub-token=${await token()}` }),
                context,
            );

            expect(response.status).toBe(200);
        });

        // The wallet asked about is the token's, never one the request names.
        it('asks Mesub about the wallet in the token', async () => {
            const { client } = mesub();
            const spy = vi
                .spyOn(client, 'decide')
                .mockResolvedValue({ access: true, answer: answer(), stale: false });

            await route(client)(
                get({ ...(await bearer()), 'x-wallet': ATTACKER }, `/api/pro?wallet=${ATTACKER}`),
                context,
            );

            expect(spy).toHaveBeenCalledWith(WALLET, 'pro');
        });

        it('returns the handler own Response as is', async () => {
            const { client } = mesub();
            const own = new Response('made here', { status: 201, headers: { 'x-own': '1' } });

            const response = await withMesub(() => own, { plan: 'pro', client })(
                get(await bearer()),
                context,
            );

            expect(response).toBe(own);
        });

        it.each([
            ['a sync handler', () => new Response('sync')],
            ['an async handler', async () => new Response('async')],
        ])('works with %s', async (_label, handler) => {
            const { client } = mesub();

            const response = await withMesub(handler, { plan: 'pro', client })(
                get(await bearer()),
                context,
            );

            expect(response.status).toBe(200);
        });
    });

    describe('401, not signed in', () => {
        it.each([
            ['no token at all', {} as Record<string, string>],
            ['another scheme', { Authorization: 'Basic abc' }],
            ['something that is not a token', { Authorization: 'Bearer not-a-token' }],
        ])('answers 401 on %s', async (_label, headers) => {
            const { client } = mesub();

            const response = await route(client)(get(headers), context);

            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ access: false, reason: 'unauthenticated' });
        });

        it('answers 401 on a token for another project', async () => {
            const { client } = mesub();

            const response = await route(client)(get(await bearer({ aud: 'proj_2' })), context);

            expect(response.status).toBe(401);
        });

        it('answers 401 on an expired token', async () => {
            const { client } = mesub();

            const response = await route(client)(get(await bearer({ exp: '-10s' })), context);

            expect(response.status).toBe(401);
        });

        it('never asks /v1/access nor calls the handler without a valid token', async () => {
            const { client, calls } = mesub();
            const handler = vi.fn(() => new Response('ok'));

            await withMesub(handler, { plan: 'pro', client })(get(), context);

            expect(calls).not.toContain('/v1/access');
            expect(handler).not.toHaveBeenCalled();
        });
    });

    // A merchant's own `Authorization: Bearer` must not hide the cookie (#36).
    describe('a bearer that is not a Mesub token', () => {
        it('falls back on the mesub-token cookie', async () => {
            const { client } = mesub();

            const response = await route(client)(
                get({
                    Authorization: `Bearer ${await theirs()}`,
                    Cookie: `mesub-token=${await token()}`,
                }),
                context,
            );

            expect(response.status).toBe(200);
        });

        it('answers 401 when there is no cookie behind it', async () => {
            const { client } = mesub();

            const response = await route(client)(
                get({ Authorization: `Bearer ${await theirs()}` }),
                context,
            );

            expect(response.status).toBe(401);
        });

        it('never tries the cookie once the keys could not be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });
            const verify = vi.spyOn(client, 'verifyToken');

            const response = await route(client)(
                get({ ...(await bearer()), Cookie: `mesub-token=${await token({ exp: '2h' })}` }),
                context,
            );

            expect(response.status).toBe(503);
            expect(verify).toHaveBeenCalledOnce();
        });

        it('reads the token where the token option says, and only there', async () => {
            const { client } = mesub();
            const custom = route(client, {
                token: (request) => request.headers.get('x-mesub-token'),
            });

            const found = await custom(
                get({ Authorization: `Bearer ${await theirs()}`, 'x-mesub-token': await token() }),
                context,
            );
            const ignored = await custom(get(await bearer()), context);

            expect(found.status).toBe(200);
            expect(ignored.status).toBe(401);
        });
    });

    describe('402, no access', () => {
        it('answers 402 with the status for a subscriber without access', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'stopped' })),
            });

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(402);
            expect(response.headers.get('retry-after')).toBeNull();
            expect(await response.json()).toEqual({
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
            const handler = route(client);
            const headers = await bearer();
            expect((await handler(get(headers), context)).status).toBe(200);

            down = true;
            const response = await handler(get(headers), context);

            expect(response.status).toBe(200);
            expect(((await response.json()) as { mesub: MesubAccess }).mesub.stale).toBe(true);
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

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
            expect(await response.json()).toEqual({ access: false, reason: 'unavailable' });
        });

        it('answers 503 with Retry-After when the keys cannot be fetched', async () => {
            const { client } = mesub({ keys: () => new Response('boom', { status: 500 }) });

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
            expect(await response.json()).toEqual({ access: false, reason: 'unavailable' });
        });

        // A guard holds a request for guardTimeout at most, never for an outage (#24).
        it('answers 503 with Retry-After when Mesub does not answer within guardTimeout', async () => {
            const { client } = mesub({ access: hang }, { guardTimeout: 50 });

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
            expect(await response.json()).toEqual({ access: false, reason: 'unavailable' });
        });

        it('answers 503 when the project id cannot be fetched', async () => {
            const { client } = mesub({
                project: () => Response.json({ message: 'down' }, { status: 503 }),
            });

            const response = await route(client)(get(await bearer()), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
        });
    });

    describe('onDenied', () => {
        it('lets the merchant answer a 402', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'none' })),
            });
            const onDenied = vi.fn((denial: { reason: string }) =>
                Response.redirect(`https://shop.test/subscribe?why=${denial.reason}`, 302),
            );
            const request = get(await bearer());

            const response = await route(client, { onDenied })(request, context);

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe(
                'https://shop.test/subscribe?why=no_access',
            );
            expect(onDenied.mock.calls[0]![0]).toMatchObject({
                reason: 'no_access',
                status: 402,
                answer: { status: 'none' },
            });
            expect((onDenied.mock.calls[0] as unknown[])[1]).toBe(request);
        });

        it('hands it the 401 too, and waits for an async answer', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(async () => new Response(null, { status: 418 }));

            const response = await route(client, { onDenied })(get(), context);

            expect(response.status).toBe(418);
            expect((onDenied.mock.calls[0] as unknown[])[0]).toEqual({
                reason: 'unauthenticated',
                status: 401,
                answer: null,
            });
        });

        it('is never called for a subscriber with access', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(() => new Response(null, { status: 418 }));

            const response = await route(client, { onDenied })(get(await bearer()), context);

            expect(response.status).toBe(200);
            expect(onDenied).not.toHaveBeenCalled();
        });
    });

    // A broken integration must reach Next as a thrown error, not look like a denial.
    describe('integration errors', () => {
        it.each([
            ['a bad secret key', 401, 'unauthorized'],
            ['an unknown plan', 404, 'plan_not_found'],
        ])('throws %s', async (_label, status, code) => {
            const { client } = mesub({
                access: () =>
                    Response.json({ message: 'nope', statusCode: status, code }, { status }),
            });
            const handler = vi.fn(() => new Response('ok'));

            const failing = withMesub(handler, { plan: 'pro', client })(
                get(await bearer()),
                context,
            );

            await expect(failing).rejects.toBeInstanceOf(MesubError);
            await expect(failing).rejects.toMatchObject({ code });
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
