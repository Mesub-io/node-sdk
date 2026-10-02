import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

import { Mesub, MesubError, type MesubOptions } from '../src/index.js';

/** Mesub's own public URL, what the back signs `iss` with (PUBLIC_API_URL). */
const API = 'https://api.mesub.test';
/** The merchant's proxy in front of it, under a path. */
const PROXY = 'https://proxy.example.test/mesub';
const PROJECT = 'proj_1';
const WALLET = 'SysvarRent111111111111111111111111111111111';

let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' };
});

function token(iss: string) {
    return new SignJWT({ wallet: WALLET })
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setSubject('user_1')
        .setAudience(PROJECT)
        .setIssuer(iss)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
}

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

        if (url.href === `${PROXY}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
        if (url.href === `${PROXY}/v1/project`) return Response.json({ id: PROJECT });
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

    it('fetches the public keys under that path, not at the domain root', async () => {
        const { client, seen } = proxied({ issuer: API });

        await expect(client.verifyToken(await token(API))).resolves.toEqual({
            userId: 'user_1',
            wallet: WALLET,
        });
        expect(seen.map((call) => call.url)).toContain(`${PROXY}/.well-known/jwks.json`);
    });

    it('also with a trailing slash', async () => {
        const { client, seen } = proxied({ baseUrl: `${PROXY}/`, issuer: API });

        await client.verifyToken(await token(API));

        expect(seen.map((call) => call.url)).toContain(`${PROXY}/.well-known/jwks.json`);
    });
});

describe('issuer', () => {
    it('defaults to the baseUrl', async () => {
        const { client } = proxied();

        await expect(client.verifyToken(await token(PROXY))).resolves.toMatchObject({
            wallet: WALLET,
        });
    });

    it("refuses Mesub's own iss behind a proxy unless issuer names it", async () => {
        const { client } = proxied();

        const error = await client.verifyToken(await token(API)).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MesubError);
        expect((error as MesubError).code).toBe('invalid_token');
    });

    it('is the only iss accepted once set', async () => {
        const { client } = proxied({ issuer: API });

        const error = await client.verifyToken(await token(PROXY)).catch((e: unknown) => e);

        expect((error as MesubError).code).toBe('invalid_token');
    });

    it.each(['', 42])('refuses an issuer of %j', (issuer) => {
        expect(() => proxied({ issuer: issuer as string })).toThrow(TypeError);
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

    it('are sent for the public keys too, and never the API key', async () => {
        const { client, seen } = proxied({ headers: access, issuer: API });

        await client.verifyToken(await token(API));

        const keys = seen.find((call) => call.url.endsWith('/.well-known/jwks.json'))!;
        expect(keys.headers.get('cf-access-client-id')).toBe('id.access');
        expect(keys.headers.get('user-agent')).toMatch(/^@mesub\/node\//);
        expect(keys.headers.get('authorization')).toBeNull();
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
