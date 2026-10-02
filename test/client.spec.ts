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
