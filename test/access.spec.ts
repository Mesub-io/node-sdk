import { createHash, createHmac } from 'node:crypto';

import type { AccessAnswer, AccessList, CacheStore, MesubOptions } from '../src/index.js';
import { Mesub, MemoryStore, MesubError } from '../src/index.js';
import { coded, json, mockFetch, nest } from './helpers.js';

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
        paused: false,
        end_reason: null,
        payment_status: 'paid',
        subscribed_since: '2026-09-01T00:00:00.000Z',
        first_subscribed_at: '2026-09-01T00:00:00.000Z',
        current_period_end: '2026-10-01T00:00:00.000Z',
        cancelled_at: null,
        access_until: null,
        next_charge_at: '2026-10-01T00:00:00.000Z',
        next_retry_at: null,
        retry_deadline: null,
        revalidate_after: 60,
        ...over,
    };
}

const PROJECT = 'proj_1';

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/** How the cache key names an email or an external id: an HMAC under the API key. */
function hmac(kind: string, value: string, apiKey = 'SUB_test'): string {
    return createHmac('sha256', apiKey).update(`${kind}:${value}`).digest('hex');
}

const SCOPE = `key-${sha256('SUB_test').slice(0, 16)}`;

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
    cache?: CacheStore<AccessAnswer | AccessList>,
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
                `mesub:access:key-${sha256('SUB_test').slice(0, 16)}:pro:wallet:${WALLET}`,
                expect.objectContaining({ value: answer() }),
                expect.any(Number),
            );
        });
    });

    // An answer the SDK cannot read must never be cached, nor read as a yes (#31).
    describe('an answer of the wrong shape', () => {
        /** The answer, with that field set, or removed when `value` is undefined. */
        function without(field: string, value?: unknown): Record<string, unknown> {
            const body: Record<string, unknown> = { ...answer() };

            if (value === undefined) delete body[field];
            else body[field] = value;

            return body;
        }

        it.each([
            ['no revalidate_after', without('revalidate_after'), 'revalidate_after is missing'],
            [
                'a null revalidate_after',
                without('revalidate_after', null),
                'revalidate_after is not a finite number of seconds',
            ],
            [
                'revalidate_after as a string',
                without('revalidate_after', '60'),
                'revalidate_after is not a finite number of seconds',
            ],
            ['no access', without('access'), 'access is missing'],
            ['access as a string', without('access', 'true'), 'access is not a boolean'],
            ['access as 1', without('access', 1), 'access is not a boolean'],
            ['a numeric wallet', without('wallet', 42), 'wallet is not a string or null'],
            ['no wallet', without('wallet'), 'wallet is missing'],
            ['no plan', without('plan'), 'plan is missing'],
            ['no status', without('status'), 'status is missing'],
            [
                'a date that is not one',
                without('access_until', 'tomorrow'),
                'access_until is not a date or null',
            ],
            [
                'a date as a number',
                without('next_charge_at', 0),
                'next_charge_at is not a date or null',
            ],
            [
                'a retry_deadline that is not a date',
                without('retry_deadline', 'soon'),
                'retry_deadline is not a date or null',
            ],
            ['paused as a string', without('paused', 'no'), 'paused is not a boolean'],
            ['paused as null', without('paused', null), 'paused is not a boolean'],
            [
                'an end_reason that is not a string',
                without('end_reason', 3),
                'end_reason is not a string or null',
            ],
            [
                'an end_reason as a boolean',
                without('end_reason', false),
                'end_reason is not a string or null',
            ],
            ['attempts that are not a list', without('attempts', {}), 'attempts is not a list'],
            [
                'an attempt whose outcome is not a string',
                without('attempts', [
                    {
                        outcome: null,
                        reason: null,
                        amount: '1000000',
                        attempted_at: START.toISOString(),
                        signature: null,
                    },
                ]),
                'attempts[0].outcome is not a string',
            ],
            [
                'an attempt without an amount',
                without('attempts', [
                    {
                        outcome: 'PAID',
                        reason: null,
                        attempted_at: START.toISOString(),
                        signature: null,
                    },
                ]),
                'attempts[0].amount is missing',
            ],
            [
                'an attempt that is not an object',
                without('attempts', ['PAID']),
                'attempts[0] is not an object',
            ],
            ['a list', [answer()], 'the body is not an object'],
            ['null', null, 'the body is not an object'],
            ['a string', 'ok', 'the body is not an object'],
            [
                "the list of a customer's plans",
                { plans: [answer()], revalidate_after: 60 },
                'wallet is missing',
            ],
        ])('throws unexpected on %s', async (_label, body, problem) => {
            const { fetch } = mockFetch(json(200, body));

            const error = await client(fetch)
                .access(WALLET, 'pro')
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({
                status: 200,
                code: 'unexpected',
                apiCode: null,
                retryable: false,
                body,
            });
            expect((error as MesubError).message).toBe(
                `Mesub answered /v1/access with an answer this SDK cannot read: ${problem}.`,
            );
        });

        // Served since Mesub-io/backend#191: a back from before still answers.
        it('reads a missing retry_deadline as null, and a date as is', async () => {
            const deadline = '2026-10-30T11:58:00.000Z';
            const { fetch } = mockFetch(
                json(200, without('retry_deadline')),
                json(200, answer({ retry_deadline: deadline })),
            );
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            await expect(mesub.access(OTHER_WALLET, 'pro')).resolves.toMatchObject({
                retry_deadline: deadline,
            });
        });

        // Served since Mesub-io/backend#236: a back from before still answers.
        it('reads a missing paused as false and a missing end_reason as null', async () => {
            const older = without('paused');
            delete older['end_reason'];
            const { fetch } = mockFetch(json(200, older));

            const read = await client(fetch).access(WALLET, 'pro');

            expect(read).toEqual(answer());
            expect(read).toMatchObject({ paused: false, end_reason: null });
        });

        it('reads only one of the two missing, keeping the other as sent', async () => {
            const { fetch } = mockFetch(
                json(200, without('end_reason')),
                json(200, { ...without('paused'), status: 'ended', end_reason: 'closed' }),
            );
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).resolves.toMatchObject({
                paused: false,
                end_reason: null,
            });
            await expect(mesub.access(OTHER_WALLET, 'pro')).resolves.toMatchObject({
                paused: false,
                end_reason: 'closed',
            });
        });

        it('caches an older answer with the two defaults filled in', async () => {
            const set = vi.fn();
            const older = without('paused');
            delete older['end_reason'];
            const { fetch } = mockFetch(json(200, older));

            await client(fetch, { get: () => undefined, set }).access(WALLET, 'pro');

            expect(set).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ value: answer() }),
                expect.any(Number),
            );
        });

        it('fills the defaults in each plan of a list from an older back', async () => {
            const older = without('paused');
            delete older['end_reason'];
            const { fetch } = mockFetch(json(200, { plans: [older], revalidate_after: 60 }));

            await expect(client(fetch).accessList(WALLET)).resolves.toEqual({
                plans: [answer()],
                revalidate_after: 60,
            });
        });

        it('names the plan of a list whose paused is not a boolean', async () => {
            const { fetch } = mockFetch(
                json(200, { plans: [answer(), without('paused', 1)], revalidate_after: 60 }),
            );

            const error = await client(fetch)
                .accessList(WALLET)
                .catch((caught: unknown) => caught);

            expect(error).toMatchObject({ code: 'unexpected' });
            expect((error as MesubError).message).toContain('plans[1].paused is not a boolean');
        });

        it.each([
            'cancelled',
            'plan_removed',
            'plan_replaced',
            'plan_ended',
            'authority_closed',
            'closed',
        ] as const)('takes an ended answer whose end_reason is %s', async (end_reason) => {
            const ended = answer({
                access: false,
                status: 'ended',
                end_reason,
                payment_status: 'none',
                next_charge_at: null,
            });
            const { fetch } = mockFetch(json(200, ended));
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(ended);
        });

        it('takes an ended answer with no reason recorded', async () => {
            const ended = answer({ access: false, status: 'ended', end_reason: null });
            const { fetch } = mockFetch(json(200, ended));

            await expect(client(fetch).access(WALLET, 'pro')).resolves.toEqual(ended);
        });

        // A reason the back adds later must not turn a guard into an error.
        it('takes an end_reason it does not know, and answers no from hasAccess', async () => {
            const ended = answer({
                access: false,
                status: 'ended',
                end_reason: 'merchant_refunded' as AccessAnswer['end_reason'],
            });
            const { fetch } = mockFetch(json(200, ended), json(200, ended));
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(ended);
            await expect(mesub.hasAccess(OTHER_WALLET, 'pro')).resolves.toBe(false);
        });

        // Parked over the project's cap: the status stays, nothing is billed.
        it.each(['active', 'unpaid', 'cancelled'] as const)(
            'takes a paused %s seat, its status unchanged',
            async (status) => {
                const parked = answer({
                    status,
                    paused: true,
                    payment_status: 'none',
                    next_charge_at: null,
                    access_until: '2026-10-01T00:00:00.000Z',
                });
                const { fetch } = mockFetch(json(200, parked), json(200, parked));
                const mesub = client(fetch);

                await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(parked);
                await expect(mesub.hasAccess(OTHER_WALLET, 'pro')).resolves.toBe(true);
            },
        );

        it.each(['PAID', 'SKIPPED', 'REJECTED', 'BLOCKED'] as const)(
            'takes a %s attempt',
            async (outcome) => {
                const body = answer({
                    attempts: [
                        {
                            outcome,
                            reason: outcome === 'PAID' ? null : 'fee-payer-empty',
                            amount: '1000000',
                            attempted_at: START.toISOString(),
                            signature: null,
                        },
                    ],
                });
                const { fetch } = mockFetch(json(200, body));

                await expect(
                    client(fetch).access(WALLET, 'pro', { attempts: true }),
                ).resolves.toEqual(body);
            },
        );

        it('takes an outcome it does not know', async () => {
            const body = answer({
                attempts: [
                    {
                        outcome: 'DEFERRED' as never,
                        reason: null,
                        amount: '1000000',
                        attempted_at: START.toISOString(),
                        signature: null,
                    },
                ],
            });
            const { fetch } = mockFetch(json(200, body));

            await expect(client(fetch).access(WALLET, 'pro', { attempts: true })).resolves.toEqual(
                body,
            );
        });

        it('takes a superseded status', async () => {
            const { fetch } = mockFetch(json(200, answer({ status: 'superseded', access: false })));

            await expect(client(fetch).access(WALLET, 'pro')).resolves.toMatchObject({
                status: 'superseded',
            });
        });

        // The NaN entry that served access: true for good, and Redis's `PX NaN`.
        it.each([
            ['no revalidate_after', without('revalidate_after')],
            ['a NaN revalidate_after', without('revalidate_after', Number.NaN)],
        ])('never caches an answer with %s', async (_label, body) => {
            const set = vi.fn();
            const { fetch, calls } = mockFetch(json(200, body), json(200, answer()));
            const mesub = client(fetch, { get: () => undefined, set });

            await expect(mesub.access(WALLET, 'pro')).rejects.toMatchObject({
                code: 'unexpected',
            });
            expect(set).not.toHaveBeenCalled();

            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            expect(calls).toHaveLength(2);
        });

        it('throws unexpected on a 200 with HTML, and caches nothing', async () => {
            const { fetch, calls } = mockFetch(
                new Response('<!doctype html><title>Welcome</title>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                }),
                json(200, answer()),
            );
            const mesub = client(fetch);

            await expect(mesub.access(WALLET, 'pro')).rejects.toMatchObject({
                status: 200,
                code: 'unexpected',
            });
            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            expect(calls).toHaveLength(2);
        });

        it('checks an answer with its attempts too', async () => {
            const { fetch } = mockFetch(json(200, without('revalidate_after')));

            await expect(
                client(fetch).access(WALLET, 'pro', { attempts: true }),
            ).rejects.toMatchObject({ code: 'unexpected' });
        });

        it('reads an answer with every nullable field null, and a status it does not know', async () => {
            const body = answer({
                wallet: null,
                status: 'paused' as AccessAnswer['status'],
                subscribed_since: null,
                first_subscribed_at: null,
                current_period_end: null,
                next_charge_at: null,
                revalidate_after: 0,
                attempts: [
                    {
                        outcome: 'REJECTED',
                        reason: 'insufficient_funds',
                        amount: '1000000',
                        attempted_at: START.toISOString(),
                        signature: null,
                    },
                ],
            });
            const { fetch } = mockFetch(json(200, body));

            await expect(client(fetch).access(WALLET, 'pro', { attempts: true })).resolves.toEqual(
                body,
            );
        });

        it('throws it from hasAccess, never reading it as a yes or a no', async () => {
            const { fetch } = mockFetch(json(200, without('revalidate_after')));

            await expect(client(fetch).hasAccess(WALLET, 'pro')).rejects.toMatchObject({
                code: 'unexpected',
            });
        });
    });

    // Two projects sharing one Redis must never read each other's answers.
    describe('the cache scope', () => {
        it('is a hash of the API key, never the key itself', async () => {
            const set = vi.fn();
            const { fetch } = mockFetch(json(200, answer()));

            await client(fetch, { get: () => undefined, set }).access(WALLET, 'pro');

            const key = set.mock.calls[0]![0] as string;
            expect(key).toBe(
                `mesub:access:key-${sha256('SUB_test').slice(0, 16)}:pro:wallet:${WALLET}`,
            );
            expect(key).not.toContain('SUB_test');
        });

        // The scope needs no network: nothing to wait for during an outage.
        it('never asks /v1/project for it', async () => {
            const project = vi.fn(() => json(200, { id: PROJECT }));
            const { fetch, calls } = mockFetch(json(200, answer()), json(200, answer()));
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, project),
                maxRetries: 0,
            });

            await mesub.access(WALLET, 'pro');
            await mesub.decide(WALLET, 'team');

            expect(project).not.toHaveBeenCalled();
            expect(calls).toHaveLength(2);
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
            expect(key).toMatch(new RegExp(`^mesub:access:key-[0-9a-f]{16}:pro:wallet:${WALLET}$`));
            expect(key).not.toContain('SUB_test');
        });

        // An id the answer does not carry is no scope: never `undefined` in the key (#27).
        it('scopes by a hash of the API key when /v1/project answers without an id', async () => {
            const set = vi.fn();
            const { fetch } = mockFetch(json(200, answer()));
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(fetch, () => json(200, {})),
                cache: { get: () => undefined, set },
            });

            await mesub.access(WALLET, 'pro');

            const key = set.mock.calls[0]![0] as string;
            expect(key).toMatch(new RegExp(`^mesub:access:key-[0-9a-f]{16}:pro:wallet:${WALLET}$`));
            expect(key).not.toContain('undefined');
        });

        it('hashes two API keys apart', async () => {
            const keys: string[] = [];
            const scoped = (apiKey: string) =>
                client(
                    mockFetch(json(200, answer())).fetch,
                    {
                        get: () => undefined,
                        set: (key) => void keys.push(key),
                    },
                    { apiKey },
                );

            await scoped('SUB_one').access(WALLET, 'pro');
            await scoped('SUB_two').access(WALLET, 'pro');

            expect(keys[0]).not.toBe(keys[1]);
            expect(keys.join()).not.toMatch(/SUB_one|SUB_two/);
        });

        // A restart in the middle of an outage, with Redis: what was written
        // before is read back, so the guards serve it instead of a 503.
        it('reads back, after a restart, what the previous process wrote', async () => {
            const store = new MemoryStore<AccessAnswer>();
            const before = answer({ revalidate_after: 0 });
            await client(mockFetch(json(200, before)).fetch, store).hasAccess(WALLET, 'pro');
            const restarted = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: 'https://api.mesub.test',
                fetch: withProject(mockFetch(nest(503, 'Service Unavailable')).fetch, () =>
                    nest(503, 'Service Unavailable'),
                ),
                maxRetries: 0,
                cache: store,
            });

            await expect(restarted.decide(WALLET, 'pro')).resolves.toEqual({
                access: true,
                answer: before,
                stale: true,
            });
        });

        // A new key starts a new scope: the old entries expire on their TTL.
        it('starts afresh after the API key is rotated', async () => {
            const store = new MemoryStore<AccessAnswer>();
            await client(mockFetch(json(200, answer())).fetch, store).hasAccess(WALLET, 'pro');
            const { fetch, calls } = mockFetch(json(200, answer()));

            await client(fetch, store, { apiKey: 'SUB_rotated' }).hasAccess(WALLET, 'pro');

            expect(calls).toHaveLength(1);
        });
    });
    describe('when Mesub cannot answer', () => {
        it.each([
            [
                'a refused plan',
                coded(404, 'plan_not_found', 'No plan of yours is named pro.'),
                'plan_not_found',
            ],
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

        // START + 61 s is when staleThen asks again (#35).
        const ended = new Date(START.getTime() + 30_000).toISOString();
        const later = new Date(START.getTime() + 120_000).toISOString();

        it('keeps out a cancelled subscriber once access_until is past', async () => {
            const mesub = await staleThen(
                answer({ status: 'cancelled', access_until: ended, next_charge_at: null }),
                nest(503, 'Service Unavailable'),
            );

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(false);
        });

        it('keeps a cancelled subscriber in before access_until', async () => {
            const mesub = await staleThen(
                answer({ status: 'cancelled', access_until: later, next_charge_at: null }),
                nest(503, 'Service Unavailable'),
            );

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        });

        it('keeps a paying subscriber in past the period end: a renewal is ahead', async () => {
            const mesub = await staleThen(
                answer({ access_until: ended, next_charge_at: ended }),
                nest(503, 'Service Unavailable'),
            );

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
        });

        it('keeps a subscriber in arrears in while a retry is ahead', async () => {
            const mesub = await staleThen(
                answer({
                    status: 'unpaid',
                    access_until: ended,
                    next_charge_at: null,
                    next_retry_at: later,
                }),
                nest(503, 'Service Unavailable'),
            );

            await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
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
            [
                'an unknown plan',
                coded(404, 'plan_not_found', 'No plan of yours is named pro.'),
                'plan_not_found',
            ],
            [
                'a malformed wallet',
                nest(400, ['wallet must be a base58 Solana address']),
                'invalid_request',
            ],
            ['a forbidden call', nest(403, 'Forbidden'), 'forbidden'],
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

// A guard must not hold a request for the length of an outage (#24).
describe('decide, for the guards', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(START);
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Today's retries, so the budget is what cuts the call short. */
    async function guarded(fetch: typeof globalThis.fetch, options: MesubOptions = {}) {
        return hashed(client(fetch, undefined, { maxRetries: 2, ...options }));
    }

    /** The key hash is real crypto, settled off the fake clock: done before any timing. */
    async function hashed(mesub: Mesub) {
        await mesub['cacheScope']();
        return mesub;
    }

    /** Starts it and records when it settled, so fake timers can run first. */
    function timed<T>(promise: Promise<T>) {
        const state: { value?: T; at?: number } = {};
        void promise.then((value) => {
            state.value = value;
            state.at = Date.now() - START.getTime();
        });
        return state;
    }

    it('answers within 2 s when Mesub hangs, from the stale answer', async () => {
        const { fetch } = mockFetch(json(200, answer({ revalidate_after: 0 })), 'hang', 'hang');
        const mesub = await guarded(fetch);
        await mesub.decide(WALLET, 'pro');

        const decision = timed(mesub.decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(1_999);
        expect(decision.at).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);

        expect(decision.value).toEqual({
            access: true,
            answer: answer({ revalidate_after: 0 }),
            stale: true,
        });
    });

    it('says Mesub is unavailable when it times out on a wallet it never saw', async () => {
        const { fetch } = mockFetch('hang');

        const decision = timed((await guarded(fetch)).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(decision.value).toEqual({
            access: false,
            answer: null,
            stale: true,
            unavailable: true,
        });
    });

    it('takes another budget from guardTimeout', async () => {
        const { fetch } = mockFetch('hang');

        const decision = timed((await guarded(fetch, { guardTimeout: 500 })).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(500);

        expect(decision.at).toBe(500);
    });

    it('does not wait a Retry-After of 30 s', async () => {
        const { fetch } = mockFetch(json(429, { message: 'slow down' }, { 'retry-after': '30' }));

        const decision = timed((await guarded(fetch)).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(0);

        expect(decision).toEqual({
            at: 0,
            value: { access: false, answer: null, stale: true, unavailable: true },
        });
    });

    it('retries within the budget, and recovers', async () => {
        const { fetch } = mockFetch(nest(503, 'down'), json(200, answer()));

        const decision = timed((await guarded(fetch)).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(500);

        expect(decision.value).toEqual({ access: true, answer: answer(), stale: false });
    });

    // Mesub failing fast says nothing about the wallet either: 503, not 402.
    it('says Mesub is unavailable on an outage once the retries are spent', async () => {
        const { fetch } = mockFetch(nest(503, 'a'), nest(503, 'b'), nest(503, 'c'));

        const decision = timed((await guarded(fetch)).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(1_500);

        expect(decision.value).toEqual({
            access: false,
            answer: null,
            stale: true,
            unavailable: true,
        });
    });

    // Retrying a rate limit only adds to it, and holds the request (#34).
    it('falls back at once on a 429, without retrying it', async () => {
        const { fetch } = mockFetch(coded(429, 'rate_limited', 'Slow down.', true));

        const decision = timed((await guarded(fetch)).decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(0);

        expect(decision).toEqual({
            at: 0,
            value: { access: false, answer: null, stale: true, unavailable: true },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('falls back on the stale answer on a 429', async () => {
        const { fetch } = mockFetch(
            json(200, answer({ revalidate_after: 0 })),
            nest(429, 'Too Many Requests'),
        );
        const mesub = await guarded(fetch);
        await mesub.decide(WALLET, 'pro');

        const decision = timed(mesub.decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(0);

        expect(decision.value).toEqual({
            access: true,
            answer: answer({ revalidate_after: 0 }),
            stale: true,
        });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('leaves hasAccess retrying a 429', async () => {
        const { fetch } = mockFetch(nest(429, 'a'), json(200, answer()));

        const result = timed((await guarded(fetch)).hasAccess(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(500);

        expect(result.value).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('still throws an integration error', async () => {
        const { fetch } = mockFetch(nest(401, 'That API key is not valid.'));

        await expect((await guarded(fetch)).decide(WALLET, 'pro')).rejects.toMatchObject({
            code: 'unauthorized',
        });
    });

    // The cache scope costs no call: the whole budget goes to /v1/access.
    it('spends none of the budget on /v1/project', async () => {
        const { fetch, calls } = mockFetch('hang');
        const mesub = await hashed(
            new Mesub({ apiKey: 'SUB_test', baseUrl: 'https://api.mesub.test', fetch }),
        );

        const decision = timed(mesub.decide(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(decision).toMatchObject({ at: 2_000, value: { unavailable: true } });
        expect(calls.map((call) => call.url.pathname)).toEqual(['/v1/access']);
    });

    // Called directly, hasAccess keeps the client's own timeout and retries.
    it('leaves hasAccess to the client timeout and retries', async () => {
        const { fetch } = mockFetch('hang', 'hang', 'hang');

        const result = timed((await guarded(fetch)).hasAccess(WALLET, 'pro'));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(result.at).toBeUndefined();
        await vi.advanceTimersByTimeAsync(14_500);

        expect(result).toEqual({ at: 16_500, value: false });
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

// #28: a merchant with their own login asks by their id for the customer, and
// may list every plan at once.
describe('asked by customer', () => {
    const EMAIL = 'ada@example.com';

    function list(over: Partial<AccessList> = {}): AccessList {
        return {
            plans: [answer(), answer({ plan: 'team', access: false, status: 'none' })],
            revalidate_after: 60,
            ...over,
        };
    }

    /** A store that records every key written, and the entries. */
    function recording() {
        const store = new MemoryStore<AccessAnswer | AccessList>();
        const writes: Array<{ key: string; entry: unknown }> = [];

        return {
            writes,
            store: {
                get: (key: string) => store.get(key),
                set: (key: string, entry: Parameters<typeof store.set>[1], ttl: number) => {
                    writes.push({ key, entry });
                    store.set(key, entry, ttl);
                },
            } satisfies CacheStore<AccessAnswer | AccessList>,
        };
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        ['a wallet', { wallet: WALLET }, 'wallet', WALLET],
        ['an external id', { external_id: 'user_42' }, 'external_id', 'user_42'],
        ['an email', { email: EMAIL }, 'email', EMAIL],
    ] as const)('asks about %s, and nothing else', async (_label, customer, param, value) => {
        const { fetch, calls } = mockFetch(json(200, answer()));

        await client(fetch).access(customer, 'pro');

        const query = Object.fromEntries(calls[0]!.url.searchParams);
        expect(query).toEqual({ [param]: value, plan: 'pro' });
    });

    it('still takes a wallet as a string, as the same customer as { wallet }', async () => {
        const { fetch, calls } = mockFetch(json(200, answer()));
        const mesub = client(fetch);

        await mesub.access(WALLET, 'pro');
        await expect(mesub.access({ wallet: WALLET }, 'pro')).resolves.toEqual(answer());
        await expect(mesub.hasAccess({ wallet: WALLET }, 'pro')).resolves.toBe(true);

        expect(calls).toHaveLength(1);
    });

    it('answers a null wallet for a customer with nothing on that plan', async () => {
        const nothing = answer({
            wallet: null,
            access: false,
            status: 'none',
            payment_status: 'none',
            subscribed_since: null,
            first_subscribed_at: null,
            current_period_end: null,
            next_charge_at: null,
            revalidate_after: 10,
        });
        const { fetch } = mockFetch(json(200, nothing));
        const mesub = client(fetch);

        await expect(mesub.access({ external_id: 'user_42' }, 'pro')).resolves.toEqual(nothing);
        await expect(mesub.hasAccess({ external_id: 'user_42' }, 'pro')).resolves.toBe(false);
    });

    describe('normalised as Mesub reads it', () => {
        it('trims and lowercases an email', async () => {
            const { fetch, calls } = mockFetch(json(200, answer()));

            await client(fetch).access({ email: '  Ada@Example.COM ' }, 'pro');

            expect(calls[0]!.url.searchParams.get('email')).toBe(EMAIL);
        });

        it('trims an external id, and keeps its case', async () => {
            const { fetch, calls } = mockFetch(json(200, answer()));

            await client(fetch).access({ external_id: ' User_42\t' }, 'pro');

            expect(calls[0]!.url.searchParams.get('external_id')).toBe('User_42');
        });

        it('shares one cached answer between two spellings of a customer', async () => {
            const { fetch, calls } = mockFetch(json(200, answer()), json(200, answer()));
            const mesub = client(fetch);

            await mesub.access({ email: 'Ada@Example.com' }, 'pro');
            await mesub.access({ email: ` ${EMAIL}` }, 'pro');
            await mesub.access({ external_id: 'user_42 ' }, 'pro');
            await mesub.access({ external_id: '\nuser_42' }, 'pro');

            expect(calls).toHaveLength(2);
        });
    });

    describe('the cache key', () => {
        it('names the kind of identifier, and keeps a wallet readable', async () => {
            const { store, writes } = recording();

            await client(mockFetch(json(200, answer())).fetch, store).access(WALLET, 'pro');

            expect(writes[0]!.key).toBe(`mesub:access:${SCOPE}:pro:wallet:${WALLET}`);
        });

        it.each([
            ['an external id', { external_id: 'user_42' }, 'external_id', 'user_42'],
            ['an email', { email: EMAIL }, 'email', EMAIL],
        ] as const)('hashes %s under the API key', async (_label, customer, kind, value) => {
            const { store, writes } = recording();

            await client(mockFetch(json(200, answer())).fetch, store).access(customer, 'pro');

            expect(writes[0]!.key).toBe(`mesub:access:${SCOPE}:pro:${kind}:${hmac(kind, value)}`);
            expect(writes[0]!.key).toMatch(/:[0-9a-f]{64}$/);
        });

        // A leaked Redis must not hand out the merchant's customers.
        it('never writes an email in clear, in the key or the entry', async () => {
            const { store, writes } = recording();
            const mesub = client(mockFetch(json(200, answer()), json(200, list())).fetch, store);

            await mesub.access({ email: 'Ada@Example.com' }, 'pro');
            await mesub.accessList({ email: 'Ada@Example.com' });

            expect(writes).toHaveLength(2);
            expect(JSON.stringify(writes)).not.toMatch(/ada|example/i);
        });

        it('keeps the kinds apart, the same value as an email and an external id', async () => {
            const { fetch, calls } = mockFetch(
                json(200, answer()),
                json(200, answer({ access: false, status: 'none' })),
            );
            const mesub = client(fetch);

            await mesub.access({ external_id: EMAIL }, 'pro');

            await expect(mesub.hasAccess({ email: EMAIL }, 'pro')).resolves.toBe(false);
            expect(calls).toHaveLength(2);
        });

        it('hashes under each API key apart', async () => {
            const keys: string[] = [];
            const keyed = (apiKey: string) =>
                client(
                    mockFetch(json(200, answer())).fetch,
                    { get: () => undefined, set: (key) => void keys.push(key) },
                    { apiKey },
                );

            await keyed('SUB_one').access({ external_id: 'user_42' }, 'pro');
            await keyed('SUB_two').access({ external_id: 'user_42' }, 'pro');

            expect(keys[0]!.split(':').at(-1)).toBe(hmac('external_id', 'user_42', 'SUB_one'));
            expect(keys[1]!.split(':').at(-1)).toBe(hmac('external_id', 'user_42', 'SUB_two'));
        });
    });

    describe('a malformed question', () => {
        it.each([
            ['no identifier', {}],
            ['two identifiers', { wallet: WALLET, email: EMAIL }],
            ['a misspelt one', { externalId: 'user_42' }],
            ['one that is not a string', { external_id: 42 }],
            ['null', null],
        ])('throws a TypeError on %s, and asks nothing', async (_label, customer) => {
            const { fetch, calls } = mockFetch();
            const mesub = client(fetch);
            const asked = customer as never;

            await expect(mesub.access(asked, 'pro')).rejects.toBeInstanceOf(TypeError);
            await expect(mesub.hasAccess(asked, 'pro')).rejects.toBeInstanceOf(TypeError);
            await expect(mesub.decide(asked, 'pro')).rejects.toBeInstanceOf(TypeError);
            await expect(mesub.accessList(asked)).rejects.toBeInstanceOf(TypeError);
            expect(calls).toHaveLength(0);
        });

        it('lets an identifier undefined beside the one named pass, as Mesub does', async () => {
            const { fetch, calls } = mockFetch(json(200, answer()));

            await client(fetch).access(
                { wallet: undefined, external_id: 'user_42' } as never,
                'pro',
            );

            expect(calls[0]!.url.searchParams.get('external_id')).toBe('user_42');
            expect(calls[0]!.url.searchParams.has('wallet')).toBe(false);
        });

        // Mesub would answer the list, read as one answer and cached under
        // `undefined`, its missing `access` taken for a no.
        it.each([
            ['access', (mesub: Mesub) => mesub.access(WALLET, undefined as never)],
            [
                'hasAccess',
                (mesub: Mesub) => mesub.hasAccess({ external_id: 'u' }, undefined as never),
            ],
            ['decide', (mesub: Mesub) => mesub.decide(WALLET, '')],
        ])('throws a TypeError from %s without a plan, and caches nothing', async (_l, call) => {
            const { fetch, calls } = mockFetch();
            const { store, writes } = recording();

            await expect(call(client(fetch, store))).rejects.toThrow(/accessList/);
            expect(calls).toHaveLength(0);
            expect(writes).toHaveLength(0);
        });
    });

    describe('accessList', () => {
        it('asks /v1/access without a plan, and answers the list', async () => {
            const { fetch, calls } = mockFetch(json(200, list()));

            await expect(client(fetch).accessList({ external_id: 'user_42' })).resolves.toEqual(
                list(),
            );

            expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
                external_id: 'user_42',
            });
        });

        it('takes a wallet as a string, and normalises like access', async () => {
            const { fetch, calls } = mockFetch(json(200, list()), json(200, list()));
            const mesub = client(fetch);

            await mesub.accessList(WALLET);
            await mesub.accessList({ email: ' Ada@Example.com' });

            expect(calls[0]!.url.searchParams.get('wallet')).toBe(WALLET);
            expect(calls[1]!.url.searchParams.get('email')).toBe(EMAIL);
        });

        it('is cached under its own key, never under a plan', async () => {
            const { store, writes } = recording();

            await client(mockFetch(json(200, list())).fetch, store).accessList({
                external_id: 'user_42',
            });

            expect(writes.map((write) => write.key)).toEqual([
                `mesub:access-list:${SCOPE}:external_id:${hmac('external_id', 'user_42')}`,
            ]);
        });

        it('answers again from the cache while its revalidate_after lasts', async () => {
            const { fetch, calls } = mockFetch(
                json(200, list({ revalidate_after: 30 })),
                json(200, list({ plans: [] })),
            );
            const mesub = client(fetch);

            await mesub.accessList({ external_id: 'user_42' });
            vi.setSystemTime(START.getTime() + 29_999);
            await expect(mesub.accessList({ external_id: 'user_42' })).resolves.toEqual(
                list({ revalidate_after: 30 }),
            );
            expect(calls).toHaveLength(1);

            vi.setSystemTime(START.getTime() + 30_000);
            await expect(mesub.accessList({ external_id: 'user_42' })).resolves.toEqual(
                list({ plans: [] }),
            );
            expect(calls).toHaveLength(2);
        });

        it('never answers a plan from the list, nor the list from a plan', async () => {
            const { fetch, calls } = mockFetch(json(200, list()), json(200, answer()));
            const { store } = recording();
            const mesub = client(fetch, store);

            await mesub.accessList(WALLET);
            await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
            await expect(mesub.accessList(WALLET)).resolves.toEqual(list());

            expect(calls).toHaveLength(2);
        });

        it('skips the cache both ways when attempts are asked for', async () => {
            const { fetch, calls } = mockFetch(json(200, list()), json(200, list()));
            const { store, writes } = recording();
            const mesub = client(fetch, store);

            await mesub.accessList(WALLET, { attempts: true });
            await mesub.accessList(WALLET);

            expect(calls[0]!.url.searchParams.get('attempts')).toBe('true');
            expect(calls).toHaveLength(2);
            expect(writes).toHaveLength(1);
        });

        it.each([
            ['no revalidate_after', { plans: [] }, 'revalidate_after is missing'],
            [
                'a NaN revalidate_after',
                { plans: [], revalidate_after: Number.NaN },
                'revalidate_after is not a finite number of seconds',
            ],
            ['no plans', { revalidate_after: 60 }, 'plans is missing'],
            [
                'plans that are not a list',
                { plans: {}, revalidate_after: 60 },
                'plans is not a list',
            ],
            [
                'a plan without access',
                { plans: [answer(), { ...answer(), access: undefined }], revalidate_after: 60 },
                'plans[1].access is missing',
            ],
            [
                'a plan whose attempts are not a list',
                { plans: [{ ...answer(), attempts: 'none' }], revalidate_after: 60 },
                'plans[0].attempts is not a list',
            ],
            ['the answer for one plan', answer(), 'plans is missing'],
        ])(
            'throws unexpected on a list with %s, and caches nothing',
            async (_label, body, problem) => {
                const { fetch, calls } = mockFetch(json(200, body), json(200, list()));
                const { store, writes } = recording();
                const mesub = client(fetch, store);

                const error = await mesub.accessList(WALLET).catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(MesubError);
                expect(error).toMatchObject({ status: 200, code: 'unexpected' });
                expect((error as MesubError).message).toBe(
                    `Mesub answered /v1/access with an answer this SDK cannot read: ${problem}.`,
                );
                expect(writes).toHaveLength(0);

                await expect(mesub.accessList(WALLET)).resolves.toEqual(list());
                expect(calls).toHaveLength(2);
            },
        );

        it('reads a list whose plan answers a null wallet', async () => {
            const body = list({ plans: [answer({ wallet: null, access: false, status: 'none' })] });
            const { fetch } = mockFetch(json(200, body));

            await expect(client(fetch).accessList({ email: EMAIL })).resolves.toEqual(body);
        });

        it('throws when Mesub cannot answer, even with a stale list cached', async () => {
            const { fetch } = mockFetch(json(200, list()), nest(503, 'Service Unavailable'));
            const mesub = client(fetch);
            await mesub.accessList(WALLET);
            vi.setSystemTime(START.getTime() + 61_000);

            await expect(mesub.accessList(WALLET)).rejects.toMatchObject({ code: 'unavailable' });
        });
    });

    describe('during an outage, by external id', () => {
        const CUSTOMER = { external_id: 'user_42' };

        async function staleThen(first: AccessAnswer) {
            const { fetch } = mockFetch(json(200, first), nest(503, 'Service Unavailable'));
            const mesub = client(fetch);
            await mesub.hasAccess(CUSTOMER, 'pro');
            vi.setSystemTime(START.getTime() + 61_000);

            return mesub;
        }

        it('keeps a paying customer in, from the stale answer', async () => {
            const mesub = await staleThen(answer());

            await expect(mesub.decide({ external_id: ' user_42 ' }, 'pro')).resolves.toEqual({
                access: true,
                answer: answer(),
                stale: true,
            });
        });

        it('keeps out a cancelled customer once access_until is past (#35)', async () => {
            const ended = new Date(START.getTime() + 30_000).toISOString();
            const mesub = await staleThen(
                answer({ status: 'cancelled', access_until: ended, next_charge_at: null }),
            );

            await expect(mesub.hasAccess(CUSTOMER, 'pro')).resolves.toBe(false);
        });

        it('says Mesub is unavailable for a customer it never saw', async () => {
            const { fetch } = mockFetch(nest(503, 'Service Unavailable'));

            await expect(client(fetch).decide(CUSTOMER, 'pro')).resolves.toEqual({
                access: false,
                answer: null,
                stale: true,
                unavailable: true,
            });
        });

        it('does not lend a wallet answer to the external id', async () => {
            const { fetch } = mockFetch(json(200, answer()), nest(503, 'Service Unavailable'));
            const mesub = client(fetch);
            await mesub.hasAccess(WALLET, 'pro');

            await expect(mesub.hasAccess(CUSTOMER, 'pro')).resolves.toBe(false);
        });

        // The hash needs only the API key: a restarted server reads it back.
        it('reads back, after a restart, what the previous process wrote', async () => {
            const store = new MemoryStore<AccessAnswer | AccessList>();
            const before = answer({ revalidate_after: 0 });
            await client(mockFetch(json(200, before)).fetch, store).hasAccess(CUSTOMER, 'pro');

            const restarted = client(mockFetch(nest(503, 'Service Unavailable')).fetch, store);

            await expect(restarted.decide(CUSTOMER, 'pro')).resolves.toEqual({
                access: true,
                answer: before,
                stale: true,
            });
        });
    });
});

// Fifty calls for a customer not in the cache made fifty requests (#34).
describe('concurrent lookups', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * A fetch that counts the calls to /v1/access and holds every answer
     * until `release`, so all the calls are made while the first is in flight.
     */
    function held(respond: (url: URL) => Response | Error = () => json(200, answer())) {
        const calls: URL[] = [];
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const fetch = (async (input: string | URL | Request) => {
            const url = new URL(String(input));
            calls.push(url);
            await gate;
            const response = respond(url);
            if (response instanceof Error) throw response;
            return response;
        }) as typeof globalThis.fetch;

        return { fetch, calls, release: () => open() };
    }

    /** Lets the calls reach the cache and the flight before the answer comes. */
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

    const fifty = <T>(call: () => Promise<T>) => Promise.all(Array.from({ length: 50 }, call));

    it.each<[string, (mesub: Mesub) => Promise<unknown>, unknown]>([
        ['access', (mesub: Mesub) => mesub.access(WALLET, 'pro'), answer()],
        ['hasAccess', (mesub: Mesub) => mesub.hasAccess(WALLET, 'pro'), true],
        [
            'decide',
            (mesub: Mesub) => mesub.decide(WALLET, 'pro'),
            { access: true, answer: answer(), stale: false },
        ],
    ])('makes one request for fifty %s calls on one customer', async (_label, call, expected) => {
        const { fetch, calls, release } = held();
        const mesub = client(fetch);

        const all = fifty(() => call(mesub));
        await settled();
        release();

        expect(await all).toEqual(Array.from({ length: 50 }, () => expected));
        expect(calls).toHaveLength(1);
    });

    it('makes one request for fifty accessList calls', async () => {
        const list = { plans: [answer()], revalidate_after: 60 };
        const { fetch, calls, release } = held(() => json(200, list));
        const mesub = client(fetch);

        const all = fifty(() => mesub.accessList(WALLET));
        await settled();
        release();

        expect(await all).toHaveLength(50);
        expect(calls).toHaveLength(1);
    });

    it('caches the shared answer once, then answers from it', async () => {
        const set = vi.fn();
        const memory = new MemoryStore<AccessAnswer | AccessList>();
        const { fetch, calls, release } = held();
        const mesub = client(fetch, {
            get: (key) => memory.get(key),
            set: (key, entry, ttlMs) => {
                set(key);
                memory.set(key, entry, ttlMs);
            },
        });

        const all = fifty(() => mesub.hasAccess(WALLET, 'pro'));
        await settled();
        release();
        await all;
        await mesub.hasAccess(WALLET, 'pro');

        expect(set).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1);
    });

    it('keeps customers, kinds, plans and the list apart', async () => {
        const { fetch, calls, release } = held((url) =>
            url.searchParams.has('plan')
                ? json(200, answer({ plan: url.searchParams.get('plan')! }))
                : json(200, { plans: [], revalidate_after: 60 }),
        );
        const mesub = client(fetch);

        const all = Promise.all([
            mesub.access(WALLET, 'pro'),
            mesub.access(OTHER_WALLET, 'pro'),
            mesub.access(WALLET, 'team'),
            mesub.access({ email: 'same@id.co' }, 'pro'),
            mesub.access({ external_id: 'same@id.co' }, 'pro'),
            mesub.accessList(WALLET),
            mesub.access(WALLET, 'pro'),
        ]);
        await settled();
        release();
        await all;

        expect(calls).toHaveLength(6);
    });

    it('never shares between two projects on one store', async () => {
        const store = new MemoryStore<AccessAnswer | AccessList>();
        const { fetch, calls, release } = held();
        const one = client(fetch, store);
        const two = client(fetch, store, { apiKey: 'SUB_other' });

        const all = Promise.all([one.hasAccess(WALLET, 'pro'), two.hasAccess(WALLET, 'pro')]);
        await settled();
        release();
        await all;

        expect(calls).toHaveLength(2);
    });

    // A guard's request gives up a 429 and its deadline; your own call keeps its retries.
    it('never shares between a guard and a call from your code', async () => {
        const { fetch, calls, release } = held();
        const mesub = client(fetch);

        const all = Promise.all([
            mesub.decide(WALLET, 'pro'),
            mesub.decide(WALLET, 'pro'),
            mesub.hasAccess(WALLET, 'pro'),
            mesub.access(WALLET, 'pro'),
        ]);
        await settled();
        release();
        await all;

        expect(calls).toHaveLength(2);
    });

    it('shares the failure too, and every guard falls back', async () => {
        const { fetch, calls, release } = held(() => nest(503, 'down'));
        const mesub = client(fetch);

        const all = fifty(() => mesub.decide(WALLET, 'pro'));
        await settled();
        release();

        expect(new Set((await all).map((decision) => decision.unavailable))).toEqual(
            new Set([true]),
        );
        expect(calls).toHaveLength(1);
    });

    it('asks again once the shared request failed', async () => {
        const answers = [nest(401, 'That API key is not valid.'), json(200, answer())];
        const { fetch, calls, release } = held(() => answers.shift()!);
        const mesub = client(fetch);
        release();

        await expect(mesub.access(WALLET, 'pro')).rejects.toMatchObject({ code: 'unauthorized' });
        await expect(mesub.access(WALLET, 'pro')).resolves.toEqual(answer());
        expect(calls).toHaveLength(2);
    });

    it('asks again once the shared answer went stale', async () => {
        const { fetch, calls, release } = held();
        const mesub = client(fetch);
        release();
        await mesub.access(WALLET, 'pro');
        vi.setSystemTime(START.getTime() + 61_000);

        await mesub.access(WALLET, 'pro');

        expect(calls).toHaveLength(2);
    });

    it('asks each time for attempts, which are never cached', async () => {
        const { fetch, calls, release } = held(() => json(200, answer({ attempts: [] })));
        const mesub = client(fetch);

        const all = Promise.all([
            mesub.access(WALLET, 'pro', { attempts: true }),
            mesub.access(WALLET, 'pro', { attempts: true }),
        ]);
        await settled();
        release();
        await all;

        expect(calls).toHaveLength(2);
    });

    // An answer sent before the subscription landed must not be cached after it (#33).
    it('never caches an answer in flight when a subscription lands', async () => {
        const subscription = {
            id: 'sub_1',
            status: 'active',
            access: true,
            payment_status: 'paid',
            plan: 'pro',
            wallet: WALLET,
            email: null,
            external_id: null,
            current_period_start: '2026-09-30T12:00:00.000Z',
            current_period_end: '2026-10-30T12:00:00.000Z',
            next_charge_at: '2026-10-30T12:00:00.000Z',
            next_retry_at: null,
            retry_deadline: null,
            access_until: '2026-10-30T12:00:00.000Z',
            created_at: '2026-09-30T11:58:00.000Z',
            confirmed_at: '2026-09-30T12:00:03.000Z',
        };
        const no = answer({ access: false, status: 'none', next_charge_at: null });
        // Only /v1/access is held: the subscription is read while it is in flight.
        const {
            fetch: access,
            calls,
            release,
        } = held(() => json(200, calls.length > 1 ? answer() : no));
        const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
            new URL(String(input)).pathname === '/v1/access'
                ? access(input, init)
                : json(200, subscription)) as typeof globalThis.fetch;
        const mesub = client(fetch);

        const before = mesub.hasAccess(WALLET, 'pro');
        // In flight for sure: the key is hashed first, which a timer tick does not wait for.
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        await mesub.subscriptions.retrieve('sub_1');
        release();

        await expect(before).resolves.toBe(false);
        await expect(mesub.hasAccess(WALLET, 'pro')).resolves.toBe(true);
    });
});
