/**
 * What `GET /v1/access` answers, copied from the back's `AccessAnswer`, which
 * stays the source of truth. The contract test of #8 checks the two agree.
 * Snake case, as the API serves it.
 */

/**
 * `superseded` is a stopped subscription the wallet came back over
 * (Mesub-io/backend#213): the row that replaced it is the one in force, so
 * `/v1/access` answers that one, but the back's type allows it.
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

export type PullOutcome = 'PAID' | 'SKIPPED' | 'REJECTED';

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
    /** The only field a guard needs. */
    access: boolean;
    status: SubscriptionStatus;
    payment_status: PaymentStatus;
    subscribed_since: string | null;
    first_subscribed_at: string | null;
    current_period_end: string | null;
    cancelled_at: string | null;
    access_until: string | null;
    next_charge_at: string | null;
    next_retry_at: string | null;
    /**
     * Free only (Mesub-io/backend#191): when hand retries of a missed pull
     * close, two minutes before the end of its period; past it the
     * subscription stops. Null on every other tier, whose retries are in
     * `next_retry_at`. Read as null from a back that predates it; undefined
     * only on an answer cached by an older SDK.
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
