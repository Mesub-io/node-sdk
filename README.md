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

`access`, `hasAccess`, `accessList` and `subscriptions.list` take a customer,
named by exactly one of:

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

## Subscribe from your server

Your server opens the subscription and relays the signatures; your front only
has the wallet sign. No Mesub account is involved, and the API key never
leaves your server.

1. **Create**, on your server: Mesub reserves the subscription and builds what
   the wallet signs.

    ```ts
    const { subscription, transaction, terms, costs } = await mesub.subscriptions.create({
        plan: 'pro',
        wallet, // the wallet that signs and pays
        email, // optional: where the subscriber's notices go
        external_id: user.id, // optional: your own id, handed back as given
    });
    // Send subscription.id, transaction, terms and costs to your front.
    ```

2. **Sign**, in your front, terms first, within five minutes
   (`terms.expires_at`), and without sending the transaction:

    ```ts
    import bs58 from 'bs58';
    import { VersionedTransaction } from '@solana/web3.js';

    // Show terms.message and costs (lamports) to the subscriber first.
    const signature = await wallet.signMessage(new TextEncoder().encode(terms.message));
    const terms_signature = bs58.encode(signature);

    const unsigned = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    const signed = await wallet.signTransaction(unsigned);
    const signedTransaction = Buffer.from(signed.serialize()).toString('base64');
    // Send terms_signature and signedTransaction back to your server.
    ```

3. **Submit**, on your server: Mesub checks both signatures, co-signs, sends
   the transaction and waits for the chain, up to a minute or so.

    ```ts
    import { MesubSubmitError } from '@mesub/node';

    try {
        const { subscription, reason } = await mesub.subscriptions.submit(id, {
            transaction: signedTransaction,
            terms_signature,
        });

        if (subscription.access) {
            // active (or cancelled, if the wallet set an end): grant the plan
        } else {
            // pending: Mesub read the chain, and this transaction did not land
            //   and no longer can (reason says why): create again for a new one
            // failed: what landed is not what Mesub built
        }
    } catch (error) {
        if (error instanceof MesubSubmitError) {
            // Mesub never said what became of it: the wallet may have paid.
            // error.subscription is the row read back (null if that failed):
            // read it again with retrieve before creating anew.
        }
        throw error;
    }
    ```

