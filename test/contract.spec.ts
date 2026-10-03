import { type AccessAnswer, Mesub, MesubError, type ServerSubscription } from '../src/index.js';

/**
 * The SDK against the real back, not a fake one: what catches the back
 * changing a field, a status or a code under the SDK's feet.
 *
 * Skipped unless MESUB_CONTRACT_URL is set, so `pnpm test` never needs a back.
 * The values come from the back's `pnpm contract:fixture`, see
 * `pnpm test:contract` in the README. The Contract workflow sets
 * MESUB_CONTRACT_REQUIRED, so a fixture that printed nothing fails the run
 * rather than skipping every test into a green one.
 */
const env = {
    url: process.env['MESUB_CONTRACT_URL'],
    key: process.env['MESUB_CONTRACT_KEY'] ?? '',
    plan: process.env['MESUB_CONTRACT_PLAN'] ?? '',
    wallet: process.env['MESUB_CONTRACT_WALLET'] ?? '',
    // The merchant's customer (Mesub-io/backend#210): two wallets, two plans.
    externalId: process.env['MESUB_CONTRACT_EXTERNAL_ID'] ?? '',
    email: process.env['MESUB_CONTRACT_EMAIL'] ?? '',
    activeWallet: process.env['MESUB_CONTRACT_ACTIVE_WALLET'] ?? '',
    endedWallet: process.env['MESUB_CONTRACT_ENDED_WALLET'] ?? '',
    endedPlan: process.env['MESUB_CONTRACT_ENDED_PLAN'] ?? '',
};

if (process.env['MESUB_CONTRACT_REQUIRED']) {
    const missing = Object.entries(env)
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missing.length > 0) {
        throw new Error(
            `MESUB_CONTRACT_REQUIRED is set but these are empty: ${missing.join(', ')}`,
        );
    }
}

/** Every field of AccessAnswer and its type, `attempts` aside. Kept in step with src/answer.ts. */
const FIELDS: Record<
    keyof Omit<AccessAnswer, 'attempts'>,
    'string' | 'boolean' | 'number' | 'string|null'
> = {
    wallet: 'string|null',
    plan: 'string',
    access: 'boolean',
    status: 'string',
    paused: 'boolean',
    end_reason: 'string|null',
    payment_status: 'string',
    subscribed_since: 'string|null',
    first_subscribed_at: 'string|null',
    current_period_end: 'string|null',
    cancelled_at: 'string|null',
    access_until: 'string|null',
    next_charge_at: 'string|null',
    next_retry_at: 'string|null',
    retry_deadline: 'string|null',
    revalidate_after: 'number',
};

/** Every field of ServerSubscription and its type. Kept in step with src/subscriptions.ts. */
const SUBSCRIPTION_FIELDS: Record<keyof ServerSubscription, 'string' | 'boolean' | 'string|null'> =
    {
        id: 'string',
        status: 'string',
        paused: 'boolean',
        end_reason: 'string|null',
        access: 'boolean',
        payment_status: 'string',
        plan: 'string|null',
        wallet: 'string',
        email: 'string|null',
        external_id: 'string|null',
        current_period_start: 'string|null',
        current_period_end: 'string|null',
        next_charge_at: 'string|null',
        next_retry_at: 'string|null',
        retry_deadline: 'string|null',
        access_until: 'string|null',
        created_at: 'string',
        confirmed_at: 'string|null',
    };

/**
 * A plan as `GET /v1/plans` serves it (Mesub-io/backend#184). The SDK has no
 * method for it yet: checked here so the one it gets starts from what the
 * back really answers.
 */
const PLAN_FIELDS: Record<string, 'string' | 'number' | 'boolean' | 'string|null'> = {
    slug: 'string',
    name: 'string',
    description: 'string|null',
    project_name: 'string',
    logo_url: 'string|null',
    amount: 'string',
    amount_display: 'string',
    decimals: 'number',
    symbol: 'string|null',
    mint: 'string',
    period_hours: 'number',
    network: 'string',
    status: 'string',
    available: 'boolean',
    ends_at: 'string|null',
};

