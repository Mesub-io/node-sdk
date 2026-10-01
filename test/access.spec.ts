import type { AccessAnswer, CacheStore, MesubOptions } from '../src/index.js';
import { Mesub, MemoryStore, MesubError } from '../src/index.js';
import { json, mockFetch, nest } from './helpers.js';

const WALLET = 'SysvarRent111111111111111111111111111111111';
const OTHER_WALLET = 'SysvarC1ock11111111111111111111111111111111';
const START = new Date('2026-09-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function answer(over: Partial<AccessAnswer> = {}): AccessAnswer {
    return {
        wallet: WALLET,
        plan: 'pro',
        access: true,
        status: 'active',
        payment_status: 'paid',
        subscribed_since: '2026-09-01T00:00:00.000Z',
        first_subscribed_at: '2026-09-01T00:00:00.000Z',
        current_period_end: '2026-10-01T00:00:00.000Z',
        cancelled_at: null,
        access_until: null,
        next_charge_at: '2026-10-01T00:00:00.000Z',
        next_retry_at: null,
        revalidate_after: 60,
        ...over,
    };
}

const PROJECT = 'proj_1';

/** `/v1/project` answers `project`; every other call goes to `fetch`. */
function withProject(
    fetch: typeof globalThis.fetch,
    project: () => Response | Error = () => json(200, { id: PROJECT }),
): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(input)).pathname !== '/v1/project') return fetch(input, init);

        const answer = project();
        if (answer instanceof Error) throw answer;
        return answer;
    }) as typeof globalThis.fetch;
}

/** No retries: an outage is one failed call, not three waits of backoff. */
function client(
    fetch: typeof globalThis.fetch,
    cache?: CacheStore<AccessAnswer>,
    options: MesubOptions = {},
) {
    return new Mesub({
        apiKey: 'SUB_test',
        baseUrl: 'https://api.mesub.test',
        fetch: withProject(fetch),
        maxRetries: 0,
        ...(cache ? { cache } : {}),
        ...options,
    });
}

