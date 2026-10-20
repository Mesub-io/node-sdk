import type { BlockedReason } from './answer.js';
import { MesubError } from './errors.js';
import { numberOf } from './options.js';
import type { ServerSubscription } from './subscriptions.js';
import { webhookEventFrom } from './validate.js';

/**
 * Webhooks, as Mesub-io/backend#144 sends them: Standard Webhooks
 * (https://www.standardwebhooks.com), a POST whose body is signed with the
 * endpoint's secret. Since Mesub-io/backend#482 the body is the event, as
 * `GET /v1/events` serves it. The types copy the back's `event-body.ts`,
 * `webhook-payload.ts`, `webhook-events.ts` and `pull-events.ts`, which stay
 * the source of truth. Snake case, as the API serves it.
 */

/** A Fetch `Headers` (Next, route handlers) or Node's plain object (Express). */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

/** What every signing secret starts with, as the endpoint's dashboard page shows it. */
const SECRET_PREFIX = 'whsec_';

/** Standard Webhooks' default: how far `webhook-timestamp` may be from now, either way. */
const DEFAULT_TOLERANCE = 5 * 60 * 1000;

/** `webhook-timestamp`: Unix seconds, digits only. */
const TIMESTAMP = /^[0-9]{1,15}$/;

/** The v1 events an endpoint subscribes to, and `test`, sent from the dashboard on request. */
export type WebhookEventType = WebhookEvent['type'];

/** The v1 events `GET /v1/events` serves: every type but `test`. */
export type EventType = MesubEvent['type'];

/** The Solana network a subscription is on, as `/v1` spells it. */
export type EventNetwork = 'devnet' | 'mainnet-beta';

/**
 * One event, as `GET /v1/events` serves it and its webhooks carry it
 * (Mesub-io/backend#482): written once, the same bytes for every endpoint,
 * every retry and every read.
 */
interface EventOf<Type extends string, Detail> {
    /**
     * The event's own id, the same for every endpoint and every delivery:
     * what `events.retrieve` takes.
     */
    id: string;
    object: 'event';
    type: Type;
    /** When the event happened (ISO 8601), not when it was sent. */
    created_at: string;
    /** The Solana network the subscription is on. */
    network: EventNetwork;
    /** The `Mesub-Version` `data` and `detail` are written in, kept with the body. */
    api_version: string;
    /**
     * Its place among this subscription's events (Mesub-io/backend#502): 1,
     * 2, 3... in the order they happened, two events of one change included.
     * Deliveries arrive in any order: apply one subscription's events by
     * `sequence`, and skip one lower than the last you applied for it.
     * Absent on a body written before Mesub numbered events, and on one it
     * could not number: such an event cannot be placed, so read the
     * subscription now (`subscriptions.retrieve` or `access`) rather than
     * applying its `data`. Always 1 on a test delivery.
     */
    sequence?: number;
    /**
     * The subscription as it stood right after the change that raised the
     * event, as `GET /v1/subscriptions/:id` would have answered it then,
     * however late the delivery. Events raised by one change share it:
     * `detail` says what each is about.
     */
    data: ServerSubscription;
    /** What the event is about, beyond its type. */
    detail: Detail;
}

/**
 * One event as `verify` hands it back: the body Mesub signed, and
 * `delivery_id`, its `webhook-id` header.
 *
 * A body written before the event shape (before `available_since`, see
 * `events.list`) keeps the shape it was sent in, `{ type, created_at, data }`
 * with the detail inside `data`. It is handed back in this shape all the
 * same: `detail` moved to the top, and `id`, `network` and `api_version`
 * null, since it carried none. Its `data` is the subscription as it stood at
 * the delivery's first attempt.
 */
interface WebhookEventOf<Type extends string, Detail> extends Omit<
    EventOf<Type, Detail>,
    'id' | 'network' | 'api_version'
