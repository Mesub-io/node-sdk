/**
 * What `GET /v1/access` answers, copied from the back's `AccessAnswer`, which
 * stays the source of truth. The contract test of #8 checks the two agree.
 * Snake case, as the API serves it.
 */

/**
 * `superseded` is a stopped subscription the wallet came back over
 * (Mesub-io/backend#213): the row that replaced it is the one in force, so
 * `/v1/access` answers that one, but the back's type allows it.
 *
 * `cancelled` only while the cancellation runs: once its end date passed it
 * reads `ended`, with `end_reason` `cancelled` (Mesub-io/backend#236).
 *
 * For a few minutes past a plan's end, `active` or `unpaid` is still read
 * with `access` false, until Mesub ends the row: a guard reads `access`.
 */
export type SubscriptionStatus =
    | 'pending'
    | 'active'
    | 'cancelled'
    | 'unpaid'
    | 'stopped'
    | 'ended'
    | 'failed'
    | 'superseded'
    | 'none';

/** `late` only while a pull failed and a retry is pending. */
export type PaymentStatus = 'paid' | 'late' | 'none';

/**
 * Why a subscription ended (Mesub-io/backend#236): cancelled and past its end
 * date, the plan deleted, replaced by another at its address or past its own
 * end, the wallet's authorisation closed without Mesub or through it.
 */
export type EndReason =
    'cancelled' | 'plan_removed' | 'plan_replaced' | 'plan_ended' | 'authority_closed' | 'closed';

/**
 * Why a payment is late (Mesub-io/backend#264), as the last failed pull found
 * it: the wallet holds too little (adding funds fixes it), Mesub's approval on
 * the token account was revoked or replaced by another app's (adding funds
 * does not fix it), or the wallet's authorisation was closed, which is final.
 */
export type LateReason = 'insufficient_balance' | 'approval_revoked' | 'authority_closed';

/**
 * `blocked` is a pull nothing was tried for, none of it the subscriber's
 * doing (Mesub's fee payer, the network): it never counts against them.
 */
export type PullOutcome = 'paid' | 'skipped' | 'rejected' | 'blocked';

/** One pull attempt, newest first, as the subscriber it concerns may see it. */
export interface ServedAttempt {
    outcome: PullOutcome;
    reason: string | null;
    /** In the mint's smallest unit, as a string: a u64 does not survive JSON. */
    amount: string;
    attempted_at: string;
    signature: string | null;
}

export interface AccessAnswer {
    /**
     * The wallet the answer is about. Asked by external id or email, the one
     * that pays, and null when the customer has nothing on this plan.
     */
    wallet: string | null;
    plan: string;
    /**
     * The only field a guard needs. False from the plan's end on, for a plan
     * that has one, whatever `status` still reads.
     */
    access: boolean;
    status: SubscriptionStatus;
    /**
     * A seat parked over the project's cap (Mesub-io/backend#236): `status`
     * stays as it was, nothing is charged, and access runs to the end of the
     * paid period. Read as false from a back that predates it.
     */
    paused: boolean;
    /**
     * Why it ended, only when `status` is `ended`; null on one that ended
     * before the back recorded reasons. Read as null from a back that
     * predates it.
     */
    end_reason: EndReason | null;
    /** Why it is late, only when `status` is `unpaid`; null on a refusal Mesub cannot place. */
    late_reason: LateReason | null;
    /** `none` on a paused seat: nothing is billed, so nothing is late. */
    payment_status: PaymentStatus;
    subscribed_since: string | null;
    first_subscribed_at: string | null;
    current_period_end: string | null;
    cancelled_at: string | null;
    /**
     * When access ends unless a pull renews it; null while `access` is false.
     * Never later than the plan's end, where access stops for everyone, the
     * last period being charged in full all the same.
     */
    access_until: string | null;
    /**
     * A pull Mesub will run: the next charge, or the next retry on a late
     * one, never both. Neither once the plan's end leaves no pull to run
     * (Mesub-io/backend#362): the last period has no `next_charge_at`.
     */
    next_charge_at: string | null;
    next_retry_at: string | null;
    /**
     * Free only (Mesub-io/backend#191): when hand retries of a missed pull
     * close, two minutes before the end of its period, or the plan's end
     * when that comes first; past it the subscription stops. Null on every
     * other tier, whose retries are in `next_retry_at`. Read as null from a
     * back that predates it. Like
     * `paused` and `end_reason`, undefined only on an answer cached by an
     * older SDK.
     */
    retry_deadline: string | null;
    /** Only when asked for with `{ attempts: true }`. */
    attempts?: ServedAttempt[];
    /** Seconds this answer stays true: how long it is cached. */
    revalidate_after: number;
}

/**
 * Every plan of the project a customer has, when no plan is named: what
 * `accessList` answers. Plans they never subscribed to are left out.
 */
export interface AccessList {
    plans: AccessAnswer[];
    /** The soonest of the plans', so one cached list goes stale with its first. */
    revalidate_after: number;
}

/**
 * Who an access question is about: exactly one of the wallet that pays, your
 * own id for the customer (the `external_id` given at checkout), or the email
 * given at checkout. A string alone is a wallet, as before.
 */
export type Customer = { wallet: string } | { external_id: string } | { email: string };

export interface AccessOptions {
    /** Also answer the last pull attempts. Skips the cache both ways. */
    attempts?: boolean;
}
