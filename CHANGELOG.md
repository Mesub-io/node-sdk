# Changelog

Every change a merchant using `@mesub/node` can notice. Versions follow
[semver](https://semver.org); while the major is 0, a minor version (0.2.0)
may break the API and a patch (0.1.1) never does. Pull request numbers are
those of Mesub-io/node-sdk.

## 0.1.0 (unreleased)

The first version published to npm. Requires Node 22 or later.

### Access

- `new Mesub({ apiKey })`, then `access(customer, plan)` for everything Mesub
  knows about a customer on a plan, `hasAccess` for a yes or no, and `decide`
  for what a guard does with it (#10, #13).
- A customer is a wallet, `{ external_id }` or `{ email }`: an email is
  trimmed and lowercased, an external id trimmed. `accessList(customer)` lists
  every plan they hold in one call. Asked by external id or email, `wallet`
  is null when they hold nothing on that plan (#57).
- Answers are cached for the `revalidate_after` Mesub sends, in memory (an LRU
  of 10 000) or in a store of yours such as Redis, scoped by a hash of the API
  key so projects sharing a store stay apart (#12, #26, #54).
- `CacheStore` gets an optional `delete`, so a store of two methods still
  compiles: the memory store and the README's Redis example implement it. A
  store without it gets an answer it should drop rewritten as stale instead
  (#70).
- When Mesub is down, the last answer is served for up to `maxStaleMs`
  (24 hours by default), never past its `access_until` (#26, #56).
- The answer carries `paused` (a seat parked over the project's cap: status
  unchanged, nothing charged, access to the end of the paid period) and
  `end_reason`, why an `ended` one ended: `cancelled`, `plan_removed`,
  `plan_replaced`, `plan_ended`, `authority_closed` or `closed`, typed as
  `EndReason`. A `cancelled` subscription reads `ended`, with `end_reason`
  `cancelled`, once its end date passed. An attempt's `outcome` may be
  `BLOCKED`: nothing was tried, and none of it the subscriber's doing. An
  API that predates the two fields is read as `paused: false` and
  `end_reason: null`, and a reason or an outcome newer than this release is
  handed back, not refused (#78).
- Calls for the same answer share one request in flight: while one is out
  for a customer and plan (or a customer's list), `access`, `hasAccess`,
  `decide` and `accessList` wait for its answer, or its error, instead of
  each sending their own. Guards share only with guards (#71).

### Options

- `new Mesub()` checks its options and throws a `TypeError` naming the wrong
  one: a `baseUrl` that is not https (plain http only to localhost), a
  timeout that is not a finite number of milliseconds above 0, a negative
  `maxRetries` or `maxStaleMs`, the publishable `PUB_` key instead of the
  API key, `SUB_` (#62).
- A `baseUrl` may carry a path, for a proxy: every call is made under it.
  `headers` adds headers to every call, such as a Cloudflare Access service
  token (#63).
- Every call sends `Mesub-Version`, the API version the release was written
  against, exported as `API_VERSION` (#64).

### Plans

- `plans.list()` and `plans.retrieve(slug)` read your project's plans for a
  pricing page: price, period, token, and whether each takes new subscribers
  (#84).

### Guards

- `requirePlan` for Express, `withMesub` for Next route handlers, the
  `RequirePlan` guard and `@MesubAccess()` decorator for NestJS (#15, #16,
  #20).
- Who is asking comes from `customer`, a function of the request returning
  who your own login says is signed in (`{ external_id }`, a wallet or
  `{ email }`, null for nobody, a 401). It is required: a guard built without
  it throws a `TypeError`. The route gets `mesub.customer`, who was asked
  about, and `mesub.wallet`, the wallet that pays as Mesub answered it (#79,
  #87).
- A guard answers within a time budget when Mesub is slow, and answers 503,
  not 402, for a customer it never saw while Mesub fails (#26).
- A guard takes a plan, a list of which any one will do, or a function of the
  request giving either; `mesub.plan` says which one let the request through.
  3 plans at most per guard, each one a call to Mesub; a function runs only
  once `customer` named somebody (#74).
- A guard never retries a 429: it falls back at once, on the last answer it
  knew or a 503 (#71).
- `RequirePlan<YourRequest>(...)` for NestJS: name your request type to read
  `req.user` in `customer` and `onDenied` without a cast (#84).
- An async `onDenied` is awaited: what it throws or rejects with goes where
  an integration error goes, `next(err)` under Express 4 as under 5, thrown
  in Next and Nest. In Nest, an exception it throws after an `await` is the
  one answered, not the default refusal (#73).

### Subscribing from your server

- `subscriptions.create`, `submit`, `retrieve`, `list` and `listAll`, over
  `/v1/subscriptions` (#61).
- `submit` sends the same request again when a send got no answer, three
  sends at most within its `budget`, then reads the subscription back rather
  than guessing its outcome; a `MesubSubmitError` carries what it found (#61).
- Once `submit`, `retrieve` or `list` answer a subscription with access
  (`active`, or `cancelled` before its end), the cached answers that still
  say no for its wallet, external id and email are dropped, for its plan and
  in `accessList`: `hasAccess` right after asks Mesub again (#70).
- A subscription carries `paused` and `end_reason` as `/v1/access` answers
  them, from `retrieve`, `list`, `submit` and in a webhook's `data`, with
  the same defaults from an API that predates them (#78).
- POST requests are never retried blindly, and take a per-call `timeout` and
  `signal` (#58).
- `subscriptions.cancel`, `resume` and `close` build the transaction the
  subscription's wallet signs and sends in your front, and `confirmCancel`,
  `confirmResume` and `confirmClose` settle it by its signature, over
  `/v1/subscriptions/:id` with the API key (Mesub-io/backend#276): no Mesub
  account and nothing of `@mesub/react`. Each is sent once; a confirm waits
  90 s by default and answers the subscription, with Mesub's `reason` when
  nothing changed. A confirm that settled drops every cached access answer
  for that customer on that plan, the yes too (#50).

### Routes for the React widget

- `mesubRoutes` (Express, and Nest through `app.use`) and
  `mesubRouteHandlers` (Next) serve what `@mesub/react` calls: a plan, the
  customer's subscriptions, and each step of subscribing, cancelling, resuming
  and closing. Who is asking comes from your own auth through `customer`; a
  subscription that is not theirs answers 404 (#86).

### Webhooks

- `mesub.webhooks.verify(body, headers)`, or `verifyWebhook` without a
  client, checks a webhook Mesub sent (Standard Webhooks): the HMAC-SHA256
  signature over the raw body in constant time, any one of several
  signatures, a timestamp within 5 minutes (`tolerance`). It hands back the
  event, typed by `type`, its subscription and detail checked, and `id`, the
  `webhook-id` to drop duplicates by. The secret is `webhookSecret`,
  `MESUB_WEBHOOK_SECRET` by default, or `secret` per call. A failure throws
  `invalid_webhook`; a verified event that grants access drops the cached no
  (#77).
- `@mesub/node/testing`: `fake.webhook(type)` makes a signed delivery the
  fake's client verifies; `signWebhook` signs a body of your own (#77).
- A verified event drops every access answer cached for its customer, the
  yes too: after `subscription.stopped` or `subscription.ended`, `hasAccess`
  says no at once instead of the cached yes for up to five minutes (#84).

### Testing your integration

- `@mesub/node/testing` exports `FakeMesub`, a fake Mesub behind a `fetch`:
  `grant`, `deny` and `setAccess` set its answers, `client()` gives a real
  `Mesub` wired to it, `fail()` an outage or any error, `requests` what it
  received. Nothing of it reaches the other entries (#65).
- `FakeMesub` answers cancel, resume and close and their confirms, which
  land at once: the subscription and its access answers move, and a step the
  status does not allow is refused with Mesub's code (#50).

### Errors

- Every failure is a `MesubError` with a stable `code`, the back's own
  `apiCode`, `retryable`, `status`, `body` and `retryAfter` (#60).
- Every answer is checked against the shape the SDK types before it is used
  or cached; anything else throws `unexpected` (#59).

### Releases and CI

- Published from a version tag on main only, after a reviewer approves the
  `npm` environment, with npm provenance and no npm token stored (#18, #67).
- The contract test runs in CI against a back built from Mesub-io/backend,
  covering `/v1/access` by external id and email, `/v1/subscriptions` and
  `/v1/plans` (#66).
- Coverage is measured in CI, with a 90% floor (#68).
- Tested on Node 22 and 24, Express 4 and 5.
