import type { CacheEntry, CacheStore } from './store.js';

/** How long a stale answer is kept for the outage fallback, then dropped. */
export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/** The one field the cache reads from an answer: seconds it stays true. */
export interface Revalidating {
    revalidate_after: number;
}

export interface AccessCacheOptions {
    maxStaleMs?: number;
    now?: () => number;
}

/** What a read found: the answer, and whether it can be served without calling Mesub. */
export interface CachedAnswer<T> {
    value: T;
    fresh: boolean;
}

/**
 * The `/v1/access` answers, by customer and plan, over any store.
 *
 * A store that fails never breaks a request: a read that throws is a miss,
 * a write that throws is dropped. A merchant whose Redis is down still gets
 * answers, straight from Mesub.
 */
export class AccessCache<T extends Revalidating> {
    private readonly maxStaleMs: number;
    private readonly now: () => number;

    constructor(
        private readonly store: CacheStore<T>,
        options: AccessCacheOptions = {},
    ) {
        this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
        this.now = options.now ?? Date.now;
    }

    /**
     * `mesub:access:<scope>:<plan>:<who>`, prefixed so it can share a Redis
     * with anything. The scope (the client passes a hash of its API key) keeps
     * two projects sharing one store apart; without one, `mesub:access:<plan>:<who>`.
     *
     * `who` is whatever names the customer, the client's being
     * `<kind>:<wallet or hash>`. A null plan is the list of every plan they
     * have, under its own prefix, `mesub:access-list:`: no plan slug can reach it.
     */
    static key(who: string, plan: string | null, scope?: string): string {
        const prefix = plan === null ? 'mesub:access-list' : 'mesub:access';
        const path = plan === null ? who : `${plan}:${who}`;

        return scope === undefined ? `${prefix}:${path}` : `${prefix}:${scope}:${path}`;
    }

    async read(
        who: string,
        plan: string | null,
        scope?: string,
    ): Promise<CachedAnswer<T> | undefined> {
        let entry: CacheEntry<T> | undefined;

        try {
            entry = await this.store.get(AccessCache.key(who, plan, scope));
        } catch {
            return undefined;
        }

        const now = this.now();

        // Checked here too: a store like Redis may keep a key a little longer.
        if (!entry || now > entry.keepUntil) return undefined;

        return { value: entry.value, fresh: now < entry.freshUntil };
    }

    async write(who: string, plan: string | null, value: T, scope?: string): Promise<void> {
        const now = this.now();
        const freshUntil = now + Math.max(0, value.revalidate_after) * 1000;
        const keepUntil = freshUntil + this.maxStaleMs;

        try {
            await this.store.set(
                AccessCache.key(who, plan, scope),
                { value, freshUntil, keepUntil },
                keepUntil - now,
            );
        } catch {
            // A store that cannot write costs a cached answer, never the request.
        }
    }
}
