# @mesub/node

Server-side SDK for [Mesub](https://mesub.io), recurring payments on Solana.

Mesub runs the billing: it holds no funds, pulls each period on the merchant's
behalf, retries, and keeps the record of every attempt. This package is the
part that lives on your servers. It answers **does this customer have access
to this plan?** on every request, and opens subscriptions for your front to
have the wallet sign.

**[Read the docs](https://docs.mesub.io)** for the walkthroughs. This page is
the short version and the reference of the options.

> **Status: early, 0.x, not on npm yet.** The API may still change between
> minor versions. See the [board](https://github.com/orgs/Mesub-io/projects/4)
> for what is next.

## Install

```sh
npm install @mesub/node
```

Node 22 or later. No runtime dependency.

## How it fits

Your subscribers get no Mesub account. You keep your own login and your own
UI; your server talks to Mesub with the API key, through this package, and
your pages only have the wallet sign. See
[How it works](https://docs.mesub.io/docs/how-it-works).

| Where                | What                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| Your server's `.env` | `MESUB_API_KEY=SUB_...`, the API key, from your dashboard. Read by this package. |
| Your server's `.env` | With webhooks: `MESUB_WEBHOOK_SECRET=whsec_...`, the endpoint's signing secret.  |
| Your pages           | Nothing. No key ever goes to the browser.                                        |

## Gate a route

Your own login says who the user is; Mesub says whether they have access.

```ts
import { Mesub } from '@mesub/node';

const mesub = new Mesub(); // reads MESUB_API_KEY

app.get('/api/analytics', yourLogin, async (req, res) => {
    if (!(await mesub.hasAccess({ external_id: req.user.id }, 'pro'))) {
        res.status(402).json({ error: 'The Pro plan is needed.' });
        return;
    }
    res.json(buildAnalytics(req.user));
});
```

The guards do the same in one line and answer the refusals themselves (401
nobody signed in, 402 no access, 503 Mesub could not answer about a customer it
never saw):

```ts
// Express
import { requirePlan } from '@mesub/node/express';

const customer = (req) => (req.user ? { external_id: req.user.id } : null);
app.get('/api/analytics', yourLogin, requirePlan('pro', { customer }), handler);
```

```ts
// Next, app/api/analytics/route.ts
import { withMesub } from '@mesub/node/next';

export const GET = withMesub(async (request, mesub) => Response.json(await analytics(mesub)), {
    plan: 'pro',
    customer: async (request) => {
        const session = await yourSession(request);
        return session ? { external_id: session.userId } : null;
    },
});
```

```ts
// Nest
import { Controller, Get, UseGuards } from '@nestjs/common';
import { MesubAccess, type MesubRequest, RequirePlan } from '@mesub/node/nest';

interface AuthedRequest extends MesubRequest {
    user?: { id: string };
}

@Controller('analytics')
@UseGuards(
    YourAuthGuard,
    RequirePlan<AuthedRequest>('pro', {
        customer: (req) => (req.user ? { external_id: req.user.id } : null),
    }),
)
export class AnalyticsController {
    @Get()
    list(@MesubAccess() mesub: MesubAccess) {
        return buildAnalytics(mesub.customer);
    }
}
```

> **`customer` must come from a session you verified**, never from the request
> itself. A guard reading `req.query.wallet` lets in anyone who types a
> subscriber's address.

A customer is named by exactly one of `external_id` (your own id for them),
`wallet` or `email`. A guard takes one plan, a list of up to three, or a
function of the request. `access` returns the whole answer for a screen, and
`accessList` every plan a customer has anything on.

Everything else, the answer's fields, the errors, who to ask about:
[Check access](https://docs.mesub.io/docs/access). What each status means:
[Lifecycle](https://docs.mesub.io/docs/lifecycle).

## When Mesub does not answer

`hasAccess` and the guards never lock out a paying subscriber for an outage,
nor let a stranger in: they serve the last answer they knew for that customer
and plan, for up to 24 hours (`maxStaleMs`), and `false` or a 503 for one they
never saw. `access` throws instead. A guard never holds a request longer than
`guardTimeout`, 2 s by default. A bad key or an unknown plan always throws: a
broken integration is never read as "not subscribed".

## Show your plans

```ts
const plans = await mesub.plans.list(); // sorted by slug
const pro = await mesub.plans.retrieve('pro');
// pro.amount_display "9.99", pro.symbol "USDC", pro.period_hours 720, pro.available
```

`available` is false on a plan that is ending and when your project is full:
show "Subscribe" only when it is true. Nothing is cached.

## Subscribe from your server

Three steps, with the wallet in the middle. The API key never leaves your
server.

```ts
// 1. On your server: Mesub reserves it and builds what the wallet signs.
const { subscription, transaction, terms, costs } = await mesub.subscriptions.create({
    plan: 'pro',
    wallet, // the wallet that signs and pays
    external_id: user.id, // optional: your own id, what you gate routes by
    email, // optional: where their notices go
});

// 2. In your pages: the wallet signs terms.message, then the transaction,
//    without sending it, before terms.expires_at.

// 3. On your server: Mesub co-signs, sends, and waits for the chain.
const { subscription: now, reason } = await mesub.subscriptions.submit(subscription.id, {
    transaction: signedTransaction,
    terms_signature,
});
if (now.access) {
    // it landed: grant the plan
}
```

`submit` waits for the chain: up to 130 s by default, which `{ timeout, budget }`
lower for a serverless function. When no answer says what became of it, it
throws a `MesubSubmitError`: read the subscription back with `retrieve` before
creating a new one, since the wallet may have paid.

The signing code, what `create` answers, the refusals:
[Subscribe from your server](https://docs.mesub.io/docs/subscribe).

## Cancel, resume, close, and payments

Each action is two calls from your server with the wallet in between: your
server builds a transaction, the subscription's own wallet signs and sends it,
your server confirms with the signature.

| To                                            | Build        | Confirm                            |
| --------------------------------------------- | ------------ | ---------------------------------- |
| stop the renewals of a running one            | `cancel(id)` | `confirmCancel(id, { signature })` |
| take a cancellation back before its end       | `resume(id)` | `confirmResume(id, { signature })` |
| close one that is over, and get its rent back | `close(id)`  | `confirmClose(id, { signature })`  |

```ts
await mesub.subscriptions.retrieve(id);
await mesub.subscriptions.list({ external_id: user.id }); // { data, has_more }
const { data, paid } = await mesub.subscriptions.attempts(id); // its charges, and the total paid
```

`listAll` and `allAttempts` walk every page. The steps, the refusals and what
an attempt carries: [Manage from your server](https://docs.mesub.io/docs/manage).

## Routes for the React widget

[`@mesub/react`](https://github.com/Mesub-io/react-sdk) is optional. It never
talks to Mesub: it calls your server, on routes this package mounts in one
line.

```ts
// Express, after your own login. Under Nest: the same app.use in main.ts.
import { mesubRoutes } from '@mesub/node/express';

app.use(
    '/api/mesub',
    yourLogin,
    mesubRoutes({
        customer: (req) => (req.user ? { external_id: req.user.id } : null),
        email: (req) => req.user?.email,
    }),
);
```

```ts
// Next, app/api/mesub/[...mesub]/route.ts
import { mesubRouteHandlers } from '@mesub/node/next';

export const { GET, POST } = mesubRouteHandlers({
    customer: async (request) => {
        const session = await yourSession(request);
        return session ? { external_id: session.userId } : null;
    },
});
```

Every subscription created is tied to the customer your function returns,
whatever the browser sends; one that is not theirs answers 404. `plans:
['pro', 'team']` keeps the widget to those plans. The browser never gets your
API key, nor the email and the id you gave Mesub.

| Route                                                        | What it does                                |
| ------------------------------------------------------------ | ------------------------------------------- |
| `GET /plans/:slug`                                           | The plan to show. Public.                   |
| `GET /subscriptions`                                         | The customer's subscriptions, 500 at most.  |
| `GET /subscriptions/:id`                                     | One of them, with its payments.             |
| `POST /subscriptions`                                        | Prepares one: terms and a transaction.      |
| `POST /subscriptions/:id/submit`                             | Sends what the wallet signed.               |
| `POST /subscriptions/:id/cancel`, `/resume`, `/close`        | The transaction the wallet signs and sends. |
| `POST /subscriptions/:id/cancel/confirm`, and the two others | Confirms it with its signature.             |

`GET /plans/:slug` is public, so the routes answer it from your project's
plan list, kept in memory for 60 seconds: one call to Mesub a minute at most,
whatever the slugs asked, and a slug you do not have costs none. A change to a
plan shows there within a minute. `mesub.plans.list` and `mesub.plans.retrieve`
themselves are never cached.

A refusal is `{ error: { code, message } }`. The widget's side:
[React widget](https://docs.mesub.io/docs/react).

## Webhooks

Mesub posts an event to your endpoint when a subscription changes, signed the
[Standard Webhooks](https://www.standardwebhooks.com) way. Verify the raw body,
never one a JSON parser read and wrote again:

```ts
import { MesubError } from '@mesub/node';

app.post('/webhooks/mesub', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        event = await mesub.webhooks.verify(req.body, req.headers);
    } catch (error) {
        if (error instanceof MesubError) return res.status(400).end();
        throw error;
    }

    if (await alreadyHandled(event.id)) return res.status(200).end();
    // event.type, event.data (the subscription), event.data.detail
    res.status(200).end();
});
```

In a Next route handler: `await verifyWebhook(await request.text(),
request.headers)`. A delivery can arrive twice or out of order: drop an
`event.id` you already handled, and ask `hasAccess` before granting or
revoking. The events, their bodies and how to test:
[Webhooks](https://docs.mesub.io/docs/webhooks).

## Errors

Every failure is a `MesubError` with a `status` (the HTTP status, or `null`)
and a stable `code` to branch on:

| `code`            | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `invalid_request` | 400, e.g. a wallet that is not an address                               |
| `unauthorized`    | 401, an API key Mesub never issued                                      |
| `forbidden`       | 403, e.g. signed terms that expired                                     |
| `plan_not_found`  | 404, no plan of yours under that slug                                   |
| `not_found`       | any other 404 Mesub answered, e.g. an unknown subscription id           |
| `conflict`        | 409, e.g. a wallet already subscribed                                   |
| `rate_limited`    | 429, after the retries                                                  |
| `unavailable`     | 5xx, a timeout or a network error, after the retries                    |
| `invalid_webhook` | a webhook that fails verification: signature, headers or timestamp      |
| `unexpected`      | any other status, or an answer that is not Mesub's: is `baseUrl` right? |

It also carries `apiCode`, Mesub's own finer code (`already_subscribed`,
`close_too_early`, ...), `retryable`, `retryAfter` in milliseconds, and the
parsed `body`. New codes are added: keep a default branch. Every code:
[API reference](https://docs.mesub.io/docs/api).

Reads time out after 5 s and are retried twice. `create` and the six manage
calls are sent once and never retried.

## Test your integration

`@mesub/node/testing` is a fake Mesub for your own tests: no network, no Mesub
account, and nothing of it in your production bundle.

```ts
import { FakeMesub } from '@mesub/node/testing';

const fake = new FakeMesub();
const mesub = fake.client(); // a real Mesub, wired to the fake

fake.grant({ external_id: 'user_42' }, 'pro');
await mesub.hasAccess({ external_id: 'user_42' }, 'pro'); // true

fake.fail('outage'); // every call answers 503, until fail(null)
const { body, headers } = await fake.webhook('subscription.renewed'); // signed
fake.reset(); // between tests
```

Guards, webhooks, subscribing and managing against it:
[Test your integration](https://docs.mesub.io/docs/testing).

## Options

```ts
new Mesub({
    apiKey, // default: process.env.MESUB_API_KEY
    baseUrl, // default: https://api.mesub.io, may carry a path
    headers, // extra headers on every call, e.g. for a proxy
    timeout, // per attempt, ms, default 5000
    maxRetries, // default 2
    fetch, // a custom fetch, e.g. bound to your own agent
    cache, // where answers are kept, default: 10,000 entries in memory
    maxStaleMs, // how long a stale answer serves the outage fallback, default 24 h
    guardTimeout, // the guards' budget for the access check, ms, default 2000
    webhookSecret, // the endpoint's whsec_ secret, default: process.env.MESUB_WEBHOOK_SECRET
});
```

They are checked once, by `new Mesub()`, which throws a `TypeError` naming
the option: a `baseUrl` that is not https (plain http only to `localhost` or
`127.0.0.1`: every call carries the key), a timeout that is not a positive
number of milliseconds, or `maxRetries` or `maxStaleMs` below 0. On an edge runtime
without `process.env` (Cloudflare Workers), pass `apiKey` yourself.

Behind a proxy, `baseUrl` may carry a path: every call goes under it
(`https://proxy.example.com/mesub/v1/access`). Add whatever the proxy asks
for, such as a Cloudflare Access service token:

```ts
new Mesub({
    baseUrl: 'https://proxy.example.com/mesub',
    headers: {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID!,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET!,
    },
});
```

`headers` cannot replace the SDK's own (`Authorization`, `User-Agent`,
`Accept`, `Content-Type`, `Mesub-Version`).

The memory cache is per process and emptied on restart. A store is three
methods, so Redis is a few lines, and keeps the outage fallback across
restarts and servers:

```ts
import type { AccessAnswer, AccessList, CacheStore } from '@mesub/node';

const redisStore: CacheStore<AccessAnswer | AccessList> = {
    get: async (key) => JSON.parse((await redis.get(key)) ?? 'null') ?? undefined,
    set: async (key, entry, ttlMs) => {
        await redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
    },
    delete: async (key) => {
        await redis.del(key);
    },
};

const mesub = new Mesub({ cache: redisStore });
```

`delete` is what drops a cached no once a subscription lands. It is optional:
a store without it gets that answer rewritten as stale instead, which also
makes the next call ask Mesub.

Keys read `mesub:access:key-<hash>:<plan>:<kind>:<id>`, and
`mesub:access-list:key-<hash>:<kind>:<id>` for `accessList`, so several
projects can share one Redis. `<hash>` is the start of your API key's SHA-256,
never the key itself: it needs no call to Mesub, so a server restarted during
an outage still reads what was cached before. `<kind>` is `wallet`,
`external_id` or `email`; `<id>` is the wallet itself, or for an external id or
an email an HMAC-SHA256 under your API key, so neither is ever stored in
clear. Rotating the API key starts a fresh cache: each customer costs one call
to Mesub, and the old keys expire on their own TTL. So do keys written before
the `<kind>` segment, which are no longer read.

### API version

Every call sends `Mesub-Version: 2026-10-02`, the version of the API this
release was written against, exported as `API_VERSION`. It is pinned per
release and cannot be set, so Mesub can change an answer for newer releases
without breaking one already installed: upgrading the package is what moves
you to a newer version. Mesub does not read it yet.

## Requirements

Node 22 or later. Express, Next and `@nestjs/common` are optional peer
dependencies: install the one you use. There is no runtime dependency.

What CI runs the tests against: Node 22 and 24; Express 5, and Express 4 on
Node 22; Nest 12. `@mesub/node/next` imports nothing from Next, only the Web
`Request` and `Response`, so no Next version is installed to test it.

## Development

```sh
pnpm install
pnpm test          # unit tests, against a fake Mesub
pnpm test:coverage # the same, with v8 coverage of src/ in coverage/index.html
pnpm typecheck
pnpm lint
pnpm build         # dist/, ESM and CJS, with declaration files
pnpm check:exports # every entry resolves through import and require, shares one MesubError,
                   # and the fake Mesub stays in @mesub/node/testing
```

The pre-commit hook lints and checks the format of the staged files; the
pre-push hook runs typecheck, test, build and check:exports. CI runs all of
it on Node 22 and 24, measures coverage on Node 24, fails under 90%, and
keeps the report as the `coverage` artifact of the run.

### Releasing

A version tag on main publishes, once a reviewer approves: see
[RELEASING.md](./RELEASING.md) for the one-time setup and the checklist, and
[CHANGELOG.md](./CHANGELOG.md) for what changed.

### Contract test

`pnpm test` runs against a fake Mesub. The contract test runs the SDK against
the real back instead, to catch the back changing a field, a status or an
error code under the SDK. With the back running locally (`pnpm start:dev` in
Mesub-io/backend):

```sh
# in the backend: write a merchant, a key, its plans and their subscribers
pnpm -s contract:fixture > /tmp/mesub-contract.env

# here
env $(cat /tmp/mesub-contract.env) pnpm test:contract
```

Without `MESUB_CONTRACT_URL` it is skipped, which is why `pnpm test` never
needs a back.

The Contract workflow runs it on every push, every morning and by hand (with a
back branch to try): it checks out Mesub-io/backend, starts Postgres and Redis,
migrates, seeds the fixture, starts the API and runs `pnpm test:contract`.
The back is private, so it needs one secret, set once by an admin:

1. `ssh-keygen -t ed25519 -N '' -C node-sdk-contract -f contract_key`
2. Mesub-io/backend, Settings, Deploy keys: add `contract_key.pub`, read-only.
3. Mesub-io/node-sdk, Settings, Secrets and variables, Actions: a repository
   secret `BACKEND_DEPLOY_KEY` holding `contract_key`. Then delete both files.

Without it the job is skipped with a warning. Whoever can push a branch here
can read the back's code through that key.

## License

[MIT](./LICENSE)
