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
 * Redis or anything else by implementing `get` and `set`, and `delete` if it
 * can. Each may be sync or async.
 */
export interface CacheStore<T = unknown> {
    get(key: string): CacheEntry<T> | undefined | Promise<CacheEntry<T> | undefined>;
    /** `ttlMs` is how long until `keepUntil`, for a store that expires keys itself. */
    set(key: string, entry: CacheEntry<T>, ttlMs: number): void | Promise<void>;
    /**
     * Drops a key, when a subscription that grants access lands and the
     * answer cached says no. Optional: without it, that answer is rewritten
     * as stale instead, which also makes the next call ask Mesub.
     */
    delete?(key: string): void | Promise<void>;
}
