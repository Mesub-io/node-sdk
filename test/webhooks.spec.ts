import { createHmac } from 'node:crypto';

import { Mesub, MesubError, verifyWebhook, type WebhookEvent } from '../src/index.js';
import { FakeMesub, signWebhook } from '../src/testing.js';
import { signedHeaders } from '../src/webhooks.js';

const SECRET = 'whsec_bWVzdWItZmFrZS13ZWJob29rLWtleS0x';
const OTHER_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const NOW = 1_790_000_000;
const NOW_ISO = new Date(NOW * 1000).toISOString();
const WALLET = 'SysvarRent111111111111111111111111111111111';

/**
 * Mesub-io/backend `src/webhooks/webhook-signature.ts` at 880ce03, copied as
 * is: what the back signs every delivery with. If the two ever disagree,
 * this is where it shows.
 */
function backendSignatureOf(secret: string, id: string, timestamp: number, body: string): string {
    const SECRET_PREFIX = 'whsec_';
    const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
    const digest = createHmac('sha256', Buffer.from(encoded, 'base64'))
        .update(`${id}.${timestamp}.${body}`)
        .digest('base64');

    return `v1,${digest}`;
}

/** The back's `signedHeaders`, over the back's signature. */
function backendHeaders(secret: string, id: string, timestamp: number, body: string) {
    return {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': backendSignatureOf(secret, id, timestamp, body),
    };
}

/** The back's `TEST_SUBSCRIPTION` (webhook-payload.ts), the subscription a test delivery carries. */
const SUBSCRIPTION = {
    id: 'sub_test',
    status: 'active',
    paused: false,
    end_reason: null,
    late_reason: null,
    stop_reason: null,
    access: true,
    payment_status: 'paid',
    blocked_since: null,
    blocked_reason: null,
    plan: 'pro',
    wallet: '11111111111111111111111111111111',
    email: 'subscriber@example.com',
    external_id: 'user_123',
    current_period_start: '2026-01-01T00:00:00.000Z',
    current_period_end: '2026-01-31T00:00:00.000Z',
    next_charge_at: '2026-01-31T00:00:00.000Z',
    next_retry_at: null,
    retry_deadline: null,
    next_retry_number: null,
    retries_allowed: null,
    access_until: '2026-01-31T00:00:00.000Z',
    closable: false,
    closable_from: null,
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: '2026-01-01T00:00:00.000Z',
};

/** The event id the bodies below carry, as the back's `eventBody` writes one. */
const EVENT_ID = 'evt_cmg1x0evt0001';

/** As the back's `eventBody` renders a body (Mesub-io/backend#482), and the processor sends it. */
function body(type: string, detail: Record<string, unknown> = {}, data = SUBSCRIPTION): string {
    return JSON.stringify({
        id: EVENT_ID,
        object: 'event',
        type,
        created_at: '2026-01-15T12:00:00.000Z',
        network: 'devnet',
        api_version: '2026-10-02',
        data,
        detail,
    });
}

/**
 * As the back's `legacyPayload` wrote a body before Mesub-io/backend#482,
 * frozen since: no id, the detail inside `data`, and `data` as it stood
 * then, without the fields served since.
 */
function olderBody(type: string, detail: Record<string, unknown> = {}): string {
    const { stop_reason: _, closable: __, closable_from: ___, ...then } = SUBSCRIPTION;

    return JSON.stringify({
        type,
        created_at: '2026-01-15T12:00:00.000Z',
        data: { ...then, detail },
    });
}

/** Each v1 detail, in the shape the back's `pull-events.ts` and services write it. */
const DETAILS: Record<string, Record<string, unknown>> = {
    'subscription.created': {
        previous_id: 'sub_before',
        first_payment: {
            amount: '9990000',
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            signature: '5wHu1q',
        },
    },
    'subscription.renewed': {
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        period_start: '2026-01-31T00:00:00.000Z',
        period_end: '2026-03-02T00:00:00.000Z',
        signature: '5h3sig',
    },
    'subscription.payment_failed': {
        reason: 'insufficient_balance',
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        period_start: '2026-01-31T00:00:00.000Z',
        period_end: '2026-03-02T00:00:00.000Z',
        next_retry_at: '2026-02-01T00:00:00.000Z',
        retry_deadline: null,
        retries_left: 2,
        retry_mode: 'scheduled',
    },
    'subscription.stopped': { reason: 'retry_deadline_passed' },
    'subscription.renewal_upcoming': {
        can_pay: false,
        renewal_issue: 'balance',
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        due_at: '2026-01-31T00:00:00.000Z',
    },
    'subscription.cancelled': {},
    'subscription.resumed': {},
    'subscription.ended': {},
    'subscription.expired': {},
    'subscription.paused': {},
    'subscription.unpaused': {},
    'subscription.access_granted': {
        changed_at: '2026-01-15T12:00:00.000Z',
        blocked_reason: null,
        access_until: null,
    },
    'subscription.access_revoked': {
        changed_at: '2026-01-31T00:00:00.000Z',
        blocked_reason: 'receiver_account_frozen',
        access_until: '2026-01-31T00:00:00.000Z',
    },
    test: {},
};

