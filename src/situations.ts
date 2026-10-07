/**
 * One sentence per subscription situation, for the subscriber and for the
 * merchant, and what each of them can do about it: the canonical wording of
 * 2026-10-05, agreed with the backend. Show these instead of writing your
 * own: hand-written ones drift, and some are false ("add funds" on a removed
 * approval, "nothing more is charged" on a stopped subscription).
 *
 * Browser-safe: this module imports types only, so `@mesub/node/situations`
 * loads in a page, a widget or a docs site with nothing of Node.
 *
 * Templates carry `{placeholders}`. A `[segment]` holds a placeholder `/v1`
 * does not always serve: it is shown when every placeholder in it has a
 * value, and left out otherwise, so the sentence stays true without it.
 */
import type { AccessAnswer, EndReason, LateReason } from './answer.js';
import type { ServerSubscription } from './subscriptions.js';

/** Who acts. */
export type SituationActor = 'subscriber' | 'merchant';

/**
 * What can be done. `add_funds` has no route (the wallet does it). `retry` is
 * the subscriber's "Pay now" with the API key (`subscriptions.retry`,
 * Mesub-io/backend#354), and the merchant's on the Mesub dashboard; `upgrade`
 * exists on the dashboard only.
 */
export type SituationActionId =
    | 'subscribe'
    | 'submit'
    | 'cancel'
    | 'resume'
    | 'close'
    | 'add_funds'
    | 'retry'
    | 'upgrade'
    | 'retrieve'
    | 'list';

/** One action of a situation, as the table lists it. */
export interface SituationActionTemplate {
    readonly by: SituationActor;
    readonly action: SituationActionId;
    /** The method of `@mesub/node`, when there is one: `subscriptions.cancel`, … */
    readonly sdk?: string;
    /** The API route behind it. */
    readonly route?: string;
    /** On the Mesub dashboard only: an API key cannot call it. */
    readonly dashboard?: true;
    /** The sentence to show before the subscriber signs it, a key of `CONFIRMATIONS`. */
    readonly confirm?: ConfirmationKey;
    /** Only while the date in this field of the subscription is ahead. */
    readonly until?: 'access_until' | 'retry_deadline';
}

/**
 * A sentence, or one per tier where the canonical sentence names both:
 * `retries` for Dev and Business (Mesub retries on its own), `free` for Free
 * (hand retries until `retry_deadline`).
 */
export type SituationText = string | { readonly retries: string; readonly free: string };

export interface Situation {
    readonly subscriber: SituationText;
    readonly merchant: SituationText;
    readonly actions: readonly SituationActionTemplate[];
}

const SUBSCRIBE = {
    by: 'subscriber',
    action: 'subscribe',
    sdk: 'subscriptions.create',
    route: 'POST /v1/subscriptions',
} as const;
const CANCEL = {
    by: 'subscriber',
    action: 'cancel',
    sdk: 'subscriptions.cancel',
    route: 'POST /v1/subscriptions/:id/cancel',
} as const;
const RESUME = {
    by: 'subscriber',
    action: 'resume',
    sdk: 'subscriptions.resume',
    route: 'POST /v1/subscriptions/:id/resume',
    until: 'access_until',
} as const;
const CLOSE = {
    by: 'subscriber',
    action: 'close',
    sdk: 'subscriptions.close',
    route: 'POST /v1/subscriptions/:id/close',
    confirm: 'confirm_close',
} as const;
const ADD_FUNDS = { by: 'subscriber', action: 'add_funds' } as const;
/** Does not count as a retry, and doubles the wait before the next one. */
const RETRY = {
    by: 'merchant',
    action: 'retry',
    route: 'POST /merchant/subscriptions/:id/retry',
    dashboard: true,
} as const;
/**
 * The subscriber's own, shown as "Pay now" (Mesub-io/backend#354): the same
 * rules as the merchant's, nothing to sign, and refused first when it cannot
 * succeed (a short wallet, an approval gone), so no retry is spent for nothing.
 */
const PAY_NOW = {
    by: 'subscriber',
    action: 'retry',
    sdk: 'subscriptions.retry',
    route: 'POST /v1/subscriptions/:id/retry',
} as const;
const UPGRADE = {
    by: 'merchant',
    action: 'upgrade',
    route: 'POST /projects/:id/upgrade',
    dashboard: true,
} as const;
const CANCEL_PAID = { ...CANCEL, confirm: 'confirm_cancel_paid' } as const;
const CANCEL_BEHIND = { ...CANCEL, confirm: 'confirm_cancel_behind' } as const;

