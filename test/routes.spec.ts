import express from 'express';
import request from 'supertest';

import { mesubRoutes } from '../src/express.js';
import type { Mesub } from '../src/index.js';
import { mesubRouteHandlers } from '../src/next.js';
import {
    checkWidgetOptions,
    handleWidget,
    widgetCustomer,
    type WidgetRequest,
} from '../src/routes.js';
import { FakeMesub } from '../src/testing.js';

const WALLET = 'SysvarRent111111111111111111111111111111111';
const OTHER_WALLET = 'SysvarC1ock11111111111111111111111111111111';
const JSON_TYPE = 'application/json';
const SIGNATURE =
    '5wHu1qwD4kLDLoREEPBpKvGvhbxWFxFFfr5nQq7dxAsRRDXvHRqpNvfsCvC1qzjWQhqmPtBb8LnZjKmvpehJqSWk';

const ada = { kind: 'external_id', value: 'user_ada' } as const;
const bob = { kind: 'external_id', value: 'user_bob' } as const;

function setup() {
    const fake = new FakeMesub({ plans: ['pro', 'team'] });
    const client = fake.client();
    const call = (
        asked: Parameters<typeof handleWidget>[2],
        req: Partial<WidgetRequest> & { path: string },
        options?: Parameters<typeof handleWidget>[3],
    ) =>
        handleWidget(
            client,
            { method: 'GET', body: undefined, contentType: null, ...req },
            asked,
            options,
        );
    const post = (
        asked: Parameters<typeof handleWidget>[2],
        path: string,
        body?: unknown,
        options?: Parameters<typeof handleWidget>[3],
    ) => call(asked, { method: 'POST', path, body, contentType: JSON_TYPE }, options);

    return { fake, client, call, post };
}

/** A subscription of Ada's, running, as the fake's own subscribe flow leaves it. */
async function subscribed(client: Mesub, externalId = 'user_ada', wallet = WALLET) {
    const created = await client.subscriptions.create({
        plan: 'pro',
        wallet,
        external_id: externalId,
        email: 'ada@example.com',
    });
    await client.subscriptions.submit(created.subscription.id, {
        transaction: created.transaction,
        terms_signature: SIGNATURE,
    });

    return created.subscription.id;
}

const STEPS = [
    'submit',
    'cancel',
    'cancel/confirm',
    'resume',
    'resume/confirm',
    'close',
    'close/confirm',
] as const;

describe('the widget routes: a plan', () => {
    it('is read by anybody, signed in or not', async () => {
        const { call } = setup();

        const answer = await call(null, { path: '/plans/pro' });

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ slug: 'pro', amount_display: '9.99' });
    });

    it.each(['/plans/nope', '/plans/..', '/plans/Pro', '/plans/a%2Fb'])(
        'answers 404 for %s',
        async (path) => {
            const { call, fake } = setup();

            const answer = await call(null, { path });

            expect(answer.status).toBe(404);
            if (path !== '/plans/nope') expect(fake.requests).toEqual([]);
        },
    );

    it('answers 404 for a plan left off the list, without asking Mesub', async () => {
        const { call, fake } = setup();

        const answer = await call(null, { path: '/plans/team' }, { plans: ['pro'] });

        expect(answer.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });
});

