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
            { outcome: 'REJECTED', reason: 'insufficient-balance' },
        ]);

        expect(set[0]).toMatchObject({
            id: expect.stringMatching(/^att_fake_/),
            outcome: 'PAID',
            reason: null,
            amount: '9990000',
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

    it('answers a subscription its own attempts, paged, with the total over all of them', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const { id } = fake.addSubscription({ wallet: WALLET, plan: 'pro' });
        const other = fake.addSubscription({ wallet: WALLET, plan: 'team' });
        const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();
        const set = fake.setAttempts(id, [
            { attempted_at: day(1) },
            { attempted_at: day(3), retry: true, retry_number: 2, retries_allowed: 3 },
            { attempted_at: day(2), outcome: 'SKIPPED', reason: 'insufficient-balance' },
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
