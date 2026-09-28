# @mesub/node

Server-side SDK for [Mesub](https://mesub.io), recurring payments on Solana.

Mesub runs the billing: it holds no funds, pulls each period on the merchant's
behalf, retries, and keeps the record of every attempt. This package is the
part that lives on your servers. It answers one question on every request:
**does this subscriber have access to this plan?**

> **Status: not published yet.** The package is being built in the open, one
> issue at a time: see the [board](https://github.com/orgs/Mesub-io/projects/4)
> and the [issues](https://github.com/Mesub-io/node-sdk/issues). The API below
> is the one being built, not one you can install today.

## How it fits

1. Your frontend signs the subscriber in with
   [`@mesub/react`](https://github.com/Mesub-io/react-sdk): email, then wallet.
   It receives a short-lived **access token**, sent to your server in
   `Authorization: Bearer` and in a `mesub-token` cookie.
2. This package **verifies that token locally**, against Mesub's public keys,
   without a network call, and learns which wallet is behind the request.
3. It asks Mesub whether that wallet has access to the plan, and caches the
   answer for as long as Mesub says it stays true.

## Planned usage

```ts
import { Mesub } from '@mesub/node';

// Reads MESUB_API_KEY from the environment by default.
const mesub = new Mesub();

await mesub.hasAccess(wallet, 'pro'); // true or false
await mesub.access(wallet, 'pro'); // the full answer: status, dates, next charge
```

As a guard, with Express:

```ts
import { requirePlan } from '@mesub/node/express';

// 401 without a valid token, 402 without access, next() otherwise.
app.use('/api/pro', requirePlan('pro'));
```

Or on a Next.js route handler:

```ts
import { withMesub } from '@mesub/node/next';

export const GET = withMesub(async (request, access) => Response.json(await report()), {
    plan: 'pro',
});
```

## When Mesub does not answer

`hasAccess` never lets an outage lock out a paying subscriber, nor let a
stranger in: after its retries, it serves the last answer it knew for that
wallet and plan, even stale, and answers `false` for one it never saw.
`access` throws instead, since it is for screens rather than guards.

A bad API key, an unknown plan or a malformed wallet is never turned into
`false`: those throw, because they are a broken integration, not a denial.

## Requirements

Node 20 or later. Express and Next are optional peer dependencies: install the
one you use.

## Development

```sh
pnpm install
pnpm test          # unit tests
pnpm typecheck
pnpm lint
pnpm build         # dist/, ESM and CJS, with declaration files
pnpm check:exports # every entry point resolves through import and require
```

The pre-push hook runs all of it, as CI does on Node 20, 22 and 24.

## License

[MIT](./LICENSE)
