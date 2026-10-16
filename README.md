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

// Your login sets req.user: declare it once. With Passport, add these fields to Express.User.
declare global {
    namespace Express {
        interface Request {
            user?: { id: string; email?: string };
        }
    }
}

app.get('/api/analytics', yourLogin, async (req, res) => {
    const user = req.user!; // yourLogin answers 401 when nobody is signed in
    if (!(await mesub.hasAccess({ external_id: user.id }, 'pro'))) {
        res.status(402).json({ error: 'The Pro plan is needed.' });
        return;
    }
    res.json(buildAnalytics(user));
});
```

Called like this, `hasAccess` has no time budget: it waits out the client's
timeout and retries, and a 429's `Retry-After` twice, so a rate limit can hold
the route for about two minutes. The guards do the same in one line, within
`guardTimeout` (2 s by default), and answer the refusals themselves (401
nobody signed in, 402 no access, 503 Mesub could not answer about a customer it
never saw):

```ts
// Express
import type { Request } from 'express';
import { requirePlan } from '@mesub/node/express';

const customer = (req: Request) => (req.user ? { external_id: req.user.id } : null);
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

A guard reads `access`, never `status`. Access runs past `access_until`
while the renewal goes through, a couple of minutes when nothing is in its
way; never past it on a blocked subscription, nor past a plan's end. On a plan
with an end date (`ends_at` on the plan) `access_until` is never later than
that end: nobody has access past it, the last period being charged in full
all the same. In that last period the
answer has no `next_charge_at`, and a late one no `next_retry_at`, since no
pull is left to run. For a few minutes past the end, `status` can still read
`active` or `unpaid` with `access: false`, until Mesub ends the subscription
(`ended`, `end_reason: 'plan_ended'`).

A charge can also fail for a reason that is not your customer's. The answer
then carries `blocked_since` and `blocked_reason`, both null otherwise:
`mesub` for a cause on Mesub's side, or your plan's own setup by name,
`puller_not_allowed`, `receiver_not_allowed`, `receiver_account_missing`,
`receiver_account_frozen` or `mint_gone`. `status` and `payment_status` do not
move for it and Mesub keeps trying; `access` ends at `access_until` if nothing
is collected by then, and comes back with the first charge that goes through,
nothing to sign. On `mint_gone` no charge can go through again, so access does
not come back.

