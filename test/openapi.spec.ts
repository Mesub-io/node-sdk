import { readFileSync } from 'node:fs';

import { Validator } from '@cfworker/json-schema';

import { Mesub } from '../src/index.js';
import { FakeMesub } from '../src/testing.js';
import type { WebhookEventType } from '../src/webhooks.js';

/**
 * What the fake serves, held to the back's own contract: Mesub-io/backend
 * `openapi/v1.json` at this commit, copied as is to
 * `test/fixtures/openapi-v1.json`. When the back's contract moves, copy it
 * again (`git -C ../backend show origin/main:openapi/v1.json`) and move the
 * commit here: what the SDK no longer agrees with fails below.
 *
 * Every answer is checked against the schema the spec names for its route
 * and status, held strict: an object that lists its `properties` takes no
 * other, so a field the fake serves and the back does not fails as surely as
 * one it leaves out. The fake is built from the SDK's own types, so this is
 * where the types and the back's contract meet without a back running.
 */
const BACKEND_COMMIT = 'c585920507c1834708cfcdd84525771a4e818156';

interface Spec {
    info: { version: string };
    paths: Record<string, Record<string, { responses: Record<string, Response3> }>>;
    webhooks: Record<string, { post: { requestBody: Response3 } }>;
    components: { schemas: Record<string, Schema>; headers: Record<string, { schema: Schema }> };
}
interface Response3 {
    content?: { 'application/json'?: { schema: Schema } };
}
type Schema = Record<string, unknown>;

const spec = JSON.parse(
    readFileSync(new URL('./fixtures/openapi-v1.json', import.meta.url), 'utf8'),
) as Spec;

/** Every object schema that lists its properties, closed to any other. */
function strict(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(strict);
    if (typeof schema !== 'object' || schema === null) return schema;

    const copy = Object.fromEntries(
        Object.entries(schema).map(([key, value]) => [
            key,
            // `examples` and `example` are data, not schemas.
            key === 'examples' || key === 'example' ? value : strict(value),
        ]),
    );
    if ('properties' in copy && !('additionalProperties' in copy)) {
        copy['additionalProperties'] = false;
    }
    return copy;
}

const components = strict(spec.components) as Spec['components'];

