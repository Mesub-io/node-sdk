import { readFileSync } from 'node:fs';
import * as core from '../src/index.js';
import { Mesub } from '../src/index.js';
import { API_VERSION, VERSION } from '../src/version.js';
import { json, mockFetch } from './helpers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

it('sends the version of package.json in the User-Agent', () => {
    expect(VERSION).toBe(pkg.version);
});

describe('the API version', () => {
    it('is a date, exported with the header it goes in', () => {
        expect(API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(core.API_VERSION).toBe(API_VERSION);
        expect(core.API_VERSION_HEADER).toBe('Mesub-Version');
    });

    it('is sent with every call, GET and POST', async () => {
        const { fetch, calls } = mockFetch(
            json(200, { plans: [], revalidate_after: 60 }),
            json(400, { statusCode: 400, message: 'no', code: 'invalid_request' }),
        );
        const mesub = new Mesub({ apiKey: 'SUB_test', fetch, maxRetries: 0 });

        await mesub.accessList('wallet');
        await mesub.subscriptions.create({ plan: 'pro', wallet: 'wallet' }).catch(() => null);

        expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST']);
        for (const { init } of calls) {
            expect(new Headers(init.headers).get('mesub-version')).toBe(API_VERSION);
        }
    });

    it('is sent for the public keys too', async () => {
        const seen: Headers[] = [];
        const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (url.pathname === '/v1/project') return Response.json({ id: 'proj_1' });
            seen.push(new Headers(init?.headers));
            return Response.json({ keys: [] });
        });
        const mesub = new Mesub({
            apiKey: 'SUB_test',
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        // Well formed enough for jose to look for its key, never verified.
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${part({ alg: 'ES256', kid: 'key-1' })}.${part({ sub: 'u' })}.c2ln`;
        await mesub.verifyToken(token).catch(() => null);

        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]!.get('mesub-version')).toBe(API_VERSION);
    });

    it('cannot be replaced through headers', () => {
        expect(
            () => new Mesub({ apiKey: 'SUB_test', headers: { 'mesub-version': '2020-01-01' } }),
        ).toThrow(/cannot set/);
    });
});
