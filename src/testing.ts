/**
 * `@mesub/node/testing`: a fake Mesub, for a merchant's own tests. It answers
 * what the SDK calls (`/v1/access`, `/v1/plans`, `/v1/subscriptions`, its
 * fresh transaction, its attempts and its cancel, resume and close) from
 * what the test sets, through a `fetch` handed to the client: no network, no backend, no test framework of its own.
 *
 * ```ts
 * import { FakeMesub } from '@mesub/node/testing';
 *
 * const fake = new FakeMesub();
 * fake.grant(wallet, 'pro');
 * const mesub = fake.client();
 * await mesub.hasAccess(wallet, 'pro'); // true
 *
 * const { body, headers } = await fake.webhook('subscription.renewed');
 * await mesub.webhooks.verify(body, headers); // the event
 * ```
 */
import type { AccessAnswer, Customer, ServedAttempt } from './answer.js';
import { Mesub, type MesubOptions } from './client.js';
import { type Asked, customerOf } from './customer.js';
import type { Plan, PlanToken } from './plans.js';
import type {
    ServerSubscription,
    ServerSubscriptionList,
    SubscribeTransaction,
    SubscriptionAttempt,
    SubscriptionAttemptList,
    WalletTransaction,
} from './subscriptions.js';
import { signedHeaders, type WebhookEventType } from './webhooks.js';

export interface FakeMesubOptions {
    /** Where the fake answers. Defaults to `https://api.mesub.test`. */
    baseUrl?: string;
    /** The only key it accepts; any other is answered 401. Defaults to `SUB_test_fake`. */
    apiKey?: string;
    /**
     * The plans that exist: any other slug is answered 404 `plan_not_found`.
     * By default every slug exists. A slug alone, or the fields `plans.list`
     * and `plans.retrieve` should answer for it: the rest is filled in.
     * Name them to test the widget routes, which read `plans.list`: left
     * out, the list is empty. A plan given an `ends_at` is served as Mesub
     * serves one: no `access_until` later than it, no pull dated from it
     * on, and no access once it has passed. A plan's token is USDC, verified,
     * and its `amount_usd` its `amount_display`: give a `token` (some of its
     * fields are enough) and an `amount_usd` for any other, such as an
     * unverified one with a null `symbol`.
     */
    plans?: Array<string | FakePlanFields>;
    /** What `webhook()` signs with, and `client()` verifies with. Defaults to a fixed `whsec_` secret. */
    webhookSecret?: string;
    /**
     * False to act as a Mesub that predates
     * `GET /v1/subscriptions/:id/attempts`: it answers Nest's 404 for a route
     * it does not have, and attempts are only served through `/v1/access`.
     */
    attemptsRoute?: boolean;
}

/** A plan as declared to the fake: its slug, and any field to set, a token's included. */
export type FakePlanFields = Partial<Omit<Plan, 'token'>> & {
    slug: string;
    token?: Partial<PlanToken>;
};

/** How many attempts `/v1/access` serves at most. */
const ACCESS_ATTEMPTS = 5;

/** A webhook as Mesub posts it: the exact body, and the three headers that sign it. */
export interface SignedWebhook {
    body: string;
    headers: Record<string, string>;
}

export interface SignWebhookOptions {
    /** The endpoint's secret, `whsec_...`. */
    secret: string;
    /** `webhook-id`. Defaults to a new `msg_fake_...` each time. */
    id?: string;
    /** `webhook-timestamp`, Unix seconds. Defaults to now. */
    timestamp?: number;
}

/** What `FakeMesub.webhook` sends, on top of a made-up event of that type. */
export interface FakeWebhookFields {
    /** Fields of the subscription it carries. Defaults to an active, paid one on `pro`. */
    subscription?: Partial<ServerSubscription>;
    /** The event's detail. Defaults to a plausible one for the type. */
    detail?: Record<string, unknown>;
    /** When the event happened. Defaults to now. */
    created_at?: string;
    id?: string;
    timestamp?: number;
}

/** One call the fake received. */
export interface FakeRequest {
    method: string;
    /** Under the base URL, e.g. `/v1/access`. */
    path: string;
    query: Record<string, string>;
    headers: Headers;
    /** The parsed JSON body of a POST, undefined otherwise. */
    body: unknown;
}

/** An error the fake answers instead, as Mesub would send it. */
export interface FakeFailure {
    status: number;
    /** Mesub's own code, e.g. `network_unavailable`. */
    code: string;
    message?: string;
    /**
     * Defaults to what Mesub says of the code, e.g. true for
     * `subscription_changed`; for a code Mesub does not have, to what the
     * status says: true for 408, 429 and 5xx.
     */
    retryable?: boolean;
    /** Seconds, sent as `Retry-After`. */
    retryAfter?: number;
}

/** What a test may set of an access answer: all but the plan, named apart. */
export type FakeAccess = Partial<Omit<AccessAnswer, 'plan'>>;

/** What Mesub answers a customer with nothing on a plan. */
const NOTHING: Omit<AccessAnswer, 'wallet' | 'plan'> = {
    access: false,
    status: 'none',
    paused: false,
    end_reason: null,
    late_reason: null,
    payment_status: 'none',
    blocked_since: null,
    blocked_reason: null,
    subscribed_since: null,
    first_subscribed_at: null,
    current_period_end: null,
    cancelled_at: null,
    access_until: null,
    next_charge_at: null,
    next_retry_at: null,
    retry_deadline: null,
    // Stale at once, so a change shows on the next call; the outage fallback
    // still keeps it. Set it to test the cache itself.
    revalidate_after: 0,
};

const OUTAGE: FakeFailure = {
    status: 503,
    code: 'unavailable',
    message: 'Mesub is unavailable.',
};

