import type { Customer, ServedAttempt } from './answer.js';
import type { Mesub } from './client.js';
import { type Asked, customerOf } from './customer.js';
import { MesubError } from './errors.js';
import type { Plan } from './plans.js';
import type { ServerSubscription, SubscriptionAttempt } from './subscriptions.js';
import type { CallOptions } from './transport.js';

/**
 * The routes `@mesub/react` calls on your own server, so the browser never
 * talks to Mesub nor holds a key: a plan to show, the customer's
 * subscriptions, one of them with its payments, and each step of
 * subscribing, cancelling, resuming and closing. One function, `handleWidget`; the Express and Next entries only
 * carry a request to it.
 *
 * Who is asking comes from `customer`, your own verified auth, as on the
 * guards. A subscription that is not that customer's is answered 404, the
 * same as one that does not exist.
 */

/** Who is asking, from your own auth. Null when nobody is signed in, a 401. */
export type WidgetCustomer<Req> = (
    request: Req,
) => Customer | string | null | undefined | Promise<Customer | string | null | undefined>;

export interface WidgetRoutesOptions<Req> {
    /** Defaults to one client built from MESUB_API_KEY. */
    client?: Mesub;
    /**
     * Who is asking, from a session you verified, never from the request
     * itself: `(req) => ({ external_id: req.user.id })`, a wallet or an email.
     * Every subscription created is tied to it, and only its own are reached.
     */
    customer: WidgetCustomer<Req>;
    /**
     * Where that customer's notices go, when `customer` is not an email:
     * `(req) => req.user.email`. Not verified by Mesub.
     */
    email?: (request: Req) => string | null | undefined | Promise<string | null | undefined>;
    /**
     * The plans the widget may subscribe to. Any plan of your project by
     * default; name them to keep one off your site.
     */
    plans?: readonly string[];
}

/** A request as the core reads it, whatever the framework. */
export interface WidgetRequest {
    method: string;
    /** After the mount point: `/subscriptions/sub_1/cancel`. */
    path: string;
    /** Parsed JSON, or undefined when there was none. */
    body: unknown;
    /** The request's `Content-Type`, to refuse a POST a plain form could send. */
    contentType: string | null;
}