describe('access', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('asks /v1/access about that wallet and plan, with the secret key', async () => {
        const { fetch, calls } = mockFetch(json(200, answer()));

        await expect(client(fetch).access(WALLET, 'pro')).resolves.toEqual(answer());

        expect(calls[0]!.url.pathname).toBe('/v1/access');
        expect(calls[0]!.url.searchParams.get('wallet')).toBe(WALLET);
        expect(calls[0]!.url.searchParams.get('plan')).toBe('pro');
        expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer SUB_test');
    });

    it('does not ask for attempts unless told to', async () => {
        const { fetch, calls } = mockFetch(json(200, answer()));

        await client(fetch).access(WALLET, 'pro');

        expect(calls[0]!.url.searchParams.has('attempts')).toBe(false);
    });

    it('asks for attempts when told to', async () => {
        const { fetch, calls } = mockFetch(json(200, answer({ attempts: [] })));

        await client(fetch).access(WALLET, 'pro', { attempts: true });

        expect(calls[0]!.url.searchParams.get('attempts')).toBe('true');
    });

    describe('the cache', () => {
        it('answers again from the cache while revalidate_after lasts', async () => {
            const { fetch, calls } = mockFetch(json(200, answer()));
            const mesub = client(fetch);

            await mesub.access(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 59_000);

            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            expect(calls).toHaveLength(1);
        });

        it('asks again once revalidate_after ran out', async () => {
            const { fetch, calls } = mockFetch(
                json(200, answer()),
                json(200, answer({ access: false, status: 'unpaid' })),
            );
            const mesub = client(fetch);

            await mesub.access(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 60_000);

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({ access: false });
            expect(calls).toHaveLength(2);
        });

        it('keeps wallets and plans apart', async () => {
            const { fetch, calls } = mockFetch(
                json(200, answer()),
                json(200, answer({ plan: 'team' })),
                json(200, answer({ wallet: OTHER_WALLET })),
            );
            const mesub = client(fetch);

            await mesub.access(WALLET, 'pro');
            await mesub.access(WALLET, 'team');
            await mesub.access(OTHER_WALLET, 'pro');

            expect(calls).toHaveLength(3);
        });

        // A page asking for the history must get it, whatever a guard cached.
        it('skips a cached answer when attempts are asked for', async () => {
            const { fetch, calls } = mockFetch(
                json(200, answer()),
                json(200, answer({ attempts: [] })),
            );
            const mesub = client(fetch);

            await mesub.access(WALLET, 'pro');
            await expect(mesub.access(WALLET, 'pro', { attempts: true })).resolves.toHaveProperty(
                'attempts',
            );
            expect(calls).toHaveLength(2);
        });

        // The heavy answer must not replace the light one a guard reads.
        it('caches nothing when attempts are asked for', async () => {
            const { fetch, calls } = mockFetch(
                json(200, answer({ attempts: [] })),
                json(200, answer()),
            );
            const mesub = client(fetch);

            await mesub.access(WALLET, 'pro', { attempts: true });
            await mesub.access(WALLET, 'pro');

            expect(calls).toHaveLength(2);
        });

        it('caches nothing when Mesub refuses', async () => {
            const { fetch, calls } = mockFetch(
                nest(404, 'No plan of yours is named pro.'),
                json(200, answer()),
            );
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).rejects.toBeInstanceOf(MesubError);
            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            expect(calls).toHaveLength(2);
        });

        it('writes to the store it is given', async () => {
            const set = vi.fn();
            const { fetch } = mockFetch(json(200, answer()));

            await client(fetch, { get: () => undefined, set }).access(WALLET, 'pro');

            expect(set).toHaveBeenCalledWith(
                `mesub:access:${PROJECT}:pro:${WALLET}`,
                expect.objectContaining({ value: answer() }),
                expect.any(Number),
            );
        });
    });

    // Two projects sharing one Redis must never read each other's answers.
    describe('the cache scope', () => {
        it('asks /v1/project once, then keeps it', async () => {
            const project = vi.fn(() => json(200, { id: PROJECT }));
            const { fetch } = mockFetch(json(200, answer()), json(200, answer({ plan: 'team' })));
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, project),
                maxRetries: 0,
            });

            await mesub.access(WALLET, 'pro');
            await mesub.access(WALLET, 'team');

            expect(project).toHaveBeenCalledOnce();
        });

        it('keeps two projects sharing one store apart', async () => {
            const store = new MemoryStore<AccessAnswer>();
            const first = mockFetch(json(200, answer()));
            const second = mockFetch(json(200, answer({ access: false, status: 'none' })));
            const project = (id: string, fetch: typeof globalThis.fetch) =>
                new Mesub({
                    apiKey: `SUB_${id}`,
                    baseUrl: 'https://api.mesub.test',
                    fetch: withProject(fetch, () => json(200, { id })),
                    cache: store,
                });

            await expect(project('proj_a', first.fetch).hasAccess(WALLET, 'pro')).resolves.toBe(
                true,
            );
            await expect(project('proj_b', second.fetch).hasAccess(WALLET, 'pro')).resolves.toBe(
                false,
            );
            expect(second.calls).toHaveLength(1);
        });

        it('scopes by a hash of the API key while /v1/project cannot answer', async () => {
            const set = vi.fn();
            const { fetch } = mockFetch(json(200, answer()));
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, () => nest(503, 'Service Unavailable')),
                cache: { get: () => undefined, set },
            });

            await mesub.access(WALLET, 'pro');

            const key = set.mock.calls[0]![0] as string;
            expect(key).toMatch(new RegExp(`^mesub:access:key-[0-9a-f]{16}:pro:${WALLET}$`));
            expect(key).not.toContain('SUB_test');
        });

        it('hashes two API keys apart', async () => {
            const keys: string[] = [];
            const scoped = (apiKey: string) =>
                new Mesub({
                    apiKey,
                    baseUrl: 'https://api.mesub.test',
                    fetch: withProject(mockFetch(json(200, answer())).fetch, () =>
                        nest(503, 'Service Unavailable'),
                    ),
                    cache: { get: () => undefined, set: (key) => void keys.push(key) },
                });

            await scoped('SUB_one').access(WALLET, 'pro');
            await scoped('SUB_two').access(WALLET, 'pro');

            expect(keys[0]).not.toBe(keys[1]);
        });

        // A single attempt: the scope must not add the retries of an outage.
        it('asks /v1/project once per call while it fails, without retrying', async () => {
            const project = vi.fn(() => nest(503, 'Service Unavailable'));
            const { fetch } = mockFetch(
                json(200, answer({ revalidate_after: 0 })),
                json(200, answer()),
            );
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, project),
                maxRetries: 2,
            });

            await mesub.hasAccess(WALLET, 'pro');
            await mesub.hasAccess(WALLET, 'pro');

            expect(project).toHaveBeenCalledTimes(2);
        });

        it('moves to the project scope once /v1/project answers', async () => {
            const set = vi.fn();
            let up = false;
            const { fetch } = mockFetch(json(200, answer()), json(200, answer()));
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, () =>
                    up ? json(200, { id: PROJECT }) : new TypeError('fetch failed'),
                ),
                maxRetries: 0,
                cache: { get: () => undefined, set },
            });

            await mesub.access(WALLET, 'pro');
            up = true;
            await mesub.access(WALLET, 'pro');

            expect(set.mock.calls[0]![0]).toMatch(/^mesub:access:key-/);
            expect(set.mock.calls[1]![0]).toBe(`mesub:access:${PROJECT}:pro:${WALLET}`);
        });
    });

    describe('when Mesub cannot answer', () => {
        it.each([
            ['a refused plan', nest(404, 'No plan of yours is named pro.'), 'plan_not_found'],
            ['a bad key', nest(401, 'That API key is not valid.'), 'unauthorized'],
            [
                'a bad wallet',
                nest(400, ['wallet must be a base58 Solana address']),
                'invalid_request',
            ],
            ['an outage', nest(503, 'Service Unavailable'), 'unavailable'],
        ])('throws on %s, even with a stale answer cached', async (_label, failure, code) => {
            const { fetch } = mockFetch(json(200, answer()), failure);
            const mesub = client(fetch);
            await mesub.access(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 61_000);

            await expect(mesub.access(WALLET, 'pro')).rejects.toMatchObject({ code });
        });
    });
});

