import type { Customer, ServedAttempt } from './answer.js';
import type { Mesub } from './client.js';
import { type Asked, customerOf } from './customer.js';
import { MesubError } from './errors.js';
import type { ServerSubscription } from './subscriptions.js';

/**
 * The routes `@mesub/react` calls on your own server, so the browser never
 * talks to Mesub nor holds a key: a plan to show, the customer's
 * subscriptions, one of them with its last payments, and each step of
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

const ACTIONS = ['cancel', 'resume', 'close'] as const;
type Action = (typeof ACTIONS)[number];

/** An id as Mesub writes them: nothing that could rewrite the path. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function refusal(status: number, code: string, message: string): WidgetResponse {
    return { status, body: { error: { code, message } } };
}

const NOT_FOUND = () => refusal(404, 'not_found', 'Nothing here.');
const NO_SUBSCRIPTION = () => refusal(404, 'subscription_not_found', 'No such subscription.');

/** A Mesub refusal, handed on with its own status and code, and nothing of the key. */
function fromMesub(error: MesubError): WidgetResponse {
    // No answer from Mesub: your server reached nobody, which is a 502 of yours.
    const status = error.status ?? 502;
    const retry =
        error.retryAfter === null
            ? undefined
            : { 'Retry-After': String(Math.ceil(error.retryAfter / 1000)) };

    return {
        status,
        body: { error: { code: error.apiCode ?? error.code, message: error.message } },
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

/** One pull attempt as the browser gets it: the fields Mesub serves, and no other. */
export interface WidgetPayment {
    attempted_at: string;
    /** `PAID`, `SKIPPED`, `REJECTED` or `BLOCKED` today; a newer one is handed on as is. */
    outcome: string;
    /** What was asked for, in the mint's smallest unit. */
    amount: string;
    /** Mesub's short reason, null on a paid one. */
    reason: string | null;
    /** Null when nothing was sent. */
    signature: string | null;
}

/** What `GET /subscriptions/:id` answers. */
export interface WidgetSubscriptionDetail {
    subscription: Omit<ServerSubscription, 'email' | 'external_id'>;
    /**
     * The last pull attempts, newest first: as many as Mesub serves, five
     * today, so never a full history. Null when they could not be read or
     * are not this subscription's: `payments_error` says which.
     */
    payments: WidgetPayment[] | null;
    /**
     * The paid ones among `payments`, not a total since the subscription
     * began. `amount` is their sum in the mint's smallest unit, null if one
     * could not be read as a whole number.
     */
    listed_paid: { count: number; amount: string | null } | null;
    /** Why `payments` is null; null otherwise. */
    payments_error: { code: string; message: string } | null;
}

/** The statuses nothing is ever pulled in: a checkout that never started. */
const NEVER_STARTED = ['pending', 'expired', 'failed'];

function payment(attempt: ServedAttempt): WidgetPayment {
    return {
        attempted_at: attempt.attempted_at,
        outcome: attempt.outcome,
        amount: attempt.amount,
        reason: attempt.reason,
        signature: attempt.signature,
    };
}

type Payments = Omit<WidgetSubscriptionDetail, 'subscription'>;

function listed(payments: WidgetPayment[]): Payments {
    const paid = payments.filter((each) => each.outcome === 'PAID');
    const whole = paid.every((each) => /^\d+$/.test(each.amount));

    return {
        payments,
        listed_paid: {
            count: paid.length,
            amount: whole
                ? paid.reduce((sum, each) => sum + BigInt(each.amount), 0n).toString()
                : null,
        },
        payments_error: null,
    };
}

function unlisted(code: string, message: string): Payments {
    return {
        payments: null,
        listed_paid: null,
        payments_error: { code, message },
    };
}

/**
 * A subscription's last pull attempts. Mesub serves them through `/v1/access`
 * only, for the subscription in force on that wallet and plan, and names no
 * id: they are this one's only when the answer started when this one did.
 */
async function paymentsOf(client: Mesub, subscription: ServerSubscription): Promise<Payments> {
    const { plan, wallet, confirmed_at: confirmedAt } = subscription;

    // Never started, so never pulled: nothing to ask.
    if (confirmedAt === null && NEVER_STARTED.includes(subscription.status)) return listed([]);
    if (plan === null || !SLUG.test(plan)) {
        return unlisted('plan_without_slug', 'Its plan has no slug to read payments by.');
    }

    try {
        const answer = await client.access({ wallet }, plan, { attempts: true });
        const same =
            confirmedAt !== null &&
            answer.subscribed_since !== null &&
            Date.parse(answer.subscribed_since) === Date.parse(confirmedAt);

        if (!same) {
            return unlisted(
                'not_the_current_subscription',
                'Payments are served for the current subscription of a wallet on a plan only.',
            );
        }

        return listed(
            (answer.attempts ?? [])
                .map(payment)
                .sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at)),
        );
    } catch (error) {
        if (!(error instanceof MesubError)) throw error;

        // The subscription was read: it is answered without them, so the dialog still opens.
        return unlisted(error.apiCode ?? error.code, error.message);
    }
}

/**
 * Answers one request of the widget. `asked` is who your auth says is asking,
 * already normalised, or null for nobody; `email` their notices' address.
 *
 * Never throws for what the caller sent or what Mesub refused: both are
 * answered. An integration error (a bad API key is answered 401 by Mesub and
 * handed on; anything that is not a MesubError) is thrown to the framework.
 */
export async function handleWidget(
    client: Mesub,
    request: WidgetRequest,
    asked: Asked | null,
    options: { email?: string | null | undefined; plans?: readonly string[] } = {},
): Promise<WidgetResponse> {
    const segments = request.path.split('?')[0]!.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    try {
        // A plan is public: the page shows its price before anybody signs in.
        if (method === 'GET' && segments.length === 2 && segments[0] === 'plans') {
            const slug = segments[1]!;

            if (!SLUG.test(slug) || (options.plans && !options.plans.includes(slug))) {
                return refusal(404, 'plan_not_found', 'No such plan.');
            }

            return { status: 200, body: await client.plans.retrieve(slug) };
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
            const subscription = await client.subscriptions.retrieve(id);
            if (!isTheirs(subscription, asked)) return NO_SUBSCRIPTION();

            const detail: WidgetSubscriptionDetail = {
                subscription: shown(subscription),
                ...(await paymentsOf(client, subscription)),
            };

            return { status: 200, body: detail };
        }

        if (method === 'GET') {
            if (segments.length !== 1) return NOT_FOUND();

            const subscriptions: ServerSubscription[] = [];
            for await (const each of client.subscriptions.listAll(customerParam(asked))) {
                subscriptions.push(each);
            }

            return { status: 200, body: { subscriptions: subscriptions.map(shown) } };
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
        const subscription = await client.subscriptions.retrieve(id);
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
        if (!(error instanceof MesubError)) throw error;
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
