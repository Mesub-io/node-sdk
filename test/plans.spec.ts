import { Mesub, MesubError, type Plan } from '../src/index.js';
import { FakeMesub } from '../src/testing.js';

const BASE = 'https://api.mesub.test';

function plan(over: Partial<Plan> = {}): Plan {
    return {
        slug: 'pro',
        name: 'Pro',
        description: 'Everything.',
        project_name: 'Acme',
        logo_url: null,
        amount: '9990000',
        amount_display: '9.99',
        decimals: 6,
        symbol: 'USDC',
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        period_hours: 720,
        network: 'devnet',
        status: 'active',
        available: true,
        ends_at: null,
        ...over,
    };
}

/** A client whose API is one function, and what it was asked. */
function mesub(answer: (url: URL) => Response) {
    const asked: Array<{ method: string; path: string; auth: string | null }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        asked.push({
            method: init?.method ?? 'GET',
            path: url.pathname + url.search,
            auth: new Headers(init?.headers).get('authorization'),
        });
        return answer(url);
    }) as typeof globalThis.fetch;

    return {
        client: new Mesub({ apiKey: 'SUB_test', baseUrl: BASE, fetch, maxRetries: 0 }),
        asked,
    };
}

const refusal = (status: number, code: string) =>
    Response.json({ statusCode: status, message: 'no', code }, { status });

describe('plans.list', () => {
    it('answers the plans of the project, as a list', async () => {
        const plans = [plan({ slug: 'pro' }), plan({ slug: 'team', amount_display: '29.00' })];
        const { client, asked } = mesub(() => Response.json({ plans }));

        await expect(client.plans.list()).resolves.toEqual(plans);
        expect(asked).toEqual([{ method: 'GET', path: '/v1/plans', auth: 'Bearer SUB_test' }]);
    });

    it('answers an empty list for a project with no plan', async () => {
        const { client } = mesub(() => Response.json({ plans: [] }));

        await expect(client.plans.list()).resolves.toEqual([]);
    });

    it('hands back a status and a network it does not know, rather than throw', async () => {
        const later = plan({ status: 'paused' as never, network: 'testnet' as never });
        const { client } = mesub(() => Response.json({ plans: [later] }));

        await expect(client.plans.list()).resolves.toEqual([later]);
    });

    it.each([
        ['no list', {}],
        ['a list that is not one', { plans: 'pro' }],
        ['a plan with no slug', { plans: [{ ...plan(), slug: undefined }] }],
        ['an amount that is a number', { plans: [plan({ amount: 9990000 as never })] }],
        ['an end that is not a date', { plans: [plan({ ends_at: 'soon' })] }],
        ['a plan that is not an object', { plans: ['pro'] }],
    ])('refuses %s as an answer it cannot read', async (_name, body) => {
        const { client } = mesub(() => Response.json(body));

        await expect(client.plans.list()).rejects.toMatchObject({ code: 'unexpected' });
    });

    it('throws what Mesub refuses with, a bad key say', async () => {
        const { client } = mesub(() => refusal(401, 'invalid_api_key'));

        await expect(client.plans.list()).rejects.toMatchObject({ status: 401 });
    });

    it('is not cached: asked again each time', async () => {
        const { client, asked } = mesub(() => Response.json({ plans: [plan()] }));

        await client.plans.list();
        await client.plans.list();

        expect(asked).toHaveLength(2);
    });
});

describe('plans.retrieve', () => {
    it('answers one plan by its slug', async () => {
        const { client, asked } = mesub(() => Response.json(plan()));

        await expect(client.plans.retrieve('pro')).resolves.toEqual(plan());
        expect(asked[0]?.path).toBe('/v1/plans/pro');
    });

    it('reads a sunset plan, its end and no new subscriber', async () => {
        const ending = plan({
            status: 'sunset',
            available: false,
            ends_at: '2026-12-01T00:00:00.000Z',
        });
        const { client } = mesub(() => Response.json(ending));

        await expect(client.plans.retrieve('pro')).resolves.toEqual(ending);
    });

    it('throws plan_not_found for a slug the project lacks', async () => {
        const { client } = mesub(() => refusal(404, 'plan_not_found'));

        await expect(client.plans.retrieve('nope')).rejects.toMatchObject({
            status: 404,
            code: 'plan_not_found',
        });
    });

    it.each(['', '.', '..', 'Pro', 'a/b', 'a b', '-pro', 'pro-', 'a--b', '../access', 42, null])(
        'refuses %j before anything is sent: it could reach another route',
        async (slug) => {
            const { client, asked } = mesub(() => Response.json(plan()));

            await expect(client.plans.retrieve(slug as never)).rejects.toMatchObject({
                code: 'invalid_request',
                status: null,
            });
            expect(asked).toEqual([]);
        },
    );

    it('refuses an answer it cannot read', async () => {
        const { client } = mesub(() => Response.json({ slug: 'pro' }));
        const reading = client.plans.retrieve('pro');

        await expect(reading).rejects.toBeInstanceOf(MesubError);
        await expect(reading).rejects.toMatchObject({ code: 'unexpected' });
    });
});

describe('testing: plans', () => {
    it('lists the plans it was given, sorted by slug, a slug alone filled in', async () => {
        const fake = new FakeMesub({
            plans: ['team', { slug: 'pro', amount_display: '4.99', available: false }],
        });

        const plans = await fake.client().plans.list();

        expect(plans.map((each) => each.slug)).toEqual(['pro', 'team']);
        expect(plans[0]).toMatchObject({ amount_display: '4.99', available: false });
        expect(plans[1]).toMatchObject({ name: 'team', status: 'active', available: true });
    });

    it('retrieves one, and answers plan_not_found for a slug outside the list', async () => {
        const fake = new FakeMesub({ plans: ['pro'] });
        const client = fake.client();

        await expect(client.plans.retrieve('pro')).resolves.toMatchObject({ slug: 'pro' });
        await expect(client.plans.retrieve('team')).rejects.toMatchObject({
            code: 'plan_not_found',
        });
    });

    it('lists nothing and finds any slug when no plan was given, as access does', async () => {
        const client = new FakeMesub().client();

        await expect(client.plans.list()).resolves.toEqual([]);
        await expect(client.plans.retrieve('anything')).resolves.toMatchObject({
            slug: 'anything',
        });
    });

    it('still refuses a key that is not its own', async () => {
        const fake = new FakeMesub();
        const stranger = new Mesub({
            apiKey: 'SUB_other',
            baseUrl: fake.baseUrl,
            fetch: fake.fetch,
            maxRetries: 0,
        });

        await expect(stranger.plans.list()).rejects.toMatchObject({ status: 401 });
    });
});