/** What `instance` breaks of `schema`, read against the spec's components; empty when nothing. */
function problems(schema: Schema, instance: unknown): string[] {
    const validator = new Validator(
        { ...(strict(schema) as Schema), components },
        '2020-12',
        false,
    );
    const { errors } = validator.validate(instance);

    // The leaves only: "A subschema had errors" says nothing of where.
    return errors
        .filter((error) => !/subschema|does not match schema/.test(error.error))
        .map((error) => `${error.instanceLocation}: ${error.error}`);
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** The spec's routes, each as a pattern of the paths it serves. */
const ROUTES = Object.keys(spec.paths).map((route) => ({
    route,
    pattern: new RegExp(`^${route.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

interface Seen {
    method: string;
    route: string;
    status: number;
    body: unknown;
    requestId: string | null;
}

/** A fake, a client on it, and every answer it gave on a route of the spec. */
function recorded(options: ConstructorParameters<typeof FakeMesub>[0] = {}) {
    const fake = new FakeMesub(options);
    const seen: Seen[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const response = await fake.fetch(input, init);
        const url = new URL(String(input));
        const path = url.pathname.slice(new URL(fake.baseUrl).pathname.replace(/\/+$/, '').length);
        const route = ROUTES.find((each) => each.pattern.test(path))?.route;
        // Nest's own 404 for a route it does not have is no answer of the spec.
        if (route !== undefined) {
            seen.push({
                method: (init?.method ?? 'GET').toLowerCase(),
                route,
                status: response.status,
                body: await response.clone().json(),
                requestId: response.headers.get('mesub-request-id'),
            });
        }
        return response;
    };
    const client = (apiKey = fake.apiKey) =>
        new Mesub({
            apiKey,
            baseUrl: fake.baseUrl,
            fetch,
            maxRetries: 0,
            webhookSecret: fake.webhookSecret,
        });

    return { fake, client, seen };
}

/** Each answer seen, against the schema the spec names for its route and status. */
function expectContract(seen: Seen[]) {
    const pattern = new RegExp(String(components.headers['MesubRequestId']!.schema['pattern']));

    expect(seen.length).toBeGreaterThan(0);
    for (const { method, route, status, body, requestId } of seen) {
        const label = `${method.toUpperCase()} ${route} ${status}`;
        const schema =
            spec.paths[route]?.[method]?.responses[String(status)]?.content?.['application/json']
                ?.schema;

        expect(schema, `${label}: the spec names no such answer`).toBeDefined();
        expect(problems(schema!, body), label).toEqual([]);
        expect(requestId, `${label}: Mesub-Request-Id`).toMatch(pattern);
    }
}

const WALLET = 'SysvarRent111111111111111111111111111111111';
const OTHER = 'SysvarC1ock11111111111111111111111111111111';
const signed = { signature: 'fake_signature' };

describe(`the fake against the back's openapi/v1.json (${BACKEND_COMMIT.slice(0, 7)})`, () => {
    it('is the contract of the version this release sends', async () => {
        const { API_VERSION } = await import('../src/version.js');
        const versions = (
            spec.components.schemas['Event']!['properties'] as Record<string, Schema>
        )['api_version']!['enum'];

        expect(versions).toContain(API_VERSION);
    });

    it('checks strictly: a field too many, or one missing, fails', () => {
        const { stop_reason: _, ...missing } = {
            ...JSON.parse(JSON.stringify(spec.paths['/v1/events']!['get']!.responses['200']!)),
        }.content['application/json'].example.data[0].data;

        expect(problems(ref('Subscription'), missing)).not.toEqual([]);
        expect(
            problems(ref('Subscription'), { ...missing, stop_reason: null, extra: 1 }),
        ).not.toEqual([]);
        expect(problems(ref('Subscription'), { ...missing, stop_reason: null })).toEqual([]);
    });

    it('answers plans and access as the spec says', async () => {
        const { fake, client, seen } = recorded({
            plans: ['pro', 'team', { slug: 'bonk', token: { name: 'Bonk' } }],
        });
        const mesub = client();
        fake.grant(WALLET, 'pro');
        fake.grant({ external_id: 'user_42' }, 'team', {
            status: 'cancelled',
            cancelled_at: '2026-10-01T00:00:00.000Z',
            access_until: new Date(Date.now() + 86_400_000).toISOString(),
        });
        fake.deny(OTHER, 'pro', {
            status: 'stopped',
            late_reason: 'authority_closed',
            stop_reason: 'authority_closed',
        });
        fake.deny(OTHER, 'team', { status: 'ended', end_reason: 'closed_elsewhere' });
        fake.grant({ email: 'ada@example.com' }, 'pro', {
            blocked_since: '2026-10-01T00:00:00.000Z',
            blocked_reason: 'receiver_account_frozen',
        });

        await mesub.plans.list();
        await mesub.plans.retrieve('bonk');
        await mesub.plans.retrieve('nope').catch(() => null);
        await mesub.access(WALLET, 'pro');
        await mesub.access(WALLET, 'team');
        await mesub.access({ external_id: 'user_42' }, 'team');
        await mesub.access(OTHER, 'pro');
        await mesub.access(OTHER, 'team');
        await mesub.access({ email: 'ada@example.com' }, 'pro');
        await mesub.accessList(OTHER);
        await mesub.accessList({ external_id: 'nobody' });
        await mesub.access('not a wallet', 'pro').catch(() => null);
        await client('SUB_wrong')
            .access(WALLET, 'pro')
            .catch(() => null);

        expectContract(seen);
        expect(seen.map(({ status }) => status)).toEqual(
            expect.arrayContaining([200, 400, 401, 404]),
        );
    });

    it('answers subscribing, its reads, its attempts and what stops it as the spec says', async () => {
        const { fake, client, seen } = recorded();
        const mesub = client();

        const created = await mesub.subscriptions.create({
            plan: 'pro',
            wallet: WALLET,
            external_id: 'user_42',
            email: 'ada@example.com',
        });
        const { id } = created.subscription;
        await mesub.subscriptions.transaction(id);
        await mesub.subscriptions.submit(id, {
            transaction: created.transaction,
            terms_signature: 'signed',
        });
        await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET }).catch(() => null);
        fake.setAttempts(id, [
            {},
            { outcome: 'rejected', reason: 'insufficient_balance', signature: null, retry: true },
            { outcome: 'blocked', reason: 'mesub', signature: null, amount_usd: null },
        ]);
        await mesub.access(WALLET, 'pro', { attempts: true });
        await mesub.subscriptions.retrieve(id);
        await mesub.subscriptions.list({ external_id: 'user_42' });
        await mesub.subscriptions.attempts(id, { limit: 2 });
        await mesub.subscriptions.retry(id).catch(() => null);

        await mesub.subscriptions.cancel(id);
        await mesub.subscriptions.confirmCancel(id, signed);
        await mesub.subscriptions.close(id).catch(() => null);
        await mesub.subscriptions.resume(id);
        await mesub.subscriptions.confirmResume(id, signed);

        const late = fake.addSubscription({
            wallet: OTHER,
            plan: 'pro',
            status: 'unpaid',
            payment_status: 'late',
            late_reason: 'insufficient_balance',
            next_retry_at: new Date(Date.now() + 86_400_000).toISOString(),
            next_retry_number: 1,
            retries_allowed: 3,
        });
        await mesub.subscriptions.retry(late.id);
        const dead = fake.addSubscription({
            wallet: OTHER,
            plan: 'team',
            status: 'stopped',
            access: false,
            payment_status: 'none',
            late_reason: 'authority_closed',
            stop_reason: 'authority_closed',
        });
        await mesub.subscriptions.close(dead.id);
        await mesub.subscriptions.confirmClose(dead.id, signed);
        await mesub.subscriptions.retrieve('sub_nobody').catch(() => null);

        expectContract(seen);
        expect(new Set(seen.map(({ route }) => route))).toEqual(
            new Set([
                '/v1/subscriptions',
                '/v1/subscriptions/{id}/transaction',
                '/v1/subscriptions/{id}/submit',
                '/v1/access',
                '/v1/subscriptions/{id}',
                '/v1/subscriptions/{id}/attempts',
                '/v1/subscriptions/{id}/retry',
                '/v1/subscriptions/{id}/cancel',
                '/v1/subscriptions/{id}/cancel/confirm',
                '/v1/subscriptions/{id}/close',
                '/v1/subscriptions/{id}/resume',
                '/v1/subscriptions/{id}/resume/confirm',
                '/v1/subscriptions/{id}/close/confirm',
            ]),
        );
    });

    it('answers events as the spec says', async () => {
        const { fake, client, seen } = recorded();
        const mesub = client();
        const created = await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET });
        await mesub.subscriptions.submit(created.subscription.id, {
            transaction: created.transaction,
            terms_signature: 'signed',
        });
        for (const type of [
            'subscription.renewal_upcoming',
            'subscription.renewed',
            'subscription.payment_failed',
            'subscription.stopped',
            'subscription.expired',
        ] as const) {
            fake.addEvent(type, { subscription: { id: created.subscription.id } });
        }
        fake.addEvent('subscription.access_revoked');
        fake.addEvent('subscription.renewed', { sequence: null });

        const { data } = await mesub.events.list();
        await mesub.events.list({ type: 'subscription.renewed', limit: 1 });
        await mesub.events.list({ type: 'subscription.access_granted' });
        await mesub.events.retrieve(data[0]!.id);
        await mesub.events.retrieve('evt_nobody').catch(() => null);
        await mesub.events.list({ limit: 0 }).catch(() => null);

        expectContract(seen);
        expect(data).toHaveLength(8);
    });

    it.each([
        'subscription.created',
        'subscription.renewal_upcoming',
        'subscription.renewed',
        'subscription.payment_failed',
        'subscription.stopped',
        'subscription.cancelled',
        'subscription.resumed',
        'subscription.ended',
        'subscription.expired',
        'subscription.access_granted',
        'subscription.access_revoked',
    ] satisfies WebhookEventType[])('signs a %s webhook whose body is an Event', async (type) => {
        const { body } = await new FakeMesub().webhook(type);

        expect(problems(ref('Event'), JSON.parse(body))).toEqual([]);
    });

    it.each(Object.keys(spec.webhooks))(
        'signs a %s webhook as the spec describes that webhook',
        async (type) => {
            const schema =
                spec.webhooks[type]!.post.requestBody.content!['application/json']!.schema;
            const { body } = await new FakeMesub().webhook(type as WebhookEventType, {
                ...(type === 'test' && { subscription: { id: 'sub_test' } }),
            });

            expect(problems(schema, JSON.parse(body))).toEqual([]);
        },
    );

    it('raises the access events of its own changes as the spec says, when asked', async () => {
        const { client, seen } = recorded({ accessEvents: true });
        const mesub = client();
        const created = await mesub.subscriptions.create({ plan: 'pro', wallet: WALLET });
        const { id } = created.subscription;
        await mesub.subscriptions.submit(id, {
            transaction: created.transaction,
            terms_signature: 'signed',
        });

        const { data } = await mesub.events.list({ subscription: id });

        expectContract(seen);
        expect(data.map(({ type, sequence }) => [type, sequence])).toEqual([
            ['subscription.access_granted', 2],
            ['subscription.created', 1],
        ]);
    });
});
