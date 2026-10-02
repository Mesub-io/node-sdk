import { Mesub, MesubError } from '../src/index.js';
import type { MesubOptions } from '../src/index.js';
import { json, mockFetch } from './helpers.js';

/** Reaches the transport the way `access()` will, from inside the class. */
class Probe extends Mesub {
    get(path: string, query = {}) {
        return this.transport.get(path, query);
    }
}

async function firstCall(options: MesubOptions = {}) {
    const { fetch, calls } = mockFetch(json(200, {}));
    await new Probe({ fetch, ...options }).get('/v1/access', { wallet: 'w' });
    const call = calls[0]!;
    return { url: call.url, headers: call.init.headers as Record<string, string> };
}

beforeEach(() => {
    vi.stubEnv('MESUB_API_KEY', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('new Mesub()', () => {
    it('reads the key from MESUB_API_KEY by default', async () => {
        vi.stubEnv('MESUB_API_KEY', 'sk_env');

        const { headers } = await firstCall();
        expect(headers['Authorization']).toBe('Bearer sk_env');
    });

    it('prefers an explicit key over the environment', async () => {
        vi.stubEnv('MESUB_API_KEY', 'sk_env');

        const { headers } = await firstCall({ apiKey: 'sk_explicit' });
        expect(headers['Authorization']).toBe('Bearer sk_explicit');
    });

    it('throws a clear error without any key', () => {
        expect(() => new Mesub()).toThrow(/MESUB_API_KEY/);
        expect(() => new Mesub({ apiKey: '' })).toThrow(/Missing Mesub API key/);
    });

    it('does not throw a MesubError for a missing key, since no call was made', () => {
        expect(() => new Mesub()).not.toThrow(MesubError);
    });

    it.each([0, -1, Number.NaN])('refuses a guardTimeout of %s', (guardTimeout) => {
        expect(() => new Mesub({ apiKey: 'sk', guardTimeout })).toThrow(/guardTimeout/);
    });

    it('refuses the publishable key, naming the one it needs', () => {
        expect(() => new Mesub({ apiKey: 'PUB_abc' })).toThrow(TypeError);
        expect(() => new Mesub({ apiKey: 'PUB_abc' })).toThrow(/publishable key.*SUB_/s);
    });

    it('refuses the publishable key from MESUB_API_KEY too', () => {
        vi.stubEnv('MESUB_API_KEY', 'PUB_abc');

        expect(() => new Mesub()).toThrow(/publishable key/);
    });

    it('refuses an apiKey that is not a string', () => {
        expect(() => new Mesub({ apiKey: 42 as unknown as string })).toThrow(TypeError);
    });

    describe('without process (an edge runtime)', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('says to pass the key, since there is no MESUB_API_KEY to read', () => {
            vi.stubGlobal('process', undefined);
            let thrown: unknown;
            try {
                new Mesub();
            } catch (error) {
                thrown = error;
            }
            vi.unstubAllGlobals();

            expect(thrown).toBeInstanceOf(TypeError);
            expect((thrown as Error).message).toMatch(/no process\.env here.*apiKey/s);
        });

        it('works with the key passed', async () => {
            const { fetch } = mockFetch(json(200, { ok: 1 }));
            vi.stubGlobal('process', undefined);
            let client: Probe;
            try {
                client = new Probe({ apiKey: 'SUB_edge', fetch });
            } finally {
                vi.unstubAllGlobals();
            }

            await expect(client.get('/v1/access')).resolves.toEqual({ ok: 1 });
        });
    });

    it.each([
        ['timeout', Number.NaN],
        ['timeout', 0],
        ['timeout', -5],
        ['timeout', Infinity],
        ['timeout', 2 ** 31],
        ['timeout', '5000'],
        ['guardTimeout', Infinity],
        ['maxRetries', -1],
        ['maxRetries', 1.5],
        ['maxRetries', Number.NaN],
        ['maxRetries', '2'],
        ['maxStaleMs', -1],
        ['maxStaleMs', Number.NaN],
        ['maxStaleMs', Infinity],
    ])('refuses %s: %s with a TypeError naming it', (name, value) => {
        const options = { apiKey: 'sk', [name]: value } as MesubOptions;

        expect(() => new Mesub(options)).toThrow(TypeError);
        expect(() => new Mesub(options)).toThrow(new RegExp(`^${name} must be`));
    });

    it.each([
        ['maxRetries', 0],
        ['maxStaleMs', 0],
        ['timeout', 1],
        ['guardTimeout', 2 ** 31 - 1],
    ])('accepts %s: %s', (name, value) => {
        expect(() => new Mesub({ apiKey: 'sk', [name]: value })).not.toThrow();
    });

    it('refuses a fetch that is not a function', () => {
        const fetch = 'https://api.mesub.io' as unknown as typeof globalThis.fetch;

        expect(() => new Mesub({ apiKey: 'sk', fetch })).toThrow(/fetch must be a function/);
    });

    it.each([
        'http://api.mesub.io',
        'http://192.168.1.10:3333',
        'http://localhost.evil.test',
        'ftp://api.mesub.io',
    ])('refuses baseUrl %s: the key would leave in clear', (baseUrl) => {
        expect(() => new Mesub({ apiKey: 'sk', baseUrl })).toThrow(TypeError);
        expect(() => new Mesub({ apiKey: 'sk', baseUrl })).toThrow(/baseUrl must be https/);
    });

    it.each(['api.mesub.io', '/v1', ''])('refuses baseUrl %j, not an absolute URL', (baseUrl) => {
        expect(() => new Mesub({ apiKey: 'sk', baseUrl })).toThrow(/absolute URL/);
    });

    it.each(['http://localhost:3333', 'http://127.0.0.1:3333', 'http://[::1]:3333'])(
        'accepts http to this machine: %s',
        (baseUrl) => {
            expect(() => new Mesub({ apiKey: 'sk', baseUrl })).not.toThrow();
        },
    );

    it('calls https://api.mesub.io by default', async () => {
        const { url } = await firstCall({ apiKey: 'sk' });
        expect(url.href).toBe('https://api.mesub.io/v1/access?wallet=w');
    });

    it.each([
        ['http://localhost:3333', 'http://localhost:3333/v1/access?wallet=w'],
        ['http://localhost:3333/', 'http://localhost:3333/v1/access?wallet=w'],
        ['https://staging.test/api//', 'https://staging.test/api/v1/access?wallet=w'],
    ])('accepts baseUrl %s', async (baseUrl, expected) => {
        const { url } = await firstCall({ apiKey: 'sk', baseUrl });
        expect(url.href).toBe(expected);
    });

    it('uses the global fetch when none is injected', async () => {
        const { fetch } = mockFetch(json(200, { ok: 1 }));
        vi.stubGlobal('fetch', fetch);
        try {
            await expect(new Probe({ apiKey: 'sk' }).get('/v1/access')).resolves.toEqual({
                ok: 1,
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('passes timeout and maxRetries through', async () => {
        vi.useFakeTimers();
        try {
            const { fetch } = mockFetch('hang');
            const call = new Probe({ apiKey: 'sk', fetch, timeout: 100, maxRetries: 0 })
                .get('/v1/access')
                .catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(100);

            expect(await call).toMatchObject({
                status: null,
                code: 'unavailable',
                message: 'Mesub did not answer within 100 ms.',
            });
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
