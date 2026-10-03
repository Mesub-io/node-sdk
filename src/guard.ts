import type { AccessAnswer, Customer } from './answer.js';
import { type Decision, Mesub } from './client.js';
import { type Asked, customerOf } from './customer.js';

/** Why a request was turned away, and what it answers by default. */
export type DenialReason = 'unauthenticated' | 'no_access' | 'unavailable';

export type GuardOutcome =
    | { allowed: true; customer: Asked; plan: string; decision: Decision }
    | { allowed: false; reason: DenialReason; decision?: Decision };

/** Who is asking and what Mesub answered, as a guarded route receives it. */
export interface MesubAccess {
    /**
     * The wallet that pays. Asked by external id or email, the one Mesub
     * answered with; null when the answer is the outage fallback's and holds none.
     */
    wallet: string | null;
    /** Who Mesub was asked about: a wallet, your own id for them, or their email. */
    customer: Asked;
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

/**
 * Each plan a guard asks about is one call to `/v1/access`, made for every
 * request, against the key's 1000 calls a minute. Three is what a Dev
 * project can hold; a list longer than that is more likely built from the
 * request than written by hand.
 */
const MAX_PLANS = 3;

function checkedPlans(value: unknown): string[] {
    const plans: unknown[] =
        typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];

    if (plans.length === 0 || !plans.every((plan) => typeof plan === 'string' && plan !== '')) {
        throw new TypeError('A guard needs a plan, or a list of plans, as non-empty strings.');
    }

    const unique = [...new Set(plans as string[])];

    if (unique.length > MAX_PLANS) {
        throw new TypeError(
            `A guard asks about ${MAX_PLANS} plans at most: each one is a call to Mesub on every request.`,
        );
    }

    return unique;
}

/**
 * Who is asking, from your own auth: `(req) => ({ external_id: req.user.id })`,
 * a wallet, or an email. Null or undefined when nobody is signed in, a 401.
 * May be async.
 *
 * It must come from a session you verified, never from the request itself (a
 * query, a body, a header the caller writes): whoever names a subscriber
 * would get their access.
 */
export type CustomerOption<Req> = (
    request: Req,
) => Customer | string | null | undefined | Promise<Customer | string | null | undefined>;

/** Checked when the guard is built: without `customer` it could not tell who is asking. */
export function checkCustomer<Req>(options: { customer: CustomerOption<Req> }): void {
    if (typeof options?.customer !== 'function') {
        throw new TypeError(
            'A guard needs `customer`: a function of the request returning who is signed in, ' +
                'e.g. `(req) => ({ external_id: req.user.id })`.',
        );
    }
}

/**
 * Who is asking, as `customer` names them, or null for nobody.
 *
 * A `customer` that returns something Mesub cannot be asked about (two
 * identifiers, an empty one, not a string) is a broken integration: thrown.
 */
export async function askerOf<Req>(
    request: Req,
    customer: CustomerOption<Req>,
): Promise<Asked | null> {
    const named = await customer(request);

    if (named === null || named === undefined) return null;

    const asked = customerOf(named);

    if (asked.value === '') {
        throw new TypeError(
            '`customer` returned an empty value: return null when nobody is signed in.',
        );
    }

    return asked;
}

/** The customer as `decide` takes it. */
function asCustomer(asked: Asked): Customer | string {
    if (asked.kind === 'wallet') return asked.value;

    return asked.kind === 'email' ? { email: asked.value } : { external_id: asked.value };
}

/**
 * The one decision the middlewares make: who is asking, from `askerOf`, then
 * whether they have access to one of the plans.
 *
 * - nobody is asking (`customer` returned null): `unauthenticated`
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
 *
 * `plansFor` runs only once somebody is identified: a plan worked out from
 * the request never runs, nor throws, for an anonymous one.
 */
export async function guard(
    client: Mesub,
    asked: Asked | null,
    plansFor: () => readonly string[],
): Promise<GuardOutcome> {
    if (!asked) return { allowed: false, reason: 'unauthenticated' };

    const plans = plansFor();
    const customer = asCustomer(asked);
    const pending = plans.map((plan) => client.decide(customer, plan));

    // The ones not read, once a plan before them grants, must not reject unhandled.
    for (const decision of pending) decision.catch(() => undefined);

    let first: Decision | undefined;
    let unavailable: Decision | undefined;

    for (const [index, next] of pending.entries()) {
        const decision = await next;

        if (decision.access) {
            return { allowed: true, customer: asked, plan: plans[index]!, decision };
        }

        first ??= decision;
        // Mesub failed or did not answer within the budget, and nothing was
        // cached for that customer and plan: not a no, an outage.
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
    const { customer } = outcome;

    return {
        wallet:
            customer.kind === 'wallet' ? customer.value : (outcome.decision.answer?.wallet ?? null),
        customer,
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