> {
    /** The event's id, as `EventOf`'s; null on a body written in the older shape. */
    id: string | null;
    /**
     * The delivery's id, from the `webhook-id` header: one per event and per
     * endpoint, the same on every retry and resend. Drop a delivery you
     * already handled by it; across endpoints, by `id`.
     */
    delivery_id: string;
    /** Null on a body written in the older shape. */
    network: EventNetwork | null;
    /** Null on a body written in the older shape. */
    api_version: string | null;
    /**
     * True on a body sent by hand from the dashboard: the `test` event, or
     * a sample of a real type on a made-up subscription (`sub_test`,
     * `user_123`), with the id `evt_test`. Absent on a real event. Change
     * nothing for it.
     */
    test?: true;
}

/** No detail: the subscription says it all. */
export type NoDetail = Record<string, never>;

/** `subscription.created`: the first payment landed. */
export interface CreatedDetail {
    /** On a wallet coming back after a stop, the subscription it replaces. */
    previous_id?: string;
    /**
     * What the first payment paid (Mesub-io/backend#509). Null when Mesub
     * recorded none at the confirmation (a period paid only in part, which
     * the next charge collects); absent on an event written before it.
     */
    first_payment?: FirstPayment | null;
}

/** The first payment of a subscription: the transfer its own transaction carried. */
export interface FirstPayment {
    /** In the token's smallest unit, as a string. */
    amount: string;
    mint: string | null;
    /** The transaction that paid it. */
    signature: string | null;
    /**
     * What the receiver's account got of it: `amount` less the fee a
     * Token-2022 mint withholds. Null when not known, absent from a Mesub that
     * predates it.
     */
    amount_received?: string | null;
}

/**
 * `subscription.ended`: `changed_at` only on a cancellation that reached its
 * end (Mesub-io/backend#509), its expiry to the millisecond, the moment
 * `data` describes. Absent on any other end.
 */
export interface EndedDetail {
    changed_at?: string;
    /**
     * `cancelled` on a cancellation that reached its end, as `data.end_reason`
     * says it (Mesub-io/backend#511); absent otherwise, and on an older event.
     */
    end_reason?: 'cancelled';
}

/**
 * `subscription.renewed`: a period paid. Amounts in the mint's base units, as
 * strings. It can come late: a transfer whose send failed may land later, and
 * Mesub sends `renewed` then. By that time the subscription may no longer be
 * `active`. Ask `hasAccess` before granting access.
 */
export interface RenewedDetail {
    amount: string;
    mint: string;
    period_start: string;
    period_end: string;
    /** The transaction that paid it. */
    signature: string;
}

/** `subscription.payment_failed`: a pull missed, and what comes next. */
export interface PaymentFailedDetail {
    /** Why, e.g. `insufficient_balance`: an attempt's reason (`ServedAttempt`). */
    reason: string;
    amount: string;
    mint: string;
    /** The period it was for; null when unknown. */
    period_start: string | null;
    period_end: string | null;
    /**
     * When Mesub retries; null when it will not (the plan ends before the
     * retry, among others), or on Free, where retries are by hand.
     */
    next_retry_at: string | null;
    /** Free only: when hand retries close, the plan's end when that comes first. */
    retry_deadline: string | null;
    /**
     * Pulls still to come before the subscription stops, the next one
     * included; 0 with `next_retry_at` null when the plan ends before any.
     */
    retries_left: number;
    /** Who retries: Mesub on its schedule, or you by hand (Free). Null once none is left. */
    retry_mode: 'scheduled' | 'manual' | null;
}

/**
 * `subscription.stopped`: no more pulls. `data.stop_reason` says why it
 * stopped, the reading a program branches on.
 */
export interface StoppedDetail {
    /** Why, e.g. `insufficient_balance` or, on Free, `retry_deadline_passed`. */
    reason: string;
}

/**
 * Why the coming charge would not pay: the wallet holds too little or has no
 * account of the token (`balance`), or Mesub's approval can no longer move
 * the tokens (`authority`). One newer than this release is handed back as it is.
 */
export type RenewalIssue = 'balance' | 'authority';

/**
 * `subscription.renewal_upcoming`: the charge due next, and whether the wallet
 * can pay it as it stood at the event's `created_at`. A reading, not a promise.
 */
export interface RenewalUpcomingDetail {
    can_pay: boolean;
    /** Why not; null when it can. */
    renewal_issue: RenewalIssue | null;
    amount: string;
    mint: string;
    /** When the charge is due. */
    due_at: string;
}