/**
 * The canonical table, by situation key. The renewal checks
 * (`active_renewal_*`) are left out: Mesub serves them on its dashboard
 * only, never on `/v1`.
 */
export const SITUATIONS = {
    // Running
    none: {
        subscriber: 'You are not subscribed to {plan_name}.',
        merchant: 'This customer has no subscription to {plan_name}.',
        actions: [SUBSCRIBE],
    },
    active: {
        subscriber: 'Active. Your next payment of {amount} is on {next_charge_at}.',
        merchant: 'Active and paid up. Next payment of {amount} on {next_charge_at}.',
        actions: [CANCEL_PAID],
    },
    // The plan ends before another charge: the last period, paid in full.
    active_last_period: {
        subscriber:
            'Active until {access_until}: {plan_name} is ending, and no further payment will be taken.',
        merchant:
            'Active and paid up, in its last period: the plan is ending, so no further payment is taken. Access ends on {access_until}.',
        actions: [CANCEL_PAID],
    },
    active_unbilled: {
        subscriber: 'Active until {access_until}. No further payment is scheduled.',
        merchant:
            "Not billed: this subscription's terms were never signed through Mesub, so Mesub never takes a payment for it. Access ends on {access_until}.",
        actions: [],
    },

    // Late (`unpaid`)
    // The plan ends before the next retry: none is scheduled, whatever the reason.
    unpaid_last_period: {
        subscriber:
            'Your payment of {amount} is late, and Mesub will not try again on its own: {plan_name} is ending. You keep access until {access_until}.',
        merchant:
            'Payment late, with no retry ahead: the plan ends before the next one. Access continues until {access_until}, and the subscription ends with the plan.',
        actions: [PAY_NOW, CANCEL_BEHIND, RETRY],
    },
    unpaid_insufficient_balance_retries: {
        subscriber:
            'Your payment of {amount} is late because your wallet held too little, and nothing was taken. Add {amount} to your wallet, then pay it now, with nothing to sign; otherwise Mesub tries again on {next_retry_at}. Your subscription stops if no payment goes through by {access_until}.',
        merchant:
            "Payment late: the wallet was short. Retry[ {next_retry_number} of {retries_allowed}] on {next_retry_at}, or sooner by hand, yours or the subscriber's. Access continues until {access_until}; the subscription stops then if every retry fails.",
        actions: [ADD_FUNDS, PAY_NOW, CANCEL_BEHIND, RETRY],
    },
    unpaid_insufficient_balance_free: {
        subscriber:
            'Your payment of {amount} is late because your wallet held too little, so your access is off. Add {amount} to your wallet, then pay it now, with nothing to sign, before {retry_deadline}; if no payment goes through by then, the subscription stops.',
        merchant:
            'Payment late: the wallet was short. On Free, Mesub does not retry on its own: you or the subscriber can retry by hand, up to 3 times between you, 10 minutes apart, until {retry_deadline}. Access is off meanwhile, and it stops after that.',
        actions: [
            ADD_FUNDS,
            { ...PAY_NOW, until: 'retry_deadline' },
            CANCEL_BEHIND,
            { ...RETRY, until: 'retry_deadline' },
        ],
    },
    unpaid_approval_revoked: {
        subscriber:
            "Mesub could not take your payment of {amount}: your wallet no longer approves it (the approval was removed, or replaced by another app's). Adding funds will not fix this, and removing the approval did not cancel the subscription: Cancel it if you want to stop.",
        merchant: {
            retries:
                "Payment late: the subscriber's wallet no longer approves Mesub (removed in the wallet, or replaced by another app's approval). Every retry fails until it is back, and no Mesub route restores it today. It stops on {access_until}.",
            free: "Payment late: the subscriber's wallet no longer approves Mesub (removed in the wallet, or replaced by another app's approval). Every retry fails until it is back, and no Mesub route restores it today. It stops at {retry_deadline}.",
        },
        // A retry by hand is accepted by the dashboard but fails, and the
        // subscriber's is refused (`retry_cannot_succeed`): neither is offered.
        actions: [CANCEL_BEHIND],
    },
    unpaid_authority_closed: {
        subscriber:
            "Mesub can no longer take payments for this subscription: your wallet's approval for {token} was closed for good, so adding funds will not help. Cancel it, then close it once its period ends if you want to subscribe again.",
        merchant: {
            retries:
                "Payment late, for good: the subscriber's subscription authority for {token} was closed (or re-created), so no retry can succeed. It stops on {access_until}, unless the subscriber cancels first.",
            free: "Payment late, for good: the subscriber's subscription authority for {token} was closed (or re-created), so no retry can succeed. It stops at {retry_deadline}, unless the subscriber cancels first.",
        },
        // Close, then subscribe, come once it is cancelled and its period ended.
        actions: [CANCEL_BEHIND],
    },
    unpaid_unknown: {
        subscriber:
            'Your wallet refused the payment of {amount}, so nothing was taken. Check that it still holds {amount} in {token} and can send it, then pay it now, or Cancel to stop.',
        merchant:
            "Payment late: the network refused the payment for a reason Mesub does not name (for example a frozen {token} account). See the last attempt's reason.",
        actions: [PAY_NOW, CANCEL_BEHIND, RETRY],
    },

    // Cancelled
    cancelled_with_access: {
        subscriber:
            'Cancelled: nothing more will be taken, and you keep access until {access_until}. Resume before then to keep it going.',
        merchant:
            'Cancelled[ on {cancelled_at}]: access runs until {access_until}, and nothing more will be taken.',
        actions: [{ ...RESUME, confirm: 'confirm_resume' }],
    },
    cancelled_no_access: {
        subscriber:
            'Cancelled. Your last payment was missed, so you have no access, and Mesub will not collect it; you can close the subscription[ from {closable_from}] to get your deposit back.',
        merchant:
            'Cancelled while behind[ on {cancelled_at}]: no access, and Mesub will not collect the missed payment. The subscriber can close it[ from {closable_from}], and must do so before subscribing again.',
        // Not resume (refused) and not subscribe (refused until it is closed).
        actions: [CLOSE],
    },
    cancelled_ended: {
        subscriber:
            'This subscription has ended. Close it to get your deposit back; you need to close it before subscribing to {plan_name} again.',
        merchant:
            "Ended by the subscriber's cancellation. Its subscription account stays open until the subscriber closes it, which they must do before subscribing again.",
        actions: [CLOSE],
    },

    // Stopped
    stopped: {
        subscriber:
            "Your subscription stopped after missed payments, and your access has ended; Mesub will not take payments for it again. Its subscription account stays open on your wallet, so the plan's owner could still charge it: Cancel if you are not coming back.",
        // `{stop_cause}`, "retries spent" or "the Free deadline passed", is not served on `/v1`.
        merchant:
            "Stopped[: {stop_cause}]. Mesub takes nothing more and access is off. The subscription account stays open on chain, and you, as the plan's owner, could still pull from it, until the subscriber cancels and closes it. The subscriber can come back over it.",
        // Subscribing again restarts it, while it is not cancelled on chain,
        // the plan's terms are unchanged and the project has a free seat.
        actions: [CANCEL_BEHIND, SUBSCRIBE],
    },

    // Paused
    paused: {
        subscriber:
            'Paused by {merchant_name}: nothing will be taken, and you keep access until {access_until}.',
        merchant:
            "Paused: your project is over its tier's subscriber limit, so Mesub takes nothing from this subscriber. Access runs to the end of the paid period ({access_until}). Move back up a tier to restart payments.",
        actions: [CANCEL_PAID, UPGRADE],
    },
    paused_access_over: {
        subscriber:
            'Paused by {merchant_name}: nothing is taken, and your access has ended. If {merchant_name} unpauses it, a payment is due at once; Cancel to stop for good.',
        merchant:
            'Paused over your tier limit, and its paid period is over, so access is off. Moving back up a tier makes a payment due at once.',
        actions: [CANCEL, UPGRADE],
    },
    paused_cancelled: {
        subscriber:
            'Cancelled: nothing more will be taken, and you keep access until {access_until}. You can resume before then, but it stays paused, with no payment, until {merchant_name} unpauses it.',
        merchant: 'Cancelled while paused over your tier limit; access until {access_until}.',
        actions: [{ ...RESUME, confirm: 'confirm_resume_paused' }],
    },

    // Ended
    ended_closed: {
        subscriber:
            'You closed this subscription, and its deposit is back in your wallet. You can subscribe to {plan_name} again at any time.',
        merchant:
            'Ended: the subscriber closed it and got the deposit back. They can subscribe again.',
        actions: [SUBSCRIBE],
    },
    ended_authority_closed: {
        subscriber:
            "This subscription's account was closed outside Mesub, so it has ended and nothing more can be taken. You can subscribe to {plan_name} again.",
        merchant:
            'Ended: its subscription account was found closed on chain, without Mesub. The subscriber can subscribe again.',
        actions: [SUBSCRIBE],
    },
    ended_plan_removed: {
        subscriber:
            '{merchant_name} removed {plan_name}, so your subscription has ended and nothing more will be taken.',
        merchant:
            "Ended: the plan account was deleted. The subscriber's subscription account may still hold their deposit, and Mesub cannot close it today.",
        actions: [],
    },
    ended_plan_replaced: {
        subscriber:
            '{merchant_name} replaced {plan_name} with another plan, so this subscription has ended and nothing more will be taken.',
        merchant:
            "Ended: another plan now stands at this plan's address, and this subscription was never signed for it.",
        actions: [],
    },
    ended_plan_ended: {
        // `{plan_ends_at}` is the plan's `ends_at`, not on a subscription.
        subscriber:
            '{plan_name} reached its end date[ ({plan_ends_at})], so your subscription has ended and nothing more will be taken.',
        merchant: 'Ended: the plan passed its end date.',
        actions: [],
    },
    ended_unknown: {
        subscriber: 'This subscription has ended, and nothing more will be taken.',
        merchant: 'Ended (before Mesub recorded reasons).',
        actions: [],
    },

    // Checkout and history
    pending: {
        subscriber:
            'Not signed yet. Approve it in your wallet to pay the first {amount} and start the subscription.',
        merchant: 'Checkout started, not signed yet: nothing is on chain and nothing was charged.',
        actions: [
            {
                by: 'merchant',
                action: 'submit',
                sdk: 'subscriptions.submit',
                route: 'POST /v1/subscriptions/:id/submit',
            },
        ],
    },
    expired: {
        subscriber:
            'This checkout was never signed, so nothing was charged. Subscribe again to start.',
        merchant: 'Checkout expired unsigned. Nothing on chain.',
        actions: [SUBSCRIBE],
    },
    failed: {
        subscriber:
            'This subscription did not start: what reached the network was not the transaction prepared for it. If money left your wallet for it, contact {merchant_name}.',
        merchant:
            "Failed: what landed on chain is not what Mesub built (see the submit reason). Check the wallet's transactions before creating a new one.",
        actions: [
            {
                by: 'merchant',
                action: 'retrieve',
                sdk: 'subscriptions.retrieve',
                route: 'GET /v1/subscriptions/:id',
            },
            SUBSCRIBE,
        ],
    },
    superseded: {
        // Hide it from subscribers: the newer row is the one in force.
        subscriber: 'Replaced by your newer subscription to {plan_name}.',
        // `{replaced_at}`, when the newer row was created, is not on this row.
        merchant:
            'An earlier subscription of this wallet, replaced when it subscribed again[ on {replaced_at}]. Read the current one.',
        actions: [
            {
                by: 'merchant',
                action: 'list',
                sdk: 'subscriptions.list',
                route: 'GET /v1/subscriptions',
            },
        ],
    },
} as const satisfies Record<string, Situation>;