describe('hasAccess', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('answers true for a wallet with access', async () => {
        const { fetch } = mockFetch(json(200, answer()));

        await expect(client(fetch).hasAccess(WALLET, 'pro')).resolves.toBe(true);
    });

    it('answers false for a wallet without', async () => {
        const { fetch } = mockFetch(json(200, answer({ access: false, status: 'none' })));

        await expect(client(fetch).hasAccess(WALLET, 'pro')).resolves.toBe(false);
    });

    it('answers from the cache while fresh', async () => {
        const { fetch, calls } = mockFetch(json(200, answer()));
        const mesub = client(fetch);

        await mesub.hasAccess(WALLET, 'pro');
        await mesub.hasAccess(WALLET, 'pro');

        expect(calls).toHaveLength(1);
    });

    describe('during an outage', () => {
        /** A first answer, then Mesub failing once it went stale. */
        async function staleThen(first: AccessAnswer, failure: Response | Error) {
            const { fetch } = mockFetch(json(200, first), failure);
            const mesub = client(fetch);
            await mesub.hasAccess(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 61_000);

            return mesub;
        }

        // A paying subscriber is not locked out because Mesub is down.
        it('keeps a paying subscriber in, from the stale answer', async () => {
            const mesub = await staleThen(answer(), nest(503, 'Service Unavailable'));

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        });

        it('keeps out a wallet whose last answer was no', async () => {
            const mesub = await staleThen(
                answer({ access: false }),
                nest(503, 'Service Unavailable'),
            );

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        // A stranger does not get in because Mesub is down.
        it('keeps out a wallet it never saw', async () => {
            const { fetch } = mockFetch(nest(503, 'Service Unavailable'));

            await expect(client(fetch).hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it.each([
            ['the network failing', new TypeError('fetch failed')],
            ['a 500', nest(500, 'Internal server error')],
            ['a 502', nest(502, 'Bad gateway')],
            ['being rate limited', nest(429, 'ThrottlerException: Too Many Requests')],
        ])('falls back on %s', async (_label, failure) => {
            const mesub = await staleThen(answer(), failure);

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        });

        it('keeps out a wallet whose answer is more than a day stale', async () => {
            const { fetch } = mockFetch(json(200, answer()), nest(503, 'Service Unavailable'));
            const mesub = client(fetch);
            await mesub.hasAccess(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 60_000 + DAY + 1);

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it('keeps a stale answer only as long as maxStaleMs says', async () => {
            const { fetch } = mockFetch(
                json(200, answer()),
                nest(503, 'Service Unavailable'),
                nest(503, 'Service Unavailable'),
            );
            const mesub = client(fetch, undefined, { maxStaleMs: 1_000 });
            await mesub.hasAccess(WALLET, 'pro');

            vi.setSystemTime(START.getTime() + 60_000 + 1_000);
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);

            vi.setSystemTime(START.getTime() + 60_000 + 1_001);
            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it('falls back on the answer of that plan only', async () => {
            const mesub = await staleThen(answer(), nest(503, 'Service Unavailable'));

            await expect(mesub.hasAccess(WALLET, 'team')).resolves.toBe(false);
        });
    });

    // A broken integration must be seen, not read as "no access".
    describe('an integration error', () => {
        it.each([
            ['a bad key', nest(401, 'That API key is not valid.'), 'unauthorized'],
            ['an unknown plan', nest(404, 'No plan of yours is named pro.'), 'plan_not_found'],
            [
                'a malformed wallet',
                nest(400, ['wallet must be a base58 Solana address']),
                'invalid_request',
            ],
            ['a forbidden call', nest(403, 'Forbidden'), 'unexpected'],
        ])('throws on %s, and never answers false', async (_label, failure, code) => {
            const { fetch } = mockFetch(failure);

            const error = await client(fetch)
                .hasAccess(WALLET, 'pro')
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({ code });
        });

        it('throws even with an answer cached', async () => {
            const { fetch } = mockFetch(
                json(200, answer()),
                nest(401, 'That API key is not valid.'),
            );
            const mesub = client(fetch);
            await mesub.hasAccess(WALLET, 'pro');
            vi.setSystemTime(START.getTime() + 61_000);

            await expect(mesub.hasAccess(WALLET, 'pro')).rejects.toMatchObject({
                code: 'unauthorized',
            });
        });
    });
});

/**
 * A Free plan has no pull retries (#57): a missed pull stops the subscription
 * at once, and /v1/access answers it the way below. Nothing in the SDK depends
 * on retries: it reads `access`, whatever the tier.
 */
describe('a plan without pull retries', () => {
    const stopped = answer({
        access: false,
        status: 'stopped',
        payment_status: 'none',
        access_until: null,
        next_charge_at: null,
        next_retry_at: null,
        revalidate_after: 300,
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('answers false once the missed pull stopped it', async () => {
        const { fetch } = mockFetch(json(200, stopped));

        await expect(client(fetch).hasAccess(WALLET, 'pro')).resolves.toBe(false);
    });

    it('never reports a retry to come', async () => {
        const { fetch } = mockFetch(json(200, stopped));

        await expect(client(fetch).access(WALLET, 'pro')).resolves.toMatchObject({
            payment_status: 'none',
            next_retry_at: null,
        });
    });

    // Before the due date Mesub shrinks revalidate_after to the seconds left,
    // so an active answer does not outlive the pull that may stop it.
    it('asks again right after the due date, not minutes later', async () => {
        const { fetch, calls } = mockFetch(
            json(200, answer({ revalidate_after: 10 })),
            json(200, stopped),
        );
        const mesub = client(fetch);

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        vi.setSystemTime(START.getTime() + 10_000);

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        expect(calls).toHaveLength(2);
    });

    it('keeps it out during an outage once the stop was seen', async () => {
        const { fetch } = mockFetch(json(200, stopped), nest(503, 'Service Unavailable'));
        const mesub = client(fetch);
        await mesub.hasAccess(WALLET, 'pro');
        vi.setSystemTime(START.getTime() + 301_000);

        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
    });
});