/**
 * `subscription.access_granted` and `subscription.access_revoked`: when
 * access actually changed. A date that passed with nothing else happening
 * (the end of a paid period, of a cancellation, of the plan) is that date to
 * the millisecond, even when Mesub wrote the event later; `created_at` is
 * when it was written.
 */
export interface AccessChangedDetail {
    changed_at: string;
    /**
     * Why the subscription's charges were held when access changed, in the
     * words of `data.blocked_reason`; null when they were not. Absent on an
     * event written before Mesub-io/backend#511. Keep a default branch: Mesub
     * may add a reason.
     */
    blocked_reason?: BlockedReason | null;
    /**
     * On `access_revoked`, the date access ended: the end of a paid period,
     * of a cancellation, of the plan, or of the access a held subscription
     * keeps; never after `changed_at`, and null when access ended with no
     * date of its own (a stop). On `access_granted`, on a held subscription,
     * the date access ends if nothing is collected by then; null otherwise.
     * Absent on an event written before Mesub-io/backend#511.
     */
    access_until?: string | null;
}

/** Each event type and its `detail`. */
interface EventDetails {
    'subscription.created': CreatedDetail;
    'subscription.renewal_upcoming': RenewalUpcomingDetail;
    'subscription.renewed': RenewedDetail;
    'subscription.payment_failed': PaymentFailedDetail;
    'subscription.stopped': StoppedDetail;
    'subscription.cancelled': NoDetail;
    'subscription.resumed': NoDetail;
    'subscription.ended': EndedDetail;
    'subscription.expired': NoDetail;
    'subscription.access_granted': AccessChangedDetail;
    'subscription.access_revoked': AccessChangedDetail;
    'subscription.paused': NoDetail;
    'subscription.unpaused': NoDetail;
}

/**
 * Every event `GET /v1/events` serves. Narrow it with `switch (event.type)`,
 * and keep a default branch: a type newer than this release is handed back
 * too, its subscription checked.
 */
export type MesubEvent = {
    [Type in keyof EventDetails]: EventOf<Type, EventDetails[Type]>;
}[keyof EventDetails];

export type SubscriptionCreatedEvent = WebhookEventOf<'subscription.created', CreatedDetail>;
/** Once per period, in its last quarter and three days before the charge at most. */
export type SubscriptionRenewalUpcomingEvent = WebhookEventOf<
    'subscription.renewal_upcoming',
    RenewalUpcomingDetail
>;
export type SubscriptionRenewedEvent = WebhookEventOf<'subscription.renewed', RenewedDetail>;
export type SubscriptionPaymentFailedEvent = WebhookEventOf<
    'subscription.payment_failed',
    PaymentFailedDetail
>;
export type SubscriptionStoppedEvent = WebhookEventOf<'subscription.stopped', StoppedDetail>;
export type SubscriptionCancelledEvent = WebhookEventOf<'subscription.cancelled', NoDetail>;
export type SubscriptionResumedEvent = WebhookEventOf<'subscription.resumed', NoDetail>;
/**
 * Sent when the plan ends, is removed or replaced, and when a subscription is
 * closed. Once Mesub turns the access events on, also when a cancellation
 * reaches its end (Mesub-io/backend#509): `end_reason` `cancelled`,
 * `detail.changed_at` its expiry, usually within half an hour of it, after
 * that expiry's `subscription.access_revoked`. Closing it later sends it
 * again, `end_reason` `closed`: one subscription can end twice.
 */
export type SubscriptionEndedEvent = WebhookEventOf<'subscription.ended', EndedDetail>;
/** A checkout nobody signed in time. */
export type SubscriptionExpiredEvent = WebhookEventOf<'subscription.expired', NoDetail>;
/**
 * Access started (Mesub-io/backend#507): the subscription grants access now
 * and did not just before. Its first access, a payment that gives access
 * back, a resume after a cancellation ended. A renewal paid on time, or a
 * resume while the period runs, sends none. `data.access` is true.
 *
 * With `subscription.access_revoked`, the one pair to drive access from:
 * sent exactly when access changes, and every change sends one. Apply them
 * by `sequence`; the last one applied says whether the customer has access.
 * The other events say why. Off until Mesub turns them on (`ACCESS_EVENTS`).
 */
