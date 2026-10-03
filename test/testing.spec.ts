import express from 'express';
import request from 'supertest';

import { requirePlan } from '../src/express.js';
import { Mesub, MesubError } from '../src/index.js';
import { FakeMesub } from '../src/testing.js';

const WALLET = 'SysvarRent111111111111111111111111111111111';
const OTHER = 'SysvarC1ock11111111111111111111111111111111';

async function codeOf(promise: Promise<unknown>) {
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MesubError);
    return (error as MesubError).apiCode ?? (error as MesubError).code;
}

describe('FakeMesub', () => {
    it('answers what a test granted, and nothing for anyone else', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        const mesub = fake.client();

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        await expect(mesub.hasAccess(WALLET, 'team')).resolves.toBe(false);
        await expect(mesub.access(OTHER, 'pro')).resolves.toMatchObject({
            wallet: OTHER,
            access: false,
            status: 'none',
        });
    });

    it('answers paused and end_reason, false and null unless a test sets them', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();

        fake.grant(WALLET, 'pro');
        fake.deny(WALLET, 'team', { status: 'ended', end_reason: 'plan_removed' });
        fake.grant(WALLET, 'solo', { paused: true, payment_status: 'none' });
        const added = fake.addSubscription({ wallet: WALLET, plan: 'pro' });

        await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
            paused: false,
            end_reason: null,
        });
        await expect(mesub.access(WALLET, 'never')).resolves.toMatchObject({
            paused: false,
            end_reason: null,
        });
        await expect(mesub.access(WALLET, 'team')).resolves.toMatchObject({
            access: false,
            status: 'ended',
            end_reason: 'plan_removed',
        });
        await expect(mesub.access(WALLET, 'solo')).resolves.toMatchObject({
            access: true,
            paused: true,
        });
        expect(added).toMatchObject({ paused: false, end_reason: null });
    });

    it('builds clients of the core Mesub', () => {
        expect(new FakeMesub().client()).toBeInstanceOf(Mesub);
    });

    it('answers a change on the next call', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.grant(WALLET, 'pro');
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

        fake.deny(WALLET, 'pro', { status: 'stopped' });

        await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
            access: false,
            status: 'stopped',
        });
    });

    it('answers a customer by external id or email, as named', async () => {
        const fake = new FakeMesub();
        fake.grant({ external_id: 'user_42' }, 'pro', { wallet: WALLET });
        fake.grant({ email: 'ada@example.com' }, 'pro');
        const mesub = fake.client();

        await expect(mesub.access({ external_id: ' user_42 ' }, 'pro')).resolves.toMatchObject({
            wallet: WALLET,
            access: true,
        });
        await expect(mesub.hasAccess({ email: 'Ada@Example.com' }, 'pro')).resolves.toBe(true);
        await expect(mesub.access({ external_id: 'user_7' }, 'pro')).resolves.toMatchObject({
            wallet: null,
            access: false,
        });
    });

    it('lists every plan of a customer', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        fake.deny(WALLET, 'team', { status: 'ended' });
        fake.grant(OTHER, 'pro');

        const list = await fake.client().accessList(WALLET);

        expect(list.plans.map(({ plan, access }) => ({ plan, access }))).toEqual([
            { plan: 'pro', access: true },
            { plan: 'team', access: false },
        ]);
    });

    it('answers attempts when asked', async () => {
        const fake = new FakeMesub();
        const attempt = {
            outcome: 'PAID' as const,
            reason: null,
            amount: '1000000',
            attempted_at: '2026-10-01T00:00:00.000Z',
            signature: 'sig',
        };
        fake.grant(WALLET, 'pro', { attempts: [attempt] });
        const mesub = fake.client();

        await expect(mesub.access(WALLET, 'pro', { attempts: true })).resolves.toMatchObject({
            attempts: [attempt],
        });
        expect(await mesub.access(WALLET, 'pro')).not.toHaveProperty('attempts');
    });

    it('answers plan_not_found for a plan it was not told of', async () => {
        const fake = new FakeMesub({ plans: ['pro'] });
        const mesub = fake.client();

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        expect(await codeOf(mesub.hasAccess(WALLET, 'gold'))).toBe('plan_not_found');
    });

    it('refuses any key but its own', async () => {
        const fake = new FakeMesub();
        const mesub = new Mesub({ apiKey: 'SUB_wrong', baseUrl: fake.baseUrl, fetch: fake.fetch });

        expect(await codeOf(mesub.access(WALLET, 'pro'))).toBe('invalid_api_key');
    });

    it('fails as told, and the outage fallback serves what was cached', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        const mesub = fake.client();
        await mesub.hasAccess(WALLET, 'pro');

        fake.fail('outage');

        expect(await codeOf(mesub.access(WALLET, 'pro'))).toBe('unavailable');
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        await expect(mesub.hasAccess(OTHER, 'pro')).resolves.toBe(false);

        fake.fail(null);
        await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({ access: true });
    });

    it('fails with the error and Retry-After given', async () => {
        const fake = new FakeMesub();
        fake.fail({ status: 429, code: 'rate_limited', retryAfter: 2 });

        const error = (await fake
            .client()
            .access(WALLET, 'pro')
            .catch((e: unknown) => e)) as MesubError;

        expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 2000 });
    });

    it('signs tokens its clients verify', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();

        await expect(
            mesub.verifyToken(await fake.token(WALLET, { userId: 'user_1' })),
        ).resolves.toEqual({ userId: 'user_1', wallet: WALLET });
        expect(
            await codeOf(mesub.verifyToken(await fake.token(WALLET, { expiresIn: '-1m' }))),
        ).toBe('invalid_token');
        // Another fake's key, project or issuer is not this one's.
        expect(await codeOf(mesub.verifyToken(await new FakeMesub().token(WALLET)))).toBe(
            'invalid_token',
        );
    });

    it('drives a guard end to end', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        const app = express().get(
            '/pro',
            requirePlan('pro', { client: fake.client() }),
            (_q, res) => {
                res.json({ ok: true });
            },
        );

        await request(app)
            .get('/pro')
            .set('Authorization', `Bearer ${await fake.token(WALLET)}`)
            .expect(200, { ok: true });
        await request(app)
            .get('/pro')
            .set('Authorization', `Bearer ${await fake.token(OTHER)}`)
            .expect(402);
        await request(app).get('/pro').expect(401);
    });

    it('subscribes: create, submit, then access, retrieve and list', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();

        const created = await mesub.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_42',
        });
        expect(created.subscription.status).toBe('pending');
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);

        const { subscription } = await mesub.subscriptions.submit(created.subscription.id, {
            transaction: created.transaction,
            terms_signature: 'signed',
        });

        expect(subscription).toMatchObject({ status: 'active', access: true, wallet: WALLET });
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        await expect(mesub.hasAccess({ external_id: 'user_42' }, 'pro')).resolves.toBe(true);
        await expect(mesub.subscriptions.retrieve(subscription.id)).resolves.toEqual(subscription);
        await expect(mesub.subscriptions.list({ wallet: WALLET })).resolves.toEqual({
            data: [subscription],
            has_more: false,
        });
        expect(
            await codeOf(
                mesub.subscriptions.submit(subscription.id, {
                    transaction: created.transaction,
                    terms_signature: 'signed',
                }),
            ),
        ).toBe('not_awaiting_signature');
        expect(await codeOf(mesub.subscriptions.retrieve('sub_nope'))).toBe(
            'subscription_not_found',
        );
    });

    it('pages subscriptions newest first', async () => {
        const fake = new FakeMesub();
        const first = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        const second = fake.addSubscription({ wallet: WALLET, plan: 'team' });
        fake.addSubscription({ wallet: OTHER, plan: 'pro' });

        const all = [];
        for await (const subscription of fake
            .client()
            .subscriptions.listAll({ wallet: WALLET, limit: 1 })) {
            all.push(subscription.id);
        }

        expect(all).toEqual([second.id, first.id]);
    });

    it('records every call', async () => {
        const fake = new FakeMesub();
        await fake.client().access({ email: 'ada@example.com' }, 'pro');

        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]).toMatchObject({
            method: 'GET',
            path: '/v1/access',
            query: { email: 'ada@example.com', plan: 'pro' },
        });
        expect(fake.requests[0]!.headers.get('mesub-version')).toMatch(/^\d{4}-/);
    });

    it('serves under a base URL with a path', async () => {
        const fake = new FakeMesub({ baseUrl: 'https://proxy.example.test/mesub/' });
        fake.grant(WALLET, 'pro');
        const mesub = fake.client();

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        await expect(mesub.verifyToken(await fake.token(WALLET))).resolves.toMatchObject({
            wallet: WALLET,
        });
        expect(fake.requests.map((r) => r.path)).toContain('/.well-known/jwks.json');
    });

    it('forgets everything on reset', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        fake.fail('outage');
        await fake
            .client()
            .hasAccess(WALLET, 'pro')
            .catch(() => null);

        fake.reset();

        expect(fake.requests).toEqual([]);
        await expect(fake.client().hasAccess(WALLET, 'pro')).resolves.toBe(false);
    });
});
