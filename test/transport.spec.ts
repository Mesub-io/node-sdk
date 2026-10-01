import { MesubError } from '../src/errors.js';
import { Transport } from '../src/transport.js';
import { json, mockFetch, nest } from './helpers.js';

function transport(fetch: typeof globalThis.fetch, overrides: { maxRetries?: number } = {}) {
    return new Transport({
        apiKey: 'sk_test',
        baseUrl: 'https://api.test',
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

    it('sends the key, Accept and User-Agent, as a GET', async () => {
        const { fetch, calls } = mockFetch(json(200, {}));
        await transport(fetch).get('/v1/access');

        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(calls[0]!.init.method).toBe('GET');
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
        [403, 'unexpected'],
        [404, 'plan_not_found'],
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
        [409, 'unexpected'],
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

    it.each([
        ["the back's own error", nest(404, 'No plan of yours is named pro.', 'Not Found')],
        ['a body with a code', json(404, { code: 'plan_not_found', message: 'No such plan.' })],
    ])('stays plan_not_found on %s', async (_label, response) => {
        const { fetch } = mockFetch(response);

        await expect(transport(fetch).get('/v1/access')).rejects.toMatchObject({
            status: 404,
            code: 'plan_not_found',
        });
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
});

describe('timeouts and network errors', () => {
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