async function failure(promise: Promise<unknown>): Promise<MesubError> {
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MesubError);
    return error as MesubError;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('verifyWebhook', () => {
    it('accepts what the back signs, and hands back the event, its webhook-id as delivery_id', async () => {
        const raw = body('subscription.renewed', DETAILS['subscription.renewed']);
        const headers = backendHeaders(SECRET, 'cmdelivery1', NOW, raw);

        const event = await verifyWebhook(raw, headers, { secret: SECRET });

        expect(event).toEqual({
            id: EVENT_ID,
            delivery_id: 'cmdelivery1',
            object: 'event',
            type: 'subscription.renewed',
            created_at: '2026-01-15T12:00:00.000Z',
            network: 'devnet',
            api_version: '2026-10-02',
            data: SUBSCRIPTION,
            detail: DETAILS['subscription.renewed'],
        });
        expect(event.test).toBeUndefined();
    });

    // The event's id is the same for every endpoint, the delivery's is not.
    it('keeps the event id when two endpoints get it under two delivery ids', async () => {
        const raw = body('subscription.cancelled');

        const first = await verifyWebhook(raw, backendHeaders(SECRET, 'cmdeliveryA', NOW, raw), {
            secret: SECRET,
        });
        const second = await verifyWebhook(
            raw,
            backendHeaders(OTHER_SECRET, 'cmdeliveryB', NOW, raw),
            { secret: OTHER_SECRET },
        );

        expect([first.id, first.delivery_id]).toEqual([EVENT_ID, 'cmdeliveryA']);
        expect([second.id, second.delivery_id]).toEqual([EVENT_ID, 'cmdeliveryB']);
    });

    // Bodies written before Mesub-io/backend#482 keep their shape, retries and resends too.
    describe('a body frozen in the older shape', () => {
        it('is handed back in the event shape, its detail at the top, with no event id', async () => {
            const raw = olderBody('subscription.renewed', DETAILS['subscription.renewed']);

            const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
                secret: SECRET,
            });

            expect(event).toEqual({
                id: null,
                delivery_id: 'cm1',
                object: 'event',
                type: 'subscription.renewed',
                created_at: '2026-01-15T12:00:00.000Z',
                network: null,
                api_version: null,
                // What it lacked read as from an older back: null, and false.
                data: { ...SUBSCRIPTION, stop_reason: null, closable: false, closable_from: null },
                detail: DETAILS['subscription.renewed'],
            });
        });

        it('keeps test: true, and checks the detail it carries inside data', async () => {
            const sample = JSON.stringify({ ...JSON.parse(olderBody('test')), test: true });
            const broken = olderBody('subscription.payment_failed', {
                ...DETAILS['subscription.payment_failed'],
                retries_left: null,
            });

            await expect(
                verifyWebhook(sample, backendHeaders(SECRET, 'cm1', NOW, sample), {
                    secret: SECRET,
                }),
            ).resolves.toMatchObject({ id: null, type: 'test', test: true, detail: {} });
            await expect(
                verifyWebhook(broken, backendHeaders(SECRET, 'cm2', NOW, broken), {
                    secret: SECRET,
                }),
            ).rejects.toMatchObject({
                code: 'unexpected',
                message: expect.stringContaining('data.detail.retries_left is not a whole number'),
            });
        });

        it('refuses one without its detail', async () => {
            const raw = JSON.stringify({
                type: 'subscription.cancelled',
                created_at: '2026-01-15T12:00:00.000Z',
                data: SUBSCRIPTION,
            });

            await expect(
                verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
            ).rejects.toMatchObject({
                code: 'unexpected',
                message: expect.stringContaining('data.detail is missing'),
            });
        });
    });

    it.each([
        ['an object that is not event', { object: 'subscription' }, 'object is not "event"'],
        ['no network', { network: undefined }, 'network is missing'],
        ['no api_version', { api_version: undefined }, 'api_version is missing'],
        ['no detail', { detail: undefined }, 'detail is missing'],
        ['an id that is not a string', { id: 7 }, 'id is not a string'],
        [
            'the detail still inside data',
            { data: { ...SUBSCRIPTION, detail: 1 }, detail: undefined },
            'detail is missing',
        ],
    ])('refuses an event body with %s', async (_label, over, problem) => {
        const raw = JSON.stringify({ ...JSON.parse(body('subscription.cancelled')), ...over });

        await expect(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        ).rejects.toMatchObject({
            code: 'unexpected',
            message: `Mesub sent a webhook this SDK cannot read: ${problem}.`,
        });
    });

    // The back's `samplePayload`: a real event type, sent by hand, `test: true` at the root.
    it('hands back test: true on a sample of a real event type', async () => {
        const raw = JSON.stringify({
            ...JSON.parse(body('subscription.stopped', DETAILS['subscription.stopped'])),
            test: true,
        });
        const headers = backendHeaders(SECRET, 'cmsample1', NOW, raw);

        const event = await verifyWebhook(raw, headers, { secret: SECRET });

        expect(event).toMatchObject({ type: 'subscription.stopped', test: true });
    });

    // `data` is a subscription: `paused` and `end_reason` are read like retrieve's.
    it('reads a body from a back that predates paused and end_reason', async () => {
        const { paused: _, end_reason: __, ...older } = SUBSCRIPTION;
        const raw = body('subscription.cancelled', {}, older as typeof SUBSCRIPTION);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data).toEqual(SUBSCRIPTION);
    });

    it('reads a body from a back that predates the blocked fields', async () => {
        const { blocked_since: _, blocked_reason: __, ...older } = SUBSCRIPTION;
        const raw = body('subscription.cancelled', {}, older as typeof SUBSCRIPTION);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data).toEqual(SUBSCRIPTION);
    });

    it('reads a body from a back that predates the retry numbers', async () => {
        const { next_retry_number: _, retries_allowed: __, ...older } = SUBSCRIPTION;
        const raw = body('subscription.cancelled', {}, older as typeof SUBSCRIPTION);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data).toEqual(SUBSCRIPTION);
    });

    it.each(['plan_removed', 'closed_elsewhere', 'authority_closed', 'closed', 'not_known_yet'])(
        'hands back an ended subscription whose end_reason is %s',
        async (end_reason) => {
            const ended = {
                ...SUBSCRIPTION,
                status: 'ended',
                end_reason: end_reason as never,
                access: false,
            };
            const raw = body('subscription.ended', {}, ended);

            const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
                secret: SECRET,
            });

            expect(event.data).toMatchObject({ status: 'ended', end_reason, paused: false });
        },
    );

    it('hands back a paused subscription', async () => {
        const raw = body('subscription.renewed', DETAILS['subscription.renewed'], {
            ...SUBSCRIPTION,
            paused: true,
        });

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data.paused).toBe(true);
    });

    it('signs the Standard Webhooks test vector as the spec libraries do', async () => {
        const headers = await signedHeaders(
            'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
            'msg_p5jXN8AQM9LWM0D4loKWxJek',
            1614265330,
            '{"test": 2432232314}',
        );

        expect(headers['webhook-signature']).toBe(
            'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
        );
    });

    it('verifies the Standard Webhooks test vector, then reads its body as not Mesub-shaped', async () => {
        vi.setSystemTime(1614265330 * 1000);

        const error = await failure(
            verifyWebhook(
                '{"test": 2432232314}',
                {
                    'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
                    'webhook-timestamp': '1614265330',
                    'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
                },
                { secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
            ),
        );

        // Past the signature and the timestamp: only the shape is refused.
        expect(error.code).toBe('unexpected');
        expect(error.message).toContain('type is missing');
    });

    it('agrees with the back on a secret it generates, byte for byte', async () => {
        const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64')}`;
        const raw = body('test');

        expect((await signedHeaders(secret, 'cm1', NOW, raw))['webhook-signature']).toBe(
            backendSignatureOf(secret, 'cm1', NOW, raw),
        );
    });

    it.each(Object.keys(DETAILS))('reads %s with its detail', async (type) => {
        const raw = body(type, DETAILS[type]);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.type).toBe(type);
        expect(event.detail).toEqual(DETAILS[type]);
        expect(event.data.id).toBe('sub_test');
    });

    it('reads a created event without previous_id, as the back sends a first subscription', async () => {
        const raw = body('subscription.created');

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.detail).toEqual({});
    });

    it('narrows the detail by type', async () => {
        const raw = body('subscription.payment_failed', DETAILS['subscription.payment_failed']);
        const event: WebhookEvent = await verifyWebhook(
            raw,
            backendHeaders(SECRET, 'cm1', NOW, raw),
            { secret: SECRET },
        );

        if (event.type !== 'subscription.payment_failed') throw new Error('narrowed wrong');
        expect(event.detail.retries_left).toBe(2);
    });

    it('narrows an access event to its changed_at, and hands back its sequence', async () => {
        const raw = JSON.stringify({
            ...JSON.parse(
                body('subscription.access_revoked', DETAILS['subscription.access_revoked'], {
                    ...SUBSCRIPTION,
                    status: 'ended',
                    access: false,
                }),
            ),
            sequence: 4,
        });
        const event: WebhookEvent = await verifyWebhook(
            raw,
            backendHeaders(SECRET, 'cm1', NOW, raw),
            { secret: SECRET },
        );

        if (event.type !== 'subscription.access_revoked') throw new Error('narrowed wrong');
        const changed: string = event.detail.changed_at;
        const sequence: number | undefined = event.sequence;
        expect([changed, sequence, event.data.access]).toEqual([
            '2026-01-31T00:00:00.000Z',
            4,
            false,
        ]);
    });

    // Before Mesub-io/backend#502, or an event it could not number.
    it('reads a body without sequence, and leaves it out', async () => {
        const raw = body('subscription.renewed', DETAILS['subscription.renewed']);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect('sequence' in event).toBe(false);
    });

    it.each([0, -1, 1.5, '2', null])('throws unexpected for a sequence of %j', async (sequence) => {
        const raw = JSON.stringify({
            ...JSON.parse(body('subscription.renewed', DETAILS['subscription.renewed'])),
            sequence,
        });

        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
    });

    it.each([
        ['null, nothing recorded at the confirmation', { first_payment: null }],
        [
            'without mint and signature',
            { first_payment: { amount: '1', mint: null, signature: null } },
        ],
    ])('reads a created event whose first_payment is %s', async (_what, detail) => {
        const raw = body('subscription.created', detail);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.detail).toEqual(detail);
    });

    it('reads an ended event of a cancellation that reached its end, and types its changed_at', async () => {
        const raw = body(
            'subscription.ended',
            { changed_at: '2026-01-31T00:00:00.000Z', end_reason: 'cancelled' },
            {
                ...SUBSCRIPTION,
                status: 'ended',
                end_reason: 'cancelled' as never,
                access: false,
            },
        );
        const event: WebhookEvent = await verifyWebhook(
            raw,
            backendHeaders(SECRET, 'cm1', NOW, raw),
            { secret: SECRET },
        );

        if (event.type !== 'subscription.ended') throw new Error('narrowed wrong');
        const { changed_at, end_reason }: { changed_at?: string; end_reason?: 'cancelled' } =
            event.detail;
        expect([changed_at, end_reason]).toEqual(['2026-01-31T00:00:00.000Z', 'cancelled']);
    });

    it.each([
        ['created', { first_payment: { amount: 9990000, mint: null, signature: null } }],
        ['created', { first_payment: { mint: null, signature: null } }],
        ['created', { first_payment: 'paid' }],
        ['ended', { changed_at: 'later' }],
        ['ended', { changed_at: NOW_ISO, end_reason: 4 }],
    ])('throws unexpected for a %s detail of the wrong shape: %j', async (type, detail) => {
        const raw = body(`subscription.${type}`, detail);

        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
    });

    // Before Mesub-io/backend#511 the detail carried changed_at alone.
    it('reads an access event without blocked_reason and access_until, and leaves them out', async () => {
        const raw = body('subscription.access_granted', { changed_at: '2026-01-15T12:00:00.000Z' });

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.detail).toEqual({ changed_at: '2026-01-15T12:00:00.000Z' });
    });

    it('hands back a blocked_reason newer than this release', async () => {
        const detail = { ...DETAILS['subscription.access_revoked'], blocked_reason: 'new_hold' };
        const raw = body('subscription.access_revoked', detail);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.detail).toEqual(detail);
    });

    it.each([
        ['missing', {}],
        ['not a date', { changed_at: 'later' }],
        ['with a blocked_reason not a string', { changed_at: NOW_ISO, blocked_reason: 4 }],
        ['with an access_until not a date', { changed_at: NOW_ISO, access_until: 'later' }],
    ])('throws unexpected for an access event whose changed_at is %s', async (_what, detail) => {
        const raw = body('subscription.access_granted', detail);

        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
    });

    // A plan that ends before the next pull (Mesub-io/backend#362): the
    // schedule has none left, and on Free hand retries close with the plan.
    it.each([
        [
            'no retry of the schedule is left',
            { next_retry_at: null, retry_deadline: null, retries_left: 0, retry_mode: null },
        ],
        [
            'hand retries close at the plan end',
            {
                next_retry_at: null,
                retry_deadline: '2026-01-20T00:00:00.000Z',
                retries_left: 3,
                retry_mode: 'manual',
            },
        ],
    ])('reads a payment_failed on a plan that is ending: %s', async (_label, next) => {
        const detail = { ...DETAILS['subscription.payment_failed'], ...next };
        const raw = body('subscription.payment_failed', detail);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.detail).toEqual(detail);
    });

    it('still refuses a payment_failed whose retries_left is missing or null', async () => {
        for (const retries_left of [undefined, null]) {
            const raw = body('subscription.payment_failed', {
                ...DETAILS['subscription.payment_failed'],
                retries_left,
            });

            await expect(
                verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
            ).rejects.toMatchObject({ code: 'unexpected' });
        }
    });

    it('reads a renewal_upcoming event, and types its detail', async () => {
        const raw = body('subscription.renewal_upcoming', DETAILS['subscription.renewal_upcoming']);
        const event: WebhookEvent = await verifyWebhook(
            raw,
            backendHeaders(SECRET, 'cm1', NOW, raw),
            { secret: SECRET },
        );

        if (event.type !== 'subscription.renewal_upcoming') throw new Error('narrowed wrong');
        const { can_pay, renewal_issue, amount, mint, due_at } = event.detail;
        expect({ can_pay, renewal_issue, amount, mint, due_at }).toEqual(
            DETAILS['subscription.renewal_upcoming'],
        );
    });

    it.each([null, 'frozen'])(
        'reads a renewal_issue of %j, one newer than this release too',
        async (issue) => {
            const raw = body('subscription.renewal_upcoming', {
                ...DETAILS['subscription.renewal_upcoming'],
                can_pay: issue === null,
                renewal_issue: issue,
            });

            const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
                secret: SECRET,
            });

            expect(event.detail).toMatchObject({ renewal_issue: issue });
        },
    );

    it('takes a Buffer, a Uint8Array and an ArrayBuffer as it takes a string', async () => {
        const raw = body('subscription.renewed', DETAILS['subscription.renewed']);
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);
        const bytes = new TextEncoder().encode(raw);
        const expected = await verifyWebhook(raw, headers, { secret: SECRET });

        for (const given of [Buffer.from(raw), bytes, bytes.buffer]) {
            await expect(verifyWebhook(given, headers, { secret: SECRET })).resolves.toEqual(
                expected,
            );
        }
    });

    it('verifies the bytes of a body with characters beyond ASCII', async () => {
        const raw = body('test', {}, { ...SUBSCRIPTION, email: 'zoë@example.com' });
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        const event = await verifyWebhook(Buffer.from(raw), headers, { secret: SECRET });

        expect(event.data.email).toBe('zoë@example.com');
    });

    it('takes a Fetch Headers, and a plain object whatever the case of its names', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);
        const shouted = {
            'Webhook-Id': headers['webhook-id'],
            'Webhook-Timestamp': headers['webhook-timestamp'],
            'WEBHOOK-SIGNATURE': [headers['webhook-signature']],
        };

        await expect(
            verifyWebhook(raw, new Headers(headers), { secret: SECRET }),
        ).resolves.toMatchObject({ delivery_id: 'cm1' });
        await expect(verifyWebhook(raw, shouted, { secret: SECRET })).resolves.toMatchObject({
            delivery_id: 'cm1',
        });
    });

    it('refuses a body changed after signing', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        const error = await failure(
            verifyWebhook(raw.replace('"access":true', '"access":false'), headers, {
                secret: SECRET,
            }),
        );

        expect(error.code).toBe('invalid_webhook');
        expect(error.status).toBeNull();
        expect(error.retryable).toBe(false);
    });

    it('refuses the same JSON serialized again with other spacing', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        const error = await failure(
            verifyWebhook(JSON.stringify(JSON.parse(raw), null, 2), headers, { secret: SECRET }),
        );

        expect(error.code).toBe('invalid_webhook');
    });

    it.each([
        ['the id', { 'webhook-id': 'cm2' }],
        ['the timestamp', { 'webhook-timestamp': String(NOW - 1) }],
    ])('refuses a signature over another %s', async (_what, changed) => {
        const raw = body('test');
        const headers = { ...backendHeaders(SECRET, 'cm1', NOW, raw), ...changed };

        expect((await failure(verifyWebhook(raw, headers, { secret: SECRET }))).code).toBe(
            'invalid_webhook',
        );
    });

    it("refuses another endpoint's secret", async () => {
        const raw = body('test');
        const headers = backendHeaders(OTHER_SECRET, 'cm1', NOW, raw);

        const error = await failure(verifyWebhook(raw, headers, { secret: SECRET }));

        expect(error.code).toBe('invalid_webhook');
        expect(error.message).toContain('No signature');
    });

    it('accepts any one matching signature among several, skipping other versions', async () => {
        const raw = body('test');
        const good = backendSignatureOf(SECRET, 'cm1', NOW, raw);
        const headers = {
            'webhook-id': 'cm1',
            'webhook-timestamp': String(NOW),
            'webhook-signature': [
                backendSignatureOf(OTHER_SECRET, 'cm1', NOW, raw),
                `v1a,${good.slice(3)}`,
                'v1,not base64 at all!',
                'v1',
                good,
            ].join(' '),
        };

        await expect(verifyWebhook(raw, headers, { secret: SECRET })).resolves.toMatchObject({
            delivery_id: 'cm1',
        });
    });

    it("verifies a rotation overlap's two signatures with the new secret or the old one alone", async () => {
        // Mesub-io/backend#506: the new secret's signature first, then the old one's.
        const raw = body('test');
        const headers = {
            'webhook-id': 'cm1',
            'webhook-timestamp': String(NOW),
            'webhook-signature': [
                backendSignatureOf(OTHER_SECRET, 'cm1', NOW, raw),
                backendSignatureOf(SECRET, 'cm1', NOW, raw),
            ].join(' '),
        };

        for (const secret of [OTHER_SECRET, SECRET]) {
            await expect(verifyWebhook(raw, headers, { secret })).resolves.toMatchObject({
                delivery_id: 'cm1',
            });
        }
    });

    it('refuses a header whose only right signature is under another version', async () => {
        const raw = body('test');
        const good = backendSignatureOf(SECRET, 'cm1', NOW, raw);
        const headers = {
            ...backendHeaders(SECRET, 'cm1', NOW, raw),
            'webhook-signature': `v2,${good.slice(3)}`,
        };

        expect((await failure(verifyWebhook(raw, headers, { secret: SECRET }))).code).toBe(
            'invalid_webhook',
        );
    });

    it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
        'refuses a webhook without %s, naming it',
        async (name) => {
            const raw = body('test');
            const headers: Record<string, string> = backendHeaders(SECRET, 'cm1', NOW, raw);
            delete headers[name];

            const error = await failure(verifyWebhook(raw, headers, { secret: SECRET }));

            expect(error.code).toBe('invalid_webhook');
            expect(error.message).toContain(name);
        },
    );

    it('refuses a timestamp that is not seconds', async () => {
        const raw = body('test');
        const headers = {
            ...backendHeaders(SECRET, 'cm1', NOW, raw),
            'webhook-timestamp': `${NOW}.5`,
        };

        expect((await failure(verifyWebhook(raw, headers, { secret: SECRET }))).code).toBe(
            'invalid_webhook',
        );
    });

    it.each([
        ['older', -301],
        ['newer', 301],
    ])('refuses a timestamp 5 minutes %s than now, as a replay', async (_what, shift) => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW + shift, raw);

        const error = await failure(verifyWebhook(raw, headers, { secret: SECRET }));

        expect(error.code).toBe('invalid_webhook');
        expect(error.message).toContain('301 s');
    });

    it.each([-300, 300])('accepts a timestamp %i s away, at the edge', async (shift) => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW + shift, raw);

        await expect(verifyWebhook(raw, headers, { secret: SECRET })).resolves.toBeDefined();
    });

    it('takes its own tolerance, in milliseconds', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW - 60, raw);

        await expect(
            verifyWebhook(raw, headers, { secret: SECRET, tolerance: 30_000 }),
        ).rejects.toMatchObject({ code: 'invalid_webhook' });
        await expect(() =>
            verifyWebhook(raw, headers, { secret: SECRET, tolerance: -1 }),
        ).rejects.toThrow(TypeError);
    });

    it('refuses a tolerance of 0, which no webhook could meet', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        // Sent this very second, and good under the default.
        await expect(verifyWebhook(raw, headers, { secret: SECRET })).resolves.toBeDefined();
        await expect(verifyWebhook(raw, headers, { secret: SECRET, tolerance: 0 })).rejects.toThrow(
            new TypeError('tolerance must be a number of milliseconds, above 0, not 0.'),
        );
    });

    it('reads the secret from MESUB_WEBHOOK_SECRET when none is passed', async () => {
        vi.stubEnv('MESUB_WEBHOOK_SECRET', SECRET);
        const raw = body('test');

        await expect(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw)),
        ).resolves.toBeDefined();
    });

    it('throws a TypeError without a secret, or with one that is not whsec_', async () => {
        vi.stubEnv('MESUB_WEBHOOK_SECRET', '');
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        await expect(verifyWebhook(raw, headers)).rejects.toThrow(/MESUB_WEBHOOK_SECRET/);
        await expect(verifyWebhook(raw, headers, { secret: 'SUB_live_key' })).rejects.toThrow(
            /not an API key/,
        );
        await expect(verifyWebhook(raw, headers, { secret: 'whsec_' })).rejects.toThrow(TypeError);
        await expect(verifyWebhook(raw, headers, { secret: 'whsec_!!' })).rejects.toThrow(
            TypeError,
        );
    });

    it('throws a TypeError for a body already parsed, pointing at the raw body', async () => {
        const raw = body('test');
        const headers = backendHeaders(SECRET, 'cm1', NOW, raw);

        await expect(
            verifyWebhook(JSON.parse(raw) as string, headers, { secret: SECRET }),
        ).rejects.toThrow(/express\.raw/);
        await expect(
            verifyWebhook(raw, null as unknown as Headers, { secret: SECRET }),
        ).rejects.toThrow(TypeError);
    });

    it('throws unexpected for a signed body that is not JSON', async () => {
        const raw = 'not json';
        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
    });

    it('throws unexpected for a signed body that is not UTF-8', async () => {
        const raw = Buffer.from([0x7b, 0xff, 0x7d]);
        const headers = {
            'webhook-id': 'cm1',
            'webhook-timestamp': String(NOW),
            'webhook-signature': `v1,${createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
                .update(Buffer.concat([Buffer.from(`cm1.${NOW}.`), raw]))
                .digest('base64')}`,
        };

        expect((await failure(verifyWebhook(raw, headers, { secret: SECRET }))).code).toBe(
            'unexpected',
        );
    });

    it.each([
        ['a subscription field', body('test', {}, { ...SUBSCRIPTION, access: 'yes' as never })],
        ['a boolean paused', body('test', {}, { ...SUBSCRIPTION, paused: 'no' as never })],
        ['a string end_reason', body('test', {}, { ...SUBSCRIPTION, end_reason: 4 as never })],
        ['a detail field', body('subscription.renewed', { amount: '1' })],
        [
            'a renewal_upcoming detail field',
            body('subscription.renewal_upcoming', {
                ...DETAILS['subscription.renewal_upcoming'],
                can_pay: undefined,
            }),
        ],
        [
            'a boolean can_pay',
            body('subscription.renewal_upcoming', {
                ...DETAILS['subscription.renewal_upcoming'],
                can_pay: 'no',
            }),
        ],
        [
            'a string renewal_issue',
            body('subscription.renewal_upcoming', {
                ...DETAILS['subscription.renewal_upcoming'],
                renewal_issue: 4,
            }),
        ],
        [
            'a dated due_at',
            body('subscription.renewal_upcoming', {
                ...DETAILS['subscription.renewal_upcoming'],
                due_at: 'soon',
            }),
        ],
        ['the detail', JSON.stringify({ type: 'test', created_at: NOW, data: SUBSCRIPTION })],
        ['a test flag that is true', JSON.stringify({ ...JSON.parse(body('test')), test: 'yes' })],
    ])('throws unexpected for a signed body missing %s', async (_what, raw) => {
        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
        expect(error.body).toEqual(JSON.parse(raw));
    });

    it('hands back an event type newer than this release, its subscription checked', async () => {
        const raw = body('subscription.trial_ending', { days: 3 });

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.type).toBe('subscription.trial_ending');
        expect(event.detail).toEqual({ days: 3 });
    });
});