/** What the core answers: a status and a JSON body. */
export interface WidgetResponse {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

/** The most a widget request's body may weigh: a signed transaction is under 2 kB. */
export const MAX_BODY_BYTES = 64 * 1024;

const ACTIONS = ['cancel', 'resume', 'close'] as const;
type Action = (typeof ACTIONS)[number];

/** An id as Mesub writes them: nothing that could rewrite the path. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * How long one widget request gives Mesub for all its reads, in milliseconds:
 * a browser is waiting, and a detail or a list makes several calls.
 */
const WIDGET_READ_TIME = 10_000;

/**
 * How every read of one request is made, as a guard's: cut at one deadline,
 * and a 429 handed on at once, never waited out. The client's methods pass
 * their options to the transport whole, which is how these reach it.
 */
function bounded(): CallOptions {
    return { deadline: Date.now() + WIDGET_READ_TIME, retryRateLimited: false };
}

function refusal(status: number, code: string, message: string): WidgetResponse {
    return { status, body: { error: { code, message } } };
}

const NOT_FOUND = () => refusal(404, 'not_found', 'Nothing here.');
const NO_SUBSCRIPTION = () => refusal(404, 'subscription_not_found', 'No such subscription.');

/** Said to the browser for an error Mesub did not word itself. */
const NO_ANSWER = 'Mesub could not answer this request.';

/** Mesub's own words only: the transport's may name `baseUrl` or a network error. */
function said(error: MesubError): string {
    return error.apiCode === null ? NO_ANSWER : error.message;
}

/**
 * Whether Mesub refused your server, not what the customer did: any 401,
 * which Mesub answers only to an API key missing, never issued or rotated
 * since (`missing_api_key`, `invalid_api_key`), or a 403 that names none of
 * Mesub's own codes, from something in front of Mesub turning your server
 * away. Handed on, a 401 reads to `@mesub/react` as "nobody is signed in",
 * and every visitor gets the sign-in screen: thrown instead, a broken
 * integration, for the framework to log and answer 500.
 */
function brokenIntegration(error: MesubError): boolean {
    if (error.status === 401) return true;

    return error.status === 403 && (error.apiCode === null || error.apiCode === 'forbidden');
}

/** A Mesub refusal, handed on with its own status and code, and nothing of the key. */
function fromMesub(error: MesubError): WidgetResponse {
    // No answer from Mesub, or a 2xx this SDK cannot read: a 502 of yours.
    const status = error.status === null || error.status < 400 ? 502 : error.status;
    const retry =
        error.retryAfter === null
            ? undefined
            : { 'Retry-After': String(Math.ceil(error.retryAfter / 1000)) };

    return {
        status,
        body: { error: { code: error.apiCode ?? error.code, message: said(error) } },
        ...(retry && { headers: retry }),
    };
}

function isString(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}

function fieldsOf(body: unknown): Record<string, unknown> | null {
    return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

/** Whether that subscription is the customer's: by the same identifier it was asked with. */
function isTheirs(subscription: ServerSubscription, asked: Asked): boolean {
    if (asked.kind === 'wallet') return subscription.wallet === asked.value;
    if (asked.kind === 'external_id') return subscription.external_id === asked.value;

    return subscription.email === asked.value;
}

/** What a browser gets of a subscription: the merchant's own id and email stay on the server. */
function shown(subscription: ServerSubscription) {
    const { email: _email, external_id: _externalId, ...rest } = subscription;

    return rest;
}

/** `GET /subscriptions` reads pages of 100, Mesub's largest, and 5 at most. */
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 5;

/** What `GET /subscriptions` answers. */
export interface WidgetSubscriptionList {
    /** Newest first, expired checkouts included: the 500 newest at most. */
    subscriptions: Array<Omit<ServerSubscription, 'email' | 'external_id'>>;
    /** True when the customer has more than those, which are not read. */
    has_more: boolean;
}

/** One pull attempt as the browser gets it: the fields Mesub serves, and no other. */
export interface WidgetPayment {
    attempted_at: string;
    /** `paid`, `skipped`, `rejected` or `blocked` today; a newer one is handed on as is. */
    outcome: string;
    /** What was asked for, in the mint's smallest unit; on a paid one, what was paid. */
    amount: string;
    /** Mesub's short reason, null on a paid one. */
    reason: string | null;
    /** Null when nothing was sent. */
    signature: string | null;
    /** A retry of a missed charge. Null from a Mesub that does not say. */
    retry: boolean | null;
    /**
     * Which retry and out of how many, as Mesub recorded them when it ran:
     * 2 and 3 for "retry 2 / 3". Null when it is no retry of the plan's, or
     * Mesub does not say.
     */
    retry_number: number | null;
    retries_allowed: number | null;
    /** The start of the period it was for. Null when Mesub recorded none or does not say. */
    period_start: string | null;
}

/** What `GET /subscriptions/:id` answers. */
export interface WidgetSubscriptionDetail {
    subscription: Omit<ServerSubscription, 'email' | 'external_id'>;
    /** What Mesub pulls next, soonest first: one entry at most, none when nothing is due. */
    upcoming: WidgetUpcoming[];
    /**
     * This subscription's own pull attempts, newest first: the first page,
     * twenty at most, so not always its full history. Null when they could
     * not be read: `payments_error` says why.
     */
    payments: WidgetPayment[] | null;
    /**
     * What it paid since it began, counted by Mesub over all its attempts,
     * not over `payments`: how many were paid, and their sum in the mint's
     * smallest unit. Null when the read failed, and from a Mesub that does
     * not serve it: never summed here.
     */
    paid: { count: number; amount: string } | null;
    /** Why `payments` is null; null otherwise. */
    payments_error: { code: string; message: string } | null;
}

/** The one pull Mesub announces next for a subscription. */
export interface WidgetUpcoming {
    /** `charge` at the due date of a running one, `retry` of a missed one. */
    kind: 'charge' | 'retry';
    due_at: string;
    /**
     * The plan's price in the mint's smallest unit, and as a person counts
     * it. Null when the plan could not be read, never guessed.
     */
    amount: string | null;
    amount_display: string | null;
    /**
     * On a `retry`, which one it will be and out of how many: 2 and 3 for
     * "next try 2 / 3". Null on a `charge`, and when Mesub does not say.
     */
    retry_number: number | null;
    retries_allowed: number | null;
}

/** How long the plan list read for the widget is kept. */
const PLAN_TTL_MS = 60_000;

interface PlanList {
    /** Shared while the request is out. */
    plans: Promise<Plan[]>;
    /** Infinity until Mesub answered. */
    until: number;
}

// Per client, so two projects never share a plan.
const planLists = new WeakMap<Mesub, PlanList>();

/**
 * A plan for the widget routes, from the project's list: public reads must
 * not spend the API key's rate limit, so one call per TTL whatever the slugs,
 * and null with no call for a slug that is not in it. A failed read is
 * forgotten at once.
 */
async function planOf(client: Mesub, slug: string, read: CallOptions): Promise<Plan | null> {
    let list = planLists.get(client);

    if (!list || list.until <= Date.now()) {
        // Shared while in flight: bound by the first asker's deadline, as a guard's flight.
        const fresh: PlanList = { plans: client.plans.list(read), until: Infinity };

        list = fresh;
        planLists.set(client, fresh);
        fresh.plans.then(
            () => {
                fresh.until = Date.now() + PLAN_TTL_MS;
            },
            () => {
                if (planLists.get(client) === fresh) planLists.delete(client);
            },
        );
    }

    return (await list.plans).find((plan) => plan.slug === slug) ?? null;
}

/**
 * What Mesub will pull next: the next charge of a running subscription, the
 * next retry of a late one, and nothing for any other, a parked seat
 * included. One event at most: later periods are not served, so not computed.
 * On Free a late one has no retry of Mesub's, only `retry_deadline`.
 */
async function upcomingOf(
    client: Mesub,
    subscription: ServerSubscription,
    read: CallOptions,
): Promise<WidgetUpcoming[]> {
    const { status, plan } = subscription;
    const next =
        status === 'active'
            ? { kind: 'charge' as const, due_at: subscription.next_charge_at }
            : status === 'unpaid'
              ? { kind: 'retry' as const, due_at: subscription.next_retry_at }
              : null;

    // A date on any other status is no pull Mesub will run.
    if (!next || next.due_at === null || subscription.paused) return [];

    let price: { amount: string; amount_display: string } | null = null;

    if (plan !== null && SLUG.test(plan)) {
        try {
            price = await planOf(client, plan, read);
        } catch (error) {
            if (!(error instanceof MesubError) || brokenIntegration(error)) throw error;
        }
    }

    const retry = next.kind === 'retry';

    return [
        {
            kind: next.kind,
            due_at: next.due_at,
            amount: price?.amount ?? null,
            amount_display: price?.amount_display ?? null,
            // Mesub's own, never counted here; `?? null` for a subscription cached by an older SDK.
            retry_number: retry ? (subscription.next_retry_number ?? null) : null,
            retries_allowed: retry ? (subscription.retries_allowed ?? null) : null,
        },
    ];
}

/** The statuses nothing is ever pulled in: a checkout that never started. */
const NEVER_STARTED = ['pending', 'expired', 'failed'];

function payment(attempt: SubscriptionAttempt): WidgetPayment {
    return {
        attempted_at: attempt.attempted_at,
        outcome: attempt.outcome,
        amount: attempt.amount,
        reason: attempt.reason,
        signature: attempt.signature,
        retry: attempt.retry,
        retry_number: attempt.retry_number,
        retries_allowed: attempt.retries_allowed,
        period_start: attempt.period_start,
    };
}

/** An attempt of `/v1/access`, which says nothing of retries nor periods. */
function olderPayment(attempt: ServedAttempt): WidgetPayment {
    return {
        attempted_at: attempt.attempted_at,
        outcome: attempt.outcome,
        amount: attempt.amount,
        reason: attempt.reason,
        signature: attempt.signature,
        retry: null,
        retry_number: null,
        retries_allowed: null,
        period_start: null,
    };
}

type Payments = Omit<WidgetSubscriptionDetail, 'subscription' | 'upcoming'>;

function unlisted(code: string, message: string): Payments {
    return { payments: null, paid: null, payments_error: { code, message } };
}

/**
 * A subscription's own pull attempts and what it paid, from
 * `GET /v1/subscriptions/:id/attempts`. A Mesub that predates the route
 * (Mesub-io/backend#289) answers a 404 that names no code for it: its payments are then
 * read the older way, without a total.
 */
async function paymentsOf(
    client: Mesub,
    subscription: ServerSubscription,
    read: CallOptions,
): Promise<Payments> {
    try {
        const page = await client.subscriptions.attempts(subscription.id, {}, read);

        return { payments: page.data.map(payment), paid: page.paid, payments_error: null };
    } catch (error) {
        if (!(error instanceof MesubError) || brokenIntegration(error)) throw error;
        // No such route, not no such subscription: that one names its code.
        if (error.status === 404 && error.apiCode === null) {
            return olderPaymentsOf(client, subscription, read);
        }

        // The subscription was read: it is answered without them, so the dialog still opens.
        return unlisted(error.apiCode ?? error.code, said(error));
    }
}

/**
 * The last pull attempts as a Mesub without the attempts route serves them:
 * through `/v1/access` only, five at most, for the subscription in force on
 * that wallet and plan, naming no id. They are this one's only when the
 * answer started when this one did. No total: five attempts are not one.
 */
async function olderPaymentsOf(
    client: Mesub,
    subscription: ServerSubscription,
    read: CallOptions,
): Promise<Payments> {
    const { plan, wallet, confirmed_at: confirmedAt } = subscription;
    const listed = (payments: WidgetPayment[]): Payments => ({
        payments,
        paid: null,
        payments_error: null,
    });

    // Never started, so never pulled: nothing to ask.
    if (confirmedAt === null && NEVER_STARTED.includes(subscription.status)) return listed([]);
    if (plan === null || !SLUG.test(plan)) {
        return unlisted('plan_without_slug', 'Its plan has no slug to read payments by.');
    }

    try {
        const answer = await client.access({ wallet }, plan, { attempts: true, ...read });
        const same =
            confirmedAt !== null &&
            answer.subscribed_since !== null &&
            Date.parse(answer.subscribed_since) === Date.parse(confirmedAt);

        if (!same) {
            return unlisted(
                'not_the_current_subscription',
                'This Mesub serves payments for the current subscription of a wallet on a plan only.',
            );
        }

        return listed(
            (answer.attempts ?? [])
                .map(olderPayment)
                .sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at)),
        );
    } catch (error) {
        if (!(error instanceof MesubError) || brokenIntegration(error)) throw error;

        return unlisted(error.apiCode ?? error.code, said(error));
    }
}