/** The sentences to show before the subscriber signs an action. */
export const CONFIRMATIONS = {
    confirm_cancel_paid:
        'Cancel {plan_name}? Nothing more will be taken, and you keep access until {access_until}.',
    confirm_cancel_behind:
        'Cancel {plan_name}? Your access ends now and Mesub will not collect the missed payment; you can close it once the current period ends.',
    confirm_resume:
        'Resume {plan_name}? Nothing is taken now; your next payment of {amount} is on {access_until}.',
    confirm_resume_paused:
        'Resume {plan_name}? Nothing is taken now, and nothing will be until {merchant_name} unpauses it.',
    confirm_close:
        'Close {plan_name}? This deletes its subscription account and returns its deposit to your wallet; you can then subscribe again.',
} as const;

/** Shown beside every sentence, which therefore need not repeat it. */
export const ACCESS_LINE = { granted: 'Access until {access_until}', denied: 'No access' } as const;

export type ConfirmationKey = keyof typeof CONFIRMATIONS;

/**
 * A situation of the table, or `unknown`: a status or a reason newer than
 * this release, whose sentences are the access line, true of any situation.
 */
export type SituationKey = keyof typeof SITUATIONS | 'unknown';

export interface ExplainOptions {
    /** What "now" is, for actions open until a date. Defaults to the clock. */
    now?: Date;
    /** What neither `/v1/access` nor a subscription carries, as you show it. */
    names?: {
        /** `{plan_name}`. Defaults to the plan's slug. */
        plan?: string;
        /** `{merchant_name}`: your name, as subscribers know it. */
        merchant?: string;
        /** `{amount}`: the plan's amount with its symbol, such as `9.99 USDC`. */
        amount?: string;
        /** `{token}`: the plan's token symbol, such as `USDC`. */
        token?: string;
    };
    /**
     * How a date is written. Defaults to the ISO 8601 string as Mesub serves
     * it, the same in every locale: pass your own to show local time.
     */
    formatDate?: (iso: string) => string;
}

