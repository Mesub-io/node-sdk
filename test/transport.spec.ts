import { MesubError } from '../src/errors.js';
import { Transport } from '../src/transport.js';
import { coded, json, mockFetch, nest } from './helpers.js';

function transport(fetch: typeof globalThis.fetch, overrides: { maxRetries?: number } = {}) {
    return new Transport({
        apiKey: 'sk_test',
        baseUrl: 'https://api.test',
        headers: {},
        fetch,
        timeout: 5_000,
        maxRetries: overrides.maxRetries ?? 2,
    });
}

/** Starts the call and captures its rejection, so fake timers can run first. */
function settle(promise: Promise<unknown>) {
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

describe('Transport.get', () => {
    it('returns the parsed JSON body', async () => {
        const { fetch } = mockFetch(json(200, { active: true }));

        await expect(transport(fetch).get('/v1/access')).resolves.toEqual({ active: true });
    });

    it('sends the key, Accept and User-Agent, as a GET with no body', async () => {
        const { fetch, calls } = mockFetch(json(200, {}));
        await transport(fetch).get('/v1/access');

        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(calls[0]!.init.method).toBe('GET');
        expect(calls[0]!.init.body).toBeUndefined();
        expect(headers['Content-Type']).toBeUndefined();
        expect(headers['Authorization']).toBe('Bearer sk_test');
        expect(headers['Accept']).toBe('application/json');
        expect(headers['User-Agent']).toMatch(/^@mesub\/node\/\d+\.\d+\.\d+/);
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('encodes the query and skips undefined values', async () => {
        const { fetch, calls } = mockFetch(json(200, {}));
        await transport(fetch).get('/v1/access', {
            wallet: 'Ab+c/d=e&f',
            plan: 'pro plan',
            attempts: true,
            limit: 3,
            skipped: undefined,
        });

        const url = calls[0]!.url;
        expect(url.origin + url.pathname).toBe('https://api.test/v1/access');
        expect(url.search).toBe('?wallet=Ab%2Bc%2Fd%3De%26f&plan=pro+plan&attempts=true&limit=3');
        expect(url.searchParams.get('wallet')).toBe('Ab+c/d=e&f');
        expect(url.searchParams.has('skipped')).toBe(false);
    });

    it('throws unexpected on a 2xx whose body is not JSON, without retrying', async () => {
        const { fetch } = mockFetch(new Response('<html>', { status: 200 }));

        const error = await transport(fetch)
            .get('/v1/access')
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ status: 200, code: 'unexpected' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('status mapping', () => {
    it.each([
        [400, 'invalid_request'],
        [401, 'unauthorized'],
        [403, 'forbidden'],
        [404, 'not_found'],
        // A conflict is final: asking again cannot change the answer.
        [409, 'conflict'],
        [413, 'unexpected'],
        [422, 'unexpected'],
    ])('maps %i to %s, without retrying', async (status, code) => {
        const { fetch } = mockFetch(nest(status, 'nope'));

        const error = await transport(fetch)
            .get('/v1/access')
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ name: 'MesubError', status, code, message: 'nope' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        [408, 'unexpected'],
        [429, 'rate_limited'],
        [500, 'unavailable'],
        [502, 'unavailable'],
        [503, 'unavailable'],
        [504, 'unavailable'],
    ])('retries %i twice, then throws %s', async (status, code) => {
        const { fetch } = mockFetch(nest(status, 'a'), nest(status, 'b'), nest(status, 'c'));

        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();
        const { error } = await result;

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ status, code, message: 'c' });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([429, 500, 503])('succeeds when a retry after %i answers', async (status) => {
        const { fetch } = mockFetch(nest(status, 'x'), json(200, { ok: 1 }));

        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();

        expect((await result).value).toEqual({ ok: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

// A wrong baseUrl must not read as "no plan of yours is named pro".
describe('a 404', () => {
    it.each([
        ['an HTML page', new Response('<h1>Not Found</h1>', { status: 404 })],
        ['an empty body', new Response(null, { status: 404 })],
        ['JSON from another API', json(404, { message: 'Not Found' })],
        ['a JSON array', json(404, [])],
        [
            "Nest's answer for a route it does not have",
            nest(404, 'Cannot GET /api/v1/access?wallet=w', 'Not Found'),
        ],
    ])('on %s asks whether baseUrl is right', async (_label, response) => {
        const { fetch } = mockFetch(response);

        const error = await transport(fetch)
            .get('/v1/access')
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ status: 404, code: 'unexpected' });
        expect((error as MesubError).message).toBe(
            '/v1/access answered 404 with no Mesub error: is baseUrl (https://api.test) the Mesub API?',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("asks the same on the back's coded answer for a route it does not have", async () => {
        const { fetch } = mockFetch(coded(404, 'not_found', 'Cannot GET /api/v1/access?wallet=w'));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            status: 404,
            code: 'unexpected',
            apiCode: null,
            message:
                '/v1/access answered 404 with no Mesub error: is baseUrl (https://api.test) the Mesub API?',
        });
    });

    it.each([
        ['a coded body', coded(404, 'plan_not_found', 'No plan of yours is named pro.')],
        ['a bare code', json(404, { code: 'plan_not_found', message: 'No such plan.' })],
    ])('is plan_not_found on %s', async (_label, response) => {
        const { fetch } = mockFetch(response);

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            status: 404,
            code: 'plan_not_found',
            apiCode: 'plan_not_found',
        });
    });

    it.each([
        ['a subscription', coded(404, 'subscription_not_found', 'No such subscription.')],
        ['any other code', coded(404, 'not_found', 'Nothing here.')],
        ["Nest's error without a code", nest(404, 'No plan of yours is named pro.', 'Not Found')],
    ])('is not_found on %s', async (_label, response) => {
        const { fetch } = mockFetch(response);

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            status: 404,
            code: 'not_found',
        });
    });
});

// The back's stable codes (#180): `code` and `retryable` on every error body.
describe("the back's error codes", () => {
    it.each([
        [400, 'invalid_request', 'invalid_request'],
        [400, 'mint_not_on_chain', 'invalid_request'],
        [401, 'invalid_api_key', 'unauthorized'],
        [401, 'missing_api_key', 'unauthorized'],
        [403, 'forbidden', 'forbidden'],
        [403, 'origin_not_allowed', 'forbidden'],
        [403, 'terms_expired', 'forbidden'],
        [404, 'plan_not_found', 'plan_not_found'],
        [404, 'subscription_not_found', 'not_found'],
        [409, 'conflict', 'conflict'],
        [409, 'already_subscribed', 'conflict'],
        [409, 'plan_ended', 'conflict'],
        [413, 'payload_too_large', 'unexpected'],
    ])('maps %i %s to %s, with the code as apiCode', async (status, apiCode, code) => {
        const { fetch } = mockFetch(coded(status, apiCode, 'nope'));

        const error = await transport(fetch)
            .get('/v1/access')
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ status, code, apiCode, retryable: false, message: 'nope' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        [429, 'rate_limited', 'rate_limited'],
        [500, 'internal_error', 'unavailable'],
        [503, 'unavailable', 'unavailable'],
        [503, 'network_unavailable', 'unavailable'],
        [409, 'subscription_changed', 'conflict'],
    ])(
        'retries %i %s, which the back marks retryable, then throws %s',
        async (status, apiCode, code) => {
            const { fetch } = mockFetch(
                coded(status, apiCode, 'a', true),
                coded(status, apiCode, 'b', true),
                coded(status, apiCode, 'c', true),
            );

            const result = settle(transport(fetch).get('/v1/access'));
            await vi.runAllTimersAsync();
            const { error } = await result;

            expect(error).toMatchObject({ status, code, apiCode, retryable: true, message: 'c' });
            expect(fetch).toHaveBeenCalledTimes(3);
        },
    );

    it('does not retry a 409 the back marks not retryable', async () => {
        const { fetch } = mockFetch(coded(409, 'terms_changed', 'Start again from the terms.'));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            code: 'conflict',
            apiCode: 'terms_changed',
            retryable: false,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the body on the error', async () => {
        const { fetch } = mockFetch(coded(409, 'already_subscribed', 'Already subscribed.'));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            body: {
                statusCode: 409,
                error: 'Conflict',
                message: 'Already subscribed.',
                code: 'already_subscribed',
                retryable: false,
            },
        });
    });

    it('keeps a body that is not JSON as its text, with no apiCode', async () => {
        const { fetch } = mockFetch(new Response('<h1>Forbidden</h1>', { status: 403 }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            code: 'forbidden',
            apiCode: null,
            retryable: false,
            body: '<h1>Forbidden</h1>',
        });
    });

    // Only ever a create's, a POST, which is never retried: the error says
    // when the oldest waiting subscription stops counting, as Mesub sent it.
    it("carries the pending cap's Retry-After uncapped, on a POST sent once", async () => {
        const { fetch } = mockFetch(
            coded(
                429,
                'pending_cap_reached',
                'Too many subscriptions are waiting for a signature in this project. Try again later.',
                true,
                { 'retry-after': '3000' },
            ),
        );

        const error = await transport(fetch)
            .post('/v1/subscriptions', {})
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            status: 429,
            code: 'rate_limited',
            apiCode: 'pending_cap_reached',
            retryable: true,
            retryAfter: 3_000_000,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('error messages', () => {
    it('joins an array message', async () => {
        const { fetch } = mockFetch(nest(400, ['wallet must be base58', 'plan is required']));

        await expect(transport(fetch).get('/v1/access')).rejects.toThrow(
            'wallet must be base58; plan is required',
        );
    });

    it('falls back to `error` when there is no message', async () => {
        const { fetch } = mockFetch(json(401, { error: 'Unauthorized', statusCode: 401 }));

        await expect(transport(fetch).get('/v1/access')).rejects.toThrow('Unauthorized');
    });

    it.each([
        ['a non-JSON body', new Response('Bad Gateway', { status: 400 })],
        ['an empty body', new Response(null, { status: 400 })],
        ['a JSON body without a message', json(400, { statusCode: 400 })],
        ['a JSON array', json(400, [1, 2])],
        ['an empty message list', json(400, { message: [] })],
    ])('uses a generic message on %s', async (_, response) => {
        const { fetch } = mockFetch(response);

        const error = await transport(fetch)
            .get('/v1/access')
            .catch((e: unknown) => e);
        expect(error).toMatchObject({
            status: 400,
            code: 'invalid_request',
            message: 'Mesub answered with HTTP 400.',
        });
    });
});

describe('backoff', () => {
    it('waits 500 ms, then 1 s, between attempts', async () => {
        const { fetch } = mockFetch(nest(503, 'x'), nest(503, 'x'), json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(499);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(3);
        await result;
    });

    it('shortens the delay by up to 25% of jitter', async () => {
        vi.mocked(Math.random).mockReturnValue(0.999);
        const { fetch } = mockFetch(nest(503, 'x'), json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(374);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2);
        expect(fetch).toHaveBeenCalledTimes(2);
        await result;
    });

    it('does not retry when maxRetries is 0', async () => {
        const { fetch } = mockFetch(nest(503, 'x'));

        await expect(transport(fetch, { maxRetries: 0 }).get('/v1/access')).rejects.toMatchObject({
            code: 'unavailable',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('x-should-retry', () => {
    it('forces a retry on a status that is not retried', async () => {
        const forced = json(400, { message: 'x' }, { 'x-should-retry': 'true' });
        const { fetch } = mockFetch(forced, json(200, { ok: 1 }));

        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();

        expect((await result).value).toEqual({ ok: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('forbids a retry on a status that is retried', async () => {
        const { fetch } = mockFetch(json(503, { message: 'down' }, { 'x-should-retry': 'false' }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            status: 503,
            code: 'unavailable',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('ignores any other value', async () => {
        const { fetch } = mockFetch(json(400, { message: 'x' }, { 'x-should-retry': 'maybe' }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({ status: 400 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

// Mesub-io/backend#180: every error body says whether asking again may work.
describe("the body's retryable", () => {
    it('forbids a retry on a status that is retried', async () => {
        const { fetch } = mockFetch(json(503, { message: 'down', code: 'x', retryable: false }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({ status: 503 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('allows a retry on a status that is not retried', async () => {
        const { fetch } = mockFetch(
            json(409, { message: 'changed', code: 'subscription_changed', retryable: true }),
            json(200, { ok: 1 }),
        );

        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();

        expect((await result).value).toEqual({ ok: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('gives way to x-should-retry', async () => {
        const { fetch } = mockFetch(json(503, { retryable: true }, { 'x-should-retry': 'false' }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({ status: 503 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('is ignored when it is not a boolean', async () => {
        const { fetch } = mockFetch(json(503, { retryable: 'no' }), json(200, {}));

        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();
        await result;

        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('Retry-After', () => {
    it('waits the seconds it asks for', async () => {
        const limited = json(429, { message: 'slow down' }, { 'retry-after': '3' });
        const { fetch } = mockFetch(limited, json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(2_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await result;
    });

    it('accepts an HTTP date', async () => {
        // HTTP dates have no milliseconds: start on a whole second.
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const date = new Date(Date.now() + 10_000).toUTCString();
        const { fetch } = mockFetch(json(503, {}, { 'retry-after': date }), json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(9_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await result;
    });

    it('is capped at 60 s', async () => {
        const { fetch } = mockFetch(json(429, {}, { 'retry-after': '3600' }), json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(59_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await result;
    });

    it.each(['soon', '-5', ''])('falls back to the backoff on %j', async (value) => {
        const { fetch } = mockFetch(json(429, {}, { 'retry-after': value }), json(200, {}));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(499);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await result;
    });

    it('does not make a 400 retryable', async () => {
        const { fetch } = mockFetch(json(400, {}, { 'retry-after': '1' }));

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({ status: 400 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('is on the error, in ms, as sent rather than capped', async () => {
        const { fetch } = mockFetch(
            coded(503, 'network_unavailable', 'The network did not answer.', true, {
                'retry-after': '10',
            }),
            json(429, {}, { 'retry-after': '3600' }),
        );

        const unavailable = await transport(fetch)
            .post('/v1/subscriptions/s/submit', {})
            .catch((e: unknown) => e);
        const limited = await transport(fetch)
            .post('/v1/subscriptions', {})
            .catch((e: unknown) => e);

        expect(unavailable).toMatchObject({ apiCode: 'network_unavailable', retryAfter: 10_000 });
        expect(limited).toMatchObject({ status: 429, retryAfter: 3_600_000 });
    });

    it.each(['soon', '-5', '', 'Infinity'])('is null on the error for %j', async (value) => {
        const { fetch } = mockFetch(json(429, {}, { 'retry-after': value }));

        await expect(transport(fetch).post('/v1/subscriptions', {})).rejects.toMatchObject({
            retryAfter: null,
        });
    });

    it('is null on the error when no response came back', async () => {
        const { fetch } = mockFetch(new TypeError('fetch failed'));

        await expect(transport(fetch).post('/v1/subscriptions', {})).rejects.toMatchObject({
            status: null,
            retryAfter: null,
        });
    });
});

describe('timeouts and network errors', () => {
    it('marks them retryable, with no apiCode and no body', async () => {
        const { fetch } = mockFetch(new TypeError('fetch failed'));

        await expect(transport(fetch, { maxRetries: 0 }).get('/v1/access')).rejects.toMatchObject({
            status: null,
            apiCode: null,
            retryable: true,
            body: undefined,
        });
    });

    it('aborts an attempt after 5 s and retries it', async () => {
        const { fetch } = mockFetch('hang', json(200, { ok: 1 }));
        const result = settle(transport(fetch).get('/v1/access'));

        await vi.advanceTimersByTimeAsync(4_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1 + 500);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await result).value).toEqual({ ok: 1 });
    });

    it('throws unavailable with a null status when every attempt times out', async () => {
        const { fetch } = mockFetch('hang', 'hang', 'hang');
        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();
        const { error } = await result;

        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(error!.message).toBe('Mesub did not answer within 5000 ms.');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('retries a network error, then throws unavailable with the cause', async () => {
        const failure = new TypeError('fetch failed');
        const { fetch } = mockFetch(failure, failure, failure);
        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();
        const { error } = await result;

        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(error!.message).toBe('Could not reach Mesub: fetch failed');
        expect(error!.cause).toBe(failure);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('recovers when a retry after a network error answers', async () => {
        const { fetch } = mockFetch(new TypeError('fetch failed'), json(200, { ok: 1 }));
        const result = settle(transport(fetch).get('/v1/access'));
        await vi.runAllTimersAsync();

        expect((await result).value).toEqual({ ok: 1 });
    });

    it('leaves no timer behind after a success', async () => {
        const { fetch } = mockFetch(json(200, {}));
        await transport(fetch).get('/v1/access');

        expect(vi.getTimerCount()).toBe(0);
    });
});

// The guards' rule (#34): a rate limit is not waited out, it is fallen back on.
describe('retryRateLimited: false', () => {
    it('throws a 429 at once, even one Mesub marks retryable', async () => {
        const { fetch } = mockFetch(coded(429, 'rate_limited', 'Slow down.', true));

        await expect(
            transport(fetch).get('/v1/access', {}, { retryRateLimited: false }),
        ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('still retries a 503', async () => {
        const { fetch } = mockFetch(nest(503, 'down'), json(200, { ok: true }));

        const result = settle(transport(fetch).get('/v1/access', {}, { retryRateLimited: false }));
        await vi.advanceTimersByTimeAsync(500);

        expect((await result).value).toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

// The guards' budget: one deadline for the whole call, retries and waits included.
describe('a deadline', () => {
    it('cuts an attempt at the deadline, not at the 5 s timeout', async () => {
        const { fetch } = mockFetch('hang', json(200, {}));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() + 2_000 }),
        );

        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const { error } = await result;

        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(error!.message).toBe(
            'Mesub did not answer within the 2000 ms left before the deadline.',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('still retries when the backoff fits before it', async () => {
        const { fetch } = mockFetch(nest(503, 'x'), json(200, { ok: 1 }));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() + 2_000 }),
        );

        await vi.advanceTimersByTimeAsync(500);

        expect((await result).value).toEqual({ ok: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('cuts the retry at what is left, not at a full timeout', async () => {
        const { fetch } = mockFetch(nest(503, 'x'), 'hang');
        const result = settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() + 2_000 }),
        );

        await vi.advanceTimersByTimeAsync(2_000);
        const { error } = await result;

        expect(error!.message).toBe(
            'Mesub did not answer within the 1500 ms left before the deadline.',
        );
    });

    it('never waits a Retry-After that outlasts it', async () => {
        const { fetch } = mockFetch(json(429, { message: 'slow down' }, { 'retry-after': '30' }));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() + 2_000 }),
        );

        await vi.advanceTimersByTimeAsync(0);
        const { error } = await result;

        expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'slow down' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('waits a Retry-After that fits', async () => {
        const limited = json(429, { message: 'slow down' }, { 'retry-after': '1' });
        const { fetch } = mockFetch(limited, json(200, { ok: 1 }));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() + 2_000 }),
        );

        await vi.advanceTimersByTimeAsync(999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        expect((await result).value).toEqual({ ok: 1 });
    });

    it('calls nothing once it has passed', async () => {
        const { fetch } = mockFetch(json(200, {}));

        const { error } = await settle(
            transport(fetch).get('/v1/access', {}, { deadline: Date.now() - 1 }),
        );

        expect(error).toMatchObject({ code: 'unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('lets maxRetries be lowered for one call', async () => {
        const { fetch } = mockFetch(nest(503, 'x'), json(200, {}));

        await expect(
            transport(fetch).get('/v1/access', {}, { maxRetries: 0 }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('per-call options', () => {
    it('uses the timeout of the call over the client one', async () => {
        const { fetch } = mockFetch('hang', json(200, { ok: 1 }));
        const result = settle(transport(fetch).get('/v1/access', {}, { timeout: 8_000 }));

        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_000 + 500);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await result).value).toEqual({ ok: 1 });
    });

    it('stops an attempt on the signal, with its reason, and never retries', async () => {
        const controller = new AbortController();
        const { fetch } = mockFetch('hang', json(200, {}));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { signal: controller.signal }),
        );

        await vi.advanceTimersByTimeAsync(100);
        const reason = new Error('the user left');
        controller.abort(reason);
        await vi.runAllTimersAsync();

        expect((await result).error).toBe(reason);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the wait before a retry on the signal', async () => {
        const controller = new AbortController();
        const { fetch } = mockFetch(nest(503, 'x'), json(200, {}));
        const result = settle(
            transport(fetch).get('/v1/access', {}, { signal: controller.signal }),
        );

        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ name: 'AbortError' });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('calls nothing with a signal already aborted', async () => {
        const { fetch } = mockFetch(json(200, {}));

        const { error } = await settle(
            transport(fetch).get('/v1/access', {}, { signal: AbortSignal.abort() }),
        );

        expect(error).toMatchObject({ name: 'AbortError' });
        expect(fetch).not.toHaveBeenCalled();
    });
});

// A write is never sent twice: a submit replayed after a timeout finds its
// terms spent while the first one lands.
describe('Transport.post', () => {
    it('sends the body as JSON, with the key, and returns the parsed answer', async () => {
        const { fetch, calls } = mockFetch(json(201, { id: 'sub_1' }));

        await expect(
            transport(fetch).post('/v1/subscriptions', { plan: 'pro', wallet: 'W' }),
        ).resolves.toEqual({ id: 'sub_1' });

        const { url, init } = calls[0]!;
        const headers = init.headers as Record<string, string>;
        expect(url.href).toBe('https://api.test/v1/subscriptions');
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{"plan":"pro","wallet":"W"}');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['Authorization']).toBe('Bearer sk_test');
        expect(headers['Accept']).toBe('application/json');
    });

    it.each([408, 409, 429, 500, 503])('does not retry a %i', async (status) => {
        const { fetch } = mockFetch(nest(status, 'no'), json(201, {}));

        const result = settle(transport(fetch).post('/v1/subscriptions', {}));
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ status, message: 'no' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry even when the body or a header says it may', async () => {
        const { fetch } = mockFetch(
            json(
                429,
                { code: 'pending_cap_reached', retryable: true },
                { 'x-should-retry': 'true' },
            ),
            json(201, {}),
        );

        const result = settle(transport(fetch).post('/v1/subscriptions', {}));
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ status: 429, code: 'rate_limited' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a network error', async () => {
        const { fetch } = mockFetch(new TypeError('fetch failed'), json(201, {}));

        const result = settle(transport(fetch).post('/v1/subscriptions', {}));
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ status: null, code: 'unavailable' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('waits the timeout of the call, then gives up without retrying', async () => {
        const { fetch } = mockFetch('hang', json(201, {}));
        const result = settle(
            transport(fetch).post('/v1/subscriptions/s/submit', {}, { timeout: 90_000 }),
        );

        await vi.advanceTimersByTimeAsync(89_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.runAllTimersAsync();
        const { error } = await result;

        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(error!.message).toBe('Mesub did not answer within 90000 ms.');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('stops on the signal', async () => {
        const controller = new AbortController();
        const { fetch } = mockFetch('hang');
        const result = settle(
            transport(fetch).post('/v1/subscriptions', {}, { signal: controller.signal }),
        );

        controller.abort();
        await vi.runAllTimersAsync();

        expect((await result).error).toMatchObject({ name: 'AbortError' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
