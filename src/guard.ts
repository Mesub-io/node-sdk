import type { AccessAnswer } from './answer.js';
import { type Decision, Mesub } from './client.js';
import { MesubError } from './errors.js';
import { type HeaderSource, tokenFrom, type VerifiedToken } from './tokens.js';

/** Why a request was turned away, and what it answers by default. */
export type DenialReason = 'unauthenticated' | 'no_access' | 'unavailable';

export type GuardOutcome =
    | { allowed: true; subscriber: VerifiedToken; decision: Decision }
    | { allowed: false; reason: DenialReason; decision?: Decision };

/** Who is asking and what Mesub answered, as a guarded route receives it. */
export interface MesubAccess {
    userId: string;
    wallet: string;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback. */
    stale: boolean;
}

/** A refusal, as `onDenied` receives it. */
export interface Denial {
    reason: DenialReason;
    /** 401, 402 or 503: what would be answered without `onDenied`. */
    status: number;
    answer: AccessAnswer | null;
}

/** What a guard answers by default for each refusal. */
export const DENIAL_STATUS: Record<DenialReason, number> = {
    unauthenticated: 401,
    no_access: 402,
    unavailable: 503,
};

/** Seconds a client should wait before asking again when Mesub is unreachable. */
export const UNAVAILABLE_RETRY_AFTER_S = 30;

let shared: Mesub | undefined;

/** The client a middleware uses when given none: built once, from MESUB_API_KEY. */
export function defaultClient(): Mesub {
    shared ??= new Mesub();

    return shared;
}

/**
 * The one decision both middlewares make: who is asking, from our token, then
 * whether they have access. Never from anything the merchant's code passes.
 *
 * - no token, or one that fails verification: `unauthenticated`
 * - the keys or the project id could not be fetched: `unavailable`, since
 *   nobody can be identified, so not even the outage fallback can apply
 * - the fallback of `hasAccess` otherwise, through `decide`
 *
 * An integration error (a bad API key, an unknown plan) is thrown.
 */
export async function guard(
    client: Mesub,
    headers: HeaderSource,
    plan: string,
): Promise<GuardOutcome> {
    const token = tokenFrom({ headers });

    if (!token) return { allowed: false, reason: 'unauthenticated' };

    let subscriber: VerifiedToken;

    try {
        subscriber = await client.verifyToken(token);
    } catch (error) {
        if (error instanceof MesubError && error.code === 'invalid_token') {
            return { allowed: false, reason: 'unauthenticated' };
        }
        if (error instanceof MesubError && error.code === 'unavailable') {
            return { allowed: false, reason: 'unavailable' };
        }

        throw error;
    }

    const decision = await client.decide(subscriber.wallet, plan);

    return decision.access
        ? { allowed: true, subscriber, decision }
        : { allowed: false, reason: 'no_access', decision };
}

/** The body a refusal answers with. `status` only when there is an answer to read it from. */
export function denialBody(outcome: Extract<GuardOutcome, { allowed: false }>) {
    return {
        access: false,
        reason: outcome.reason,
        ...(outcome.decision?.answer ? { status: outcome.decision.answer.status } : {}),
    };
}

export function accessOf(outcome: Extract<GuardOutcome, { allowed: true }>): MesubAccess {
    return {
        userId: outcome.subscriber.userId,
        wallet: outcome.subscriber.wallet,
        answer: outcome.decision.answer,
        stale: outcome.decision.stale,
    };
}

export function denialOf(outcome: Extract<GuardOutcome, { allowed: false }>): Denial {
    return {
        reason: outcome.reason,
        status: DENIAL_STATUS[outcome.reason],
        answer: outcome.decision?.answer ?? null,
    };
}