describe('the widget routes: who is asking', () => {
    it.each([
        ['GET', '/subscriptions'],
        ['POST', '/subscriptions'],
        ...STEPS.map((step) => ['POST', `/subscriptions/sub_1/${step}`]),
    ])(
        'answers 401 to %s %s with nobody signed in, and asks Mesub nothing',
        async (method, path) => {
            const { call, fake } = setup();

            const answer = await call(null, { method, path, contentType: JSON_TYPE, body: {} });

            expect(answer.status).toBe(401);
            expect(fake.requests).toEqual([]);
        },
    );

    it.each(STEPS)("answers 404 to %s on another customer's subscription", async (step) => {
        const { client, post, fake } = setup();
        const id = await subscribed(client);
        const before = fake.requests.length;

        const answer = await post(bob, `/subscriptions/${id}/${step}`, {
            signature: SIGNATURE,
            transaction: 'AAAA',
            terms_signature: SIGNATURE,
        });

        expect(answer).toMatchObject({
            status: 404,
            body: { error: { code: 'subscription_not_found' } },
        });
        // One read to learn whose it is, and nothing built or confirmed.
        expect(fake.requests.slice(before).map((each) => `${each.method} ${each.path}`)).toEqual([
            `GET /v1/subscriptions/${id}`,
        ]);
    });

    it.each(STEPS)('answers the same 404 to %s on an id that does not exist', async (step) => {
        const { post } = setup();

        const answer = await post(ada, `/subscriptions/sub_nope/${step}`, { signature: SIGNATURE });

        expect(answer).toMatchObject({
            status: 404,
            body: { error: { code: 'subscription_not_found' } },
        });
    });

    it.each(['..', '.', 'a/b', 'a b', 'x'.repeat(65)])(
        'refuses the id %j before asking Mesub',
        async (id) => {
            const { post, fake } = setup();

            const answer = await post(ada, `/subscriptions/${encodeURIComponent(id)}/cancel`);

            expect(answer.status).toBe(404);
            expect(fake.requests).toEqual([]);
        },
    );

    it('tells customers apart by wallet and by email too', async () => {
        const { client, post } = setup();
        const id = await subscribed(client);

        await expect(
            post({ kind: 'wallet', value: OTHER_WALLET }, `/subscriptions/${id}/cancel`),
        ).resolves.toMatchObject({ status: 404 });
        await expect(
            post({ kind: 'email', value: 'eve@example.com' }, `/subscriptions/${id}/cancel`),
        ).resolves.toMatchObject({ status: 404 });
        await expect(
            post({ kind: 'wallet', value: WALLET }, `/subscriptions/${id}/cancel`),
        ).resolves.toMatchObject({ status: 201 });
    });
});

describe('the widget routes: subscribing', () => {
    it('creates for the customer your auth names, never one the browser names', async () => {
        const { post, fake } = setup();

        const answer = await post(ada, '/subscriptions', {
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_bob',
            email: 'bob@example.com',
        });

        expect(answer.status).toBe(201);
        expect(answer.body).toMatchObject({
            subscription: { status: 'pending' },
            transaction: expect.any(String),
            terms: { message: expect.any(String) },
        });
        expect(fake.requests.at(-1)?.body).toEqual({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_ada',
        });
    });

    it('carries the notices address your server gives', async () => {
        const { post, fake } = setup();

        await post(ada, '/subscriptions', { plan: 'pro', wallet: WALLET }, { email: 'ada@x.co' });

        expect(fake.requests.at(-1)?.body).toMatchObject({ email: 'ada@x.co' });
    });

    it('subscribes a customer named by wallet only for that wallet', async () => {
        const { post, fake } = setup();
        const walletCustomer = { kind: 'wallet', value: WALLET } as const;

        const mismatch = await post(walletCustomer, '/subscriptions', {
            plan: 'pro',
            wallet: OTHER_WALLET,
        });

        expect(mismatch.status).toBe(403);
        expect(fake.requests).toEqual([]);
        await expect(
            post(walletCustomer, '/subscriptions', { plan: 'pro', wallet: WALLET }),
        ).resolves.toMatchObject({ status: 201 });
    });

    it.each([
        ['no plan', { wallet: WALLET }],
        ['no wallet', { plan: 'pro' }],
        ['a plan that is not a slug', { plan: '../x', wallet: WALLET }],
        ['a wallet that is not a string', { plan: 'pro', wallet: 42 }],
        ['a list', ['pro']],
        ['nothing', undefined],
    ])('answers 400 for %s', async (_name, body) => {
        const { post, fake } = setup();

        const answer = await post(ada, '/subscriptions', body);

        expect(answer.status).toBe(400);
        expect(fake.requests).toEqual([]);
    });

    it('answers 404 for a plan left off the list', async () => {
        const { post, fake } = setup();

        const answer = await post(
            ada,
            '/subscriptions',
            { plan: 'team', wallet: WALLET },
            { plans: ['pro'] },
        );

        expect(answer.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it.each([null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
        'refuses a POST sent as %s: only JSON, which a plain form cannot send',
        async (contentType) => {
            const { call, fake } = setup();

            const answer = await call(ada, {
                method: 'POST',
                path: '/subscriptions',
                body: { plan: 'pro', wallet: WALLET },
                contentType,
            });

            expect(answer.status).toBe(415);
            expect(fake.requests).toEqual([]);
        },
    );

    it('submits what the wallet signed, and answers without the email and the id', async () => {
        const { client, post } = setup();
        const created = await client.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_ada',
            email: 'ada@example.com',
        });

        const answer = await post(ada, `/subscriptions/${created.subscription.id}/submit`, {
            transaction: created.transaction,
            terms_signature: SIGNATURE,
        });

        expect(answer.status).toBe(201);
        expect(answer.body).toMatchObject({ subscription: { status: 'active', wallet: WALLET } });
        const text = JSON.stringify(answer.body);
        expect(text).not.toContain('user_ada');
        expect(text).not.toContain('ada@example.com');
    });

    it('answers 400 to a submit with a signature missing', async () => {
        const { client, post } = setup();
        const created = await client.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_ada',
        });

        const answer = await post(ada, `/subscriptions/${created.subscription.id}/submit`, {
            transaction: created.transaction,
        });

        expect(answer.status).toBe(400);
    });
});

