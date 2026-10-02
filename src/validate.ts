import type { AccessAnswer, AccessList, ServedAttempt } from './answer.js';
import { MesubError } from './errors.js';

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

    if (problem !== null) throw unreadable(problem);

    return body as AccessAnswer;
}

/**
 * What `/v1/access` answered without a plan, for `accessList`: a list of
 * answers, each checked like `accessAnswerFrom`'s, and a finite
 * `revalidate_after` for the list itself. Throws and is never cached the same way.
 */
export function accessListFrom(body: unknown): AccessList {
    const problem = problemWith(body, LIST) ?? plansProblem(body);

    if (problem !== null) throw unreadable(problem);

    return body as AccessList;
}

const LIST = {
    plans: { check: Array.isArray, expected: 'a list' },
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

/** The transport hands back 2xx bodies only, and /v1/access answers 200. */
function unreadable(problem: string): MesubError {
    return new MesubError(
        `Mesub answered /v1/access with an answer this SDK cannot read: ${problem}.`,
        { status: 200, code: 'unexpected' },
    );
}

/** The first field that is missing or of the wrong type, or null when all are right. */
function problemWith(body: unknown, fields: Record<string, Field>, label?: string): string | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
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