export interface ExplainedAction {
    by: SituationActor;
    action: SituationActionId;
    sdk?: string;
    route?: string;
    dashboard?: true;
    /** Until when it can be done, as served (ISO 8601). */
    until?: string;
    /** The sentence to show before the subscriber signs it, filled. */
    confirm?: string;
}

export interface Explanation {
    key: SituationKey;
    /** For the subscriber, filled. */
    subscriber: string;
    /** For the merchant, filled. */
    merchant: string;
    /** "Access until …" or "No access", to show beside either sentence. */
    access: string;
    /** What can be done now, by whom. */
    actions: ExplainedAction[];
    /**
     * Placeholders left as `{name}` in a sentence, since nothing gave them a
     * value: pass them in `options.names`, or check the answer's fields.
     */
    missing: string[];
}

/** What `explain` reads: an answer of `/v1/access` or a subscription. */
export type Explainable = AccessAnswer | ServerSubscription;

const END_REASONS: Record<EndReason, keyof typeof SITUATIONS> = {
    cancelled: 'cancelled_ended',
    closed: 'ended_closed',
    authority_closed: 'ended_authority_closed',
    plan_removed: 'ended_plan_removed',
    plan_replaced: 'ended_plan_replaced',
    plan_ended: 'ended_plan_ended',
};