describe('the widget routes: managing', () => {
    it("lists the customer's subscriptions, without the email and the id", async () => {
        const { client, call } = setup();
        const id = await subscribed(client);
        await subscribed(client, 'user_bob', OTHER_WALLET);

        const answer = await call(ada, { path: '/subscriptions' });

        expect(answer.status).toBe(200);
        const { subscriptions } = answer.body as { subscriptions: Array<{ id: string }> };
        expect(subscriptions.map((each) => each.id)).toEqual([id]);
        const text = JSON.stringify(answer.body);
        expect(text).not.toContain('user_ada');
        expect(text).not.toContain('ada@example.com');
    });

    it('answers an empty list to a customer with none', async () => {
        const { call } = setup();

        await expect(call(bob, { path: '/subscriptions' })).resolves.toMatchObject({
            status: 200,
            body: { subscriptions: [] },
        });
    });

    it('cancels in two steps: a transaction for the wallet, then the confirm', async () => {
        const { client, post } = setup();
        const id = await subscribed(client);

        const built = await post(ada, `/subscriptions/${id}/cancel`);
        expect(built).toMatchObject({
            status: 201,
            body: { transaction: expect.any(String), last_valid_block_height: expect.any(String) },
        });

        const confirmed = await post(ada, `/subscriptions/${id}/cancel/confirm`, {
            signature: SIGNATURE,
        });
        expect(confirmed).toMatchObject({
            status: 201,
            body: { subscription: { id, status: 'cancelled' } },
        });
        expect(JSON.stringify(confirmed.body)).not.toContain('user_ada');
    });

    it('answers 400 to a confirm with no signature', async () => {
        const { client, post } = setup();
        const id = await subscribed(client);
        await post(ada, `/subscriptions/${id}/cancel`);

        const answer = await post(ada, `/subscriptions/${id}/cancel/confirm`, {});

        expect(answer.status).toBe(400);
    });

    it("hands on Mesub's refusal with its own status and code", async () => {
        const { client, post } = setup();
        const id = await subscribed(client);

        // Running, so not resumable.
        const answer = await post(ada, `/subscriptions/${id}/resume`);

        expect(answer.status).toBe(409);
        expect(answer.body).toMatchObject({ error: { code: 'subscription_not_cancelled' } });
    });

    it('hands on a Retry-After, and never the API key', async () => {
        const { post, fake } = setup();
        fake.fail({ status: 429, code: 'rate_limited', retryAfter: 30 });

        const answer = await post(ada, '/subscriptions', { plan: 'pro', wallet: WALLET });

        expect(answer.status).toBe(429);
        expect(answer.headers).toEqual({ 'Retry-After': '30' });
        expect(JSON.stringify(answer)).not.toContain(fake.apiKey);
    });

    it('answers 502 when Mesub cannot be reached', async () => {
        const { post, fake } = setup();
        fake.fail('outage');

        const answer = await post(ada, '/subscriptions', { plan: 'pro', wallet: WALLET });

        expect([502, 503]).toContain(answer.status);
    });

    it.each([
        ['GET', '/nope'],
        ['GET', '/subscriptions/sub_1'],
        ['POST', '/subscriptions/sub_1/refund'],
        ['POST', '/subscriptions/sub_1/cancel/confirm/again'],
        ['GET', '/'],
    ])('answers 404 to %s %s', async (method, path) => {
        const { call } = setup();

        const answer = await call(ada, { method, path, contentType: JSON_TYPE, body: {} });

        expect(answer.status).toBe(404);
    });

    it.each(['DELETE', 'PUT', 'PATCH'])('answers 405 to %s', async (method) => {
        const { call } = setup();

        await expect(call(ada, { method, path: '/subscriptions' })).resolves.toMatchObject({
            status: 405,
        });
    });
});

