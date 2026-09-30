import type { AccessAnswer, AccessOptions } from './answer.js';
import { AccessCache } from './cache/access-cache.js';
import { MemoryStore } from './cache/memory-store.js';
import type { CacheStore } from './cache/store.js';
import { MesubError } from './errors.js';
import { TokenVerifier, type VerifiedToken } from './tokens.js';
import { Transport } from './transport.js';

/** What a guard decided, and on which answer. */
export interface Decision {
    access: boolean;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback, not from Mesub just now. */
    stale: boolean;
}

export interface MesubOptions {
    /** Secret API key. Defaults to `process.env.MESUB_API_KEY`. */
    apiKey?: string;
    /** Defaults to `https://api.mesub.io`. */
    baseUrl?: string;
    /** A custom `fetch`, e.g. one bound to your own agent. Defaults to the global one. */
    fetch?: typeof fetch;
    /** Per attempt, in milliseconds. Defaults to 5000. */
    timeout?: number;
    /**
     * How many times a failed call to Mesub is sent again, after the first
     * attempt. Defaults to 2. HTTP retries only: nothing to do with a plan's
     * pull retries, which Mesub runs on its side (and a Free plan has none).
     */
    maxRetries?: number;
    /**
     * Where `/v1/access` answers are kept. Defaults to a memory store of
     * 10,000 entries, emptied on restart; a Redis store keeps the outage
     * fallback across restarts and servers.
     */
    cache?: CacheStore<AccessAnswer>;
}

const DEFAULT_BASE_URL = 'https://api.mesub.io';

export class Mesub {
    /** @internal */
    protected readonly transport: Transport;
    /** @internal */
    protected readonly cache: AccessCache<AccessAnswer>;
    /** @internal */
    protected readonly tokens: TokenVerifier;
    /** Asked once per process; forgotten if it failed, so the next call asks again. */
    private projectIdOnce: Promise<string> | undefined;

    constructor(options: MesubOptions = {}) {
        const apiKey = options.apiKey || process.env['MESUB_API_KEY'];
        if (!apiKey) {
            throw new Error(
                'Missing Mesub API key: pass `new Mesub({ apiKey })` or set MESUB_API_KEY.',
            );
        }

        this.transport = new Transport({
            apiKey,
            baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            // Resolved per call so a fetch patched after construction is still used.
            fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            timeout: options.timeout ?? 5_000,
            maxRetries: options.maxRetries ?? 2,
        });
        this.cache = new AccessCache(options.cache ?? new MemoryStore<AccessAnswer>());
        const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.tokens = new TokenVerifier({
            baseUrl,
            fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            projectId: () => this.projectId(),
        });
    }

    /**
     * Who the access token `@mesub/react` issued is about, verified locally
     * with Mesub's public keys. Throws a MesubError `invalid_token` for a
     * forged, expired or other project's token, `unavailable` when the keys
     * or the project id could not be fetched.
     */
    async verifyToken(token: string): Promise<VerifiedToken> {
        return this.tokens.verify(token);
    }

    /** The key's project id, from `GET /v1/project`, once per process. */
    private projectId(): Promise<string> {
        this.projectIdOnce ??= this.transport.get('/v1/project').then(
            (answer) => (answer as { id: string }).id,
            (error: unknown) => {
                this.projectIdOnce = undefined;
                throw error;
            },
        );

        return this.projectIdOnce;
    }

    /**
     * Everything Mesub knows about that wallet on that plan: whether it has
     * access, its status, its dates. Served from the cache while fresh.
     *
     * Throws a `MesubError` whenever Mesub cannot answer: it is for screens.
     * A guard calls `hasAccess`, which falls back instead.
     */
    async access(wallet: string, plan: string, options: AccessOptions = {}): Promise<AccessAnswer> {
        const attempts = options.attempts === true;

        if (!attempts) {
            const cached = await this.cache.read(wallet, plan);

            if (cached?.fresh) return cached.value;
        }

        // Throws a MesubError on any failure, which goes straight to the caller.
        const answer = (await this.transport.get('/v1/access', {
            wallet,
            plan,
            // Left out when not asked: the transport drops undefined values.
            attempts: attempts || undefined,
        })) as AccessAnswer;

        // A heavy answer must not replace the light one a guard reads.
        if (!attempts) await this.cache.write(wallet, plan, answer);

        return answer;
    }

    /**
     * Whether that wallet has access to that plan, for a guard.
     *
     * When Mesub is unavailable after the retries (`unavailable` or
     * `rate_limited`), it answers the last answer it knew, even stale, and
     * `false` for a wallet it never saw. Any other error is thrown, never
     * turned into `false`: a bad key or an unknown plan is a broken
     * integration, not a denial.
     */
    async hasAccess(wallet: string, plan: string): Promise<boolean> {
        return (await this.decide(wallet, plan)).access;
    }

    /**
     * `hasAccess`, with the answer it decided on: what the middlewares hand
     * the route. `answer` is null only for a wallet never seen during an
     * outage, `stale` is true when the answer came from the fallback.
     *
     * @internal
     */
    async decide(wallet: string, plan: string): Promise<Decision> {
        try {
            const answer = await this.access(wallet, plan);

            return { access: answer.access, answer, stale: false };
        } catch (error) {
            const unreachable =
                error instanceof MesubError &&
                (error.code === 'unavailable' || error.code === 'rate_limited');

            // A broken integration is thrown, never read as "no access".
            if (!unreachable) throw error;

            // The last answer known, even stale; a wallet never seen stays out.
            const cached = await this.cache.read(wallet, plan);

            return cached
                ? { access: cached.value.access, answer: cached.value, stale: true }
                : { access: false, answer: null, stale: true };
        }
    }
}
