/**
 * `@mesub/node/testing`: a fake Mesub, for a merchant's own tests. It answers
 * what the SDK calls (`/v1/access`, `/v1/project`, `/v1/subscriptions`, the
 * public keys) from what the test sets, through a `fetch` handed to the
 * client: no network, no backend, no test framework of its own.
 *
 * ```ts
 * import { FakeMesub } from '@mesub/node/testing';
 *
 * const fake = new FakeMesub();
 * fake.grant(wallet, 'pro');
 * const mesub = fake.client();
 * await mesub.hasAccess(wallet, 'pro'); // true
 * ```
 */
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

import type { AccessAnswer, Customer } from './answer.js';
import { Mesub, type MesubOptions } from './client.js';
import { type Asked, customerOf } from './customer.js';
import type {
    ServerSubscription,
    ServerSubscriptionList,
    SubscribeTransaction,
} from './subscriptions.js';

export interface FakeMesubOptions {
    /** Where the fake answers. Defaults to `https://api.mesub.test`. */
    baseUrl?: string;
    /** The only key it accepts; any other is answered 401. Defaults to `SUB_test_fake`. */
    apiKey?: string;
    /** What `/v1/project` answers, and the `aud` of its tokens. Defaults to `proj_test`. */
    projectId?: string;
    /**
     * The plans that exist: any other slug is answered 404 `plan_not_found`.
     * By default every slug exists.
     */
    plans?: string[];
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

export interface FakeTokenOptions {
    /** The token's `sub`. Defaults to `user_test`. */
    userId?: string;
    /** A jose duration (`'1h'`, `'-1m'` for one already expired) or epoch seconds. Defaults to `'1h'`. */
    expiresIn?: string | number;
}

/** What a test may set of an access answer: all but the plan, named apart. */
export type FakeAccess = Partial<Omit<AccessAnswer, 'plan'>>;

/** What Mesub answers a customer with nothing on a plan. */
const NOTHING: Omit<AccessAnswer, 'wallet' | 'plan'> = {
    access: false,
    status: 'none',
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

const KID = 'fake-key-1';
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
 * or `setAccess`, gets a client wired to it with `client()`, an access token
 * the guards accept with `token()`, and makes it fail with `fail()`.
 */
export class FakeMesub {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly projectId: string;
    /** Every call received, oldest first. */
    readonly requests: FakeRequest[] = [];
    /** Hand it to `new Mesub({ fetch })`, or use `client()`. */
    readonly fetch: typeof globalThis.fetch;

    readonly #plans: Set<string> | null;
    readonly #answers = new Map<string, AccessAnswer>();
    #subscriptions: ServerSubscription[] = [];
    #failure: FakeFailure | null = null;
    #keys: Promise<{ privateKey: CryptoKey; jwk: JWK }> | undefined;
    #ids = 0;

    constructor(options: FakeMesubOptions = {}) {
        this.baseUrl = (options.baseUrl ?? 'https://api.mesub.test').replace(/\/+$/, '');
        this.apiKey = options.apiKey ?? 'SUB_test_fake';
        this.projectId = options.projectId ?? 'proj_test';
        this.#plans = options.plans ? new Set(options.plans) : null;
        this.fetch = (input, init) => this.#handle(input, init);
    }

    /**
     * A client wired to this fake: its key, base URL and fetch, and no retry
     * unless asked, so a failure shows at once. Any other option is passed on.
     */
    client(options: Omit<MesubOptions, 'apiKey' | 'baseUrl' | 'fetch'> = {}): Mesub {
        return new Mesub({
            maxRetries: 0,
            ...options,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            fetch: this.fetch,
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
        const now = new Date().toISOString();
        const subscription: ServerSubscription = {
            id: this.#nextId(),
            status: 'active',
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

        this.#subscriptions.push(subscription);
        return subscription;
    }

    /**
     * Every call to `/v1/access` and `/v1/subscriptions` answers that error
     * from now on, `'outage'` a 503, until `fail(null)`. The public keys and
     * `/v1/project`, which a client fetches once, keep answering.
     */
    fail(failure: FakeFailure | 'outage' | null): void {
        this.#failure = failure === 'outage' ? OUTAGE : failure;
    }

    /**
     * An access token for that wallet, as `@mesub/react` hands it: signed by
     * this fake's key, for its project, so `verifyToken` and the guards of a
     * client of this fake accept it.
     */
    async token(wallet: string, options: FakeTokenOptions = {}): Promise<string> {
        const { privateKey } = await this.#keyPair();

        return new SignJWT({ wallet })
            .setProtectedHeader({ alg: 'ES256', kid: KID })
            .setSubject(options.userId ?? 'user_test')
            .setAudience(this.projectId)
            .setIssuer(this.baseUrl)
            .setIssuedAt()
            .setExpirationTime(options.expiresIn ?? '1h')
            .sign(privateKey);
    }

    /** Forgets every answer, subscription, failure and request. The keys stay. */
    reset(): void {
        this.#answers.clear();
        this.#subscriptions = [];
        this.#failure = null;
        this.requests.length = 0;
    }

    #keyPair() {
        this.#keys ??= generateKeyPair('ES256').then(async ({ privateKey, publicKey }) => ({
            privateKey,
            jwk: { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' },
        }));
        return this.#keys;
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

        if (method === 'GET' && path === '/.well-known/jwks.json') {
            return Response.json({ keys: [(await this.#keyPair()).jwk] });
        }
        if (headers.get('authorization') !== `Bearer ${this.apiKey}`) {
            return error(401, 'invalid_api_key', 'That API key is not valid.');
        }
        if (method === 'GET' && path === '/v1/project') {
            return Response.json({ id: this.projectId });
        }
        if (this.#failure) {
            const { status, code, message, retryable, retryAfter } = this.#failure;
            return error(status, code, message ?? `Mesub answered ${status}.`, {
                ...(retryable !== undefined && { retryable }),
                ...(retryAfter !== undefined && { retryAfter }),
            });
        }

        if (method === 'GET' && path === '/v1/access') return this.#access(query);
        if (method === 'GET' && path === '/v1/subscriptions') return this.#list(query);
        if (method === 'POST' && path === '/v1/subscriptions') return this.#create(body);

        const [, id, submit] = /^\/v1\/subscriptions\/([^/]+)(\/submit)?$/.exec(path) ?? [];
        if (id !== undefined) {
            const subscription = this.#subscriptions.find((s) => s.id === decodeURIComponent(id));
            if (!subscription) {
                return error(404, 'subscription_not_found', 'No subscription under that id.');
            }
            if (method === 'GET' && !submit) return Response.json(subscription);
            if (method === 'POST' && submit) return this.#submit(subscription);
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
}

function keyOf(asked: Asked, plan: string): string {
    return `${asked.kind}:${asked.value}\n${plan}`;
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