const LATE_REASONS: Record<Exclude<LateReason, 'insufficient_balance'>, keyof typeof SITUATIONS> = {
    approval_revoked: 'unpaid_approval_revoked',
    authority_closed: 'unpaid_authority_closed',
};

/** A key that is its status, whatever else the answer says. */
const BY_STATUS = new Set(['none', 'pending', 'expired', 'failed', 'superseded']);

/** Free is read as a `retry_deadline` set: `/v1` does not serve the tier. */
function isFree(input: Explainable): boolean {
    return input.retry_deadline != null;
}

/** Billed and running: neither parked nor one Mesub never pulls, which `payment_status` says. */
function isBilled(input: Explainable): boolean {
    return input.payment_status !== 'none';
}

/**
 * Which situation an answer is in, in the canonical order: status first,
 * then paused, then the end or late reason. Never throws: a status or a
 * reason this release does not know is `unknown`.
 *
 * A plan's end is read from what it leaves on the answer, which carries no
 * `ends_at`: access with no charge or retry ahead is the last period, and a
 * running status without access is the minutes between the end and the job
 * that ends the row. That one reads as ended already.
 */
export function situationOf(input: Explainable): SituationKey {
    const status: string = input.status;
    const paused = input.paused === true;

    if (BY_STATUS.has(status)) return status as SituationKey;

    if (paused && (status === 'active' || status === 'unpaid' || status === 'cancelled')) {
        if (status === 'cancelled') return 'paused_cancelled';
        return input.access ? 'paused' : 'paused_access_over';
    }

    switch (status) {
        case 'ended': {
            const reason: string | null = input.end_reason ?? null;
            if (reason === null) return 'ended_unknown';
            return Object.hasOwn(END_REASONS, reason)
                ? END_REASONS[reason as EndReason]
                : 'unknown';
        }
        case 'cancelled':
            if (input.access) return 'cancelled_with_access';
            // Paid up and cut short by the plan's end: it ends as cancelled.
            return input.payment_status === 'paid' ? 'cancelled_ended' : 'cancelled_no_access';
        case 'unpaid': {
            const reason: string | null = input.late_reason ?? null;
            const named = reason !== null && reason !== 'insufficient_balance';
            if (named && !Object.hasOwn(LATE_REASONS, reason)) return 'unknown';
            // On Free a late one has no access and no retry of Mesub's, end or not.
            if (!isFree(input) && isBilled(input) && input.next_retry_at == null) {
                if (!input.access) return 'ended_plan_ended';
                if (input.access_until != null) return 'unpaid_last_period';
            }
            if (reason === null) return 'unpaid_unknown';
            if (reason === 'insufficient_balance') {
                return isFree(input)
                    ? 'unpaid_insufficient_balance_free'
                    : 'unpaid_insufficient_balance_retries';
            }
            return LATE_REASONS[reason as keyof typeof LATE_REASONS];
        }
        case 'active':
            if (!isBilled(input)) return 'active_unbilled';
            if (!input.access) return 'ended_plan_ended';
            return input.access_until != null && input.next_charge_at == null
                ? 'active_last_period'
                : 'active';
        case 'stopped':
            return 'stopped';
        default:
            return 'unknown';
    }
}

