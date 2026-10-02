import type { AccessAnswer, AccessList, AccessOptions, Customer } from './answer.js';
import { AccessCache } from './cache/access-cache.js';
import { MemoryStore } from './cache/memory-store.js';
import type { CacheStore } from './cache/store.js';
import { type Asked, customerOf } from './customer.js';
import { MesubError } from './errors.js';
import { apiKeyOf, baseUrlOf, headersOf, issuerOf, numberOf } from './options.js';
import { Subscriptions } from './subscriptions.js';
import { TokenVerifier, type VerifiedToken } from './tokens.js';
import { type CallOptions, Transport } from './transport.js';
import { accessAnswerFrom, accessListFrom } from './validate.js';

/** What a guard decided, and on which answer. */
export interface Decision {
    access: boolean;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback, not from Mesub just now. */
    stale: boolean;
    /**
     * Mesub did not answer (an outage, a rate limit, or the guard's time
     * budget running out) and no answer was cached for that customer: nobody
     * knows yet, so the guards answer 503, not 402.
     */
    unavailable?: boolean;
}

export interface MesubOptions {
    /** Secret API key. Defaults to `process.env.MESUB_API_KEY`. */
    apiKey?: string;
    /**
     * Defaults to `https://api.mesub.io`. May carry a path, e.g. behind a
     * proxy at `https://proxy.example.com/mesub`: every call, the public keys
     * included, is made under it.
     */
    baseUrl?: string;
    /**
     * What the access tokens' `iss` must be: Mesub's own public API URL.
     * Defaults to `baseUrl`; set it when `baseUrl` is a proxy, e.g.
     * `https://api.mesub.io`.
     */
    issuer?: string;
    /**
     * Extra headers sent with every call to Mesub, the public keys included:
     * e.g. a Cloudflare Access service token for the proxy in front. Cannot
     * set Authorization, User-Agent, Accept nor Content-Type.
     */
    headers?: Record<string, string>;
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
    cache?: CacheStore<AccessAnswer | AccessList>;
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
    /** Subscribing from your server: create, submit, retrieve and list. */
    readonly subscriptions: Subscriptions;
    /** @internal */
    protected readonly transport: Transport;
    /** @internal */
    protected readonly cache: AccessCache<AccessAnswer>;
    /** The lists of `accessList`, in the same store, under their own keys. */
    private readonly lists: AccessCache<AccessList>;
    /** @internal */
    protected readonly tokens: TokenVerifier;
    /** Asked once per process; forgotten if it failed, so the next call asks again. */
    private projectIdOnce: Promise<string> | undefined;
    /** What the cache keys are scoped by: a hash of the API key, computed once. */
    private readonly cacheScope: () => Promise<string>;
    /** What hashes emails and external ids in the cache keys: the API key, imported once. */
    private readonly cacheSecret: () => Promise<HmacKey>;
    private readonly guardTimeout: number;

