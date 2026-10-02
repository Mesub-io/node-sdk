import {
    type AccessAnswer,
    type AccessList,
    type CacheStore,
    type ListParams,
    MemoryStore,
    Mesub,
    MesubError,
    MesubSubmitError,
    type ServerSubscription,
} from '../src/index.js';
import { type FetchCall, coded, json, mockFetch, nest } from './helpers.js';

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
        retry_deadline: null,
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

    it('throws a refusal at once, with its code and when to come back, never retried', async () => {
        const { fetch } = mockFetch(
            json(
                429,
                {
                    statusCode: 429,
                    error: 'Too Many Requests',
                    message: 'Too many subscriptions are waiting for a signature in this project.',
                    code: 'pending_cap_reached',
                    retryable: true,
                },
                { 'retry-after': '1800' },
            ),
        );

        const { error } = await settle(
            mesub(fetch).subscriptions.create({ plan: 'pro', wallet: WALLET }),
        );

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({
            status: 429,
            code: 'rate_limited',
            apiCode: 'pending_cap_reached',
            retryAfter: 1_800_000,
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
    const SENT = JSON.stringify(signed);
    const unavailable = (headers: Record<string, string> = { 'retry-after': '10' }) =>
        coded(503, 'network_unavailable', 'The Solana network did not answer.', true, headers);

    /** The submits sent, by body: always the same one. */
    const posts = (calls: FetchCall[]) =>
        calls.filter(({ init }) => init.method === 'POST').map(({ init }) => init.body);

    it('posts the signed transaction and terms, and answers what settled', async () => {
        const { fetch, calls } = mockFetch(json(201, { subscription: subscription() }));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({ subscription: subscription() });
        expect(calls[0]!.url.href).toBe('https://api.test/v1/subscriptions/sub_1/submit');
        expect(calls[0]!.init.method).toBe('POST');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual(signed);
    });

    it("answers Mesub's own pending with its reason", async () => {
        const reason = 'The transaction expired before it landed.';
        const { fetch } = mockFetch(json(201, { subscription: pending(), reason }));

        const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

        expect(result).toEqual({ subscription: pending(), reason });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

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
        expect(error).not.toBeInstanceOf(MesubSubmitError);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    describe('an answer it cannot read', () => {
        it.each([
            ['no subscription', { reason: 'x' }],
            [
                'a subscription without a status',
                { subscription: { ...subscription(), status: undefined } },
            ],
            ['a reason that is not a string', { subscription: pending(), reason: 7 }],
        ])('with %s is read back, never sent again', async (_label, body) => {
            const { fetch, calls } = mockFetch(json(201, body), json(200, subscription()));

            const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

            // The row may be active: it is, so it is answered, not an error.
            expect(result).toEqual({ subscription: subscription() });
            expect(posts(calls)).toHaveLength(1);
            expect(calls[1]!.init.method).toBe('GET');
            expect(calls[1]!.url.pathname).toBe('/v1/subscriptions/sub_1');
        });

        it('throws unexpected with what it read back when that is not active', async () => {
            const body = { subscription: { id: 'sub_1' } };
            const { fetch, calls } = mockFetch(json(201, body), json(200, pending()));

            const { error } = await settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            expect(error).toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({
                status: 201,
                code: 'unexpected',
                retryable: false,
                subscription: pending(),
                sends: 1,
                body,
            });
            expect(error!.message).toBe(
                'Mesub answered POST /v1/subscriptions/:id/submit with an answer this SDK ' +
                    'cannot read: subscription.status is missing. The subscription read back ' +
                    'is pending: read it again with retrieve before creating anew.',
            );
            expect(posts(calls)).toHaveLength(1);
        });

        it('reads back a 2xx that is not JSON too', async () => {
            const { fetch, calls } = mockFetch(
                new Response('<html>ok</html>', { status: 201 }),
                json(200, subscription()),
            );

            const result = await mesub(fetch).subscriptions.submit('sub_1', signed);

            expect(result).toEqual({ subscription: subscription() });
            expect(posts(calls)).toHaveLength(1);
        });
    });

    // Safe since Mesub-io/backend#190 and #202: the same transaction and terms
    // signature are answered from the chain, never co-signed again.
    describe('when a send gets no answer', () => {
        it('sends the same request again after the Retry-After, and answers that', async () => {
            const { fetch, calls } = mockFetch(
                unavailable(),
                json(201, { subscription: subscription() }),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            await vi.advanceTimersByTimeAsync(9_999);
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);

            expect((await result).value).toEqual({ subscription: subscription() });
            expect(posts(calls)).toEqual([SENT, SENT]);
            expect(calls[1]!.url.pathname).toBe('/v1/subscriptions/sub_1/submit');
        });

        it('waits the Retry-After Mesub asks for', async () => {
            const { fetch } = mockFetch(
                unavailable({ 'retry-after': '3' }),
                json(201, { subscription: subscription() }),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            await vi.advanceTimersByTimeAsync(2_999);
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);

            expect((await result).value).toEqual({ subscription: subscription() });
        });

        it('waits 10 s when Mesub names no wait, as after a network error', async () => {
            const { fetch } = mockFetch(
                new TypeError('fetch failed'),
                nest(502, 'Bad Gateway'),
                json(201, { subscription: subscription() }),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            await vi.advanceTimersByTimeAsync(9_999);
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(10_000);

            expect((await result).value).toEqual({ subscription: subscription() });
            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it("answers a replay's pending with Mesub's reason", async () => {
            const reason = 'The transaction expired before it landed.';
            const { fetch } = mockFetch(
                unavailable(),
                json(201, { subscription: pending(), reason }),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();

            expect((await result).value).toEqual({ subscription: pending(), reason });
        });

        it('replays an error Mesub marks retryable, then reads back', async () => {
            const { fetch, calls } = mockFetch(
                coded(500, 'internal_error', 'Something broke.', true),
                coded(409, 'subscription_changed', 'Ask again.', true),
                json(201, { subscription: subscription() }),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();

            expect((await result).value).toEqual({ subscription: subscription() });
            expect(posts(calls)).toEqual([SENT, SENT, SENT]);
        });

        it('sends three times at most, then throws with what it read back', async () => {
            const { fetch, calls } = mockFetch('hang', 'hang', 'hang', json(200, pending()));
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, {
                    timeout: 10_000,
                    budget: 60_000,
                }),
            );
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toBeInstanceOf(MesubSubmitError);
            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({
                status: null,
                code: 'unavailable',
                retryable: true,
                subscription: pending(),
                sends: 3,
            });
            expect(error!.message).toBe(
                'Mesub never said what became of the submit, sent 3 times: Mesub did not answer ' +
                    'within 10000 ms. The subscription read back is pending: read it again ' +
                    'with retrieve before creating anew.',
            );
            expect(posts(calls)).toEqual([SENT, SENT, SENT]);
            expect(calls[3]!.init.method).toBe('GET');
            expect(fetch).toHaveBeenCalledTimes(4);
        });

        it('keeps to 120 s by default: 90 s, a 10 s wait, and what is left', async () => {
            const { fetch } = mockFetch('hang', 'hang', json(200, pending()));
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            await vi.advanceTimersByTimeAsync(99_999);
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(19_999);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            const { error } = await result;

            // Cut at the budget: no third send, the read back instead.
            expect(error).toMatchObject({ code: 'unavailable', subscription: pending(), sends: 2 });
            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it('takes a timeout and a budget of the call', async () => {
            const { fetch } = mockFetch(
                new TypeError('fetch failed'),
                new TypeError('fetch failed'),
                json(200, pending()),
            );
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, { budget: 15_000 }),
            );
            await vi.runAllTimersAsync();

            // Sent at 0 and 10 s: a third at 20 s would be past the budget.
            expect((await result).error).toMatchObject({ sends: 2, subscription: pending() });
        });

        it.each([0, -1, Number.NaN, Infinity])(
            'refuses a budget of %s, sending nothing',
            async (budget) => {
                const { fetch } = mockFetch();

                await expect(
                    mesub(fetch).subscriptions.submit('sub_1', signed, { budget }),
                ).rejects.toBeInstanceOf(TypeError);
                expect(fetch).not.toHaveBeenCalled();
            },
        );

        it('does not wait a Retry-After that outlasts the budget', async () => {
            const { fetch } = mockFetch(
                unavailable({ 'retry-after': '200' }),
                json(200, pending()),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.advanceTimersByTimeAsync(0);

            expect((await result).error).toMatchObject({
                status: 503,
                code: 'unavailable',
                apiCode: 'network_unavailable',
                retryAfter: 200_000,
                sends: 1,
            });
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it('answers what it read back when that landed', async () => {
            const { fetch } = mockFetch(
                'hang',
                'hang',
                'hang',
                json(200, subscription({ status: 'cancelled' })),
            );
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, {
                    timeout: 1_000,
                    budget: 60_000,
                }),
            );
            await vi.runAllTimersAsync();

            expect((await result).value).toEqual({
                subscription: subscription({ status: 'cancelled' }),
            });
        });

        it('reads back a 5xx Mesub marks not retryable, without sending it again', async () => {
            const { fetch, calls } = mockFetch(
                coded(500, 'internal_error', 'Something broke.', false),
                json(200, pending()),
            );

            const { error } = await settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            expect(error).toMatchObject({ status: 500, subscription: pending(), sends: 1 });
            expect(posts(calls)).toHaveLength(1);
        });

        it('throws with a null subscription when the read back fails too', async () => {
            const failure = new TypeError('fetch failed');
            const { fetch } = mockFetch(failure, failure, failure, failure, failure, failure);
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({ code: 'unavailable', subscription: null, sends: 3 });
            expect(error!.message).toMatch(/Reading the subscription back failed too: /);
            expect((error!.cause as MesubError).cause).toBe(failure);
        });

        it("throws Mesub's refusal of a replay as is", async () => {
            const { fetch } = mockFetch(
                unavailable(),
                coded(409, 'transaction_expired', 'This transaction expired before it was sent.'),
            );
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).not.toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({ status: 409, apiCode: 'transaction_expired' });
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        // The first send may have been co-signed, and the row has moved on
        // since: the merchant gets the row, not a bare 409.
        it('reads back a replay refused as not awaiting a signature', async () => {
            const refusal = () =>
                coded(
                    409,
                    'not_awaiting_signature',
                    'This subscription is not waiting for a signature.',
                );
            const expired = subscription({
                status: 'expired',
                access: false,
                payment_status: 'none',
                access_until: null,
                confirmed_at: null,
            });
            const { fetch, calls } = mockFetch(
                'hang',
                refusal(),
                json(200, expired),
                'hang',
                refusal(),
                json(200, subscription()),
            );
            const options = { timeout: 1_000 };

            const first = settle(mesub(fetch).subscriptions.submit('sub_1', signed, options));
            await vi.runAllTimersAsync();
            const { error } = await first;

            expect(error).toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({
                status: 409,
                code: 'conflict',
                apiCode: 'not_awaiting_signature',
                retryable: false,
                subscription: expired,
                sends: 2,
            });
            expect(error!.message).toBe(
                'This subscription is not waiting for a signature. The subscription read ' +
                    'back is expired: read it again with retrieve before creating anew.',
            );
            expect(posts(calls)).toEqual([SENT, SENT]);

            // Landed after all: answered.
            const second = settle(mesub(fetch).subscriptions.submit('sub_1', signed, options));
            await vi.runAllTimersAsync();
            expect((await second).value).toEqual({ subscription: subscription() });
        });

        it('throws not awaiting a signature as is when no send was lost', async () => {
            const { fetch } = mockFetch(
                coded(409, 'not_awaiting_signature', 'Not waiting for a signature.'),
            );

            const { error } = await settle(mesub(fetch).subscriptions.submit('sub_1', signed));

            expect(error).not.toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({ status: 409, apiCode: 'not_awaiting_signature' });
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        it('throws a retryable refusal as is when every send got one', async () => {
            const limited = () => coded(429, 'rate_limited', 'Slow down.', true);
            const { fetch } = mockFetch(limited(), limited(), limited());
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();
            const { error } = await result;

            // Nothing was done: no read back.
            expect(error).not.toBeInstanceOf(MesubSubmitError);
            expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it('reads back when a retryable refusal follows a send that got no answer', async () => {
            const limited = () => coded(429, 'rate_limited', 'Slow down.', true);
            const { fetch } = mockFetch(unavailable(), limited(), limited(), json(200, pending()));
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();

            const { error } = await result;

            // The last answer's fields, the last send's error as the cause.
            expect(error).toMatchObject({
                status: 429,
                code: 'unavailable',
                apiCode: 'rate_limited',
                retryable: true,
                subscription: pending(),
                sends: 3,
            });
            expect((error!.cause as MesubError).apiCode).toBe('rate_limited');
        });

        it('keeps the last response it got when later sends got none', async () => {
            const { fetch } = mockFetch(unavailable(), 'hang', 'hang', json(200, pending()));
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, {
                    timeout: 1_000,
                    budget: 60_000,
                }),
            );
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toMatchObject({
                status: 503,
                code: 'unavailable',
                apiCode: 'network_unavailable',
                retryAfter: 10_000,
                sends: 3,
            });
            expect(error!.cause).toMatchObject({ status: null, code: 'unavailable' });
            expect(error!.message).toMatch(
                /^Mesub never said what became of the submit, sent 3 times: Mesub did not answer within 1000 ms\. /,
            );
        });
    });

    // A submit never takes longer than its budget plus 10 s: 130 s by default.
    describe('the read back', () => {
        it('gives up 10 s after the budget, retries included', async () => {
            const { fetch } = mockFetch('hang', 'hang', 'hang', 'hang', 'hang');
            const started = Date.now();
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toMatchObject({ code: 'unavailable', subscription: null, sends: 2 });
            expect(Date.now() - started).toBe(130_000);
        });

        it('waits no Retry-After past those 10 s', async () => {
            const busy = () => coded(503, 'unavailable', 'Busy.', true, { 'retry-after': '30' });
            const { fetch } = mockFetch('hang', 'hang', busy(), json(200, pending()));
            const started = Date.now();
            const result = settle(mesub(fetch).subscriptions.submit('sub_1', signed));
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toMatchObject({ subscription: null });
            expect(Date.now() - started).toBe(120_000);
            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });

    describe('an abort', () => {
        it('stops a send, with no read back', async () => {
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

        it('stops the wait before a replay, sending nothing more', async () => {
            const controller = new AbortController();
            const { fetch } = mockFetch(unavailable(), json(201, { subscription: subscription() }));
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, { signal: controller.signal }),
            );

            await vi.advanceTimersByTimeAsync(5_000);
            controller.abort();
            await vi.runAllTimersAsync();

            expect((await result).error).toMatchObject({ name: 'AbortError' });
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        it('stops the read back', async () => {
            const controller = new AbortController();
            const { fetch } = mockFetch(json(201, { subscription: { id: 'sub_1' } }), 'hang');
            const result = settle(
                mesub(fetch).subscriptions.submit('sub_1', signed, { signal: controller.signal }),
            );

            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await vi.runAllTimersAsync();

            expect((await result).error).toMatchObject({ name: 'AbortError' });
            expect(fetch).toHaveBeenCalledTimes(2);
        });
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

    it('reads a missing retry_deadline as null, from a back that predates it', async () => {
        const { retry_deadline: _, ...older } = subscription();
        const { fetch } = mockFetch(
            json(200, older),
            json(200, { data: [older], has_more: false }),
        );
        const client = mesub(fetch);

        await expect(client.subscriptions.retrieve('sub_1')).resolves.toEqual(subscription());
        await expect(client.subscriptions.list({ wallet: WALLET })).resolves.toEqual({
            data: [subscription()],
            has_more: false,
        });
    });

    it('takes a superseded subscription and its retry deadline', async () => {
        const superseded = subscription({
            status: 'superseded',
            access: false,
            payment_status: 'none',
            access_until: null,
            retry_deadline: '2026-10-30T11:58:00.000Z',
        });
        const { fetch } = mockFetch(json(200, superseded));

        await expect(mesub(fetch).subscriptions.retrieve('sub_1')).resolves.toEqual(superseded);
    });

    it.each([
        ['no created_at', { ...subscription(), created_at: undefined }, 'created_at is missing'],
        [
            'a retry_deadline that is not a date',
            subscription({ retry_deadline: 'soon' }),
            'retry_deadline is not a date or null',
        ],
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

// Right after a submit lands, a cached no must not keep the subscriber out (#33).
describe('the access cache once a subscription lands', () => {
    const signed = { transaction: 'AQAAAA==', terms_signature: SIGNATURE };

    function access(over: Partial<AccessAnswer> = {}): AccessAnswer {
        return {
            wallet: WALLET,
            plan: 'pro',
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
            revalidate_after: 60,
            ...over,
        };
    }

    const granted = access({ access: true, status: 'active', payment_status: 'paid' });

    function withCache(
        fetch: typeof globalThis.fetch,
        cache: CacheStore<AccessAnswer | AccessList>,
    ) {
        return new Mesub({ apiKey: 'sk_test', baseUrl: 'https://api.test', fetch, cache });
    }

    const asked = (calls: FetchCall[]) =>
        calls.filter(({ url }) => url.pathname === '/v1/access').length;

    it('asks Mesub again for the wallet after a submit that landed', async () => {
        const { fetch, calls } = mockFetch(
            json(200, access()),
            json(201, { subscription: subscription() }),
            json(200, granted),
        );
        const client = mesub(fetch);
        await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(false);

        await client.subscriptions.submit('sub_1', signed);

        await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        expect(asked(calls)).toBe(2);
    });

    it('drops the answers by external id and email, and the list, too', async () => {
        const list: AccessList = { plans: [], revalidate_after: 60 };
        const { fetch, calls } = mockFetch(
            json(200, access({ wallet: null })),
            json(200, access({ wallet: null })),
            json(200, list),
            json(201, { subscription: subscription({ status: 'cancelled' }) }),
            json(200, granted),
            json(200, granted),
            json(200, { plans: [granted], revalidate_after: 60 }),
        );
        const client = mesub(fetch);
        await client.access({ external_id: 'cus_42' }, 'pro');
        // Normalised as Mesub reads it: the subscription's `a@b.co` is the same customer.
        await client.access({ email: ' A@b.co' }, 'pro');
        await client.accessList(WALLET);

        await client.subscriptions.submit('sub_1', signed);

        await expect(client.hasAccess({ external_id: 'cus_42' }, 'pro')).resolves.toBe(true);
        await expect(client.hasAccess({ email: 'a@b.co' }, 'pro')).resolves.toBe(true);
        await expect(client.accessList(WALLET)).resolves.toEqual({
            plans: [granted],
            revalidate_after: 60,
        });
        expect(asked(calls)).toBe(6);
    });

    it('keeps a cached yes, and the answers of other plans', async () => {
        const { fetch, calls } = mockFetch(
            json(200, access({ plan: 'team' })),
            json(
                200,
                access({ wallet: 'OtherWallet1111111111111111111111111111111', access: true }),
            ),
            json(200, { plans: [granted], revalidate_after: 60 }),
            json(201, { subscription: subscription() }),
        );
        const client = mesub(fetch);
        await client.access(WALLET, 'team');
        await client.access({ email: 'a@b.co' }, 'pro');
        await client.accessList({ external_id: 'cus_42' });

        await client.subscriptions.submit('sub_1', signed);

        await expect(client.hasAccess(WALLET, 'team')).resolves.toBe(false);
        await expect(client.hasAccess({ email: 'a@b.co' }, 'pro')).resolves.toBe(true);
        await client.accessList({ external_id: 'cus_42' });
        expect(asked(calls)).toBe(3);
    });

    it('keeps the cached no after a submit Mesub answered pending', async () => {
        const { fetch, calls } = mockFetch(
            json(200, access()),
            json(201, { subscription: pending(), reason: 'Not landed yet.' }),
        );
        const client = mesub(fetch);
        await client.hasAccess(WALLET, 'pro');

        await client.subscriptions.submit('sub_1', signed);

        await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        expect(asked(calls)).toBe(1);
    });

    it.each([
        [
            'retrieve',
            () => json(200, subscription()),
            (client: Mesub) => client.subscriptions.retrieve('sub_1'),
        ],
        [
            'list',
            () =>
                json(200, {
                    data: [subscription({ status: 'expired' }), subscription()],
                    has_more: false,
                }),
            (client: Mesub) => client.subscriptions.list({ wallet: WALLET }),
        ],
    ])('drops it after %s found the subscription active', async (_label, answer, read) => {
        const { fetch, calls } = mockFetch(json(200, access()), answer(), json(200, granted));
        const client = mesub(fetch);
        await client.hasAccess(WALLET, 'pro');

        await read(client);

        await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        expect(asked(calls)).toBe(2);
    });

    it('makes it stale in a store without delete, so Mesub is asked again', async () => {
        const memory = new MemoryStore<AccessAnswer | AccessList>();
        const store: CacheStore<AccessAnswer | AccessList> = {
            get: (key) => memory.get(key),
            set: (key, entry, ttlMs) => memory.set(key, entry, ttlMs),
        };
        const { fetch, calls } = mockFetch(
            json(200, access()),
            json(201, { subscription: subscription() }),
            json(200, granted),
        );
        const client = withCache(fetch, store);
        await client.hasAccess(WALLET, 'pro');

        await client.subscriptions.submit('sub_1', signed);

        await expect(client.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        expect(asked(calls)).toBe(2);
    });

    it('still answers the submit when the store fails', async () => {
        const fail = () => {
            throw new Error('ECONNREFUSED');
        };
        const { fetch } = mockFetch(json(201, { subscription: subscription() }));
        const client = withCache(fetch, { get: fail, set: fail, delete: fail });

        await expect(client.subscriptions.submit('sub_1', signed)).resolves.toEqual({
            subscription: subscription(),
        });
    });
});
