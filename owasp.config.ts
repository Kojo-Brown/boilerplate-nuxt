import type { OwaspChecklist } from './scripts/owaspChecklist.ts'

/**
 * The OWASP Top 10:2021, mapped onto what this application actually does about
 * each category, with the test that proves every claim.
 *
 * This is the checklist. It is a `.ts` file rather than a page of Markdown for
 * the reason `scripts/owaspChecklist.ts` opens with: a prose checklist reads
 * identically whether its claims are still true or not, and
 * `tests/unit/lint/owasp-checklist.test.ts` resolves every line below against
 * the repository on each run — the source file, the test file, and the test's
 * own title. Rename a test and this file fails the build instead of quietly
 * becoming fiction. `docs/owasp-top-10.md` is the prose that explains how to
 * read it and how to add to it.
 *
 * ## What a line here is, and is not
 *
 * A mitigation is a control this codebase implements, stated as the attack it
 * denies. It is **not** a claim that the category is closed: a category is a
 * class of failure, and a boilerplate can furnish the mechanisms and the habits
 * but cannot know the application that will be built on it. Where this project
 * genuinely has nothing, the category carries a `gap` instead of a mitigation —
 * A06 does — and the gate insists an uncovered category say so out loud rather
 * than simply being short.
 *
 * ## Why so much of it is one of four files
 *
 * `server/middleware/` is four numbered files that run in filename order on
 * every request — context, auth, CSRF, rate limit — and between them they are
 * most of A01, A04 and A09. That is deliberate and it is worth knowing when
 * reading this table: a control in middleware applies to routes nobody has
 * written yet, which is the only kind of control a boilerplate can honestly
 * ship. Controls that live in a handler protect that handler and nothing else.
 * The gate requires every middleware file to appear somewhere below, so a fifth
 * one cannot join the chain unfiled.
 *
 * ## Editions
 *
 * 2021's merges are why some categories read the way they do here. CSRF has no
 * category of its own any more and is filed under A01; XSS is part of A03; and
 * A04 is where design-level controls go — a rate limiter is not a
 * misconfiguration fix, it is a decision about what the system will agree to do.
 */