export type SubscriptionAccessGrantedEvent = WebhookEventOf<
    'subscription.access_granted',
    AccessChangedDetail
>;
/**
 * Access ended (Mesub-io/backend#507): the subscription grants no access now
 * and did just before. It stopped or ended, a cancellation or the plan
 * reached its end, or a blocked collection reached its `access_until`. For a
 * date that passed, sent a few seconds after it. `data.access` is false.
 * Off until Mesub turns it on.
 */
export type SubscriptionAccessRevokedEvent = WebhookEventOf<
    'subscription.access_revoked',
    AccessChangedDetail
>;
/**
 * A seat parked (Mesub-io/backend#509): the project holds more subscribers
 * than its tier allows, and Mesub stopped charging the newest. Not a pause
 * the subscriber asked for; the status stays. `data.paused` is true,
 * `data.next_charge_at` null; access runs to the end of the paid period,
 * and its `subscription.access_revoked` comes then. Off until Mesub turns
 * the access events on.
 */
export type SubscriptionPausedEvent = WebhookEventOf<'subscription.paused', NoDetail>;
/**
 * A parked seat back (Mesub-io/backend#509): the tier has room again, and
 * Mesub charges it again. `data.paused` is false; a
 * `subscription.access_granted` follows when its access had ended. Off until
 * Mesub turns the access events on.
 */
export type SubscriptionUnpausedEvent = WebhookEventOf<'subscription.unpaused', NoDetail>;
/**
 * Sent from the dashboard on request, with a made-up subscription (`sub_test`).
 * The dashboard also sends samples of the other types, with `test: true`.
 */
export type TestEvent = WebhookEventOf<'test', NoDetail>;

/**
 * Every event Mesub sends. Narrow it with `switch (event.type)`, and keep a
 * default branch: an event type newer than this release is handed back too,
 * its subscription checked, typed as one of these.
 */
export type WebhookEvent =
    | SubscriptionCreatedEvent
    | SubscriptionRenewalUpcomingEvent
    | SubscriptionRenewedEvent
    | SubscriptionPaymentFailedEvent
    | SubscriptionStoppedEvent
    | SubscriptionCancelledEvent
    | SubscriptionResumedEvent
    | SubscriptionEndedEvent
    | SubscriptionExpiredEvent
    | SubscriptionAccessGrantedEvent
    | SubscriptionAccessRevokedEvent
    | SubscriptionPausedEvent
    | SubscriptionUnpausedEvent
    | TestEvent;

/** The body as received, never parsed: a string, a Buffer or any Uint8Array, an ArrayBuffer. */
export type WebhookBody = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
    /**
     * The endpoint's signing secret, `whsec_...`. Defaults to the client's
     * `webhookSecret`, then to `process.env.MESUB_WEBHOOK_SECRET`.
     */
    secret?: string;
    /**
     * How far `webhook-timestamp` may be from now, either way, in
     * milliseconds, above 0: older is refused as a replay. Defaults to 5 minutes.
     */
    tolerance?: number;
}

/**
 * Checks a webhook Mesub sent and hands back its event: the signature over
 * the raw body, against the endpoint's secret, then the timestamp, then the
 * body's shape.
 *
 * Throws a MesubError `invalid_webhook` when it is not Mesub's, or not now:
 * a header missing, no signature matching, a timestamp outside `tolerance`.
 * Answer it with a 400.
 *
 * Throws `unexpected` for a body Mesub signed that this release cannot read.
 * Never answer it with a 400. Log it, update `@mesub/node`, and answer a
 * 5xx: Mesub retries the same body for 3 days, so the event gets through
 * once the update is out. Past 3 days of failures, Mesub disables the
 * endpoint.
 *
 * A TypeError is an integration error: a body already parsed, no secret,
 * one that is not `whsec_...`.
 */
export async function verifyWebhook(
    body: WebhookBody,
    headers: HeaderSource,
    options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
    return verify(body, headers, options, undefined);
}

