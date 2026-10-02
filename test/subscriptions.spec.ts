import { type ListParams, Mesub, MesubError, type ServerSubscription } from '../src/index.js';
import { json, mockFetch, nest } from './helpers.js';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SIGNATURE = '5'.repeat(88);

function subscription(overrides: Partial<ServerSubscription> = {}): ServerSubscription {
    return {
        id: 'sub_1',
        status: 'active',
        access: true,
        payment_status: 'paid',
        plan: 'pro',
        wallet: WALLET,
        email: 'a@b.co',
        external_id: 'cus_42',
        current_period_start: '2026-10-02T12:00:00.000Z',
        current_period_end: '2026-11-01T12:00:00.000Z',
        next_charge_at: '2026-11-01T12:00:00.000Z',
        next_retry_at: null,
        access_until: '2026-11-01T12:00:00.000Z',
        created_at: '2026-10-02T11:58:00.000Z',
        confirmed_at: '2026-10-02T12:00:03.000Z',
        ...overrides,
    };
}

const pending = () =>
    subscription({
        status: 'pending',
        access: false,
        payment_status: 'none',
        current_period_start: null,
        current_period_end: null,
        next_charge_at: null,
        access_until: null,
        confirmed_at: null,
    });

function mesub(fetch: typeof globalThis.fetch) {
    return new Mesub({ apiKey: 'sk_test', baseUrl: 'https://api.test', fetch });
}

