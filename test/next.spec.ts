import type { AccessAnswer } from '../src/answer.js';
import { Mesub, type MesubOptions } from '../src/index.js';
import { MesubError, withMesub, type MesubAccess, type WithMesubOptions } from '../src/next.js';

const BASE = 'https://api.mesub.test';
const WALLET = 'SysvarRent111111111111111111111111111111111';
const ATTACKER = 'Attacker111111111111111111111111111111111111';

/** Stands for the merchant's own verified session: who it says is signed in. */
const SESSION = 'x-test-session';
const SIGNED_IN = { [SESSION]: WALLET };
const session = (request: Request) => request.headers.get(SESSION);

function answer(over: Partial<AccessAnswer> = {}): AccessAnswer {
    return {
        wallet: WALLET,
        plan: 'pro',
        access: true,
        status: 'active',
        paused: false,
        end_reason: null,
        payment_status: 'paid',
        subscribed_since: null,
        first_subscribed_at: null,
        current_period_end: null,
        cancelled_at: null,
        access_until: null,
        next_charge_at: null,
        next_retry_at: null,
        retry_deadline: null,
        revalidate_after: 60,
        ...over,
    };
}

interface Mesh {
    /** What /v1/access answers, per call. */
    access?: (init?: RequestInit, url?: URL) => Response | Promise<Response>;
}

/** A Mesub whose API is a function, so each test says what it answers. */
function mesub(mesh: Mesh = {}, options: MesubOptions = {}) {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        calls.push(url.pathname);
        if (url.pathname === '/v1/access')
            return (mesh.access ?? (() => Response.json(answer())))(init, url);
        throw new Error(`unexpected ${url.pathname}`);
    });
    const client = new Mesub({
        apiKey: 'SUB_test',
        baseUrl: BASE,
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 0,
        // The default budget is 2 s: on a busy machine it would decide a test that is not about it.
        guardTimeout: 30_000,
        ...options,
    });

    return { client, calls };
}

/** What /v1/access answers, per plan asked. */
function perPlan(
    answers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): NonNullable<Mesh['access']> {
    return (init, url) => answers[url!.searchParams.get('plan')!]!(init);
}

/** Mesub not answering at all, until the call gives up. */
function hang(init?: RequestInit) {
    return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
}

interface Ctx {
    params: Promise<{ id: string }>;
}

/**
 * A guarded route handler that echoes what it was handed. Signed in by the
 * test session, unless `customer` is given.
 */
function route(client: Mesub, options: Partial<Omit<WithMesubOptions, 'client' | 'plan'>> = {}) {
    return withMesub<Ctx>(
        async (_request, mesub: MesubAccess, context) =>
            Response.json({ mesub, params: await context.params }),
        { plan: 'pro', client, customer: session, ...options },
    );
}

function get(headers: Record<string, string> = {}, path = '/api/pro/42') {
    return new Request(`https://shop.test${path}`, { headers });
}

const context: Ctx = { params: Promise.resolve({ id: '42' }) };

