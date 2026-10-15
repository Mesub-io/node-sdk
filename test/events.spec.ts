import { Mesub, MesubError } from '../src/index.js';
import { coded, json, mockFetch } from './helpers.js';

/** The back's example in `openapi/v1.json`, `GET /v1/events`. */
const EVENT = {
    id: 'evt_cmg1x0evt0001',
    object: 'event',
    type: 'subscription.renewed',
    created_at: '2026-01-31T00:01:00.000Z',
    network: 'devnet',
    api_version: '2026-10-02',
    data: {
        id: 'cmg1x0abc0001',
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
        wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        email: 'subscriber@example.com',
        external_id: 'user_123',
        current_period_start: '2026-01-31T00:00:00.000Z',
        current_period_end: '2026-03-02T00:00:00.000Z',
        next_charge_at: '2026-03-02T00:00:00.000Z',
        next_retry_at: null,
        retry_deadline: null,
        next_retry_number: null,
        retries_allowed: null,
        access_until: '2026-03-02T00:00:00.000Z',
        closable: false,
        closable_from: null,
        created_at: '2026-01-01T00:00:00.000Z',
        confirmed_at: '2026-01-01T00:00:05.000Z',
    },
    detail: {
        amount: '9990000',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        period_start: '2026-01-31T00:00:00.000Z',
        period_end: '2026-03-02T00:00:00.000Z',
        signature:
            '5wHu1qwD4kLDLoREEPBpKvGvhbxWFxFFfr5nQq7dxAsRRDXvHRqpNvfsCvC1qzjWQhqmPtBb8LnZjKmvpehJqSWk',
    },
};

const SINCE = '2026-10-16T09:00:00.000Z';

function page(data: unknown[], has_more = false) {
    return { data, has_more, available_since: SINCE };
}

function mesub(fetch: typeof globalThis.fetch) {
    return new Mesub({ apiKey: 'sk_test', baseUrl: 'https://api.test', fetch, maxRetries: 0 });
}

describe('events.list', () => {
    it('asks GET /v1/events with what narrows it, and answers the page', async () => {
        const { fetch, calls } = mockFetch(json(200, page([EVENT], true)));

        await expect(
            mesub(fetch).events.list({
                type: 'subscription.renewed',
                subscription: 'cmg1x0abc0001',
                limit: 10,
                starting_after: 'evt_before',
            }),
        ).resolves.toEqual(page([EVENT], true));
        expect(calls[0]!.init.method).toBe('GET');
        expect(calls[0]!.url.pathname).toBe('/v1/events');
        expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
            type: 'subscription.renewed',
            subscription: 'cmg1x0abc0001',
            limit: '10',
            starting_after: 'evt_before',
        });
    });

    it('sends no query when nothing narrows it', async () => {
        const { fetch, calls } = mockFetch(json(200, page([])));

        await expect(mesub(fetch).events.list()).resolves.toEqual(page([]));
        expect(calls[0]!.url.search).toBe('');
    });

    it('hands on a type newer than this release, its subscription checked', async () => {
        const newer = { ...EVENT, type: 'subscription.refunded', detail: { anything: 1 } };
        const { fetch } = mockFetch(json(200, page([newer])));

        await expect(mesub(fetch).events.list()).resolves.toEqual(page([newer]));
    });

    it('fills what an older back left out of the subscription, as retrieve does', async () => {
        const { stop_reason: _, closable: __, closable_from: ___, ...older } = EVENT.data;
        const { fetch } = mockFetch(json(200, page([{ ...EVENT, data: older }])));

        await expect(mesub(fetch).events.list()).resolves.toEqual(page([EVENT]));
    });

    it.each([
        ['no available_since', { data: [EVENT], has_more: false }, 'available_since is missing'],
        ['no has_more', { data: [EVENT], available_since: SINCE }, 'has_more is missing'],
        ['an event without its id', page([{ ...EVENT, id: undefined }]), 'data[0].id is missing'],
        [
            'an event whose subscription has no wallet',
            page([{ ...EVENT, data: { ...EVENT.data, wallet: undefined } }]),
            'data[0].data.wallet is missing',
        ],
        [
            'a renewed event without its signature',
            page([{ ...EVENT, detail: { ...EVENT.detail, signature: undefined } }]),
            'data[0].detail.signature is missing',
        ],
        ['a list', [EVENT], 'the body is not an object'],
    ])('throws unexpected on an answer with %s', async (_label, body, problem) => {
        const { fetch } = mockFetch(json(200, body));

        await expect(mesub(fetch).events.list()).rejects.toMatchObject({
            status: 200,
            code: 'unexpected',
            message: `Mesub answered GET /v1/events with an answer this SDK cannot read: ${problem}.`,
        });
    });

    it('says a Mesub without the route is one, not a wrong baseUrl', async () => {
        const { fetch } = mockFetch(coded(404, 'not_found', 'Cannot GET /v1/events'));

        await expect(mesub(fetch).events.list()).rejects.toMatchObject({
            status: 404,
            code: 'not_found',
            apiCode: null,
            message: 'This Mesub does not serve GET /v1/events yet.',
        });
    });

    it('throws what Mesub refused as is', async () => {
        const { fetch } = mockFetch(
            coded(400, 'invalid_request', 'starting_after is not an event of yours.'),
        );

        await expect(
            mesub(fetch).events.list({ starting_after: 'evt_other' }),
        ).rejects.toMatchObject({ code: 'invalid_request', apiCode: 'invalid_request' });
    });
});

describe('events.retrieve', () => {
    it('asks GET /v1/events/:id and answers the event', async () => {
        const { fetch, calls } = mockFetch(json(200, EVENT));

        await expect(mesub(fetch).events.retrieve(EVENT.id)).resolves.toEqual(EVENT);
        expect(calls[0]!.url.pathname).toBe(`/v1/events/${EVENT.id}`);
    });

    it('throws not_found with event_not_found for an event Mesub does not serve', async () => {
        const { fetch } = mockFetch(
            coded(404, 'event_not_found', 'No event of yours under that id.'),
        );

        await expect(mesub(fetch).events.retrieve('evt_gone')).rejects.toMatchObject({
            status: 404,
            code: 'not_found',
            apiCode: 'event_not_found',
        });
    });

    it.each(['', '.', '..', 'evt/1', 'a'.repeat(65)])(
        'refuses the id %j before anything is sent',
        async (id) => {
            const { fetch } = mockFetch();

            const error = await mesub(fetch)
                .events.retrieve(id)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({ code: 'invalid_request', status: null });
            expect(fetch).not.toHaveBeenCalled();
        },
    );

    it('throws unexpected on an event whose object is not event', async () => {
        const { fetch } = mockFetch(json(200, { ...EVENT, object: 'subscription' }));

        await expect(mesub(fetch).events.retrieve(EVENT.id)).rejects.toMatchObject({
            code: 'unexpected',
            message:
                'Mesub answered GET /v1/events/:id with an answer this SDK cannot read: object is not "event".',
        });
    });

    it('says a Mesub without the route is one', async () => {
        const { fetch } = mockFetch(coded(404, 'not_found', `Cannot GET /v1/events/${EVENT.id}`));

        await expect(mesub(fetch).events.retrieve(EVENT.id)).rejects.toMatchObject({
            code: 'not_found',
            message: 'This Mesub does not serve GET /v1/events yet.',
        });
    });
});
