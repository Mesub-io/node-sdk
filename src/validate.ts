import type { AccessAnswer, AccessList, ServedAttempt } from './answer.js';
import { MesubError } from './errors.js';
import type { Plan } from './plans.js';
import type {
    ConfirmResult,
    ServerSubscription,
    ServerSubscriptionList,
    SubmitResult,
    SubscribeTransaction,
    SubscriptionAttempt,
    SubscriptionAttemptList,
    WalletTransaction,
} from './subscriptions.js';
import type {
    CreatedDetail,
    PaymentFailedDetail,
    RenewedDetail,
    StoppedDetail,
    WebhookEvent,
} from './webhooks.js';

/** One field of an answer: how to tell it is right, and what it should have been. */
interface Field {
    check: (value: unknown) => boolean;
    expected: string;
    /**
     * A field newer than some backs still serving: absent, it is set to this
     * value rather than refused, so the answer still holds its type.
     */
    absent?: null | false;
    /** A field the back leaves out when it has nothing to say: absent is fine, as is. */
    optional?: true;
}

const STRING: Field = { check: (value) => typeof value === 'string', expected: 'a string' };
const STRING_OR_NULL: Field = {
    check: (value) => value === null || typeof value === 'string',
    expected: 'a string or null',
};
const OPTIONAL_STRING: Field = { ...STRING, optional: true };
const COUNT: Field = {
    check: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
    expected: 'a whole number',
};
const BOOLEAN: Field = { check: (value) => typeof value === 'boolean', expected: 'a boolean' };
const OBJECT: Field = { check: isObject, expected: 'an object' };
const LIST_OF: Field = { check: Array.isArray, expected: 'a list' };
const DATE: Field = { check: isDate, expected: 'a date' };
const DATE_OR_NULL: Field = {
    check: (value) => value === null || isDate(value),
    expected: 'a date or null',
};
/** `retry_deadline`, served since Mesub-io/backend#191: null when a back predates it. */
const RETRY_DEADLINE: Field = { ...DATE_OR_NULL, absent: null };
/** `paused` and `end_reason`, served since Mesub-io/backend#236: false and null before it. */
const PAUSED: Field = { ...BOOLEAN, absent: false };
const END_REASON: Field = { ...STRING_OR_NULL, absent: null };
/**
 * `next_retry_number`, `retry_number` and `retries_allowed`, served since
 * Mesub-io/backend#289: null when a back predates them.
 */
const RETRY_COUNT: Field = {
    check: (value) => value === null || COUNT.check(value),
    expected: 'a whole number or null',
    absent: null,
};
/**
 * What the cache turns into its dates: NaN or Infinity would never go stale.
 * A negative one is read as 0 there, so it is let through.
 */
const SECONDS: Field = {
    check: (value) => typeof value === 'number' && Number.isFinite(value),
    expected: 'a finite number of seconds',
};

/**
 * Every field of an `AccessAnswer` but `attempts`, which is checked apart: a
 * field added to the type and not here fails to compile. A status, an end
 * reason or an outcome is only checked to be a string, never against the
 * list: one the back adds later must not turn every guard into an error.
 */
const ANSWER = {
    /** Null asked by external id or email, for a customer with nothing on that plan. */
    wallet: STRING_OR_NULL,
    plan: STRING,
    access: BOOLEAN,
    status: STRING,
    paused: PAUSED,
    end_reason: END_REASON,
    payment_status: STRING,
    subscribed_since: DATE_OR_NULL,
    first_subscribed_at: DATE_OR_NULL,
    current_period_end: DATE_OR_NULL,
    cancelled_at: DATE_OR_NULL,
    access_until: DATE_OR_NULL,
    next_charge_at: DATE_OR_NULL,
    next_retry_at: DATE_OR_NULL,
    retry_deadline: RETRY_DEADLINE,
    revalidate_after: SECONDS,
} satisfies Record<Exclude<keyof AccessAnswer, 'attempts'>, Field>;

const ATTEMPT = {
    outcome: STRING,
    reason: STRING_OR_NULL,
    amount: STRING,
    attempted_at: DATE,
    signature: STRING_OR_NULL,
} satisfies Record<keyof ServedAttempt, Field>;

/**
 * What `/v1/access` answered for one plan, checked before anything reads or
 * caches it (#31). Without `revalidate_after` an entry's dates were NaN and it
 * never went stale, `access: true` served for good; a Redis store refused
 * `PX NaN`.
 *
 * Throws a MesubError `unexpected` on any answer of another shape: a wrong
 * `baseUrl` answering JSON, or a back the SDK no longer agrees with. Never
 * cached, so the next call asks again.
 */