/** 24 bytes, as Mesub's secrets are. Only ever a test's. */
const FAKE_WEBHOOK_SECRET = 'whsec_bWVzdWItZmFrZS13ZWJob29rLWtleS0x';
const FAKE_WALLET = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PERIOD_MS = 30 * 24 * 3600 * 1000;
const REASONS: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
};

/**
 * A fake Mesub API. Each test sets what a customer has with `grant`, `deny`
 * or `setAccess`, gets a client wired to it with `client()`, and makes it
 * fail with `fail()`. A plan with an end is `grantLastPeriod`, `endPlan`, or
 * an `ends_at` in `plans`.
 */
export class FakeMesub {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly webhookSecret: string;
    /** Every call received, oldest first. */
    readonly requests: FakeRequest[] = [];
    /** Hand it to `new Mesub({ fetch })`, or use `client()`. */
    readonly fetch: typeof globalThis.fetch;

    readonly #plans: Set<string> | null;
    readonly #planList: Plan[];
    readonly #answers = new Map<string, AccessAnswer>();
    /** The ends `grantLastPeriod` and `endPlan` gave a plan, by slug: they win over `plans`. */
    readonly #ends = new Map<string, string>();
    #subscriptions: ServerSubscription[] = [];
    /** The subscriptions a cancel, resume or close transaction was built for, by id. */
    readonly #built = new Map<string, Set<FakeAction>>();
    /** The rows ended with their plan whose close landed: nothing of them is left on chain. */
    readonly #gone = new Set<string>();
    /** The attempts `setAttempts` gave each subscription, newest first, by id. */
    readonly #attempts = new Map<string, SubscriptionAttempt[]>();
    readonly #attemptsRoute: boolean;
    #attemptIds = 0;
    #failure: FakeFailure | null = null;
    #ids = 0;

    constructor(options: FakeMesubOptions = {}) {
        this.baseUrl = (options.baseUrl ?? 'https://api.mesub.test').replace(/\/+$/, '');
        this.apiKey = options.apiKey ?? 'SUB_test_fake';
        const plans = options.plans?.map((plan) =>
            typeof plan === 'string' ? fakePlan(plan) : fakePlan(plan.slug, plan),
        );
        this.#plans = plans ? new Set(plans.map((plan) => plan.slug)) : null;
        this.#planList = (plans ?? []).sort((a, b) => a.slug.localeCompare(b.slug));
        this.webhookSecret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
        this.#attemptsRoute = options.attemptsRoute ?? true;
        this.fetch = (input, init) => this.#handle(input, init);
    }

    /**
     * A client wired to this fake: its key, base URL and fetch, and no retry
     * unless asked, so a failure shows at once. Any other option is passed on.
     */
    client(
        options: Omit<MesubOptions, 'apiKey' | 'baseUrl' | 'fetch' | 'webhookSecret'> = {},
    ): Mesub {
        return new Mesub({
            maxRetries: 0,
            ...options,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            fetch: this.fetch,
            webhookSecret: this.webhookSecret,
        });
    }

    /**
     * That customer has access to that plan: active and paid, unless `fields`
     * say otherwise. The customer is named as `access` names them, and only
     * that way answers: a wallet granted is not found by its external id.
     */
    grant(customer: Customer | string, plan: string, fields: FakeAccess = {}): AccessAnswer {
        return this.setAccess(customer, plan, {
            access: true,
            status: 'active',
            payment_status: 'paid',
            ...fields,
        });
    }

    /** That customer has no access to that plan: `status` says why, `none` by default. */
    deny(customer: Customer | string, plan: string, fields: FakeAccess = {}): AccessAnswer {
        return this.setAccess(customer, plan, { ...fields, access: false });
    }

    /**
     * That customer is in the last period of a plan that ends at `endsAt`:
     * active and paid, access until the end and no charge ahead, unless
     * `fields` say otherwise. The plan gets that `ends_at`, and from then on
     * the fake refuses everyone on it, as Mesub does, whatever `status` reads.
     */
    grantLastPeriod(
        customer: Customer | string,
        plan: string,
        endsAt: string | Date,
        fields: FakeAccess = {},
    ): AccessAnswer {
        const end = new Date(endsAt).toISOString();

        this.#ends.set(plan, end);
        return this.grant(customer, plan, { access_until: end, ...fields });
    }

    /**
     * That plan reached its end, at `at` or now: it takes nobody new, and
     * what the fake holds on it is ended as Mesub ends it, `plan_ended` for a
     * running or late one, `cancelled` for one that had cancelled. Before
     * this is called, a plan past its `ends_at` already refuses everyone,
     * with `status` unchanged: the minutes Mesub takes to end the rows.
     */
    endPlan(plan: string, at: string | Date = new Date()): void {
        this.#ends.set(plan, new Date(at).toISOString());

        for (const [key, answer] of this.#answers) {
            if (answer.plan === plan) this.#answers.set(key, { ...answer, ...endedBy(answer) });
        }
        for (const subscription of this.#subscriptions) {
            if (subscription.plan !== plan) continue;
            const ended = endedBy(subscription);
            Object.assign(subscription, ended, 'status' in ended && NO_RETRY);
        }
    }

    /**
     * What `/v1/access` answers that customer on that plan, on top of the
     * answer for a customer with nothing. `wallet` defaults to the wallet
     * asked about, and to null for an external id or an email.
     */
    setAccess(customer: Customer | string, plan: string, fields: FakeAccess): AccessAnswer {
        const asked = customerOf(customer);
        const answer: AccessAnswer = { ...nothing(asked, plan), ...fields, plan };

        this.#answers.set(keyOf(asked, plan), answer);
        return answer;
    }

