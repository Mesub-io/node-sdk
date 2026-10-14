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
        amount_usd: '9.99',
        decimals: 6,
        symbol: 'USDC',
        token: { symbol: 'USDC', name: 'USD Coin', logo_url: null, verified: true },
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        period_hours: 720,
        network: 'devnet',
        status: 'active',
        available: true,
        ends_at: null,
        ...over,
    };
}

/** What a plan reads as from a Mesub that predates `token` and `amount_usd`. */
const UNKNOWN = {
    amount_usd: null,
    token: { symbol: null, name: null, logo_url: null, verified: false },
} as const;

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

    it('reads a plan with no token nor dollar value, from a Mesub that predates them', async () => {
        const { token: _token, amount_usd: _usd, ...older } = plan();
        const { client } = mesub(() => Response.json({ plans: [older, { ...older }] }));

        const plans = await client.plans.list();

        expect(plans).toEqual([plan(UNKNOWN), plan(UNKNOWN)]);
        // Each plan its own token, not one shared.
        expect(plans[0]!.token).not.toBe(plans[1]!.token);
    });

    it('takes an unverified token with no symbol, and a plan Mesub knows no price for', async () => {
        const bonk = plan({
            symbol: null,
            amount_usd: null,
            token: {
                symbol: null,
                name: 'Bonk',
                logo_url: 'https://img.example/b.png',
                verified: false,
            },
        });
        const { client } = mesub(() => Response.json({ plans: [bonk] }));

        await expect(client.plans.list()).resolves.toEqual([bonk]);
    });

    it('takes a token Jupiter verified that Mesub does not vouch for', async () => {
        const jup = plan({
            symbol: null,
            amount_usd: '0.41',
            token: { symbol: 'BONK', name: 'Bonk', logo_url: null, verified: true },
        });
        const { client } = mesub(() => Response.json({ plans: [jup] }));

        await expect(client.plans.list()).resolves.toEqual([jup]);
    });

    it.each([
        ['a token that is a string', { token: 'USDC' }, 'plans[0].token is not an object'],
        ['a null token', { token: null }, 'plans[0].token is not an object'],
        ['a token that is a list', { token: [] }, 'plans[0].token is not an object'],
        [
            'a token with no verified',
            { token: { symbol: 'USDC', name: null, logo_url: null } },
            'plans[0].token.verified is missing',
        ],
        [
            'a verified that is no boolean',
            { token: { ...plan().token, verified: 'yes' } },
            'plans[0].token.verified is not a boolean',
        ],
        [
            'a token symbol that is a number',
            { token: { ...plan().token, symbol: 1 } },
            'plans[0].token.symbol is not a string or null',
        ],
        [
            'a token logo that is an object',
            { token: { ...plan().token, logo_url: {} } },
            'plans[0].token.logo_url is not a string or null',
        ],
        [
            'a dollar value that is a number',
            { amount_usd: 9.99 },
            'plans[0].amount_usd is not a string or null',
        ],
    ])('refuses %s as an answer it cannot read', async (_name, over, problem) => {
        const { client } = mesub(() => Response.json({ plans: [{ ...plan(), ...over }] }));

        await expect(client.plans.list()).rejects.toMatchObject({
            code: 'unexpected',
            message: expect.stringContaining(problem),
        });
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

    it('reads one with no token nor dollar value, from a Mesub that predates them', async () => {
        const { token: _token, amount_usd: _usd, ...older } = plan();
        const { client } = mesub(() => Response.json(older));

        await expect(client.plans.retrieve('pro')).resolves.toEqual(plan(UNKNOWN));
    });

    it('refuses a token it cannot read, naming the field', async () => {
        const { client } = mesub(() =>
            Response.json({ ...plan(), token: { ...plan().token, name: 7 } }),
        );

        await expect(client.plans.retrieve('pro')).rejects.toMatchObject({
            code: 'unexpected',
            message: expect.stringContaining('token.name is not a string or null'),
        });
    });

    it('throws plan_not_found for a slug the project lacks', async () => {
        const { client } = mesub(() => refusal(404, 'plan_not_found'));

        await expect(client.plans.retrieve('nope')).rejects.toMatchObject({
            status: 404,
            code: 'plan_not_found',
        });
    });

    it.each([
        '',
        '.',
        '..',
        'Pro',
        'a/b',
        'a b',
        '-pro',
        'pro-',
        'a--b',
        '../access',
        '123',
        '2026-10',
        42,
        null,
    ])('refuses %j before anything is sent: it could reach another route', async (slug) => {
        const { client, asked } = mesub(() => Response.json(plan()));

        await expect(client.plans.retrieve(slug as never)).rejects.toMatchObject({
            code: 'invalid_request',
            status: null,
        });
        expect(asked).toEqual([]);
    });

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

    it('serves a plan in verified USDC worth its amount, unless told otherwise', async () => {
        const fake = new FakeMesub({
            plans: ['pro', { slug: 'team', amount: '29000000', amount_display: '29.00' }],
        });

        const [pro, team] = await fake.client().plans.list();

        expect(pro).toMatchObject({
            symbol: 'USDC',
            amount_usd: '9.99',
            token: { symbol: 'USDC', name: 'USD Coin', logo_url: null, verified: true },
        });
        expect(team).toMatchObject({ amount_usd: '29.00', token: { verified: true } });
    });

    it('serves the token a plan was declared with, unverified with no symbol by default', async () => {
        const fake = new FakeMesub({
            plans: [
                { slug: 'bonk', token: { name: 'Bonk' } },
                {
                    slug: 'jup',
                    amount_usd: '0.41',
                    token: {
                        symbol: 'JUP',
                        name: 'Jupiter',
                        logo_url: 'https://img.example/j.png',
                        verified: true,
                    },
                },
                { slug: 'unknown', symbol: null },
                { slug: 'usdt', symbol: 'USDT' },
            ],
        });
        const client = fake.client();

        await expect(client.plans.retrieve('bonk')).resolves.toMatchObject({
            symbol: null,
            amount_usd: null,
            token: { symbol: null, name: 'Bonk', logo_url: null, verified: false },
        });
        await expect(client.plans.retrieve('jup')).resolves.toMatchObject({
            symbol: null,
            amount_usd: '0.41',
            token: { symbol: 'JUP', name: 'Jupiter', verified: true },
        });
        await expect(client.plans.retrieve('unknown')).resolves.toMatchObject({
            symbol: null,
            amount_usd: null,
            token: { symbol: null, name: null, logo_url: null, verified: false },
        });
        await expect(client.plans.retrieve('usdt')).resolves.toMatchObject({
            symbol: 'USDT',
            amount_usd: '9.99',
            token: { symbol: 'USDT', name: null, verified: true },
        });
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
