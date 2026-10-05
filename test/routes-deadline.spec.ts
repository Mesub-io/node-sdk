import { Mesub, MesubError } from '../src/index.js';
import { handleWidget, type WidgetRequest } from '../src/routes.js';
import { FakeMesub } from '../src/testing.js';

const WALLET = 'SysvarRent111111111111111111111111111111111';
const JSON_TYPE = 'application/json';
const SIGNATURE =
    '5wHu1qwD4kLDLoREEPBpKvGvhbxWFxFFfr5nQq7dxAsRRDXvHRqpNvfsCvC1qzjWQhqmPtBb8LnZjKmvpehJqSWk';
/** What one widget request gives Mesub for its reads. */
const READ_TIME = 10_000;

const ada = { kind: 'external_id', value: 'user_ada' } as const;

type Sent = { method: string; path: string };
type Rule = (sent: Sent) => Response | 'hang' | number | undefined;

/**
 * A client that retries, as a merchant's does, in front of the fake: `rule`
 * answers a call itself, never answers it (`hang`), or delays the fake's
 * answer by that many milliseconds.
 */
function setup(rule: Rule = () => undefined, options: { attemptsRoute?: boolean } = {}) {
    const fake = new FakeMesub({ plans: ['pro'], ...options });
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init = {}) => {
        const call = {
            method: (init.method ?? 'GET').toUpperCase(),
            path: new URL(String(input)).pathname,
        };
        sent.push(`${call.method} ${call.path}`);
        const ruled = rule(call);

        if (ruled instanceof Response) return ruled;
        if (ruled === 'hang') {
            return new Promise<Response>((_, reject) => {
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            });
        }
        if (typeof ruled === 'number') await new Promise((done) => setTimeout(done, ruled));

        return fake.fetch(input, init);
    };
    const client = new Mesub({
        apiKey: fake.apiKey,
        baseUrl: fake.baseUrl,
        fetch,
        maxRetries: 2,
        // Longer than the widget's deadline: what cuts a read is the deadline.
        timeout: 60_000,
    });
    const call = (req: Partial<WidgetRequest> & { path: string }) =>
        handleWidget(client, { method: 'GET', body: undefined, contentType: null, ...req }, ada);
    const post = (path: string, body?: unknown) =>
        call({ method: 'POST', path, body, contentType: JSON_TYPE });

    return { fake, client, sent, call, post };
}

function rateLimited(seconds: number): Response {
    return Response.json(
        { statusCode: 429, message: 'Slow down.', code: 'rate_limited', retryable: true },
        { status: 429, headers: { 'retry-after': String(seconds) } },
    );
}

/** A subscription of Ada's, running. */
async function subscribed(fake: FakeMesub) {
    const client = fake.client();
    const created = await client.subscriptions.create({
        plan: 'pro',
        wallet: WALLET,
        external_id: 'user_ada',
    });
    await client.subscriptions.submit(created.subscription.id, {
        transaction: created.transaction,
        terms_signature: SIGNATURE,
    });

    return created.subscription.id;
}

/** Whether the promise has settled, without waiting for it. */
function watch<T>(promise: Promise<T>) {
    const state: { settled: boolean; value?: T } = { settled: false };
    void promise.then(
        (value) => Object.assign(state, { settled: true, value }),
        () => Object.assign(state, { settled: true }),
    );

    return state;
}

/** Only the clock: the client's own async work (its hashes) stays real. */
function fakeClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/** Waits, in real time, for what no timer holds back. */
async function until(reached: () => boolean) {
    while (!reached()) await new Promise((done) => setImmediate(done));
}