    /**
     * A subscription `retrieve` and `list` answer, active by default. Its
     * access answer is left as it is: set it with `grant`.
     */
    addSubscription(
        fields: Partial<ServerSubscription> & { wallet: string; plan: string },
    ): ServerSubscription {
        const subscription = this.#subscription(fields);

        this.#subscriptions.push(subscription);
        return subscription;
    }

    /**
     * The pull attempts of that subscription, every one it ever had: what
     * `subscriptions.attempts` answers for it, with their `paid` total, and
     * the five newest through `/v1/access` with `attempts`, whose answer
     * becomes about that subscription. Each is a paid one of 9.99 USDC now,
     * priced 9.99 dollars, not a retry, unless told otherwise; one given
     * another `amount` and no `amount_usd` is not priced. Newest first.
     * Throws for an id the fake does not hold.
     */
    setAttempts(id: string, attempts: Array<Partial<SubscriptionAttempt>>): SubscriptionAttempt[] {
        const subscription = this.#subscriptions.find((each) => each.id === id);
        if (!subscription) throw new Error(`The fake holds no subscription ${id}.`);

        const now = new Date().toISOString();
        const filled = attempts
            .map((attempt): SubscriptionAttempt => ({
                id: `att_fake_${(this.#attemptIds += 1)}`,
                attempted_at: now,
                outcome: 'paid',
                reason: null,
                amount: '9990000',
                // The default amount's worth only: no price is guessed for another.
                amount_usd: attempt.amount === undefined ? '9.99' : null,
                signature: 'fake_signature',
                retry: false,
                retry_number: null,
                retries_allowed: null,
                period_start: null,
                ...attempt,
            }))
            // Newest first, as Mesub serves them; as handed within one instant.
            .sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at));

        this.#attempts.set(id, filled);
        this.#answer(subscription, {
            subscribed_since: subscription.confirmed_at,
            attempts: filled
                .slice(0, ACCESS_ATTEMPTS)
                .map(({ outcome, reason, amount, attempted_at, signature }): ServedAttempt => ({
                    outcome,
                    reason,
                    amount,
                    attempted_at,
                    signature,
                })),
        });
        return filled;
    }

    /**
     * A webhook of that type, as Mesub posts it to an endpoint: a made-up
     * subscription and detail, unless `fields` say otherwise, signed with
     * `webhookSecret`. Post it to your own handler, or hand it to
     * `webhooks.verify` of a `client()`. Nothing is added to the fake.
     */
    async webhook(type: WebhookEventType, fields: FakeWebhookFields = {}): Promise<SignedWebhook> {
        const now = new Date();
        const payload = {
            type,
            created_at: fields.created_at ?? now.toISOString(),
            data: {
                ...this.#subscription({ wallet: FAKE_WALLET, plan: 'pro', ...fields.subscription }),
                detail: fields.detail ?? detailOf(type, now),
            },
        };

        return signWebhook(payload, {
            secret: this.webhookSecret,
            ...(fields.id !== undefined && { id: fields.id }),
            ...(fields.timestamp !== undefined && { timestamp: fields.timestamp }),
        });
    }

    /**
     * Every call answers that error from now on, `'outage'` a 503, until
     * `fail(null)`.
     */
    fail(failure: FakeFailure | 'outage' | null): void {
        this.#failure = failure === 'outage' ? OUTAGE : failure;
    }

    /** Forgets every answer, subscription, failure and request. */
    reset(): void {
        this.#answers.clear();
        this.#ends.clear();
        this.#subscriptions = [];
        this.#built.clear();
        this.#gone.clear();
        this.#attempts.clear();
        this.#failure = null;
        this.requests.length = 0;
    }

    #subscription(
        fields: Partial<ServerSubscription> & Pick<ServerSubscription, 'wallet' | 'plan'>,
    ): ServerSubscription {
        const now = new Date().toISOString();

        return {
            id: this.#nextId(),
            status: 'active',
            paused: false,
            end_reason: null,
            late_reason: null,
            access: true,
            payment_status: 'paid',
            blocked_since: null,
            blocked_reason: null,
            email: null,
            external_id: null,
            current_period_start: now,
            current_period_end: null,
            next_charge_at: null,
            next_retry_at: null,
            retry_deadline: null,
            next_retry_number: null,
            retries_allowed: null,
            access_until: null,
            created_at: now,
            confirmed_at: now,
            ...fields,
        };
    }

    /** A plan's end: the one a test gave it, else its `ends_at` in `plans`. */
    #endOf(slug: string | null): string | null {
        if (slug === null) return null;

        return (
            this.#ends.get(slug) ??
            this.#planList.find((each) => each.slug === slug)?.ends_at ??
            null
        );
    }

    /** Whether that plan is past its end, where it takes nobody new. */
    #over(slug: string | null): boolean {
        const end = this.#endOf(slug);

        return end !== null && Date.parse(end) <= Date.now();
    }

    /** A plan as served: with its end, and taking nobody new once past it. */
    #served(plan: Plan): Plan {
        const ends_at = this.#endOf(plan.slug);

        return { ...plan, ends_at, available: plan.available && !this.#over(plan.slug) };
    }

    #nextId(): string {
        this.#ids += 1;
        return `sub_fake_${this.#ids}`;
    }

    async #handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init.method ?? 'GET').toUpperCase();
        const headers = new Headers(init.headers);

        const base = new URL(this.baseUrl);
        const prefix = base.pathname.replace(/\/+$/, '');

        // Anything else is not this fake: a 404 that is not Mesub's, as a wrong baseUrl gets.
        if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) {
            return new Response('Not Found', { status: 404 });
        }

        const path = url.pathname.slice(prefix.length);
        const query = Object.fromEntries(url.searchParams);
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        this.requests.push({ method, path, query, headers, body });

        if (headers.get('authorization') !== `Bearer ${this.apiKey}`) {
            return error(401, 'invalid_api_key', 'That API key is not valid.');
        }
        if (this.#failure) {
            const { status, code, message, retryable, retryAfter } = this.#failure;
            return error(status, code, message ?? `Mesub answered ${status}.`, {
                ...(retryable !== undefined && { retryable }),
                ...(retryAfter !== undefined && { retryAfter }),
            });
        }

        if (method === 'GET' && path === '/v1/plans') {
            return Response.json({ plans: this.#planList.map((plan) => this.#served(plan)) });
        }
        const slug = /^\/v1\/plans\/([^/]+)$/.exec(path)?.[1];
        if (method === 'GET' && slug !== undefined) {
            const plan =
                this.#planList.find((each) => each.slug === slug) ??
                // No list given: every slug exists, as for access.
                (this.#plans === null ? fakePlan(slug) : undefined);

            return plan
                ? Response.json(this.#served(plan))
                : error(404, 'plan_not_found', `No plan under slug ${slug}`);
        }

        if (method === 'GET' && path === '/v1/access') return this.#access(query);
        if (method === 'GET' && path === '/v1/subscriptions') return this.#list(query);
        if (method === 'POST' && path === '/v1/subscriptions') return this.#create(body);

        const [, id, step, confirm] =
            /^\/v1\/subscriptions\/([^/]+)(?:\/(submit|transaction|cancel|resume|close|attempts|retry)(\/confirm)?)?$/.exec(
                path,
            ) ?? [];
        // A Mesub without the route knows no such path, whatever the id.
        if (step === 'attempts' && (confirm || !this.#attemptsRoute)) {
            return error(404, 'not_found', `Cannot ${method} ${path}`);
        }
        if (id !== undefined) {
            const subscription = this.#subscriptions.find((s) => s.id === decodeURIComponent(id));
            if (!subscription) {
                return error(404, 'subscription_not_found', 'No subscription under that id.');
            }
            if (method === 'GET' && !step) {
                return Response.json(bounded(subscription, this.#endOf(subscription.plan)));
            }
            if (step === 'attempts') {
                return method === 'GET'
                    ? this.#attemptsOf(subscription, query)
                    : error(404, 'not_found', `Cannot ${method} ${path}`);
            }
            if (method === 'POST' && step === 'submit' && !confirm) {
                return this.#submit(subscription);
            }
            // A fresh transaction (Mesub-io/backend#427): for a pending one only.
            if (step === 'transaction') {
                return method === 'POST' && !confirm
                    ? this.#transaction(subscription)
                    : error(404, 'not_found', `Cannot ${method} ${path}`);
            }
            // Pay now (Mesub-io/backend#354): taken for a late one, nothing pulled here.
            if (step === 'retry') {
                if (method !== 'POST' || confirm) {
                    return error(404, 'not_found', `Cannot ${method} ${path}`);
                }
                if (subscription.status !== 'unpaid') {
                    return error(
                        409,
                        'subscription_not_late',
                        'This subscription is not behind on its payment.',
                    );
                }
                return Response.json(bounded(subscription, this.#endOf(subscription.plan)), {
                    status: 202,
                });
            }
            if (method === 'POST' && step && step !== 'submit') {
                return confirm
                    ? this.#confirm(step as FakeAction, subscription, body)
                    : this.#build(step as FakeAction, subscription);
            }
        }

        return error(404, 'not_found', `Cannot ${method} ${path}`);
    }

    #access(query: Record<string, string>): Response {
        const invalid = invalidContact(query);
        if (invalid) return invalid;
        const asked = askedIn(query);
        if (!asked)
            return error(400, 'invalid_request', 'Name one of wallet, external_id or email.');

        const { plan } = query;
        const attempts = query['attempts'] === 'true';

        if (plan === undefined) {
            const plans = [...this.#answers.entries()]
                .filter(([key]) => key.startsWith(keyOf(asked, '')))
                .map(([, answer]) =>
                    withAttempts(bounded(answer, this.#endOf(answer.plan)), attempts),
                );
            const soonest = Math.min(...plans.map((answer) => answer.revalidate_after));

            return Response.json({ plans, revalidate_after: plans.length ? soonest : 0 });
        }
        if (this.#plans && !this.#plans.has(plan)) {
            return error(404, 'plan_not_found', `No plan under slug ${plan}`);
        }

        const answer = this.#answers.get(keyOf(asked, plan)) ?? nothing(asked, plan);
        return Response.json(withAttempts(bounded(answer, this.#endOf(plan)), attempts));
    }

    #list(query: Record<string, string>): Response {
        const invalid = invalidContact(query);
        if (invalid) return invalid;
        const asked = askedIn(query);
        if (!asked)
            return error(400, 'invalid_request', 'Name one of wallet, external_id or email.');

        const limit = Number(query['limit'] ?? 20);
        // Newest first. The cursor is a position among every subscription
        // held, whoever it is for, and one not held is a 400, as on Mesub.
        const all = [...this.#subscriptions].reverse();
        const after = query['starting_after'];
        const from = after === undefined ? 0 : all.findIndex((s) => s.id === after) + 1;
        if (after !== undefined && from === 0) {
            return error(400, 'invalid_request', 'starting_after is not a subscription of yours.');
        }
        const data = all
            .slice(from)
            // The comeback that replaced it stands for the customer (Mesub-io/backend#254).
            .filter((s) => s.status !== 'superseded')
            .filter((s) => s[asked.kind] === asked.value)
            .filter((s) => query['plan'] === undefined || s.plan === query['plan']);

        const page: ServerSubscriptionList = {
            data: data.slice(0, limit).map((s) => bounded(s, this.#endOf(s.plan))),
            has_more: data.length > limit,
        };
        return Response.json(page);
    }

    #attemptsOf(subscription: ServerSubscription, query: Record<string, string>): Response {
        const all = this.#attempts.get(subscription.id) ?? [];
        const limit = Number(query['limit'] ?? 20);
        const after = query['starting_after'];
        const from = after === undefined ? 0 : all.findIndex((each) => each.id === after) + 1;

        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            return error(400, 'invalid_request', 'limit must be a whole number from 1 to 100');
        }
        if (after !== undefined && from === 0) {
            return error(
                400,
                'invalid_request',
                'starting_after is not an attempt of this subscription.',
            );
        }

        const paid = all.filter((each) => each.outcome === 'paid');
        const page: SubscriptionAttemptList = {
            data: all.slice(from, from + limit),
            has_more: all.length > from + limit,
            // Over every attempt, not the page; an amount that is no whole number counts for 0.
            paid: {
                count: paid.length,
                amount: paid
                    .reduce(
                        (sum, each) => sum + (/^\d+$/.test(each.amount) ? BigInt(each.amount) : 0n),
                        0n,
                    )
                    .toString(),
            },
        };
        return Response.json(page);
    }

    #create(body: unknown): Response {
        const { plan, wallet, email, external_id } = (body ?? {}) as Record<string, unknown>;

        if (typeof plan !== 'string' || typeof wallet !== 'string') {
            return error(400, 'invalid_request', 'plan and wallet are required.');
        }
        const invalid = invalidContact({ wallet, email });
        if (invalid) return invalid;
        if (this.#plans && !this.#plans.has(plan)) {
            return error(404, 'plan_not_found', `No plan under slug ${plan}`);
        }

        if (this.#over(plan)) return error(409, 'plan_ended', 'This plan has ended.');

        const contact = {
            email: typeof email === 'string' ? email.trim().toLowerCase() : null,
            external_id: typeof external_id === 'string' ? external_id.trim() : null,
        };
        const held = this.#subscriptions.filter((s) => s.plan === plan && s.wallet === wallet);
        const refusal = liveRefusal(held);
        if (refusal) return refusal;

        // One checkout per customer on a wallet, as Mesub keeps them: the same
        // customer gets its own back, another one never does.
        const waiting = held.find(
            (s) => s.status === 'pending' && holderOf(s) === holderOf(contact),
        );
        if (waiting && contact.email !== null) waiting.email = contact.email;

        const subscription =
            waiting ??
            this.addSubscription({
                plan,
                wallet,
                ...contact,
                status: 'pending',
                access: false,
                payment_status: 'none',
                current_period_start: null,
                confirmed_at: null,
            });

        return Response.json(handedOut(subscription), { status: 201 });
    }

    /**
     * A fresh transaction for a subscription still pending, with the same
     * terms message as `create` gave it: a signature held stays good. Refused
     * as Mesub refuses it otherwise.
     */
    #transaction(subscription: ServerSubscription): Response {
        if (subscription.status !== 'pending') {
            return error(409, 'not_awaiting_signature', 'That subscription awaits no signature.');
        }
        if (this.#over(subscription.plan)) return error(409, 'plan_ended', 'This plan has ended.');

        const refusal = liveRefusal(
            this.#subscriptions.filter(
                (s) => s.plan === subscription.plan && s.wallet === subscription.wallet,
            ),
        );
        if (refusal) return refusal;

        return Response.json(handedOut(subscription), { status: 201 });
    }

    /**
     * Lands at once: the subscription turns active and its customer is granted
     * the plan. The other checkouts waiting on that wallet expire, as on Mesub.
     */
    #submit(subscription: ServerSubscription): Response {
        if (subscription.status !== 'pending') {
            return error(409, 'not_awaiting_signature', 'That subscription awaits no signature.');
        }
        for (const other of this.#subscriptions) {
            const beside = other.plan === subscription.plan && other.wallet === subscription.wallet;
            if (beside && other !== subscription && other.status === 'pending') {
                other.status = 'expired';
            }
        }

        const now = new Date();
        const end = new Date(now.getTime() + PERIOD_MS).toISOString();
        // A plan that ends inside the period: access to its end, and no second charge.
        const dates = bounded(
            { access: true, access_until: end, next_charge_at: end, next_retry_at: null },
            this.#endOf(subscription.plan),
        );
        Object.assign(subscription, {
            status: 'active',
            payment_status: 'paid',
            current_period_start: now.toISOString(),
            current_period_end: end,
            confirmed_at: now.toISOString(),
            ...dates,
        } satisfies Partial<ServerSubscription>);

        const plan = subscription.plan ?? '';
        const fields: FakeAccess = {
            wallet: subscription.wallet,
            subscribed_since: now.toISOString(),
            first_subscribed_at: now.toISOString(),
            current_period_end: end,
            access_until: dates.access_until,
            next_charge_at: dates.next_charge_at,
        };
        this.grant({ wallet: subscription.wallet }, plan, fields);
        if (subscription.external_id) {
            this.grant({ external_id: subscription.external_id }, plan, fields);
        }
        if (subscription.email) this.grant({ email: subscription.email }, plan, fields);

        return Response.json({ subscription }, { status: 201 });
    }

    /** The transaction of a cancel, resume or close, or Mesub's refusal of it. */
    #build(action: FakeAction, subscription: ServerSubscription): Response {
        const refusal = refusalOf(action, subscription, this.#gone.has(subscription.id));
        if (refusal) return refusal;

        const built = this.#built.get(subscription.id) ?? new Set();
        this.#built.set(subscription.id, built.add(action));

        const answer: WalletTransaction = {
            transaction: btoa(`fake ${action} transaction`),
            last_valid_block_height: '0',
        };
        return Response.json(answer, { status: 201 });
    }

    /** Lands at once: the subscription moves, and so do its customer's access answers. */
    #confirm(action: FakeAction, subscription: ServerSubscription, body: unknown): Response {
        const { signature } = (body ?? {}) as Record<string, unknown>;

        if (typeof signature !== 'string' || signature === '') {
            return error(400, 'invalid_request', 'signature must be a transaction signature.');
        }
        const gone = this.#gone.has(subscription.id);
        // One ended with its plan is ended before its close and after it (#344).
        const done =
            subscription.status === DONE[action] && !(endedWithPlan(subscription) && !gone);
        const refusal = done ? null : refusalOf(action, subscription, gone);
        if (refusal) return refusal;
        if (!this.#built.get(subscription.id)?.has(action)) {
            return error(400, 'nothing_to_confirm', 'There is no transaction to confirm yet.');
        }
        // Confirmed already: answered with the row, as Mesub does.
        if (done) return Response.json({ subscription }, { status: 201 });
        // What was built for another action is spent.
        this.#built.set(subscription.id, new Set([action]));

        const now = new Date().toISOString();
        const end = subscription.current_period_end;

        if (action === 'close' && endedWithPlan(subscription)) {
            // As Mesub's confirmClose: its account is gone, and the row stays
            // ended with the reason it ended for. Nothing ends twice.
            this.#gone.add(subscription.id);
            return Response.json({ subscription }, { status: 201 });
        }
        if (action === 'cancel') {
            // Paid up, it keeps its access to the end of the period.
            Object.assign(subscription, {
                status: 'cancelled',
                ...NO_BLOCK,
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
                next_retry_number: null,
                retries_allowed: null,
                access_until: subscription.access ? (subscription.access_until ?? end) : null,
            } satisfies Partial<ServerSubscription>);
            this.#answer(subscription, {
                status: 'cancelled',
                ...NO_BLOCK,
                cancelled_at: now,
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
            });
        } else if (action === 'resume') {
            Object.assign(subscription, {
                status: 'active',
                next_charge_at: end,
            } satisfies Partial<ServerSubscription>);
            this.#answer(subscription, {
                status: 'active',
                cancelled_at: null,
                next_charge_at: end,
            });
        } else {
            Object.assign(subscription, {
                status: 'ended',
                end_reason: 'closed',
                ...NO_BLOCK,
                access: false,
                payment_status: 'none',
                access_until: null,
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
                next_retry_number: null,
                retries_allowed: null,
            } satisfies Partial<ServerSubscription>);
            this.#answer(subscription, {
                access: false,
                status: 'ended',
                end_reason: 'closed',
                ...NO_BLOCK,
                payment_status: 'none',
                access_until: null,
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
            });
        }

        return Response.json({ subscription }, { status: 201 });
    }

    /**
     * Changes what `/v1/access` answers a subscription's customer, by wallet,
     * external id and email, on top of what each was answered before.
     */
    #answer(subscription: ServerSubscription, fields: FakeAccess): void {
        const plan = subscription.plan ?? '';
        const customers: Customer[] = [{ wallet: subscription.wallet }];
        if (subscription.external_id) customers.push({ external_id: subscription.external_id });
        if (subscription.email) customers.push({ email: subscription.email });

        for (const customer of customers) {
            const before = this.#answers.get(keyOf(customerOf(customer), plan));

            this.setAccess(customer, plan, {
                wallet: subscription.wallet,
                access: subscription.access,
                payment_status: subscription.payment_status,
                ...before,
                ...fields,
            });
        }
    }
}

