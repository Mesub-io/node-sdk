import { readFileSync } from 'node:fs';

import {
    type AccessAnswer,
    type Explainable,
    type ServerSubscription,
    type SituationKey,
    SITUATIONS,
    explain,
    situationOf,
} from '../src/index.js';
import * as browser from '../src/situations.js';

const NAMES = { plan: 'Pro', merchant: 'Acme', amount: '9.99 USDC', token: 'USDC' };
const NOW = new Date('2026-10-05T12:00:00.000Z');
const UNTIL = '2026-11-01T12:00:00.000Z';
const RETRY = '2026-10-06T12:00:00.000Z';
const DEADLINE = '2026-10-31T11:58:00.000Z';
/** Where a plan with an end stops access, inside the period paid for. */
const PLAN_END = '2026-10-20T00:00:00.000Z';

function subscription(over: Partial<ServerSubscription> = {}): ServerSubscription {
    return {
        id: 'sub_1',
        status: 'active',
        paused: false,
        end_reason: null,
        late_reason: null,
        access: true,
        payment_status: 'paid',
        plan: 'pro',
        wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        email: null,
        external_id: null,
        current_period_start: '2026-10-02T12:00:00.000Z',
        current_period_end: UNTIL,
        next_charge_at: UNTIL,
        next_retry_at: null,
        retry_deadline: null,
        next_retry_number: null,
        retries_allowed: null,
        access_until: UNTIL,
        created_at: '2026-10-02T12:00:00.000Z',
        confirmed_at: '2026-10-02T12:00:00.000Z',
        ...over,
    };
}

function answer(over: Partial<AccessAnswer> = {}): AccessAnswer {
    return {
        wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        plan: 'pro',
        access: true,
        status: 'active',
        paused: false,
        end_reason: null,
        late_reason: null,
        payment_status: 'paid',
        subscribed_since: '2026-10-02T12:00:00.000Z',
        first_subscribed_at: '2026-10-02T12:00:00.000Z',
        current_period_end: UNTIL,
        cancelled_at: null,
        access_until: UNTIL,
        next_charge_at: UNTIL,
        next_retry_at: null,
        retry_deadline: null,
        revalidate_after: 60,
        ...over,
    };
}

const LATE = { status: 'unpaid', payment_status: 'late', next_charge_at: null } as const;
const OVER = { access: false, access_until: null, next_charge_at: null } as const;

interface Case {
    input: Explainable;
    subscriber: string;
    merchant: string;
    actions: string[];
}

