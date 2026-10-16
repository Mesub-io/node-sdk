import express from 'express';
import request from 'supertest';

import { requirePlan } from '../src/express.js';
import { Mesub, MesubError, explain } from '../src/index.js';
import type { ServerSubscription } from '../src/subscriptions.js';
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
            late_reason: null,
        });
        await expect(mesub.access(WALLET, 'never')).resolves.toMatchObject({
            paused: false,
            end_reason: null,
            late_reason: null,
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

    // Mesub's AccessService: a no is fresh 10 s (REVALIDATE_MIN_S), a yes
    // until the next retry, charge, expiry or parked period end, the plan's
    // end, or a blocked row's access_until, from 10 s to 300 s
    // (revalidateAfter); a list for the soonest yes, 10 with none.
    describe('revalidate_after', () => {
        const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
        const near = (seconds: number) => expect.closeTo(seconds, -1);

        it('serves Mesub’s: 10 for a no, up to 300 for a yes', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const freshness = async (customer: string, plan: string) =>
                (await mesub.access(customer, plan)).revalidate_after;

            fake.grant(WALLET, 'pro');
            fake.grant(WALLET, 'charge', { next_charge_at: at(120) });
            fake.grant(WALLET, 'soon', { next_charge_at: at(2) });
            fake.grant(WALLET, 'late', {
                status: 'unpaid',
                next_retry_at: at(200),
                next_charge_at: null,
            });
            fake.grant(WALLET, 'cancelled', { status: 'cancelled', access_until: at(150) });
            fake.grant(WALLET, 'parked', { paused: true, current_period_end: at(90) });
            fake.grant(WALLET, 'blocked', {
                blocked_since: at(-60),
                blocked_reason: 'receiver_not_allowed',
                access_until: at(100),
                next_retry_at: at(250),
            });
            fake.grantLastPeriod(WALLET, 'ending', at(80));
            fake.deny(WALLET, 'stopped', { status: 'stopped' });

            await expect(freshness(OTHER, 'pro')).resolves.toBe(10);
            await expect(freshness(WALLET, 'stopped')).resolves.toBe(10);
            await expect(freshness(WALLET, 'pro')).resolves.toBe(300);
            await expect(freshness(WALLET, 'charge')).resolves.toEqual(near(120));
            await expect(freshness(WALLET, 'soon')).resolves.toBe(10);
            await expect(freshness(WALLET, 'late')).resolves.toEqual(near(200));
            await expect(freshness(WALLET, 'cancelled')).resolves.toEqual(near(150));
            await expect(freshness(WALLET, 'parked')).resolves.toEqual(near(90));
            await expect(freshness(WALLET, 'blocked')).resolves.toEqual(near(100));
            await expect(freshness(WALLET, 'ending')).resolves.toEqual(near(80));
        });

        it('serves a list the soonest yes, and 10 with none', async () => {
            const fake = new FakeMesub();
            // A new client each time: one keeps a list as long as it is fresh.
            const mesub = { accessList: (wallet: string) => fake.client().accessList(wallet) };

            await expect(mesub.accessList(WALLET)).resolves.toEqual({
                plans: [],
                revalidate_after: 10,
            });

            fake.deny(OTHER, 'team', { status: 'stopped' });
            await expect(mesub.accessList(OTHER)).resolves.toMatchObject({
                revalidate_after: 10,
            });

            fake.grant(WALLET, 'pro');
            fake.grant(WALLET, 'charge', { next_charge_at: at(120) });
            fake.deny(WALLET, 'team', { status: 'stopped' });
            await expect(mesub.accessList(WALLET)).resolves.toMatchObject({
                revalidate_after: near(120),
            });
        });

        it('keeps a yes cached as a real client does: a later no shows once it is stale', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.grant(WALLET, 'pro');
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            fake.deny(WALLET, 'pro', { status: 'stopped' });

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
            await expect(fake.client().hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it('serves the one asked for, 0 to answer a change on the next call', async () => {
            const fake = new FakeMesub({ revalidateAfter: 0 });
            const mesub = fake.client();
            fake.grant(WALLET, 'pro');
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: true,
                revalidate_after: 0,
            });

            fake.deny(WALLET, 'pro', { status: 'stopped' });

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: false,
                status: 'stopped',
                revalidate_after: 0,
            });
            await expect(mesub.accessList(OTHER)).resolves.toMatchObject({ revalidate_after: 0 });
            // One a test sets on an answer wins.
            fake.grant(WALLET, 'team', { revalidate_after: 3600 });
            await expect(mesub.access(WALLET, 'team')).resolves.toMatchObject({
                revalidate_after: 3600,
            });
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

    it('gives a subscription its attempts, filled in, for its customer however named', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const { id, confirmed_at } = fake.addSubscription({
            wallet: WALLET,
            plan: 'pro',
            external_id: 'user_42',
        });

        const set = fake.setAttempts(id, [
            {},
            { outcome: 'rejected', reason: 'insufficient_balance' },
        ]);

        expect(set[0]).toMatchObject({
            id: expect.stringMatching(/^att_fake_/),
            outcome: 'paid',
            reason: null,
            amount: '9990000',
            amount_usd: '9.99',
            retry: false,
            retry_number: null,
            retries_allowed: null,
            period_start: null,
        });
        // /v1/access serves the five fields it always did.
        const served = set.map(({ outcome, reason, amount, attempted_at, signature }) => ({
            outcome,
            reason,
            amount,
            attempted_at,
            signature,
        }));
        for (const customer of [WALLET, { external_id: 'user_42' }]) {
            const answer = await mesub.access(customer, 'pro', { attempts: true });

            expect(answer).toMatchObject({ wallet: WALLET, subscribed_since: confirmed_at });
            expect(answer.attempts).toEqual(served);
        }
        expect(await mesub.access(WALLET, 'pro')).not.toHaveProperty('attempts');
        expect(() => fake.setAttempts('sub_nope', [])).toThrow(/sub_nope/);
    });

    it('prices an attempt of the default amount, and any other only when told', async () => {
        const fake = new FakeMesub();
        const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();

        fake.setAttempts(id, [
            { attempted_at: day(4) },
            { attempted_at: day(3), amount: '30000000000' },
            { attempted_at: day(2), amount: '30000000000', amount_usd: '0.41' },
            { attempted_at: day(1), amount_usd: null },
        ]);
        const { data } = await fake.client().subscriptions.attempts(id);

        expect(data.map((each) => each.amount_usd)).toEqual(['9.99', null, '0.41', null]);
        // /v1/access serves no dollar value.
        const answer = await fake.client().access(WALLET, 'pro', { attempts: true });
        expect(answer.attempts![0]).not.toHaveProperty('amount_usd');
    });

    it('answers a subscription its own attempts, paged, with the total over all of them', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        const other = fake.addSubscription({ wallet: WALLET, plan: 'team' });
        const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();
        const set = fake.setAttempts(id, [
            { attempted_at: day(1) },
            { attempted_at: day(3), retry: true, retry_number: 2, retries_allowed: 3 },
            { attempted_at: day(2), outcome: 'skipped', reason: 'insufficient_balance' },
            ...[4, 5, 6, 7].map((n) => ({ attempted_at: day(n) })),
        ]);

        // Newest first, whatever the order handed.
        expect(set.map((each) => each.attempted_at)).toEqual(
            [7, 6, 5, 4, 3, 2, 1].map((n) => day(n)),
        );
        const first = await mesub.subscriptions.attempts(id, { limit: 3 });
        const second = await mesub.subscriptions.attempts(id, {
            limit: 3,
            starting_after: first.data.at(-1)!.id,
        });
        const all = [];
        for await (const each of mesub.subscriptions.allAttempts(id, { limit: 3 })) all.push(each);

        expect(first).toEqual({
            data: set.slice(0, 3),
            has_more: true,
            paid: { count: 6, amount: String(6 * 9_990_000) },
        });
        expect(second.data).toEqual(set.slice(3, 6));
        expect(second.paid).toEqual(first.paid);
        expect(all).toEqual(set);
        expect(set[4]).toMatchObject({ retry: true, retry_number: 2, retries_allowed: 3 });
        // /v1/access serves five at most, as Mesub does.
        expect((await mesub.access(WALLET, 'pro', { attempts: true })).attempts).toHaveLength(5);
        // A subscription nothing was set for has none.
        await expect(mesub.subscriptions.attempts(other.id)).resolves.toEqual({
            data: [],
            has_more: false,
            paid: { count: 0, amount: '0' },
        });
    });

    it('refuses the attempts of an id it does not hold, a cursor that is none, a limit past 100', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        fake.setAttempts(id, [{}]);

        await expect(mesub.subscriptions.attempts('sub_nope')).rejects.toMatchObject({
            status: 404,
            apiCode: 'subscription_not_found',
        });
        await expect(
            mesub.subscriptions.attempts(id, { starting_after: 'att_nope' }),
        ).rejects.toMatchObject({ status: 400, apiCode: 'invalid_request' });
        await expect(mesub.subscriptions.attempts(id, { limit: 101 })).rejects.toMatchObject({
            status: 400,
        });

        fake.reset();
        const again = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        expect((await mesub.subscriptions.attempts(again.id)).data).toEqual([]);
    });

    it('acts as a Mesub that predates the attempts route when told to', async () => {
        const fake = new FakeMesub({ attemptsRoute: false });
        const mesub = fake.client();
        const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        fake.setAttempts(id, [{}]);

        for (const asked of [id, 'sub_nope']) {
            await expect(mesub.subscriptions.attempts(asked)).rejects.toMatchObject({
                status: 404,
                code: 'not_found',
                apiCode: null,
            });
        }
        // The older way still answers.
        expect((await mesub.access(WALLET, 'pro', { attempts: true })).attempts).toHaveLength(1);
    });

    it('answers attempts when asked', async () => {
        const fake = new FakeMesub();
        const attempt = {
            outcome: 'paid' as const,
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
        // Stale at once, so the client asks again and meets the failure.
        const fake = new FakeMesub({ revalidateAfter: 0 });
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

    // Mesub's error body takes `retryable` from its code (ERROR_CODES), never from the status.
    it('says retryable by the code, as Mesub does, else by the status', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const retryableOf = async (failure: Parameters<FakeMesub['fail']>[0]) => {
            fake.fail(failure);
            const error = await mesub.access(WALLET, 'pro').catch((caught: unknown) => caught);
            return (error as MesubError).retryable;
        };

        await expect(retryableOf({ status: 409, code: 'subscription_changed' })).resolves.toBe(
            true,
        );
        await expect(retryableOf({ status: 409, code: 'comeback_in_flight' })).resolves.toBe(true);
        await expect(retryableOf({ status: 409, code: 'already_subscribed' })).resolves.toBe(false);
        await expect(retryableOf({ status: 503, code: 'network_unavailable' })).resolves.toBe(true);
        // A code Mesub does not have: the status says.
        await expect(retryableOf({ status: 502, code: 'bad_gateway' })).resolves.toBe(true);
        await expect(retryableOf({ status: 409, code: 'made_up' })).resolves.toBe(false);
        // What the test says wins.
        await expect(
            retryableOf({ status: 409, code: 'subscription_changed', retryable: false }),
        ).resolves.toBe(false);
    });

    it('drives a guard end to end', async () => {
        const fake = new FakeMesub();
        fake.grant(WALLET, 'pro');
        const app = express().get(
            '/pro',
            // Stands for the app's own login: a test header names who is signed in.
            requirePlan('pro', {
                client: fake.client(),
                customer: (req) => req.get('x-test-user') ?? null,
            }),
            (_q, res) => {
                res.json({ ok: true });
            },
        );

        await request(app).get('/pro').set('x-test-user', WALLET).expect(200, { ok: true });
        await request(app).get('/pro').set('x-test-user', OTHER).expect(402);
        await request(app).get('/pro').expect(401);
    });

    it('says why a late customer is late, and nothing for any other (#109)', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.grant(WALLET, 'pro', { status: 'unpaid', late_reason: 'approval_revoked' });
        fake.grant(OTHER, 'pro');

        await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
            status: 'unpaid',
            late_reason: 'approval_revoked',
        });
        await expect(mesub.access(OTHER, 'pro')).resolves.toMatchObject({ late_reason: null });
        expect(fake.addSubscription({ wallet: WALLET, plan: 'pro' }).late_reason).toBeNull();
    });

    it('keeps one checkout per customer on a wallet, as Mesub does (#100)', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const ask = (customer: { external_id?: string; email?: string }) =>
            mesub.subscriptions.create({ plan: 'pro', wallet: WALLET, ...customer });

        const his = await ask({ external_id: 'user_bob' });
        const again = await ask({ external_id: 'user_bob', email: ' Bob@Shop.test ' });
        const hers = await ask({ external_id: 'user_alice' });
        const byEmail = await ask({ email: 'bob@shop.test' });
        const nobody = await ask({});

        // The same customer gets its own back, with the email given this time.
        expect(again.subscription.id).toBe(his.subscription.id);
        await expect(mesub.subscriptions.retrieve(his.subscription.id)).resolves.toMatchObject({
            external_id: 'user_bob',
            email: 'bob@shop.test',
        });
        // Anybody else naming that wallet gets another, and his is not written.
        const ids = [his, hers, byEmail, nobody].map((made) => made.subscription.id);
        expect(new Set(ids).size).toBe(4);
        await expect(mesub.subscriptions.retrieve(hers.subscription.id)).resolves.toMatchObject({
            external_id: 'user_alice',
            wallet: WALLET,
        });
    });

    it('expires the other checkouts on a wallet once one lands, and takes no new one', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const signed = { transaction: 'signed', terms_signature: 'signed' };
        const his = await mesub.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_bob',
        });
        const hers = await mesub.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_alice',
        });
        const elsewhere = await mesub.subscriptions.create({
            plan: 'pro',
            wallet: OTHER,
            external_id: 'user_alice',
        });

        await mesub.subscriptions.submit(his.subscription.id, signed);

        await expect(mesub.hasAccess({ external_id: 'user_bob' }, 'pro')).resolves.toBe(true);
        await expect(mesub.hasAccess({ external_id: 'user_alice' }, 'pro')).resolves.toBe(false);
        await expect(mesub.subscriptions.retrieve(hers.subscription.id)).resolves.toMatchObject({
            status: 'expired',
            access: false,
        });
        expect(await codeOf(mesub.subscriptions.submit(hers.subscription.id, signed))).toBe(
            'not_awaiting_signature',
        );
        expect(
            await codeOf(
                mesub.subscriptions.create({
                    plan: 'pro',
                    wallet: WALLET,
                    external_id: 'user_alice',
                }),
            ),
        ).toBe('already_subscribed');
        // Another wallet's checkout is no business of his.
        await expect(
            mesub.subscriptions.retrieve(elsewhere.subscription.id),
        ).resolves.toMatchObject({ status: 'pending' });
    });

    // Mesub's reserveSubscription answers liveRefusal of the wallet's live row
    // on the plan, by its status; a STOPPED one nothing cancelled is a
    // comeback, a new checkout beside it (#211).
    it('refuses a create over a subscription the wallet holds, by its status', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const create = (plan: string) => mesub.subscriptions.create({ plan, wallet: WALLET });
        const later = new Date(Date.now() + 3600 * 1000).toISOString();
        const past = '2020-01-01T00:00:00.000Z';
        const held = (plan: string, fields: Partial<Omit<ServerSubscription, 'plan'>>) =>
            fake.addSubscription({ wallet: WALLET, plan, ...fields });

        held('active', { status: 'active' });
        held('cancelled', { status: 'cancelled', access_until: later });
        held('cancelled-over', { status: 'cancelled', access: false, access_until: past });
        // Cancelled and past its end, not closed yet: Mesub reads it ended.
        held('ran-out', { status: 'ended', end_reason: 'cancelled', access: false });
        held('unpaid', { status: 'unpaid', payment_status: 'late' });
        const stopped = held('stopped', { status: 'stopped', access: false });
        held('closed', { status: 'ended', end_reason: 'closed', access: false });

        expect(await codeOf(create('active'))).toBe('already_subscribed');
        const resume = await create('cancelled').catch((caught: unknown) => caught);
        expect(resume).toMatchObject({ apiCode: 'subscription_cancelled' });
        expect((resume as MesubError).message).toContain('resume it');
        const close = await create('cancelled-over').catch((caught: unknown) => caught);
        expect(close).toMatchObject({ apiCode: 'subscription_cancelled' });
        expect((close as MesubError).message).toContain('close it');
        expect(await codeOf(create('ran-out'))).toBe('subscription_cancelled');
        expect(await codeOf(create('unpaid'))).toBe('payment_pending');

        const comeback = await create('stopped');
        expect(comeback.subscription.id).not.toBe(stopped.id);
        await expect(create('closed')).resolves.toMatchObject({
            subscription: { status: 'pending' },
        });
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

    describe('a fresh transaction', () => {
        async function waiting(fake: FakeMesub, plan = 'pro') {
            const mesub = fake.client();
            const created = await mesub.subscriptions.create({
                plan,
                wallet: WALLET,
                external_id: 'user_42',
            });

            return { mesub, created, id: created.subscription.id };
        }

        it('answers a pending subscription what create answered, with the same terms', async () => {
            const fake = new FakeMesub();
            const { mesub, created, id } = await waiting(fake);

            const fresh = await mesub.subscriptions.transaction(id);

            expect(fresh).toEqual({
                ...created,
                // A fresh transaction, dated from now.
                transaction_expires_at: expect.any(String),
                terms: { message: created.terms.message, expires_at: expect.any(String) },
            });
            expect(fresh.subscription).toEqual({ id, status: 'pending' });
            // The same text: the terms signature a test holds is still good.
            expect(fresh.terms.message).toBe(created.terms.message);
            expect(fake.requests.at(-1)).toMatchObject({
                method: 'POST',
                path: `/v1/subscriptions/${id}/transaction`,
                body: undefined,
            });
        });

        it('reserves nothing: the same subscription, however often it is asked', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await waiting(fake);

            await mesub.subscriptions.transaction(id);
            await mesub.subscriptions.transaction(id);

            const { data } = await mesub.subscriptions.list({ wallet: WALLET });
            expect(data.map((each) => [each.id, each.status])).toEqual([[id, 'pending']]);
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it('hands out a transaction the submit takes', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await waiting(fake);

            const fresh = await mesub.subscriptions.transaction(id);
            const { subscription } = await mesub.subscriptions.submit(id, {
                transaction: fresh.transaction,
                terms_signature: 'signed',
            });

            expect(subscription).toMatchObject({ id, status: 'active', access: true });
        });

        it.each([
            ['active', {}],
            ['cancelled', { status: 'cancelled' }],
            ['unpaid', { status: 'unpaid', payment_status: 'late' }],
            ['stopped', { status: 'stopped', access: false }],
            ['ended', { status: 'ended', end_reason: 'closed', access: false }],
            ['expired', { status: 'expired', access: false }],
            ['failed', { status: 'failed', access: false }],
            ['superseded', { status: 'superseded', access: false }],
        ] as const)('refuses a %s one: it awaits no signature', async (_status, fields) => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro', ...fields });

            const error = await fake
                .client()
                .subscriptions.transaction(id)
                .catch((caught: unknown) => caught);

            expect(error).toMatchObject({
                status: 409,
                code: 'conflict',
                apiCode: 'not_awaiting_signature',
                retryable: false,
            });
        });

        it('refuses once it landed, and once another checkout expired it', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const his = await mesub.subscriptions.create({
                plan: 'pro',
                wallet: WALLET,
                external_id: 'user_1',
            });
            const hers = await mesub.subscriptions.create({
                plan: 'pro',
                wallet: WALLET,
                external_id: 'user_2',
            });
            await mesub.subscriptions.submit(his.subscription.id, {
                transaction: his.transaction,
                terms_signature: 'signed',
            });

            for (const { subscription } of [his, hers]) {
                expect(await codeOf(mesub.subscriptions.transaction(subscription.id))).toBe(
                    'not_awaiting_signature',
                );
            }
        });

        it('refuses a pending one beside a subscription that landed on that wallet', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await waiting(fake);
            fake.addSubscription({ wallet: WALLET, plan: 'pro' });

            expect(await codeOf(mesub.subscriptions.transaction(id))).toBe('already_subscribed');
            // Another plan, or another wallet, is no business of this checkout.
            const other = await waiting(fake, 'team');
            fake.addSubscription({ wallet: OTHER, plan: 'team' });
            await expect(mesub.subscriptions.transaction(other.id)).resolves.toMatchObject({
                subscription: { id: other.id },
            });
        });

        // Mesub's subscribeTransaction answers liveRefusal of the row that landed, by its status.
        it('refuses it by the status of the subscription that landed', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await waiting(fake);
            const landed = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });

            expect(await codeOf(mesub.subscriptions.transaction(id))).toBe('payment_pending');
            landed.status = 'cancelled';
            expect(await codeOf(mesub.subscriptions.transaction(id))).toBe(
                'subscription_cancelled',
            );
        });

        it('refuses once the plan ended, and not before', async () => {
            const soon = new Date(Date.now() + 3600 * 1000).toISOString();
            const fake = new FakeMesub({ plans: [{ slug: 'pro', ends_at: soon }] });
            const { mesub, id } = await waiting(fake);

            await expect(mesub.subscriptions.transaction(id)).resolves.toBeDefined();
            fake.endPlan('pro');
            expect(await codeOf(mesub.subscriptions.transaction(id))).toBe('plan_ended');
        });

        it('answers subscription_not_found for an id it does not hold', async () => {
            const fake = new FakeMesub();

            const error = await fake
                .client()
                .subscriptions.transaction('sub_nope')
                .catch((caught: unknown) => caught);

            expect(error).toMatchObject({ status: 404, apiCode: 'subscription_not_found' });
        });

        it.each([
            ['GET', 'transaction'],
            ['POST', 'transaction/confirm'],
        ])('knows no %s .../%s', async (method, step) => {
            const fake = new FakeMesub();
            const { id } = await waiting(fake);

            const response = await fake.fetch(`${fake.baseUrl}/v1/subscriptions/${id}/${step}`, {
                method,
                headers: { authorization: `Bearer ${fake.apiKey}` },
            });

            expect(response.status).toBe(404);
            await expect(response.json()).resolves.toMatchObject({ code: 'not_found' });
        });

        it('fails like any other call when told to', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await waiting(fake);

            fake.fail({ status: 503, code: 'network_unavailable', retryAfter: 10 });
            await expect(mesub.subscriptions.transaction(id)).rejects.toMatchObject({
                status: 503,
                apiCode: 'network_unavailable',
                retryAfter: 10_000,
            });
            fake.fail(null);
            await expect(mesub.subscriptions.transaction(id)).resolves.toBeDefined();
        });
    });

    describe('blocked charges', () => {
        const SINCE = '2026-10-04T08:00:00.000Z';
        const REASONS = [
            'mesub',
            'puller_not_allowed',
            'receiver_not_allowed',
            'receiver_account_missing',
            'receiver_account_frozen',
            'mint_gone',
        ] as const;

        it('answers both fields null unless a test sets them', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.grant(WALLET, 'pro');
            fake.deny(WALLET, 'team', { status: 'stopped' });
            const added = fake.addSubscription({ wallet: WALLET, plan: 'pro' });

            for (const plan of ['pro', 'team', 'never']) {
                await expect(mesub.access(WALLET, plan)).resolves.toMatchObject({
                    blocked_since: null,
                    blocked_reason: null,
                });
            }
            await expect(mesub.subscriptions.retrieve(added.id)).resolves.toMatchObject({
                blocked_since: null,
                blocked_reason: null,
            });
            const { plans } = await mesub.accessList(WALLET);
            expect(plans.map((plan) => plan.blocked_reason)).toEqual([null, null]);
        });

        it.each(REASONS)('serves a block by %s as set, status unmoved', async (blocked_reason) => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const block = { blocked_since: SINCE, blocked_reason };
            fake.grant(WALLET, 'pro', block);
            fake.grant({ external_id: 'user_42' }, 'pro', block);
            const added = fake.addSubscription({ wallet: WALLET, plan: 'pro', ...block });

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: true,
                status: 'active',
                payment_status: 'paid',
                ...block,
            });
            await expect(mesub.access({ external_id: 'user_42' }, 'pro')).resolves.toMatchObject(
                block,
            );
            await expect(mesub.accessList(WALLET)).resolves.toMatchObject({ plans: [block] });
            await expect(mesub.subscriptions.retrieve(added.id)).resolves.toMatchObject(block);
            await expect(mesub.subscriptions.list({ wallet: WALLET })).resolves.toMatchObject({
                data: [block],
            });
        });

        it('serves a blocked one whose access ended, and a guard refuses it', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.deny(WALLET, 'pro', {
                status: 'active',
                payment_status: 'paid',
                blocked_since: SINCE,
                blocked_reason: 'puller_not_allowed',
            });

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: false,
                status: 'active',
                access_until: null,
                blocked_reason: 'puller_not_allowed',
            });
        });

        it('carries a block in a webhook, null by default', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const plain = await fake.webhook('subscription.renewed');
            const blocked = await fake.webhook('subscription.renewal_upcoming', {
                subscription: { blocked_since: SINCE, blocked_reason: 'mesub' },
            });

            await expect(mesub.webhooks.verify(plain.body, plain.headers)).resolves.toMatchObject({
                data: { blocked_since: null, blocked_reason: null },
            });
            await expect(
                mesub.webhooks.verify(blocked.body, blocked.headers),
            ).resolves.toMatchObject({ data: { blocked_since: SINCE, blocked_reason: 'mesub' } });
        });

        it('lifts the block when the subscription is cancelled, closed or its plan ends', async () => {
            const block = { blocked_since: SINCE, blocked_reason: 'mesub' } as const;
            const lifted = { blocked_since: null, blocked_reason: null };
            const signed = { signature: 'fake_signature' };
            const fake = new FakeMesub();
            const mesub = fake.client();
            const cancelled = fake.addSubscription({ wallet: WALLET, plan: 'pro', ...block });
            const ended = fake.addSubscription({ wallet: OTHER, plan: 'team', ...block });
            fake.grant(WALLET, 'pro', block);
            fake.grant(OTHER, 'team', block);

            await mesub.subscriptions.cancel(cancelled.id);
            await expect(
                mesub.subscriptions.confirmCancel(cancelled.id, signed),
            ).resolves.toMatchObject({ subscription: { status: 'cancelled', ...lifted } });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject(lifted);

            fake.endPlan('team');
            await expect(mesub.subscriptions.retrieve(ended.id)).resolves.toMatchObject({
                status: 'ended',
                ...lifted,
            });
            await expect(mesub.access(OTHER, 'team')).resolves.toMatchObject({
                status: 'ended',
                ...lifted,
            });
        });

        it('keeps the block through a hand retry, which lands nothing here', async () => {
            const fake = new FakeMesub();
            const block = { blocked_since: SINCE, blocked_reason: 'mint_gone' } as const;
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'unpaid',
                payment_status: 'late',
                ...block,
            });

            await expect(fake.client().subscriptions.retry(id)).resolves.toMatchObject(block);
        });
    });

    describe('a plan with an end', () => {
        const HOUR = 3600 * 1000;
        const soon = () => new Date(Date.now() + HOUR).toISOString();

        afterEach(() => {
            vi.useRealTimers();
        });

        it('grants a last period: access until the end, and no charge ahead', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const end = soon();

            fake.grantLastPeriod(WALLET, 'pro', end);
            const answer = await mesub.access(WALLET, 'pro');

            expect(answer).toMatchObject({
                access: true,
                status: 'active',
                payment_status: 'paid',
                access_until: end,
                next_charge_at: null,
                next_retry_at: null,
            });
            expect(explain(answer).key).toBe('active_last_period');
            await expect(mesub.plans.retrieve('pro')).resolves.toMatchObject({ ends_at: end });
        });

        it('takes the end as a Date, and other fields on top', async () => {
            const fake = new FakeMesub();
            const end = new Date(Date.now() + HOUR);

            const answer = fake.grantLastPeriod({ external_id: 'user_42' }, 'pro', end, {
                status: 'unpaid',
                payment_status: 'late',
                late_reason: 'insufficient_balance',
            });

            expect(answer.access_until).toBe(end.toISOString());
            expect(explain(answer).key).toBe('unpaid_last_period');
        });

        it('refuses everyone from the end on, whatever the status still reads', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            // Stale at once: Mesub's yes just before the end is fresh 10 s.
            const fake = new FakeMesub({ revalidateAfter: 0 });
            const mesub = fake.client();
            const end = soon();
            fake.grantLastPeriod(WALLET, 'pro', end);

            vi.setSystemTime(Date.parse(end) - 1);
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            vi.setSystemTime(Date.parse(end));
            const after = await mesub.access(WALLET, 'pro');
            expect(after).toMatchObject({ access: false, status: 'active', access_until: null });
            expect(explain(after).key).toBe('ended_plan_ended');
            await expect(mesub.accessList(WALLET)).resolves.toMatchObject({
                plans: [{ plan: 'pro', access: false }],
            });
        });

        it('never serves an access_until, a charge or a retry past the end of a plan', async () => {
            const end = soon();
            const later = new Date(Date.now() + 30 * 24 * HOUR).toISOString();
            const fake = new FakeMesub({ plans: [{ slug: 'pro', ends_at: end }, 'team'] });
            const mesub = fake.client();

            fake.grant(WALLET, 'pro', { access_until: later, next_charge_at: later });
            fake.grant(WALLET, 'team', { access_until: later, next_charge_at: later });
            const held = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                access_until: later,
                next_charge_at: later,
            });

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: true,
                access_until: end,
                next_charge_at: null,
            });
            await expect(mesub.subscriptions.retrieve(held.id)).resolves.toMatchObject({
                access: true,
                access_until: end,
                next_charge_at: null,
            });
            // A plan with no end keeps its dates.
            await expect(mesub.access(WALLET, 'team')).resolves.toMatchObject({
                access_until: later,
                next_charge_at: later,
            });
        });

        it('ends a plan: everything held on it ends with plan_ended', async () => {
            const fake = new FakeMesub({ plans: ['pro', 'team'] });
            const mesub = fake.client();
            fake.grant(WALLET, 'pro');
            fake.grant(WALLET, 'team');
            fake.grant(OTHER, 'pro', { status: 'cancelled', access_until: soon() });
            const held = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
            const before = Date.now();

            fake.endPlan('pro');

            const answer = await mesub.access(WALLET, 'pro');
            expect(answer).toMatchObject({
                access: false,
                status: 'ended',
                end_reason: 'plan_ended',
                payment_status: 'none',
                access_until: null,
                next_charge_at: null,
            });
            expect(explain(answer).key).toBe('ended_plan_ended');
            // One that had cancelled ends as cancelled.
            await expect(mesub.access(OTHER, 'pro')).resolves.toMatchObject({
                access: false,
                status: 'ended',
                end_reason: 'cancelled',
            });
            await expect(mesub.subscriptions.retrieve(held.id)).resolves.toMatchObject({
                access: false,
                status: 'ended',
                end_reason: 'plan_ended',
            });
            await expect(mesub.hasAccess(WALLET, 'team')).resolves.toBe(true);

            const plan = await mesub.plans.retrieve('pro');
            expect(plan.available).toBe(false);
            expect(Date.parse(plan.ends_at!)).toBeGreaterThanOrEqual(before);
            await expect(mesub.plans.retrieve('team')).resolves.toMatchObject({
                available: true,
                ends_at: null,
            });
        });

        it('leaves a visitor and a stopped one as they were when a plan ends', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.deny(WALLET, 'pro', { status: 'stopped' });

            fake.endPlan('pro', '2026-01-01T00:00:00.000Z');

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                status: 'stopped',
                end_reason: null,
            });
            await expect(mesub.access(OTHER, 'pro')).resolves.toMatchObject({ status: 'none' });
            await expect(mesub.plans.retrieve('pro')).resolves.toMatchObject({
                ends_at: '2026-01-01T00:00:00.000Z',
                available: false,
            });
        });

        it('takes nobody new on a plan that ended', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.endPlan('pro');

            expect(await codeOf(mesub.subscriptions.create({ plan: 'pro', wallet: WALLET }))).toBe(
                'plan_ended',
            );
        });

        it('lands a subscription in its last period when the plan ends inside it', async () => {
            const end = new Date(Date.now() + 24 * HOUR).toISOString();
            const fake = new FakeMesub({ plans: [{ slug: 'pro', ends_at: end }] });
            const mesub = fake.client();

            const created = await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET });
            const { subscription } = await mesub.subscriptions.submit(created.subscription.id, {
                transaction: created.transaction,
                terms_signature: 'signed',
            });

            expect(subscription).toMatchObject({
                access: true,
                access_until: end,
                next_charge_at: null,
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: true,
                access_until: end,
                next_charge_at: null,
            });
        });

        it('forgets an end on reset', async () => {
            const fake = new FakeMesub();
            fake.endPlan('pro');
            fake.reset();

            await expect(fake.client().plans.retrieve('pro')).resolves.toMatchObject({
                ends_at: null,
                available: true,
            });
        });

        // The outage fallback, end to end: what the README promises.
        it('keeps the outage fallback from outliving the end', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const fake = new FakeMesub();
            const mesub = fake.client();
            const end = soon();
            fake.grantLastPeriod(WALLET, 'pro', end);
            await mesub.hasAccess(WALLET, 'pro');

            fake.fail('outage');
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            vi.setSystemTime(Date.parse(end) + 1);
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });
    });

    describe('closable, and a stopped subscription', () => {
        const signed = { signature: 'fake_signature' };
        const AHEAD = new Date(Date.now() + 86_400_000).toISOString();
        const PAST = '2020-01-01T00:00:00.000Z';

        it('works closable out from what its close would take, on a subscription and an answer', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const running = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
            const ending = fake.addSubscription({
                wallet: OTHER,
                plan: 'pro',
                status: 'cancelled',
                access_until: AHEAD,
            });
            const over = fake.addSubscription({
                wallet: WALLET,
                plan: 'team',
                status: 'ended',
                end_reason: 'cancelled',
                access: false,
            });
            fake.deny(OTHER, 'team', { status: 'ended', end_reason: 'plan_ended' });

            await expect(mesub.subscriptions.retrieve(running.id)).resolves.toMatchObject({
                closable: false,
                closable_from: null,
            });
            await expect(mesub.subscriptions.retrieve(ending.id)).resolves.toMatchObject({
                closable: false,
                closable_from: AHEAD,
            });
            await expect(mesub.subscriptions.retrieve(over.id)).resolves.toMatchObject({
                closable: true,
                closable_from: null,
            });
            await expect(mesub.access(OTHER, 'team')).resolves.toMatchObject({
                closable: true,
                closable_from: null,
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                subscription_id: null,
                closable: false,
            });
        });

        it('keeps the closable a test set on an answer', async () => {
            const fake = new FakeMesub();
            fake.deny(WALLET, 'pro', { status: 'ended', end_reason: 'cancelled', closable: false });

            await expect(fake.client().access(WALLET, 'pro')).resolves.toMatchObject({
                closable: false,
            });
        });

        it('closes a stopped one whose authority closed for good, and takes no comeback over it', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const dead = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'stopped',
                access: false,
                payment_status: 'none',
                late_reason: 'authority_closed',
                stop_reason: 'authority_closed',
            });
            fake.deny(WALLET, 'pro', {
                status: 'stopped',
                late_reason: 'authority_closed',
                stop_reason: 'authority_closed',
            });

            expect(explain(await mesub.access(WALLET, 'pro')).key).toBe('stopped_authority_closed');
            await expect(mesub.subscriptions.retrieve(dead.id)).resolves.toMatchObject({
                closable: true,
            });
            expect(await codeOf(mesub.subscriptions.create({ plan: 'pro', wallet: WALLET }))).toBe(
                'subscription_stopped',
            );

            await mesub.subscriptions.close(dead.id);
            const { subscription } = await mesub.subscriptions.confirmClose(dead.id, signed);

            expect(subscription).toMatchObject({
                status: 'ended',
                end_reason: 'closed',
                stop_reason: null,
                closable: false,
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                status: 'ended',
                stop_reason: null,
                subscription_id: dead.id,
                closable: false,
            });
        });

        it('says a closed plan-ended row has nothing left to close', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const ended = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'ended',
                end_reason: 'plan_ended',
                access: false,
                access_until: PAST,
            });

            await expect(mesub.subscriptions.retrieve(ended.id)).resolves.toMatchObject({
                closable: true,
            });
            await mesub.subscriptions.close(ended.id);
            await expect(mesub.subscriptions.confirmClose(ended.id, signed)).resolves.toMatchObject(
                { subscription: { closable: false } },
            );
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({ closable: false });
        });
    });

    describe('events', () => {
        const signed = { signature: 'fake_signature' };

        async function subscribed(fake: FakeMesub) {
            const mesub = fake.client();
            const created = await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET });
            const { subscription } = await mesub.subscriptions.submit(created.subscription.id, {
                transaction: created.transaction,
                terms_signature: 'signed',
            });

            return { mesub, id: subscription.id };
        }

        it('serves the events its own changes raise, newest first, with the subscription then', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);
            await mesub.subscriptions.cancel(id);
            await mesub.subscriptions.confirmCancel(id, signed);

            const { data, has_more, available_since } = await mesub.events.list();

            expect(data.map((event) => event.type)).toEqual([
                'subscription.cancelled',
                'subscription.created',
            ]);
            expect(data[0]).toMatchObject({
                object: 'event',
                network: 'devnet',
                api_version: '2026-10-02',
                data: { id, status: 'cancelled' },
                detail: {},
            });
            expect(data[1]!.data).toMatchObject({ id, status: 'active' });
            expect(has_more).toBe(false);
            expect(Date.parse(available_since)).toBeLessThan(Date.now());
            await expect(mesub.events.retrieve(data[0]!.id)).resolves.toEqual(data[0]);
        });

        it('narrows by type and subscription, and pages after an event', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const first = fake.addEvent('subscription.renewed', {
                created_at: '2026-10-01T00:00:00.000Z',
            });
            const second = fake.addEvent('subscription.payment_failed', {
                subscription: { id: 'sub_other' },
                created_at: '2026-10-02T00:00:00.000Z',
            });
            const third = fake.addEvent('subscription.renewed', {
                created_at: '2026-10-03T00:00:00.000Z',
            });
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));

            try {
                await expect(
                    mesub.events.list({ type: 'subscription.renewed' }),
                ).resolves.toMatchObject({ data: [{ id: third.id }, { id: first.id }] });
                await expect(
                    mesub.events.list({ subscription: 'sub_other' }),
                ).resolves.toMatchObject({ data: [{ id: second.id }] });
                await expect(mesub.events.list({ limit: 1 })).resolves.toMatchObject({
                    data: [{ id: third.id }],
                    has_more: true,
                });
                await expect(
                    mesub.events.list({ limit: 1, starting_after: third.id }),
                ).resolves.toMatchObject({ data: [{ id: second.id }], has_more: true });
                expect(await codeOf(mesub.events.list({ starting_after: 'evt_nobody' }))).toBe(
                    'invalid_request',
                );
                expect(await codeOf(mesub.events.list({ limit: 101 }))).toBe('invalid_request');
                expect(await codeOf(mesub.events.retrieve('evt_nobody'))).toBe('event_not_found');
            } finally {
                vi.useRealTimers();
            }
        });

        it('serves nothing older than 30 days, nor than available_since', async () => {
            const fake = new FakeMesub({ eventsSince: '2026-10-02T00:00:00.000Z' });
            const mesub = fake.client();
            const before = fake.addEvent('subscription.renewed', {
                created_at: '2026-10-01T00:00:00.000Z',
            });
            const after = fake.addEvent('subscription.renewed', {
                created_at: '2026-10-03T00:00:00.000Z',
            });
            vi.useFakeTimers({ toFake: ['Date'] });

            try {
                vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
                await expect(mesub.events.list()).resolves.toEqual({
                    data: [after],
                    has_more: false,
                    available_since: '2026-10-02T00:00:00.000Z',
                });
                expect(await codeOf(mesub.events.retrieve(before.id))).toBe('event_not_found');

                vi.setSystemTime(new Date('2026-11-03T00:00:00.000Z'));
                await expect(mesub.events.list()).resolves.toMatchObject({ data: [] });
            } finally {
                vi.useRealTimers();
            }
        });

        it('adds an event on the subscription it holds, and moves nothing', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);

            const event = fake.addEvent('subscription.payment_failed', {
                subscription: { id, status: 'unpaid', payment_status: 'late' },
            });

            expect(event).toMatchObject({
                data: { id, wallet: WALLET, status: 'unpaid' },
                detail: { reason: 'insufficient_balance', retries_left: 1 },
            });
            await expect(mesub.subscriptions.retrieve(id)).resolves.toMatchObject({
                status: 'active',
            });
            await expect(mesub.events.retrieve(event.id)).resolves.toEqual(event);
        });

        it('keeps what it serves apart from what a test holds', async () => {
            const fake = new FakeMesub();
            const event = fake.addEvent('subscription.renewed');

            event.data.status = 'ended';

            await expect(fake.client().events.retrieve(event.id)).resolves.toMatchObject({
                data: { status: 'active' },
            });
        });

        it('forgets them on reset, and numbers again from 1', async () => {
            const fake = new FakeMesub();
            fake.addEvent('subscription.renewed', { subscription: { id: 'sub_a' } });

            fake.reset();

            await expect(fake.client().events.list()).resolves.toMatchObject({ data: [] });
            expect(
                fake.addEvent('subscription.renewed', { subscription: { id: 'sub_a' } }).sequence,
            ).toBe(1);
        });

        it("numbers each subscription's events from 1, and serves a millisecond's by sequence", async () => {
            const fake = new FakeMesub();
            const created_at = new Date().toISOString();
            const sequences = [
                fake.addEvent('subscription.renewed', {
                    subscription: { id: 'sub_a' },
                    created_at,
                }),
                fake.addEvent('subscription.payment_failed', { subscription: { id: 'sub_b' } }),
                fake.addEvent('subscription.stopped', {
                    subscription: { id: 'sub_a' },
                    created_at,
                }),
            ].map((event) => event.sequence);

            const { data } = await fake.client().events.list({ subscription: 'sub_a' });

            expect(sequences).toEqual([1, 1, 2]);
            expect(data.map((event) => event.sequence)).toEqual([2, 1]);
        });

        it('takes the sequence given, and leaves it out on null, as an event Mesub could not number', async () => {
            const fake = new FakeMesub();

            const given = fake.addEvent('subscription.renewed', { sequence: 7 });
            const unnumbered = fake.addEvent('subscription.renewed', { sequence: null });

            expect(given.sequence).toBe(7);
            expect('sequence' in unnumbered).toBe(false);
            await expect(fake.client().events.retrieve(unnumbered.id)).resolves.not.toHaveProperty(
                'sequence',
            );
        });

        it('raises no access event by default, as Mesub until it turns them on', async () => {
            const fake = new FakeMesub();
            const { mesub } = await subscribed(fake);

            const { data } = await mesub.events.list();

            expect(data.map((event) => event.type)).toEqual(['subscription.created']);
            expect(data[0]!.sequence).toBe(1);
        });

        it('with accessEvents, raises access_granted after created, and none while access holds', async () => {
            const fake = new FakeMesub({ accessEvents: true });
            const { mesub, id } = await subscribed(fake);
            await mesub.subscriptions.cancel(id);
            await mesub.subscriptions.confirmCancel(id, signed);
            await mesub.subscriptions.resume(id);
            await mesub.subscriptions.confirmResume(id, signed);

            const { data } = await mesub.events.list({ subscription: id });
            const [granted, created] = data.slice(-2);

            expect(data.map(({ type, sequence }) => [type, sequence])).toEqual([
                ['subscription.resumed', 4],
                ['subscription.cancelled', 3],
                ['subscription.access_granted', 2],
                ['subscription.created', 1],
            ]);
            expect(granted).toMatchObject({
                created_at: created!.created_at,
                data: created!.data,
                detail: {
                    changed_at: created!.created_at,
                    blocked_reason: null,
                    access_until: null,
                },
            });
            expect(granted!.data.access).toBe(true);
        });

        it("tells what a submit's first payment paid, the plan's amount and mint", async () => {
            const fake = new FakeMesub({ plans: [{ slug: 'pro', amount: '5000000' }] });
            const { mesub } = await subscribed(fake);

            const { data } = await mesub.events.list({ type: 'subscription.created' });

            expect(data[0]!.detail).toEqual({
                first_payment: {
                    amount: '5000000',
                    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
                    signature: 'fake_signature',
                },
            });
        });

        it('parks and brings back a seat, raising nothing without accessEvents', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);

            const parked = fake.park(id);

            expect(parked).toMatchObject({ paused: true, next_charge_at: null, access: true });
            await expect(fake.client().access(WALLET, 'pro')).resolves.toMatchObject({
                paused: true,
                next_charge_at: null,
                access: true,
            });
            const back = fake.unpark(id);
            expect(back).toMatchObject({ paused: false, next_charge_at: back.current_period_end });
            expect((await mesub.events.list()).data.map((event) => event.type)).toEqual([
                'subscription.created',
            ]);
            expect(() => fake.park('sub_nobody')).toThrow(/no subscription sub_nobody/);
        });

        it('with accessEvents, raises paused and unpaused, once each', async () => {
            const fake = new FakeMesub({ accessEvents: true });
            const { mesub, id } = await subscribed(fake);

            fake.park(id);
            fake.park(id);
            fake.unpark(id);

            const { data } = await mesub.events.list({ subscription: id });
            expect(data.map(({ type, sequence }) => [type, sequence])).toEqual([
                ['subscription.unpaused', 4],
                ['subscription.paused', 3],
                ['subscription.access_granted', 2],
                ['subscription.created', 1],
            ]);
            expect(data[1]!.data).toMatchObject({ paused: true, next_charge_at: null });
            expect(data[0]!.detail).toEqual({});
        });

        it('adds an ended of a cancellation reaching its end with changed_at, and a paused one parked', async () => {
            const fake = new FakeMesub();

            const ended = fake.addEvent('subscription.ended', {
                subscription: { status: 'ended', end_reason: 'cancelled', access: false },
            });
            const closed = fake.addEvent('subscription.ended', {
                subscription: { status: 'ended', end_reason: 'closed', access: false },
            });
            const paused = fake.addEvent('subscription.paused');

            expect(ended.detail).toEqual({ changed_at: ended.created_at, end_reason: 'cancelled' });
            expect(closed.detail).toEqual({});
            expect(paused.data).toMatchObject({ paused: true, next_charge_at: null });
        });

        it('adds access events: a revoked one on a subscription without access', async () => {
            const fake = new FakeMesub();

            const revoked = fake.addEvent('subscription.access_revoked');
            const granted = fake.addEvent('subscription.access_granted');

            expect(revoked).toMatchObject({
                data: { status: 'ended', access: false, end_reason: 'cancelled' },
            });
            // The cancellation's end passed: that date, as Mesub's accessCauseOf.
            expect(revoked.detail).toEqual({
                changed_at: revoked.created_at,
                blocked_reason: null,
                access_until: revoked.created_at,
            });
            expect(granted).toMatchObject({ data: { status: 'active', access: true } });
            expect(granted.detail).toEqual({
                changed_at: granted.created_at,
                blocked_reason: null,
                access_until: null,
            });
            await expect(
                fake.client().events.list({ type: 'subscription.access_revoked' }),
            ).resolves.toMatchObject({ data: [{ id: revoked.id }] });
        });

        it('fills an access event from its subscription as Mesub does: held, or stopped', async () => {
            const fake = new FakeMesub();
            const until = '2026-11-01T00:00:00.000Z';
            const held = {
                blocked_since: '2026-10-01T00:00:00.000Z',
                blocked_reason: 'receiver_account_frozen' as const,
                access_until: until,
            };

            const granted = fake.addEvent('subscription.access_granted', { subscription: held });
            const heldOut = fake.addEvent('subscription.access_revoked', {
                subscription: { ...held, status: 'active', end_reason: null },
            });
            const stopped = fake.addEvent('subscription.access_revoked', {
                subscription: {
                    status: 'stopped',
                    end_reason: null,
                    stop_reason: 'authority_closed',
                },
            });

            expect(granted.detail).toMatchObject({
                blocked_reason: 'receiver_account_frozen',
                access_until: until,
            });
            expect(heldOut.detail).toMatchObject({
                blocked_reason: 'receiver_account_frozen',
                access_until: until,
            });
            expect(stopped.detail).toMatchObject({ blocked_reason: null, access_until: null });
        });

        it('signs a test delivery with sequence 1, and leaves sequence out on null', async () => {
            const fake = new FakeMesub();
            const client = fake.client();

            const test = await fake.webhook('test');
            const unnumbered = await fake.webhook('subscription.renewed', { sequence: null });

            await expect(client.webhooks.verify(test.body, test.headers)).resolves.toMatchObject({
                sequence: 1,
            });
            expect(
                await client.webhooks.verify(unnumbered.body, unnumbered.headers),
            ).not.toHaveProperty('sequence');
        });
    });

    describe('cancel, resume and close', () => {
        const PAST = '2020-01-01T00:00:00.000Z';
        const signed = { signature: 'fake_signature' };

        async function subscribed(fake: FakeMesub) {
            const mesub = fake.client();
            const created = await mesub.subscriptions.create({
                plan: 'pro',
                wallet: WALLET,
                external_id: 'user_42',
                email: 'a@b.co',
            });
            const { subscription } = await mesub.subscriptions.submit(created.subscription.id, {
                transaction: created.transaction,
                terms_signature: 'signed',
            });

            return { mesub, id: subscription.id };
        }

        it('cancels: access to the end of the period, by every name', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);

            const unsigned = await mesub.subscriptions.cancel(id);
            expect(unsigned).toEqual({
                transaction: expect.any(String),
                last_valid_block_height: expect.any(String),
                transaction_expires_at: expect.any(String),
            });
            // Nothing moves until the wallet's signature is confirmed.
            await expect(mesub.subscriptions.retrieve(id)).resolves.toMatchObject({
                status: 'active',
            });

            const { subscription, reason } = await mesub.subscriptions.confirmCancel(id, signed);

            expect(reason).toBeUndefined();
            expect(subscription).toMatchObject({
                status: 'cancelled',
                access: true,
                next_charge_at: null,
            });
            expect(subscription.access_until).toBe(subscription.current_period_end);
            for (const customer of [WALLET, { external_id: 'user_42' }, { email: 'a@b.co' }]) {
                await expect(mesub.access(customer, 'pro')).resolves.toMatchObject({
                    access: true,
                    status: 'cancelled',
                    cancelled_at: expect.any(String),
                    next_charge_at: null,
                });
            }
            await expect(mesub.subscriptions.retrieve(id)).resolves.toEqual(subscription);
            // Confirmed twice, it is answered the same.
            await expect(mesub.subscriptions.confirmCancel(id, signed)).resolves.toEqual({
                subscription,
            });
        });

        it('resumes a cancelled one', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);
            await mesub.subscriptions.cancel(id);
            await mesub.subscriptions.confirmCancel(id, signed);

            await mesub.subscriptions.resume(id);
            const { subscription } = await mesub.subscriptions.confirmResume(id, signed);

            expect(subscription).toMatchObject({ status: 'active', access: true });
            expect(subscription.next_charge_at).toBe(subscription.current_period_end);
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                status: 'active',
                cancelled_at: null,
                next_charge_at: subscription.current_period_end,
            });
            // The cancel built before is spent: a new one is needed.
            expect(await codeOf(mesub.subscriptions.confirmCancel(id, signed))).toBe(
                'nothing_to_confirm',
            );
        });

        it('closes one that is over, and ends its access', async () => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'cancelled',
                access: false,
                access_until: PAST,
            });
            fake.grant(WALLET, 'pro');
            const mesub = fake.client();

            await mesub.subscriptions.close(id);
            const { subscription } = await mesub.subscriptions.confirmClose(id, signed);

            expect(subscription).toMatchObject({
                status: 'ended',
                end_reason: 'closed',
                access: false,
                access_until: null,
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                access: false,
                status: 'ended',
                end_reason: 'closed',
            });
            expect(await codeOf(mesub.subscriptions.close(id))).toBe('subscription_not_on_chain');
        });

        it('cancels a stopped one with no access, then closes it', async () => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'stopped',
                access: false,
                payment_status: 'late',
            });
            const mesub = fake.client();

            await mesub.subscriptions.cancel(id);
            const { subscription } = await mesub.subscriptions.confirmCancel(id, signed);

            expect(subscription).toMatchObject({
                status: 'cancelled',
                access: false,
                access_until: null,
            });
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
            await mesub.subscriptions.close(id);
            await expect(mesub.subscriptions.confirmClose(id, signed)).resolves.toMatchObject({
                subscription: { status: 'ended', end_reason: 'closed' },
            });
        });

        // Mesub's buildCloseTransaction: a STOPPED row whose delegation carries
        // no expiry (nothing cancelled it) answers subscription_not_cancelled.
        it('refuses to close a stopped one never cancelled: it is cancelled first', async () => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'stopped',
                access: false,
                payment_status: 'none',
            });
            const mesub = fake.client();

            expect(await codeOf(mesub.subscriptions.close(id))).toBe('subscription_not_cancelled');
            expect(await codeOf(mesub.subscriptions.confirmClose(id, signed))).toBe(
                'subscription_not_cancelled',
            );
        });

        // Mesub's buildCloseTransaction and confirmClose (#344): a row ended
        // with its plan (removed, replaced, past its end) still holds its
        // delegation, and closes; it stays ENDED with its reason, and once its
        // account is gone a second close finds nothing on chain.
        it('closes one ended with its plan, which keeps its status and reason', async () => {
            for (const end_reason of ['plan_ended', 'plan_removed', 'plan_replaced'] as const) {
                const fake = new FakeMesub();
                const { id } = fake.addSubscription({
                    wallet: WALLET,
                    plan: 'pro',
                    status: 'ended',
                    end_reason,
                    access: false,
                    payment_status: 'none',
                });
                const mesub = fake.client();

                await expect(mesub.subscriptions.close(id)).resolves.toMatchObject({
                    transaction: expect.any(String),
                });
                await expect(mesub.subscriptions.confirmClose(id, signed)).resolves.toEqual({
                    subscription: expect.objectContaining({ status: 'ended', end_reason }),
                });
                // Confirmed twice, it is answered the same.
                await expect(mesub.subscriptions.confirmClose(id, signed)).resolves.toEqual({
                    subscription: expect.objectContaining({ status: 'ended', end_reason }),
                });
                expect(await codeOf(mesub.subscriptions.close(id))).toBe(
                    'subscription_not_on_chain',
                );
            }
        });

        // Mesub's buildCloseTransaction: an ENDED row that is neither closed
        // nor ended with its plan is answered subscription_not_on_chain.
        it('refuses to close one ended any other way', async () => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                status: 'ended',
                end_reason: 'authority_closed',
                access: false,
                payment_status: 'none',
            });

            expect(await codeOf(fake.client().subscriptions.close(id))).toBe(
                'subscription_not_on_chain',
            );
        });

        it('refuses what the status does not allow, as Mesub does', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);
            const { subscriptions } = mesub;
            const pending = await subscriptions.create({ plan: 'team', wallet: WALLET });
            const over = fake.addSubscription({
                wallet: OTHER,
                plan: 'pro',
                status: 'cancelled',
                access: false,
                access_until: PAST,
            });

            // Active: nothing to resume or close, and nothing built to confirm.
            expect(await codeOf(subscriptions.resume(id))).toBe('subscription_not_cancelled');
            expect(await codeOf(subscriptions.close(id))).toBe('subscription_not_cancelled');
            expect(await codeOf(subscriptions.confirmCancel(id, signed))).toBe(
                'nothing_to_confirm',
            );
            expect(await codeOf(subscriptions.confirmResume(id, signed))).toBe(
                'nothing_to_confirm',
            );
            expect(await codeOf(subscriptions.confirmClose(id, signed))).toBe(
                'subscription_not_cancelled',
            );
            expect(await codeOf(subscriptions.cancel(pending.subscription.id))).toBe(
                'subscription_not_active',
            );

            await subscriptions.cancel(id);
            await subscriptions.confirmCancel(id, signed);

            // Cancelled, and still running.
            expect(await codeOf(subscriptions.cancel(id))).toBe('subscription_cancelled');
            expect(await codeOf(subscriptions.close(id))).toBe('close_too_early');
            // Cancelled, and past its end.
            expect(await codeOf(subscriptions.resume(over.id))).toBe('subscription_ended');

            for (const call of [
                subscriptions.cancel('sub_nope'),
                subscriptions.resume('sub_nope'),
                subscriptions.close('sub_nope'),
                subscriptions.confirmCancel('sub_nope', signed),
                subscriptions.confirmResume('sub_nope', signed),
                subscriptions.confirmClose('sub_nope', signed),
            ]) {
                expect(await codeOf(call)).toBe('subscription_not_found');
            }
        });

        it('refuses a confirm without a signature', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);
            await mesub.subscriptions.cancel(id);

            const error = await mesub.subscriptions
                .confirmCancel(id, { signature: '' })
                .catch((caught: unknown) => caught);

            expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
        });

        it('fails them like any other call, and records them', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);

            fake.fail('outage');
            await expect(mesub.subscriptions.cancel(id)).rejects.toMatchObject({ status: 503 });
            fake.fail(null);
            await mesub.subscriptions.cancel(id);
            await mesub.subscriptions.confirmCancel(id, signed);

            expect(fake.requests.slice(-2)).toMatchObject([
                { method: 'POST', path: `/v1/subscriptions/${id}/cancel`, body: undefined },
                { method: 'POST', path: `/v1/subscriptions/${id}/cancel/confirm`, body: signed },
            ]);

            fake.reset();
            expect(await codeOf(mesub.subscriptions.confirmCancel(id, signed))).toBe(
                'subscription_not_found',
            );
        });

        it('drops the cached access of a real client once a confirm lands', async () => {
            const fake = new FakeMesub();
            const { mesub, id } = await subscribed(fake);
            fake.setAccess(WALLET, 'pro', {
                ...(await mesub.access(WALLET, 'pro')),
                revalidate_after: 3600,
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({ status: 'active' });

            await mesub.subscriptions.cancel(id);
            await mesub.subscriptions.confirmCancel(id, signed);

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                status: 'cancelled',
            });
        });
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

    // Mesub's ServerSubscriptionsService.list: SUPERSEDED rows are left out
    // (#254), still answered by id; the cursor is a position among every
    // subscription it holds, and one it does not hold is a 400.
    it('lists as Mesub does: no superseded row, and no cursor it does not hold', async () => {
        const fake = new FakeMesub();
        const old = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'superseded' });
        const comeback = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        const elsewhere = fake.addSubscription({ wallet: OTHER, plan: 'pro' });
        const newest = fake.addSubscription({ wallet: WALLET, plan: 'team' });
        const { subscriptions } = fake.client();

        await expect(subscriptions.list({ wallet: WALLET })).resolves.toMatchObject({
            data: [{ id: newest.id }, { id: comeback.id }],
            has_more: false,
        });
        await expect(subscriptions.retrieve(old.id)).resolves.toMatchObject({
            status: 'superseded',
        });
        // Another customer's id is still a position.
        await expect(
            subscriptions.list({ wallet: WALLET, starting_after: elsewhere.id }),
        ).resolves.toMatchObject({ data: [{ id: comeback.id }] });

        const error = await subscriptions
            .list({ wallet: WALLET, starting_after: 'sub_nope' })
            .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ status: 400, apiCode: 'invalid_request' });
    });

    // Mesub's CustomerQueryDto and ServerSubscribeDto: a wallet is base58, 32
    // to 44 characters, and an email is one IsEmail takes, or the call is a
    // 400 invalid_request, which a guard raises as an integration error.
    it('refuses a wallet or an email Mesub refuses, with a 400', async () => {
        const fake = new FakeMesub();
        fake.grant('alice', 'pro');
        const mesub = fake.client();
        const refused = async (promise: Promise<unknown>) => {
            const error = await promise.catch((caught: unknown) => caught);
            expect(error).toMatchObject({ status: 400, apiCode: 'invalid_request' });
        };

        await refused(mesub.hasAccess('alice', 'pro'));
        await refused(mesub.accessList('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'));
        await refused(mesub.hasAccess(`${WALLET}1x`, 'pro'));
        await refused(mesub.hasAccess({ email: 'ops@localhost' }, 'pro'));
        await refused(mesub.hasAccess({ email: 'not an email' }, 'pro'));
        await refused(mesub.subscriptions.list({ wallet: 'alice' }));
        await refused(mesub.subscriptions.list({ email: 'ops@localhost' }));
        await refused(mesub.subscriptions.create({ plan: 'pro', wallet: 'alice' }));
        await refused(
            mesub.subscriptions.create({ plan: 'pro', wallet: WALLET, email: 'ops@localhost' }),
        );

        // 32 characters is a wallet too, and a plain email is one.
        await expect(mesub.hasAccess('11111111111111111111111111111111', 'pro')).resolves.toBe(
            false,
        );
        await expect(mesub.hasAccess({ email: 'Ops@Shop.Example' }, 'pro')).resolves.toBe(false);
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
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/access']);
    });

    // Mesub-io/backend#472: an id on every answer, and in every error body.
    it('names every request in Mesub-Request-Id, and an error body by the same id', async () => {
        const fake = new FakeMesub();
        const responses: Response[] = [];
        const mesub = new Mesub({
            apiKey: fake.apiKey,
            baseUrl: fake.baseUrl,
            maxRetries: 0,
            fetch: async (input, init) => {
                const response = await fake.fetch(input, init);
                responses.push(response.clone());
                return response;
            },
        });

        await mesub.access(WALLET, 'pro');
        const error = await mesub.subscriptions.retrieve('sub_nope').catch((caught) => caught);

        const [first, second] = responses.map((each) => each.headers.get('mesub-request-id'));
        expect(first).toMatch(/^req_[0-9A-Za-z]{24}$/);
        expect(second).toMatch(/^req_[0-9A-Za-z]{24}$/);
        expect(second).not.toBe(first);
        expect(error).toMatchObject({ apiCode: 'subscription_not_found', requestId: second });
        await expect(responses[1]!.json()).resolves.toMatchObject({ request_id: second });
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

describe('FakeMesub, refusing and dating as Mesub does', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    async function errorOf(promise: Promise<unknown>) {
        const error = await promise.catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MesubError);
        return error as MesubError;
    }

    describe('Pay now (retry)', () => {
        it('refuses a parked late seat: subscription_paused', async () => {
            const fake = new FakeMesub();
            const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });
            fake.park(id);

            expect(await codeOf(fake.client().subscriptions.retry(id))).toBe('subscription_paused');
        });

        it('refuses a late one on a plan past its end: plan_ended', async () => {
            const ended = new Date(Date.now() - 1000).toISOString();
            const fake = new FakeMesub({ plans: [{ slug: 'pro', ends_at: ended }] });
            const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });

            expect(await codeOf(fake.client().subscriptions.retry(id))).toBe('plan_ended');
        });

        it('on Dev and Business: the first at once, then a wait of 20 minutes doubling', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const fake = new FakeMesub();
            const mesub = fake.client();
            const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });

            await expect(mesub.subscriptions.retry(id)).resolves.toMatchObject({
                status: 'unpaid',
            });
            const soon = await errorOf(mesub.subscriptions.retry(id));
            expect(soon).toMatchObject({ status: 409, apiCode: 'retry_too_soon', retryable: true });
            expect(soon.retryAfter).toBe(1200_000);

            vi.setSystemTime(Date.now() + 20 * 60_000);
            await mesub.subscriptions.retry(id);
            vi.setSystemTime(Date.now() + 39 * 60_000);
            expect((await errorOf(mesub.subscriptions.retry(id))).retryAfter).toBe(60_000);
            vi.setSystemTime(Date.now() + 60_000);
            await expect(mesub.subscriptions.retry(id)).resolves.toMatchObject({ id });
        });

        it('on Free: 10 minutes apart, three per missed period, none past the deadline', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const fake = new FakeMesub({ tier: 'free' });
            const mesub = fake.client();
            const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });

            for (let each = 0; each < 3; each += 1) {
                await mesub.subscriptions.retry(id);
                expect((await errorOf(mesub.subscriptions.retry(id))).retryAfter).toBe(600_000);
                vi.setSystemTime(Date.now() + 10 * 60_000);
            }
            expect(await codeOf(mesub.subscriptions.retry(id))).toBe('retries_spent');

            const passed = new Date(Date.now() - 1000).toISOString();
            const late = fake.addSubscription({
                wallet: OTHER,
                plan: 'pro',
                status: 'unpaid',
                retry_deadline: passed,
            });
            expect(await codeOf(mesub.subscriptions.retry(late.id))).toBe('retry_deadline_passed');
        });

        it("sends retry_too_soon's Retry-After with fail(), the tier's first wait", async () => {
            const dev = new FakeMesub();
            const free = new FakeMesub({ tier: 'free' });
            const { id } = dev.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });
            const other = free.addSubscription({ wallet: WALLET, plan: 'pro', status: 'unpaid' });
            dev.fail({ status: 409, code: 'retry_too_soon' });
            free.fail({ status: 409, code: 'retry_too_soon' });

            expect((await errorOf(dev.client().subscriptions.retry(id))).retryAfter).toBe(1200_000);
            expect((await errorOf(free.client().subscriptions.retry(other.id))).retryAfter).toBe(
                600_000,
            );
        });
    });

    describe('addSubscription', () => {
        it('dates each status as Mesub does', () => {
            const fake = new FakeMesub();
            const free = new FakeMesub({ tier: 'free' });
            const add = (status: ServerSubscription['status'], on = fake) =>
                on.addSubscription({ wallet: WALLET, plan: 'pro', status });
            const ahead = (date: string | null) => date !== null && Date.parse(date) > Date.now();

            const active = add('active');
            expect(active).toMatchObject({ access: true, payment_status: 'paid' });
            expect(ahead(active.current_period_end)).toBe(true);
            expect(active.access_until).toBe(active.current_period_end);
            expect(active.next_charge_at).toBe(active.current_period_end);

            const late = add('unpaid');
            expect(late).toMatchObject({
                access: true,
                payment_status: 'late',
                next_charge_at: null,
            });
            expect(ahead(late.current_period_end)).toBe(false);
            expect(ahead(late.next_retry_at)).toBe(true);
            expect(late.access_until).toBe(late.next_retry_at);

            const lateOnFree = add('unpaid', free);
            expect(lateOnFree).toMatchObject({
                access: false,
                payment_status: 'late',
                access_until: null,
                next_retry_at: null,
            });
            expect(ahead(lateOnFree.retry_deadline)).toBe(true);

            const cancelled = add('cancelled');
            expect(cancelled).toMatchObject({ access: true, next_charge_at: null });
            expect(ahead(cancelled.access_until)).toBe(true);

            expect(add('stopped')).toMatchObject({
                access: false,
                payment_status: 'none',
                stop_reason: 'out_of_retries',
                access_until: null,
            });
            expect(add('ended')).toMatchObject({
                access: false,
                payment_status: 'none',
                end_reason: 'closed',
                access_until: null,
            });
            expect(add('pending')).toMatchObject({
                access: false,
                current_period_start: null,
                confirmed_at: null,
            });
        });

        it('refuses a wallet Mesub would refuse', () => {
            expect(() =>
                new FakeMesub().addSubscription({ wallet: 'not a wallet', plan: 'pro' }),
            ).toThrow(/base58/);
        });

        it('cancelled at once, keeps its period: closed too early, resumed', async () => {
            const fake = new FakeMesub({ revalidateAfter: 0 });
            const mesub = fake.client();
            const added = fake.addSubscription({ wallet: WALLET, plan: 'pro', external_id: 'u' });

            await mesub.subscriptions.cancel(added.id);
            const { subscription } = await mesub.subscriptions.confirmCancel(added.id, {
                signature: 'x',
            });
            expect(subscription).toMatchObject({
                status: 'cancelled',
                access: true,
                access_until: added.current_period_end,
                closable: false,
                closable_from: added.current_period_end,
            });
            await expect(mesub.access({ external_id: 'u' }, 'pro')).resolves.toMatchObject({
                access_until: added.current_period_end,
                closable: false,
            });
            expect(await codeOf(mesub.subscriptions.close(added.id))).toBe('close_too_early');

            await mesub.subscriptions.resume(added.id);
            const resumed = await mesub.subscriptions.confirmResume(added.id, { signature: 'y' });
            expect(resumed.subscription).toMatchObject({
                status: 'active',
                next_charge_at: added.current_period_end,
            });
        });
    });

    describe('webhook', () => {
        it("sends the test event as Mesub's test delivery", async () => {
            const fake = new FakeMesub();
            const { body, headers } = await fake.webhook('test');
            const event = await fake.client().webhooks.verify(body, headers);

            expect(event).toMatchObject({
                id: 'evt_test',
                type: 'test',
                sequence: 1,
                test: true,
                detail: {},
                data: { id: 'sub_test', external_id: 'user_123', email: 'subscriber@example.com' },
            });
        });

        it('carries the subscription the fake holds under that id', async () => {
            const fake = new FakeMesub();
            const held = fake.addSubscription({
                wallet: WALLET,
                plan: 'pro',
                external_id: 'user_42',
                status: 'unpaid',
            });
            const { body, headers } = await fake.webhook('subscription.payment_failed', {
                subscription: { id: held.id },
            });
            const event = await fake.client().webhooks.verify(body, headers);

            expect(event.data).toMatchObject({
                id: held.id,
                status: 'unpaid',
                wallet: WALLET,
                external_id: 'user_42',
            });
        });
    });

    describe('submit', () => {
        it('refuses a plan that ended since the create: plan_ended', async () => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            const created = await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET });
            fake.endPlan('pro');

            const refused = mesub.subscriptions.submit(created.subscription.id, {
                transaction: created.transaction,
                terms_signature: 'signed',
            });
            expect(await codeOf(refused)).toBe('plan_ended');
        });

        it('refuses a body without the terms signature, as the DTO does', async () => {
            const fake = new FakeMesub();
            const created = await fake
                .client()
                .subscriptions.create({ plan: 'pro', wallet: WALLET });
            const response = await fake.fetch(
                `${fake.baseUrl}/v1/subscriptions/${created.subscription.id}/submit`,
                {
                    method: 'POST',
                    headers: { authorization: `Bearer ${fake.apiKey}` },
                    body: JSON.stringify({ transaction: created.transaction }),
                },
            );

            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({
                code: 'invalid_request',
                message: ['terms_signature must be a base58 signature'],
            });
        });
    });

    describe('ids', () => {
        it('start over on reset(), and are each fake its own', async () => {
            const fake = new FakeMesub();
            const first = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
            const delivery = await fake.webhook('subscription.renewed');
            fake.reset();

            expect(fake.addSubscription({ wallet: WALLET, plan: 'pro' }).id).toBe(first.id);
            expect((await fake.webhook('subscription.renewed')).headers).toEqual(
                expect.objectContaining({ 'webhook-id': delivery.headers['webhook-id'] }),
            );
            const other = await new FakeMesub().webhook('subscription.renewed');
            expect(other.headers['webhook-id']).toBe('msg_fake_1');
        });

        it('takes no subscription id for a made-up event', async () => {
            const fake = new FakeMesub();
            await fake.webhook('subscription.renewed');
            fake.addEvent('subscription.renewed');

            expect(fake.addSubscription({ wallet: WALLET, plan: 'pro' }).id).toBe('sub_fake_1');
        });
    });

    describe('the edges of a request', () => {
        it('tells a missing key from a wrong one', async () => {
            const fake = new FakeMesub();
            const call = async (headers: Record<string, string>) =>
                (
                    (await (await fake.fetch(`${fake.baseUrl}/v1/plans`, { headers })).json()) as {
                        code: string;
                    }
                ).code;

            await expect(call({})).resolves.toBe('missing_api_key');
            await expect(call({ authorization: 'Basic abc' })).resolves.toBe('missing_api_key');
            await expect(call({ authorization: 'Bearer SUB_nope' })).resolves.toBe(
                'invalid_api_key',
            );
        });

        it.each(['0', '101', 'ten', '1.5'])('refuses a list limit of %s', async (limit) => {
            const fake = new FakeMesub();
            const response = await fake.fetch(
                `${fake.baseUrl}/v1/subscriptions?wallet=${WALLET}&limit=${limit}`,
                { headers: { authorization: `Bearer ${fake.apiKey}` } },
            );

            expect(response.status).toBe(400);
        });
    });
});
