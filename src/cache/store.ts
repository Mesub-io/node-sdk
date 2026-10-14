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
 *
 * A store that throws or rejects costs a cached answer, never the request. One
 * that hangs without failing, as a saturated Redis, costs no more under a
 * guard (#132): its `get` is given until the guard's `guardTimeout` runs out,
 * then read as a miss, and an answer never waits for its `set`.
 */
export interface CacheStore<T = unknown> {
    /**
     * Under a guard, read as a miss when it has not answered within
     * `guardTimeout`: the guard then has no time left to ask Mesub, and
     * answers from nothing, a 503.
     */
    get(key: string): CacheEntry<T> | undefined | Promise<CacheEntry<T> | undefined>;
    /**
     * `ttlMs` is how long until `keepUntil`, for a store that expires keys
     * itself. Not awaited: the answer is handed back while it runs, so a read
     * right after may not find it yet.
     */
    set(key: string, entry: CacheEntry<T>, ttlMs: number): void | Promise<void>;
    /**
     * Drops a key, when a subscription that grants access lands and the
     * answer cached says no. Optional: without it, that answer is rewritten
     * as stale instead, which also makes the next call ask Mesub.
     */
    delete?(key: string): void | Promise<void>;
}
