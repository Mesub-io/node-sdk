import { MesubError } from './errors.js';
import { numberOf } from './options.js';
import type { ServerSubscription } from './subscriptions.js';
import { webhookEventFrom } from './validate.js';

/**
 * Webhooks, as Mesub-io/backend#144 sends them: Standard Webhooks
 * (https://www.standardwebhooks.com), a POST whose body is signed with the
 * endpoint's secret. The types copy the back's `webhook-payload.ts`,
 * `webhook-events.ts` and `pull-events.ts`, which stay the source of truth.
 * Snake case, as the API serves it.
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

/**
 * One event as `verify` hands it back: the body Mesub signed, and `id`, the
 * `webhook-id` header. `data` is the subscription as `GET /v1/subscriptions/:id`
 * answers it when the delivery was first attempted, which may be later than
 * the event: `type`, `created_at` and `data.detail` are the event's own.
 */
interface WebhookEventOf<Type extends string, Detail> {
    /**
     * The `webhook-id` header: the same on every retry and resend of this
     * delivery, so a handler drops one it has already done. Another
     * endpoint gets the same event under its own id.
     */
    id: string;
    type: Type;
    /** When the event happened (ISO 8601), not when it was sent. */
    created_at: string;
    data: ServerSubscription & { detail: Detail };
}

/** No detail: the subscription says it all. */
export type NoDetail = Record<string, never>;

/** `subscription.created`: the first payment landed. */
export interface CreatedDetail {
    /** On a wallet coming back after a stop, the subscription it replaces. */
    previous_id?: string;
}

/** `subscription.renewed`: a period paid. Amounts in the mint's base units, as strings. */
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
    /** Why, e.g. `insufficient-balance`. */
    reason: string;
    amount: string;
    mint: string;
    /** The period it was for; null when unknown. */
    period_start: string | null;
    period_end: string | null;
    /** When Mesub retries; null when it will not, or on Free, where retries are by hand. */
    next_retry_at: string | null;
    /** Free only: when hand retries close. */
    retry_deadline: string | null;
    /** Pulls still to come before the subscription stops, the next one included. */
    retries_left: number;
    /** Who retries: Mesub on its schedule, or you by hand (Free). Null once none is left. */
    retry_mode: 'scheduled' | 'manual' | null;
}

/** `subscription.stopped`: no more pulls. */
export interface StoppedDetail {
    /** Why, e.g. `insufficient-balance` or `grace-ended`. */
    reason: string;
}

export type SubscriptionCreatedEvent = WebhookEventOf<'subscription.created', CreatedDetail>;
export type SubscriptionRenewedEvent = WebhookEventOf<'subscription.renewed', RenewedDetail>;
export type SubscriptionPaymentFailedEvent = WebhookEventOf<
    'subscription.payment_failed',
    PaymentFailedDetail
>;
export type SubscriptionStoppedEvent = WebhookEventOf<'subscription.stopped', StoppedDetail>;
export type SubscriptionCancelledEvent = WebhookEventOf<'subscription.cancelled', NoDetail>;
export type SubscriptionResumedEvent = WebhookEventOf<'subscription.resumed', NoDetail>;
export type SubscriptionEndedEvent = WebhookEventOf<'subscription.ended', NoDetail>;
/** A checkout nobody signed in time. */
export type SubscriptionExpiredEvent = WebhookEventOf<'subscription.expired', NoDetail>;
/** Sent from the dashboard on request, with a made-up subscription (`sub_test`). */
export type TestEvent = WebhookEventOf<'test', NoDetail>;

/**
 * Every event Mesub sends. Narrow it with `switch (event.type)`, and keep a
 * default branch: an event type newer than this release is handed back too,
 * its subscription checked, typed as one of these.
 */
export type WebhookEvent =
    | SubscriptionCreatedEvent
    | SubscriptionRenewedEvent
    | SubscriptionPaymentFailedEvent
    | SubscriptionStoppedEvent
    | SubscriptionCancelledEvent
    | SubscriptionResumedEvent
    | SubscriptionEndedEvent
    | SubscriptionExpiredEvent
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
     * milliseconds: older is refused as a replay. Defaults to 5 minutes.
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
 * Answer it with a 400. Throws `unexpected` for a body Mesub signed that
 * this release cannot read. A TypeError is an integration error: a body
 * already parsed, no secret, one that is not `whsec_...`.
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
     * otherwise. An event whose subscription grants access also drops the
     * client's cached no for that customer, as a submit that lands does.
     */
    async verify(
        body: WebhookBody,
        headers: HeaderSource,
        options: VerifyWebhookOptions = {},
    ): Promise<WebhookEvent> {
        const event = await verify(body, headers, options, this.#secret);

        if (event.type !== 'test') await this.#received(event);

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
    const tolerance = numberOf('tolerance', options.tolerance, DEFAULT_TOLERANCE, { zero: true });
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