describe('mesub.webhooks.verify', () => {
    it('verifies with the webhookSecret option', async () => {
        const mesub = new Mesub({ apiKey: 'SUB_test', webhookSecret: SECRET });
        const raw = body('test');

        await expect(
            mesub.webhooks.verify(raw, backendHeaders(SECRET, 'cm1', NOW, raw)),
        ).resolves.toMatchObject({ type: 'test' });
    });

    it('takes MESUB_WEBHOOK_SECRET by default, and a per-call secret over it', async () => {
        vi.stubEnv('MESUB_WEBHOOK_SECRET', SECRET);
        const mesub = new Mesub({ apiKey: 'SUB_test' });
        const raw = body('test');

        await expect(
            mesub.webhooks.verify(raw, backendHeaders(SECRET, 'cm1', NOW, raw)),
        ).resolves.toBeDefined();
        await expect(
            mesub.webhooks.verify(raw, backendHeaders(OTHER_SECRET, 'cm1', NOW, raw), {
                secret: OTHER_SECRET,
            }),
        ).resolves.toBeDefined();
    });

    it('needs no webhook secret until a webhook is verified', () => {
        vi.stubEnv('MESUB_WEBHOOK_SECRET', '');

        expect(() => new Mesub({ apiKey: 'SUB_test' })).not.toThrow();
    });

    it('refuses a malformed webhookSecret at new Mesub()', () => {
        expect(() => new Mesub({ apiKey: 'SUB_test', webhookSecret: 'SUB_test' })).toThrow(
            /webhookSecret must be/,
        );
        expect(
            () => new Mesub({ apiKey: 'SUB_test', webhookSecret: 42 as unknown as string }),
        ).toThrow(TypeError);

        vi.stubEnv('MESUB_WEBHOOK_SECRET', 'nope');
        expect(() => new Mesub({ apiKey: 'SUB_test' })).toThrow(/MESUB_WEBHOOK_SECRET must be/);
    });

    it('drops a cached no once an event says the subscription grants access', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.deny(WALLET, 'pro', { revalidate_after: 3600 });
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        fake.grant(WALLET, 'pro');
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);

        const { body: raw, headers } = await fake.webhook('subscription.created', {
            subscription: { wallet: WALLET, plan: 'pro' },
        });
        await mesub.webhooks.verify(raw, headers);

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
    });

    // A cached yes must not outlive the event that takes access away.
    it.each(['subscription.stopped', 'subscription.ended'] as const)(
        'drops a cached yes once a %s event comes',
        async (type) => {
            const fake = new FakeMesub();
            const mesub = fake.client();
            fake.grant(WALLET, 'pro', { revalidate_after: 300 });
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
            fake.deny(WALLET, 'pro');
            // Still the cached answer.
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            const { body: raw, headers } = await fake.webhook(type, {
                subscription: { wallet: WALLET, plan: 'pro', access: false },
            });
            await mesub.webhooks.verify(raw, headers);

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        },
    );

    it.each([
        ['subscription.access_revoked', false],
        ['subscription.access_granted', true],
    ] as const)('drops the cached answer once a %s event comes', async (type, access) => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        if (access) fake.deny(WALLET, 'pro', { revalidate_after: 3600 });
        else fake.grant(WALLET, 'pro', { revalidate_after: 300 });
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(!access);
        if (access) fake.grant(WALLET, 'pro');
        else fake.deny(WALLET, 'pro');

        const { body: raw, headers } = await fake.webhook(type, {
            subscription: { wallet: WALLET, plan: 'pro' },
        });
        await mesub.webhooks.verify(raw, headers);

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(access);
    });

    // It announces a charge and moves no access: the cached answer, and the outage fallback, stay.
    it('keeps the cached answer when a subscription.renewal_upcoming event comes', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.grant(WALLET, 'pro', { revalidate_after: 300 });
        await mesub.hasAccess(WALLET, 'pro');
        await mesub.accessList(WALLET);
        const asked = fake.requests.length;

        const { body: raw, headers } = await fake.webhook('subscription.renewal_upcoming', {
            subscription: { wallet: WALLET, plan: 'pro' },
        });
        await mesub.webhooks.verify(raw, headers);
        await mesub.hasAccess(WALLET, 'pro');
        await mesub.accessList(WALLET);

        expect(fake.requests.length).toBe(asked);
    });

    // The dashboard's sample of a real event type: a made-up subscription, flagged `test: true`.
    it('keeps the cached answer when a sample sent from the dashboard comes', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.grant(WALLET, 'pro', { revalidate_after: 300 });
        await mesub.hasAccess(WALLET, 'pro');
        await mesub.accessList(WALLET);
        const asked = fake.requests.length;

        const sample = await fake.webhook('subscription.stopped', {
            subscription: { wallet: WALLET, plan: 'pro', access: false },
        });
        const { body: raw, headers } = await signWebhook(
            { ...(JSON.parse(sample.body) as object), test: true },
            { secret: fake.webhookSecret },
        );
        const event = await mesub.webhooks.verify(raw, headers);
        await mesub.hasAccess(WALLET, 'pro');
        await mesub.accessList(WALLET);

        const flagged: true | undefined = event.test;
        expect(flagged).toBe(true);
        expect(fake.requests.length).toBe(asked);
    });

    it('keeps the cached answer of another customer and of another plan', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        const OTHER = 'SysvarC1ock11111111111111111111111111111111';
        fake.grant(OTHER, 'pro', { revalidate_after: 300 });
        fake.grant(WALLET, 'team', { revalidate_after: 300 });
        await mesub.hasAccess(OTHER, 'pro');
        await mesub.hasAccess(WALLET, 'team');
        const asked = fake.requests.length;

        const { body: raw, headers } = await fake.webhook('subscription.stopped', {
            subscription: { wallet: WALLET, plan: 'pro', access: false },
        });
        await mesub.webhooks.verify(raw, headers);
        await mesub.hasAccess(OTHER, 'pro');
        await mesub.hasAccess(WALLET, 'team');

        expect(fake.requests.length).toBe(asked);
    });

    it('drops nothing for an event whose signature does not hold', async () => {
        const fake = new FakeMesub();
        const mesub = fake.client();
        fake.grant(WALLET, 'pro', { revalidate_after: 300 });
        await mesub.hasAccess(WALLET, 'pro');
        fake.deny(WALLET, 'pro');

        const { body: raw, headers } = await fake.webhook('subscription.stopped', {
            subscription: { wallet: WALLET, plan: 'pro', access: false },
        });
        await expect(
            mesub.webhooks.verify(raw, { ...headers, 'webhook-signature': 'v1,forged' }),
        ).rejects.toThrow();

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
    });
});