export const owaspTopTen: OwaspChecklist = [
  {
    id: 'A01',
    title: 'Broken Access Control',
    mitigations: [
      {
        id: 'api-default-deny',
        summary:
          'Adding an API route without thinking about auth yields a 401, not an open endpoint: ' +
          '`/api/**` requires a session and every public route is a carve-out with a reason.',
        implementation: [
          'server/utils/access-policy.ts',
          'server/middleware/10.auth.ts',
          'server/utils/request-auth.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/access-policy.test.ts',
            tests: [
              'defaults every API path to authenticated',
              'classifies every route the server actually serves',
              'has no public carve-out left over from a deleted route',
            ],
          },
          {
            file: 'tests/unit/server/request-auth.test.ts',
            tests: [
              'throws 401 when the request has no user',
              'throws 500 naming the policy file when no middleware resolved a context',
            ],
          },
        ],
      },
      {
        id: 'path-normalisation-before-matching',
        summary:
          'A rule is matched against a canonical path, so `..`, a doubled slash or an encoded ' +
          'separator cannot address a protected route under a pattern that does not cover it.',
        implementation: ['server/utils/request-path.ts', 'server/utils/route-pattern.ts'],
        evidence: [
          {
            file: 'tests/unit/server/request-path.test.ts',
            tests: [
              'drops `.` segments and pops the parent on `..`',
              'never climbs above the root',
              'decodes an encoded separator rather than treating it as a segment',
              'still normalises when decoding uses up every pass',
            ],
          },
          {
            file: 'tests/unit/server/access-policy.test.ts',
            tests: ['does not let a public prefix match a longer sibling name'],
          },
        ],
      },
      {
        id: 'csrf-origin-and-token',
        summary:
          'A cross-origin page cannot make this app act on its user: every state-changing ' +
          'request needs a same-origin signal *and* a signed token that a foreign script cannot read.',
        implementation: [
          'server/middleware/20.csrf.ts',
          'server/utils/csrf.ts',
          'server/utils/csrf-cookie.ts',
          'utils/csrf.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/csrf-middleware.test.ts',
            tests: [
              'refuses a cross-origin write with 403 and a machine-readable reason',
              'refuses a same-site sibling, which SameSite=Lax would have let through',
              'guards paths outside /api too, which the access policy leaves unmanaged',
              'matches the exemption against the normalised path, not the raw one',
            ],
          },
          {
            file: 'tests/unit/server/csrf.test.ts',
            tests: [
              'every exemption still names a route that exists',
              'refuses a write that carries no site signal at all',
            ],
          },
        ],
      },
      {
        id: 'websocket-handshake-gate',
        summary:
          'A WebSocket upgrade is exempt from the same-origin policy and never reaches the ' +
          'HTTP middleware, so the socket carries its own origin check and a single-use ticket.',
        implementation: [
          'server/utils/ws-handshake.ts',
          'server/utils/ws-ticket.ts',
          'server/api/ws/ticket.post.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/ws-handshake.test.ts',
            tests: [
              'refuses another host — this is the cross-site hijacking check',
              'refuses a handshake with no ticket, however good the cookie would have been',
              'refuses a foreign origin before looking at the ticket',
              'spends the ticket, so the same handshake cannot be replayed',
              'refuses a valid ticket whose session was revoked',
            ],
          },
        ],
      },
      {
        id: 'per-user-store-keys',
        summary:
          'One user cannot read or revoke another through a crafted id: every store key ' +
          'encodes its parts, so a separator in a value cannot widen a prefix scan.',
        implementation: ['server/utils/session-store.ts', 'server/utils/idempotency.ts'],
        evidence: [
          {
            file: 'tests/unit/server/session-store.test.ts',
            tests: [
              'encodes a colon in either half so a key cannot forge another namespace',
              'does not let a user id smuggle a separator into the prefix scan',
              'does not revoke another user who happens to share the session id',
              'does not spill into a user whose id merely starts with the same characters',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A02',
    title: 'Cryptographic Failures',
    mitigations: [
      {
        id: 'seal-key-strength-audited-at-boot',
        summary:
          'The server refuses to start rather than sealing sessions with nothing, with a key ' +
          'too short for iron-webcrypto, or with the placeholder from `.env.example`.',
        implementation: [
          'server/utils/session-hardening.ts',
          'server/plugins/session-hardening.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/session-hardening.test.ts',
            tests: [
              'refuses to serve with no key',
              'rejects a key that is too short for iron-webcrypto',
              'rejects the placeholder from .env.example, which is long enough to pass on length',
              'rejects padding that satisfies the length rule',
              'names the marker it matched but never echoes the key itself',
            ],
          },
        ],
      },
      {
        id: 'per-purpose-derived-keys',
        summary:
          'Nothing signs with the session password itself: each subsystem derives its own key, ' +
          'so a token minted for one purpose cannot be verified as another.',
        implementation: ['server/utils/csrf-config.ts', 'server/utils/ws-ticket.ts'],
        evidence: [
          {
            file: 'tests/unit/server/csrf-config.test.ts',
            tests: [
              'is not the WebSocket ticket key, though both come from the same password',
              'produces a key that can sign and cannot be read back out',
              'refuses a secret too short to be a seal key',
            ],
          },
          {
            file: 'tests/unit/server/ws-ticket.test.ts',
            tests: [
              'is not the secret itself — that is the whole point of deriving it',
              'produces a 256-bit key',
              'separates keys derived from different secrets',
            ],
          },
        ],
      },
      {
        id: 'transport-confidentiality',
        summary:
          'HSTS commits a browser to TLS for a year, and the session cookie is `secure`, so the ' +
          'credential is never sent in the clear — a weakened cookie fails the boot audit.',
        implementation: ['server/utils/security-headers.ts', 'server/utils/session-hardening.ts'],
        evidence: [
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'sends HSTS only over TLS',
              'includes subdomains by default',
              'clamps to 0…two years',
              'only upgrades insecure requests over TLS',
            ],
          },
          {
            file: 'tests/unit/server/session-hardening.test.ts',
            tests: ['rejects secure being turned off'],
          },
        ],
      },
      {
        id: 'no-credential-in-web-storage',
        summary:
          'There is no bearer credential for a script to lose: the session lives only in an ' +
          'httpOnly cookie, and a scan of every file that ships to the browser keeps it that way.',
        implementation: ['composables/useAuth.ts', 'server/utils/session-hardening.ts'],
        evidence: [
          {
            file: 'tests/unit/lint/token-storage.test.ts',
            tests: [
              'stores nothing credential-shaped in web storage or document.cookie',
              'keeps useAuth() free of any storage access at all',
              'exposes no token from the session composable',
              'persists only the preference stores, and only their non-credential fields',
            ],
          },
          {
            file: 'tests/unit/server/session-hardening.test.ts',
            tests: [
              'disables the session request header with the boolean, not a string',
              'rejects httpOnly being turned off',
            ],
          },
        ],
      },
      {
        id: 'constant-time-token-comparison',
        summary:
          'The CSRF token comparison does not return early on the first differing byte, so a ' +
          'caller cannot recover a token one character at a time from response timing.',
        implementation: ['server/utils/csrf.ts'],
        evidence: [
          {
            file: 'tests/unit/server/csrf.test.ts',
            tests: [
              'accepts two identical values',
              'rejects values of the same length that differ',
              'rejects values of different lengths without throwing',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A03',
    title: 'Injection',
    mitigations: [
      {
        id: 'parameterised-sql-only',
        summary:
          'No query is assembled from strings: all DB access goes through Drizzle, which sends ' +
          'interpolated values as bind parameters, and the escape hatches that bypass that are absent.',
        implementation: [
          'server/utils/db.ts',
          'server/utils/todo-store.ts',
          'server/utils/outbox-store.ts',
          'server/db/schema.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/lint/sql-injection.test.ts',
            tests: [
              'finds the server sources it is supposed to be scanning',
              'calls none of the APIs that hand raw SQL to the driver',
              'interpolates values into a tagged sql template, never assembled SQL text',
              'builds no query by concatenation or interpolation into a string',
              'opens exactly one database client, in the module that owns it',
            ],
          },
        ],
      },
      {
        id: 'markup-escaping',
        summary:
          'Stored content cannot become script: the Markdown renderer escapes before it emits, ' +
          'inside code spans and attribute values as well as in prose, and drops dangerous link schemes.',
        implementation: ['server/utils/content-markup.ts'],
        evidence: [
          {
            file: 'tests/unit/server/content-markup.test.ts',
            tests: [
              'escapes a tag in a paragraph',
              'escapes a tag inside a fenced code block',
              'escapes a quote in a link target so it cannot close the attribute',
              'does not resurrect a scheme smuggled through an HTML entity',
              'keeps the literal text of a rejected link',
            ],
          },
        ],
      },
      {
        id: 'schema-validated-request-bodies',
        summary:
          'Every handler parses its input with a closed Zod schema before touching it, so an ' +
          'unexpected key or an unbounded string is a 422 rather than something a sink receives.',
        implementation: [
          'server/utils/auth-schemas.ts',
          'server/utils/vitals-schemas.ts',
          'server/utils/upload-schemas.ts',
          'server/utils/todo-schemas.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/vitals-schemas.test.ts',
            tests: [
              'rejects unknown keys rather than passing them through to a sink',
              'bounds the strings a forged beacon could grow',
              'caps the batch at the size both ends agree on',
            ],
          },
          {
            file: 'tests/unit/auth-schemas.test.ts',
            tests: ['rejects invalid email format', 'rejects empty object'],
          },
          {
            file: 'tests/unit/server/upload-schemas.test.ts',
            tests: ['rejects a disallowed content type', 'rejects a file over 10 MB'],
          },
        ],
      },
      {
        id: 'header-and-log-injection',
        summary:
          'The one attacker-supplied value this app echoes into a response header and a log line ' +
          'is whitelisted, so a CRLF cannot add a header or forge a log record.',
        implementation: ['server/utils/request-id.ts', 'server/middleware/00.request-context.ts'],
        evidence: [
          {
            file: 'tests/unit/server/request-id.test.ts',
            tests: [
              'rejects anything that could break out of a header or a log line',
              'rejects lengths outside the accepted band',
            ],
          },
        ],
      },
      {
        id: 'store-key-injection',
        summary:
          'A caller cannot forge a neighbouring bucket by putting the separator in a value: ' +
          'every composite store key encodes its parts before joining them.',
        implementation: ['server/utils/rate-limit-policy.ts', 'server/utils/idempotency.ts'],
        evidence: [
          {
            file: 'tests/unit/server/rate-limit-policy.test.ts',
            tests: [
              'encodes every part, so a colon cannot forge another bucket',
              'separates a user from an address that happens to read the same',
            ],
          },
          {
            file: 'tests/unit/server/idempotency.test.ts',
            tests: [
              'encodes a colon in either half so a key cannot forge another scope',
              'cannot be fooled by moving the field boundary',
            ],
          },
        ],
      },
      {
        id: 'csp-nonce-over-unsafe-inline',
        summary:
          'Injected markup cannot execute even when it reaches the document: `script-src` names ' +
          'a per-response nonce, and a configured source list cannot smuggle a directive of its own.',
        implementation: [
          'server/utils/csp-nonce.ts',
          'server/utils/security-headers.ts',
          'server/plugins/security-headers.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'never puts a nonce and `unsafe-inline` in the same directive',
              'drops anything that could append a directive of its own',
              'keeps the valid entries of a partly invalid list',
            ],
          },
          {
            file: 'tests/unit/server/csp-nonce.test.ts',
            tests: [
              'produces a base64 value of 16 random bytes',
              'does not repeat',
              'rejects anything that could break out of an attribute',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A04',
    title: 'Insecure Design',
    mitigations: [
      {
        id: 'rate-limit-every-api-route',
        summary:
          'Brute force and scraping cost the attacker something: every API route has a limit by ' +
          'default, login has a much tighter one, and the table cannot silently stop covering a route.',
        implementation: [
          'server/middleware/30.rate-limit.ts',
          'server/utils/rate-limit.ts',
          'server/utils/rate-limit-policy.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/rate-limit-policy.test.ts',
            tests: [
              'limits every /api route, including ones with no key of their own',
              'carries a catch-all, so an unmatched path is a decision and not an accident',
              'clamps a table entry, so a typo cannot mean "no limit"',
              'limits login far more tightly than the API default',
            ],
          },
          {
            file: 'tests/unit/server/rate-limit-middleware.test.ts',
            tests: [
              'answers 429 with Retry-After once the login bucket is spent',
              'separates buckets per rule, so one endpoint cannot exhaust another',
              'counts a normalised path, so a traversal cannot buy a fresh bucket',
            ],
          },
        ],
      },
      {
        id: 'untrusted-client-ip',
        summary:
          '`x-forwarded-for` is read from the right by a configured hop count, so a caller cannot ' +
          'mint a fresh rate-limit bucket per request by writing their own left-most entry.',
        implementation: ['server/utils/rate-limit-policy.ts'],
        evidence: [
          {
            file: 'tests/unit/server/rate-limit-policy.test.ts',
            tests: [
              'ignores x-forwarded-for entirely when no proxy is trusted',
              'takes the entry the nearest trusted proxy wrote, not the one the client sent',
              'does not let extra spoofed entries shift which hop is read',
            ],
          },
          {
            file: 'tests/unit/server/rate-limit-middleware.test.ts',
            tests: [
              'ignores a spoofed x-forwarded-for when no proxy is trusted',
              'reads the trusted hop when one proxy is configured',
            ],
          },
        ],
      },
      {
        id: 'no-nonce-reuse-in-shared-html',
        summary:
          'A prerendered or cached page serves one document to every visitor, so it is served ' +
          'without a nonce rather than with one attacker and victim would share.',
        implementation: [
          'server/utils/security-headers.ts',
          'server/plugins/security-headers.ts',
          'route-rules.config.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'derives the exceptions from the project route rules',
              'matches the prerendered and cached pages of this project',
              'leaves every other path with a nonce',
              'counts isr as well as swr',
            ],
          },
        ],
      },
      {
        id: 'replay-safe-writes',
        summary:
          'A retried write is not a second write: an idempotency key replays the first response, ' +
          'and the same key with a different body is refused rather than silently accepted.',
        implementation: ['server/utils/idempotency.ts', 'server/utils/idempotent-route.ts'],
        evidence: [
          {
            file: 'tests/unit/server/idempotency.test.ts',
            tests: [
              'refuses a completed record replayed with a different payload',
              'checks the fingerprint before the state, so a mismatch is never a replay',
              'reports a live claim as in-flight rather than running the handler twice',
              'takes over a claim older than the timeout, so a crash cannot stick a key',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A05',
    title: 'Security Misconfiguration',
    mitigations: [
      {
        id: 'security-header-baseline',
        summary:
          'Every response carries the header set, not just the pages someone remembered: it is ' +
          'applied in a Nitro `request` hook and its whole policy is asserted as one string.',
        implementation: [
          'server/plugins/security-headers.ts',
          'server/utils/security-headers.ts',
          'server/utils/security-response.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'sets the static headers on every response',
              'is the whole policy, in a fixed order, for a rendered page over TLS',
              'emits header names lowercased, so a later `setResponseHeader` replaces rather than doubles',
            ],
          },
        ],
      },
      {
        id: 'session-transport-audited-at-boot',
        summary:
          'A deployment cannot weaken the session cookie through a `NUXT_SESSION_*` variable and ' +
          'still serve: the resolved config is audited at boot and every weakening is a refusal.',
        implementation: [
          'server/plugins/session-hardening.ts',
          'server/utils/session-hardening.ts',
          'nuxt.config.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/session-hardening.test.ts',
            tests: [
              'is what nuxt.config.ts ships, and passes its own audit',
              'rejects the session request header being left enabled',
              'rejects the string "false", which h3 would treat as enabled',
              'rejects SameSite=None, which is what makes a session CSRF-reachable',
              'collects every problem in one pass rather than stopping at the first',
            ],
          },
        ],
      },
      {
        id: 'csrf-config-fails-closed',
        summary:
          'A deployment with no seal key cannot serve a CSRF defence that signs with nothing — ' +
          'it fails to resolve its config instead.',
        implementation: ['server/utils/csrf-config.ts', 'server/middleware/20.csrf.ts'],
        evidence: [
          {
            file: 'tests/unit/server/csrf-config.test.ts',
            tests: [
              'fails on a deployment with no seal key rather than signing with nothing',
              'reads the TTL and the allowlist, clamping the first',
            ],
          },
          {
            file: 'tests/unit/server/csrf-middleware.test.ts',
            tests: [
              'lets requests through rather than failing, because there are no sessions to forge',
              'says so once, not once per request',
            ],
          },
        ],
      },
      {
        id: 'operational-dials-are-clamped',
        summary:
          'A typo in an environment variable cannot turn a control off: TTLs, intervals and ' +
          'limits are clamped to a supported range and fall back to a default, never to "unlimited".',
        implementation: [
          'server/utils/csrf.ts',
          'server/utils/ws-ticket.ts',
          'server/utils/session-rotation.ts',
          'server/utils/security-headers.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/csrf.test.ts',
            tests: [
              'floors and caps out-of-range values instead of rejecting them',
              'accepts the string an environment variable degrades to',
              'clamps a wildly long requested lifetime rather than honouring it',
            ],
          },
          {
            file: 'tests/unit/server/ws-ticket.test.ts',
            tests: [
              'clamps to the supported range rather than trusting configuration',
              'accepts the string a NUXT_* environment override arrives as',
            ],
          },
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'defaults to a year when unset or unparseable',
              'reads the string an env var actually delivers',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A06',
    title: 'Vulnerable and Outdated Components',
    mitigations: [],
    gap:
      'Nothing in this repository looks at the advisory database. `pnpm audit` reports 32 ' +
      'advisories against the current lockfile (16 high, 13 moderate, 3 low as of 2026-09-30), ' +
      'all of them transitive and most of them in build and test tooling, so adding the gate is ' +
      'not a one-line change and is not this item. What does exist is the machinery a gate would ' +
      'need: a committed `pnpm-lock.yaml` installed with `--frozen-lockfile`, ' +
      '`pnpm.onlyBuiltDependencies` so a new postinstall script is a decision, `engine-strict` ' +
      'against an unsupported runtime, and Actions pinned to majors. None of that is detection — ' +
      'it makes the dependency graph reproducible and reviewable, which is A08, not this. Until a ' +
      'scanner runs in CI the honest state of this category is: unmeasured.',
  },

  {
    id: 'A07',
    title: 'Identification and Authentication Failures',
    mitigations: [
      {
        id: 'no-session-fixation',
        summary:
          'A session id a caller arrived with is never adopted: signing in mints a fresh `sid` ' +
          "and starts both of the session's clocks, so a pre-planted cookie is worth nothing.",
        implementation: ['server/utils/session-rotation.ts', 'server/api/auth/login.post.ts'],
        evidence: [
          {
            file: 'tests/unit/server/session-rotation.test.ts',
            tests: [
              'starts both clocks together',
              'mints a new credential id, which h3 would not have done for it',
              'mints a different id every time',
            ],
          },
        ],
      },
      {
        id: 'session-rotation-and-absolute-cap',
        summary:
          'A stolen cookie has a shelf life: the credential is replaced on an interval and the ' +
          'sign-in ends at an absolute cap counted from the sign-in, not from the last request.',
        implementation: ['server/utils/session-rotation.ts'],
        evidence: [
          {
            file: 'tests/unit/server/session-rotation.test.ts',
            tests: [
              'rotates once the interval has elapsed',
              'measures the interval from the last rotation, not from the sign-in',
              'expires a session that has hit the absolute cap',
              'carries issuedAt across, so the absolute cap still counts from the sign-in',
              'caps the interval at the cookie lifetime, which would otherwise never rotate',
            ],
          },
        ],
      },
      {
        id: 'revocable-sessions',
        summary:
          'A sealed cookie is valid until it expires unless something can say otherwise: every ' +
          'session is registered so it — or every session a user has — can be revoked immediately.',
        implementation: ['server/utils/session-store.ts', 'server/middleware/10.auth.ts'],
        evidence: [
          {
            file: 'tests/unit/server/session-store.test.ts',
            tests: [
              'marks the record revoked instead of deleting it',
              'prefers revoked over expired, so a tombstone is never read as a miss',
              'revokes every live session that user has',
              'keys the record on the sid, not on h3’s stable session id',
            ],
          },
        ],
      },
      {
        id: 'login-brute-force-limit',
        summary:
          'Guessing a password is rate-limited far harder than reading the API, and the limit is ' +
          'keyed so one caller cannot spread attempts across fresh buckets.',
        implementation: ['server/utils/rate-limit-policy.ts', 'server/middleware/30.rate-limit.ts'],
        evidence: [
          {
            file: 'tests/unit/server/rate-limit-middleware.test.ts',
            tests: [
              'applies the tight login limit rather than the API default',
              'names a retry delay in the message a developer will actually read',
            ],
          },
          {
            file: 'tests/unit/server/rate-limit-policy.test.ts',
            tests: [
              'limits login far more tightly than the API default',
              'prefers the user id, so a shared NAT does not throttle its occupants together',
            ],
          },
        ],
      },
      {
        id: 'credential-shape-enforced',
        summary:
          'The login route validates before it compares, so a missing field or a two-character ' +
          'password is a 422 from the schema rather than a branch in the handler.',
        implementation: ['server/utils/auth-schemas.ts', 'server/api/auth/login.post.ts'],
        evidence: [
          {
            file: 'tests/unit/auth-schemas.test.ts',
            tests: [
              'rejects password shorter than 8 characters',
              'rejects missing password',
              'rejects missing email',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A08',
    title: 'Software and Data Integrity Failures',
    mitigations: [
      {
        id: 'verify-before-deserialise',
        summary:
          'Nothing that arrives from a client is trusted before its signature is checked: an ' +
          'edited expiry, a foreign signing key or a hand-rolled cookie all fail verification.',
        implementation: [
          'server/utils/csrf.ts',
          'server/utils/csrf-cookie.ts',
          'server/utils/ws-ticket.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/csrf.test.ts',
            tests: [
              'refuses a token whose expiry has been edited, because the expiry is signed',
              'refuses a token signed with a different deployment key',
              'refuses a token past its expiry',
            ],
          },
          {
            file: 'tests/unit/server/csrf-middleware.test.ts',
            tests: ['refuses a cookie this server did not sign, however well-formed it looks'],
          },
          {
            file: 'tests/unit/server/ws-ticket.test.ts',
            tests: [
              'pins the algorithm and the media type in the protected header',
              'carries the identity in standard claims, not bespoke ones',
            ],
          },
        ],
      },
      {
        id: 'no-lost-updates',
        summary:
          'Two concurrent writers cannot silently overwrite each other: a mutating request ' +
          'carries `If-Match`, and a stale version is a 409 that reports both versions.',
        implementation: ['server/utils/optimistic-concurrency.ts', 'server/utils/todo-store.ts'],
        evidence: [
          {
            file: 'tests/unit/server/optimistic-concurrency.test.ts',
            tests: [
              'demands a precondition on a route that requires one',
              'passes a malformed header through as malformed, never as absent',
              'guards on the highest version in a list, so no write can be lost',
              'carries the current row and both versions for a stale write',
            ],
          },
        ],
      },
      {
        id: 'no-lost-side-effects',
        summary:
          'A side effect that was recorded is delivered at least once or dead-lettered with its ' +
          'reason — never dropped, and never retried out from under another relay.',
        implementation: [
          'server/utils/outbox.ts',
          'server/utils/outbox-store.ts',
          'server/plugins/outbox-relay.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/outbox.test.ts',
            tests: [
              'reschedules a failed row with backoff instead of losing it',
              'dead-letters a row that has used its last attempt',
              'propagates a store outage instead of recording it as a delivery failure',
              'does not re-claim a row whose lease is still running',
            ],
          },
          {
            file: 'tests/unit/server/outbox-store.test.ts',
            tests: [
              'claims only rows that are owed and due',
              'locks the batch with SKIP LOCKED so relays divide the queue',
              'stamps the delivery, clears the error, and cannot overwrite an earlier one',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A09',
    title: 'Security Logging and Monitoring Failures',
    mitigations: [
      {
        id: 'request-correlation',
        summary:
          'A browser-side call and the server records it produced can be joined: the first ' +
          'middleware adopts or mints a request id and echoes it on the response.',
        implementation: [
          'server/middleware/00.request-context.ts',
          'server/utils/request-id.ts',
          'utils/api.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/request-id.test.ts',
            tests: [
              'accepts the id formats a real caller sends',
              'prefers x-request-id but still accepts the id utils/api.ts already sends',
            ],
          },
        ],
      },
      {
        id: 'refusals-say-why',
        summary:
          'A rejected request carries a machine-readable reason rather than a bare 403, so the ' +
          'difference between an attack and a misconfigured client is greppable.',
        implementation: ['server/middleware/20.csrf.ts', 'server/utils/csrf.ts'],
        evidence: [
          {
            file: 'tests/unit/server/csrf-middleware.test.ts',
            tests: [
              'refuses a cross-origin write with 403 and a machine-readable reason',
              'refuses a same-origin write with no header, and says where to get one',
            ],
          },
          {
            file: 'tests/unit/server/csrf.test.ts',
            tests: ['names the missing half', 'reports why the cookie failed verification'],
          },
        ],
      },
      {
        id: 'fail-open-is-observable',
        summary:
          'The rate limiter admits traffic when its store is unreachable — the availability ' +
          'choice — and says so, so the window where the control was absent is in the record.',
        implementation: ['server/middleware/30.rate-limit.ts', 'server/utils/rate-limit.ts'],
        evidence: [
          {
            file: 'tests/unit/server/rate-limit-middleware.test.ts',
            tests: [
              'admits the request and logs, rather than failing the app closed',
              'admits the request when the write fails after a successful read',
            ],
          },
        ],
      },
      {
        id: 'csp-violation-reporting',
        summary:
          'A policy can be rolled out and watched before it is enforced: report-only mode and a ' +
          'validated `report-uri` are configuration, not a code change.',
        implementation: ['server/utils/security-headers.ts'],
        evidence: [
          {
            file: 'tests/unit/server/security-headers.test.ts',
            tests: [
              'moves the policy to the report-only header in report-only mode',
              'takes a same-origin path or an absolute http(s) report endpoint, and nothing else',
              'appends report-uri last, when one is configured',
              'accepts the three modes and falls back to enforce for anything else',
            ],
          },
        ],
      },
      {
        id: 'log-volume-is-bounded',
        summary:
          'A failing dependency cannot drown the log it is supposed to be reported in: repeated ' +
          'messages are throttled and report how many were swallowed.',
        implementation: ['server/utils/vitals-sink.ts'],
        evidence: [
          {
            file: 'tests/unit/server/vitals-sink.test.ts',
            tests: [
              'passes the first message and suppresses the rest of the interval',
              'reports how many it swallowed when the interval passes',
              'truncates a long error body rather than logging all of it',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'A10',
    title: 'Server-Side Request Forgery (SSRF)',
    mitigations: [
      {
        id: 'closed-image-transformer',
        summary:
          'The image transformer runs inside this server and will fetch from no remote host ' +
          'unless one is listed, so `/_ipx/` cannot be pointed at an internal address.',
        implementation: ['image.config.ts'],
        evidence: [
          {
            file: 'tests/unit/image-config.test.ts',
            tests: [
              'transforms nothing from a remote host by default',
              'names the provider rather than leaving it to the deploy target',
            ],
          },
        ],
      },
      {
        id: 'outbound-destinations-are-configuration',
        summary:
          'The two places this server makes an outbound call take their URL from runtime config ' +
          'validated at boot, never from a request, and a set-but-unusable URL is a refusal.',
        implementation: [
          'server/utils/vitals-sink.ts',
          'server/utils/outbox-publisher.ts',
          'server/plugins/outbox-relay.ts',
        ],
        evidence: [
          {
            file: 'tests/unit/server/vitals-sink.test.ts',
            tests: [
              'rejects a non-URL and a non-HTTP scheme',
              'throws on a URL that is set but unusable',
              'never echoes the URL, which routinely carries an API key',
            ],
          },
        ],
      },
    ],
  },
]