/** Moves the clock, then lets what the timers settled reach its callers. */
async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let turn = 0; turn < 5; turn++) await new Promise((done) => setImmediate(done));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('the widget routes: a rate limit of Mesub is never waited out', () => {
    it.each([
        // A plan is read from the project's list.
        ['GET', '/plans/pro', 'GET /v1/plans'],
        ['GET', '/subscriptions', 'GET /v1/subscriptions'],
        ['GET', '/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1'],
        // The read that says whose it is, before anything is built or confirmed.
        ['POST', '/subscriptions/sub_1/cancel', 'GET /v1/subscriptions/sub_1'],
        ['POST', '/subscriptions/sub_1/submit', 'GET /v1/subscriptions/sub_1'],
        ['POST', '/subscriptions/sub_1/close/confirm', 'GET /v1/subscriptions/sub_1'],
    ])('answers %s %s 429 with its Retry-After after one call', async (method, path, asked) => {
        fakeClock();
        const { call, sent } = setup(() => rateLimited(60));

        // No timer is advanced: a wait for the Retry-After would never end.
        const answer = await call({ method, path, contentType: JSON_TYPE, body: {} });

        expect(answer.status).toBe(429);
        expect(answer.headers).toEqual({ 'Retry-After': '60' });
        expect(answer.body).toMatchObject({ error: { code: 'rate_limited' } });
        expect(sent).toEqual([asked]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('asks for the price and the payments of one subscription once each', async () => {
        fakeClock();
        const { fake, call, sent } = setup(({ path }) =>
            path.startsWith('/v1/subscriptions/') && !path.endsWith('/attempts')
                ? undefined
                : rateLimited(60),
        );
        const id = await subscribed(fake);

        const answer = await call({ path: `/subscriptions/${id}` });

        // The subscription was read: it is answered without what was refused.
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            subscription: { id },
            payments: null,
            payments_error: { code: 'rate_limited' },
        });
        expect([...sent].sort()).toEqual([
            'GET /v1/plans',
            `GET /v1/subscriptions/${id}`,
            `GET /v1/subscriptions/${id}/attempts`,
        ]);
    });

    it('asks /v1/access once too, for a Mesub without the attempts route', async () => {
        fakeClock();
        const { fake, call, sent } = setup(
            ({ path }) => (path === '/v1/access' ? rateLimited(60) : undefined),
            { attemptsRoute: false },
        );
        const id = await subscribed(fake);

        const answer = await call({ path: `/subscriptions/${id}` });

        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ payments_error: { code: 'rate_limited' } });
        expect(sent.filter((each) => each === 'GET /v1/access')).toHaveLength(1);
    });
});

