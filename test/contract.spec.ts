import { type AccessAnswer, Mesub, MesubError } from '../src/index.js';

/**
 * The SDK against the real back, not a fake one: what catches the back
 * changing a field, a status or a code under the SDK's feet.
 *
 * Skipped unless MESUB_CONTRACT_URL is set, so CI and `pnpm test` never need
 * a back. The values come from the back's `pnpm contract:fixture`, see
 * `pnpm test:contract` in the README.
 */
const env = {
    url: process.env['MESUB_CONTRACT_URL'],
    key: process.env['MESUB_CONTRACT_KEY'] ?? '',
    plan: process.env['MESUB_CONTRACT_PLAN'] ?? '',
    wallet: process.env['MESUB_CONTRACT_WALLET'] ?? '',
    token: process.env['MESUB_CONTRACT_TOKEN'] ?? '',
};

/** Every field of AccessAnswer and its type, `attempts` aside. Kept in step with src/answer.ts. */
const FIELDS: Record<
    keyof Omit<AccessAnswer, 'attempts'>,
    'string' | 'boolean' | 'number' | 'string|null'
> = {
    wallet: 'string|null',
    plan: 'string',
    access: 'boolean',
    status: 'string',
    payment_status: 'string',
    subscribed_since: 'string|null',
    first_subscribed_at: 'string|null',
    current_period_end: 'string|null',
    cancelled_at: 'string|null',
    access_until: 'string|null',
    next_charge_at: 'string|null',
    next_retry_at: 'string|null',
    revalidate_after: 'number',
};

const STATUSES = ['pending', 'active', 'cancelled', 'unpaid', 'stopped', 'ended', 'failed', 'none'];
const PAYMENT_STATUSES = ['paid', 'late', 'none'];
const OUTCOMES = ['PAID', 'SKIPPED', 'REJECTED'];

/** A wallet nobody subscribed with: valid base58, never used by the fixture. */
const STRANGER = 'SysvarC1ock11111111111111111111111111111111';

function typeOf(value: unknown): string {
    return value === null ? 'null' : typeof value;
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

    describe('access tokens', () => {
        // The JWKS, the key format, /v1/project, aud and iss, all at once.
        it('verifies a token the back issued, and names its wallet', async () => {
            await expect(mesub().verifyToken(env.token)).resolves.toMatchObject({
                wallet: env.wallet,
            });
        });

        it('refuses the same token once edited', async () => {
            const [header, payload, signature] = env.token.split('.');
            const edited = `${header}.${payload}x.${signature}`;

            expect(await codeOf(mesub().verifyToken(edited))).toBe('invalid_token');
        });
    });

    it('answers hasAccess end to end for the fixture subscriber', async () => {
        await expect(mesub().hasAccess(env.wallet, env.plan)).resolves.toEqual(expect.any(Boolean));
    });
});
