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

    it('cannot be replaced through headers', () => {
        expect(
            () => new Mesub({ apiKey: 'SUB_test', headers: { 'mesub-version': '2020-01-01' } }),
        ).toThrow(/cannot set/);
    });
});