export function accessAnswerFrom(body: unknown): AccessAnswer {
    const problem = answerProblem(body);

    if (problem !== null) throw unreadable(problem, body);

    return body as AccessAnswer;
}

/**
 * What `/v1/access` answered without a plan, for `accessList`: a list of
 * answers, each checked like `accessAnswerFrom`'s, and a finite
 * `revalidate_after` for the list itself. Throws and is never cached the same way.
 */
export function accessListFrom(body: unknown): AccessList {
    const problem = problemWith(body, LIST) ?? plansProblem(body);

    if (problem !== null) throw unreadable(problem, body);

    return body as AccessList;
}

const LIST = {
    plans: LIST_OF,
    revalidate_after: SECONDS,
} satisfies Record<keyof AccessList, Field>;

function answerProblem(body: unknown, label?: string): string | null {
    return problemWith(body, ANSWER, label) ?? attemptsProblem(body, label);
}

function plansProblem(body: unknown): string | null {
    const { plans } = body as { plans: unknown[] };

    for (const [index, answer] of plans.entries()) {
        const problem = answerProblem(answer, `plans[${index}]`);

        if (problem !== null) return problem;
    }

    return null;
}

/**
 * Every field of a `ServerSubscription`, as `GET /v1/subscriptions/:id`
 * answers it and as `submit` and `list` embed it. Its status is only checked
 * to be a string, like an access answer's.
 */
const SUBSCRIPTION = {
    id: STRING,
    status: STRING,
    paused: PAUSED,
    end_reason: END_REASON,
    access: BOOLEAN,
    payment_status: STRING,
    plan: STRING_OR_NULL,
    wallet: STRING,
    email: STRING_OR_NULL,
    external_id: STRING_OR_NULL,
    current_period_start: DATE_OR_NULL,
    current_period_end: DATE_OR_NULL,
    next_charge_at: DATE_OR_NULL,
    next_retry_at: DATE_OR_NULL,
    retry_deadline: RETRY_DEADLINE,
    next_retry_number: RETRY_COUNT,
    retries_allowed: RETRY_COUNT,
    access_until: DATE_OR_NULL,
    created_at: DATE,
    confirmed_at: DATE_OR_NULL,
} satisfies Record<keyof ServerSubscription, Field>;

const SUBSCRIPTION_LIST = {
    data: LIST_OF,
    has_more: BOOLEAN,
} satisfies Record<keyof ServerSubscriptionList, Field>;

/** An outcome is only checked to be a string: one the back adds later is handed on. */
const SUBSCRIPTION_ATTEMPT = {
    id: STRING,
    attempted_at: DATE,
    outcome: STRING,
    reason: STRING_OR_NULL,
    amount: STRING,
    signature: STRING_OR_NULL,
    retry: BOOLEAN,
    retry_number: RETRY_COUNT,
    retries_allowed: RETRY_COUNT,
    period_start: DATE_OR_NULL,
} satisfies Record<keyof SubscriptionAttempt, Field>;

const SUBSCRIPTION_ATTEMPT_LIST = {
    data: LIST_OF,
    has_more: BOOLEAN,
    paid: OBJECT,
} satisfies Record<keyof SubscriptionAttemptList, Field>;

/** A sum in base units: digits only, so it can be shown or added without a float. */
const BASE_UNITS: Field = {
    check: (value) => typeof value === 'string' && /^\d+$/.test(value),
    expected: 'a whole number as a string',
};

/** What the front needs to have the wallet sign; the costs are only shown. */
const SUBSCRIBE_TRANSACTION = {
    subscription: OBJECT,
    transaction: STRING,
    last_valid_block_height: STRING,
    costs: OBJECT,
    terms: OBJECT,
} satisfies Record<keyof SubscribeTransaction, Field>;

const PLAN = {
    slug: STRING,
    name: STRING,
    description: STRING_OR_NULL,
    project_name: STRING,
    logo_url: STRING_OR_NULL,
    amount: STRING,
    amount_display: STRING,
    decimals: COUNT,
    symbol: STRING_OR_NULL,
    mint: STRING,
    period_hours: COUNT,
    network: STRING,
    // A string, not one of two: a status added later is handed back, not refused.
    status: STRING,
    available: BOOLEAN,
    ends_at: DATE_OR_NULL,
} satisfies Record<keyof Plan, Field>;

