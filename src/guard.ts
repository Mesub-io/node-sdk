import type { AccessAnswer } from './answer.js';
import { type Decision, Mesub } from './client.js';
import { MesubError } from './errors.js';
import { type HeaderSource, tokensFrom, type VerifiedToken } from './tokens.js';

/** Why a request was turned away, and what it answers by default. */
export type DenialReason = 'unauthenticated' | 'no_access' | 'unavailable';

export type GuardOutcome =
    | { allowed: true; subscriber: VerifiedToken; plan: string; decision: Decision }
    | { allowed: false; reason: DenialReason; decision?: Decision };

/** Who is asking and what Mesub answered, as a guarded route receives it. */
export interface MesubAccess {
    userId: string;
    wallet: string;
    /** The plan that let the request through: the first of the list that did. */
    plan: string;
    /** Mesub's answer for that plan. */
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback. */
    stale: boolean;
}

/** A refusal, as `onDenied` receives it. */
export interface Denial {
    reason: DenialReason;
    /** 401, 402 or 503: what would be answered without `onDenied`. */
    status: number;
    /** Mesub's answer, for the first plan asked when there are several. */
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
 * The plan a guard asks about: one, any one of several (the first that grants
 * lets the request through), or either of those worked out per request.
 */
export type PlanOption<Req> =
    string | readonly string[] | ((request: Req) => string | readonly string[]);

/**
 * The plans a guard asks about for that request, in order, each once. A
 * plan that is not a non-empty string, or no plan at all, is a broken
 * integration: thrown, never read as a refusal.
 */
export function plansOf<Req>(plan: PlanOption<Req>, request: Req): string[] {
    return checkedPlans(typeof plan === 'function' ? plan(request) : plan);
}

/**
 * Checks a fixed plan when the guard is built, so a typo fails at start-up
 * rather than on the first request. One worked out per request is checked
 * then, by `plansOf`.
 */
export function checkPlan<Req>(plan: PlanOption<Req>): void {
    if (typeof plan !== 'function') checkedPlans(plan);
}

function checkedPlans(value: unknown): string[] {
    const plans: unknown[] =
        typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];

    if (plans.length === 0 || !plans.every((plan) => typeof plan === 'string' && plan !== '')) {
        throw new TypeError('A guard needs a plan, or a list of plans, as non-empty strings.');
    }

    return [...new Set(plans as string[])];
}

/**
 * Where a guard finds the Mesub access token, when it is not in the bearer or
 * the `mesub-token` cookie: a header of your own, a session. Null or
 * undefined when there is none, a 401.
 */
export type TokenOption<Req> = (request: Req) => string | null | undefined;

/**
 * The tokens a guard tries, in turn: the one `token` returns when given, else
 * the bearer, then the `mesub-token` cookie.
 */
export function tokensOf<Req extends { headers: HeaderSource }>(
    request: Req,
    token?: TokenOption<Req>,
): string[] {
    if (!token) return tokensFrom(request);

    const found = token(request);

    return typeof found === 'string' && found !== '' ? [found] : [];
}

/**
 * The one decision the middlewares make: who is asking, from our token, then
 * whether they have access to one of the plans. Never from anything the
 * merchant's code passes.
 *
 * - no token, or none that verifies: `unauthenticated`. A bearer that is not
 *   a Mesub token (the merchant's own JWT) does not hide the cookie: each
 *   token is tried in turn, the first that verifies is who is asking
 * - the keys or the project id could not be fetched: `unavailable`, since
 *   nobody can be identified, so not even the outage fallback can apply;
 *   no other token is tried then
 * - the fallback of `hasAccess` otherwise, per plan, through `decide`,
 *   within the client's `guardTimeout`. The plans are asked at once, so
 *   several fit the same budget, and read in order: the first that grants
 *   lets the request through, without waiting for the ones after it.
 *   `unavailable` when none grants and Mesub failed (outage, rate limit) or
 *   the budget ran out on one with nothing cached: 402 only ever means
 *   Mesub said no, for every plan
 *
 * An integration error (a bad API key, an unknown plan) is thrown, unless a
 * plan before it in the list already granted.
 */
export async function guard(
    client: Mesub,
    tokens: readonly string[],
    plans: readonly string[],
): Promise<GuardOutcome> {
    let subscriber: VerifiedToken | undefined;

    for (const token of tokens) {
        try {
            subscriber = await client.verifyToken(token);
            break;
        } catch (error) {
            // Not a Mesub token, or not a valid one: maybe the next one is.
            if (error instanceof MesubError && error.code === 'invalid_token') continue;
            if (error instanceof MesubError && error.code === 'unavailable') {
                return { allowed: false, reason: 'unavailable' };
            }

            throw error;
        }
    }

    if (!subscriber) return { allowed: false, reason: 'unauthenticated' };

    const wallet = subscriber.wallet;
    const pending = plans.map((plan) => client.decide(wallet, plan));

    // The ones not read, once a plan before them grants, must not reject unhandled.
    for (const decision of pending) decision.catch(() => undefined);

    let first: Decision | undefined;
    let unavailable: Decision | undefined;

    for (const [index, next] of pending.entries()) {
        const decision = await next;

        if (decision.access) {
            return { allowed: true, subscriber, plan: plans[index]!, decision };
        }

        first ??= decision;
        // Mesub failed or did not answer within the budget, and nothing was
        // cached for that wallet and plan: not a no, an outage.
        if (decision.unavailable) unavailable ??= decision;
    }

    if (unavailable) return { allowed: false, reason: 'unavailable', decision: unavailable };

    return { allowed: false, reason: 'no_access', ...(first ? { decision: first } : {}) };
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
        plan: outcome.plan,
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
