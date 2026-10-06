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
  (24 hours by default), never past its `access_until` (#26, #56) unless a
  renewal is ahead. A plan's last period has none, so it stops there (#124).
- A plan with an end date: nobody has access past it, and `access_until` is
  never later than it. In the last period `next_charge_at` is null, and
  `next_retry_at` on a late one, with `next_retry_number` and
  `retries_allowed`; `retry_deadline` can be the plan's end. For a few minutes
  past the end `status` can still read `active` or `unpaid` with
  `access: false`: a guard reads `access`, never `status`. Nothing changes in
  what is accepted: these fields were nullable already (#124).
- The answer carries `paused` (a seat parked over the project's cap: status
  unchanged, nothing charged, access to the end of the paid period) and
  `end_reason`, why an `ended` one ended: `cancelled`, `plan_removed`,
  `plan_replaced`, `plan_ended`, `authority_closed` or `closed`, typed as
  `EndReason`. A `cancelled` subscription reads `ended`, with `end_reason`
  `cancelled`, once its end date passed. An attempt's `outcome` is lowercase,
  like every state on `/v1` (Mesub-io/backend#321): `paid`, `skipped`,
  `rejected` or `blocked`, where `blocked` means nothing was tried, and none of
  it the subscriber's doing. An
  API that predates the two fields is read as `paused: false` and
  `end_reason: null`, and a reason or an outcome newer than this release is
  handed back, not refused (#78).
- The answer carries `late_reason`, why an `unpaid` one is late:
  `insufficient_balance` (adding funds fixes it), `approval_revoked` (it does
  not: Mesub's approval on the token account was revoked or replaced) or
  `authority_closed`, typed as `LateReason`; null on any other status. A
  subscription and a webhook's `data` carry it too. Required: an answer
  without it is refused as `unexpected` (#109).
- Calls for the same answer share one request in flight: while one is out
  for a customer and plan (or a customer's list), `access`, `hasAccess`,
  `decide` and `accessList` wait for its answer, or its error, instead of
  each sending their own. Guards share only with guards (#71).

### Options

- `new Mesub()` checks its options and throws a `TypeError` naming the wrong
  one: a `baseUrl` that is not https (plain http only to localhost), a
  timeout that is not a finite number of milliseconds above 0, a negative
  `maxRetries` or `maxStaleMs`, a missing API key (#62).
- The check that refused a publishable `PUB_` key is removed: Mesub has no
  such key any more. Any non-empty API key is accepted, and a wrong one is
  answered 401 by Mesub, thrown as `unauthorized` (#96).
- Three options that were taken and then misbehaved now throw a `TypeError`:
  a per-call `timeout` that is not a number of milliseconds above 0 (`NaN`
  or `0` cut the call at once), checked as the client's own before anything
  is sent; a `tolerance` of 0 in `webhooks.verify` and `verifyWebhook` (it
  refused every webhook); a `maxEntries` of `MemoryStore` that is not a whole
  number above 0 (`NaN` left the store unbounded) (#101).
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
- Under Express, an integration error Mesub answered with a 4xx (a refused
  API key, an unknown plan) reaches `next(err)` as a `MesubError` of status
  500 with the same `code` and `apiCode`, the original as its `cause`.
  Express's own error handler answers an error's `status`: without a handler
  of yours, `requirePlan` and `mesubRoutes` answered Mesub's 401 or 404
  (#120).

### Subscribing from your server

- `subscriptions.create`, `submit`, `retrieve`, `list` and `listAll`, over
  `/v1/subscriptions` (#61).
- `subscriptions.attempts(id, { limit, starting_after })` answers a
  subscription's own pull attempts, newest first, each with its `id`, `retry`,
  `retry_number`, `retries_allowed` and `period_start`, and `paid`, how many
  were paid and how much since it began, counted by Mesub over all of them.
  `allAttempts` walks every page. A subscription carries `next_retry_number`
  and `retries_allowed`: the retry due at `next_retry_at` and out of how many,
  null when Mesub retries nothing on its own. Both are read as null from a
  Mesub that predates them. Needs Mesub-io/backend#290 (#91).
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

### Situations

- `explain(answer | subscription, { names, now, formatDate })` gives the
  situation's key, a sentence for the subscriber and one for the merchant,
  the access line, and the actions open now (who, the SDK method and route,
  the sentence to show before signing), from the canonical wording agreed
  with the backend. Chosen from `status`, then `paused`, then `end_reason` or
  `late_reason`; Free is read as a `retry_deadline` set. A status or reason
  newer than this release gives `unknown`, never an error. `SITUATIONS` is
  the table, also served by `@mesub/node/situations`, which imports nothing
  of Node so a page can use it (#116).
- Two situations for a plan with an end, read from what the end leaves on
  the answer: `active_last_period` (access with no charge ahead, where
  `active` announced a next payment with no date) and `unpaid_last_period`
  (late, on a tier that retries, with no retry ahead). In the minutes past
  the end, `active` or `unpaid` without access reads `ended_plan_ended`, and
  a paid up cancellation cut short reads `cancelled_ended`, not
  `cancelled_no_access` (#124).

### Routes for the React widget

- `mesubRoutes` (Express, and Nest through `app.use`) and
  `mesubRouteHandlers` (Next) serve what `@mesub/react` calls: a plan, the
  customer's subscriptions, and each step of subscribing, cancelling, resuming
  and closing. Who is asking comes from your own auth through `customer`; a
  subscription that is not theirs answers 404 (#86).
- `GET /subscriptions/:id` answers one subscription of the customer with what
  Mesub pulls next as `upcoming` (a retry carries `retry_number` and
  `retries_allowed`), its own pull attempts, newest first, as `payments`
  (date, outcome, amount, reason, transaction signature, `retry`,
  `retry_number`, `retries_allowed` and `period_start`, twenty at most), and
  `paid`, the count and the sum Mesub holds for every paid attempt since the
  subscription began. When they cannot be read, both are null and
  `payments_error` says why; the subscription is still answered. From a Mesub
  that does not serve the attempts route yet, the last five are read through
  `/v1/access` as before, with `paid: null`. In `@mesub/node/testing`,
  `fake.setAttempts(id, [...])` gives a subscription its attempts, and
  `attemptsRoute: false` acts as that older Mesub (#89, #91).
- A 2xx from Mesub that the SDK cannot read is answered as a 502
  `unexpected`, no longer with the 2xx it came with (#97).
- The routes read plans from your project's plan list, kept in memory for 60
  seconds per client: `GET /plans/:slug`, which is public, and the price of
  `upcoming` make one call to Mesub a minute at most, whatever the slugs
  asked, and a slug that is not in the list answers 404 `plan_not_found`
  without a call. A change to a plan shows within a minute. A failed read is
  not kept, and `plans.list` and `plans.retrieve` stay uncached (#98).

- `GET /subscriptions` reads the customer's subscriptions by pages of 100 and
  5 pages at most, so one browser request is never more than 5 calls to
  Mesub. It answers `has_more` beside `subscriptions`: true when the customer
  has more than the 500 newest, which are not read (#101).
- A refusal's `message` is Mesub's own only when Mesub worded it (an error
  with an `apiCode`). For any other, the browser reads `Mesub could not
answer this request.`: never the SDK's own message, which may name your
  `baseUrl` or a network error. `payments_error` the same. The `MesubError`
  your server catches is unchanged (#101).
- `mesubRouteHandlers` counts the 64 kB a body may weigh in bytes, as
  `mesubRoutes` does: it answers 413 on a `Content-Length` over it without
  reading, and stops reading at the limit otherwise (#101).
- The routes never hold a browser for Mesub: every read of one request (the
  plan list, a subscription, its attempts, a list, and the read before a
  submit, a cancel, a resume or a close) shares one deadline of 10 s, and a
  429 is handed on at once with its `Retry-After`, never waited out and
  retried. `submit` and the confirms keep their own timeouts, and the same
  methods called from your code keep the client's `timeout` and `maxRetries`
  (#99).
- Mesub refusing your API key (401 `missing_api_key` or `invalid_api_key`),
  or a 403 from something in front of Mesub, is thrown to your framework,
  which logs it and answers 500. It was handed to the browser as a 401, which
  `@mesub/react` reads as "nobody is signed in": every visitor got the
  sign-in screen. The routes' own 401, nobody signed in, is unchanged.

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
- `subscription.renewal_upcoming` is typed: `SubscriptionRenewalUpcomingEvent`,
  whose detail (`RenewalUpcomingDetail`) says whether the coming charge can
  pay and, when it cannot, why (`RenewalIssue`). Its detail is checked,
  `fake.webhook` makes one, and verifying it drops no cached answer: it moves
  no access (#121).

### Testing your integration

- `@mesub/node/testing` exports `FakeMesub`, a fake Mesub behind a `fetch`:
  `grant`, `deny` and `setAccess` set its answers, `client()` gives a real
  `Mesub` wired to it, `fail()` an outage or any error, `requests` what it
  received. Nothing of it reaches the other entries (#65).
- `FakeMesub` answers cancel, resume and close and their confirms, which
  land at once: the subscription and its access answers move, and a step the
  status does not allow is refused with Mesub's code (#50).
- `FakeMesub` models a plan with an end: `grantLastPeriod(customer, plan,
endsAt)` for an answer in its last period, `endPlan(plan)` to end what is
  held on it with `plan_ended`, and an `ends_at` in `plans`. Past its end a
  plan refuses everyone and takes no new subscriber (`plan_ended`), and
  before it no `access_until` or pull is served later than it (#124).
- `FakeMesub` keeps one checkout per customer on a wallet, as Mesub does
  since Mesub-io/backend#311: `create` again for the same plan, wallet and
  customer (`external_id`, else `email`) answers the same subscription,
  another customer gets its own, and once one lands the others on that
  wallet expire and a new `create` is refused `already_subscribed` (#100).

### Errors

- Every failure is a `MesubError` with a stable `code`, the back's own
  `apiCode`, `retryable`, `status`, `body` and `retryAfter` (#60).
- Every answer is checked against the shape the SDK types before it is used
  or cached; anything else throws `unexpected` (#59).
- `subscriptions.create` checks `costs` field by field, `rent`, `fee` and
  `total`, as it is typed: amounts are whole numbers as strings, and
  `rent.authority` may be null (#101).

### Releases and CI

- Published from a version tag on main only, after a reviewer approves the
  `npm` environment, with npm provenance and no npm token stored (#18, #67).
- The contract test runs in CI against a back built from Mesub-io/backend,
  covering `/v1/access` by external id and email, `/v1/subscriptions` and
  `/v1/plans` (#66).
- Coverage is measured in CI, with a 90% floor (#68).
- Tested on Node 22 and 24, Express 4 and 5.
