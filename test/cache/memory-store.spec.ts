import type { CacheEntry } from '../../src/cache/store.js';
import { DEFAULT_MAX_ENTRIES, MemoryStore } from '../../src/index.js';

const NOW = 1_000_000;

function entry(value: string, keepUntil = NOW + 60_000): CacheEntry<string> {
    return { value, freshUntil: NOW + 1_000, keepUntil };
}

function store(maxEntries?: number, now = () => NOW) {
    return new MemoryStore<string>({ ...(maxEntries === undefined ? {} : { maxEntries }), now });
}

describe('MemoryStore', () => {
    it('answers nothing for a key never set', () => {
        expect(store().get('missing')).toBeUndefined();
    });

    it('answers what was set', () => {
        const s = store();
        s.set('a', entry('A'), 60_000);

        expect(s.get('a')).toEqual(entry('A'));
    });

    it('replaces an entry set twice', () => {
        const s = store();
        s.set('a', entry('first'), 60_000);
        s.set('a', entry('second'), 60_000);

        expect(s.get('a')?.value).toBe('second');
        expect(s.size).toBe(1);
    });

    it('keeps 10,000 entries by default', () => {
        expect(DEFAULT_MAX_ENTRIES).toBe(10_000);
    });

    describe('evicting', () => {
        it('drops the oldest entry past the limit', () => {
            const s = store(2);
            s.set('a', entry('A'), 60_000);
            s.set('b', entry('B'), 60_000);
            s.set('c', entry('C'), 60_000);

            expect(s.get('a')).toBeUndefined();
            expect(s.get('b')?.value).toBe('B');
            expect(s.get('c')?.value).toBe('C');
        });

        it('never holds more than the limit', () => {
            const s = store(3);

            for (let i = 0; i < 50; i++) s.set(`k${i}`, entry(`${i}`), 60_000);

            expect(s.size).toBe(3);
        });

        // Least recently used, not least recently written.
        it('keeps an entry that was read, and drops the one nobody asked for', () => {
            const s = store(2);
            s.set('a', entry('A'), 60_000);
            s.set('b', entry('B'), 60_000);
            s.get('a');
            s.set('c', entry('C'), 60_000);

            expect(s.get('a')?.value).toBe('A');
            expect(s.get('b')).toBeUndefined();
        });

        it('counts writing an entry again as using it', () => {
            const s = store(2);
            s.set('a', entry('A'), 60_000);
            s.set('b', entry('B'), 60_000);
            s.set('a', entry('A2'), 60_000);
            s.set('c', entry('C'), 60_000);

            expect(s.get('a')?.value).toBe('A2');
            expect(s.get('b')).toBeUndefined();
        });

        it('holds a single entry when the limit is one', () => {
            const s = store(1);
            s.set('a', entry('A'), 60_000);
            s.set('b', entry('B'), 60_000);

            expect(s.size).toBe(1);
            expect(s.get('b')?.value).toBe('B');
        });
    });

    describe('expiring', () => {
        it('answers an entry up to its keepUntil', () => {
            let now = NOW;
            const s = store(undefined, () => now);
            s.set('a', entry('A', NOW + 10), 10);

            now = NOW + 10;

            expect(s.get('a')?.value).toBe('A');
        });

        it('drops an entry past its keepUntil', () => {
            let now = NOW;
            const s = store(undefined, () => now);
            s.set('a', entry('A', NOW + 10), 10);

            now = NOW + 11;

            expect(s.get('a')).toBeUndefined();
            expect(s.size).toBe(0);
        });

        // A stale answer is still kept: freshness is the AccessCache's business.
        it('keeps an entry past its freshUntil', () => {
            let now = NOW;
            const s = store(undefined, () => now);
            s.set('a', { value: 'A', freshUntil: NOW + 1, keepUntil: NOW + 100 }, 100);

            now = NOW + 50;

            expect(s.get('a')?.value).toBe('A');
        });
    });
});
