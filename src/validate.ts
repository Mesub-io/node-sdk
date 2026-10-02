import type { AccessAnswer, AccessList, ServedAttempt } from './answer.js';
import { MesubError } from './errors.js';
import type {
    ServerSubscription,
    ServerSubscriptionList,
    SubmitResult,
    SubscribeTransaction,
} from './subscriptions.js';

/** One field of an answer: how to tell it is right, and what it should have been. */
interface Field {
    check: (value: unknown) => boolean;
    expected: string;
}

const STRING: Field = { check: (value) => typeof value === 'string', expected: 'a string' };
const STRING_OR_NULL: Field = {
    check: (value) => value === null || typeof value === 'string',
    expected: 'a string or null',
};
const BOOLEAN: Field = { check: (value) => typeof value === 'boolean', expected: 'a boolean' };
const OBJECT: Field = { check: isObject, expected: 'an object' };
const LIST_OF: Field = { check: Array.isArray, expected: 'a list' };
const DATE: Field = { check: isDate, expected: 'a date' };
const DATE_OR_NULL: Field = {
    check: (value) => value === null || isDate(value),
    expected: 'a date or null',
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
 * field added to the type and not here fails to compile. A status or an
 * outcome is only checked to be a string, never against the list: one the
 * back adds later must not turn every guard into an error.
 */
const ANSWER = {
    /** Null asked by external id or email, for a customer with nothing on that plan. */
    wallet: STRING_OR_NULL,
    plan: STRING,
    access: BOOLEAN,
    status: STRING,
    payment_status: STRING,
    subscribed_since: DATE_OR_NULL,
    first_subscribed_at: DATE_OR_NULL,
    current_period_end: DATE_OR_NULL,
    cancelled_at: DATE_OR_NULL,
    access_until: DATE_OR_NULL,
    next_charge_at: DATE_OR_NULL,
    next_retry_at: DATE_OR_NULL,
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
    access_until: DATE_OR_NULL,
    created_at: DATE,
    confirmed_at: DATE_OR_NULL,
} satisfies Record<keyof ServerSubscription, Field>;

const SUBSCRIPTION_LIST = {
    data: LIST_OF,
    has_more: BOOLEAN,
} satisfies Record<keyof ServerSubscriptionList, Field>;

/** What the front needs to have the wallet sign; the costs are only shown. */
const SUBSCRIBE_TRANSACTION = {
    subscription: OBJECT,
    transaction: STRING,
    last_valid_block_height: STRING,
    costs: OBJECT,
    terms: OBJECT,
} satisfies Record<keyof SubscribeTransaction, Field>;

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
    const problem =
        problemWith(body, { subscription: OBJECT }) ??
        problemWith((body as SubmitResult).subscription, SUBSCRIPTION, 'subscription') ??
        reasonProblem((body as SubmitResult).reason);

    if (problem !== null) {
        throw unreadable(problem, body, 'POST /v1/subscriptions/:id/submit', 201);
    }

    return body as SubmitResult;
}

function reasonProblem(reason: unknown): string | null {
    return reason === undefined || typeof reason === 'string' ? null : 'reason is not a string';
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

/** The first field that is missing or of the wrong type, or null when all are right. */
function problemWith(body: unknown, fields: Record<string, Field>, label?: string): string | null {
    if (!isObject(body)) {
        return `${label ?? 'the body'} is not an object`;
    }

    const prefix = label === undefined ? '' : `${label}.`;

    for (const [name, field] of Object.entries(fields)) {
        const value = (body as Record<string, unknown>)[name];

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