    constructor(options: MesubOptions = {}) {
        // Every option is checked here, before anything is built: a TypeError
        // now rather than a 401 or a 1 ms timeout on every call.
        const apiKey = apiKeyOf(options.apiKey);
        const baseUrl = baseUrlOf(options.baseUrl, DEFAULT_BASE_URL);
        const issuer = issuerOf(options.issuer, baseUrl);
        const headers = headersOf(options.headers);
        if (options.fetch !== undefined && typeof options.fetch !== 'function') {
            throw new TypeError('fetch must be a function.');
        }
        // Resolved per call so a fetch patched after construction is still used.
        const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        // NaN or 0 would cut every call before it starts.
        this.guardTimeout = numberOf('guardTimeout', options.guardTimeout, DEFAULT_GUARD_TIMEOUT, {
            delay: true,
        });

        this.transport = new Transport({
            apiKey,
            baseUrl,
            headers,
            fetch,
            timeout: numberOf('timeout', options.timeout, 5_000, { delay: true }),
            maxRetries: numberOf('maxRetries', options.maxRetries, 2, {
                zero: true,
                integer: true,
            }),
        });
        this.subscriptions = new Subscriptions(this.transport);
        const store = options.cache ?? new MemoryStore<AccessAnswer | AccessList>();
        const staleness =
            options.maxStaleMs === undefined
                ? {}
                : { maxStaleMs: numberOf('maxStaleMs', options.maxStaleMs, 0, { zero: true }) };
        // One store for both: their keys never meet (`mesub:access:` and
        // `mesub:access-list:`), so each reads back only what it wrote.
        this.cache = new AccessCache(store as CacheStore<AccessAnswer>, staleness);
        this.lists = new AccessCache(store as CacheStore<AccessList>, staleness);
        let cacheScope: Promise<string> | undefined;
        this.cacheScope = () => (cacheScope ??= hashScope(apiKey));
        let cacheSecret: Promise<HmacKey> | undefined;
        this.cacheSecret = () => (cacheSecret ??= importSecret(apiKey));
        this.tokens = new TokenVerifier({
            baseUrl,
            issuer,
            headers,
            fetch,
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
     * Everything Mesub knows about that customer on that plan: whether they
     * have access, their status, their dates. Served from the cache while fresh.
     *
     * The customer is `{ wallet }`, `{ external_id }` or `{ email }`, or a
     * wallet as a string. Asked by external id or email, the answer is about
     * the wallet that grants access, if any: `wallet` is null when they have
     * nothing on that plan.
     *
     * Throws a `MesubError` whenever Mesub cannot answer: it is for screens.
     * A guard calls `hasAccess`, which falls back instead.
     */
    async access(
        customer: Customer | string,
        plan: string,
        options: AccessOptions = {},
    ): Promise<AccessAnswer> {
        const asked = customerOf(customer);
        const slug = planOf(plan);

        // Attempts skip the cache both ways: no key to compute.
        if (options.attempts === true) return this.ask(asked, slug, null);

        return this.ask(asked, slug, await this.slotOf(asked));
    }

    /**
     * Every plan of the project that customer has anything on, each answered
     * like `access`, for a page listing their entitlements in one call. Cached
     * apart from the answers by plan, for its own `revalidate_after`.
     *
     * Throws a `MesubError` whenever Mesub cannot answer, like `access`.
     */
    async accessList(
        customer: Customer | string,
        options: AccessOptions = {},
    ): Promise<AccessList> {
        const asked = customerOf(customer);
        const attempts = options.attempts === true;
        // Attempts skip the cache both ways, as with `access`.
        const slot = attempts ? null : await this.slotOf(asked);

        if (slot) {
            const cached = await this.lists.read(slot.who, null, slot.scope);

            if (cached?.fresh) return cached.value;
        }

        // Checked like `access`'s answer, before it reaches the cache.
        const list = accessListFrom(
            await this.transport.get('/v1/access', {
                [asked.kind]: asked.value,
                attempts: attempts || undefined,
            }),
        );

        if (slot) await this.lists.write(slot.who, null, list, slot.scope);

        return list;
    }

    /**
     * `access`, in the cache slot its caller computed once, or without the
     * cache at all (`null`) for an answer with its attempts.
     */
    private async ask(
        asked: Asked,
        plan: string,
        slot: Slot | null,
        call: CallOptions = {},
    ): Promise<AccessAnswer> {
        const attempts = slot === null;

        if (slot) {
            const cached = await this.cache.read(slot.who, plan, slot.scope);

            if (cached?.fresh) return cached.value;
        }

        // Throws a MesubError on any failure, which goes straight to the caller;
        // an answer of the wrong shape too, before it reaches the cache.
        const answer = accessAnswerFrom(
            await this.transport.get(
                '/v1/access',
                {
                    [asked.kind]: asked.value,
                    plan,
                    // Left out when not asked: the transport drops undefined values.
                    attempts: attempts || undefined,
                },
                call,
            ),
        );

        // A heavy answer must not replace the light one a guard reads.
        if (slot) await this.cache.write(slot.who, plan, answer, slot.scope);

        return answer;
    }

    /**
     * Where a customer's answers are cached: the project's scope, and who
     * they are as the key reads it. A wallet is public on chain and stays
     * readable; an email or an external id is never written in clear, only
     * as an HMAC under the API key, which a leaked Redis alone cannot reverse
     * by guessing.
     */
    private async slotOf(asked: Asked): Promise<Slot> {
        const scope = await this.cacheScope();

        if (asked.kind === 'wallet') return { scope, who: `wallet:${asked.value}` };

        const mac = await crypto.subtle.sign(
            'HMAC',
            await this.cacheSecret(),
            new TextEncoder().encode(`${asked.kind}:${asked.value}`),
        );

        return { scope, who: `${asked.kind}:${hex(mac)}` };
    }

    /**
     * Whether that customer has access to that plan, for a guard. The
     * customer is the same as for `access`, a wallet string included.
     *
     * When Mesub is unavailable after the retries (`unavailable` or
     * `rate_limited`), it answers the last answer it knew, even stale, and
     * `false` for a customer it never saw. Any other error is thrown, never
     * turned into `false`: a bad key or an unknown plan is a broken
     * integration, not a denial.
     */
    async hasAccess(customer: Customer | string, plan: string): Promise<boolean> {
        return (await this.decideBy(customer, plan)).access;
    }

    /**
     * `hasAccess`, with the answer it decided on, within `guardTimeout`: what
     * the middlewares hand the route. `answer` is null only for a customer
     * never seen during an outage, which is then `unavailable`; `stale` is
     * true when the answer came from the fallback.
     *
     * @internal
     */
    async decide(customer: Customer | string, plan: string): Promise<Decision> {
        return this.decideBy(customer, plan, Date.now() + this.guardTimeout);
    }

    /**
     * The decision itself. With a deadline (the guards), every call to Mesub
     * fits before it: attempts are cut at it and a Retry-After that would
     * outlast it is not waited. Without one (`hasAccess` called directly),
     * the client's timeout and retries, as configured.
     */
    private async decideBy(
        customer: Customer | string,
        plan: string,
        deadline?: number,
    ): Promise<Decision> {
        const call: CallOptions = deadline === undefined ? {} : { deadline };
        // A malformed customer or a missing plan is thrown before anything is asked.
        const asked = customerOf(customer);
        const slug = planOf(plan);
        const slot = await this.slotOf(asked);

        try {
            const answer = await this.ask(asked, slug, slot, call);

            return { access: answer.access, answer, stale: false };
        } catch (error) {
            const unreachable =
                error instanceof MesubError &&
                (error.code === 'unavailable' || error.code === 'rate_limited');

            // A broken integration is thrown, never read as "no access".
            if (!unreachable) throw error;

            // The last answer known, even stale; a customer never seen stays out.
            const cached = await this.cache.read(slot.who, slug, slot.scope);

            if (cached) {
                return { access: stillGrants(cached.value), answer: cached.value, stale: true };
            }

            // Not Mesub saying no: nobody knows, so a guard asks for a retry later.
            return { access: false, answer: null, stale: true, unavailable: true };
        }
    }
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Where a customer's answers are cached: see `slotOf`. */
interface Slot {
    scope: string;
    who: string;
}

/**
 * The plan, which `access`, `hasAccess` and the guards cannot do without.
 * Without it Mesub answers the list of every plan instead: read as one
 * answer, it would be cached under `undefined` and its missing `access` taken
 * for a no. The list is `accessList`.
 */
function planOf(plan: unknown): string {
    if (typeof plan !== 'string' || plan === '') {
        throw new TypeError('A plan is needed: accessList(customer) lists every plan instead.');
    }

    return plan;
}

/**
 * `key-` and 16 hex characters of the API key's SHA-256: a scope, not a way
 * back to the key. Two projects sharing one store never share a key, and it
 * needs no call to Mesub, so it is the same after a restart in an outage. A
 * rotated key starts a new scope; the old entries expire on their TTL.
 */
async function hashScope(apiKey: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));

    return `key-${hex(digest).slice(0, 16)}`;
}

/** The API key as an HMAC key, for the hashes of emails and external ids. */
function importSecret(apiKey: string): Promise<HmacKey> {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(apiKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
}

function hex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