/** What an access answer and a subscription both say of access and of the pulls ahead. */
type Dated = Pick<AccessAnswer, 'access' | 'access_until' | 'next_charge_at' | 'next_retry_at'>;

/**
 * A row as Mesub serves it on a plan that ends at `end`: no access from the
 * end on, whatever its status, and before it no `access_until` later than
 * the end and no pull dated at or after it. The real margin (a pull due in
 * the two minutes before the end is not served either) is left out.
 */
function bounded<T extends Dated>(row: T, end: string | null): T {
    if (end === null || !row.access) return row;

    const at = Date.parse(end);
    const none = { next_charge_at: null, next_retry_at: null };
    if (at <= Date.now()) return { ...row, ...none, access: false, access_until: null };

    const ahead = (date: string | null) => (date !== null && Date.parse(date) < at ? date : null);

    return {
        ...row,
        access_until:
            row.access_until !== null && Date.parse(row.access_until) > at ? end : row.access_until,
        next_charge_at: ahead(row.next_charge_at),
        next_retry_at: ahead(row.next_retry_at),
    };
}

/** What `create` and `transaction` hand out for a pending subscription: nothing a chain would take. */
function handedOut(subscription: ServerSubscription): SubscribeTransaction {
    const zero = '0';

    return {
        subscription: { id: subscription.id, status: 'pending' },
        transaction: btoa('fake transaction'),
        last_valid_block_height: zero,
        costs: {
            rent: { subscription: zero, authority: null, total: zero },
            fee: { signatures: 2, per_signature: zero, priority: zero, total: zero },
            total: zero,
        },
        terms: {
            message: `Fake Mesub terms: ${subscription.wallet} subscribes to ${subscription.plan}.`,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
    };
}

/** A block is only ever on a running row: gone once it is cancelled or over. */
const NO_BLOCK = { blocked_since: null, blocked_reason: null } as const;

/** What only a subscription carries of a retry, gone with the retry. */
const NO_RETRY = { next_retry_number: null, retries_allowed: null } as const;

/** What a plan's end makes of a row held on it; nothing of one that was over already. */
function endedBy(row: {
    status: ServerSubscription['status'] | AccessAnswer['status'];
}): Partial<Omit<AccessAnswer, 'status'>> & { status?: 'ended' } {
    const running = row.status === 'active' || row.status === 'unpaid';
    if (!running && row.status !== 'cancelled') return {};

    return {
        status: 'ended',
        end_reason: running ? 'plan_ended' : 'cancelled',
        late_reason: null,
        ...NO_BLOCK,
        paused: false,
        access: false,
        payment_status: 'none',
        access_until: null,
        next_charge_at: null,
        next_retry_at: null,
        retry_deadline: null,
    };
}

/** What stops, takes back or closes a subscription in the fake. */
type FakeAction = 'cancel' | 'resume' | 'close';

/** The status each action leaves a subscription in. */
const DONE: Record<FakeAction, ServerSubscription['status']> = {
    cancel: 'cancelled',
    resume: 'active',
    close: 'ended',
};

/**
 * Mesub's 409 for an action a subscription's status does not allow, or null.
 * `gone`: a row ended with its plan whose close landed already.
 */
function refusalOf(
    action: FakeAction,
    subscription: ServerSubscription,
    gone = false,
): Response | null {
    const { status, access_until } = subscription;
    const over = access_until === null || Date.parse(access_until) <= Date.now();
    const cancelled =
        status === 'cancelled' || (status === 'ended' && subscription.end_reason === 'cancelled');

    if (action === 'cancel') {
        if (status === 'cancelled') {
            return error(409, 'subscription_cancelled', 'This subscription is cancelled already.');
        }
        return ['active', 'unpaid', 'stopped'].includes(status)
            ? null
            : error(409, 'subscription_not_active', 'This subscription is not running.');
    }
    if (action === 'resume') {
        if (status !== 'cancelled') {
            return error(409, 'subscription_not_cancelled', 'This subscription is not cancelled.');
        }
        return over
            ? error(409, 'subscription_ended', 'The period paid for is over: subscribe again.')
            : null;
    }
    // A close, as Mesub's buildCloseTransaction answers it. Ended with its
    // plan, the delegation still holds the deposit (#344): it closes, once.
    if (endedWithPlan(subscription)) {
        return gone
            ? error(
                  409,
                  'subscription_not_on_chain',
                  'This subscription was closed outside Mesub, so it has ended.',
              )
            : null;
    }
    if (isClosed(subscription)) {
        return error(409, 'subscription_not_on_chain', 'This subscription is closed already.');
    }
    if (status === 'ended' && !cancelled) {
        return error(
            409,
            'subscription_not_on_chain',
            'This subscription has ended and cannot be closed through Mesub.',
        );
    }
    // A stopped one included: the fake's is one nothing cancelled, which
    // Mesub cancels first. Neither a cancellation signed without Mesub nor an
    // authority closed for good (Mesub-io/backend#394) is modelled here.
    if (!cancelled) {
        return error(
            409,
            'subscription_not_cancelled',
            'Cancel this subscription before closing it.',
        );
    }
    return over
        ? null
        : error(409, 'close_too_early', `This subscription runs until ${access_until}.`);
}

/**
 * Mesub's 409 for a checkout beside the subscription a wallet holds on the
 * plan, by its status, as the back's `liveRefusal` words it; null when it
 * holds none. A cancelled one past its end is held until it is closed: it
 * reads `ended`, with `end_reason` `cancelled`. A stopped one is not: the
 * fake's is one nothing cancelled, which the wallet comes back over
 * (Mesub-io/backend#211).
 */
function liveRefusal(held: ServerSubscription[]): Response | null {
    const live = held.find(
        (s) =>
            ['active', 'cancelled', 'unpaid'].includes(s.status) ||
            (s.status === 'ended' && s.end_reason === 'cancelled'),
    );

    if (!live) return null;
    if (live.status === 'active') {
        return error(409, 'already_subscribed', 'You are already subscribed to this plan.');
    }
    if (live.status === 'unpaid') {
        return error(
            409,
            'payment_pending',
            'You already have a subscription to this plan, and its last payment is late. Open it in your subscriptions to see how to fix it, or cancel it.',
        );
    }
    const until = live.status === 'cancelled' ? live.access_until : null;
    return error(
        409,
        'subscription_cancelled',
        until !== null && Date.parse(until) > Date.now()
            ? `Your subscription to this plan is cancelled but runs until ${until}: resume it instead of subscribing again.`
            : 'Your cancelled subscription to this plan must be closed first: close it, then subscribe again.',
    );
}

/** Whose checkout it is, as Mesub tells them apart: the external id, else the email, else nobody. */
function holderOf(contact: Pick<ServerSubscription, 'email' | 'external_id'>): string {
    if (contact.external_id) return `x:${contact.external_id}`;

    return contact.email ? `e:${contact.email}` : '-';
}

/** The reasons a row ends with its plan: removed, replaced, or past its end. */
const WITH_ITS_PLAN: Array<ServerSubscription['end_reason']> = [
    'plan_removed',
    'plan_replaced',
    'plan_ended',
];

/** A row ended with its plan, which Mesub still closes (Mesub-io/backend#344). */
function endedWithPlan(subscription: ServerSubscription): boolean {
    return subscription.status === 'ended' && WITH_ITS_PLAN.includes(subscription.end_reason);
}

function isClosed(subscription: ServerSubscription): boolean {
    return subscription.status === 'ended' && subscription.end_reason === 'closed';
}

function keyOf(asked: Asked, plan: string): string {
    return `${asked.kind}:${asked.value}\n${plan}`;
}

let webhookIds = 0;

/**
 * Signs a body as Mesub does (Standard Webhooks, HMAC-SHA256 of
 * `id.timestamp.body`), for a webhook of your own making: an object is sent
 * as its JSON, a string as is. `FakeMesub.webhook` builds the body for you.
 */
export async function signWebhook(
    payload: unknown,
    options: SignWebhookOptions,
): Promise<SignedWebhook> {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const id = options.id ?? `msg_fake_${(webhookIds += 1)}`;
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

    return { body, headers: await signedHeaders(options.secret, id, timestamp, body) };
}

/** A plausible detail for each type that carries one, as the back writes it. */
function detailOf(type: WebhookEventType, now: Date): Record<string, unknown> {
    const start = now.toISOString();
    const end = new Date(now.getTime() + PERIOD_MS).toISOString();
    const paid = { amount: '9990000', mint: USDC, period_start: start, period_end: end };

    switch (type) {
        case 'subscription.renewal_upcoming':
            return {
                can_pay: true,
                renewal_issue: null,
                amount: paid.amount,
                mint: USDC,
                // The check's window opens three days before the charge at most.
                due_at: new Date(now.getTime() + 3 * 24 * 3600 * 1000).toISOString(),
            };
        case 'subscription.renewed':
            return { ...paid, signature: 'fake_signature' };
        case 'subscription.payment_failed':
            return {
                ...paid,
                reason: 'insufficient-balance',
                next_retry_at: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
                retry_deadline: null,
                retries_left: 1,
                retry_mode: 'scheduled',
            };
        case 'subscription.stopped':
            return { reason: 'insufficient-balance' };
        default:
            return {};
    }
}

function nothing(asked: Asked, plan: string): AccessAnswer {
    return { wallet: asked.kind === 'wallet' ? asked.value : null, plan, ...NOTHING };
}

/** A Solana address's shape, as Mesub's DTOs hold a wallet to: base58, 32 to 44 characters. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Close to the `IsEmail` Mesub checks an email with, validator.js's
 * defaults: no space, one @, and a domain ending in a top-level one of two
 * letters or more, so `ops@localhost` is refused. Not every edge of it.
 */
const EMAIL = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Mesub's 400 for a wallet or an email its DTOs refuse (`CustomerQueryDto`,
 * `ServerSubscribeDto`), before anything is looked up; null for those it
 * takes, or that are not given. The email is trimmed and lowercased first,
 * as Mesub does.
 */
