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
- Calls for the same answer share one request in flight: while one is out
  for a customer and plan (or a customer's list), `access`, `hasAccess`,
  `decide` and `accessList` wait for its answer, or its error, instead of
  each sending their own. Guards share only with guards (#71).

### Options

- `new Mesub()` checks its options and throws a `TypeError` naming the wrong
  one: a `baseUrl` that is not https (plain http only to localhost), a
  timeout that is not a finite number of milliseconds above 0, a negative
  `maxRetries` or `maxStaleMs`, the publishable `PUB_` key instead of the
  secret `SUB_` one (#62).
- A `baseUrl` may carry a path, for a proxy: the API and the public keys are
  both read under it. `issuer` says what a token's `iss` must be, the
  `baseUrl` by default; `headers` adds headers to every call, the public keys
  included, such as a Cloudflare Access service token (#63).
- Every call sends `Mesub-Version`, the API version the release was written
  against, exported as `API_VERSION` (#64).

### Guards

- `requirePlan` for Express, `withMesub` for Next route handlers, the
  `RequirePlan` guard and `@MesubAccess()` decorator for NestJS (#15, #16,
  #20).
- A guard answers within a time budget when Mesub is slow, and answers 503,
  not 402, for a wallet it never saw while Mesub fails (#26).
- A guard takes a plan, a list of which any one will do, or a function of the
  request giving either; `mesub.plan` says which one let the request through.
  3 plans at most per guard, each one a call to Mesub; a function runs only
  once the token verifies (#74).
- A guard never retries a 429: it falls back at once, on the last answer it
  knew or a 503 (#71).
- The guards try the bearer, then the `mesub-token` cookie: a bearer of your
  own (your session JWT) no longer hides the cookie. The `token` option says
  where else the token travels, and is then the only place looked at (#72).
- An async `onDenied` is awaited: what it throws or rejects with goes where
  an integration error goes, `next(err)` under Express 4 as under 5, thrown
  in Next and Nest. In Nest, an exception it throws after an `await` is the
  one answered, not the default refusal (#73).

### Access tokens

- `verifyToken` checks a Mesub access token against the project's JWKS
  (ES256): signature, expiry, audience and issuer (#14).
- A project id missing from `/v1/project` is refused before any token is
  verified; malformed tokens and claims throw `invalid_token` (#52, #55).

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
- POST requests are never retried blindly, and take a per-call `timeout` and
  `signal` (#58).

### Testing your integration

- `@mesub/node/testing` exports `FakeMesub`, a fake Mesub behind a `fetch`:
  `grant`, `deny` and `setAccess` set its answers, `client()` gives a real
  `Mesub` wired to it, `token()` a token the guards accept, `fail()` an
  outage or any error, `requests` what it received. Nothing of it reaches
  the other entries (#65).

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
