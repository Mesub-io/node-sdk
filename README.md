# @mesub/node

Server-side SDK for [Mesub](https://mesub.io), recurring payments on Solana.

Mesub runs the billing: it holds no funds, pulls each period on the merchant's
behalf, retries, and keeps the record of every attempt. This package is the
part that lives on your servers. It answers one question on every request:
**does this subscriber have access to this plan?**

> **Status: not published to npm yet.** Everything below works on `main`, see
> the [board](https://github.com/orgs/Mesub-io/projects/4) for what is left.

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
| Your server's `.env` | `MESUB_API_KEY=SUB_...`, the secret key. Read by this package.       |
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

Both answer a refusal themselves:

| Status  | When                                                                   | Body                                             |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| **401** | No token, or one that is forged, expired, or for another project       | `{ access: false, reason: 'unauthenticated' }`   |
| **402** | A valid subscriber without access to that plan                         | `{ access: false, reason: 'no_access', status }` |
| **503** | Mesub unreachable before anyone could be identified. `Retry-After: 30` | `{ access: false, reason: 'unavailable' }`       |

`onDenied(denial, ...)` answers instead: a redirect to your pricing page, your
own JSON. A broken integration (a bad secret key, an unknown plan) is never a
refusal: Express gets it through `next(err)`, Next through a thrown error.

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

## When Mesub does not answer

- **Verifying a token** needs Mesub only on the first token after a start, and
  after a key rotation: the keys and the project id are then kept in memory.
- **`hasAccess`** never locks out a paying subscriber for an outage, nor lets a
  stranger in: after its retries it serves the last answer it knew for that
  wallet and plan, even stale (for up to 24 hours), and `false` for one it
  never saw. `access` throws instead, since it is for screens.
- A bad key, an unknown plan or a malformed wallet always throws, it is never
  turned into `false`.

Calls to Mesub time out after 5 s and are retried twice, on network errors,
408, 409, 429 and 5xx, honouring `Retry-After`. These are HTTP retries of the
SDK's own calls, unrelated to a plan's pull retries.

## Options

```ts
new Mesub({
    apiKey, // default: process.env.MESUB_API_KEY
    baseUrl, // default: https://api.mesub.io
    timeout, // per attempt, ms, default 5000
    maxRetries, // default 2
    fetch, // a custom fetch, e.g. bound to your own agent
    cache, // where answers are kept, default: 10,000 entries in memory
});
```

The memory cache is per process and emptied on restart. A store is two
methods, so Redis is a few lines, and keeps the outage fallback across
restarts and servers:

```ts
import type { AccessAnswer, CacheStore } from '@mesub/node';

const redisStore: CacheStore<AccessAnswer> = {
    get: async (key) => JSON.parse((await redis.get(key)) ?? 'null') ?? undefined,
    set: async (key, entry, ttlMs) => {
        await redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
    },
};

const mesub = new Mesub({ cache: redisStore });
```

## Errors

Every failure is a `MesubError` with a `status` (the HTTP status, or `null`)
and a stable `code` to branch on:

| `code`            | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `invalid_request` | 400, e.g. a wallet that is not an address            |
| `unauthorized`    | 401, a secret key Mesub never issued                 |
| `plan_not_found`  | 404, no plan of yours under that slug                |
| `rate_limited`    | 429, after the retries                               |
| `unavailable`     | 5xx, a timeout or a network error, after the retries |
| `invalid_token`   | an access token that fails verification              |
| `unexpected`      | any other status                                     |

## Requirements

Node 20 or later. Express and Next are optional peer dependencies: install the
one you use. `jose` is the only runtime dependency.

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

### Contract test

`pnpm test` runs against a fake Mesub. The contract test runs the SDK against
the real back instead, to catch the back changing a field, a status or an
error code under the SDK. With the back running locally (`pnpm start:dev` in
Mesub-io/backend):

```sh
# in the backend: write a merchant, a key, a plan and a subscriber's token
pnpm contract:fixture > /tmp/mesub-contract.env

# here
env $(cat /tmp/mesub-contract.env) pnpm test:contract
```

Without `MESUB_CONTRACT_URL` it is skipped, which is why CI never needs a back.

## License

[MIT](./LICENSE)