One send of `submit` waits up to 90 s (`{ timeout }` changes it). When it
gets no answer that says what became of it (a timeout, a network error, a
5xx, Mesub's `network_unavailable` while the Solana network does not answer),
or an error Mesub marks `retryable`, `submit` sends **the same request** again,
the same transaction and terms signature, up to twice: after the
`Retry-After` Mesub asks for, or 10 s, and only within the whole call's
budget, 120 s by default (`{ budget }`, in ms, changes it). Mesub recognises
a request it already co-signed, signs nothing again, and answers it from the
chain: `active` if it landed, or `pending` with its reason if it did not.

This relies on Mesub-io/backend#190 and #202 being deployed, as they are on
every Mesub environment this SDK talks to: a back without them would refuse
the second send with `terms_missing`, thrown as is.

When no send got an answer, `submit` reads the subscription back once, for
10 s at most, retries included. It returns it if it is `active` or
`cancelled` (it landed), and otherwise throws a `MesubSubmitError`: a
`MesubError` with `code` `unavailable`, how many `sends` it made, and the
`subscription` it read back, or `null` if that read failed too. Its
`status`, `apiCode`, `body` and `retryAfter` are those of the last send that
got a response (a 503, a 429), all null when none did (timeouts, network
errors); its `cause` is the last send's own error. A `pending` one may still
land: read it again a little later (Mesub also settles it on its own within
the hour), and only create anew once it is `expired`. The same read back
follows an answer the SDK cannot read (thrown as `unexpected`), and a replay
refused with `not_awaiting_signature` after a send that got no answer, since
the row has moved on (thrown as that `conflict`, with the row).

So `submit` takes at most its budget plus 10 s: **130 s by default**. That is
past Cloudflare's 100 s (a 524 to your front) and past many serverless
functions' limit: there, lower it, e.g. `{ timeout: 25_000, budget: 40_000 }`
for a 60 s function. A short `timeout` does not stop the request already
sent: Mesub may still co-sign it and the transaction land after `submit`
threw, so read the subscription back later rather than create anew.

An abort through `{ signal }` stops the sends, the waits and the read back,
and rejects with the signal's reason. A send already out may have been
co-signed: read the subscription back before anything else.

Refusals throw a `MesubError` (see [Errors](#errors)): its `code` says the
kind, its `apiCode` which one, e.g. `forbidden` / `terms_expired` (sign the
terms again), `conflict` / `transaction_expired` (create again), `conflict` /
`insufficient_balance` or `already_subscribed` on create, and `not_found` /
`subscription_not_found` for an id Mesub does not know.

Reading back:

```ts
await mesub.subscriptions.retrieve(id); // status, access, dates, wallet, email, external_id
await mesub.subscriptions.list({ external_id: user.id }); // { data, has_more }, newest first
for await (const sub of mesub.subscriptions.listAll({ email: 'a@b.co', plan: 'pro' })) {
    // every page, one call per page
}
```

`list` names the customer as `access` does (see
[Who to ask about](#who-to-ask-about)): exactly one of `wallet`, `external_id`
and `email`, trimmed and lowercased the same way, a `TypeError` otherwise. It
also answers `expired` checkouts, which nobody signed: `access` is false on
them.

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

Reads from Mesub time out after 5 s and are retried twice, on network errors
and on any error Mesub marks `retryable` (a 429 rate limit, a 5xx), honouring
`Retry-After`; an error without Mesub's flag is retried on 408, 429 and 5xx,
never on a 409. `create` is sent once and never retried, whatever happened:
one that got no answer may still have reserved. A full cap of subscriptions
waiting for a signature (`pending_cap_reached`, a 429) frees up over an hour:
the error's `retryAfter` says when. What `submit` does when no answer comes
back is in [Subscribe from your server](#subscribe-from-your-server).
These are HTTP retries of the SDK's own calls, unrelated to a plan's pull
retries. `access` and `hasAccess`, called from your own code, keep exactly
that: `guardTimeout` binds the guards only.

## Options

```ts
new Mesub({
    apiKey, // default: process.env.MESUB_API_KEY
    baseUrl, // default: https://api.mesub.io, may carry a path
    issuer, // the tokens' iss, default: baseUrl
    headers, // extra headers on every call, e.g. for a proxy
    timeout, // per attempt, ms, default 5000
    maxRetries, // default 2
    fetch, // a custom fetch, e.g. bound to your own agent
    cache, // where answers are kept, default: 10,000 entries in memory
    maxStaleMs, // how long a stale answer serves the outage fallback, default 24 h
    guardTimeout, // the guards' budget for the access check, ms, default 2000
});
```

They are checked once, by `new Mesub()`, which throws a `TypeError` naming
the option: a `baseUrl` that is not https (plain http only to `localhost` or
`127.0.0.1`: every call carries the key), a timeout that is not a positive
number of milliseconds, `maxRetries` or `maxStaleMs` below 0, or the
publishable `PUB_` key where the secret `SUB_` one goes. On an edge runtime
without `process.env` (Cloudflare Workers), pass `apiKey` yourself.

Behind a proxy, `baseUrl` may carry a path: every call, the public keys
included, goes under it (`https://proxy.example.com/mesub/v1/access`,
`.../mesub/.well-known/jwks.json`). The access tokens still name Mesub's own
URL as their issuer, so say which, and add whatever the proxy asks for, such
as a Cloudflare Access service token:

```ts
new Mesub({
    baseUrl: 'https://proxy.example.com/mesub',
    issuer: 'https://api.mesub.io',
    headers: {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID!,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET!,
    },
});
```

`headers` cannot replace the SDK's own (`Authorization`, `User-Agent`,
`Accept`, `Content-Type`), and the API key is never sent for the public keys.

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
| `invalid_token`   | an access token that fails verification                                 |
| `unexpected`      | any other status, or an answer that is not Mesub's: is `baseUrl` right? |

It also carries what Mesub answered:

- `apiCode`: Mesub's own code, finer than `code` (`subscription_not_found`,
  `already_subscribed`, `pending_cap_reached`, ...), or `null` when no Mesub
  error came back. A code is never renamed nor reused, but new ones are added:
  keep a default branch.
- `retryable`: whether the same call, sent again unchanged, may succeed later.
  Mesub's own flag when it sent one, what the status says otherwise.
- `retryAfter`: how long Mesub asked to wait before that, in milliseconds,
  from the response's `Retry-After` (on a 429, or a 503 such as
  `network_unavailable`), or `null` when it sent none.
- `body`: the error body, parsed when it is JSON.

A `submit` whose outcome Mesub never told throws a `MesubSubmitError`, a
`MesubError` that also carries the `subscription` read back and its `sends`:
see [Subscribe from your server](#subscribe-from-your-server).

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
