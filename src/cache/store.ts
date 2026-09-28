/** One cached answer, with the two moments that decide what it is still good for. */
export interface CacheEntry<T> {
    value: T;
    /** Epoch ms. Before it, the answer is served without calling Mesub. */
    freshUntil: number;
    /** Epoch ms. Until then a stale answer is kept for the outage fallback, then dropped. */
    keepUntil: number;
}

/**
 * Where answers are kept. The memory store is the default; a merchant plugs
 * Redis or anything else by implementing these two methods. Either may be
 * sync or async.
 */
export interface CacheStore<T = unknown> {
    get(key: string): CacheEntry<T> | undefined | Promise<CacheEntry<T> | undefined>;
    /** `ttlMs` is how long until `keepUntil`, for a store that expires keys itself. */
    set(key: string, entry: CacheEntry<T>, ttlMs: number): void | Promise<void>;
}