/**
 * Answers one request of the widget. `asked` is who your auth says is asking,
 * already normalised, or null for nobody; `email` their notices' address.
 *
 * Never throws for what the caller sent or what Mesub refused of the
 * customer's request: both are answered. An integration error is thrown to
 * the framework, which logs it and answers 500: Mesub refusing your API key
 * (its 401, never handed on as the customer's own) or something in front of
 * Mesub refusing your server (a 403 without Mesub's code), and anything that
 * is not a MesubError. The 401 answered here means nobody is signed in, only.
 */
export async function handleWidget(
    client: Mesub,
    request: WidgetRequest,
    asked: Asked | null,
    options: { email?: string | null | undefined; plans?: readonly string[] } = {},
): Promise<WidgetResponse> {
    const segments = request.path.split('?')[0]!.split('/').filter(Boolean);
    const method = request.method.toUpperCase();
    const read = bounded();

    try {
        // A plan is public: the page shows its price before anybody signs in.
        if (method === 'GET' && segments.length === 2 && segments[0] === 'plans') {
            const slug = segments[1]!;

            if (!SLUG.test(slug) || (options.plans && !options.plans.includes(slug))) {
                return refusal(404, 'plan_not_found', 'No such plan.');
            }

            const plan = await planOf(client, slug, read);

            return plan
                ? { status: 200, body: plan }
                : refusal(404, 'plan_not_found', 'No such plan.');
        }

        if (segments[0] !== 'subscriptions') return NOT_FOUND();
        if (method !== 'GET' && method !== 'POST') {
            return refusal(405, 'method_not_allowed', 'GET or POST.');
        }
        if (!asked) return refusal(401, 'unauthenticated', 'Sign in first.');

        if (method === 'GET' && segments.length === 2) {
            const id = segments[1]!;

            if (!ID.test(id)) return NO_SUBSCRIPTION();

            // Theirs first: another customer's is not read any further.
            const subscription = await client.subscriptions.retrieve(id, read);
            if (!isTheirs(subscription, asked)) return NO_SUBSCRIPTION();

            const [upcoming, payments] = await Promise.all([
                upcomingOf(client, subscription, read),
                paymentsOf(client, subscription, read),
            ]);
            const detail: WidgetSubscriptionDetail = {
                subscription: shown(subscription),
                upcoming,
                ...payments,
            };

            return { status: 200, body: detail };
        }

        if (method === 'GET') {
            if (segments.length !== 1) return NOT_FOUND();

            const params = { ...customerParam(asked), limit: LIST_PAGE };
            let page = await client.subscriptions.list(params, read);
            const subscriptions = [...page.data];

            const more = () => page.has_more && page.data.length > 0;

            // One browser request is LIST_MAX_PAGES calls to Mesub at most.
            for (let pages = 1; more() && pages < LIST_MAX_PAGES; pages++) {
                page = await client.subscriptions.list(
                    { ...params, starting_after: page.data.at(-1)!.id },
                    read,
                );
                subscriptions.push(...page.data);
            }

            const list: WidgetSubscriptionList = {
                subscriptions: subscriptions.map(shown),
                has_more: more(),
            };

            return { status: 200, body: list };
        }

        // A JSON body cannot be sent by a plain form from another site.
        if (!request.contentType?.toLowerCase().startsWith('application/json')) {
            return refusal(415, 'unsupported_media_type', 'Send JSON.');
        }

        const body = fieldsOf(request.body) ?? {};

        if (segments.length === 1) {
            const { plan, wallet } = body;

            if (!isString(plan) || !SLUG.test(plan) || !isString(wallet)) {
                return refusal(400, 'invalid_request', 'A plan and a wallet are needed.');
            }
            if (options.plans && !options.plans.includes(plan)) {
                return refusal(404, 'plan_not_found', 'No such plan.');
            }
            // Named by wallet, the customer is that wallet: no other may be subscribed for them.
            if (asked.kind === 'wallet' && asked.value !== wallet) {
                return refusal(403, 'wallet_mismatch', 'Connect the wallet you signed in with.');
            }

            const email = asked.kind === 'email' ? asked.value : options.email;
            const created = await client.subscriptions.create({
                plan,
                wallet,
                ...(asked.kind === 'external_id' && { external_id: asked.value }),
                ...(isString(email) && { email }),
            });

            return { status: 201, body: created };
        }

        const id = segments[1]!;
        const step = segments.slice(2).join('/');

        if (!ID.test(id)) return NO_SUBSCRIPTION();

        const known = ['submit', ...ACTIONS, ...ACTIONS.map((action) => `${action}/confirm`)];
        if (!known.includes(step)) return NOT_FOUND();

        // Before anything is built or confirmed: is it theirs at all.
        const subscription = await client.subscriptions.retrieve(id, read);
        if (!isTheirs(subscription, asked)) return NO_SUBSCRIPTION();

        if (step === 'submit') {
            const { transaction, terms_signature: termsSignature } = body;

            if (!isString(transaction) || !isString(termsSignature)) {
                return refusal(
                    400,
                    'invalid_request',
                    'The signed transaction and the terms signature are needed.',
                );
            }

            const settled = await client.subscriptions.submit(id, {
                transaction,
                terms_signature: termsSignature,
            });

            return { status: 201, body: { ...settled, subscription: shown(settled.subscription) } };
        }

        const [action, confirm] = step.split('/') as [Action, 'confirm' | undefined];

        if (!confirm) {
            return { status: 201, body: await client.subscriptions[action](id) };
        }

        const { signature } = body;
        if (!isString(signature)) {
            return refusal(400, 'invalid_request', 'The signature of the transaction is needed.');
        }

        const confirmed = await client.subscriptions[CONFIRM[action]](id, { signature });

        return {
            status: 201,
            body: { ...confirmed, subscription: shown(confirmed.subscription) },
        };
    } catch (error) {
        if (!(error instanceof MesubError) || brokenIntegration(error)) throw error;
        // An unknown id is Mesub's 404, answered as ours: nothing tells the two apart.
        if (error.apiCode === 'subscription_not_found') return NO_SUBSCRIPTION();

        return fromMesub(error);
    }
}

const CONFIRM = {
    cancel: 'confirmCancel',
    resume: 'confirmResume',
    close: 'confirmClose',
} as const satisfies Record<Action, string>;

function customerParam(asked: Asked): Customer {
    if (asked.kind === 'wallet') return { wallet: asked.value };

    return asked.kind === 'email' ? { email: asked.value } : { external_id: asked.value };
}

/**
 * Who your auth says is asking, normalised as Mesub reads it. Null for
 * nobody; a value Mesub cannot be asked about is a broken integration, thrown.
 */
export async function widgetCustomer<Req>(
    request: Req,
    customer: WidgetCustomer<Req>,
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

/** Checked when the routes are built: without `customer` they would serve anybody. */
export function checkWidgetOptions<Req>(options: WidgetRoutesOptions<Req>): void {
    if (typeof options?.customer !== 'function') {
        throw new TypeError(
            'The widget routes need `customer`: a function of the request returning who is signed in.',
        );
    }
    if (options.plans !== undefined && !options.plans.every((plan) => SLUG.test(plan))) {
        throw new TypeError('`plans` is a list of plan slugs.');
    }
}
