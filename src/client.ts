import type { AccessAnswer, AccessOptions } from './answer.js';
import { AccessCache } from './cache/access-cache.js';
import { MemoryStore } from './cache/memory-store.js';
import type { CacheStore } from './cache/store.js';
import { MesubError } from './errors.js';
import { TokenVerifier, type VerifiedToken } from './tokens.js';
import { type CallOptions, Transport } from './transport.js';

/** What a guard decided, and on which answer. */
export interface Decision {
    access: boolean;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback, not from Mesub just now. */
    stale: boolean;
    /**
     * Mesub did not answer (an outage, a rate limit, or the guard's time
     * budget running out) and no answer was cached for that wallet: nobody
     * knows yet, so the guards answer 503, not 402.
     */
    unavailable?: boolean;
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
    /**
     * How long an answer is kept once stale, for the outage fallback of
     * `hasAccess` and the guards, in milliseconds. Defaults to 24 hours. 0
     * turns the fallback off: an outage then keeps everyone out.
     */
    maxStaleMs?: number;
    /**
     * How long the guards (`requirePlan`, `withMesub`, `RequirePlan`) give
     * Mesub to answer, retries and waits included, in milliseconds. Defaults
     * to 2000. Once it runs out, or Mesub fails, the guard answers from the
     * cache, even stale, or 503 with Retry-After for a wallet it never saw. `access` and
     * `hasAccess`, called directly, are not bound by it.
     */
    guardTimeout?: number;
}

const DEFAULT_BASE_URL = 'https://api.mesub.io';
const DEFAULT_GUARD_TIMEOUT = 2_000;

export class Mesub {
    /** @internal */
    protected readonly transport: Transport;
    /** @internal */
    protected readonly cache: AccessCache<AccessAnswer>;
    /** @internal */
    protected readonly tokens: TokenVerifier;
    /** Asked once per process; forgotten if it failed, so the next call asks again. */
    private projectIdOnce: Promise<string> | undefined;
    /** What the cache keys are scoped by: a hash of the API key, computed once. */
    private readonly cacheScope: () => Promise<string>;
    private readonly guardTimeout: number;

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
        this.cache = new AccessCache(
            options.cache ?? new MemoryStore<AccessAnswer>(),
            options.maxStaleMs === undefined ? {} : { maxStaleMs: options.maxStaleMs },
        );
        this.guardTimeout = options.guardTimeout ?? DEFAULT_GUARD_TIMEOUT;
        // NaN or 0 would cut every guard's call before it starts.
        if (!(this.guardTimeout > 0)) {
            throw new Error('guardTimeout must be a positive number of milliseconds.');
        }
        let cacheScope: Promise<string> | undefined;
        this.cacheScope = () => (cacheScope ??= hashScope(apiKey));
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
    private projectId(call: CallOptions = {}): Promise<string> {
        this.projectIdOnce ??= this.transport.get('/v1/project', {}, call).then(
            (answer) => {
                const { id } = (answer ?? {}) as { id?: unknown };

                // Anything else would reach jose as no audience, which skips the
                // check: a token of any project would pass (#27). Not kept, so
                // the next call asks again.
                if (typeof id !== 'string' || id === '') {
                    this.projectIdOnce = undefined;
                    throw missingProjectId();
                }
                return id;
            },
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
        // Attempts skip the cache both ways: no scope to resolve.
        if (options.attempts === true) return this.ask(wallet, plan, null);

        return this.ask(wallet, plan, await this.cacheScope());
    }

    /**
     * `access`, in the cache scope its caller resolved once, or without the
     * cache at all (`null`) for an answer with its attempts.
     */
    private async ask(
        wallet: string,
        plan: string,
        scope: string | null,
        call: CallOptions = {},
    ): Promise<AccessAnswer> {
        const attempts = scope === null;

        if (!attempts) {
            const cached = await this.cache.read(wallet, plan, scope);

            if (cached?.fresh) return cached.value;
        }

        // Throws a MesubError on any failure, which goes straight to the caller.
        const answer = (await this.transport.get(
            '/v1/access',
            {
                wallet,
                plan,
                // Left out when not asked: the transport drops undefined values.
                attempts: attempts || undefined,
            },
            call,
        )) as AccessAnswer;

        // A heavy answer must not replace the light one a guard reads.
        if (!attempts) await this.cache.write(wallet, plan, answer, scope);

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
        return (await this.decideBy(wallet, plan)).access;
    }

    /**
     * `hasAccess`, with the answer it decided on, within `guardTimeout`: what
     * the middlewares hand the route. `answer` is null only for a wallet never
     * seen during an outage, which is then `unavailable`; `stale` is true
     * when the answer came from the fallback.
     *
     * @internal
     */
    async decide(wallet: string, plan: string): Promise<Decision> {
        return this.decideBy(wallet, plan, Date.now() + this.guardTimeout);
    }

    /**
     * The decision itself. With a deadline (the guards), every call to Mesub
     * fits before it: attempts are cut at it and a Retry-After that would
     * outlast it is not waited. Without one (`hasAccess` called directly),
     * the client's timeout and retries, as configured.
     */
    private async decideBy(wallet: string, plan: string, deadline?: number): Promise<Decision> {
        const call: CallOptions = deadline === undefined ? {} : { deadline };
        const scope = await this.cacheScope();

        try {
            const answer = await this.ask(wallet, plan, scope, call);

            return { access: answer.access, answer, stale: false };
        } catch (error) {
            const unreachable =
                error instanceof MesubError &&
                (error.code === 'unavailable' || error.code === 'rate_limited');

            // A broken integration is thrown, never read as "no access".
            if (!unreachable) throw error;

            // The last answer known, even stale; a wallet never seen stays out.
            const cached = await this.cache.read(wallet, plan, scope);

            if (cached) {
                return { access: stillGrants(cached.value), answer: cached.value, stale: true };
            }

            // Not Mesub saying no: nobody knows, so a guard asks for a retry later.
            return { access: false, answer: null, stale: true, unavailable: true };
        }
    }
}

/**
 * `key-` and 16 hex characters of the API key's SHA-256: a scope, not a way
 * back to the key. Two projects sharing one store never share a key, and it
 * needs no call to Mesub, so it is the same after a restart in an outage. A
 * rotated key starts a new scope; the old entries expire on their TTL.
 */
async function hashScope(apiKey: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));

    return `key-${hex.join('').slice(0, 16)}`;
}

/** `/v1/project` answered without an id: like an outage, nobody can be identified. */
function missingProjectId(): MesubError {
    return new MesubError('Mesub answered /v1/project without a project id.', {
        status: null,
        code: 'unavailable',
    });
}

/**
 * A stale answer's access, past what it paid for (#35): an answer with no
 * charge or retry ahead (cancelled, parked) ends at `access_until`. One with a
 * renewal ahead keeps the fallback: it was likely paid while Mesub was down.
 */
function stillGrants(answer: AccessAnswer, now: number = Date.now()): boolean {
    if (!answer.access || !answer.access_until) return answer.access;
    if (answer.next_charge_at || answer.next_retry_at) return true;
    return Date.parse(answer.access_until) > now;
}
