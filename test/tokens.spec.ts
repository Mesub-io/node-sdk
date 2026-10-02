import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

import { Mesub, MesubError, TOKEN_COOKIE, tokenFrom } from '../src/index.js';
import { tokensFrom } from '../src/tokens.js';

const BASE = 'https://api.mesub.test';
const PROJECT = 'proj_1';
const WALLET = 'SysvarRent111111111111111111111111111111111';

describe('tokenFrom', () => {
    it('reads a bearer from Fetch headers', () => {
        expect(tokenFrom({ headers: new Headers({ authorization: 'Bearer abc' }) })).toBe('abc');
    });

    it('reads a bearer from Node headers', () => {
        expect(tokenFrom({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    });

    it('accepts the scheme in any case', () => {
        expect(tokenFrom({ headers: { authorization: 'bearer abc' } })).toBe('abc');
    });

    it('falls back on the mesub-token cookie', () => {
        expect(tokenFrom({ headers: { cookie: `${TOKEN_COOKIE}=abc` } })).toBe('abc');
    });

    it('finds the cookie among others', () => {
        expect(
            tokenFrom({ headers: new Headers({ cookie: `a=1; ${TOKEN_COOKIE}=abc; b=2` }) }),
        ).toBe('abc');
    });

    it('decodes an encoded cookie', () => {
        expect(tokenFrom({ headers: { cookie: `${TOKEN_COOKIE}=a%2Eb%2Ec` } })).toBe('a.b.c');
    });

    it('prefers the header over the cookie', () => {
        expect(
            tokenFrom({
                headers: { authorization: 'Bearer header', cookie: `${TOKEN_COOKIE}=cookie` },
            }),
        ).toBe('header');
    });

    it('ignores another scheme and reads the cookie', () => {
        expect(
            tokenFrom({ headers: { authorization: 'Basic xyz', cookie: `${TOKEN_COOKIE}=abc` } }),
        ).toBe('abc');
    });

    // `other-mesub-token=` must not pass for our cookie.
    it('does not take a cookie whose name only ends like ours', () => {
        expect(tokenFrom({ headers: { cookie: `other-${TOKEN_COOKIE}=abc` } })).toBeNull();
    });

    it.each([
        ['no headers at all', {}],
        ['a bearer with nothing after it', { authorization: 'Bearer' }],
        ['another scheme and no cookie', { authorization: 'Basic xyz' }],
        ['cookies without ours', { cookie: 'a=1; b=2' }],
        ['our cookie left empty', { cookie: `${TOKEN_COOKIE}=` }],
    ])('answers null on %s', (_label, headers) => {
        expect(tokenFrom({ headers })).toBeNull();
    });

    // decodeURIComponent throws on these: a 401, never a 500 (#37).
    it.each([['%E0%A4%A'], ['%'], ['%ZZ'], ['abc%']])(
        'answers null on a cookie that is not valid percent-encoding: %s',
        (value) => {
            expect(tokenFrom({ headers: { cookie: `${TOKEN_COOKIE}=${value}` } })).toBeNull();
        },
    );

    it('still reads the bearer when the cookie is malformed', () => {
        expect(
            tokenFrom({
                headers: { authorization: 'Bearer abc', cookie: `${TOKEN_COOKIE}=%E0%A4%A` },
            }),
        ).toBe('abc');
    });

    it('takes the first value when Node gives an array', () => {
        expect(tokenFrom({ headers: { authorization: ['Bearer first', 'Bearer second'] } })).toBe(
            'first',
        );
    });
});

// What the guards try in turn: a merchant's own bearer must not hide our cookie (#36).
describe('tokensFrom', () => {
    it('gives the bearer, then the cookie', () => {
        expect(
            tokensFrom({
                headers: { authorization: 'Bearer theirs', cookie: `${TOKEN_COOKIE}=ours` },
            }),
        ).toEqual(['theirs', 'ours']);
    });

    it('gives the same token once when both carry it', () => {
        expect(
            tokensFrom({
                headers: new Headers({
                    authorization: 'Bearer abc',
                    cookie: `${TOKEN_COOKIE}=abc`,
                }),
            }),
        ).toEqual(['abc']);
    });

    it.each([
        ['a bearer only', { authorization: 'Bearer abc' }, ['abc']],
        ['a cookie only', { cookie: `${TOKEN_COOKIE}=abc` }, ['abc']],
        [
            'another scheme and a cookie',
            { authorization: 'Basic x', cookie: `${TOKEN_COOKIE}=abc` },
            ['abc'],
        ],
        [
            'a malformed cookie and a bearer',
            { authorization: 'Bearer abc', cookie: `${TOKEN_COOKIE}=%` },
            ['abc'],
        ],
        ['neither', {}, []],
    ])('reads %s', (_label, headers, expected) => {
        expect(tokensFrom({ headers })).toEqual(expected);
    });
});

describe('verifyToken', () => {
    let privateKey: CryptoKey;
    let jwk: JWK;

    beforeAll(async () => {
        ({ privateKey, jwk } = await keyPair('key-1'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function keyPair(kid: string) {
        const pair = await generateKeyPair('ES256');

        return {
            privateKey: pair.privateKey,
            jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' },
        };
    }

    /** A token as the back issues one (#117), with anything overridden. */
    async function token(
        over: {
            key?: CryptoKey;
            kid?: string;
            aud?: string;
            iss?: string;
            exp?: string;
            wallet?: unknown;
            sub?: string;
        } = {},
    ) {
        const claims: Record<string, unknown> = {
            wallet: over.wallet === undefined ? WALLET : over.wallet,
        };
        if (over.wallet === null) delete claims['wallet'];

        return new SignJWT(claims)
            .setProtectedHeader({ alg: 'ES256', kid: over.kid ?? 'key-1' })
            .setSubject(over.sub ?? 'user_1')
            .setAudience(over.aud ?? PROJECT)
            .setIssuer(over.iss ?? BASE)
            .setIssuedAt()
            .setExpirationTime(over.exp ?? '1h')
            .sign(over.key ?? privateKey);
    }

    /** A Mesub answering the JWKS and /v1/project, counting calls to each. */
    function server(
        keys: () => JWK[] = () => [jwk],
        project: () => Response = () => Response.json({ id: PROJECT }),
    ) {
        const calls = { jwks: 0, project: 0 };
        const fetch = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (url.pathname === '/.well-known/jwks.json') {
                calls.jwks += 1;
                return Response.json({ keys: keys() });
            }
            if (url.pathname === '/v1/project') {
                calls.project += 1;
                return project();
            }
            throw new Error(`unexpected ${url.pathname}`);
        });

        return {
            calls,
            mesub: new Mesub({
                apiKey: 'SUB_test',
                baseUrl: BASE,
                fetch: fetch as unknown as typeof globalThis.fetch,
                maxRetries: 0,
            }),
        };
    }

    async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
        const error = await promise.catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MesubError);
        return (error as MesubError).code;
    }

    it('answers who the token is about', async () => {
        const { mesub } = server();

        await expect(mesub.verifyToken(await token())).resolves.toEqual({
            userId: 'user_1',
            wallet: WALLET,
        });
    });

    describe('when /v1/project answers without a project id (#27)', () => {
        const answers: [string, unknown][] = [
            ['no id', {}],
            ['an empty id', { id: '' }],
            ['a number', { id: 123 }],
            ['null', { id: null }],
            ['nothing at all', null],
        ];

        it.each(answers)('refuses to verify when it answers %s', async (_label, body) => {
            const { mesub } = server(undefined, () => Response.json(body));

            expect(await codeOf(mesub.verifyToken(await token()))).toBe('unavailable');
        });

        // Without an audience jose skips the check: any project's token would pass.
        it.each(answers)(
            "never accepts another project's token when it answers %s",
            async (_label, body) => {
                const { mesub } = server(undefined, () => Response.json(body));

                for (const aud of ['proj_2', 'undefined', '']) {
                    const error = await mesub
                        .verifyToken(await token({ aud }))
                        .catch((caught: unknown) => caught);
                    expect(error).toBeInstanceOf(MesubError);
                }
            },
        );

        it('asks again on the next call instead of keeping the empty answer', async () => {
            let first = true;
            const { mesub, calls } = server(undefined, () => {
                if (!first) return Response.json({ id: PROJECT });
                first = false;
                return Response.json({});
            });

            expect(await codeOf(mesub.verifyToken(await token()))).toBe('unavailable');
            await expect(mesub.verifyToken(await token())).resolves.toMatchObject({
                wallet: WALLET,
            });
            expect(calls.project).toBe(2);
        });

        it('checks the audience again once a real id comes back', async () => {
            let first = true;
            const { mesub } = server(undefined, () => {
                if (!first) return Response.json({ id: PROJECT });
                first = false;
                return Response.json({ id: '' });
            });

            await mesub.verifyToken(await token()).catch(() => undefined);

            expect(await codeOf(mesub.verifyToken(await token({ aud: 'proj_2' })))).toBe(
                'invalid_token',
            );
        });
    });

    // The whole point of aud: a token from merchant A is useless at merchant B.
    it('refuses a token issued for another project', async () => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(await token({ aud: 'proj_2' })))).toBe(
            'invalid_token',
        );
    });

    it('refuses an expired token', async () => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(await token({ exp: '-10s' })))).toBe('invalid_token');
    });

    // Five seconds of clock skew between our servers and the merchant's (#37).
    it('accepts a token that expired within the clock tolerance', async () => {
        const { mesub } = server();

        await expect(mesub.verifyToken(await token({ exp: '-3s' }))).resolves.toMatchObject({
            wallet: WALLET,
        });
    });

    describe('a token missing a claim it must carry (#37)', () => {
        /** Signed by our key, with only the claims a case keeps. */
        async function without(claim: 'exp' | 'sub' | 'aud' | 'iss') {
            const jwt = new SignJWT({ wallet: WALLET })
                .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
                .setIssuedAt();
            if (claim !== 'exp') jwt.setExpirationTime('1h');
            if (claim !== 'sub') jwt.setSubject('user_1');
            if (claim !== 'aud') jwt.setAudience(PROJECT);
            if (claim !== 'iss') jwt.setIssuer(BASE);
            return jwt.sign(privateKey);
        }

        it.each(['exp', 'sub', 'aud', 'iss'] as const)(
            'refuses a token without %s',
            async (claim) => {
                const { mesub } = server();

                expect(await codeOf(mesub.verifyToken(await without(claim)))).toBe('invalid_token');
            },
        );
    });

    it('refuses a token from another issuer', async () => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(await token({ iss: 'https://evil.test' })))).toBe(
            'invalid_token',
        );
    });

    it('refuses a token signed by another key that claims our kid', async () => {
        const { mesub } = server();
        const stranger = await keyPair('key-1');

        expect(await codeOf(mesub.verifyToken(await token({ key: stranger.privateKey })))).toBe(
            'invalid_token',
        );
    });

    it('refuses a token naming a key Mesub does not serve', async () => {
        const { mesub } = server();
        const stranger = await keyPair('key-9');

        expect(
            await codeOf(
                mesub.verifyToken(await token({ key: stranger.privateKey, kid: 'key-9' })),
            ),
        ).toBe('invalid_token');
    });

    it('refuses an HS256 token', async () => {
        const { mesub } = server();
        const hs = await new SignJWT({ wallet: WALLET })
            .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
            .setSubject('user_1')
            .setAudience(PROJECT)
            .setIssuer(BASE)
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('a-secret-long-enough-for-hs256-00'));

        expect(await codeOf(mesub.verifyToken(hs))).toBe('invalid_token');
    });

    it('refuses an unsigned token', async () => {
        const { mesub } = server();
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const unsigned = `${part({ alg: 'none', kid: 'key-1' })}.${part({ sub: 'user_1', aud: PROJECT, iss: BASE, wallet: WALLET, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;

        expect(await codeOf(mesub.verifyToken(unsigned))).toBe('invalid_token');
    });

    it('refuses a token without a wallet', async () => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(await token({ wallet: null })))).toBe(
            'invalid_token',
        );
    });

    it('refuses a wallet that is not a string', async () => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(await token({ wallet: 42 })))).toBe('invalid_token');
    });

    it.each([
        ['an empty string', ''],
        ['something that is not a JWT', 'not-a-token'],
    ])('refuses %s', async (_label, value) => {
        const { mesub } = server();

        expect(await codeOf(mesub.verifyToken(value))).toBe('invalid_token');
    });

    describe('what it fetches', () => {
        it('asks for the project id once per process', async () => {
            const { mesub, calls } = server();

            await mesub.verifyToken(await token());
            await mesub.verifyToken(await token());
            await mesub.verifyToken(await token());

            expect(calls.project).toBe(1);
        });

        it('fetches the keys once, then verifies locally', async () => {
            const { mesub, calls } = server();

            await mesub.verifyToken(await token());
            await mesub.verifyToken(await token());

            expect(calls.jwks).toBe(1);
        });

        // A rotation needs nothing from the merchant: a new kid refetches the keys.
        it('picks up a new key after a rotation', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const next = await keyPair('key-2');
            let served = [jwk];
            const { mesub } = server(() => served);
            await mesub.verifyToken(await token());

            served = [next.jwk, jwk];
            // jose waits its cooldown before fetching the keys again.
            vi.setSystemTime(Date.now() + 31_000);

            await expect(
                mesub.verifyToken(await token({ key: next.privateKey, kid: 'key-2' })),
            ).resolves.toMatchObject({
                wallet: WALLET,
            });
        });
    });

    describe('when Mesub cannot be reached', () => {
        it('is unavailable when the project id cannot be fetched', async () => {
            const { mesub } = server(undefined, () =>
                Response.json({ message: 'down' }, { status: 503 }),
            );

            expect(await codeOf(mesub.verifyToken(await token()))).toBe('unavailable');
        });

        // A failed lookup is not remembered: the next call asks again.
        it('asks for the project id again after a failure', async () => {
            let down = true;
            const { mesub, calls } = server(undefined, () =>
                down
                    ? Response.json({ message: 'down' }, { status: 503 })
                    : Response.json({ id: PROJECT }),
            );
            await mesub.verifyToken(await token()).catch(() => undefined);

            down = false;

            await expect(mesub.verifyToken(await token())).resolves.toMatchObject({
                wallet: WALLET,
            });
            expect(calls.project).toBe(2);
        });

        // A 500 from the JWKS is jose's generic error: an outage, not a forged token.
        it('is unavailable, not invalid, when the keys cannot be fetched', async () => {
            const fetch = vi.fn(async (input: string | URL | Request) => {
                const url = new URL(String(input instanceof Request ? input.url : input));
                return url.pathname === '/v1/project'
                    ? Response.json({ id: PROJECT })
                    : new Response('boom', { status: 500 });
            });
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: BASE,
                fetch: fetch as unknown as typeof globalThis.fetch,
                maxRetries: 0,
            });

            expect(await codeOf(mesub.verifyToken(await token()))).toBe('unavailable');
        });

        it('is unavailable when the network fails on the keys', async () => {
            const fetch = vi.fn(async (input: string | URL | Request) => {
                const url = new URL(String(input instanceof Request ? input.url : input));
                if (url.pathname === '/v1/project') return Response.json({ id: PROJECT });
                throw new TypeError('fetch failed');
            });
            const mesub = new Mesub({
                apiKey: 'SUB_test',
                baseUrl: BASE,
                fetch: fetch as unknown as typeof globalThis.fetch,
                maxRetries: 0,
            });

            expect(await codeOf(mesub.verifyToken(await token()))).toBe('unavailable');
        });
    });
});
