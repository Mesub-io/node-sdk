import { numberOf } from '../options.js';
import type { CacheEntry, CacheStore } from './store.js';

/** How many answers the memory store keeps before dropping the least recently used. */
export const DEFAULT_MAX_ENTRIES = 10_000;

export interface MemoryStoreOptions {
    /** A whole number above 0: 10 000 by default. */
    maxEntries?: number;
    /** The clock, replaced in tests. */
    now?: () => number;
}

/**
 * The default store: an LRU in a `Map`, which keeps insertion order. Reading
 * an entry moves it to the end, so the first key is always the least recently
 * used one. It lives in this process only: a restart empties it.
 */
export class MemoryStore<T = unknown> implements CacheStore<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private readonly maxEntries: number;
    private readonly now: () => number;

    constructor(options: MemoryStoreOptions = {}) {
        // NaN would never drop an entry: the store would grow without bound.
        this.maxEntries = numberOf('maxEntries', options.maxEntries, DEFAULT_MAX_ENTRIES, {
            integer: true,
        });
        this.now = options.now ?? Date.now;
    }

    /** How many entries are held, expired ones included until they are read. */
    get size(): number {
        return this.entries.size;
    }

    get(key: string): CacheEntry<T> | undefined {
        const result = this.entries.get(key);
        if (!result) return undefined;
        if (result.keepUntil < this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // Deleted then set again: the Map moves it to the end, the most recently used place.
        this.entries.delete(key);
        this.entries.set(key, result);

        return result;
    }

    set(key: string, entry: CacheEntry<T>, _ttlMs: number): void {
        // `_ttlMs` stays unread: `keepUntil` in the entry already says it.
        this.entries.delete(key);
        this.entries.set(key, entry);

        // The first key of the Map is the least recently used one.
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;

            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    delete(key: string): void {
        this.entries.delete(key);
    }
}