/** One plan, from `plans.retrieve`. */
export function planFrom(body: unknown): Plan {
    const problem = problemWith(body, PLAN);

    if (problem !== null) throw unreadable(problem, body, 'GET /v1/plans/:slug');

    return body as Plan;
}

/** `plans.list`: each plan checked like `retrieve`'s. */
export function planListFrom(body: unknown): Plan[] {
    const problem =
        problemWith(body, { plans: LIST_OF }) ??
        firstProblem((body as { plans: unknown[] }).plans, 'plans', PLAN);

    if (problem !== null) throw unreadable(problem, body, 'GET /v1/plans');

    return (body as { plans: Plan[] }).plans;
}

/** One subscription, from `retrieve`, or read back after a submit. */
export function serverSubscriptionFrom(body: unknown): ServerSubscription {
    const problem = problemWith(body, SUBSCRIPTION);

    if (problem !== null) throw unreadable(problem, body, 'GET /v1/subscriptions/:id');

    return body as ServerSubscription;
}

/** One page of `list`: each subscription checked like `retrieve`'s. */
export function serverSubscriptionListFrom(body: unknown): ServerSubscriptionList {
    const problem =
        problemWith(body, SUBSCRIPTION_LIST) ??
        firstProblem((body as { data: unknown[] }).data, 'data', SUBSCRIPTION);

    if (problem !== null) throw unreadable(problem, body, 'GET /v1/subscriptions');

    return body as ServerSubscriptionList;
}

/** One page of `attempts`: each attempt checked, and the paid total. */
export function subscriptionAttemptListFrom(body: unknown): SubscriptionAttemptList {
    const problem =
        problemWith(body, SUBSCRIPTION_ATTEMPT_LIST) ??
        firstProblem((body as { data: unknown[] }).data, 'data', SUBSCRIPTION_ATTEMPT) ??
        problemWith(
            (body as SubscriptionAttemptList).paid,
            { count: COUNT, amount: BASE_UNITS },
            'paid',
        );

    if (problem !== null) throw unreadable(problem, body, 'GET /v1/subscriptions/:id/attempts');

    return body as SubscriptionAttemptList;
}

/** What `create` answered: what the wallet signs, and the subscription's id. */
export function subscribeTransactionFrom(body: unknown): SubscribeTransaction {
    const problem =
        problemWith(body, SUBSCRIBE_TRANSACTION) ??
        problemWith(
            (body as SubscribeTransaction).subscription,
            { id: STRING, status: STRING },
            'subscription',
        ) ??
        problemWith(
            (body as SubscribeTransaction).terms,
            { message: STRING, expires_at: DATE },
            'terms',
        );

    if (problem !== null) throw unreadable(problem, body, 'POST /v1/subscriptions', 201);

    return body as SubscribeTransaction;
}

/** What `submit` answered: the subscription as it settled, and a reason when one came. */
export function submitResultFrom(body: unknown): SubmitResult {
    return confirmResultFrom(body, 'POST /v1/subscriptions/:id/submit');
}

/** What a confirm of `route` answered: the same shape as `submit`'s. */
export function confirmResultFrom(body: unknown, route: string): ConfirmResult {
    const problem =
        problemWith(body, { subscription: OBJECT }) ??
        problemWith((body as ConfirmResult).subscription, SUBSCRIPTION, 'subscription') ??
        reasonProblem((body as ConfirmResult).reason);

    if (problem !== null) throw unreadable(problem, body, route, 201);

    return body as ConfirmResult;
}

const WALLET_TRANSACTION = {
    transaction: STRING,
    last_valid_block_height: STRING,
} satisfies Record<keyof WalletTransaction, Field>;

/** What `cancel`, `resume` or `close` answered: the transaction the wallet signs and sends. */
export function walletTransactionFrom(body: unknown, route: string): WalletTransaction {
    const problem = problemWith(body, WALLET_TRANSACTION);

    if (problem !== null) throw unreadable(problem, body, route, 201);

    return body as WalletTransaction;
}

function reasonProblem(reason: unknown): string | null {
    return reason === undefined || typeof reason === 'string' ? null : 'reason is not a string';
}

/**
 * A webhook's body (Mesub-io/backend#144): its type, its date, the
 * subscription as `retrieve` answers it, and the event's detail, checked
 * field by field for the types this release knows. A type it does not know
 * is only checked to be a string, like a status: one the back adds later
 * must not turn every delivery into an error.
 */