/** One case per situation key: the fields that select it, and what it reads. */
const CASES = {
    none: {
        input: answer({ status: 'none', wallet: null, ...OVER, payment_status: 'none' }),
        subscriber: 'You are not subscribed to Pro.',
        merchant: 'This customer has no subscription to Pro.',
        actions: ['subscriber:subscribe'],
    },
    active: {
        input: subscription(),
        subscriber: `Active. Your next payment of 9.99 USDC is on ${UNTIL}.`,
        merchant: `Active and paid up. Next payment of 9.99 USDC on ${UNTIL}.`,
        actions: ['subscriber:cancel'],
    },
    active_unbilled: {
        input: subscription({ payment_status: 'none', next_charge_at: null }),
        subscriber: `Active until ${UNTIL}. No further payment is scheduled.`,
        merchant: `Not billed: this subscription's terms were never signed through Mesub, so Mesub never takes a payment for it. Access ends on ${UNTIL}.`,
        actions: [],
    },
    active_last_period: {
        input: subscription({ next_charge_at: null, access_until: PLAN_END }),
        subscriber: `Active until ${PLAN_END}: Pro is ending, and no further payment will be taken.`,
        merchant: `Active and paid up, in its last period: the plan is ending, so no further payment is taken. Access ends on ${PLAN_END}.`,
        actions: ['subscriber:cancel'],
    },
    unpaid_last_period: {
        input: subscription({
            ...LATE,
            late_reason: 'insufficient_balance',
            access_until: PLAN_END,
        }),
        subscriber: `Your payment of 9.99 USDC is late, and Mesub will not try again on its own: Pro is ending. You keep access until ${PLAN_END}.`,
        merchant: `Payment late, with no retry ahead: the plan ends before the next one. Access continues until ${PLAN_END}, and the subscription ends with the plan.`,
        actions: ['subscriber:cancel', 'merchant:retry'],
    },
    unpaid_insufficient_balance_retries: {
        input: subscription({
            ...LATE,
            late_reason: 'insufficient_balance',
            next_retry_at: RETRY,
            next_retry_number: 2,
            retries_allowed: 3,
        }),
        subscriber: `Your payment of 9.99 USDC is late because your wallet held too little, and nothing was taken. Add 9.99 USDC before ${RETRY}, with nothing to sign: Mesub tries again then, and your subscription stops if no payment goes through by ${UNTIL}.`,
        merchant: `Payment late: the wallet was short. Retry 2 of 3 on ${RETRY}. Access continues until ${UNTIL}; the subscription stops then if every retry fails.`,
        actions: ['subscriber:add_funds', 'subscriber:cancel', 'merchant:retry'],
    },
    unpaid_insufficient_balance_free: {
        input: subscription({
            ...LATE,
            ...OVER,
            late_reason: 'insufficient_balance',
            retry_deadline: DEADLINE,
        }),
        subscriber: `Your payment of 9.99 USDC is late because your wallet held too little, so your access is off. Add 9.99 USDC to your wallet and Acme can retry it until ${DEADLINE}; if no payment goes through by then, the subscription stops.`,
        merchant: `Payment late: the wallet was short. On Free, Mesub does not retry: you can retry by hand, up to 3 times, 10 minutes apart, until ${DEADLINE}. Access is off meanwhile, and it stops after that.`,
        actions: ['merchant:retry', 'subscriber:add_funds', 'subscriber:cancel'],
    },
    unpaid_approval_revoked: {
        input: subscription({ ...LATE, late_reason: 'approval_revoked', next_retry_at: RETRY }),
        subscriber:
            "Mesub could not take your payment of 9.99 USDC: your wallet no longer approves it (the approval was removed, or replaced by another app's). Adding funds will not fix this, and removing the approval did not cancel the subscription: Cancel it if you want to stop.",
        merchant: `Payment late: the subscriber's wallet no longer approves Mesub (removed in the wallet, or replaced by another app's approval). Every retry fails until it is back, and no Mesub route restores it today. It stops on ${UNTIL}.`,
        actions: ['subscriber:cancel'],
    },
    unpaid_authority_closed: {
        input: subscription({ ...LATE, late_reason: 'authority_closed', next_retry_at: RETRY }),
        subscriber:
            "Mesub can no longer take payments for this subscription: your wallet's approval for USDC was closed for good, so adding funds will not help. Cancel it, then close it once its period ends if you want to subscribe again.",
        merchant: `Payment late, for good: the subscriber's subscription authority for USDC was closed (or re-created), so no retry can succeed. It stops on ${UNTIL}, unless the subscriber cancels first.`,
        actions: ['subscriber:cancel'],
    },
    unpaid_unknown: {
        input: subscription({ ...LATE, next_retry_at: RETRY }),
        subscriber:
            'Your wallet refused the payment of 9.99 USDC, so nothing was taken. Check that it still holds 9.99 USDC in USDC and can send it, or Cancel to stop.',
        merchant:
            "Payment late: the network refused the payment for a reason Mesub does not name (for example a frozen USDC account). See the last attempt's reason.",
        actions: ['subscriber:cancel', 'merchant:retry'],
    },
    cancelled_with_access: {
        input: answer({
            status: 'cancelled',
            next_charge_at: null,
            cancelled_at: '2026-10-04T09:00:00.000Z',
        }),
        subscriber: `Cancelled: nothing more will be taken, and you keep access until ${UNTIL}. Resume before then to keep it going.`,
        merchant: `Cancelled on 2026-10-04T09:00:00.000Z: access runs until ${UNTIL}, and nothing more will be taken.`,
        actions: ['subscriber:resume'],
    },
    cancelled_no_access: {
        input: subscription({ status: 'cancelled', payment_status: 'none', ...OVER }),
        subscriber:
            'Cancelled. Your last payment was missed, so you have no access, and Mesub will not collect it; you can close the subscription to get your deposit back.',
        merchant:
            'Cancelled while behind: no access, and Mesub will not collect the missed payment. The subscriber can close it, and must do so before subscribing again.',
        actions: ['subscriber:close'],
    },
    cancelled_ended: {
        input: subscription({ status: 'ended', end_reason: 'cancelled', ...OVER }),
        subscriber:
            'This subscription has ended. Close it to get your deposit back; you need to close it before subscribing to Pro again.',
        merchant:
            "Ended by the subscriber's cancellation. Its subscription account stays open until the subscriber closes it, which they must do before subscribing again.",
        actions: ['subscriber:close'],
    },
    stopped: {
        input: subscription({ status: 'stopped', payment_status: 'none', ...OVER }),
        subscriber:
            "Your subscription stopped after missed payments, and your access has ended; Mesub will not take payments for it again. Its subscription account stays open on your wallet, so the plan's owner could still charge it: Cancel if you are not coming back.",
        merchant:
            "Stopped. Mesub takes nothing more and access is off. The subscription account stays open on chain, and you, as the plan's owner, could still pull from it, until the subscriber cancels and closes it. The subscriber can come back over it.",
        actions: ['subscriber:cancel', 'subscriber:subscribe'],
    },
    paused: {
        input: subscription({ paused: true, payment_status: 'none', next_charge_at: null }),
        subscriber: `Paused by Acme: nothing will be taken, and you keep access until ${UNTIL}.`,
        merchant: `Paused: your project is over its tier's subscriber limit, so Mesub takes nothing from this subscriber. Access runs to the end of the paid period (${UNTIL}). Move back up a tier to restart payments.`,
        actions: ['subscriber:cancel', 'merchant:upgrade'],
    },
    paused_access_over: {
        input: subscription({
            ...LATE,
            ...OVER,
            paused: true,
            late_reason: 'insufficient_balance',
        }),
        subscriber:
            'Paused by Acme: nothing is taken, and your access has ended. If Acme unpauses it, a payment is due at once; Cancel to stop for good.',
        merchant:
            'Paused over your tier limit, and its paid period is over, so access is off. Moving back up a tier makes a payment due at once.',
        actions: ['subscriber:cancel', 'merchant:upgrade'],
    },
    paused_cancelled: {
        input: subscription({ status: 'cancelled', paused: true, next_charge_at: null }),
        subscriber: `Cancelled: nothing more will be taken, and you keep access until ${UNTIL}. You can resume before then, but it stays paused, with no payment, until Acme unpauses it.`,
        merchant: `Cancelled while paused over your tier limit; access until ${UNTIL}.`,
        actions: ['subscriber:resume'],
    },
    ended_closed: {
        input: subscription({ status: 'ended', end_reason: 'closed', ...OVER }),
        subscriber:
            'You closed this subscription, and its deposit is back in your wallet. You can subscribe to Pro again at any time.',
        merchant:
            'Ended: the subscriber closed it and got the deposit back. They can subscribe again.',
        actions: ['subscriber:subscribe'],
    },
    ended_authority_closed: {
        input: subscription({ status: 'ended', end_reason: 'authority_closed', ...OVER }),
        subscriber:
            "This subscription's account was closed outside Mesub, so it has ended and nothing more can be taken. You can subscribe to Pro again.",
        merchant:
            'Ended: its subscription account was found closed on chain, without Mesub. The subscriber can subscribe again.',
        actions: ['subscriber:subscribe'],
    },
    ended_plan_removed: {
        input: subscription({ status: 'ended', end_reason: 'plan_removed', ...OVER }),
        subscriber:
            'Acme removed Pro, so your subscription has ended and nothing more will be taken.',
        merchant:
            "Ended: the plan account was deleted. The subscriber's subscription account may still hold their deposit, and Mesub cannot close it today.",
        actions: [],
    },
    ended_plan_replaced: {
        input: subscription({ status: 'ended', end_reason: 'plan_replaced', ...OVER }),
        subscriber:
            'Acme replaced Pro with another plan, so this subscription has ended and nothing more will be taken.',
        merchant:
            "Ended: another plan now stands at this plan's address, and this subscription was never signed for it.",
        actions: [],
    },
    ended_plan_ended: {
        input: subscription({ status: 'ended', end_reason: 'plan_ended', ...OVER }),
        subscriber:
            'Pro reached its end date, so your subscription has ended and nothing more will be taken.',
        merchant: 'Ended: the plan passed its end date.',
        actions: [],
    },
    ended_unknown: {
        input: subscription({ status: 'ended', ...OVER }),
        subscriber: 'This subscription has ended, and nothing more will be taken.',
        merchant: 'Ended (before Mesub recorded reasons).',
        actions: [],
    },
    pending: {
        input: subscription({ status: 'pending', payment_status: 'none', ...OVER }),
        subscriber:
            'Not signed yet. Approve it in your wallet to pay the first 9.99 USDC and start the subscription.',
        merchant: 'Checkout started, not signed yet: nothing is on chain and nothing was charged.',
        actions: ['merchant:submit'],
    },
    expired: {
        input: subscription({ status: 'expired', payment_status: 'none', ...OVER }),
        subscriber:
            'This checkout was never signed, so nothing was charged. Subscribe again to start.',
        merchant: 'Checkout expired unsigned. Nothing on chain.',
        actions: ['subscriber:subscribe'],
    },
    failed: {
        input: subscription({ status: 'failed', payment_status: 'none', ...OVER }),
        subscriber:
            'This subscription did not start: what reached the network was not the transaction prepared for it. If money left your wallet for it, contact Acme.',
        merchant:
            "Failed: what landed on chain is not what Mesub built (see the submit reason). Check the wallet's transactions before creating a new one.",
        actions: ['merchant:retrieve', 'subscriber:subscribe'],
    },
    superseded: {
        input: subscription({ status: 'superseded', payment_status: 'none', ...OVER }),
        subscriber: 'Replaced by your newer subscription to Pro.',
        merchant:
            'An earlier subscription of this wallet, replaced when it subscribed again. Read the current one.',
        actions: ['merchant:list'],
    },
} satisfies Record<Exclude<SituationKey, 'unknown'>, Case>;

