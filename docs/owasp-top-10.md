# The OWASP Top 10 checklist

A checklist that is checked. Every line of it is in
[`owasp.config.ts`](../owasp.config.ts), and
[`tests/unit/lint/owasp-checklist.test.ts`](../tests/unit/lint/owasp-checklist.test.ts)
resolves each one against this repository on every `pnpm test`: the source file
it names, the test file it cites, and the exact `it(…)` title inside that file.

| File                                      | Job                                                         |
| ----------------------------------------- | ----------------------------------------------------------- |
| `owasp.config.ts`                         | The checklist, as data. Ten categories, thirty-nine claims. |
| `scripts/owaspChecklist.ts`               | The rules a checklist has to satisfy. Pure functions.       |
| `tests/unit/lint/owasp-checklist.test.ts` | The gate: the rules, run against the filesystem.            |

## Why it is code

A security checklist written as prose is accurate on the day it is written and
decays silently afterwards. "CSRF: double-submit token, covered by
`tests/unit/server/csrf.test.ts`" reads exactly the same after the test is
renamed, after it is deleted, and after the middleware it covered is replaced.
That is worse than having no checklist at all, because it is evidence nobody has
to check — and the first time anyone finds out it was fiction is during the
incident it was supposed to have prevented.

So a claim here names its proof precisely enough to break. Citing the test
_file_ would survive the deletion of the only test that mattered, so each
mitigation names titles:

```ts
{
  id: 'csrf-origin-and-token',
  summary: 'A cross-origin page cannot make this app act on its user: …',
  implementation: ['server/middleware/20.csrf.ts', 'server/utils/csrf.ts', …],
  evidence: [
    {
      file: 'tests/unit/server/csrf-middleware.test.ts',
      tests: [
        'refuses a cross-origin write with 403 and a machine-readable reason',
        'refuses a same-site sibling, which SameSite=Lax would have let through',
        …
      ],
    },
  ],
}
```

Rename that test and the build fails here, in the line claiming it proves
something, rather than quietly turning that line into a lie.

## What the gate proves, and what it does not

It proves that every cited test exists, is named what the checklist says, and
lives where `vitest.config.ts` will actually collect it. It does not — and
cannot — prove that a cited test is a _good_ test. The value of a citation is
that a reviewer can open it in one keystroke; the value of the gate is that the
citation still points somewhere. Read the table as a map with working links, not
as an audit.

Three rules do the rest of the work:

- **The ten categories are pinned** to the published Top 10:2021, in rank order,
  under OWASP's own titles. A category cannot quietly leave the list because
  nothing was done about it.
- **An uncovered category must say so.** A category with no mitigations has to
  carry a `gap` explaining why, and a category with mitigations may not carry
  one. That is the difference between a risk that was weighed and one that was
  forgotten. Exactly one category is in that state today — see A06 below.
- **Every request middleware must be filed.** `server/middleware/` is four
  numbered files that run on every request, and between them they are most of
  A01, A04 and A09. A fifth joining the chain without appearing on the checklist
  fails the gate.

## Why so much of the table is middleware

A control in `server/middleware/` applies to routes nobody has written yet,
which is the only kind of control a boilerplate can honestly ship. A control in
a handler protects that handler. So the four numbered files carry the weight:
`00.request-context.ts` (correlation), `10.auth.ts` (the access gate),
`20.csrf.ts` (origin plus token), `30.rate-limit.ts` (what the system will agree
to do). Everything else on the table either supports one of those or guards a
path that never reaches them — the WebSocket handshake being the notable one,
since an upgrade is exempt from the same-origin policy and never builds an
`H3Event` at all.

## The categories

### A01 — Broken Access Control

`api-default-deny` is the load-bearing one: `/api/**` requires a session, and
every public route is an explicit carve-out with a reason, so the failure mode of
adding an endpoint and forgetting about auth is a 401 rather than an open door.
`path-normalisation-before-matching` is what keeps that from being addressable
around — a rule is matched against a canonical path, so `..`, a doubled slash and
an encoded separator all resolve before anything is decided.
`csrf-origin-and-token` is here rather than in a category of its own because
2021 merged it in. `websocket-handshake-gate` covers the path the middleware
cannot see, and `per-user-store-keys` is the horizontal half: one user must not
be able to reach another's records through a crafted id.

See [`docs/csrf.md`](./csrf.md), [`docs/websockets.md`](./websockets.md) and
[`docs/server-middleware.md`](./server-middleware.md).

### A02 — Cryptographic Failures

Mostly about keys and where the credential lives.
`seal-key-strength-audited-at-boot` means a deployment cannot serve with no key,
a short key, or the placeholder out of `.env.example`.
`per-purpose-derived-keys` means nothing signs with the session password
directly, so a CSRF token cannot be verified as a WebSocket ticket.
`transport-confidentiality` is HSTS plus a `secure` cookie whose weakening fails
the boot audit. `no-credential-in-web-storage` is the one that is enforced
against the _client_ bundle: there is no bearer token for a script to lose, and a
scan keeps it that way. `constant-time-token-comparison` closes the timing side
channel on the one secret a caller submits.

See [`docs/session-security.md`](./session-security.md).

### A03 — Injection

Six entries, because "injection" is a family. `parameterised-sql-only` is the
headline and the newest: all database access goes through Drizzle, and
[`tests/unit/lint/sql-injection.test.ts`](../tests/unit/lint/sql-injection.test.ts)
scans `server/` for the three ways out of that guarantee — `sql.raw()`,
postgres.js's `unsafe()`, and a statement assembled as a string. `markup-escaping`
is XSS at the source, `csp-nonce-over-unsafe-inline` is XSS as
defence-in-depth, and `schema-validated-request-bodies` is the habit that keeps
unexpected input from reaching a sink at all. The last two are the ones people
forget: `header-and-log-injection` (the correlation id is attacker-supplied and
ends up in a response header and a log line) and `store-key-injection` (a
separator inside a value must not be able to address a neighbouring bucket).

