/**
 * `@mesub/node/testing`: a fake Mesub, for a merchant's own tests. It answers
 * what the SDK calls (`/v1/access`, `/v1/plans`, `/v1/subscriptions` and its
 * cancel, resume and close) from what the test sets, through a `fetch` handed
 * to the client: no network, no backend, no test framework of its own.
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
import type { Plan } from './plans.js';
import type {
    ServerSubscription,
    ServerSubscriptionList,
    SubscribeTransaction,
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
     */
    plans?: Array<string | (Partial<Plan> & { slug: string })>;
    /** What `webhook()` signs with, and `client()` verifies with. Defaults to a fixed `whsec_` secret. */
    webhookSecret?: string;
}

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
    /** Defaults to what the status says: true for 408, 429 and 5xx. */
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
    payment_status: 'none',
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
 * fail with `fail()`.
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
    #subscriptions: ServerSubscription[] = [];
    /** The subscriptions a cancel, resume or close transaction was built for, by id. */
    readonly #built = new Map<string, Set<FakeAction>>();
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
     * The pull attempts of that subscription, as `/v1/access` answers them to
     * its customer with `attempts`: the answer becomes about that subscription.
     * Each is a paid one of 9.99 USDC now unless told otherwise; hand them
     * newest first, as Mesub serves them. Throws for an id the fake does not hold.
     */
    setAttempts(id: string, attempts: Array<Partial<ServedAttempt>>): ServedAttempt[] {
        const subscription = this.#subscriptions.find((each) => each.id === id);
        if (!subscription) throw new Error(`The fake holds no subscription ${id}.`);

        const now = new Date().toISOString();
        const filled = attempts.map((attempt): ServedAttempt => ({
            outcome: 'PAID',
            reason: null,
            amount: '9990000',
            attempted_at: now,
            signature: 'fake_signature',
            ...attempt,
        }));

        this.#answer(subscription, {
            subscribed_since: subscription.confirmed_at,
            attempts: filled,
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
        this.#subscriptions = [];
        this.#built.clear();
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
            access: true,
            payment_status: 'paid',
            email: null,
            external_id: null,
            current_period_start: now,
            current_period_end: null,
            next_charge_at: null,
            next_retry_at: null,
            retry_deadline: null,
            access_until: null,
            created_at: now,
            confirmed_at: now,
            ...fields,
        };
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
            return Response.json({ plans: this.#planList });
        }
        const slug = /^\/v1\/plans\/([^/]+)$/.exec(path)?.[1];
        if (method === 'GET' && slug !== undefined) {
            const plan =
                this.#planList.find((each) => each.slug === slug) ??
                // No list given: every slug exists, as for access.
                (this.#plans === null ? fakePlan(slug) : undefined);

            return plan
                ? Response.json(plan)
                : error(404, 'plan_not_found', `No plan under slug ${slug}`);
        }

        if (method === 'GET' && path === '/v1/access') return this.#access(query);
        if (method === 'GET' && path === '/v1/subscriptions') return this.#list(query);
        if (method === 'POST' && path === '/v1/subscriptions') return this.#create(body);

        const [, id, step, confirm] =
            /^\/v1\/subscriptions\/([^/]+)(?:\/(submit|cancel|resume|close)(\/confirm)?)?$/.exec(
                path,
            ) ?? [];
        if (id !== undefined) {
            const subscription = this.#subscriptions.find((s) => s.id === decodeURIComponent(id));
            if (!subscription) {
                return error(404, 'subscription_not_found', 'No subscription under that id.');
            }
            if (method === 'GET' && !step) return Response.json(subscription);
            if (method === 'POST' && step === 'submit' && !confirm) {
                return this.#submit(subscription);
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
        const asked = askedIn(query);
        if (!asked)
            return error(400, 'invalid_request', 'Name one of wallet, external_id or email.');

        const { plan } = query;
        const attempts = query['attempts'] === 'true';

        if (plan === undefined) {
            const plans = [...this.#answers.entries()]
                .filter(([key]) => key.startsWith(keyOf(asked, '')))
                .map(([, answer]) => withAttempts(answer, attempts));
            const soonest = Math.min(...plans.map((answer) => answer.revalidate_after));

            return Response.json({ plans, revalidate_after: plans.length ? soonest : 0 });
        }
        if (this.#plans && !this.#plans.has(plan)) {
            return error(404, 'plan_not_found', `No plan under slug ${plan}`);
        }

        const answer = this.#answers.get(keyOf(asked, plan)) ?? nothing(asked, plan);
        return Response.json(withAttempts(answer, attempts));
    }

    #list(query: Record<string, string>): Response {
        const asked = askedIn(query);
        if (!asked)
            return error(400, 'invalid_request', 'Name one of wallet, external_id or email.');

        const limit = Number(query['limit'] ?? 20);
        let data = this.#subscriptions
            .filter((s) => s[asked.kind] === asked.value)
            .filter((s) => query['plan'] === undefined || s.plan === query['plan'])
            .reverse();
        const after = query['starting_after'];
        if (after !== undefined) data = data.slice(data.findIndex((s) => s.id === after) + 1);

        const page: ServerSubscriptionList = {
            data: data.slice(0, limit),
            has_more: data.length > limit,
        };
        return Response.json(page);
    }

    #create(body: unknown): Response {
        const { plan, wallet, email, external_id } = (body ?? {}) as Record<string, unknown>;

        if (typeof plan !== 'string' || typeof wallet !== 'string') {
            return error(400, 'invalid_request', 'plan and wallet are required.');
        }
        if (this.#plans && !this.#plans.has(plan)) {
            return error(404, 'plan_not_found', `No plan under slug ${plan}`);
        }

        const subscription = this.addSubscription({
            plan,
            wallet,
            email: typeof email === 'string' ? email.trim().toLowerCase() : null,
            external_id: typeof external_id === 'string' ? external_id.trim() : null,
            status: 'pending',
            access: false,
            payment_status: 'none',
            current_period_start: null,
            confirmed_at: null,
        });
        const zero = '0';
        const answer: SubscribeTransaction = {
            subscription: { id: subscription.id, status: 'pending' },
            transaction: btoa('fake transaction'),
            last_valid_block_height: zero,
            costs: {
                rent: { subscription: zero, authority: null, total: zero },
                fee: { signatures: 2, per_signature: zero, priority: zero, total: zero },
                total: zero,
            },
            terms: {
                message: `Fake Mesub terms: ${wallet} subscribes to ${plan}.`,
                expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
        };

        return Response.json(answer, { status: 201 });
    }

    /** Lands at once: the subscription turns active and its customer is granted the plan. */
    #submit(subscription: ServerSubscription): Response {
        if (subscription.status !== 'pending') {
            return error(409, 'not_awaiting_signature', 'That subscription awaits no signature.');
        }

        const now = new Date();
        const end = new Date(now.getTime() + PERIOD_MS).toISOString();
        Object.assign(subscription, {
            status: 'active',
            access: true,
            payment_status: 'paid',
            current_period_start: now.toISOString(),
            current_period_end: end,
            next_charge_at: end,
            access_until: end,
            confirmed_at: now.toISOString(),
        } satisfies Partial<ServerSubscription>);

        const plan = subscription.plan ?? '';
        const fields: FakeAccess = {
            wallet: subscription.wallet,
            subscribed_since: now.toISOString(),
            first_subscribed_at: now.toISOString(),
            current_period_end: end,
            access_until: end,
            next_charge_at: end,
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
        const refusal = refusalOf(action, subscription);
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
        const done = subscription.status === DONE[action];
        const refusal = done ? null : refusalOf(action, subscription);
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

        if (action === 'cancel') {
            // Paid up, it keeps its access to the end of the period.
            Object.assign(subscription, {
                status: 'cancelled',
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
                access_until: subscription.access ? (subscription.access_until ?? end) : null,
            } satisfies Partial<ServerSubscription>);
            this.#answer(subscription, {
                status: 'cancelled',
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
                access: false,
                payment_status: 'none',
                access_until: null,
                next_charge_at: null,
                next_retry_at: null,
                retry_deadline: null,
            } satisfies Partial<ServerSubscription>);
            this.#answer(subscription, {
                access: false,
                status: 'ended',
                end_reason: 'closed',
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

/** What stops, takes back or closes a subscription in the fake. */
type FakeAction = 'cancel' | 'resume' | 'close';

/** The status each action leaves a subscription in. */
const DONE: Record<FakeAction, ServerSubscription['status']> = {
    cancel: 'cancelled',
    resume: 'active',
    close: 'ended',
};

/** Mesub's 409 for an action a subscription's status does not allow, or null. */
function refusalOf(action: FakeAction, subscription: ServerSubscription): Response | null {
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
    if (isClosed(subscription)) {
        return error(409, 'subscription_not_on_chain', 'This subscription is closed already.');
    }
    if (!cancelled && status !== 'stopped') {
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

/** An error as the back writes it: Nest's body, plus `code` and `retryable`. */
/** A plan as `/v1/plans` serves one: 9.99 USDC a month on devnet, unless told otherwise. */
function fakePlan(slug: string, over: Partial<Plan> = {}): Plan {
    return {
        slug,
        name: slug,
        description: null,
        project_name: 'Test project',
        logo_url: null,
        amount: '9990000',
        amount_display: '9.99',
        decimals: 6,
        symbol: 'USDC',
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        period_hours: 720,
        network: 'devnet',
        status: 'active',
        available: true,
        ends_at: null,
        ...over,
    };
}

function error(
    status: number,
    code: string,
    message: string,
    { retryable, retryAfter }: { retryable?: boolean; retryAfter?: number } = {},
): Response {
    return Response.json(
        {
            statusCode: status,
            error: REASONS[status] ?? 'Error',
            message,
            code,
            retryable: retryable ?? (status === 408 || status === 429 || status >= 500),
        },
        {
            status,
            ...(retryAfter !== undefined && { headers: { 'Retry-After': String(retryAfter) } }),
        },
    );
}