function invalidContact({ wallet, email }: { wallet?: unknown; email?: unknown }): Response | null {
    const reasons: string[] = [];
    if (typeof wallet === 'string' && !BASE58_ADDRESS.test(wallet)) {
        reasons.push('wallet must be a base58 Solana address');
    }
    if (typeof email === 'string') {
        const normalised = email.trim().toLowerCase();
        if (!EMAIL.test(normalised)) reasons.push('email must be an email address');
        if (normalised.length > 254) {
            reasons.push('email must be shorter than or equal to 254 characters');
        }
    }

    return reasons.length ? error(400, 'invalid_request', reasons) : null;
}

/** The one customer a query names, or null when it names none or several. */
function askedIn(query: Record<string, string>): Asked | null {
    try {
        return customerOf({
            wallet: query['wallet'],
            external_id: query['external_id'],
            email: query['email'],
        } as unknown as Customer);
    } catch {
        return null;
    }
}

function withAttempts(answer: AccessAnswer, attempts: boolean): AccessAnswer {
    if (attempts) return { ...answer, attempts: answer.attempts ?? [] };

    const light = { ...answer };
    delete light.attempts;
    return light;
}

/**
 * A plan as `/v1/plans` serves one: 9.99 USDC a month on devnet, unless told
 * otherwise. Its token follows its `symbol`, which only a vouched mint has:
 * verified and worth its amount in dollars with one, unverified and unpriced
 * with a `token` given or a null `symbol`.
 */
