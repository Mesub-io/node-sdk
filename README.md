# @mesub/node

Server-side SDK for [Mesub](https://mesub.io), recurring payments on Solana.

Mesub runs the billing: it holds no funds, pulls each period on the merchant's
behalf, retries, and keeps the record of every attempt. This package is the
part that lives on your servers. It answers **does this customer have access
to this plan?** on every request, and opens subscriptions for your front to
have the wallet sign.

> **Status: early, 0.x.** The API may still change between minor versions.
> See the [board](https://github.com/orgs/Mesub-io/projects/4) for what is next.

## Install

```sh
npm install @mesub/node
```

## How it fits

Your subscribers get no Mesub account. You keep your own login and your own
UI; your server talks to Mesub with the API key, through this package, and
your front only has the wallet sign.

```
your front                 your server (@mesub/node)              Mesub
----------                 -------------------------              -----
a request           --->   hasAccess({ external_id }, 'pro')  --->  answers, cached
"Subscribe"         --->   subscriptions.create               --->  reserves, builds
wallet signs terms  <---   terms + unsigned transaction
  then transaction  --->   subscriptions.submit               --->  co-signs, sends
```

Mesub knows a customer by your own id for them (`external_id`), by the
wallet that pays, or by the email given when they subscribed: see
[Who to ask about](#who-to-ask-about). The wallet is what pays, not an
account.

Three walkthroughs, in the order you need them:

1. [Gate a route](#gate-a-route): serve only customers with access to a plan.
2. [Subscribe from your server](#subscribe-from-your-server): create, have the
   wallet sign in your front, submit.
3. [Webhooks](#webhooks): hear from Mesub when a subscription renews, misses a
   payment or stops.

The [`@mesub/react`](https://github.com/Mesub-io/react-sdk) widget is
optional: a ready-made sign-in and checkout. Today it still subscribes
through an older path, being moved to the one above.

## Configuration

One key on your server, from your Mesub dashboard:

| Where                | What                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Your server's `.env` | `MESUB_API_KEY=SUB_...`, the API key. Read by this package.                                |
| Your server's `.env` | With webhooks: `MESUB_WEBHOOK_SECRET=whsec_...`, the endpoint's signing secret.            |
| Your frontend        | Only with the widget: `PUB_...`, the publishable key, given to `@mesub/react`. Not secret. |

## Gate a route

Ask Mesub before serving. How you name the customer depends on who signs
your users in.

### With your own login

Your login says who the user is: ask about them by your own id, the
`external_id` you passed when they subscribed.

```ts
import { Mesub } from '@mesub/node';

const mesub = new Mesub(); // reads MESUB_API_KEY

app.get('/api/reports', yourLogin, async (req, res) => {
    const user = res.locals.user; // whoever your login says
    if (!(await mesub.hasAccess({ external_id: user.id }, 'pro'))) {
        res.status(402).json({ error: 'The Pro plan is needed.' });
        return;
    }
    res.json(buildReport(user));
});
```

`hasAccess` caches Mesub's answer for as long as Mesub says it stays true
(`revalidate_after`), and serves the last one it knew when Mesub does not
answer: see [When Mesub does not answer](#when-mesub-does-not-answer). During
an outage it answers `false` for a customer it never saw. `access` throws
instead, and gives the full answer, for a screen:

```ts
await mesub.access({ external_id: user.id }, 'pro'); // status, dates, next charge
await mesub.access({ external_id: user.id }, 'pro', { attempts: true }); // plus the last pull attempts
```

#### What the answer says

`access` is the only field a guard needs. `status` says where the
subscription stands: `none` (never subscribed), `pending`, `active`, `unpaid`
(a pull missed), `cancelled`, `stopped` (no more pulls), `ended`, `failed` or
`superseded`. Three things the status alone does not say:

- **`cancelled`** is only read while the cancellation runs: access, if any,
  holds until `access_until`. Once that end date passed, the same
  subscription reads `ended`, with `end_reason: 'cancelled'`.
- **`end_reason`** says why an `ended` one ended, and is null on every other
  status: `cancelled`, `plan_removed` (the plan was deleted), `plan_replaced`
  (another plan stands at its address), `plan_ended` (past the plan's own end
  date), `authority_closed` (the wallet's authorisation was closed outside
  Mesub) or `closed` (the subscriber closed it through Mesub). Null too on
  one that ended before Mesub recorded reasons.
- **`paused`** is true on a seat parked over your project's cap: its `status`
  stays as it was, nothing is charged (`payment_status` is `none`), and
  `access` runs to the end of the period already paid, in `access_until`.

With `{ attempts: true }`, each attempt has an `outcome`: `PAID`, `SKIPPED`
(nothing was sent, the chain said it could not work), `REJECTED` (sent, and
refused for a reason that is the subscriber's) or `BLOCKED` (nothing was
tried, and none of it the subscriber's doing: it never counts against them).

Mesub may add a status, an end reason or an outcome: the SDK hands back one
it does not know rather than throw, so keep a default branch. `paused` and
`end_reason` are read as `false` and `null` from an API that predates them.

### Who to ask about

`access`, `hasAccess`, `accessList` and `subscriptions.list` take a customer,
named by exactly one of:

```ts
await mesub.hasAccess({ external_id: user.id }, 'pro'); // your own id for them
await mesub.hasAccess({ wallet }, 'pro'); // the wallet that pays (a string alone works too)
await mesub.hasAccess({ email: 'ada@example.com' }, 'pro'); // the email given when they subscribed
```

- **`external_id`** when your app has its own login: the id you passed to
  `subscriptions.create`. It follows the customer whichever wallet pays, and
  across several: access if any of them grants it, and the answer names that
  wallet.
- **`wallet`** for a wallet-only dApp, where the connected wallet is the
  customer. This is what the guards use, from the access token.
- **`email`** as a fallback, or for a support lookup: it is the address given
  when they subscribed, never verified by Mesub, so anyone could have typed
  it.

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

### With a Mesub access token

The guards, `requirePlan` (Express), `withMesub` (Next) and `RequirePlan`
(Nest), take the customer from a Mesub **access token** instead: a one-hour
token that the `@mesub/react` widget's sign-in issues today, sent in
`Authorization: Bearer` and in a `mesub-token` cookie. They verify it locally,
with Mesub's public keys (fetched once from `/.well-known/jwks.json`), ask
about the wallet behind it, and answer refusals themselves. The wallet always
comes from that token, never from anything your code or the request passes.

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

All three read the Mesub access token from `Authorization: Bearer`, then from
the `mesub-token` cookie: when your app already sends a bearer of its own (your
session JWT), a bearer that does not verify as a Mesub token falls back on the
cookie. If the token travels elsewhere, say where with `token`; it is then the
only place looked at:

```ts
requirePlan('pro', { token: (req) => req.get('x-mesub-token') });
```

All three answer a refusal themselves:

| Status  | When                                                                                                                               | Body                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **401** | No token, or one that is forged, expired, or for another project                                                                   | `{ access: false, reason: 'unauthenticated' }`   |
| **402** | Mesub said this subscriber has no access to that plan, or to any of the list                                                       | `{ access: false, reason: 'no_access', status }` |
| **503** | Nobody can be identified, or Mesub failed (outage, rate limit, `guardTimeout` run out) on a wallet it never saw. `Retry-After: 30` | `{ access: false, reason: 'unavailable' }`       |

`onDenied(denial, ...)` answers instead: a redirect to your pricing page, your
own JSON. In Nest it throws your own exception, and the default refusal is
thrown if it returns. It may be async: it is awaited, and what it throws or
rejects with goes where an integration error goes. A broken integration (a
bad API key, an unknown plan) is never a refusal: Express gets it through
`next(err)`, Next and Nest through a thrown error, answered 500.

#### Which plan

The plan is a slug, a list, or a function of the request giving either:

```ts
requirePlan('pro'); // that plan
requirePlan(['pro', 'team']); // any one of them

// worked out per request, from a list you wrote
const PLANS = new Map([
    ['reports', ['pro', 'team']],
    ['exports', ['team']],
]);
requirePlan((req) => PLANS.get(String(req.params.feature)) ?? 'team');
```

`withMesub` takes the same as `{ plan }`, `RequirePlan` as its first argument.
For a list, the plans are asked at once and read in order: the first that
grants lets the request through, without waiting for the ones after it, and
`mesub.plan` with `mesub.answer` say which plan it was and what Mesub
answered for it. Each plan keeps its own outage fallback, within the one
`guardTimeout`:

| None of the plans grants, and                         | Answer                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Mesub said no for every one                           | **402**, with the `status` of the first plan of the list       |
| Mesub failed on one it never answered for this wallet | **503** with `Retry-After`: nobody knows yet whether it grants |

The plan comes from what the route serves, never from what the request asks
for: `(req) => req.query.tier` lets anyone pick the plan they are checked
against. Map the request to a list you wrote, as above, or guard with every
plan the route accepts and serve according to `mesub.plan`. A function runs
only once the Mesub token verifies, so an anonymous request never reaches it.

A guard asks about **3 plans at most**, what a Dev project holds: each one is
a call to Mesub on every request, against your key's 1000 calls a minute.

An unknown plan is a broken integration, like a bad API key, unless a plan
earlier in the list already let the request through. An empty list, an empty
slug, or more than 3 plans is thrown when the guard is built, or on the
request for a function.

#### Without a middleware

What the guards do, by hand:

```ts
import { Mesub, tokenFrom } from '@mesub/node';

const mesub = new Mesub(); // reads MESUB_API_KEY

const token = tokenFrom(request); // Authorization bearer, else the mesub-token cookie
const { wallet } = await mesub.verifyToken(token!);

await mesub.hasAccess(wallet, 'pro'); // true or false, for a guard
await mesub.access(wallet, 'pro'); // the full answer: status, dates, next charge
```

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
        external_id: user.id, // optional: your own id, what you gate routes by
    });
    // Send transaction, terms and costs to your front; keep subscription.id.
    ```

    Pass `external_id` when your app has a login: it is how
    [Gate a route](#with-your-own-login) finds this customer, whichever wallet
    pays. Called again for the same plan and wallet while nothing landed,
    `create` answers the same subscription with a fresh transaction, and the
    `email` and `external_id` of the last call replace those before.

2. **Sign**, in your front, terms first, within five minutes
   (`terms.expires_at`), and without sending the transaction:

    ```ts
    import bs58 from 'bs58';
    import { VersionedTransaction } from '@solana/web3.js';

    // wallet: the connected wallet, e.g. useWallet() of @solana/wallet-adapter-react.
    // Show terms.message and costs (lamports) to the subscriber first.
    const signature = await wallet.signMessage(new TextEncoder().encode(terms.message));
    const terms_signature = bs58.encode(signature);

    const bytes = Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0));
    const signed = await wallet.signTransaction(VersionedTransaction.deserialize(bytes));
    const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
    // Send terms_signature and signedTransaction back to your server.
    ```

3. **Submit**, on your server: Mesub checks both signatures, co-signs, sends
   the transaction and waits for the chain, up to a minute or so.

    ```ts
    import { MesubSubmitError } from '@mesub/node';

    // subscriptionId: the subscription.id kept at create.
    try {
        const { subscription, reason } = await mesub.subscriptions.submit(subscriptionId, {
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
land: read it again a little later (Mesub also confirms it, or marks it
`expired`, on its own within the hour), and only create anew once it is
`expired`. The same read back
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

A subscription `submit` returns with `access` (`active`, or `cancelled`
before its end) drops the `/v1/access` answers this client cached for that
customer that still say no: by wallet, and by external id and email when the
subscription has them, for its plan and in `accessList`. So `hasAccess` right
after asks Mesub again, rather than answering the no it cached a few seconds
before. `retrieve` and `list` do the same for each subscription they find
with `access`. Another server sharing no store with this one keeps its own
cached no until its `revalidate_after` runs out.

Refusals throw a `MesubError` (see [Errors](#errors)): its `code` says the
kind, its `apiCode` which one, e.g. `forbidden` / `terms_expired` (create
again for fresh terms, and sign those), `conflict` / `transaction_expired` (create again), `conflict` /
`insufficient_balance` or `already_subscribed` on create, and `not_found` /
`subscription_not_found` for an id Mesub does not know.

Reading back:

```ts
await mesub.subscriptions.retrieve(id); // status, paused, end_reason, access, dates, wallet, email, external_id
await mesub.subscriptions.list({ external_id: user.id }); // { data, has_more }, newest first
for await (const sub of mesub.subscriptions.listAll({ email: 'a@b.co', plan: 'pro' })) {
    // every page, one call per page
}
```

`list` names the customer as `access` does (see
[Who to ask about](#who-to-ask-about)): exactly one of `wallet`, `external_id`
and `email`, trimmed and lowercased the same way, a `TypeError` otherwise. It
also answers `expired` checkouts, which nobody signed: `access` is false on
them. `status`, `paused` and `end_reason` read as on `access` (see
[What the answer says](#what-the-answer-says)): a `cancelled` subscription is
`ended`, with `end_reason: 'cancelled'`, once its end date passed.

## Webhooks

Mesub posts an event to your endpoint when a subscription changes, signed
the [Standard Webhooks](https://www.standardwebhooks.com) way. Register the
endpoint and pick its events in the dashboard; its signing secret goes in
`MESUB_WEBHOOK_SECRET` (or `new Mesub({ webhookSecret })`, or `{ secret }`
per call when you have several endpoints).

The signature is over the exact bytes Mesub sent: verify the raw body, never
one a JSON parser read and wrote again. With Express, mount `express.raw` on
the route, before any `app.use(express.json())` reaches it:

```ts
app.post('/webhooks/mesub', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        event = await mesub.webhooks.verify(req.body, req.headers);
    } catch (error) {
        if (error instanceof MesubError) return res.status(400).end();
        throw error;
    }

    if (await alreadyHandled(event.id)) return res.status(200).end();

    switch (event.type) {
        case 'subscription.renewed':
            // event.data is the subscription; event.data.detail what was paid
            break;
        case 'subscription.payment_failed':
            // event.data.detail.reason, retries_left, next_retry_at
            break;
        // ...
    }
    res.status(200).end();
});
```

In a Next route handler, `verifyWebhook` is the same check without a
client: `await verifyWebhook(await request.text(), request.headers)`.

- **Events**: `subscription.created` (first payment landed),
  `subscription.renewed`, `subscription.payment_failed`,
  `subscription.stopped` (no more pulls), `subscription.cancelled`,
  `subscription.resumed`, `subscription.ended` (the plan ended or was
  deleted, or the wallet closed its delegation: `data.end_reason` says
  which), `subscription.expired` (a
  checkout nobody signed), and `test`, sent from the dashboard with a
  made-up subscription. Keep a default branch: a newer type is handed back
  too.
- **`data`** is the subscription as `subscriptions.retrieve` answers it, plus
  `detail`, the event's own. It is taken at the first attempt, so it may be
  newer than the event: `created_at` is when the event happened.
- **Duplicates**: a delivery without a 2xx in 10 s is sent again for about 3
  days, under the same `event.id` (the `webhook-id` header): drop one you
  have already handled. A redirect is a failure.
- **Order** is not guaranteed: a retry can land after a later event. Before
  granting or revoking, ask `hasAccess`; `webhooks.verify` already dropped
  the cached no of a subscription that grants access.
- **Failures**: `invalid_webhook` when the signature, a header or the
  timestamp (5 minutes either way, see `tolerance`) is wrong; answer 400.
  `unexpected` for a body Mesub signed that this release cannot read.

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
  retries happen only while they fit, a `Retry-After` that would outlast it
  is not waited, and a 429 is never retried. When it runs out, or Mesub fails
  (5xx, 429, network), the guard answers from the last answer it knew, like
  `hasAccess`, or 503 with `Retry-After: 30` for a wallet it never saw, since
  nobody knows yet whether it pays: 402 only ever means Mesub said no.
  Verifying the token is not counted: it needs Mesub only once per process,
  as said above.
- **Many requests at once** for a customer not in the cache send Mesub one
  request, not one each: 50 checks of the same wallet on the same plan wait
  for the same answer, or the same error. The guards share theirs with each
  other, and `access`, `hasAccess` and `accessList` called from your code
  with each other, since a guard's request gives up sooner.
- A bad key, an unknown plan or a malformed wallet always throws, it is never
  turned into `false`.

Reads from Mesub time out after 5 s and are retried twice, on network errors
and on any error Mesub marks `retryable` (a 429 rate limit, a 5xx), honouring
`Retry-After`; an error without Mesub's flag is retried on 408, 429 and 5xx,
never on a 409. A guard never retries a 429. `create` is sent once and never
retried, whatever happened: one that got no answer may still have reserved,
and calling it again for the same plan and wallet answers that same
subscription. A full cap of subscriptions waiting for a signature (`pending_cap_reached`, a 429) frees up over an hour:
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
    webhookSecret, // the endpoint's whsec_ secret, default: process.env.MESUB_WEBHOOK_SECRET
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
`Accept`, `Content-Type`, `Mesub-Version`), and the API key is never sent for
the public keys.

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

`delete` is what drops a cached no once a subscription lands (see
[Subscribe from your server](#subscribe-from-your-server)). It is optional:
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
| `invalid_webhook` | a webhook that fails verification: signature, headers or timestamp      |
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

## Test your integration

`@mesub/node/testing` is a fake Mesub for your own tests: it answers what the
SDK asks (`/v1/access`, `/v1/project`, `/v1/subscriptions`, the public keys)
from what each test sets, through a `fetch` handed to the client. No network,
no Mesub account, and nothing of it in your production bundle.

```ts
import { FakeMesub } from '@mesub/node/testing';

const fake = new FakeMesub(); // or { plans: ['pro'] }: any other slug is plan_not_found
const mesub = fake.client(); // a real Mesub, wired to the fake

fake.grant(wallet, 'pro'); // active and paid
fake.grant({ external_id: 'user_42' }, 'pro', { wallet }); // by your own id
fake.deny(wallet, 'team', { status: 'stopped' }); // or setAccess(...) for any answer

await mesub.hasAccess(wallet, 'pro'); // true

// A guard, end to end: a token signed by the fake, for its project.
app.get('/api/reports', requirePlan('pro', { client: mesub }), handler);
await request(app)
    .get('/api/reports')
    .set('Authorization', `Bearer ${await fake.token(wallet)}`);

fake.fail('outage'); // every access and subscriptions call answers 503, until fail(null)
fake.fail({ status: 429, code: 'rate_limited', retryAfter: 2 });
fake.requests; // every call received: method, path, query, headers, body
fake.reset(); // between tests

// A webhook, signed with fake.webhookSecret, which fake.client() verifies with.
const { body, headers } = await fake.webhook('subscription.renewed', {
    subscription: { external_id: 'user_42' },
});
await request(app).post('/webhooks/mesub').set(headers).type('json').send(body);
```

Its answers are stale at once (`revalidate_after: 0`), so a change shows on
the next call while the outage fallback still has them; pass
`revalidate_after` to test the cache. A customer is answered as named: a
wallet granted is not found by its external id. `subscriptions.create` then
`submit` land at once and grant the plan; `addSubscription` adds one for
`retrieve` and `list`. Pass `fake.fetch` to your own `new Mesub()` with
`fake.apiKey` and `fake.baseUrl` if you build the client yourself, and
`fake.webhookSecret` as `webhookSecret`. `signWebhook(body, { secret })`
signs a body of your own.

## Requirements

Node 22 or later. Express, Next and `@nestjs/common` are optional peer
dependencies: install the one you use. `jose` is the only runtime dependency.

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
# in the backend: write a merchant, a key, a plan and a subscriber's token
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
