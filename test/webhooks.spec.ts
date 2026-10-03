import { createHmac } from 'node:crypto';

import { Mesub, MesubError, verifyWebhook, type WebhookEvent } from '../src/index.js';
import { FakeMesub, signWebhook } from '../src/testing.js';
import { signedHeaders } from '../src/webhooks.js';

const SECRET = 'whsec_bWVzdWItZmFrZS13ZWJob29rLWtleS0x';
const OTHER_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const NOW = 1_790_000_000;
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
    access: true,
    payment_status: 'paid',
    plan: 'pro',
    wallet: '11111111111111111111111111111111',
    email: 'subscriber@example.com',
    external_id: 'user_123',
    current_period_start: '2026-01-01T00:00:00.000Z',
    current_period_end: '2026-01-31T00:00:00.000Z',
    next_charge_at: '2026-01-31T00:00:00.000Z',
    next_retry_at: null,
    retry_deadline: null,
    access_until: '2026-01-31T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: '2026-01-01T00:00:00.000Z',
};

/** As the back's `webhookPayload` builds a body, and the processor serializes it. */
function body(type: string, detail: Record<string, unknown> = {}, data = SUBSCRIPTION): string {
    return JSON.stringify({
        type,
        created_at: '2026-01-15T12:00:00.000Z',
        data: { ...data, detail },
    });
}

/** Each v1 detail, in the shape the back's `pull-events.ts` and services write it. */
const DETAILS: Record<string, Record<string, unknown>> = {
    'subscription.created': { previous_id: 'sub_before' },
    'subscription.renewed': {
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        period_start: '2026-01-31T00:00:00.000Z',
        period_end: '2026-03-02T00:00:00.000Z',
        signature: '5h3sig',
    },
    'subscription.payment_failed': {
        reason: 'insufficient-balance',
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        period_start: '2026-01-31T00:00:00.000Z',
        period_end: '2026-03-02T00:00:00.000Z',
        next_retry_at: '2026-02-01T00:00:00.000Z',
        retry_deadline: null,
        retries_left: 2,
        retry_mode: 'scheduled',
    },
    'subscription.stopped': { reason: 'grace-ended' },
    'subscription.cancelled': {},
    'subscription.resumed': {},
    'subscription.ended': {},
    'subscription.expired': {},
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
    it('accepts what the back signs, and hands back the event with its webhook-id', async () => {
        const raw = body('subscription.renewed', DETAILS['subscription.renewed']);
        const headers = backendHeaders(SECRET, 'cmdelivery1', NOW, raw);

        const event = await verifyWebhook(raw, headers, { secret: SECRET });

        expect(event).toEqual({
            id: 'cmdelivery1',
            type: 'subscription.renewed',
            created_at: '2026-01-15T12:00:00.000Z',
            data: { ...SUBSCRIPTION, detail: DETAILS['subscription.renewed'] },
        });
    });

    // `data` is a subscription: `paused` and `end_reason` are read like retrieve's.
    it('reads a body from a back that predates paused and end_reason', async () => {
        const { paused: _, end_reason: __, ...older } = SUBSCRIPTION;
        const raw = body('subscription.cancelled', {}, older as typeof SUBSCRIPTION);

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data).toEqual({ ...SUBSCRIPTION, detail: {} });
    });

    it.each(['plan_removed', 'authority_closed', 'closed', 'not_known_yet'])(
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
        expect(event.data.detail).toEqual(DETAILS[type]);
        expect(event.data.id).toBe('sub_test');
    });

    it('reads a created event without previous_id, as the back sends a first subscription', async () => {
        const raw = body('subscription.created');

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.data.detail).toEqual({});
    });

    it('narrows the detail by type', async () => {
        const raw = body('subscription.payment_failed', DETAILS['subscription.payment_failed']);
        const event: WebhookEvent = await verifyWebhook(
            raw,
            backendHeaders(SECRET, 'cm1', NOW, raw),
            { secret: SECRET },
        );

        if (event.type !== 'subscription.payment_failed') throw new Error('narrowed wrong');
        expect(event.data.detail.retries_left).toBe(2);
    });

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
        ).resolves.toMatchObject({ id: 'cm1' });
        await expect(verifyWebhook(raw, shouted, { secret: SECRET })).resolves.toMatchObject({
            id: 'cm1',
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
            id: 'cm1',
        });
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
        ['the detail', JSON.stringify({ type: 'test', created_at: NOW, data: SUBSCRIPTION })],
    ])('throws unexpected for a signed body missing %s', async (_what, raw) => {
        const error = await failure(
            verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), { secret: SECRET }),
        );

        expect(error.code).toBe('unexpected');
        expect(error.body).toEqual(JSON.parse(raw));
    });

    it('hands back an event type newer than this release, its subscription checked', async () => {
        const raw = body('subscription.renewal_upcoming', { days: 3 });

        const event = await verifyWebhook(raw, backendHeaders(SECRET, 'cm1', NOW, raw), {
            secret: SECRET,
        });

        expect(event.type).toBe('subscription.renewal_upcoming');
        expect(event.data.detail).toEqual({ days: 3 });
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

            expect(event).toMatchObject({ id: headers['webhook-id'], type });
            expect(headers['webhook-signature']).toBe(
                backendSignatureOf(fake.webhookSecret, event.id, NOW, raw),
            );
        },
    );

    it('FakeMesub.webhook takes the subscription, detail, id and timestamp given', async () => {
        const fake = new FakeMesub({ webhookSecret: OTHER_SECRET });

        const { body: raw, headers } = await fake.webhook('subscription.stopped', {
            subscription: { status: 'stopped', access: false, external_id: 'user_42' },
            detail: { reason: 'grace-ended' },
            created_at: '2026-02-01T00:00:00.000Z',
            id: 'msg_given',
            timestamp: NOW - 10,
        });
        const event = await verifyWebhook(raw, headers, { secret: OTHER_SECRET });

        expect(event).toMatchObject({
            id: 'msg_given',
            created_at: '2026-02-01T00:00:00.000Z',
            data: {
                status: 'stopped',
                access: false,
                external_id: 'user_42',
                detail: { reason: 'grace-ended' },
            },
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
