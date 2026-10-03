import { Mesub, type MesubOptions } from '../src/index.js';

/** The merchant's proxy in front of Mesub, under a path. */
const PROXY = 'https://proxy.example.test/mesub';
const WALLET = 'SysvarRent111111111111111111111111111111111';

interface Seen {
    url: string;
    headers: Headers;
}

/** A proxy at `PROXY` serving Mesub under its path only, recording each call. */
function proxied(options: MesubOptions = {}) {
    const seen: Seen[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        seen.push({ url: url.href, headers: new Headers(init?.headers) });

        if (url.pathname === '/mesub/v1/access') {
            return Response.json({ plans: [], revalidate_after: 60 });
        }

        return new Response('Not Found', { status: 404 });
    });
    const client = new Mesub({
        apiKey: 'SUB_test',
        baseUrl: PROXY,
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 0,
        ...options,
    });

    return { client, seen };
}

describe('a baseUrl with a path', () => {
    it('calls the API under that path', async () => {
        const { client, seen } = proxied();

        await client.accessList(WALLET);

        expect(seen.map((call) => call.url)).toEqual([`${PROXY}/v1/access?wallet=${WALLET}`]);
    });

    it('also with a trailing slash', async () => {
        const { client, seen } = proxied({ baseUrl: `${PROXY}/` });

        await client.accessList(WALLET);

        expect(seen.map((call) => call.url)).toEqual([`${PROXY}/v1/access?wallet=${WALLET}`]);
    });
});

describe('headers', () => {
    const access = {
        'CF-Access-Client-Id': 'id.access',
        'CF-Access-Client-Secret': 'secret',
    };

    it('are sent with every API call, next to the SDK own', async () => {
        const { client, seen } = proxied({ headers: access });

        await client.accessList(WALLET);

        const { headers } = seen[0]!;
        expect(headers.get('cf-access-client-id')).toBe('id.access');
        expect(headers.get('cf-access-client-secret')).toBe('secret');
        expect(headers.get('authorization')).toBe('Bearer SUB_test');
        expect(headers.get('user-agent')).toMatch(/^@mesub\/node\//);
    });

    it.each(['Authorization', 'authorization', 'User-Agent', 'Accept', 'content-type'])(
        'cannot set %s',
        (name) => {
            expect(() => proxied({ headers: { [name]: 'Bearer SUB_other' } })).toThrow(
                /cannot set/,
            );
        },
    );

    it.each([
        [{ 'bad name': 'x' }, /not a valid header/],
        [{ 'X-Ok': 'line\nbreak' }, /not a valid header/],
        [{ 'X-Count': 1 }, /must be a string/],
        [['X-Ok', 'x'], /must be an object/],
        ['X-Ok: x', /must be an object/],
    ])('refuses %j', (headers, message) => {
        expect(() => proxied({ headers: headers as Record<string, string> })).toThrow(message);
    });
});

describe('baseUrl', () => {
    it.each([`${PROXY}?region=eu`, `${PROXY}#v1`])('refuses %s: paths go after it', (baseUrl) => {
        expect(() => proxied({ baseUrl })).toThrow(/no query nor fragment/);
    });
});