function settle<T>(promise: Promise<T>) {
    return promise.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error: error as MesubError }),
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('subscriptions.create', () => {
    const answer = {
        subscription: { id: 'sub_1', status: 'pending' },
        transaction: 'AQAAAA==',
        last_valid_block_height: '312345678',
        costs: {
            rent: { subscription: '2039280', authority: null, total: '2039280' },
            fee: { signatures: 2, per_signature: '5000', priority: '0', total: '10000' },
            total: '2049280',
        },
        terms: { message: 'Mesub: the terms...', expires_at: '2026-10-02T12:05:00.000Z' },
    };

    it('posts the plan, wallet, email and external id, and answers what to sign', async () => {
        const { fetch, calls } = mockFetch(json(201, answer));

        const created = await mesub(fetch).subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            email: 'a@b.co',
            external_id: 'cus_42',
        });

        expect(created).toEqual(answer);
        expect(calls[0]!.url.href).toBe('https://api.test/v1/subscriptions');
        expect(calls[0]!.init.method).toBe('POST');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            plan: 'pro',
            wallet: WALLET,
            email: 'a@b.co',
            external_id: 'cus_42',
        });
    });

    it('sends nothing but the fields Mesub takes', async () => {
        const { fetch, calls } = mockFetch(json(201, answer));
        const params = { plan: 'pro', wallet: WALLET, extra: 'no' };

        await mesub(fetch).subscriptions.create(params);

        expect(calls[0]!.init.body).toBe(`{"plan":"pro","wallet":"${WALLET}"}`);
    });

    it('throws a refusal at once, with its code, never retried', async () => {
        const { fetch } = mockFetch(
            json(429, {
                statusCode: 429,
                error: 'Too Many Requests',
                message: 'Too many subscriptions are waiting for a signature in this project.',
                code: 'pending_cap_reached',
                retryable: true,
            }),
        );

        const { error } = await settle(
            mesub(fetch).subscriptions.create({ plan: 'pro', wallet: WALLET }),
        );

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({
            status: 429,
            code: 'rate_limited',
            apiCode: 'pending_cap_reached',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['no transaction', { ...answer, transaction: undefined }, 'transaction is missing'],
        [
            'terms without an expiry',
            { ...answer, terms: { message: 'Mesub: the terms...' } },
            'terms.expires_at is missing',
        ],
        [
            'a subscription without an id',
            { ...answer, subscription: { status: 'pending' } },
            'subscription.id is missing',
        ],
    ])('throws unexpected on an answer with %s', async (_label, body, problem) => {
        const { fetch } = mockFetch(json(201, body));

        await expect(
            mesub(fetch).subscriptions.create({ plan: 'pro', wallet: WALLET }),
        ).rejects.toMatchObject({
            status: 201,
            code: 'unexpected',
            message: `Mesub answered POST /v1/subscriptions with an answer this SDK cannot read: ${problem}.`,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('subscriptions.submit', () => {
    const signed = { transaction: 'AQAAAA==', terms_signature: SIGNATURE };

    it('posts the signed transaction and terms, and answers what settled', async () => {
        const { fetch, calls } = mockFetch(json(201, { subscription: subscription() }));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({ subscription: subscription() });
        expect(calls[0]!.url.href).toBe('https://api.test/v1/subscriptions/sub_1/submit');
        expect(calls[0]!.init.method).toBe('POST');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual(signed);
    });

    it('answers a pending with its reason', async () => {
        const reason = 'The transaction expired before it landed.';
        const { fetch } = mockFetch(json(201, { subscription: pending(), reason }));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({ subscription: pending(), reason });
    });

    it.each([
        ['no subscription', { reason: 'x' }, 'subscription is missing'],
        [
            'a subscription without a status',
            { subscription: { ...subscription(), status: undefined } },
            'subscription.status is missing',
        ],
        [
            'a reason that is not a string',
            { subscription: pending(), reason: 7 },
            'reason is not a string',
        ],
    ])(
        'throws unexpected on an answer with %s, never sending again',
        async (_label, body, problem) => {
            const { fetch } = mockFetch(json(201, body));

            await expect(mesub(fetch).subscriptions.submit('sub_1', signed)).rejects.toMatchObject({
                status: 201,
                code: 'unexpected',
                message: `Mesub answered POST /v1/subscriptions/:id/submit with an answer this SDK cannot read: ${problem}.`,
            });
            expect(fetch).toHaveBeenCalledTimes(1);
        },
    );

    it('escapes the id in the path', async () => {
        const { fetch, calls } = mockFetch(json(201, { subscription: subscription() }));

        await mesub(fetch).subscriptions.submit('a/b?c', signed);

        expect(calls[0]!.url.pathname).toBe('/v1/subscriptions/a%2Fb%3Fc/submit');
    });

    it('throws a refusal as is, without reading back or sending again', async () => {
        const { fetch } = mockFetch(
            json(403, {
                message: 'Ask for the terms of this subscription again.',
                code: 'terms_used',
                retryable: false,
            }),
        );

        const { error } = await settle(mesub(fetch).subscriptions.submit('sub_1', signed));

        expect(error).toMatchObject({ status: 403, apiCode: 'terms_used' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('waits 90 s by default, then reads back once instead of sending again', async () => {
        const { fetch, calls } = mockFetch('hang', json(200, subscription()));
        const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));

        await vi.advanceTimersByTimeAsync(89_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        // Landed: the submit answers it as if Mesub had.
        expect((await result).value).toEqual({ subscription: subscription() });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(calls[1]!.init.method).toBe('GET');
        expect(calls[1]!.url.href).toBe('https://api.test/v1/subscriptions/sub_1');
    });

    it('takes a timeout of the call', async () => {
        const { fetch } = mockFetch('hang', json(200, subscription()));
        const result = settle(
            mesub(fetch).subscriptions.submit('sub_1', signed, { timeout: 120_000 }),
        );

        await vi.advanceTimersByTimeAsync(119_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        expect((await result).value).toEqual({ subscription: subscription() });
    });

    it('answers what it read back with a reason when nothing landed', async () => {
        const { fetch } = mockFetch(new TypeError('fetch failed'), json(200, pending()));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({
            subscription: pending(),
            reason:
                'The submit got no answer (Could not reach Mesub: fetch failed), ' +
                'and the subscription read back is pending.',
        });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('reads back after a 5xx too', async () => {
        const { fetch } = mockFetch(nest(502, 'Bad Gateway'), json(200, subscription()));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({ subscription: subscription() });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("throws the submit's own error when the read back fails too", async () => {
        const failure = new TypeError('fetch failed');
        const { fetch } = mockFetch(failure, failure, failure, failure);

        const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
        await vi.runAllTimersAsync();
        const { error } = await result;

        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(error!.cause).toBe(failure);
        // The submit once, then the read with its own retries: never a second submit.
        const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(posts).toHaveLength(1);
    });

    it('does not read back when the caller aborted', async () => {
        const controller = new AbortController();
        const { fetch } = mockFetch('hang', json(200, subscription()));
        const result = settle(
            mesub(fetch).subscriptions.submit('sub_1', signed, { signal: controller.signal }),
        );

        controller.abort();
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ name: 'AbortError' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('subscriptions.retrieve', () => {
    it('gets one subscription by id', async () => {
        const expired = subscription({ status: 'expired', access: false, access_until: null });
        const { fetch, calls } = mockFetch(json(200, expired));

        await expect(mesub(fetch).subscriptions.retrieve('sub_1')).resolves.toEqual(expired);
        expect(calls[0]!.init.method).toBe('GET');
        expect(calls[0]!.url.href).toBe('https://api.test/v1/subscriptions/sub_1');
    });

    it("carries Mesub's code on an unknown id", async () => {
        const { fetch } = mockFetch(
            json(404, {
                statusCode: 404,
                error: 'Not Found',
                message: 'No subscription of yours under that id.',
                code: 'subscription_not_found',
                retryable: false,
            }),
        );

        await expect(mesub(fetch).subscriptions.retrieve('nope')).rejects.toMatchObject({
            status: 404,
            code: 'not_found',
            apiCode: 'subscription_not_found',
            retryable: false,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['no created_at', { ...subscription(), created_at: undefined }, 'created_at is missing'],
        ['access as a string', subscription({ access: 'yes' as never }), 'access is not a boolean'],
        [
            'a date that is not one',
            subscription({ access_until: 'soon' }),
            'access_until is not a date or null',
        ],
        ['a list', [subscription()], 'the body is not an object'],
    ])('throws unexpected on an answer with %s', async (_label, body, problem) => {
        const { fetch } = mockFetch(json(200, body));

        await expect(mesub(fetch).subscriptions.retrieve('sub_1')).rejects.toMatchObject({
            status: 200,
            code: 'unexpected',
            message: `Mesub answered GET /v1/subscriptions/:id with an answer this SDK cannot read: ${problem}.`,
        });
    });

    it.each(['', undefined as unknown as string])(
        'refuses an empty id, calling nothing',
        async (id) => {
            const { fetch } = mockFetch();

            await expect(mesub(fetch).subscriptions.retrieve(id)).rejects.toMatchObject({
                code: 'invalid_request',
                message: 'A subscription id is required.',
            });
            expect(fetch).not.toHaveBeenCalled();
        },
    );
});

describe('subscriptions.list', () => {
    it('asks by the customer, plan, limit and cursor given', async () => {
        const page = { data: [subscription()], has_more: false };
        const { fetch, calls } = mockFetch(json(200, page));

        const answer = await mesub(fetch).subscriptions.list({
            external_id: 'cus_42',
            plan: 'pro',
            limit: 50,
            starting_after: 'sub_0',
        });

        expect(answer).toEqual(page);
        expect(calls[0]!.url.pathname).toBe('/v1/subscriptions');
        expect(calls[0]!.url.search).toBe(
            '?external_id=cus_42&plan=pro&limit=50&starting_after=sub_0',
        );
    });

    it('leaves out what was not given', async () => {
        const { fetch, calls } = mockFetch(json(200, { data: [], has_more: false }));

        await mesub(fetch).subscriptions.list({ email: 'a@b.co' });

        expect(calls[0]!.url.search).toBe('?email=a%40b.co');
    });

    it('walks every page with listAll', async () => {
        const { fetch, calls } = mockFetch(
            json(200, {
                data: [subscription({ id: 's3' }), subscription({ id: 's2' })],
                has_more: true,
            }),
            json(200, { data: [subscription({ id: 's1' })], has_more: false }),
        );

        const ids: string[] = [];
        for await (const row of mesub(fetch).subscriptions.listAll({ wallet: WALLET, limit: 2 })) {
            ids.push(row.id);
        }

        expect(ids).toEqual(['s3', 's2', 's1']);
        expect(calls[0]!.url.searchParams.has('starting_after')).toBe(false);
        expect(calls[1]!.url.searchParams.get('starting_after')).toBe('s2');
        expect(calls[1]!.url.searchParams.get('limit')).toBe('2');
    });

    it('asks for no page beyond what was used', async () => {
        const { fetch } = mockFetch(
            json(200, { data: [subscription({ id: 's2' })], has_more: true }),
            json(200, { data: [subscription({ id: 's1' })], has_more: false }),
        );

        for await (const row of mesub(fetch).subscriptions.listAll({ wallet: WALLET })) {
            expect(row.id).toBe('s2');
            break;
        }

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('names the customer as access does, normalised the same way', async () => {
        const { fetch, calls } = mockFetch(
            json(200, { data: [], has_more: false }),
            json(200, { data: [], has_more: false }),
        );

        await mesub(fetch).subscriptions.list({ email: ' Ada@Example.com ' });
        await mesub(fetch).subscriptions.list({ external_id: ' cus_42 ', plan: 'pro' });

        expect(calls[0]!.url.search).toBe('?email=ada%40example.com');
        expect(calls[1]!.url.search).toBe('?external_id=cus_42&plan=pro');
    });

    it.each([
        ['no customer', { plan: 'pro' }],
        ['two customers', { wallet: WALLET, email: 'a@b.co' }],
        ['a wallet that is not a string', { wallet: 42 }],
    ])('throws a TypeError on %s, calling nothing', async (_label, params) => {
        const { fetch } = mockFetch();

        await expect(
            mesub(fetch).subscriptions.list(params as unknown as ListParams),
        ).rejects.toBeInstanceOf(TypeError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ['no has_more', { data: [] }, 'has_more is missing'],
        ['data that is not a list', { data: {}, has_more: false }, 'data is not a list'],
        [
            'a subscription without an id',
            { data: [subscription(), { ...subscription(), id: undefined }], has_more: false },
            'data[1].id is missing',
        ],
    ])('throws unexpected on a page with %s', async (_label, body, problem) => {
        const { fetch } = mockFetch(json(200, body));

        await expect(mesub(fetch).subscriptions.list({ wallet: WALLET })).rejects.toMatchObject({
            status: 200,
            code: 'unexpected',
            message: `Mesub answered GET /v1/subscriptions with an answer this SDK cannot read: ${problem}.`,
        });
    });

    it('stops on an empty page that says has_more', async () => {
        const { fetch } = mockFetch(json(200, { data: [], has_more: true }));

        const rows = [];
        for await (const row of mesub(fetch).subscriptions.listAll({ wallet: WALLET })) {
            rows.push(row);
        }

        expect(rows).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