describe('the widget routes: a slow Mesub is cut at one deadline', () => {
    it('answers a read Mesub never answers when the deadline comes, after one call', async () => {
        fakeClock();
        const { call, sent } = setup(() => 'hang');

        const answer = watch(call({ path: '/plans/pro' }));

        await advance(READ_TIME - 1);
        expect(answer.settled).toBe(false);

        await advance(1);
        await until(() => answer.settled);
        expect(answer.value!.status).toBeGreaterThanOrEqual(500);
        expect(answer.value!.body).toMatchObject({ error: { code: 'unavailable' } });
        // Cut by the deadline, so not sent again.
        expect(sent).toEqual(['GET /v1/plans']);
    });

    it('gives every read of one subscription the same deadline, not one each', async () => {
        fakeClock();
        const { fake, call, sent } = setup(({ path }) =>
            path.endsWith('/attempts') || path === '/v1/plans' ? 'hang' : 4_000,
        );
        const id = await subscribed(fake);

        const answer = watch(call({ path: `/subscriptions/${id}` }));

        // 4 s for the subscription, then 6 s left for the rest, not 10 more.
        await advance(4_000);
        await until(() => sent.includes(`GET /v1/subscriptions/${id}/attempts`));
        await advance(READ_TIME - 4_000 - 1);
        expect(answer.settled).toBe(false);

        await advance(1);
        await until(() => answer.settled);
        expect(answer.value).toMatchObject({
            status: 200,
            body: {
                subscription: { id },
                payments: null,
                payments_error: { code: 'unavailable' },
                // The date is the subscription's own; the price could not be read.
                upcoming: [{ kind: 'charge', amount: null }],
            },
        });
    });

    it('walks the pages of a list within that one deadline', async () => {
        fakeClock();
        let pages = 0;
        const { call, sent } = setup(({ path }) => {
            if (path !== '/v1/subscriptions') return undefined;
            pages += 1;
            if (pages > 1) return 'hang';

            return Response.json({
                data: [{ ...SUBSCRIPTION, id: 'sub_1' }],
                has_more: true,
            });
        });

        const answer = watch(call({ path: '/subscriptions' }));

        await until(() => sent.length === 2);
        await advance(READ_TIME - 1);
        expect(answer.settled).toBe(false);

        await advance(1);
        await until(() => answer.settled);
        expect(answer.value!.status).toBeGreaterThanOrEqual(500);
        expect(answer.value!.body).toMatchObject({ error: { code: 'unavailable' } });
        expect(sent).toHaveLength(2);
    });

    it('still retries a read that fails otherwise, within the deadline', async () => {
        fakeClock();
        let calls = 0;
        const { call, sent } = setup(() => {
            calls += 1;

            return calls === 1
                ? Response.json({ statusCode: 503, message: 'Down.' }, { status: 503 })
                : undefined;
        });

        const answer = watch(call({ path: '/plans/pro' }));
        await advance(1_000);
        await until(() => answer.settled);

        expect(answer.value).toMatchObject({ status: 200, body: { slug: 'pro' } });
        expect(sent).toHaveLength(2);
    });
});

describe('the widget routes: the plan list kept for a minute', () => {
    it('does not keep a read cut at the deadline: the next request asks again', async () => {
        fakeClock();
        let down = true;
        const { call, sent } = setup(() => (down ? 'hang' : undefined));

        const cut = watch(call({ path: '/plans/pro' }));
        await advance(READ_TIME);
        await until(() => cut.settled);
        expect(cut.value!.status).toBeGreaterThanOrEqual(500);

        down = false;
        const answer = await call({ path: '/plans/pro' });

        expect(answer).toMatchObject({ status: 200, body: { slug: 'pro' } });
        expect(sent).toEqual(['GET /v1/plans', 'GET /v1/plans']);
    });

    it('does not keep a 429 either: one call, handed on, and asked again next time', async () => {
        fakeClock();
        let limited = true;
        const { call, sent } = setup(() => (limited ? rateLimited(60) : undefined));

        const refused = await call({ path: '/plans/pro' });
        expect(refused.status).toBe(429);
        expect(refused.headers).toEqual({ 'Retry-After': '60' });
        expect(sent).toEqual(['GET /v1/plans']);

        limited = false;
        const answer = await call({ path: '/plans/pro' });

        expect(answer).toMatchObject({ status: 200, body: { slug: 'pro' } });
        expect(sent).toEqual(['GET /v1/plans', 'GET /v1/plans']);
    });

    it("cuts a request that joined a read in flight at the first one's deadline", async () => {
        fakeClock();
        const { call, sent } = setup(() => 'hang');

        const first = watch(call({ path: '/plans/pro' }));
        await advance(6_000);
        const second = watch(call({ path: '/plans/pro' }));

        await advance(READ_TIME - 6_000 - 1);
        expect(first.settled || second.settled).toBe(false);

        await advance(1);
        await until(() => first.settled && second.settled);
        expect(second.value!.body).toMatchObject({ error: { code: 'unavailable' } });
        expect(sent).toEqual(['GET /v1/plans']);
    });
});

