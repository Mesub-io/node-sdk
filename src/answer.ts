/**
 * What `GET /v1/access` answers, copied from the back's `AccessAnswer`, which
 * stays the source of truth. The contract test of #8 checks the two agree.
 * Snake case, as the API serves it.
 */

export type SubscriptionStatus =
    'pending' | 'active' | 'cancelled' | 'unpaid' | 'stopped' | 'ended' | 'failed' | 'none';

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
    wallet: string;
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
    /** Only when asked for with `{ attempts: true }`. */
    attempts?: ServedAttempt[];
    /** Seconds this answer stays true: how long it is cached. */
    revalidate_after: number;
}

export interface AccessOptions {
    /** Also answer the last pull attempts. Skips the cache both ways. */
    attempts?: boolean;
}