describe('withMesub', () => {
    describe('letting through', () => {
        it('hands the handler who is asking, the answer and the untouched context', async () => {
            const { client } = mesub();

            const response = await route(client)(get(SIGNED_IN), context);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                mesub: {
                    wallet: WALLET,
                    customer: { kind: 'wallet', value: WALLET },
                    plan: 'pro',
                    answer: answer(),
                    stale: false,
                },
                params: { id: '42' },
            });
        });

        it('passes the same request and context objects through', async () => {
            const { client } = mesub();
            const handler = vi.fn(
                (_request: Request, _mesub: MesubAccess, _context: Ctx) => new Response('ok'),
            );
            const request = get(SIGNED_IN);

            await withMesub(handler, { plan: 'pro', client, customer: session })(request, context);

            expect(handler.mock.calls[0]![0]).toBe(request);
            expect(handler.mock.calls[0]![2]).toBe(context);
        });

        // Who is asked about is who `customer` names, never one the request names.
        it('asks Mesub about the wallet the session names', async () => {
            const { client } = mesub();
            const spy = vi
                .spyOn(client, 'decide')
                .mockResolvedValue({ access: true, answer: answer(), stale: false });

            await route(client)(
                get({ ...SIGNED_IN, 'x-wallet': ATTACKER }, `/api/pro?wallet=${ATTACKER}`),
                context,
            );

            expect(spy).toHaveBeenCalledWith(WALLET, 'pro');
        });

        it('returns the handler own Response as is', async () => {
            const { client } = mesub();
            const own = new Response('made here', { status: 201, headers: { 'x-own': '1' } });

            const response = await withMesub(() => own, { plan: 'pro', client, customer: session })(
                get(SIGNED_IN),
                context,
            );

            expect(response).toBe(own);
        });

        it.each([
            ['a sync handler', () => new Response('sync')],
            ['an async handler', async () => new Response('async')],
        ])('works with %s', async (_label, handler) => {
            const { client } = mesub();

            const response = await withMesub(handler, { plan: 'pro', client, customer: session })(
                get(SIGNED_IN),
                context,
            );

            expect(response.status).toBe(200);
        });
    });

    describe('401, not signed in', () => {
        it.each([
            ['no session at all', {} as Record<string, string>],
            // Only `customer` says who is asking: nothing else of the request is read.
            [
                'a bearer and a cookie the guard does not read',
                { Authorization: `Bearer ${WALLET}`, Cookie: `wallet=${WALLET}` },
            ],
        ])('answers 401 on %s', async (_label, headers) => {
            const { client, calls } = mesub();

            const response = await route(client)(get(headers), context);

            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ access: false, reason: 'unauthenticated' });
            expect(calls).toEqual([]);
        });

        it('never asks Mesub nor calls the handler when nobody is signed in', async () => {
            const { client, calls } = mesub();
            const handler = vi.fn(() => new Response('ok'));

            await withMesub(handler, { plan: 'pro', client, customer: session })(get(), context);

            expect(calls).toEqual([]);
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('customer option: who is asking, from the merchant own auth', () => {
        it('lets a customer through by external id', async () => {
            const queries: Record<string, string>[] = [];
            const { client, calls } = mesub({
                access: (_init, url) => {
                    queries.push(Object.fromEntries(url!.searchParams));
                    return Response.json(answer());
                },
            });

            const response = await route(client, {
                customer: () => ({ external_id: 'user_42' }),
            })(get(), context);

            expect(response.status).toBe(200);
            expect(queries).toEqual([{ external_id: 'user_42', plan: 'pro' }]);
            expect(calls).toEqual(['/v1/access']);
            expect(((await response.json()) as { mesub: MesubAccess }).mesub).toEqual({
                wallet: WALLET,
                customer: { kind: 'external_id', value: 'user_42' },
                plan: 'pro',
                answer: answer(),
                stale: false,
            });
        });

        it('hands the request to an async resolver', async () => {
            const { client } = mesub();
            const customer = vi.fn(async (request: Request) => ({
                email: request.headers.get('x-session-email')!,
            }));

            const request = get({ 'x-session-email': 'ada@example.com' });
            const response = await route(client, { customer })(request, context);

            expect(response.status).toBe(200);
            expect(customer).toHaveBeenCalledWith(request);
        });

        it.each([null, undefined])(
            'answers 401 when it returns %s: nobody is signed in',
            async (none) => {
                const { client, calls } = mesub();

                const response = await route(client, { customer: () => none })(get(), context);

                expect(response.status).toBe(401);
                expect(calls).toEqual([]);
            },
        );

        it('answers 402 when Mesub says no for that customer', async () => {
            const { client } = mesub({
                access: () =>
                    Response.json(answer({ access: false, status: 'none', wallet: null })),
            });

            const response = await route(client, { customer: () => WALLET })(get(), context);

            expect(response.status).toBe(402);
        });

        it('throws what cannot be asked about: a broken integration, not a refusal', async () => {
            const { client } = mesub();

            await expect(
                route(client, { customer: () => ({ external_id: 'u', email: 'a@b.co' }) as never })(
                    get(),
                    context,
                ),
            ).rejects.toThrow(TypeError);
            await expect(route(client, { customer: () => '' })(get(), context)).rejects.toThrow(
                TypeError,
            );
        });

        it.each([
            ['is missing', {}],
            ['is not a function', { customer: { external_id: 'u1' } }],
        ])('refuses to wrap when it %s, and says what to pass', (_name, options) => {
            const { client } = mesub();
            const wrap = () =>
                withMesub(() => new Response('ok'), { plan: 'pro', client, ...options } as never);

            expect(wrap).toThrow(TypeError);
            expect(wrap).toThrow(/needs `customer`: a function of the request/);
        });
    });

    describe('402, no access', () => {
        it('answers 402 with the status for a subscriber without access', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'stopped' })),
            });

            const response = await route(client)(get(SIGNED_IN), context);

            expect(response.status).toBe(402);
            expect(response.headers.get('retry-after')).toBeNull();
            expect(await response.json()).toEqual({
                access: false,
                reason: 'no_access',
                status: 'stopped',
            });
        });

        // Mesub down, but this wallet was seen and had access: it stays in.
        it('keeps a known subscriber in during an outage', async () => {
            let down = false;
            const { client } = mesub({
                access: () =>
                    down
                        ? Response.json({ message: 'down' }, { status: 503 })
                        : Response.json(answer({ revalidate_after: 0 })),
            });
            const handler = route(client);
            expect((await handler(get(SIGNED_IN), context)).status).toBe(200);

            down = true;
            const response = await handler(get(SIGNED_IN), context);

            expect(response.status).toBe(200);
            expect(((await response.json()) as { mesub: MesubAccess }).mesub.stale).toBe(true);
        });
    });

    describe('503, nobody knows yet', () => {
        // 402 only means Mesub said no: failing, it said nothing about this wallet.
        it.each([
            ['an outage', 503],
            ['a rate limit', 429],
        ])('answers 503 with Retry-After for an unseen wallet on %s', async (_label, status) => {
            const { client } = mesub({
                access: () => Response.json({ message: 'down' }, { status }),
            });

            const response = await route(client)(get(SIGNED_IN), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
            expect(await response.json()).toEqual({ access: false, reason: 'unavailable' });
        });

        // A guard holds a request for guardTimeout at most, never for an outage (#24).
        it('answers 503 with Retry-After when Mesub does not answer within guardTimeout', async () => {
            const { client } = mesub({ access: hang }, { guardTimeout: 50 });

            const response = await route(client)(get(SIGNED_IN), context);

            expect(response.status).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
            expect(await response.json()).toEqual({ access: false, reason: 'unavailable' });
        });
    });

    // #38: any one of several plans, or the plan worked out per request.
    describe('which plan', () => {
        const no = () => Response.json(answer({ access: false, status: 'none' }));
        const yes = () => Response.json(answer({ plan: 'team' }));
        const echo = async (_request: Request, mesub: MesubAccess) => Response.json(mesub);

        it('lets through on the first plan of the list that grants, and says which', async () => {
            const { client } = mesub({ access: perPlan({ pro: no, team: yes }) });

            const response = await withMesub(echo, {
                plan: ['pro', 'team'],
                client,
                customer: session,
            })(get(SIGNED_IN), context);

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ plan: 'team', answer: { plan: 'team' } });
        });

        it('answers 402 when none grants', async () => {
            const { client } = mesub({ access: perPlan({ pro: no, team: no }) });

            const response = await withMesub(echo, {
                plan: ['pro', 'team'],
                client,
                customer: session,
            })(get(SIGNED_IN), context);

            expect(response.status).toBe(402);
        });

        it('asks about the plan a function picks for the request', async () => {
            const { client } = mesub({ access: perPlan({ team: yes }) });
            const guarded = withMesub(echo, {
                plan: (request) => new URL(request.url).searchParams.get('tier') ?? 'pro',
                client,
                customer: session,
            });

            const response = await guarded(get(SIGNED_IN, '/api/x?tier=team'), context);

            expect(response.status).toBe(200);
            expect(((await response.json()) as MesubAccess).plan).toBe('team');
        });

        it('refuses an empty list when wrapping, and throws one a function gives', async () => {
            const { client } = mesub();

            expect(() => withMesub(echo, { plan: [], client, customer: session })).toThrow(/plan/);
            await expect(
                withMesub(echo, { plan: () => [], client, customer: session })(
                    get(SIGNED_IN),
                    context,
                ),
            ).rejects.toThrow(/plan/);
        });

        it('refuses more than three plans, and never runs the function for nobody', async () => {
            const { client } = mesub();
            const plan = vi.fn(() => ['pro', 'team', 'max', 'org']);

            expect(() =>
                withMesub(echo, { plan: ['pro', 'team', 'max', 'org'], client, customer: session }),
            ).toThrow(/3 plans at most/);
            await expect(
                withMesub(echo, { plan, client, customer: session })(get(SIGNED_IN), context),
            ).rejects.toThrow(/3 plans at most/);

            plan.mockClear();
            const response = await withMesub(echo, { plan, client, customer: session })(
                get(),
                context,
            );

            expect(response.status).toBe(401);
            expect(plan).not.toHaveBeenCalled();
        });
    });

    describe('onDenied', () => {
        it('lets the merchant answer a 402', async () => {
            const { client } = mesub({
                access: () => Response.json(answer({ access: false, status: 'none' })),
            });
            const onDenied = vi.fn((denial: { reason: string }) =>
                Response.redirect(`https://shop.test/subscribe?why=${denial.reason}`, 302),
            );
            const request = get(SIGNED_IN);

            const response = await route(client, { onDenied })(request, context);

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe(
                'https://shop.test/subscribe?why=no_access',
            );
            expect(onDenied.mock.calls[0]![0]).toMatchObject({
                reason: 'no_access',
                status: 402,
                answer: { status: 'none' },
            });
            expect((onDenied.mock.calls[0] as unknown[])[1]).toBe(request);
        });

        it('hands it the 401 too, and waits for an async answer', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(async () => new Response(null, { status: 418 }));

            const response = await route(client, { onDenied })(get(), context);

            expect(response.status).toBe(418);
            expect((onDenied.mock.calls[0] as unknown[])[0]).toEqual({
                reason: 'unauthenticated',
                status: 401,
                answer: null,
            });
        });

        // #45: a rejection is thrown, for Next to answer 500, never swallowed.
        it('throws what an async one rejects with', async () => {
            const { client } = mesub();
            const failure = new Error('onDenied failed');
            const onDenied = vi.fn(async (): Promise<Response> => {
                await Promise.resolve();
                throw failure;
            });

            await expect(route(client, { onDenied })(get(), context)).rejects.toBe(failure);
        });

        it('is never called for a subscriber with access', async () => {
            const { client } = mesub();
            const onDenied = vi.fn(() => new Response(null, { status: 418 }));

            const response = await route(client, { onDenied })(get(SIGNED_IN), context);

            expect(response.status).toBe(200);
            expect(onDenied).not.toHaveBeenCalled();
        });
    });

    // A broken integration must reach Next as a thrown error, not look like a denial.
    describe('integration errors', () => {
        it.each([
            ['a bad API key', 401, 'unauthorized'],
            ['an unknown plan', 404, 'plan_not_found'],
        ])('throws %s', async (_label, status, code) => {
            const { client } = mesub({
                access: () =>
                    Response.json({ message: 'nope', statusCode: status, code }, { status }),
            });
            const handler = vi.fn(() => new Response('ok'));

            const failing = withMesub(handler, { plan: 'pro', client, customer: session })(
                get(SIGNED_IN),
                context,
            );

            await expect(failing).rejects.toBeInstanceOf(MesubError);
            await expect(failing).rejects.toMatchObject({ code });
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