const STATUSES = [
    'pending',
    'active',
    'cancelled',
    'unpaid',
    'stopped',
    'ended',
    'failed',
    'superseded',
    'none',
];
const PAYMENT_STATUSES = ['paid', 'late', 'none'];
const OUTCOMES = ['PAID', 'SKIPPED', 'REJECTED', 'BLOCKED'];
const END_REASONS = [
    'cancelled',
    'plan_removed',
    'plan_replaced',
    'plan_ended',
    'authority_closed',
    'closed',
];

/** A wallet nobody subscribed with: valid base58, never used by the fixture. */
const STRANGER = 'SysvarC1ock11111111111111111111111111111111';

function typeOf(value: unknown): string {
    return value === null ? 'null' : typeof value;
}

/** Each field of `fields` present in `value` with one of its types, and nothing else. */
function expectShape(value: unknown, fields: Record<string, string>) {
    const record = value as Record<string, unknown>;

    expect(Object.keys(record).sort()).toEqual(Object.keys(fields).sort());
    for (const [field, expected] of Object.entries(fields)) {
        expect(expected.split('|'), field).toContain(typeOf(record[field]));
    }
}

describe.skipIf(!env.url)('contract with the back', () => {
    const mesub = () => new Mesub({ apiKey: env.key, baseUrl: env.url!, maxRetries: 0 });

    async function codeOf(promise: Promise<unknown>) {
        const error = await promise.catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MesubError);
        return (error as MesubError).code;
    }

    describe('GET /v1/access', () => {
        it('answers exactly the fields the SDK types, no more, no fewer', async () => {
            const answer = await mesub().access(STRANGER, env.plan);

            expect(Object.keys(answer).sort()).toEqual(Object.keys(FIELDS).sort());
        });

        it('answers each field with the type the SDK expects', async () => {
            const answer = (await mesub().access(STRANGER, env.plan)) as unknown as Record<
                string,
                unknown
            >;

            for (const [field, expected] of Object.entries(FIELDS)) {
                expect(expected.split('|'), field).toContain(typeOf(answer[field]));
            }
        });

        it('answers a status and a payment status the SDK knows', async () => {
            const answer = await mesub().access(env.wallet, env.plan);

            expect(STATUSES).toContain(answer.status);
            expect(PAYMENT_STATUSES).toContain(answer.payment_status);
        });

        it('answers an end reason the SDK knows, only on an ended status', async () => {
            const answer = await mesub().access(env.wallet, env.plan);

            expect([...END_REASONS, null]).toContain(answer.end_reason);
            if (answer.status !== 'ended') expect(answer.end_reason).toBeNull();
        });

        it('answers a stranger as neither paused nor ended for a reason', async () => {
            await expect(mesub().access(STRANGER, env.plan)).resolves.toMatchObject({
                paused: false,
                end_reason: null,
            });
        });

        it('answers a wallet that never subscribed as none, without access', async () => {
            await expect(mesub().access(STRANGER, env.plan)).resolves.toMatchObject({
                access: false,
                status: 'none',
                wallet: STRANGER,
                plan: env.plan,
            });
        });

        it('adds attempts when asked, each with the fields the SDK types', async () => {
            const answer = await mesub().access(env.wallet, env.plan, { attempts: true });

            expect(Array.isArray(answer.attempts)).toBe(true);
            for (const attempt of answer.attempts ?? []) {
                expect(Object.keys(attempt).sort()).toEqual([
                    'amount',
                    'attempted_at',
                    'outcome',
                    'reason',
                    'signature',
                ]);
                expect(OUTCOMES).toContain(attempt.outcome);
            }
        });

        // Asked by external id or email, nothing on the plan answers no wallet (#28).
        it('answers a null wallet for an external id it never saw', async () => {
            await expect(
                mesub().access({ external_id: 'never-subscribed-42' }, env.plan),
            ).resolves.toMatchObject({ access: false, status: 'none', wallet: null });
        });

        it('lists every plan of a customer when no plan is named', async () => {
            const list = await mesub().accessList(env.wallet);

            expect(Object.keys(list).sort()).toEqual(['plans', 'revalidate_after']);
            expect(list.revalidate_after).toBeGreaterThan(0);
            for (const answer of list.plans) {
                expect(Object.keys(answer).sort()).toEqual(Object.keys(FIELDS).sort());
            }
        });

        it('answers a positive revalidate_after', async () => {
            const answer = await mesub().access(STRANGER, env.plan);

            expect(answer.revalidate_after).toBeGreaterThan(0);
        });
    });

    describe("GET /v1/access by the merchant's customer", () => {
        it('answers the wallet that grants access, asked by external id', async () => {
            const answer = await mesub().access({ external_id: env.externalId }, env.plan);

            expectShape(answer, FIELDS);
            expect(answer).toMatchObject({
                wallet: env.activeWallet,
                plan: env.plan,
                access: true,
                status: 'active',
                payment_status: 'paid',
            });
        });

        it('answers the same, asked by email in another case', async () => {
            const answer = await mesub().access(
                { email: ` ${env.email.toUpperCase()} ` },
                env.plan,
            );

            expect(answer).toMatchObject({ wallet: env.activeWallet, access: true });
        });

        it('answers an ended plan without access, naming its wallet', async () => {
            await expect(
                mesub().access({ external_id: env.externalId }, env.endedPlan),
            ).resolves.toMatchObject({
                wallet: env.endedWallet,
                access: false,
                status: 'ended',
            });
        });

        it('lists both plans by slug, only the monthly one granting access', async () => {
            const list = await mesub().accessList({ external_id: env.externalId });

            expect(Object.keys(list).sort()).toEqual(['plans', 'revalidate_after']);
            for (const answer of list.plans) expectShape(answer, FIELDS);
            expect(list.plans.map(({ plan, access }) => [plan, access])).toEqual(
                [
                    [env.plan, true],
                    [env.endedPlan, false],
                ].sort(([a], [b]) => String(a).localeCompare(String(b))),
            );
            // The soonest of the plans granting access: one without would hold
            // the whole list to its 10 s.
            expect(list.revalidate_after).toBe(
                Math.min(
                    ...list.plans
                        .filter((answer) => answer.access)
                        .map((answer) => answer.revalidate_after),
                ),
            );
        });

        it('lists nothing for an external id it never saw', async () => {
            await expect(
                mesub().accessList({ external_id: 'never-subscribed-42' }),
            ).resolves.toMatchObject({ plans: [] });
        });
    });

    describe('GET /v1/subscriptions', () => {
        it("lists both of the customer's subscriptions, newest first", async () => {
            const page = await mesub().subscriptions.list({ external_id: env.externalId });

            expect(Object.keys(page).sort()).toEqual(['data', 'has_more']);
            expect(page.has_more).toBe(false);
            for (const subscription of page.data) {
                expectShape(subscription, SUBSCRIPTION_FIELDS);
                expect([...END_REASONS, null]).toContain(subscription.end_reason);
            }
            expect(
                page.data.map(({ plan, wallet, status, access }) => ({
                    plan,
                    wallet,
                    status,
                    access,
                })),
            ).toEqual([
                { plan: env.plan, wallet: env.activeWallet, status: 'active', access: true },
                { plan: env.endedPlan, wallet: env.endedWallet, status: 'ended', access: false },
            ]);
            for (const subscription of page.data) {
                expect(subscription).toMatchObject({
                    external_id: env.externalId,
                    email: env.email,
                });
            }
        });

        it('lists the same by email, by wallet, and narrowed to a plan', async () => {
            const mesubClient = mesub();
            const byEmail = await mesubClient.subscriptions.list({ email: env.email });
            const byWallet = await mesubClient.subscriptions.list({ wallet: env.activeWallet });
            const byPlan = await mesubClient.subscriptions.list({
                external_id: env.externalId,
                plan: env.endedPlan,
            });

            expect(byEmail.data.map(({ id }) => id)).toHaveLength(2);
            expect(byWallet.data.map(({ plan }) => plan)).toEqual([env.plan]);
            expect(byPlan.data.map(({ status }) => status)).toEqual(['ended']);
        });

        it('pages with limit and starting_after, and listAll walks every page', async () => {
            const mesubClient = mesub();
            const first = await mesubClient.subscriptions.list({
                external_id: env.externalId,
                limit: 1,
            });
            const all: string[] = [];

            for await (const subscription of mesubClient.subscriptions.listAll({
                external_id: env.externalId,
                limit: 1,
            })) {
                all.push(subscription.id);
            }

            expect(first.data).toHaveLength(1);
            expect(first.has_more).toBe(true);
            expect(all).toHaveLength(2);
            expect(all[0]).toBe(first.data[0]!.id);
        });

        it('lists nothing for a customer it never saw', async () => {
            await expect(
                mesub().subscriptions.list({ external_id: 'never-subscribed-42' }),
            ).resolves.toEqual({ data: [], has_more: false });
        });

        it('retrieves one by id, as the list answered it', async () => {
            const mesubClient = mesub();
            const [listed] = (await mesubClient.subscriptions.list({ wallet: env.activeWallet }))
                .data;
            const retrieved = await mesubClient.subscriptions.retrieve(listed!.id);

            expectShape(retrieved, SUBSCRIPTION_FIELDS);
            expect(retrieved).toEqual(listed);
        });

        it('answers not_found, subscription_not_found, for an id it never issued', async () => {
            const error = await mesub()
                .subscriptions.retrieve('never-issued')
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(MesubError);
            expect(error).toMatchObject({
                code: 'not_found',
                apiCode: 'subscription_not_found',
                status: 404,
            });
        });
    });

    describe('GET /v1/plans', () => {
        // No SDK method yet: the same key, the same header the transport sends.
        const get = (path: string) =>
            fetch(new URL(path, env.url), { headers: { Authorization: `Bearer ${env.key}` } });

        it("lists the project's plans by slug, each with the fields expected", async () => {
            const response = await get('/v1/plans');
            const body = (await response.json()) as { plans: Array<{ slug: string }> };

            expect(response.status).toBe(200);
            expect(Object.keys(body)).toEqual(['plans']);
            for (const plan of body.plans) expectShape(plan, PLAN_FIELDS);
            expect(body.plans.map(({ slug }) => slug)).toEqual([env.plan, env.endedPlan].sort());
        });

        it('reads one plan by slug, and a 404 plan_not_found for a slug it lacks', async () => {
            const found = await get(`/v1/plans/${env.plan}`);
            const missing = await get('/v1/plans/no-such-plan-here');

            expect(found.status).toBe(200);
            expectShape(await found.json(), PLAN_FIELDS);
            expect(missing.status).toBe(404);
            expect(await missing.json()).toMatchObject({ code: 'plan_not_found' });
        });
    });

    describe('plans, through the SDK', () => {
        it('lists both plans, each one the SDK can read', async () => {
            const plans = await mesub().plans.list();

            for (const plan of plans) expectShape(plan, PLAN_FIELDS);
            expect(plans.map(({ slug }) => slug)).toEqual([env.plan, env.endedPlan].sort());
        });

        it('retrieves one, and throws plan_not_found for a slug the project lacks', async () => {
            await expect(mesub().plans.retrieve(env.plan)).resolves.toMatchObject({
                slug: env.plan,
            });
            await expect(mesub().plans.retrieve('no-such-plan-here')).rejects.toMatchObject({
                status: 404,
                code: 'plan_not_found',
            });
        });
    });

    describe('errors', () => {
        it('answers unauthorized for a key never issued', async () => {
            const stranger = new Mesub({
                apiKey: 'SUB_never_issued',
                baseUrl: env.url!,
                maxRetries: 0,
            });

            expect(await codeOf(stranger.access(STRANGER, env.plan))).toBe('unauthorized');
        });

        it('answers plan_not_found for a slug the project does not have', async () => {
            expect(await codeOf(mesub().access(STRANGER, 'no-such-plan-here'))).toBe(
                'plan_not_found',
            );
        });

        it('answers invalid_request for a wallet that is not an address', async () => {
            expect(await codeOf(mesub().access('not-a-wallet', env.plan))).toBe('invalid_request');
        });

        // A broken integration must throw, even from the guard's call.
        it('makes hasAccess throw on a bad key, not answer false', async () => {
            const stranger = new Mesub({
                apiKey: 'SUB_never_issued',
                baseUrl: env.url!,
                maxRetries: 0,
            });

            expect(await codeOf(stranger.hasAccess(STRANGER, env.plan))).toBe('unauthorized');
        });
    });

    it('answers hasAccess end to end for the fixture subscriber', async () => {
        await expect(mesub().hasAccess(env.wallet, env.plan)).resolves.toEqual(expect.any(Boolean));
    });
});
