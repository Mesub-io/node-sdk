import { Mesub, MesubError } from '../src/index.js';
import { FakeMesub } from '../src/testing.js';

const BASE = 'https://api.mesub.test';

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

describe('project', () => {
    it('answers the id of the project the key belongs to', async () => {
        const { client, asked } = mesub(() => Response.json({ id: 'cmufsl77w001ag2s6pp1ngf9p' }));

        await expect(client.project()).resolves.toEqual({ id: 'cmufsl77w001ag2s6pp1ngf9p' });
        expect(asked).toEqual([{ method: 'GET', path: '/v1/project', auth: 'Bearer SUB_test' }]);
    });

    it('throws invalid_api_key for a key Mesub does not know', async () => {
        const { client } = mesub(() =>
            Response.json(
                { statusCode: 401, message: 'no', code: 'invalid_api_key' },
                { status: 401 },
            ),
        );

        await expect(client.project()).rejects.toMatchObject({
            status: 401,
            apiCode: 'invalid_api_key',
        });
    });

    it.each([
        ['an id that is not a string', { id: 42 }],
        ['no id', {}],
        ['a list', [{ id: 'cm1' }]],
    ])('refuses %s as an answer it cannot read', async (_name, body) => {
        const { client } = mesub(() => Response.json(body));
        const reading = client.project();

        await expect(reading).rejects.toBeInstanceOf(MesubError);
        await expect(reading).rejects.toMatchObject({ code: 'unexpected' });
    });

    it('is not cached: asked again each time', async () => {
        const { client, asked } = mesub(() => Response.json({ id: 'cm1' }));

        await client.project();
        await client.project();

        expect(asked).toHaveLength(2);
    });
});

describe('testing: project', () => {
    it('answers its projectId, and refuses a wrong key', async () => {
        const fake = new FakeMesub();

        await expect(fake.client().project()).resolves.toEqual({ id: fake.projectId });
        await expect(
            new Mesub({ apiKey: 'SUB_wrong', baseUrl: fake.baseUrl, fetch: fake.fetch }).project(),
        ).rejects.toMatchObject({ status: 401 });
    });
});