Everything else, the answer's fields, the errors, who to ask about:
[Check access](https://docs.mesub.io/docs/access). What each status means:
[Lifecycle](https://docs.mesub.io/docs/lifecycle).

## When Mesub does not answer

`hasAccess` and the guards do not lock out a paying subscriber for an outage,
nor let a stranger in: they serve the last answer they knew for that customer
and plan, for up to 24 hours (`maxStaleMs`), and `false` or a 503 for one they
never saw. An answer with no charge or retry ahead (cancelled, parked, or in
a plan's last period) stops at its `access_until`; one with a renewal ahead
keeps the fallback, as it was likely paid while Mesub was down. A blocked one
(`blocked_since`) stops at its `access_until` whatever is ahead, as Mesub
does: its retries say nothing of a payment.
`access` throws instead. A guard never holds a request longer than
`guardTimeout`, 2 s by default, a cache store that hangs included: a read not
answered by then is a miss, and no answer waits for a write. Its 503 carries
the `Retry-After` Mesub sent, 30 s when it sent none. A bad key or an unknown
plan always throws: a broken integration is never read as "not subscribed".

## Show your plans

```ts
const plans = await mesub.plans.list(); // sorted by slug
const pro = await mesub.plans.retrieve('pro');
// pro.amount_display "9.99", pro.symbol "USDC", pro.period_hours 720, pro.available
// pro.token { symbol: "USDC", name: "USD Coin", logo_url, verified: true }, pro.amount_usd "9.99"
```

`available` is false on a plan that is ending and when your project is full:
show "Subscribe" only when it is true. `ends_at` is when a plan ends, null
for one with no end. Nothing is cached.

`symbol` is set only for a mint Mesub vouches for (USDC, USDT, PYUSD).
`token` is what Mesub resolved for any mint: its symbol, name and logo, and
`verified`, true for a vouched mint or one Jupiter marks verified. A symbol is
free text on chain and a fake "USDC" is a known scam: show an unverified token
as unverified and keep `mint` visible. `amount_usd` is the plan's amount in
dollars at the latest price Mesub knows, a decimal string to show beside the
amount, null when it knows none. An attempt's `amount_usd` is priced when it
was attempted, null until then.

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

A transaction lives about half a minute, the terms five:
`transaction_expires_at` says when it should run out, an estimate that errs
early. Have the terms signed first, then ask for the transaction when the
wallet is ready, and after a submit refused with `transaction_expired`:

```ts
const fresh = await mesub.subscriptions.transaction(subscription.id);
// fresh.terms.message is the text the wallet signed: its signature is still good.
// Another text is new terms: have the wallet sign them too.
```

It answers what `create` answers for the same subscription, reserves nothing,
and is refused with `not_awaiting_signature` once the subscription is signed
or expired. Always sign the transaction of the last call.

A `submit` or a confirm that settled nothing answers the subscription with a
`reason`, a sentence for a person, and a `reason_code` for your code
(`transaction_expired`, `nothing_landed`, ...): branch on `reason_code`, and
keep a default branch, since Mesub adds codes.

The signing code, what `create` answers, the refusals:
[Subscribe from your server](https://docs.mesub.io/docs/subscribe).

## Cancel, resume, close, pay now, and payments

Each action is two calls from your server with the wallet in between: your
server builds a transaction, the subscription's own wallet signs and sends it,
your server confirms with the signature.

| To                                            | Build        | Confirm                            |
| --------------------------------------------- | ------------ | ---------------------------------- |
| stop the renewals of a running one            | `cancel(id)` | `confirmCancel(id, { signature })` |
| take a cancellation back before its end       | `resume(id)` | `confirmResume(id, { signature })` |
| close one that is over, and get its rent back | `close(id)`  | `confirmClose(id, { signature })`  |

Whether `close` can work now is on every subscription and access answer:
`closable`, and `closable_from`, the date it can when not yet (null when no
date is known: a running one is cancelled first). A subscription stopped
because the wallet closed its approval for good (`stop_reason`
`authority_closed`) can be closed at once, and cannot come back. An access
answer names its subscription in `subscription_id`, so you can act on it
without listing first.

A late payment is paid now in one call, with nothing to sign: `retry(id)`,
shown to your customer as "Pay now". Mesub answers the subscription, still
`unpaid`: the outcome comes with the pull, as the `subscription.renewed` or
`subscription.payment_failed` webhook. It refuses with an `apiCode` when paying
cannot succeed, so no retry is spent for nothing: `insufficient_balance` (top
up first), `retry_cannot_succeed` (the wallet no longer approves it, its token
account is frozen, or its authority is closed), `retry_too_soon` (`retryAfter`
says when). Two refusals are `retryable`: `subscription_changed` (two retries
met, or a pull moved it on) and, on Free, `pull_running` (a pull runs now).
Read the subscription back before you ask again. Sent once, never retried.

```ts
await mesub.subscriptions.retrieve(id);
await mesub.subscriptions.list({ external_id: user.id }); // { data, has_more }
const { data, paid } = await mesub.subscriptions.attempts(id); // its charges, and the total paid
```

`listAll` and `allAttempts` walk every page. The steps, the refusals and what
an attempt carries: [Manage from your server](https://docs.mesub.io/docs/manage).

## Show a subscription's situation

`explain` turns an access answer or a subscription into the words Mesub uses
everywhere: one sentence for the subscriber, one for you, the access line,
and what each of you can do now. Show these rather than your own: a late
payment the wallet cannot fix by adding funds reads differently from one it
can.

```ts
import { explain } from '@mesub/node'; // or '@mesub/node/situations' in a page

const answer = await mesub.access({ external_id: user.id }, 'pro');
const { key, subscriber, access, actions } = explain(answer, {
    names: { plan: 'Pro', merchant: 'Acme', amount: '9.99 USDC', token: 'USDC' },
});
// key "unpaid_approval_revoked"
// subscriber "Mesub could not take your payment of 9.99 USDC: your wallet no longer approves it (...)"
// access "No access"
// actions [{ by: 'subscriber', action: 'cancel', sdk: 'subscriptions.cancel', confirm: 'Cancel Pro? ...' }]
```

`names` fills what neither answer carries; a placeholder left without a value
stays as `{amount}` and is listed in `missing`. Dates are written as Mesub
serves them, in ISO 8601, unless you pass `formatDate`. A status or a reason
newer than this release gives `key: 'unknown'` and the access line, never an
error. A blocked subscription has its own keys, `blocked_mesub` and one per
cause of your setup (`blocked_puller_not_allowed`, ...): the subscriber reads
that nothing is theirs to do, you read what to fix.

`close` is offered only while Mesub says the subscription is `closable`, and
the sentence names `closable_from` when it can be closed later. A
subscription stopped for good (`stop_reason` `authority_closed`) reads
`stopped_authority_closed`: no comeback, only the close.
`@mesub/node/situations` imports nothing of Node, so your pages can use
it too; `SITUATIONS` is the whole table.

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
| `POST /subscriptions/:id/transaction`                        | A fresh transaction for it, and its terms.  |
| `POST /subscriptions/:id/submit`                             | Sends what the wallet signed.               |
| `POST /subscriptions/:id/cancel`, `/resume`, `/close`        | The transaction the wallet signs and sends. |
| `POST /subscriptions/:id/cancel/confirm`, and the two others | Confirms it with its signature.             |

`GET /plans/:slug` is public, so the routes answer it from your project's
plan list, kept in memory for 60 seconds: one call to Mesub a minute at most,
whatever the slugs asked, and a slug you do not have costs none. A change to a
plan shows there within a minute. `mesub.plans.list` and `mesub.plans.retrieve`
themselves are never cached.

A refusal is `{ error: { code, message } }`. A 401 always means nobody is
signed in on your site. Mesub refusing your API key (missing, wrong or
rotated) is thrown to your framework, which logs it and answers 500, never
handed to the browser as a 401. The widget's side:
[React widget](https://docs.mesub.io/docs/react).

Under Express, `requirePlan` and `mesubRoutes` hand such an error to
`next(err)`, and Express's own handler answers an error's `status`. So one
Mesub answered with a 4xx (a refused key, an unknown plan) reaches your error
handler as a `MesubError` with the same `code` and `apiCode` and a `status`
of 500, the original, with Mesub's status, as its `cause`: with no error
handler of yours, Express answers 500.

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
        if (!(error instanceof MesubError)) throw error;
        // Not Mesub's, or not now: refuse it.
        if (error.code === 'invalid_webhook') return res.status(400).end();
        // Mesub signed it, but this release cannot read it: update @mesub/node.
        console.error(error);
        return res.status(500).end();
    }

    if (event.test) return res.status(200).end(); // sent from the dashboard
    if (await alreadyHandled(event.delivery_id)) return res.status(200).end();
    // event.type, event.data (the subscription), event.detail
    res.status(200).end();
});
```

In a Next route handler: `await verifyWebhook(await request.text(),
request.headers)`.

Answer 400 only for `invalid_webhook`. An `unexpected` error is a body Mesub
signed that this release cannot read: log it, and answer a 5xx. Mesub then
retries the same body for 3 days, so the event still gets through once you
update `@mesub/node`; a 2xx would lose it. After 3 days of failures, Mesub
disables the endpoint.

`event.delivery_id` is the `webhook-id` header: one per event and per
endpoint, the same on every retry and resend. Drop a delivery you already
handled by it. `event.id` is the event's own, the same for every endpoint:
deduplicate on it across endpoints, and read the event again with
`events.retrieve(event.id)`. Deliveries can arrive out of order: `event.sequence`
numbers one subscription's events 1, 2, 3..., two events of one change
included. Apply them by `sequence`, and skip one lower than the last you
applied for that subscription. An event without `sequence` (written before
Mesub numbered events, or one it could not number) cannot be placed: read the
subscription now with `subscriptions.retrieve` or `access` rather than
applying its `data`.

`event.data` is the subscription as it stood right after the change, however
late the delivery; `event.detail` says what the event is about. A body Mesub
wrote before this shape, and retries as it was sent, is handed back in the
same shape: its detail at the top, and `id`, `network` and `api_version` null.

A body sent from the dashboard carries `test: true`, on a made-up subscription
(`sub_test`, `user_123`), whatever its `type`. Change nothing for it: `verify`
keeps the access cache as it is.

No `subscription.ended` comes when a cancellation reaches its end: the
subscription reads `ended` from its `access_until` on, and only
`subscription.access_revoked` says so, once the access events are on. A `subscription.renewed` can come late, on
a subscription that is no longer `active`. The events, their bodies and how to
test: [Webhooks](https://docs.mesub.io/docs/webhooks).

`subscription.renewal_upcoming` comes once per period, in its last quarter and
three days before the charge at most. Its detail says whether the wallet, as
Mesub just read it, can pay: a reading, not a promise.

```ts
if (event.type === 'subscription.renewal_upcoming' && !event.detail.can_pay) {
    // renewal_issue: 'balance' (add funds) or 'authority' (the approval is gone)
    await remind(event.data.external_id, event.detail.renewal_issue);
}
```

It changes no access, so `verify` leaves the access cache as it is for it.

### Drive access from the access events

`subscription.access_granted` and `subscription.access_revoked` are sent
exactly when the access a subscription grants changes, whatever made it
change, a date passing included: the first access, a payment that gives it
back, the end of a cancellation, of a paid period or of the plan. One event
per change, never two; a renewal paid on time, or a resume while the period
runs, sends neither. Keep your customer's access from these two alone; the
other events say why.

**They are off until Mesub turns them on**: Mesub is not sending them yet. Until then,
`hasAccess` (or the guards) stays the way to know, and the other events say
what changed.

```ts
switch (event.type) {
    case 'subscription.access_granted':
    case 'subscription.access_revoked': {
        const { id, access, external_id } = event.data;
        if (event.sequence === undefined) {
            // Cannot be placed: read the state now.
            await setAccess(id, external_id, (await mesub.subscriptions.retrieve(id)).access);
            break;
        }
        // Apply only what is newer than the last event applied for it.
        if (event.sequence <= ((await lastSequence(id)) ?? 0)) break;
        await setAccess(id, external_id, access, event.sequence);
        break;
    }
    // The other events say why: payment_failed, stopped, cancelled...
}
```

`data.access` is true on `access_granted`, false on `access_revoked`.
`event.detail.changed_at` is when access changed: a date that passed with
nothing else happening is that date to the millisecond, even when the event
was written a few seconds later, its `created_at`. `verify` drops the access
answers cached for the customer on both.

### Catch up on missed events

Mesub keeps the last 30 days of events, each the very body its webhooks
carried. Read them after an endpoint was down or turned off:

```ts
const { data, has_more, available_since } = await mesub.events.list({
    type: 'subscription.payment_failed', // optional
    subscription: id, // optional
    limit: 100, // 1 to 100, 25 by default
});
for (const event of data) await handle(event); // the same shape as a webhook's

const one = await mesub.events.retrieve(eventId); // the id a webhook body carried
```

Newest first, and within one millisecond by `sequence`, highest first; page
with `starting_after` set to the last id. Events before
`available_since` are not served. An event can appear a moment after its
`created_at`, so when polling, page on until `created_at` is a minute older
than the newest you held, and skip the ids you have seen.

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
| `rate_limited`    | 429, after the retries, or a quota on create (`pending_cap_reached`)    |
| `unavailable`     | 5xx, a timeout or a network error, after the retries                    |
| `invalid_webhook` | a webhook that fails verification: signature, headers or timestamp      |
| `unexpected`      | any other status, or an answer that is not Mesub's: is `baseUrl` right? |

It also carries `apiCode`, Mesub's own finer code (`already_subscribed`,
`close_too_early`, ...), `retryable`, `retryAfter` in milliseconds, the
parsed `body`, and `requestId`, the id Mesub gave the request
(`Mesub-Request-Id`): log it, and quote it to Mesub support. New codes are added: keep a default branch. Every code:
[Errors](https://docs.mesub.io/reference/errors).

`pending_cap_reached` is a quota, not a rate: too many subscriptions wait for
a signature. `create` is never retried for it, and `retryAfter` says when the
oldest stops counting, up to an hour. Do not hold a request that long.

Reads time out after 5 s and are retried twice. `create`, `transaction` and
the six manage calls are sent once and never retried.

## Test your integration

`@mesub/node/testing` is a fake Mesub for your own tests: no network, no Mesub
account, and nothing of it in your production bundle.

```ts
import { FakeMesub } from '@mesub/node/testing';

const fake = new FakeMesub();
const mesub = fake.client(); // a real Mesub, wired to the fake

fake.grant({ external_id: 'user_42' }, 'pro');
await mesub.hasAccess({ external_id: 'user_42' }, 'pro'); // true

fake.grantLastPeriod({ external_id: 'user_7' }, 'pro', endsAt); // access until the plan ends
fake.endPlan('pro'); // the end passed: what is held on it ends with plan_ended

fake.grant({ external_id: 'user_9' }, 'pro', {
    blocked_since: new Date().toISOString(), // charges blocked, access still on
    blocked_reason: 'puller_not_allowed',
});

// A plan is in verified USDC unless told: here an unverified token, no symbol, no price.
new FakeMesub({ plans: ['pro', { slug: 'bonk', mint, token: { name: 'Bonk' } }] });

fake.fail('outage'); // every call answers 503, until fail(null)
const { body, headers } = await fake.webhook('subscription.renewed'); // signed
fake.addEvent('subscription.payment_failed', { subscription: { id } }); // on /v1/events
fake.addEvent('subscription.access_revoked', { subscription: { id }, sequence: 5 });
fake.reset(); // between tests
```

Every event the fake signs or serves carries the next `sequence` of its
subscription (`sequence: null` leaves it out). The access events are off by
default, as on Mesub: `new FakeMesub({ accessEvents: true })` raises
`subscription.access_granted` after the `subscription.created` of a submit,
one `sequence` later, and an access event after any other change of the fake
that flips access. `addEvent` and `webhook` make either type whatever this says.

As on Mesub, a client keeps a yes up to five minutes: a change shows to a new
`fake.client()`, or on the next call with `new FakeMesub({ revalidateAfter: 0 })`.

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
import { Mesub } from '@mesub/node';

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
import { type AccessAnswer, type AccessList, type CacheStore, Mesub } from '@mesub/node';

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
you to a newer version. Mesub reads it. A version Mesub no longer serves is
refused with a 400 (`invalid_request`, `apiCode` `unsupported_version`), and
every call throws, guards included. Mesub keeps a version while releases that
send it are in use.

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

`pnpm test` also holds what the fake serves to the back's own contract,
`openapi/v1.json`, copied to `test/fixtures/openapi-v1.json` from the commit
named in `test/openapi.spec.ts`. When the back's contract moves, copy it
again and move the commit.

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
