# @mesub/node

Server-side SDK for [Mesub](https://mesub.io), recurring payments on Solana.

Mesub runs the billing: it holds no funds, pulls each period on the merchant's
behalf, retries, and keeps the record of every attempt. This package is the
part that lives on your servers. It answers one question on every request:
**does this subscriber have access to this plan?**

> **Status: early, 0.x.** The API may still change between minor versions.
> See the [board](https://github.com/orgs/Mesub-io/projects/4) for what is next.

## Install

```sh
npm install @mesub/node
```

## How it fits

1. Your frontend signs the subscriber in with
   [`@mesub/react`](https://github.com/Mesub-io/react-sdk): email, then wallet.
   It gets a one-hour **access token**, sent to your server in
   `Authorization: Bearer` and in a `mesub-token` cookie.
2. This package **verifies that token locally**, with Mesub's public keys
   (fetched once from `/.well-known/jwks.json`), and learns which wallet is
   behind the request. The wallet always comes from that token, never from
   anything your code or the request passes.
3. It asks Mesub whether that wallet has access to the plan, and caches the
   answer for as long as Mesub says it stays true (`revalidate_after`).

## Configuration

Two keys, both from your Mesub dashboard, and nothing else:

| Where                | What                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| Your server's `.env` | `MESUB_API_KEY=SUB_...`, the API key. Read by this package.          |
| Your frontend        | `PUB_...`, the publishable key, given to `@mesub/react`. Not secret. |

## Guard a route

With Express:

```ts
import { requirePlan } from '@mesub/node/express';

app.get('/api/reports', requirePlan('pro'), (req, res) => {
    const { wallet, answer } = res.locals.mesub; // who, and what Mesub said
    res.json(buildReport(wallet));
});
```

With a Next.js App Router route handler:

```ts
import { withMesub } from '@mesub/node/next';

export const GET = withMesub(
    async (request, mesub, context) => Response.json(await buildReport(mesub.wallet)),
    { plan: 'pro' },
);
```

With a NestJS controller or route:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { MesubAccess, RequirePlan } from '@mesub/node/nest';

@Controller('reports')
@UseGuards(RequirePlan('pro'))
export class ReportsController {
    @Get()
    list(@MesubAccess() mesub: MesubAccess) {
        return buildReport(mesub.wallet);
    }
}
```

All three answer a refusal themselves:

| Status  | When                                                                                                                               | Body                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **401** | No token, or one that is forged, expired, or for another project                                                                   | `{ access: false, reason: 'unauthenticated' }`   |
| **402** | Mesub said this subscriber has no access to that plan                                                                              | `{ access: false, reason: 'no_access', status }` |
| **503** | Nobody can be identified, or Mesub failed (outage, rate limit, `guardTimeout` run out) on a wallet it never saw. `Retry-After: 30` | `{ access: false, reason: 'unavailable' }`       |

`onDenied(denial, ...)` answers instead: a redirect to your pricing page, your
own JSON. In Nest it throws your own exception, and the default refusal is
thrown if it returns. A broken integration (a bad API key, an unknown plan)
is never a refusal: Express gets it through `next(err)`, Next and Nest through
a thrown error, answered 500.

## Without a middleware

```ts
import { Mesub, tokenFrom } from '@mesub/node';

const mesub = new Mesub(); // reads MESUB_API_KEY

const token = tokenFrom(request); // Authorization bearer, else the mesub-token cookie
const { wallet } = await mesub.verifyToken(token!);

await mesub.hasAccess(wallet, 'pro'); // true or false, for a guard
await mesub.access(wallet, 'pro'); // the full answer: status, dates, next charge
await mesub.access(wallet, 'pro', { attempts: true }); // plus the last pull attempts
```

## Who to ask about

`access`, `hasAccess` and `accessList` take a customer, named by exactly one of:

```ts
await mesub.hasAccess({ external_id: user.id }, 'pro'); // your own id for them
await mesub.hasAccess({ wallet }, 'pro'); // the wallet that pays (a string alone works too)
await mesub.hasAccess({ email: 'ada@example.com' }, 'pro'); // the email given at checkout
```

- **`external_id`** when your app has its own login: the id you passed at
  checkout. It follows the customer whichever wallet pays, and across
  several: access if any of them grants it, and the answer names that wallet.
- **`wallet`** for a wallet-only dApp, where the connected wallet is the
  customer. This is what the guards use, from the access token.
- **`email`** as a fallback, or for a support lookup: it is the address given
  at checkout, never verified by Mesub, so anyone could have typed it.

Asked by `external_id` or `email`, a customer with nothing on that plan is
answered `wallet: null`. Emails are trimmed and lowercased, external ids
trimmed, as Mesub reads them: `' Ada@Example.com'` is `ada@example.com`.

Without a plan, `accessList` answers every plan the customer has anything on,
for a page listing their entitlements in one call:

```ts
const { plans } = await mesub.accessList({ external_id: user.id });
// [{ plan: 'pro', access: true, status: 'active', ... }, ...]
```

It is cached on its own, for its own `revalidate_after`, and throws like
`access` when Mesub cannot answer. `access` and `hasAccess` always need a plan:
called without one, they throw a `TypeError` instead of asking.

## When Mesub does not answer

- **Verifying a token** needs Mesub only on the first token after a start, and
  after a key rotation: the keys and the project id are then kept in memory.
- **`hasAccess`** never locks out a paying subscriber for an outage, nor lets a
  stranger in: after its retries it serves the last answer it knew for that
  customer and plan, even stale (for up to 24 hours, see `maxStaleMs`), and
  `false` for one it never saw. `access` throws instead, since it is for
  screens.
- **The guards** (`requirePlan`, `withMesub`, `RequirePlan`) never hold a
  request longer than `guardTimeout`, 2 s by default, for the access check:
  retries happen only while they fit, and a `Retry-After` that would outlast
  it is not waited. When it runs out, or Mesub fails (5xx, 429, network),
  the guard answers from the last answer it knew, like `hasAccess`, or 503
  with `Retry-After: 30` for a wallet it never saw, since nobody knows yet
  whether it pays: 402 only ever means Mesub said no. Verifying the token is
  not counted: it needs Mesub only once per process, as said above.
- A bad key, an unknown plan or a malformed wallet always throws, it is never
  turned into `false`.

Calls to Mesub time out after 5 s and are retried twice, on network errors,
408, 409, 429 and 5xx, honouring `Retry-After`. These are HTTP retries of the
SDK's own calls, unrelated to a plan's pull retries. `access` and `hasAccess`,
called from your own code, keep exactly that: `guardTimeout` binds the guards
only.

## Options

```ts
new Mesub({
    apiKey, // default: process.env.MESUB_API_KEY
    baseUrl, // default: https://api.mesub.io
    timeout, // per attempt, ms, default 5000
    maxRetries, // default 2
    fetch, // a custom fetch, e.g. bound to your own agent
    cache, // where answers are kept, default: 10,000 entries in memory
    maxStaleMs, // how long a stale answer serves the outage fallback, default 24 h
    guardTimeout, // the guards' budget for the access check, ms, default 2000
});
```

The memory cache is per process and emptied on restart. A store is two
methods, so Redis is a few lines, and keeps the outage fallback across
restarts and servers:

```ts
import type { AccessAnswer, AccessList, CacheStore } from '@mesub/node';

const redisStore: CacheStore<AccessAnswer | AccessList> = {
    get: async (key) => JSON.parse((await redis.get(key)) ?? 'null') ?? undefined,
    set: async (key, entry, ttlMs) => {
        await redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
    },
};

const mesub = new Mesub({ cache: redisStore });
```

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

## Errors

Every failure is a `MesubError` with a `status` (the HTTP status, or `null`)
and a stable `code` to branch on:

| `code`            | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `invalid_request` | 400, e.g. a wallet that is not an address                           |
| `unauthorized`    | 401, an API key Mesub never issued                                  |
| `plan_not_found`  | 404, no plan of yours under that slug                               |
| `rate_limited`    | 429, after the retries                                              |
| `unavailable`     | 5xx, a timeout or a network error, after the retries                |
| `invalid_token`   | an access token that fails verification                             |
| `unexpected`      | any other status, or a 404 that is not Mesub's: is `baseUrl` right? |

## Requirements

Node 20 or later. Express, Next and `@nestjs/common` are optional peer
dependencies: install the one you use. `jose` is the only runtime dependency.

## Development

```sh
pnpm install
pnpm test          # unit tests, against a fake Mesub
pnpm typecheck
pnpm lint
pnpm build         # dist/, ESM and CJS, with declaration files
pnpm check:exports # every entry resolves through import and require, and shares one MesubError
```

The pre-push hook runs all of it, as CI does on Node 20, 22 and 24.

### Releasing

Bump `version` in `package.json` and `VERSION` in `src/version.ts`, merge, then
push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The Publish
workflow checks, builds and publishes with provenance.

### Contract test

`pnpm test` runs against a fake Mesub. The contract test runs the SDK against
the real back instead, to catch the back changing a field, a status or an
error code under the SDK. With the back running locally (`pnpm start:dev` in
Mesub-io/backend):

```sh
# in the backend: write a merchant, a key, a plan and a subscriber's token
pnpm -s contract:fixture > /tmp/mesub-contract.env

# here
env $(cat /tmp/mesub-contract.env) pnpm test:contract
```

Without `MESUB_CONTRACT_URL` it is skipped, which is why CI never needs a back.

## License

[MIT](./LICENSE)
