import {
    AccessCache,
    type CacheStore,
    DEFAULT_MAX_STALE_MS,
    MemoryStore,
} from '../../src/index.js';

interface Answer {
    access: boolean;
    revalidate_after: number;
}

const WALLET = 'SysvarRent111111111111111111111111111111111';
const NOW = 1_000_000;
const HOUR = 60 * 60 * 1000;

function setup(options: { maxStaleMs?: number } = {}) {
    const clock = { now: NOW };
    const now = () => clock.now;
    const store = new MemoryStore<Answer>({ now });
    const cache = new AccessCache<Answer>(store, { ...options, now });

    return { clock, store, cache };
}

describe('AccessCache', () => {
    describe('the key', () => {
        it('is prefixed, then the plan, then the wallet', () => {
            expect(AccessCache.key(WALLET, 'pro')).toBe(`mesub:access:pro:${WALLET}`);
        });

        it('puts the scope between the prefix and the plan', () => {
            expect(AccessCache.key(WALLET, 'pro', 'proj_1')).toBe(
                `mesub:access:proj_1:pro:${WALLET}`,
            );
        });

        it('reads and writes in the scope it is given only', async () => {
            const { cache } = setup();
            await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 }, 'proj_1');

            await expect(cache.read(WALLET, 'pro', 'proj_1')).resolves.toMatchObject({
                fresh: true,
            });
            await expect(cache.read(WALLET, 'pro', 'proj_2')).resolves.toBeUndefined();
            await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
        });

        it('differs by plan and by wallet', () => {
            const keys = new Set([
                AccessCache.key(WALLET, 'pro'),
                AccessCache.key(WALLET, 'team'),
                AccessCache.key('Other1111111111111111111111111111111111111', 'pro'),
            ]);

            expect(keys.size).toBe(3);
        });
    });

    it('finds nothing before anything was written', async () => {
        await expect(setup().cache.read(WALLET, 'pro')).resolves.toBeUndefined();
    });

    it('serves an answer as fresh while revalidate_after lasts', async () => {
        const { clock, cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

        clock.now = NOW + 59_999;

        await expect(cache.read(WALLET, 'pro')).resolves.toEqual({
            value: { access: true, revalidate_after: 60 },
            fresh: true,
        });
    });

    it('serves it as stale once revalidate_after ran out', async () => {
        const { clock, cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

        clock.now = NOW + 60_000;

        await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({ fresh: false });
    });

    it('keeps a stale answer for 24 hours, then drops it', async () => {
        const { clock, cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

        clock.now = NOW + 60_000 + DEFAULT_MAX_STALE_MS;
        await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({ fresh: false });

        clock.now += 1;
        await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
    });

    it('keeps them 24 hours by default', () => {
        expect(DEFAULT_MAX_STALE_MS).toBe(24 * HOUR);
    });

    it('takes another stale limit', async () => {
        const { clock, cache } = setup({ maxStaleMs: 1_000 });
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 0 });

        clock.now = NOW + 1_001;

        await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
    });

    it('treats revalidate_after 0 as stale at once', async () => {
        const { cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 0 });

        await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({ fresh: false });
    });

    it('treats a negative revalidate_after as 0', async () => {
        const { clock, cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: -3600 });

        await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({ fresh: false });
        clock.now = NOW + DEFAULT_MAX_STALE_MS;
        await expect(cache.read(WALLET, 'pro')).resolves.toBeDefined();
    });

    it('replaces the answer on a new write', async () => {
        const { cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });
        await cache.write(WALLET, 'pro', { access: false, revalidate_after: 60 });

        await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({
            value: { access: false },
        });
    });

    it('keeps wallets and plans apart', async () => {
        const { cache } = setup();
        await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

        await expect(cache.read(WALLET, 'team')).resolves.toBeUndefined();
        await expect(
            cache.read('Other1111111111111111111111111111111111111', 'pro'),
        ).resolves.toBeUndefined();
    });

    describe('over any store', () => {
        // What a Redis store does with it: expire the key when the fallback ends.
        it('tells the store how long to keep the entry', async () => {
            const set = vi.fn();
            const cache = new AccessCache<Answer>(
                { get: () => undefined, set },
                { now: () => NOW },
            );

            await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

            expect(set).toHaveBeenCalledWith(
                `mesub:access:pro:${WALLET}`,
                {
                    value: { access: true, revalidate_after: 60 },
                    freshUntil: NOW + 60_000,
                    keepUntil: NOW + 60_000 + DEFAULT_MAX_STALE_MS,
                },
                60_000 + DEFAULT_MAX_STALE_MS,
            );
        });

        it('works with a store that answers promises', async () => {
            const map = new Map();
            const store: CacheStore<Answer> = {
                get: async (key) => map.get(key),
                set: async (key, entry) => {
                    map.set(key, entry);
                },
            };
            const cache = new AccessCache<Answer>(store, { now: () => NOW });

            await cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 });

            await expect(cache.read(WALLET, 'pro')).resolves.toMatchObject({ fresh: true });
        });

        // A store that keeps a key longer than asked does not revive it.
        it('drops an entry past keepUntil even if the store still has it', async () => {
            const cache = new AccessCache<Answer>(
                {
                    get: () => ({
                        value: { access: true, revalidate_after: 60 },
                        freshUntil: NOW - 2,
                        keepUntil: NOW - 1,
                    }),
                    set: () => undefined,
                },
                { now: () => NOW },
            );

            await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
        });

        // Redis down must never break a request.
        it('reads a store that throws as a miss', async () => {
            const cache = new AccessCache<Answer>(
                {
                    get: () => {
                        throw new Error('ECONNREFUSED');
                    },
                    set: () => undefined,
                },
                { now: () => NOW },
            );

            await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
        });

        it('reads a store that rejects as a miss', async () => {
            const cache = new AccessCache<Answer>(
                { get: async () => Promise.reject(new Error('timeout')), set: () => undefined },
                { now: () => NOW },
            );

            await expect(cache.read(WALLET, 'pro')).resolves.toBeUndefined();
        });

        it('ignores a store that fails to write', async () => {
            const cache = new AccessCache<Answer>(
                { get: () => undefined, set: async () => Promise.reject(new Error('READONLY')) },
                { now: () => NOW },
            );

            await expect(
                cache.write(WALLET, 'pro', { access: true, revalidate_after: 60 }),
            ).resolves.toBeUndefined();
        });
    });
});