### A04 — Insecure Design

Design-level decisions, not misconfiguration fixes. `rate-limit-every-api-route`
is the default-on limiter; `untrusted-client-ip` is the detail that makes it
mean anything, since keying on the left-most `x-forwarded-for` entry would let
any caller mint a fresh bucket per request. `no-nonce-reuse-in-shared-html` is
the subtle one: a prerendered or cached page serves one document to every
visitor, so it is served _without_ a nonce rather than with one an attacker and a
victim would share. `replay-safe-writes` makes a retried write not be a second
write.

See [`docs/rate-limiting.md`](./rate-limiting.md) and
[`docs/idempotency.md`](./idempotency.md).

### A05 — Security Misconfiguration

The theme is that a weakened configuration should fail loudly rather than serve.
`security-header-baseline` applies the header set in a Nitro `request` hook, so
it covers responses nobody remembered. `session-transport-audited-at-boot` and
`csrf-config-fails-closed` both refuse to start rather than run with a defence
that has been turned off through an environment variable.
`operational-dials-are-clamped` is the quieter one: a typo in a TTL falls back to
a default and never to "unlimited".

See [`docs/security-headers.md`](./security-headers.md).

### A06 — Vulnerable and Outdated Components

**The gap.** Nothing in this repository looks at the advisory database.
`pnpm audit` reports 32 advisories against the current lockfile — 16 high, 13
moderate, 3 low as of 2026-09-30 — all transitive and most in build and test
tooling, so turning a scan on is not a one-line change and was not the item that
added this checklist.

What does exist is the machinery a gate would need: a committed `pnpm-lock.yaml`
installed with `--frozen-lockfile`, `pnpm.onlyBuiltDependencies` so a new
postinstall script is a decision rather than a surprise, `engine-strict=true`
against an unsupported runtime, and Actions pinned to majors. None of that is
_detection_. It makes the dependency graph reproducible and reviewable, which is
A08's concern, not this one. Until a scanner runs in CI the honest state of this
category is: unmeasured — and the gate requires it to say so rather than be
quietly missing from the list.

### A07 — Identification and Authentication Failures

`no-session-fixation` (signing in mints a fresh `sid`, so a pre-planted cookie is
worth nothing), `session-rotation-and-absolute-cap` (a stolen cookie has a shelf
life), `revocable-sessions` (a sealed cookie is otherwise valid until it
expires), `login-brute-force-limit` and `credential-shape-enforced`.

The demo login in `server/api/auth/login.post.ts` compares against a hard-coded
pair and says so in a comment — it is a placeholder for a real lookup and an
argon2 verification, and nothing on this checklist claims otherwise. Every
mitigation in this category is about the _session_ the login issues, which is the
part a boilerplate can get right on the application's behalf.

### A08 — Software and Data Integrity Failures

`verify-before-deserialise`: nothing arriving from a client is trusted before its
signature is checked, so an edited expiry, a foreign signing key and a
hand-rolled cookie all fail. `no-lost-updates` is `If-Match` on mutating
requests. `no-lost-side-effects` is the outbox — a recorded side effect is
delivered at least once or dead-lettered with its reason, never dropped.

See [`docs/optimistic-concurrency.md`](./optimistic-concurrency.md) and
[`docs/outbox.md`](./outbox.md).

### A09 — Security Logging and Monitoring Failures

The category is about being able to tell that something happened.
`request-correlation` joins a browser-side call to the records it produced.
`refusals-say-why` means a rejection carries a machine-readable reason, so an
attack and a misconfigured client are distinguishable.
`fail-open-is-observable` covers the window where the rate limiter admitted
traffic because its store was unreachable — the availability choice, made
explicitly, and recorded. `csp-violation-reporting` lets a policy be watched
before it is enforced. `log-volume-is-bounded` keeps a failing dependency from
drowning the log it is reported in.

This application logs; it does not ship a log _pipeline_, and there is no
alerting. Both are deployment concerns, and neither is claimed here.

### A10 — Server-Side Request Forgery

Two entries, because there are only two places this server makes an outbound
call. `closed-image-transformer`: IPX runs inside this Nitro server and will
fetch from no remote host unless one is listed in `image.config.ts`, so `/_ipx/`
cannot be pointed at an internal address.
`outbound-destinations-are-configuration`: the vitals sink and the outbox
publisher take their URL from runtime config, validated at boot, and a
set-but-unusable URL is a refusal rather than a silently dead delivery.

Worth stating plainly: no request handler takes a URL from a caller and fetches
it, and **nothing enforces that**. If one is ever added, this category needs an
allowlist and a mitigation describing it — the scan that would catch the
regression does not exist.

## Adding to the checklist

1. Build the control, with tests, the way anything else in this repository is
   built.
2. Add a mitigation to the right category in `owasp.config.ts`: a kebab-case
   `id`, a `summary` that states the attack and what denies it, the
   `implementation` files, and the `evidence` — test file plus the exact titles.
3. Add a sentence to the category above, naming the `id`. The gate checks this
   file mentions every id, so a mitigation cannot be added to the data and left
   out of the explanation.
4. `pnpm test` resolves all of it.

If a category's last mitigation goes away, give it a `gap` saying why. The gate
will not let it simply become shorter.