const WEBHOOK = {
    type: STRING,
    created_at: DATE,
    data: OBJECT,
} satisfies Record<Exclude<keyof WebhookEvent, 'id'>, Field>;

const DETAILS: Partial<Record<string, Record<string, Field>>> = {
    'subscription.created': {
        previous_id: OPTIONAL_STRING,
    } satisfies Record<keyof CreatedDetail, Field>,
    'subscription.renewed': {
        amount: STRING,
        mint: STRING,
        period_start: DATE,
        period_end: DATE,
        signature: STRING,
    } satisfies Record<keyof RenewedDetail, Field>,
    'subscription.payment_failed': {
        reason: STRING,
        amount: STRING,
        mint: STRING,
        period_start: DATE_OR_NULL,
        period_end: DATE_OR_NULL,
        next_retry_at: DATE_OR_NULL,
        retry_deadline: DATE_OR_NULL,
        retries_left: COUNT,
        retry_mode: STRING_OR_NULL,
    } satisfies Record<keyof PaymentFailedDetail, Field>,
    'subscription.stopped': {
        reason: STRING,
    } satisfies Record<keyof StoppedDetail, Field>,
};

/**
 * A webhook whose signature verified, and `id`, its `webhook-id` header.
 * Throws a MesubError `unexpected` on a body of another shape: Mesub signed
 * it, so it is a back this release no longer agrees with.
 */
export function webhookEventFrom(body: unknown, id: string): WebhookEvent {
    const { type, data } = (isObject(body) ? body : {}) as { type: string; data: unknown };
    const { detail } = (isObject(data) ? data : {}) as { detail?: unknown };
    const fields = DETAILS[type];
    const problem =
        problemWith(body, WEBHOOK) ??
        problemWith(data, { ...SUBSCRIPTION, detail: OBJECT }, 'data') ??
        (fields ? problemWith(detail, fields, 'data.detail') : null);

    if (problem !== null) {
        throw new MesubError(`Mesub sent a webhook this SDK cannot read: ${problem}.`, {
            status: null,
            code: 'unexpected',
            body,
        });
    }

    return { ...(body as Omit<WebhookEvent, 'id'>), id } as WebhookEvent;
}

/** The first item of a list that is not of those fields, or null when all are. */
function firstProblem(
    items: unknown[],
    label: string,
    fields: Record<string, Field>,
): string | null {
    for (const [index, item] of items.entries()) {
        const problem = problemWith(item, fields, `${label}[${index}]`);

        if (problem !== null) return problem;
    }

    return null;
}

/**
 * The transport hands back 2xx bodies only: /v1/access and the reads answer
 * 200, the POSTs 201.
 */
function unreadable(
    problem: string,
    body: unknown,
    route = '/v1/access',
    status = 200,
): MesubError {
    return new MesubError(
        `Mesub answered ${route} with an answer this SDK cannot read: ${problem}.`,
        { status, code: 'unexpected', body },
    );
}

/**
 * The first field that is missing or of the wrong type, or null when all are
 * right. A missing field with an `absent` value is set to it on the body,
 * which is the answer just parsed, never one the caller handed in.
 */
function problemWith(body: unknown, fields: Record<string, Field>, label?: string): string | null {
    if (!isObject(body)) {
        return `${label ?? 'the body'} is not an object`;
    }

    const prefix = label === undefined ? '' : `${label}.`;

    for (const [name, field] of Object.entries(fields)) {
        const value = (body as Record<string, unknown>)[name];

        if (value === undefined && field.optional) continue;
        if (value === undefined && 'absent' in field) {
            (body as Record<string, unknown>)[name] = field.absent;
            continue;
        }
        if (value === undefined) return `${prefix}${name} is missing`;
        if (!field.check(value)) return `${prefix}${name} is not ${field.expected}`;
    }

    return null;
}

/** `attempts`, only there when asked for: a list of attempts when it is. */
function attemptsProblem(body: unknown, label?: string): string | null {
    const { attempts } = body as { attempts?: unknown };
    const prefix = label === undefined ? '' : `${label}.`;

    if (attempts === undefined) return null;
    if (!Array.isArray(attempts)) return `${prefix}attempts is not a list`;

    for (const [index, attempt] of attempts.entries()) {
        const problem = problemWith(attempt, ATTEMPT, `${prefix}attempts[${index}]`);

        if (problem !== null) return problem;
    }

    return null;
}

function isDate(value: unknown): boolean {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