describe('the widget routes: your auth', () => {
    it('reads who is asking, normalised, sync or async', async () => {
        await expect(widgetCustomer({}, () => ({ external_id: ' u1 ' }))).resolves.toEqual({
            kind: 'external_id',
            value: 'u1',
        });
        await expect(widgetCustomer({}, async () => WALLET)).resolves.toEqual({
            kind: 'wallet',
            value: WALLET,
        });
        await expect(widgetCustomer({}, () => null)).resolves.toBeNull();
        await expect(widgetCustomer({}, () => undefined)).resolves.toBeNull();
    });

    it.each([{}, { external_id: 'a', email: 'b@c.co' }, '', { external_id: '  ' }, 42])(
        'throws for %j: a broken integration, never a customer',
        async (named) => {
            await expect(widgetCustomer({}, () => named as never)).rejects.toThrow(TypeError);
        },
    );

    it('refuses to be built without customer, or with plans that are not slugs', () => {
        expect(() => checkWidgetOptions({} as never)).toThrow(TypeError);
        expect(() => checkWidgetOptions({ customer: 'me' } as never)).toThrow(TypeError);
        expect(() => checkWidgetOptions({ customer: () => null, plans: ['Pro!'] })).toThrow(
            TypeError,
        );
        expect(() => checkWidgetOptions({ customer: () => null, plans: ['pro'] })).not.toThrow();
    });
});