describe('testing: signing webhooks', () => {
    it.each(Object.keys(DETAILS) as WebhookEvent['type'][])(
        'FakeMesub.webhook makes a %s the client verifies',
        async (type) => {
            const fake = new FakeMesub();

            const { body: raw, headers } = await fake.webhook(type);
            const event = await fake.client().webhooks.verify(raw, headers);

            expect(event).toMatchObject({
                id: type === 'test' ? 'evt_test' : expect.stringMatching(/^evt_fake_\d+$/),
                delivery_id: headers['webhook-id'],
                type,
                network: 'devnet',
                api_version: '2026-10-02',
            });
            expect(headers['webhook-signature']).toBe(
                backendSignatureOf(fake.webhookSecret, event.delivery_id, NOW, raw),
            );
        },
    );

    it('FakeMesub.webhook makes a renewal_upcoming that can pay, due in three days', async () => {
        const fake = new FakeMesub();

        const { body: raw, headers } = await fake.webhook('subscription.renewal_upcoming');
        const event = await fake.client().webhooks.verify(raw, headers);

        expect(event.type).toBe('subscription.renewal_upcoming');
        expect(event.detail).toEqual({
            can_pay: true,
            renewal_issue: null,
            amount: '9990000',
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            due_at: new Date((NOW + 3 * 24 * 3600) * 1000).toISOString(),
        });
    });

    it('FakeMesub.webhook gives each event an id of its own', async () => {
        const fake = new FakeMesub();
        const client = fake.client();

        const first = await fake.webhook('subscription.renewed');
        const second = await fake.webhook('subscription.renewed');

        const ids = [
            (await client.webhooks.verify(first.body, first.headers)).id,
            (await client.webhooks.verify(second.body, second.headers)).id,
        ];
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('FakeMesub.webhook takes the subscription, detail, ids and timestamp given', async () => {
        const fake = new FakeMesub({ webhookSecret: OTHER_SECRET });

        const { body: raw, headers } = await fake.webhook('subscription.stopped', {
            subscription: { status: 'stopped', access: false, external_id: 'user_42' },
            detail: { reason: 'retry_deadline_passed' },
            created_at: '2026-02-01T00:00:00.000Z',
            id: 'evt_given',
            delivery_id: 'msg_given',
            timestamp: NOW - 10,
        });
        const event = await verifyWebhook(raw, headers, { secret: OTHER_SECRET });

        expect(event).toMatchObject({
            id: 'evt_given',
            delivery_id: 'msg_given',
            created_at: '2026-02-01T00:00:00.000Z',
            data: { status: 'stopped', access: false, external_id: 'user_42' },
            detail: { reason: 'retry_deadline_passed' },
        });
        expect(headers['webhook-timestamp']).toBe(String(NOW - 10));
    });

    it('signWebhook signs a body of your own, as the back would', async () => {
        const raw = body('test');

        const signed = await signWebhook(raw, { secret: SECRET, id: 'cm1' });

        expect(signed).toEqual({ body: raw, headers: backendHeaders(SECRET, 'cm1', NOW, raw) });
    });

    it('signWebhook serializes an object, under a new id each time', async () => {
        const first = await signWebhook({ type: 'test' }, { secret: SECRET });
        const second = await signWebhook({ type: 'test' }, { secret: SECRET });

        expect(first.body).toBe('{"type":"test"}');
        expect(first.headers['webhook-id']).not.toBe(second.headers['webhook-id']);
    });
});
