import express from 'express';
import request from 'supertest';

import { mesubRoutes } from '../src/express.js';
import { Mesub } from '../src/index.js';
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

function setup(options: { attemptsRoute?: boolean } = {}) {
    const fake = new FakeMesub({ plans: ['pro', 'team'], ...options });
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
        ['GET', '/subscriptions/sub_1'],
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

        await expect(call(bob, { path: '/subscriptions' })).resolves.toEqual({
            status: 200,
            body: { subscriptions: [], has_more: false },
        });
    });

    /** A Mesub holding `total` subscriptions of Ada's, served by pages as asked. */
    async function holding(total: number) {
        const { client } = setup();
        const one = await client.subscriptions.retrieve(await subscribed(client));
        const queries: Array<Record<string, string>> = [];
        const paged = new Mesub({
            apiKey: 'SUB_test',
            fetch: async (input) => {
                const query = Object.fromEntries(new URL(String(input)).searchParams);
                queries.push(query);
                const from = query['starting_after'] ? Number(query['starting_after']) + 1 : 0;
                const limit = Number(query['limit'] ?? 20);
                const data = Array.from({ length: Math.min(limit, total - from) }, (_, index) => ({
                    ...one,
                    id: String(from + index),
                }));

                return Response.json({ data, has_more: from + data.length < total });
            },
        });
        const list = () =>
            handleWidget(
                paged,
                { method: 'GET', path: '/subscriptions', body: undefined, contentType: null },
                ada,
            );

        return { list, queries };
    }

    it('reads the list by pages of 100, and says there is no more', async () => {
        const { list, queries } = await holding(230);

        const answer = await list();

        const body = answer.body as { subscriptions: Array<{ id: string }>; has_more: boolean };
        expect(body.subscriptions).toHaveLength(230);
        expect(body.has_more).toBe(false);
        expect(queries.map((query) => [query['limit'], query['starting_after']])).toEqual([
            ['100', undefined],
            ['100', '99'],
            ['100', '199'],
        ]);
    });

    it('stops at 5 pages, and says the list was cut', async () => {
        const { list, queries } = await holding(10_000);

        const answer = await list();

        const body = answer.body as { subscriptions: Array<{ id: string }>; has_more: boolean };
        expect(queries).toHaveLength(5);
        expect(body.subscriptions).toHaveLength(500);
        expect(body.subscriptions.at(-1)!.id).toBe('499');
        expect(body.has_more).toBe(true);
    });

    it('says there is no more for exactly 5 full pages', async () => {
        const { list, queries } = await holding(500);

        const answer = await list();

        expect(queries).toHaveLength(5);
        expect(answer.body).toMatchObject({ has_more: false });
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

    it('never tells the browser your baseUrl when what answers there is not Mesub', async () => {
        const mesub = new Mesub({
            apiKey: 'SUB_test',
            baseUrl: 'https://proxy.internal.example/mesub',
            fetch: async () => new Response('<h1>Not Found</h1>', { status: 404 }),
        });
        const read = { method: 'GET', path: '/plans/pro', body: undefined, contentType: null };

        const answer = await handleWidget(mesub, read, null);

        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({
            error: { code: 'unexpected', message: 'Mesub could not answer this request.' },
        });
        // Your server still reads it in full.
        await expect(mesub.plans.retrieve('pro')).rejects.toThrow(
            'is baseUrl (https://proxy.internal.example/mesub) the Mesub API?',
        );
    });

    it('never tells the browser why Mesub could not be reached', async () => {
        const mesub = new Mesub({
            apiKey: 'SUB_test',
            maxRetries: 0,
            fetch: async () => {
                throw new Error('connect ECONNREFUSED 10.0.0.7:8443');
            },
        });
        const read = { method: 'GET', path: '/plans/pro', body: undefined, contentType: null };

        const answer = await handleWidget(mesub, read, null);

        expect(answer.body).toEqual({
            error: { code: 'unavailable', message: 'Mesub could not answer this request.' },
        });
        await expect(mesub.plans.retrieve('pro')).rejects.toThrow('ECONNREFUSED 10.0.0.7:8443');
    });

    it("still hands on Mesub's own message, the one that comes with its code", async () => {
        const mesub = new Mesub({
            apiKey: 'SUB_test',
            fetch: async () =>
                Response.json(
                    {
                        statusCode: 409,
                        error: 'Conflict',
                        message: 'This plan takes no new subscriber.',
                        code: 'plan_unavailable',
                        retryable: false,
                    },
                    { status: 409 },
                ),
        });
        const read = { method: 'GET', path: '/plans/pro', body: undefined, contentType: null };

        const answer = await handleWidget(mesub, read, null);

        expect(answer.body).toEqual({
            error: { code: 'plan_unavailable', message: 'This plan takes no new subscriber.' },
        });
    });

    it.each([
        ['GET', '/nope'],
        ['GET', '/subscriptions/sub_1/cancel'],
        ['GET', '/subscriptions/sub_1/payments'],
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

describe('the widget routes: one subscription in full', () => {
    const DAY = 24 * 3600 * 1000;
    const at = (daysAgo: number) => new Date(Date.UTC(2026, 9, 1) - daysAgo * DAY).toISOString();
    const calls = (fake: FakeMesub, from = 0) =>
        fake.requests.slice(from).map((each) => `${each.method} ${each.path}`);

    interface Detail {
        subscription: Record<string, unknown>;
        payments: Array<Record<string, unknown>> | null;
        paid: { count: number; amount: string } | null;
        payments_error: { code: string; message: string } | null;
        upcoming: Array<Record<string, unknown>>;
    }

    const SOON = '2026-11-01T09:00:00.000Z';
    const LATER = '2026-11-03T09:00:00.000Z';

    /** A subscription of Ada's in that state, and what its detail answers. */
    async function detailOf(
        fields: Record<string, unknown>,
        options?: Parameters<typeof setup>[0],
    ) {
        const { call, fake } = setup(options);
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            ...fields,
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        return { body: answer.body as Detail, fake, id };
    }

    it('announces the next charge of a running one, at the price of its plan', async () => {
        const { body } = await detailOf({ status: 'active', next_charge_at: SOON });

        expect(body.upcoming).toEqual([
            {
                kind: 'charge',
                due_at: SOON,
                amount: '9990000',
                amount_display: '9.99',
                retry_number: null,
                retries_allowed: null,
            },
        ]);
    });

    it('announces the next retry of a late one, as a retry', async () => {
        const { body } = await detailOf({
            status: 'unpaid',
            payment_status: 'late',
            next_retry_at: SOON,
            next_retry_number: 2,
            retries_allowed: 3,
            // Not a pull: never read for a late one.
            next_charge_at: LATER,
        });

        expect(body.upcoming).toEqual([
            {
                kind: 'retry',
                due_at: SOON,
                amount: '9990000',
                amount_display: '9.99',
                retry_number: 2,
                retries_allowed: 3,
            },
        ]);
    });

    it('announces a retry without its number when Mesub does not say which', async () => {
        const { body } = await detailOf({
            status: 'unpaid',
            payment_status: 'late',
            next_retry_at: SOON,
        });

        expect(body.upcoming).toMatchObject([
            { kind: 'retry', due_at: SOON, retry_number: null, retries_allowed: null },
        ]);
    });

    it('never numbers a charge, whatever the subscription carries', async () => {
        const { body } = await detailOf({
            status: 'active',
            next_charge_at: SOON,
            next_retry_number: 1,
            retries_allowed: 3,
        });

        expect(body.upcoming).toMatchObject([
            { kind: 'charge', retry_number: null, retries_allowed: null },
        ]);
    });

    it('announces nothing for a late one on Free, and hands on its deadline as it is', async () => {
        const { body, fake, id } = await detailOf({
            status: 'unpaid',
            payment_status: 'late',
            access: false,
            next_retry_at: null,
            retry_deadline: SOON,
        });

        expect(body.upcoming).toEqual([]);
        expect(body.subscription).toMatchObject({ retry_deadline: SOON, next_retry_at: null });
        // No entry, so no price to read.
        expect(calls(fake).sort()).toEqual([
            `GET /v1/subscriptions/${id}`,
            `GET /v1/subscriptions/${id}/attempts`,
        ]);
    });

    it('announces a retry on Free while one is due before the deadline', async () => {
        const { body } = await detailOf({
            status: 'unpaid',
            next_retry_at: SOON,
            retry_deadline: LATER,
        });

        expect(body.upcoming).toMatchObject([{ kind: 'retry', due_at: SOON }]);
    });

    it.each([
        ['a cancelled', { status: 'cancelled', access_until: SOON }],
        ['a stopped', { status: 'stopped', access: false }],
        ['an ended', { status: 'ended', end_reason: 'cancelled', access: false }],
        ['a superseded', { status: 'superseded', access: false }],
        ['a pending', { status: 'pending', access: false, confirmed_at: null }],
        ['an expired', { status: 'expired', access: false, confirmed_at: null }],
        ['a failed', { status: 'failed', access: false, confirmed_at: null }],
        ['a status newer than this release for', { status: 'frozen' }],
        ['a parked active', { status: 'active', paused: true }],
        ['a parked unpaid', { status: 'unpaid', paused: true }],
    ])('announces nothing for %s one, whatever dates it carries', async (_name, fields) => {
        const { body, fake } = await detailOf({
            ...fields,
            next_charge_at: SOON,
            next_retry_at: SOON,
        });

        expect(body.upcoming).toEqual([]);
        expect(calls(fake)).not.toContain('GET /v1/plans/pro');
    });

    it.each([
        ['active', { status: 'active', next_charge_at: null, next_retry_at: SOON }],
        ['unpaid', { status: 'unpaid', next_retry_at: null, next_charge_at: SOON }],
    ])('announces nothing for an %s one with no date of its own', async (_name, fields) => {
        const { body } = await detailOf(fields);

        expect(body.upcoming).toEqual([]);
    });

    it.each([
        ['Mesub no longer has', { plan: 'gone' }],
        ['without a slug', { plan: null }],
    ])('announces the charge without an amount for a plan %s', async (_name, fields) => {
        const { body } = await detailOf({ next_charge_at: SOON, ...fields });

        expect(body.upcoming).toEqual([
            {
                kind: 'charge',
                due_at: SOON,
                amount: null,
                amount_display: null,
                retry_number: null,
                retries_allowed: null,
            },
        ]);
    });

    it('announces the charge without an amount when Mesub refuses the plan alone', async () => {
        const { fake } = setup();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            confirmed_at: at(30),
            next_charge_at: SOON,
        });
        fake.setAttempts(id, [{ attempted_at: at(30) }]);
        const mesub = new Mesub({
            apiKey: fake.apiKey,
            baseUrl: fake.baseUrl,
            maxRetries: 0,
            fetch: (input, init) =>
                String(input).includes('/v1/plans/')
                    ? Promise.resolve(
                          Response.json(
                              { statusCode: 500, code: 'internal_error', message: 'Broken.' },
                              { status: 500 },
                          ),
                      )
                    : fake.fetch(input, init),
        });

        const answer = await handleWidget(
            mesub,
            { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
            ada,
        );

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            upcoming: [{ kind: 'charge', due_at: SOON, amount: null, amount_display: null }],
            // The payments were read all the same.
            payments: [{ outcome: 'PAID' }],
            payments_error: null,
        });
    });

    it('reads the price of a plan the widget is kept off: the subscription is theirs', async () => {
        const { call, fake } = setup();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'team',
            external_id: 'user_ada',
            next_charge_at: SOON,
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` }, { plans: ['pro'] });

        expect((answer.body as Detail).upcoming).toMatchObject([{ amount: '9990000' }]);
    });

    it('answers the subscription and its own payments, newest first, with what it paid', async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [
            { attempted_at: at(30), signature: 'sig_first', period_start: at(30) },
            {
                attempted_at: at(0),
                signature: 'sig_last',
                retry: true,
                retry_number: 2,
                retries_allowed: 3,
                period_start: at(0),
            },
            {
                attempted_at: at(1),
                outcome: 'REJECTED',
                reason: 'insufficient-balance',
                signature: 'sig_rejected',
                retry: true,
                retry_number: 1,
                retries_allowed: 3,
            },
            { attempted_at: at(2), outcome: 'SKIPPED', reason: 'wrong-delegate', signature: null },
        ]);
        const before = fake.requests.length;

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        const body = answer.body as Detail;
        expect(body.subscription).toMatchObject({ id, status: 'active', wallet: WALLET });
        expect(body.payments).toEqual([
            {
                attempted_at: at(0),
                outcome: 'PAID',
                amount: '9990000',
                reason: null,
                signature: 'sig_last',
                retry: true,
                retry_number: 2,
                retries_allowed: 3,
                period_start: at(0),
            },
            {
                attempted_at: at(1),
                outcome: 'REJECTED',
                amount: '9990000',
                reason: 'insufficient-balance',
                signature: 'sig_rejected',
                retry: true,
                retry_number: 1,
                retries_allowed: 3,
                period_start: null,
            },
            {
                attempted_at: at(2),
                outcome: 'SKIPPED',
                amount: '9990000',
                reason: 'wrong-delegate',
                signature: null,
                retry: false,
                retry_number: null,
                retries_allowed: null,
                period_start: null,
            },
            {
                attempted_at: at(30),
                outcome: 'PAID',
                amount: '9990000',
                reason: null,
                signature: 'sig_first',
                retry: false,
                retry_number: null,
                retries_allowed: null,
                period_start: at(30),
            },
        ]);
        expect(body.paid).toEqual({ count: 2, amount: '19980000' });
        expect(body.payments_error).toBeNull();
        // Read by its own id: /v1/access is not asked.
        expect(calls(fake, before).sort()).toEqual([
            'GET /v1/plans/pro',
            `GET /v1/subscriptions/${id}`,
            `GET /v1/subscriptions/${id}/attempts`,
        ]);
        expect(fake.requests.at(-1)?.query ?? {}).not.toHaveProperty('wallet');
    });

    it('never carries the email, the external id nor the API key', async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [{}]);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        const text = JSON.stringify(answer);
        expect(text).not.toContain('user_ada');
        expect(text).not.toContain('ada@example.com');
        expect(text).not.toContain(fake.apiKey);
        expect(answer.body).not.toHaveProperty('subscription.email');
        expect(answer.body).not.toHaveProperty('subscription.external_id');
    });

    it('answers an empty list for a subscription nothing was pulled for yet', async () => {
        const { client, call } = setup();
        const id = await subscribed(client);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.body).toMatchObject({
            payments: [],
            paid: { count: 0, amount: '0' },
            payments_error: null,
        });
    });

    it.each([
        ['wallet', { kind: 'wallet', value: WALLET }],
        ['external id', ada],
        ['email', { kind: 'email', value: 'ada@example.com' }],
    ] as const)('is read by its customer named by %s', async (_name, asked) => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [{ attempted_at: at(0) }]);

        const answer = await call(asked, { path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        expect((answer.body as Detail).payments).toHaveLength(1);
    });

    it.each([
        ['wallet', { kind: 'wallet', value: OTHER_WALLET }],
        ['external id', bob],
        ['email', { kind: 'email', value: 'eve@example.com' }],
    ] as const)(
        'answers 404 to another customer named by %s, without reading its payments',
        async (_name, asked) => {
            const { client, call, fake } = setup();
            const id = await subscribed(client);
            fake.setAttempts(id, [{ signature: 'sig_secret' }]);
            const before = fake.requests.length;

            const theirs = await call(asked, { path: `/subscriptions/${id}` });
            const unknown = await call(asked, { path: '/subscriptions/sub_nope' });

            expect(theirs).toMatchObject({
                status: 404,
                body: { error: { code: 'subscription_not_found' } },
            });
            // Identical to an id nobody holds.
            expect(theirs).toEqual(unknown);
            expect(JSON.stringify(theirs)).not.toContain('sig_secret');
            expect(calls(fake, before)).toEqual([
                `GET /v1/subscriptions/${id}`,
                'GET /v1/subscriptions/sub_nope',
            ]);
        },
    );

    it.each(['..', '.', 'a b', 'a.b', 'x'.repeat(65)])(
        'refuses the id %j before asking Mesub',
        async (id) => {
            const { call, fake } = setup();

            const answer = await call(ada, { path: `/subscriptions/${encodeURIComponent(id)}` });

            expect(answer).toMatchObject({
                status: 404,
                body: { error: { code: 'subscription_not_found' } },
            });
            expect(fake.requests).toEqual([]);
        },
    );

    it('hands on an outcome newer than this release, and the total as Mesub counted it', async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [
            { attempted_at: at(0), outcome: 'REFUNDED' as never, reason: 'made-up' },
            { attempted_at: at(1), outcome: 'BLOCKED', signature: null },
            { attempted_at: at(2), amount: '5000000' },
        ]);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        const body = answer.body as Detail;
        expect(body.payments?.map((each) => each['outcome'])).toEqual([
            'REFUNDED',
            'BLOCKED',
            'PAID',
        ]);
        expect(body.paid).toEqual({ count: 1, amount: '5000000' });
    });

    it('serves the first page and the total of all, past the page and past a float', async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [
            { attempted_at: at(0), amount: '18446744073709551615' },
            ...Array.from({ length: 24 }, (_, n) => ({ attempted_at: at(n + 1), amount: '1' })),
        ]);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        const body = answer.body as Detail;
        expect(body.payments).toHaveLength(20);
        // Mesub's own count, not a sum of the twenty shown.
        expect(body.paid).toEqual({ count: 25, amount: '18446744073709551639' });
    });

    it('hands on the total exactly as Mesub answered it', async () => {
        const { client, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [{}]);
        const mesub = fake.client();
        vi.spyOn(mesub.subscriptions, 'attempts').mockResolvedValue({
            data: [],
            has_more: true,
            paid: { count: 7, amount: '123' },
        });

        const answer = await handleWidget(
            mesub,
            { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
            ada,
        );

        expect(answer.body).toMatchObject({ payments: [], paid: { count: 7, amount: '123' } });
    });

    it('hands the browser only the fields it knows of an attempt', async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.setAttempts(id, [{ detail: 'Program log: internal' } as never]);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(JSON.stringify(answer.body)).not.toContain('internal');
        expect(Object.keys((answer.body as Detail).payments![0]!).sort()).toEqual([
            'amount',
            'attempted_at',
            'outcome',
            'period_start',
            'reason',
            'retries_allowed',
            'retry',
            'retry_number',
            'signature',
        ]);
    });

    it('serves a superseded subscription its own payments, never those of the one that replaced it', async () => {
        const { client, call, fake } = setup();
        const old = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            status: 'superseded',
            access: false,
            payment_status: 'none',
            created_at: at(90),
            confirmed_at: at(90),
        });
        fake.setAttempts(old.id, [
            { attempted_at: at(90), signature: 'sig_old_1' },
            { attempted_at: at(60), signature: 'sig_old_2' },
        ]);
        const current = await subscribed(client);
        fake.setAttempts(current, [{ signature: 'sig_current' }]);

        const answer = await call(ada, { path: `/subscriptions/${old.id}` });

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            subscription: { id: old.id, status: 'superseded' },
            payments: [{ signature: 'sig_old_2' }, { signature: 'sig_old_1' }],
            paid: { count: 2, amount: '19980000' },
            payments_error: null,
        });
        expect(JSON.stringify(answer.body)).not.toContain('sig_current');
        // The current one gets its own, and its own total.
        const mine = (await call(ada, { path: `/subscriptions/${current}` })).body as Detail;
        expect(mine.payments).toMatchObject([{ signature: 'sig_current' }]);
        expect(mine.paid).toEqual({ count: 1, amount: '9990000' });
    });

    it('serves an ended subscription what it paid, with nothing in force on that plan', async () => {
        const { call, fake } = setup();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            status: 'ended',
            access: false,
        });
        fake.setAttempts(id, [{ attempted_at: at(40) }]);
        fake.deny(WALLET, 'pro');

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.body).toMatchObject({
            payments: [{ attempted_at: at(40) }],
            paid: { count: 1, amount: '9990000' },
            payments_error: null,
        });
    });

    it.each(['pending', 'expired', 'failed'] as const)(
        'answers a %s checkout what Mesub holds for it: nothing, or a payment',
        async (status) => {
            const { call, fake } = setup();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                external_id: 'user_ada',
                status,
                access: false,
                confirmed_at: null,
            });

            const empty = await call(ada, { path: `/subscriptions/${id}` });

            expect(empty).toMatchObject({
                status: 200,
                body: { payments: [], paid: { count: 0, amount: '0' }, payments_error: null },
            });
            expect(calls(fake)).toEqual([
                `GET /v1/subscriptions/${id}`,
                `GET /v1/subscriptions/${id}/attempts`,
            ]);

            // A comeback left failed after it paid keeps that payment.
            fake.setAttempts(id, [{}]);
            const paid = await call(ada, { path: `/subscriptions/${id}` });
            expect((paid.body as Detail).paid).toEqual({ count: 1, amount: '9990000' });
        },
    );

    it('reads the payments of a plan that has no slug, by the subscription id', async () => {
        const { call, fake } = setup();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: null as never,
            external_id: 'user_ada',
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer).toMatchObject({
            status: 200,
            body: { payments: [], paid: { count: 0, amount: '0' }, payments_error: null },
        });
        expect(calls(fake)).toEqual([
            `GET /v1/subscriptions/${id}`,
            `GET /v1/subscriptions/${id}/attempts`,
        ]);
    });

    it("hands on Mesub's refusal of the subscription, never the API key", async () => {
        const { client, call, fake } = setup();
        const id = await subscribed(client);
        fake.fail({ status: 429, code: 'rate_limited', retryAfter: 30 });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer).toMatchObject({
            status: 429,
            body: { error: { code: 'rate_limited' } },
            headers: { 'Retry-After': '30' },
        });
        expect(JSON.stringify(answer)).not.toContain(fake.apiKey);
    });

    it.each([
        [{ status: 429, code: 'rate_limited' }, 'rate_limited'],
        [{ status: 500, code: 'internal_error' }, 'internal_error'],
        [{ status: 404, code: 'plan_not_found' }, 'plan_not_found'],
        // Not the subscription's own 404: it was read.
        [{ status: 404, code: 'subscription_not_found' }, 'subscription_not_found'],
    ])(
        'still answers the subscription when its payments are refused: %j',
        async (failure, code) => {
            const { client, fake } = setup();
            const id = await subscribed(client);
            fake.setAttempts(id, [{}]);
            // The subscription is read, then Mesub fails.
            const mesub = fake.client();
            vi.spyOn(mesub.subscriptions, 'retrieve').mockImplementation(async (...args) => {
                const read = await client.subscriptions.retrieve(...args);
                fake.fail(failure);
                return read;
            });

            const answer = await handleWidget(
                mesub,
                { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
                ada,
            );

            expect(answer.status).toBe(200);
            expect(answer.body).toMatchObject({
                subscription: { id },
                payments: null,
                paid: null,
                payments_error: { code, message: expect.any(String) },
                // The date is the subscription's own; the price could not be read.
                upcoming: [{ kind: 'charge', amount: null, amount_display: null }],
            });
            expect(JSON.stringify(answer)).not.toContain(fake.apiKey);
            // A refusal is no missing route: the older way is not tried.
            expect(calls(fake)).not.toContain('GET /v1/access');
        },
    );

    it('still answers the subscription when Mesub cannot be reached for its payments', async () => {
        const { client, fake } = setup();
        const id = await subscribed(client);
        const read = await client.subscriptions.retrieve(id);
        const mesub = fake.client();
        vi.spyOn(mesub.subscriptions, 'retrieve').mockResolvedValue(read);
        fake.fail('outage');

        const answer = await handleWidget(
            mesub,
            { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
            ada,
        );

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ payments: null, paid: null, payments_error: {} });
    });

    it('never tells the browser why its payments could not be read, short of a word of Mesub', async () => {
        const { client } = setup();
        const id = await subscribed(client);
        const read = await client.subscriptions.retrieve(id);
        const mesub = new Mesub({
            apiKey: 'SUB_test',
            maxRetries: 0,
            fetch: async () => {
                throw new Error('connect ECONNREFUSED 10.0.0.7:8443');
            },
        });
        vi.spyOn(mesub.subscriptions, 'retrieve').mockResolvedValue(read);

        const answer = await handleWidget(
            mesub,
            { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
            ada,
        );

        expect(answer.body).toMatchObject({
            payments_error: {
                code: 'unavailable',
                message: 'Mesub could not answer this request.',
            },
        });
    });

    it('throws what is not a refusal of Mesub: a bug, never an answer', async () => {
        const { client, fake } = setup();
        const id = await subscribed(client);
        const mesub = fake.client();
        vi.spyOn(mesub.subscriptions, 'attempts').mockRejectedValue(new RangeError('boom'));

        await expect(
            handleWidget(
                mesub,
                { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
                ada,
            ),
        ).rejects.toThrow(RangeError);
    });

    it('answers 502 or 503 when Mesub cannot be reached at all', async () => {
        const { call, fake } = setup();
        fake.fail('outage');

        const answer = await call(ada, { path: '/subscriptions/sub_1' });

        expect([502, 503]).toContain(answer.status);
    });
});

/**
 * A merchant who upgrades the SDK before Mesub serves
 * `GET /v1/subscriptions/:id/attempts`: the route answers 404 `not_found`,
 * and payments are read as before, through `/v1/access`, without a total.
 */
describe('the widget routes: one subscription, from a Mesub without the attempts route', () => {
    const DAY = 24 * 3600 * 1000;
    const at = (daysAgo: number) => new Date(Date.UTC(2026, 9, 1) - daysAgo * DAY).toISOString();
    const calls = (fake: FakeMesub, from = 0) =>
        fake.requests.slice(from).map((each) => `${each.method} ${each.path}`);
    const older = () => setup({ attemptsRoute: false });

    it('still answers its last payments, newest first, with no total and no retry told', async () => {
        const { client, call, fake } = older();
        const id = await subscribed(client);
        fake.setAttempts(id, [
            { attempted_at: at(30), signature: 'sig_first' },
            { attempted_at: at(0), signature: 'sig_last', retry: true, retry_number: 1 },
            { attempted_at: at(1), outcome: 'SKIPPED', reason: 'wrong-delegate', signature: null },
        ]);
        const before = fake.requests.length;

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            subscription: { id },
            payments: [
                {
                    attempted_at: at(0),
                    outcome: 'PAID',
                    amount: '9990000',
                    reason: null,
                    signature: 'sig_last',
                    retry: null,
                    retry_number: null,
                    retries_allowed: null,
                    period_start: null,
                },
                { attempted_at: at(1), outcome: 'SKIPPED', retry: null },
                { attempted_at: at(30), signature: 'sig_first', retry: null },
            ],
            // Five attempts at most are no total: none is made up.
            paid: null,
            payments_error: null,
        });
        expect(calls(fake, before).sort()).toEqual([
            'GET /v1/access',
            'GET /v1/plans/pro',
            `GET /v1/subscriptions/${id}`,
            `GET /v1/subscriptions/${id}/attempts`,
        ]);
        expect(fake.requests.find((each) => each.path === '/v1/access')?.query).toEqual({
            wallet: WALLET,
            plan: 'pro',
            attempts: 'true',
        });
    });

    it('answers an empty list for one nothing was pulled for yet', async () => {
        const { client, call } = older();
        const id = await subscribed(client);

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.body).toMatchObject({ payments: [], paid: null, payments_error: null });
    });

    it('does not serve the payments of a newer subscription on the same wallet and plan', async () => {
        const { client, call, fake } = older();
        const old = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            status: 'superseded',
            access: false,
            payment_status: 'none',
            created_at: at(90),
            confirmed_at: at(90),
        });
        const current = await subscribed(client);
        fake.setAttempts(current, [{ signature: 'sig_current' }]);

        const answer = await call(ada, { path: `/subscriptions/${old.id}` });

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            subscription: { id: old.id, status: 'superseded' },
            payments: null,
            paid: null,
            payments_error: { code: 'not_the_current_subscription' },
        });
        expect(JSON.stringify(answer.body)).not.toContain('sig_current');
        const mine = await call(ada, { path: `/subscriptions/${current}` });
        expect((mine.body as { payments: unknown[] }).payments).toHaveLength(1);
    });

    it('does not serve payments when Mesub answers about nothing on that plan', async () => {
        const { call, fake } = older();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            status: 'ended',
            access: false,
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.body).toMatchObject({
            payments: null,
            paid: null,
            payments_error: { code: 'not_the_current_subscription' },
        });
    });

    it.each(['pending', 'expired', 'failed'] as const)(
        'answers no payment for a %s checkout, without asking /v1/access',
        async (status) => {
            const { call, fake } = older();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                external_id: 'user_ada',
                status,
                access: false,
                confirmed_at: null,
            });

            const answer = await call(ada, { path: `/subscriptions/${id}` });

            expect(answer).toMatchObject({ status: 200, body: { payments: [], paid: null } });
            expect(calls(fake)).not.toContain('GET /v1/access');
        },
    );

    it('answers without payments for a plan that has no slug', async () => {
        const { call, fake } = older();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: null as never,
            external_id: 'user_ada',
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer).toMatchObject({
            status: 200,
            body: { payments: null, paid: null, payments_error: { code: 'plan_without_slug' } },
        });
        expect(calls(fake)).not.toContain('GET /v1/access');
    });

    it('still answers the subscription when /v1/access is refused too', async () => {
        const { client, fake } = older();
        const id = await subscribed(client);
        fake.setAttempts(id, [{}]);
        const mesub = fake.client();
        vi.spyOn(mesub, 'access').mockImplementation(async () => {
            fake.fail({ status: 429, code: 'rate_limited' });
            return client.access(WALLET, 'pro', { attempts: true });
        });

        const answer = await handleWidget(
            mesub,
            { method: 'GET', path: `/subscriptions/${id}`, body: undefined, contentType: null },
            ada,
        );

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            subscription: { id },
            payments: null,
            paid: null,
            payments_error: { code: 'rate_limited' },
        });
    });

    it('answers 404 to another customer without reading anything more', async () => {
        const { client, call, fake } = older();
        const id = await subscribed(client);
        fake.setAttempts(id, [{ signature: 'sig_secret' }]);
        const before = fake.requests.length;

        const theirs = await call(bob, { path: `/subscriptions/${id}` });

        expect(theirs).toMatchObject({
            status: 404,
            body: { error: { code: 'subscription_not_found' } },
        });
        expect(JSON.stringify(theirs)).not.toContain('sig_secret');
        expect(calls(fake, before)).toEqual([`GET /v1/subscriptions/${id}`]);
    });

    it('announces a retry without its number: an older Mesub does not say which', async () => {
        const { call, fake } = older();
        const { id } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_ada',
            status: 'unpaid',
            payment_status: 'late',
            next_retry_at: '2026-11-01T09:00:00.000Z',
        });

        const answer = await call(ada, { path: `/subscriptions/${id}` });

        expect(answer.body).toMatchObject({
            upcoming: [{ kind: 'retry', retry_number: null, retries_allowed: null }],
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

    it('answers 404 itself to a path it does not serve, never through next()', async () => {
        const { server } = app(() => ({ external_id: 'user_ada' }));
        const after = vi.fn((_req: express.Request, res: express.Response) => {
            res.status(404).json({ yours: true });
        });
        server.use(after);

        const response = await request(server).get('/api/mesub/nope').expect(404);

        expect(response.body).toEqual({ error: { code: 'not_found', message: 'Nothing here.' } });
        expect(after).not.toHaveBeenCalled();
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

    it('serves one subscription with its payments, and 404 for one not theirs', async () => {
        let user = 'user_ada';
        const { server, fake } = app(() => ({ external_id: user }), true);
        const id = await subscribed(fake.client());
        fake.setAttempts(id, [{ signature: 'sig_1' }]);

        const response = await request(server).get(`/api/mesub/subscriptions/${id}`);

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({
            subscription: { id },
            payments: [{ outcome: 'PAID', signature: 'sig_1' }],
            upcoming: [{ kind: 'charge', amount: '9990000', amount_display: '9.99' }],
            paid: { count: 1, amount: '9990000' },
            payments_error: null,
        });
        expect(response.text).not.toContain('user_ada');

        user = 'user_bob';
        const theirs = await request(server).get(`/api/mesub/subscriptions/${id}`);
        expect(theirs.status).toBe(404);
        expect(theirs.body).toEqual({
            error: { code: 'subscription_not_found', message: expect.any(String) },
        });
    });

    it('answers 401 to one subscription with nobody signed in, 404 to an id that is none', async () => {
        const signedOut = app(() => null);
        await request(signedOut.server).get('/api/mesub/subscriptions/sub_1').expect(401);
        expect(signedOut.fake.requests).toEqual([]);

        const { server, fake } = app(() => ({ external_id: 'user_ada' }));
        await request(server).get('/api/mesub/subscriptions/a%20b').expect(404);
        await request(server).get('/api/mesub/subscriptions/..%2Faccess').expect(404);
        expect(fake.requests).toEqual([]);
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

    /** A POST whose body comes in those chunks, and how many of them were asked for. */
    function streamed(chunks: Iterable<Uint8Array>, headers: Record<string, string> = {}) {
        const each = chunks[Symbol.iterator]();
        const seen = { pulls: 0, cancelled: false };
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    seen.pulls++;
                    const next = each.next();
                    if (next.done) controller.close();
                    else controller.enqueue(next.value);
                },
                cancel() {
                    seen.cancelled = true;
                },
            },
            { highWaterMark: 0 },
        );
        const request = new Request('https://shop.test/api/mesub/x', {
            method: 'POST',
            headers: { 'content-type': JSON_TYPE, ...headers },
            body,
            duplex: 'half',
        } as RequestInit);

        return { request, seen };
    }

    function* forever(chunk: Uint8Array) {
        for (;;) yield chunk;
    }

    it('counts the 64 kB in bytes, not in characters', async () => {
        const { POST, fake } = handlers(() => ({ external_id: 'user_ada' }));
        // 30 000 characters, 90 000 bytes.
        const heavy = json({ plan: 'pro', wallet: '€'.repeat(30_000) });

        const response = await POST(heavy, context('subscriptions'));

        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({
            error: { code: 'payload_too_large', message: 'The body is too large.' },
        });
        expect(fake.requests).toHaveLength(0);
    });

    it('takes a body of exactly 64 kB', async () => {
        const { POST } = handlers(() => ({ external_id: 'user_ada' }));
        const empty = JSON.stringify({ plan: 'pro', wallet: WALLET, pad: '' }).length;
        const full = json({ plan: 'pro', wallet: WALLET, pad: 'x'.repeat(64 * 1024 - empty) });

        expect((await POST(full, context('subscriptions'))).status).toBe(201);
    });

    it('refuses on Content-Length alone, reading nothing', async () => {
        const { POST } = handlers(() => ({ external_id: 'user_ada' }));
        const { request, seen } = streamed(forever(new Uint8Array(1024)), {
            'content-length': String(64 * 1024 + 1),
        });

        expect((await POST(request, context('subscriptions'))).status).toBe(413);
        expect(seen.pulls).toBe(0);
    });

    it('stops reading at the limit when no Content-Length says it', async () => {
        const { POST } = handlers(() => ({ external_id: 'user_ada' }));
        const { request, seen } = streamed(forever(new Uint8Array(16 * 1024)));

        expect((await POST(request, context('subscriptions'))).status).toBe(413);
        // Four chunks fill the 64 kB, the fifth passes it.
        expect(seen.pulls).toBe(5);
        expect(seen.cancelled).toBe(true);
    });

    it('reads a body whose characters are cut across chunks', async () => {
        const { POST, fake } = handlers(() => ({ external_id: 'user_ada' }));
        const bytes = new TextEncoder().encode(
            JSON.stringify({ plan: 'pro', wallet: `${WALLET}é€` }),
        );
        const { request } = streamed(Array.from(bytes, (byte) => Uint8Array.of(byte)));

        expect((await POST(request, context('subscriptions'))).status).toBe(201);
        expect(fake.requests.at(-1)?.body).toMatchObject({ wallet: `${WALLET}é€` });
    });

    it('serves one subscription with its payments, and 404 for one not theirs', async () => {
        let user: string | null = 'user_ada';
        const { GET, fake } = handlers(() => (user ? { external_id: user } : null));
        const id = await subscribed(fake.client());
        fake.setAttempts(id, [{ signature: 'sig_1' }, { outcome: 'BLOCKED', signature: null }]);
        const get = () => GET(new Request('https://shop.test/x'), context('subscriptions', id));

        const response = await get();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
            subscription: { id },
            payments: [{ signature: 'sig_1' }, { outcome: 'BLOCKED' }],
            upcoming: [{ kind: 'charge', due_at: expect.any(String), amount: '9990000' }],
            paid: { count: 1, amount: '9990000' },
        });
        expect(text).not.toContain('user_ada');

        user = 'user_bob';
        expect((await get()).status).toBe(404);
        user = null;
        const before = fake.requests.length;
        expect((await get()).status).toBe(401);
        expect(fake.requests).toHaveLength(before);
    });

    it('refuses an id that is none through the catch-all, asking Mesub nothing', async () => {
        const { GET, fake } = handlers(() => ({ external_id: 'user_ada' }));

        const response = await GET(
            new Request('https://shop.test/x'),
            context('subscriptions', '../access'),
        );

        expect(response.status).toBe(404);
        expect(fake.requests).toEqual([]);
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