describe('mesubRoutes for Express', () => {
    function app(customer: () => unknown, parse = false) {
        const fake = new FakeMesub({ plans: ['pro'] });
        const server = express();
        if (parse) server.use(express.json());
        server.use(
            '/api/mesub',
            mesubRoutes({ client: fake.client(), customer: customer as never }),
        );
        server.use(
            (
                error: unknown,
                _req: express.Request,
                res: express.Response,
                _next: express.NextFunction,
            ) => {
                res.status(500).json({ thrown: error instanceof TypeError ? 'type' : 'other' });
            },
        );

        return { fake, server };
    }

    it.each([false, true])(
        'subscribes under its mount point, express.json() mounted: %s',
        async (parse) => {
            const { server, fake } = app(() => ({ external_id: 'user_ada' }), parse);

            const response = await request(server)
                .post('/api/mesub/subscriptions')
                .send({ plan: 'pro', wallet: WALLET });

            expect(response.status).toBe(201);
            expect(response.headers['cache-control']).toBe('no-store');
            expect(fake.requests.at(-1)?.body).toMatchObject({ external_id: 'user_ada' });
        },
    );

    it('serves a plan with nobody signed in, without asking who is', async () => {
        const customer = vi.fn(() => null);
        const { server } = app(customer);

        await request(server).get('/api/mesub/plans/pro').expect(200);

        expect(customer).not.toHaveBeenCalled();
    });

    it('answers 401 with nobody signed in', async () => {
        const { server } = app(() => null);

        await request(server).get('/api/mesub/subscriptions').expect(401);
    });

    it('answers 400 to a body that is not JSON, and 415 to a form', async () => {
        const { server } = app(() => ({ external_id: 'user_ada' }));

        await request(server)
            .post('/api/mesub/subscriptions')
            .set('Content-Type', JSON_TYPE)
            .send('{nope')
            .expect(400);
        await request(server)
            .post('/api/mesub/subscriptions')
            .type('form')
            .send({ plan: 'pro', wallet: WALLET })
            .expect((response) => expect([400, 415]).toContain(response.status));
    });

    it('answers 413 to a body too large', async () => {
        const { server } = app(() => ({ external_id: 'user_ada' }));

        await request(server)
            .post('/api/mesub/subscriptions')
            .set('Content-Type', JSON_TYPE)
            .send(JSON.stringify({ plan: 'pro', wallet: 'x'.repeat(70_000) }))
            .expect(413);
    });

    it('forwards a broken customer to next(err)', async () => {
        const { server } = app(() => ({ external_id: 'a', email: 'b@c.co' }));

        const response = await request(server).get('/api/mesub/subscriptions');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ thrown: 'type' });
    });

    it('refuses to be built without customer', () => {
        expect(() => mesubRoutes({} as never)).toThrow(TypeError);
    });
});

describe('mesubRouteHandlers for Next', () => {
    function handlers(customer: (request: Request) => unknown) {
        const fake = new FakeMesub({ plans: ['pro'] });

        return {
            fake,
            ...mesubRouteHandlers({ client: fake.client(), customer: customer as never }),
        };
    }

    const context = (...mesub: string[]) => ({ params: Promise.resolve({ mesub }) });
    const json = (body: unknown) =>
        new Request('https://shop.test/api/mesub/x', {
            method: 'POST',
            headers: { 'content-type': JSON_TYPE },
            body: JSON.stringify(body),
        });

    it('subscribes through the catch-all segment', async () => {
        const { POST, fake } = handlers(() => ({ external_id: 'user_ada' }));

        const response = await POST(
            json({ plan: 'pro', wallet: WALLET }),
            context('subscriptions'),
        );

        expect(response.status).toBe(201);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(fake.requests.at(-1)?.body).toMatchObject({ external_id: 'user_ada' });
    });

    it('reads params given as a plain object too, as before Next 15', async () => {
        const { GET } = handlers(() => null);

        const response = await GET(new Request('https://shop.test/api/mesub/plans/pro'), {
            params: { mesub: ['plans', 'pro'] },
        });

        expect(response.status).toBe(200);
    });

    it('answers 401 with nobody signed in, 400 to a body that is not JSON', async () => {
        const { GET, POST } = handlers(() => null);

        expect(
            (await GET(new Request('https://shop.test/x'), context('subscriptions'))).status,
        ).toBe(401);
        const broken = new Request('https://shop.test/x', {
            method: 'POST',
            headers: { 'content-type': JSON_TYPE },
            body: '{nope',
        });
        expect((await POST(broken, context('subscriptions'))).status).toBe(400);
    });

    it('cannot be walked out of its mount by a segment', async () => {
        const { GET, fake } = handlers(() => ({ external_id: 'user_ada' }));

        const response = await GET(
            new Request('https://shop.test/x'),
            context('plans', '../access'),
        );

        expect(response.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it('throws a broken customer, for Next to log', async () => {
        const { GET } = handlers(() => '');

        await expect(
            GET(new Request('https://shop.test/x'), context('subscriptions')),
        ).rejects.toThrow(TypeError);
    });
});