describe('the widget routes: what is not a read keeps its own time', () => {
    it('lets a submit wait its 90 s, past the deadline of the reads', async () => {
        fakeClock();
        const { fake, post, sent } = setup(({ method }) =>
            method === 'POST' ? 'hang' : undefined,
        );
        const created = await fake.client().subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_ada',
        });
        const { id } = created.subscription;
        const path = `/v1/subscriptions/${id}`;

        const answer = watch(
            post(`/subscriptions/${id}/submit`, {
                transaction: created.transaction,
                terms_signature: SIGNATURE,
            }),
        );

        await until(() => sent.length === 2);
        await advance(89_999);
        expect(answer.settled).toBe(false);
        expect(sent).toEqual([`GET ${path}`, `POST ${path}/submit`]);

        // The send is cut at 90 s, and replayed 10 s later, as before.
        await advance(1);
        await advance(10_000);
        await until(() => sent.length === 3);
        expect(sent).toEqual([`GET ${path}`, `POST ${path}/submit`, `POST ${path}/submit`]);
        expect(answer.settled).toBe(false);
    });

    it('lets a confirm wait its 90 s, sent once', async () => {
        fakeClock();
        const { fake, post, sent } = setup(({ method }) =>
            method === 'POST' ? 'hang' : undefined,
        );
        const id = await subscribed(fake);
        const path = `/v1/subscriptions/${id}`;

        const answer = watch(post(`/subscriptions/${id}/cancel/confirm`, { signature: SIGNATURE }));

        await until(() => sent.length === 2);
        await advance(89_999);
        expect(answer.settled).toBe(false);

        await advance(1);
        await until(() => answer.settled);
        expect(answer.value!.status).toBeGreaterThanOrEqual(500);
        expect(answer.value!.body).toMatchObject({ error: { code: 'unavailable' } });
        expect(sent).toEqual([`GET ${path}`, `POST ${path}/cancel/confirm`]);
    });
});

describe('the client, called directly, keeps its retries', () => {
    it.each([
        ['plans.retrieve', (mesub: Mesub) => mesub.plans.retrieve('pro')],
        ['subscriptions.retrieve', (mesub: Mesub) => mesub.subscriptions.retrieve('sub_1')],
        ['subscriptions.list', (mesub: Mesub) => mesub.subscriptions.list({ wallet: WALLET })],
        ['subscriptions.attempts', (mesub: Mesub) => mesub.subscriptions.attempts('sub_1')],
        ['access', (mesub: Mesub) => mesub.access(WALLET, 'pro', { attempts: true })],
    ])('%s waits out a 429 and asks three times', async (_name, read) => {
        fakeClock();
        const { client, sent } = setup(() => rateLimited(2));

        const failed = read(client).catch((error: unknown) => error);
        const state = watch(failed);

        await advance(3_999);
        expect(state.settled).toBe(false);

        await advance(1);
        const error = await failed;
        expect(error).toBeInstanceOf(MesubError);
        expect(error).toMatchObject({ code: 'rate_limited', retryAfter: 2_000 });
        expect(sent).toHaveLength(3);
    });

    it('takes no deadline from a call that asks for no attempts', async () => {
        fakeClock();
        const { client, sent } = setup(() => rateLimited(2));
        const options = { attempts: false, deadline: Date.now() + 1, retryRateLimited: false };

        const failed = client.access(WALLET, 'pro', options).catch((error: unknown) => error);
        // Its cache key is hashed first, in real time.
        await until(() => sent.length === 1);
        await advance(4_000);

        expect(await failed).toMatchObject({ code: 'rate_limited' });
        expect(sent).toHaveLength(3);
    });
});

const SUBSCRIPTION = {
    status: 'active',
    paused: false,
    end_reason: null,
    late_reason: null,
    access: true,
    payment_status: 'paid',
    plan: 'pro',
    wallet: WALLET,
    email: null,
    external_id: 'user_ada',
    current_period_start: null,
    current_period_end: null,
    next_charge_at: null,
    next_retry_at: null,
    retry_deadline: null,
    next_retry_number: null,
    retries_allowed: null,
    access_until: null,
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: '2026-01-01T00:00:00.000Z',
};
