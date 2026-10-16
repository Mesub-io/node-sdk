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
- The answer carries `blocked_since` and `blocked_reason`, both null unless
  every charge is blocked for a reason that is not the subscriber's
  (Mesub-io/backend#398): `mesub`, or the plan's own setup by name,
  `puller_not_allowed`, `receiver_not_allowed`, `receiver_account_missing`,
  `mint_gone`. `status` and `payment_status` do not move for it; `access`
  ends at `access_until`. A subscription carries both too, from `retrieve`,
  `list`, `submit` and in a webhook's `data`. Read as null from a Mesub that
  predates them; `BlockedReason` is exported (#128).
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
- `end_reason` can be `closed_elsewhere`: the subscription's account was
  closed outside Mesub (Mesub-io/backend#476). Mesub served
  `authority_closed` for it before; `EndReason` has both, read the same way,
  and the old one goes once no Mesub serves it. `authority_closed` stays a
  `late_reason`, a different fact. An attempt's `reason` is snake case
  (`insufficient_balance`, Mesub-io/backend#475) and stays an open string:
  its JSDoc names the `program_${number}` and `solana_${number}` families.
  Two `apiCode`s are renamed: `plan_deleted` is `plan_removed`, and
  `plan_rebuilt` is `plan_replaced`; branch on both until every Mesub serves
  the new ones (#144).
- The answer carries `subscription_id`, the subscription it is about, to
  `cancel`, `close` or `retry` without listing first (null with `status`
  `none`, Mesub-io/backend#469); `stop_reason`, why a `stopped` one stopped:
  `out_of_retries`, `retry_deadline_passed` or `authority_closed`, typed as
  `StopReason` (Mesub-io/backend#402); `late_reason` on a `stopped` one too,
  for the payment it stopped on; and `closable` and `closable_from`, whether
  the subscriber can close it now to get its deposit back, and from when if
  not yet. A subscription carries `stop_reason`, `closable` and
  `closable_from` too. All are read as null, and `closable` as false, from a
  Mesub that predates them (#146).

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
  against, exported as `API_VERSION` (#64). Mesub reads it: a version it no
  longer serves is a 400, `unsupported_version` (#135).

### Plans

- `plans.list()` and `plans.retrieve(slug)` read your project's plans for a
  pricing page: price, period, token, and whether each takes new subscribers
  (#84).
- A plan carries `token`, what Mesub resolved for its mint (`symbol`, `name`,
  `logo_url`, `verified`), and `amount_usd`, its amount in dollars at the
  latest price Mesub knows, a decimal string, null when it knows none
  (Mesub-io/backend#433). `verified` is true for a mint Mesub vouches for or
  one Jupiter marks verified. A symbol is free text on chain and a fake
  "USDC" is a known scam: show an unverified token as unverified, with its
  mint; Mesub never serves one under the symbol or name of a vouched
  stablecoin. The top-level `symbol` is unchanged: set only for a vouched
  mint. Read as an unverified token with nothing known and `amount_usd: null`
  from a Mesub that predates them; `PlanToken` is exported (#130).
- A plan slug needs at least one letter, as Mesub requires: `retrieve('123')`
  throws `invalid_request` before anything is sent, the widget routes answer
  `GET /plans/123` 404 without a call, and `mesubRoutes({ plans: ['123'] })`
  throws (#136).

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
- During an outage, a blocked subscription (`blocked_since`) keeps the
  fallback only until its `access_until`, as Mesub does: the retry Mesub keeps
  scheduling used to keep it in for up to `maxStaleMs`. A cache store that
  hangs no longer holds a guard: a `get` not answered within `guardTimeout`
  is a miss, and no answer waits for a `set`. A guard's 503 carries the
  `Retry-After` Mesub sent, 30 s only when it sent none, and `Decision` gets
  `retryAfter` (#132).

### Subscribing from your server

- `subscriptions.create`, `submit`, `retrieve`, `list` and `listAll`, over
  `/v1/subscriptions` (#61).
- `subscriptions.transaction(id)` answers a fresh transaction for a
  subscription still `pending`, with the terms it names, over
  `POST /v1/subscriptions/:id/transaction` (Mesub-io/backend#427): what to
  call when the wallet is ready to sign, and after a submit refused with
  `transaction_expired`, rather than `create` again. The terms signature held
  stays good while `terms.message` is the text the wallet signed. Sent once,
  never retried (#128).
- `subscriptions.attempts(id, { limit, starting_after })` answers a
  subscription's own pull attempts, newest first, each with its `id`, `retry`,
  `retry_number`, `retries_allowed` and `period_start`, and `paid`, how many
  were paid and how much since it began, counted by Mesub over all of them.
  `allAttempts` walks every page. A subscription carries `next_retry_number`
  and `retries_allowed`: the retry due at `next_retry_at` and out of how many,
  null when Mesub retries nothing on its own. Both are read as null from a
  Mesub that predates them. Needs Mesub-io/backend#290 (#91).
- An attempt carries `amount_usd`, its amount in dollars at the price of the
  instant it was attempted, a decimal string: null until Mesub priced it, and
  from a Mesub that predates it (Mesub-io/backend#433) (#130).
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
- A subscription id is checked as Mesub writes them, letters, digits, `-`
  and `_`, 64 at most, before any method builds a path with it: anything else
  throws `invalid_request` and sends nothing. `retrieve('.')` asked the list
  and `cancel('..')` reached `POST /v1/cancel` (#136).
- What `create`, `transaction`, `cancel`, `resume` and `close` answer carries
  `transaction_expires_at`, when `last_valid_block_height` is expected to
  pass, about half a minute ahead (Mesub-io/backend#471): an estimate that
  errs early, for a countdown or to ask for a fresh transaction in time. Null
  from a Mesub that predates it (#146).
- A `submit` or a confirm that settled nothing carries `reason_code` beside
  `reason` (Mesub-io/backend#470): `transaction_expired`, `nothing_landed`,
  `cancellation_not_landed`, ... Branch on it, never on `reason`, which Mesub
  may reword. An open family, typed as `ConfirmReasonCode`: a code newer than
  this release is handed on, and a Mesub that predates it sends `reason`
  alone (#146).

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
- Five situations for a subscription whose charges are blocked, read before
  the end or late reason on an `active` or `unpaid` one: `blocked_mesub`, and
  `blocked_puller_not_allowed`, `blocked_receiver_not_allowed`,
  `blocked_receiver_account_missing` and `blocked_mint_gone` for the plan's
  setup. The subscriber reads that nothing is theirs to do, the merchant
  what to fix, and both when access ends. A blocked one whose access ended
  no longer reads `ended_plan_ended` (#128).
- `blocked_mint_gone` no longer says access comes back with the first payment
  that goes through: the token no longer exists, so no payment can. Both
  sentences say access does not come back once it ends (#136).
- `pending` offers `transaction` before `submit`
  (`subscriptions.transaction`, `POST /v1/subscriptions/:id/transaction`): a
  fresh transaction when the wallet is ready to sign, or after
  `transaction_expired`. `SituationActionId` gains `transaction` (#136).
- `blocked_reason` can be `receiver_account_frozen`: the token account of the
  wallet that receives the plan's payments is frozen (Mesub-io/backend#395).
  `BlockedReason` has it, and `explain()` reads it as
  `blocked_receiver_account_frozen`: the subscriber reads that nothing is
  theirs to do, the merchant to choose another receiving wallet or ask the
  token's issuer to unfreeze that account (#133).
- `explain()` reads `end_reason` `closed_elsewhere` as
  `ended_authority_closed`, the situation `authority_closed` has: the key
  keeps the old word, so code that branches on it does not change (#144).
- A stopped subscription whose `stop_reason` is `authority_closed` reads
  `stopped_authority_closed`, a new key: nobody can charge it again and it
  cannot be restarted, so the only action is `close`. It read `stopped` and
  offered to subscribe again, which Mesub refuses over it
  (`subscription_stopped`). `stopped` fills `{stop_cause}` from `stop_reason`
  (`out_of_retries`, `retry_deadline_passed`); a stop reason newer than this
  release reads `unknown` (#146).
- `closable` decides `close`: it is offered only where Mesub says the
  subscription can be closed now, and `{closable_from}` dates it in the
  sentence when it cannot yet. `ended_plan_removed`, `ended_plan_replaced`
  and `ended_plan_ended` offer `close` (Mesub closes them since
  Mesub-io/backend#344), with a new confirmation, `confirm_close_over`, that
  does not promise a new subscription; `stopped` offers it once `closable`.
  `ended_plan_removed` no longer tells the merchant that Mesub cannot close
  it (#146).

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

- `POST /subscriptions/:id/transaction` answers a fresh transaction for the
  signed-in customer's pending subscription, 201 and the body
  `POST /subscriptions` answers; any other customer's is a 404 (#128).
- `GET /plans/:slug` hands on the plan's `token` and `amount_usd`, and each
  of `payments` its `amount_usd`, null from a Mesub that does not price it
  (#130).
- `upcoming` carries `amount_usd`, the plan's amount in dollars at the latest
  price Mesub knows, null when it knows none or the plan could not be read
  (#136).
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
- The fake's `subscription.payment_failed` and `subscription.stopped` carry
  `insufficient_balance`, snake case as Mesub sends it (#144).
- A verified event drops every access answer cached for its customer, the
  yes too: after `subscription.stopped` or `subscription.ended`, `hasAccess`
  says no at once instead of the cached yes for up to five minutes (#84).
- `subscription.renewal_upcoming` is typed: `SubscriptionRenewalUpcomingEvent`,
  whose detail (`RenewalUpcomingDetail`) says whether the coming charge can
  pay and, when it cannot, why (`RenewalIssue`). Its detail is checked,
  `fake.webhook` makes one, and verifying it drops no cached answer: it moves
  no access (#121).
- A webhook sent by hand from the dashboard carries `test: true`, now typed
  on every event. The dashboard sends one for any event type, on a made-up
  subscription. `verify` drops no cached answer for it (#135).
- The README's webhook handler answers 400 only for `invalid_webhook`. For
  `unexpected`, a body Mesub signed that this release cannot read, it logs
  and answers 500: Mesub retries it, and it gets through once you update.
  `id` is documented as the delivery id, one per endpoint. No event comes
  when a cancellation reaches its end, and `subscription.renewed` can come
  late (#135).
- **Breaking.** `event.id` is the event's own id (Mesub-io/backend#482), the
  same for every endpoint and every retry, the one `events.retrieve` takes.
  The `webhook-id` header, which `event.id` was until now, is
  `event.delivery_id`: deduplicate a delivery on it, or an event across
  endpoints on `id`. `event.detail` moved to the top of the event, out of
  `event.data`, which is the subscription alone; the event also carries
  `object`, `network` and `api_version`. A body written before the event
  shape, and kept as it was sent, is handed back in the same shape: its
  detail at the top, and `id`, `network` and `api_version` null (#146).
- `mesub.events.list({ type, subscription, limit, starting_after })` and
  `mesub.events.retrieve(id)` read your project's events of the last 30
  days over `GET /v1/events` (Mesub-io/backend#482), each the very body its
  webhooks carried, to catch up on what an endpoint missed. A page carries
  `available_since`: events before it are not served. Typed as `MesubEvent`
  and `EventList`; a Mesub that predates the route throws a `not_found`
  whose `apiCode` is null (#146).
- Every event carries `sequence` (Mesub-io/backend#502), its place among its
  subscription's events: apply one subscription's events by `sequence`, and
  skip one lower than the last applied. Optional: absent on a body written
  before Mesub numbered events and on one it could not number, which cannot
  be placed (read the subscription instead). One that is not a whole number
  from 1 throws `unexpected` (#149).
- `subscription.access_granted` and `subscription.access_revoked` are typed
  (Mesub-io/backend#507): `SubscriptionAccessGrantedEvent`,
  `SubscriptionAccessRevokedEvent`, and their detail `AccessChangedDetail`,
  `changed_at`, checked to be a date. Sent exactly when access changes, a date
  passing included, they are the pair to drive access from, ordered by
  `sequence`; `data` carries `access`, `access_until`, `blocked_since` and
  `blocked_reason`. `events.list` takes them as a `type`, and `verify` drops
  the cached answers for their customer. Off until Mesub turns them on
  (#149).

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
- `FakeMesub` answers `subscriptions.transaction` for a pending
  subscription, with the terms `create` gave it, and refuses any other
  (`not_awaiting_signature`, `plan_ended`, `already_subscribed`). Its access
  answers, subscriptions and webhooks carry `blocked_since` and
  `blocked_reason`, null unless a test sets them (#128).
- `FakeMesub` plans carry `token` and `amount_usd`: USDC, verified and worth
  its `amount_display` by default. A plan declared with a `token` (some of
  its fields are enough) or a null `symbol` is unverified with no symbol and
  no dollar value unless told. An attempt of `setAttempts` is priced `9.99`,
  and not priced when given another `amount` and no `amount_usd` (#130).
- `FakeMesub` serves the `revalidate_after` Mesub does: 10 for a no, and for
  a yes the seconds to its next charge, retry or end, from 10 to 300; a list
  gets its soonest yes, or 10. A client keeps a yes up to five minutes, as
  against Mesub: `new FakeMesub({ revalidateAfter: 0 })` shows every change
  on the next call (#134).
- `FakeMesub` refuses as Mesub does. `create` and `transaction` beside a
  subscription the wallet holds answer by its status: `already_subscribed`,
  `subscription_cancelled` or `payment_pending`. `close` of a stopped
  subscription nobody cancelled answers `subscription_not_cancelled`, and
  one ended with its plan closes. A wallet that is not base58 (32 to 44
  characters) or an invalid email is a 400 `invalid_request` (#134).
- `FakeMesub` lists as Mesub does: no `superseded` subscription, and a 400
  for a `starting_after` it does not hold. An error's `retryable` follows its
  code, true for `subscription_changed` (#134).
- `FakeMesub` serves what Mesub-io/backend serves since #402, #469 to #472
  and #482: `subscription_id` on an answer about a subscription it holds,
  `stop_reason`, `closable` and `closable_from` worked out from what its
  close takes (a test may set them on an answer), `transaction_expires_at`,
  a `Mesub-Request-Id` on every answer and `request_id` in every error body.
  A stopped subscription whose authority closed closes at once, and refuses
  a comeback (`subscription_stopped`). It serves `/v1/events`: what its
  submits and confirms raise, and what `addEvent(type, fields)` records,
  within 30 days and from `eventsSince`. **Breaking:** `fake.webhook()`
  signs the event shape, with an `evt_fake_...` id; its `id` field is the
  event's, and `delivery_id` the `webhook-id` (#146).
- `FakeMesub` numbers each subscription's events from 1 (`sequence`, or
  `sequence: null` in `addEvent` and `webhook` to leave it out; 1 on the
  `test` event) and serves a millisecond's events by it, highest first.
  `addEvent` and `webhook` make `subscription.access_granted` and
  `subscription.access_revoked` with `detail.changed_at`, the revoked one on
  an ended subscription without access. `new FakeMesub({ accessEvents: true
})` raises `access_granted` after a submit's `created`, as Mesub with its
  `ACCESS_EVENTS` flag on; off by default. Held to Mesub-io/backend
  `openapi/v1.json` at c585920, each webhook against its own schema (#149).

### Errors

- Every failure is a `MesubError` with a stable `code`, the back's own
  `apiCode`, `retryable`, `status`, `body` and `retryAfter` (#60).
- A `MesubError` carries `requestId`, the id Mesub gave the request, from
  its `Mesub-Request-Id` header, or the error body's `request_id` when a
  proxy dropped the header (Mesub-io/backend#472): log it, and quote it to
  Mesub support. Null when no response came back (#146).
- Every answer is checked against the shape the SDK types before it is used
  or cached; anything else throws `unexpected` (#59).
- `subscriptions.create` checks `costs` field by field, `rent`, `fee` and
  `total`, as it is typed: amounts are whole numbers as strings, and
  `rent.authority` may be null (#101).
- An answer to `subscriptions.retry` it cannot read names
  `POST /v1/subscriptions/:id/retry` and status 202, no longer
  `GET /v1/subscriptions/:id` and 200 (#136).
- Whether a GET is sent again comes from Mesub's `retryable`, or the status
  without one: an `x-should-retry` header, which Mesub never sends, is no
  longer read (#136).
- The docs say when `retryAfter` comes on a 409 (`retry_too_soon`,
  `comeback_period_rolling`), and that `pending_cap_reached` is a quota, not
  a rate. `retry` lists `pull_running` and `subscription_changed`; `close`
  says which subscriptions Mesub closes. The README's snippets compile under
  `strict` (#135).

### Releases and CI

- Published from a version tag on main only, after a reviewer approves the
  `npm` environment, with npm provenance and no npm token stored (#18, #67).
- The contract test runs in CI against a back built from Mesub-io/backend,
  covering `/v1/access` by external id and email, `/v1/subscriptions` and
  `/v1/plans` (#66).
- Coverage is measured in CI, with a 90% floor (#68).
- Tested on Node 22 and 24, Express 4 and 5.
- What `FakeMesub` serves is checked, strictly, against the back's
  `openapi/v1.json`, copied to `test/fixtures` with the commit it came from:
  a field too many or one missing fails without a back running (#146).