describe('explain', () => {
    it('has a case for every situation of the table', () => {
        expect(Object.keys(CASES).sort()).toEqual(Object.keys(SITUATIONS).sort());
    });

    it.each(Object.entries(CASES))('reads %s, and fills its sentences', (key, c: Case) => {
        const explained = explain(c.input, { names: NAMES, now: NOW });

        expect(situationOf(c.input)).toBe(key);
        expect(explained.key).toBe(key);
        expect(explained.subscriber).toBe(c.subscriber);
        expect(explained.merchant).toBe(c.merchant);
        expect(explained.actions.map((a) => `${a.by}:${a.action}`)).toEqual(c.actions);
        expect(explained.missing).toEqual([]);
        expect(explained.subscriber + explained.merchant).not.toMatch(/[{}[\]]/);
    });

    it('writes the access line beside every sentence', () => {
        expect(explain(subscription()).access).toBe(`Access until ${UNTIL}`);
        expect(explain(subscription({ status: 'stopped', ...OVER })).access).toBe('No access');
    });

    describe('on Free (a retry_deadline set)', () => {
        it.each([
            ['approval_revoked', 'It stops at'],
            ['authority_closed', 'It stops at'],
        ] as const)('says when %s stops by its deadline', (late_reason, stops) => {
            const free = subscription({ ...LATE, ...OVER, late_reason, retry_deadline: DEADLINE });

            expect(explain(free, { names: NAMES }).merchant).toContain(`${stops} ${DEADLINE}`);
            expect(explain(free, { names: NAMES }).missing).toEqual([]);
        });

        it('offers the retry by hand only until the deadline', () => {
            const free = subscription({
                ...LATE,
                ...OVER,
                late_reason: 'insufficient_balance',
                retry_deadline: DEADLINE,
            });
            const before = explain(free, { now: NOW }).actions[0];
            const after = explain(free, { now: new Date(DEADLINE) }).actions;

            expect(before).toEqual({
                by: 'merchant',
                action: 'retry',
                route: 'POST /merchant/subscriptions/:id/retry',
                dashboard: true,
                until: DEADLINE,
            });
            expect(after.map((a) => a.action)).toEqual(['add_funds', 'cancel']);
        });
    });

    it('offers resume until access_until only, with its confirmation', () => {
        const cancelled = subscription({ status: 'cancelled', next_charge_at: null });

        expect(explain(cancelled, { names: NAMES, now: NOW }).actions).toEqual([
            {
                by: 'subscriber',
                action: 'resume',
                sdk: 'subscriptions.resume',
                route: 'POST /v1/subscriptions/:id/resume',
                until: UNTIL,
                confirm: `Resume Pro? Nothing is taken now; your next payment of 9.99 USDC is on ${UNTIL}.`,
            },
        ]);
        expect(explain(cancelled, { now: new Date(UNTIL) }).actions).toEqual([]);
    });

    it.each([
        [subscription(), 'Cancel Pro? Nothing more will be taken, and you keep access until'],
        [subscription({ status: 'stopped', ...OVER }), 'Cancel Pro? Your access ends now'],
        [
            subscription({ status: 'cancelled', ...OVER }),
            'Close Pro? This deletes its subscription account',
        ],
        [
            subscription({ status: 'cancelled', paused: true }),
            'Resume Pro? Nothing is taken now, and nothing will be until Acme unpauses it.',
        ],
    ])('gives the confirmation the action needs', (input, confirm) => {
        expect(explain(input, { names: NAMES, now: NOW }).actions[0]?.confirm).toContain(confirm);
    });

    it('names the plan by its slug, and keeps a placeholder nothing filled', () => {
        const explained = explain(subscription());
        const none = explain(answer({ status: 'none', ...OVER }));

        expect(explained.subscriber).toBe(`Active. Your next payment of {amount} is on ${UNTIL}.`);
        expect(explained.missing).toEqual(['amount']);
        expect(none.subscriber).toBe('You are not subscribed to pro.');
        expect(none.missing).toEqual([]);
    });

    it('writes dates with formatDate when given', () => {
        const explained = explain(subscription(), {
            names: NAMES,
            formatDate: (iso) => iso.slice(0, 10),
        });

        expect(explained.subscriber).toBe(
            'Active. Your next payment of 9.99 USDC is on 2026-11-01.',
        );
        expect(explained.access).toBe('Access until 2026-11-01');
    });

    describe('reads an answer of /v1/access and a subscription alike', () => {
        it('the same situation from both', () => {
            const late = {
                ...LATE,
                late_reason: 'insufficient_balance',
                next_retry_at: RETRY,
            } as const;
            const fromAnswer = explain(answer(late), { names: NAMES });
            const fromSubscription = explain(subscription(late), { names: NAMES });

            expect(fromAnswer.key).toBe('unpaid_insufficient_balance_retries');
            expect(fromAnswer.subscriber).toBe(fromSubscription.subscriber);
        });

        it('leaves out the retry count, which only a subscription carries', () => {
            const late = {
                ...LATE,
                late_reason: 'insufficient_balance',
                next_retry_at: RETRY,
            } as const;

            expect(explain(answer(late), { names: NAMES }).merchant).toContain(
                `Retry on ${RETRY}.`,
            );
            expect(explain(answer(late), { names: NAMES }).missing).toEqual([]);
        });

        it('leaves out cancelled_at, which only an answer carries', () => {
            const cancelled = subscription({ status: 'cancelled', next_charge_at: null });

            expect(explain(cancelled).merchant).toBe(
                `Cancelled: access runs until ${UNTIL}, and nothing more will be taken.`,
            );
        });

        it('reads an answer cached by an older SDK, without paused or retry_deadline', () => {
            const old = answer({
                ...LATE,
                late_reason: 'insufficient_balance',
                next_retry_at: RETRY,
            }) as Partial<AccessAnswer>;
            delete old.paused;
            delete old.retry_deadline;

            expect(explain(old as AccessAnswer).key).toBe('unpaid_insufficient_balance_retries');
        });
    });

    describe('on a plan with an end', () => {
        it('never announces a payment once no charge is ahead', () => {
            const last = explain(answer({ next_charge_at: null, access_until: PLAN_END }), {
                names: NAMES,
            });

            expect(last.key).toBe('active_last_period');
            expect(last.subscriber + last.merchant).not.toMatch(/next payment/i);
            expect(last.access).toBe(`Access until ${PLAN_END}`);
            expect(last.missing).toEqual([]);
        });

        it.each([['approval_revoked'], ['authority_closed'], [null]] as const)(
            'reads a late one no retry is ahead for as its last period (%s)',
            (reason) => {
                const late = { ...LATE, late_reason: reason, access_until: PLAN_END } as const;

                expect(situationOf(answer(late))).toBe('unpaid_last_period');
                expect(situationOf(subscription(late))).toBe('unpaid_last_period');
            },
        );

        it('keeps a late one with a retry ahead as it was', () => {
            const late = {
                ...LATE,
                late_reason: 'insufficient_balance',
                next_retry_at: RETRY,
                access_until: PLAN_END,
            } as const;

            expect(situationOf(answer(late))).toBe('unpaid_insufficient_balance_retries');
        });

        // The minutes between the plan's end and the job that ends the row.
        it.each([
            ['active', { status: 'active' }],
            ['unpaid', { ...LATE, late_reason: 'insufficient_balance' }],
        ] as const)('reads %s with no access as ended, never as paying', (_, over) => {
            const explained = explain(answer({ ...over, ...OVER }), { names: NAMES });

            expect(explained.key).toBe('ended_plan_ended');
            expect(explained.subscriber).toBe(
                'Pro reached its end date, so your subscription has ended and nothing more will be taken.',
            );
            expect(explained.access).toBe('No access');
            expect(explained.actions).toEqual([]);
            expect(situationOf(subscription({ ...over, ...OVER }))).toBe('ended_plan_ended');
        });

        it('reads a paid up cancellation the end cut short as ended, not as behind', () => {
            const cut = subscription({ status: 'cancelled', ...OVER });

            expect(situationOf(cut)).toBe('cancelled_ended');
            expect(explain(cut, { names: NAMES }).subscriber).not.toMatch(/missed/);
        });

        it('keeps a late Free one, whose access is off before any end, as it was', () => {
            const free = answer({
                ...LATE,
                ...OVER,
                late_reason: 'insufficient_balance',
                retry_deadline: PLAN_END,
            });

            expect(situationOf(free)).toBe('unpaid_insufficient_balance_free');
        });

        // Late on a tier that retries, then moved down to Free: the retry is still dated.
        it('keeps a late one without access as late while a retry is dated', () => {
            const late = { ...LATE, ...OVER, late_reason: 'insufficient_balance' } as const;

            expect(situationOf(answer({ ...late, next_retry_at: RETRY }))).toBe(
                'unpaid_insufficient_balance_retries',
            );
        });

        it('keeps an answer with no date at all as active', () => {
            expect(situationOf(answer({ next_charge_at: null, access_until: null }))).toBe(
                'active',
            );
        });
    });

    describe('never throws on what this release does not know', () => {
        it.each([
            ['a status', { status: 'frozen' }],
            ['an end reason', { status: 'ended', end_reason: 'merged', ...OVER }],
            ['a late reason', { ...LATE, late_reason: 'frozen_account' }],
            ['a paused status', { status: 'frozen', paused: true }],
        ])('reads %s it does not know as unknown, with the access line', (_, over) => {
            const input = subscription(over as unknown as Partial<ServerSubscription>);
            const explained = explain(input, { names: NAMES });
            const line = input.access ? `Access until ${UNTIL}` : 'No access';

            expect(explained).toEqual({
                key: 'unknown',
                subscriber: line,
                merchant: line,
                access: line,
                actions: [],
                missing: [],
            });
        });

        it('does not take a reason named like an object key for one it knows', () => {
            const input = subscription({
                status: 'ended',
                end_reason: 'toString' as never,
                ...OVER,
            });

            expect(explain(input).key).toBe('unknown');
        });
    });
});

describe('@mesub/node/situations', () => {
    it('exports what the root exports', () => {
        expect(browser.explain).toBe(explain);
        expect(browser.SITUATIONS).toBe(SITUATIONS);
    });

    // A page loads it: nothing of Node, and no code of the client, may come with it.
    it('imports types only', () => {
        const source = readFileSync(new URL('../src/situations.ts', import.meta.url), 'utf8');
        const imports = source.match(/^import .*$/gm) ?? [];

        expect(imports.length).toBeGreaterThan(0);
        for (const line of imports) expect(line).toMatch(/^import type /);
        expect(source).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b|node:/);
    });
});