function fakePlan(slug: string, { token, ...over }: Omit<FakePlanFields, 'slug'> = {}): Plan {
    const symbol = over.symbol === undefined ? (token ? null : 'USDC') : over.symbol;
    const vouched = token === undefined && symbol !== null;

    return {
        slug,
        name: slug,
        description: null,
        project_name: 'Test project',
        logo_url: null,
        amount: '9990000',
        amount_display: '9.99',
        amount_usd: vouched ? (over.amount_display ?? '9.99') : null,
        decimals: 6,
        symbol,
        token: {
            symbol: token ? null : symbol,
            name: vouched && symbol === 'USDC' ? 'USD Coin' : null,
            logo_url: null,
            verified: vouched,
            ...token,
        },
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        period_hours: 720,
        network: 'devnet',
        status: 'active',
        available: true,
        ends_at: null,
        ...over,
    };
}

/**
 * The codes Mesub answers `retryable: true`, from the back's `ERROR_CODES`,
 * which sets the flag by code alone. Every other code it has is false, and
 * none of those is ever answered as a 408, a 429 or a 5xx, so the status
 * says the same of them.
 */
const RETRYABLE_CODES = new Set([
    'rate_limited',
    'internal_error',
    'unavailable',
    'comeback_in_flight',
    'comeback_period_rolling',
    'pending_cap_reached',
    'subscription_changed',
    'retry_too_soon',
    'pull_running',
    'network_unavailable',
]);

/** An error as the back writes it: Nest's body, plus `code` and `retryable`. */
function error(
    status: number,
    code: string,
    // A list for what Mesub's validation refused, as Nest answers it.
    message: string | string[],
    { retryable, retryAfter }: { retryable?: boolean; retryAfter?: number } = {},
): Response {
    return Response.json(
        {
            statusCode: status,
            error: REASONS[status] ?? 'Error',
            message,
            code,
            retryable:
                retryable ??
                (RETRYABLE_CODES.has(code) || status === 408 || status === 429 || status >= 500),
        },
        {
            status,
            ...(retryAfter !== undefined && { headers: { 'Retry-After': String(retryAfter) } }),
        },
    );
}