/** `mesub.webhooks`: `verifyWebhook` with the client's own secret. */
export class Webhooks {
    readonly #secret: string | undefined;
    readonly #received: (event: WebhookEvent) => Promise<void>;

    /** @internal */
    constructor(secret: string | undefined, received: (event: WebhookEvent) => Promise<void>) {
        this.#secret = secret;
        this.#received = received;
    }

    /**
     * `verifyWebhook`, with `webhookSecret` unless `options.secret` says
     * otherwise. A verified event also drops every access answer cached for
     * its customer, the yes and the no, so the next check asks Mesub.
     * Three drop nothing: `subscription.renewal_upcoming`, which moves no
     * access, the `test` event, and any body with `test: true`, whose
     * subscription is made up.
     */
    async verify(
        body: WebhookBody,
        headers: HeaderSource,
        options: VerifyWebhookOptions = {},
    ): Promise<WebhookEvent> {
        const event = await verify(body, headers, options, this.#secret);

        // A charge to come changes no answer: dropping it would cost the outage fallback.
        // A sample from the dashboard names a made-up customer: it moves nobody's access.
        const moves =
            event.test !== true &&
            event.type !== 'test' &&
            event.type !== 'subscription.renewal_upcoming';

        if (moves) await this.#received(event);

        return event;
    }
}

async function verify(
    body: WebhookBody,
    headers: HeaderSource,
    options: VerifyWebhookOptions,
    fallback: string | undefined,
): Promise<WebhookEvent> {
    const key =
        options.secret !== undefined || fallback !== undefined
            ? keyOf(options.secret ?? fallback, 'secret')
            : keyOf(envSecret(), 'MESUB_WEBHOOK_SECRET');
    const tolerance = numberOf('tolerance', options.tolerance, DEFAULT_TOLERANCE);
    const bytes = bytesOf(body);

    if (typeof headers !== 'object' || headers === null) {
        throw new TypeError('headers must be the request headers: a Headers or a plain object.');
    }

    const id = headerIn(headers, 'webhook-id');
    const timestamp = headerIn(headers, 'webhook-timestamp');
    const signatures = headerIn(headers, 'webhook-signature');

    if (!id || !timestamp || !signatures) {
        const missing = [
            !id && 'webhook-id',
            !timestamp && 'webhook-timestamp',
            !signatures && 'webhook-signature',
        ].filter(Boolean);

        throw invalid(`The webhook has no ${missing.join(', ')} header: it is not one of Mesub's.`);
    }
    if (!TIMESTAMP.test(timestamp)) {
        throw invalid('The webhook-timestamp header is not a number of seconds.');
    }

    const expected = await signatureOf(key, id, timestamp, bytes);
    // Every candidate is compared, whichever matches: the time taken says nothing.
    let matched = false;
    for (const candidate of signatures.split(' ')) {
        const [version, encoded] = candidate.split(',');
        const given = version === 'v1' && encoded !== undefined ? fromBase64(encoded) : null;

        if (given !== null && sameBytes(given, expected)) matched = true;
    }

    if (!matched) {
        throw invalid(
            "No signature of the webhook matches the secret: not Mesub's, another endpoint's " +
                'secret, or a body changed on its way (parsed then serialized again?). ' +
                'Verify the raw body.',
        );
    }

    // After the signature: a stale one is Mesub's, replayed or late on a clock.
    const skew = Date.now() - Number(timestamp) * 1000;
    if (Math.abs(skew) > tolerance) {
        throw invalid(
            `The webhook was signed ${Math.round(Math.abs(skew) / 1000)} s ` +
                `${skew > 0 ? 'ago' : 'ahead of this clock'}, beyond the ${tolerance / 1000} s ` +
                "tolerance: a replay, or this server's clock is off.",
        );
    }

    return webhookEventFrom(parsed(body, bytes), id);
}

/** The body as signed: the bytes received, or a string's UTF-8. */
function bytesOf(body: WebhookBody): Uint8Array<ArrayBuffer> {
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return new Uint8Array(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));