/**
 * The situation of a subscription, in words: one sentence for the
 * subscriber, one for the merchant, the access line, and what each can do
 * now. Takes an answer of `/v1/access` or a subscription as `@mesub/node`
 * returns them. Never throws.
 *
 * ```ts
 * const { subscriber, access, actions } = explain(answer, {
 *     names: { plan: 'Pro', merchant: 'Acme', amount: '9.99 USDC', token: 'USDC' },
 * });
 * ```
 */
export function explain(input: Explainable, options: ExplainOptions = {}): Explanation {
    const key = situationOf(input);
    const values = valuesOf(input, options);
    const missing = new Set<string>();
    const fill = (template: string): string => render(template, values, missing);
    const accessLine = fill(input.access ? ACCESS_LINE.granted : ACCESS_LINE.denied);

    if (key === 'unknown') {
        return {
            key,
            subscriber: accessLine,
            merchant: accessLine,
            access: accessLine,
            actions: [],
            missing: [...missing],
        };
    }

    const situation: Situation = SITUATIONS[key];
    const tier = isFree(input) ? 'free' : 'retries';
    const pick = (text: SituationText): string => (typeof text === 'string' ? text : text[tier]);
    const now = (options.now ?? new Date()).getTime();
    const actions: ExplainedAction[] = [];

    for (const template of situation.actions) {
        const { until: field, confirm, ...rest } = template;
        const action: ExplainedAction = { ...rest };

        if (field !== undefined) {
            const until = input[field];
            if (until != null) {
                if (Date.parse(until) <= now) continue;
                action.until = until;
            }
        }
        if (confirm !== undefined) action.confirm = fill(CONFIRMATIONS[confirm]);
        actions.push(action);
    }

    return {
        key,
        subscriber: fill(pick(situation.subscriber)),
        merchant: fill(pick(situation.merchant)),
        access: accessLine,
        actions,
        missing: [...missing],
    };
}

/** Every value a placeholder can take from this answer and these options. */
function valuesOf(input: Explainable, options: ExplainOptions): Record<string, string | undefined> {
    const date = options.formatDate ?? ((iso: string) => iso);
    const asDate = (iso: string | null | undefined) => (iso == null ? undefined : date(iso));
    const asNumber = (n: number | null | undefined) => (n == null ? undefined : String(n));
    const names = options.names ?? {};

    return {
        plan_name: names.plan ?? input.plan ?? undefined,
        merchant_name: names.merchant,
        amount: names.amount,
        token: names.token,
        access_until: asDate(input.access_until),
        next_charge_at: asDate(input.next_charge_at),
        next_retry_at: asDate(input.next_retry_at),
        retry_deadline: asDate(input.retry_deadline),
        // `/v1/access` only.
        cancelled_at: asDate('cancelled_at' in input ? input.cancelled_at : null),
        // On a subscription only.
        next_retry_number: asNumber('next_retry_number' in input ? input.next_retry_number : null),
        retries_allowed: asNumber('retries_allowed' in input ? input.retries_allowed : null),
        // Not served on `/v1` (yet): their segments are left out.
        closable_from: undefined,
        stop_cause: undefined,
        plan_ends_at: undefined,
        replaced_at: undefined,
    };
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Fills a template: a `[segment]` with a placeholder lacking a value is left
 * out, and a placeholder outside one is kept as `{name}` and noted missing.
 */
function render(
    template: string,
    values: Record<string, string | undefined>,
    missing: Set<string>,
): string {
    const segments = template.replace(/\[([^[\]]*)\]/g, (_, segment: string) =>
        [...segment.matchAll(PLACEHOLDER)].every(([, name]) => values[name!] !== undefined)
            ? segment
            : '',
    );

    return segments.replace(PLACEHOLDER, (whole, name: string) => {
        const value = values[name];
        if (value !== undefined) return value;
        missing.add(name);
        return whole;
    });
}