    throw new TypeError(
        'body must be the raw body as received, a string or a Buffer, never parsed: the ' +
            'signature is over its exact bytes. With Express, read it with ' +
            "express.raw({ type: 'application/json' }); in a Next route, await request.text().",
    );
}

/** The JSON Mesub signed. Not JSON, or not UTF-8, is a body this release cannot read. */
function parsed(body: WebhookBody, bytes: Uint8Array): unknown {
    try {
        const text =
            typeof body === 'string'
                ? body
                : new TextDecoder('utf-8', { fatal: true }).decode(bytes);

        return JSON.parse(text);
    } catch (cause) {
        throw new MesubError('Mesub sent a webhook whose body is not JSON.', {
            status: null,
            code: 'unexpected',
            cause,
        });
    }
}

/** `whsec_` then base64: the bytes after the prefix are the HMAC key. */
function keyOf(secret: unknown, name: string): Uint8Array<ArrayBuffer> {
    if (secret === undefined || secret === '') {
        throw new TypeError(
            typeof process === 'undefined'
                ? 'Missing Mesub webhook secret: there is no process.env here, so pass it: ' +
                      '`{ secret: env.MESUB_WEBHOOK_SECRET }` or `new Mesub({ webhookSecret })`.'
                : 'Missing Mesub webhook secret: pass `{ secret }` or ' +
                      '`new Mesub({ webhookSecret })`, or set MESUB_WEBHOOK_SECRET.',
        );
    }

    const key =
        typeof secret === 'string' && secret.startsWith(SECRET_PREFIX)
            ? fromBase64(secret.slice(SECRET_PREFIX.length))
            : null;

    if (key === null || key.length === 0) {
        throw new TypeError(
            `${name} must be the endpoint's signing secret, whsec_..., from its page in the ` +
                'Mesub dashboard' +
                (typeof secret === 'string' && /^(SUB|PUB)_/.test(secret)
                    ? ', not an API key.'
                    : '.'),
        );
    }

    return key;
}

/** Checks the client's `webhookSecret`, or MESUB_WEBHOOK_SECRET, once at `new Mesub()`. */
export function webhookSecretOf(given: unknown): string | undefined {
    if (given !== undefined && typeof given !== 'string') {
        throw new TypeError('webhookSecret must be a string.');
    }

    const secret = given || envSecret();

    if (secret) keyOf(secret, given ? 'webhookSecret' : 'MESUB_WEBHOOK_SECRET');

    return secret || undefined;
}

function envSecret(): string | undefined {
    return typeof process === 'undefined' ? undefined : process.env?.['MESUB_WEBHOOK_SECRET'];
}

/** A header from a Fetch `Headers`, or a plain object whatever the case of its names. */
function headerIn(headers: HeaderSource, name: string): string | undefined {
    if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name) ?? undefined;
    }

    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
    }

    return undefined;
}

/** HMAC-SHA256 of `id.timestamp.body`, as Standard Webhooks signs it. */
async function signatureOf(
    key: Uint8Array<ArrayBuffer>,
    id: string,
    timestamp: string,
    body: Uint8Array,
): Promise<Uint8Array> {
    const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix);
    signed.set(body, prefix.length);

    const hmac = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );

    return new Uint8Array(await crypto.subtle.sign('HMAC', hmac, signed));
}

/**
 * The three headers Mesub sends with a body, signed with that secret: for
 * `@mesub/node/testing`, and the tests.
 *
 * @internal
 */
export async function signedHeaders(
    secret: string,
    id: string,
    timestamp: number,
    body: string,
): Promise<Record<string, string>> {
    const key = keyOf(secret, 'secret');
    const signature = await signatureOf(key, id, String(timestamp), new TextEncoder().encode(body));

    return {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': `v1,${toBase64(signature)}`,
    };
}

/** Constant time over equal lengths; a length is no secret. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;

    let difference = 0;
    for (let index = 0; index < a.length; index += 1) {
        difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
    }

    return difference === 0;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
    try {
        return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    } catch {
        return null;
    }
}

function toBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function invalid(message: string): MesubError {
    return new MesubError(message, { status: null, code: 'invalid_webhook' });
}
