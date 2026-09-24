/**
 * What the session cookie is allowed to be, and what refuses to boot.
 *
 * `nuxt-auth-utils` hands `runtimeConfig.session` straight to h3's `useSession`,
 * so that object *is* the session's security configuration: the seal key, the
 * cookie attributes, and — the one that is easy to miss — whether the sealed
 * session may arrive somewhere other than the cookie. Every value in it is
 * overridable at runtime with a `NUXT_SESSION_*` environment variable, which is
 * the right design for a deployment knob and the wrong one for a security
 * boundary: nothing in the framework notices when `NUXT_SESSION_COOKIE_HTTP_ONLY`
 * arrives as `false`.
 *
 * This module is what notices. It is a pure function of the resolved config, so
 * `server/plugins/session-hardening.ts` can hold it up at boot and refuse to
 * start, and a test can hold it up without booting anything.
 *
 * ## The three things it insists on
 *
 * **The cookie is the only carrier.** h3 reads the sealed session from a request
 * header — `x-<session name>-session` — unless `sessionHeader` is `false`
 * (`getSession` in h3, which tests `config.sessionHeader !== false` *before* it
 * looks at the cookie header at all). A header is not `httpOnly`; a client that
 * kept the sealed blob in `localStorage` and replayed it in that header would be
 * authenticated by it. So the default is turned off here, and a config that
 * turns it back on is fatal rather than merely noted.
 *
 * The strict `=== false` matters more than it looks. h3's test is identity
 * against `false`, so the *string* `"false"` — what an environment variable
 * degrades to whenever Nuxt cannot infer the type from the default — leaves the
 * header path enabled while reading, in a config dump, as though it were off.
 * That is the failure this check exists for.
 *
 * **The cookie attributes are asserted, not assumed.** `httpOnly`, `secure` and
 * `path` come from h3's `DEFAULT_COOKIE` and `sameSite: 'lax'` from the
 * nuxt-auth-utils module, so today's defaults are already correct — and a
 * default is a thing that holds until someone changes it in a file nobody
 * reviews. `nuxt.config.ts` states all four, and this refuses to run if the
 * resolved value is weaker than what was stated.
 *
 * **The seal key is real.** `iron-webcrypto` needs 32 characters and
 * nuxt-auth-utils only `console.error`s when it has none, so a server with no
 * `NUXT_SESSION_PASSWORD` starts, serves, and fails on the first sign-in with an
 * error about key length. Failing at boot instead turns a production incident
 * into a deploy that does not roll out.
 *
 * ## Where it is lenient, and why
 *
 * A missing key is a warning in `pnpm dev` (the module generates one and writes
 * it to `.env`, so demanding it would break the first-run experience it exists
 * to smooth) and during prerendering (the build renders no user's session, and
 * `pnpm build` on a machine with no secrets is a supported thing to do). It is
 * fatal everywhere else. A key that is *present and weak* is fatal everywhere,
 * including dev: there is no environment in which a placeholder is the right
 * seal key, and finding out in dev is the cheapest place to find out.
 */

/**
 * The transport half of `runtimeConfig.session`, as `nuxt.config.ts` sets it.
 *
 * It lives here, next to the checks, rather than being written out in the config
 * file, so that the value shipped and the value demanded cannot drift — the
 * config spreads this, the boot check compares against these same rules, and a
 * test can assert the object directly. `nuxt.config.ts` imports it by relative
 * path because this module has no imports of its own and so needs no alias
 * resolution at config-load time.
 *
 * What it does *not* protect against is the thing it exists for: every key below
 * is still overridable at runtime with a `NUXT_SESSION_*` variable. That is what
 * `server/plugins/session-hardening.ts` checks, against the resolved config
 * rather than against this.
 */
export const HARDENED_SESSION_TRANSPORT = {
  /**
   * The cookie is the only carrier. h3 otherwise accepts a sealed session in an
   * `x-<name>-session` request header, which a script can set and which is
   * therefore not httpOnly by any definition.
   */
  sessionHeader: false,
  cookie: {
    httpOnly: true,
    /** Browsers treat localhost as a secure origin, so this holds in dev too. */
    secure: true,
    /** `lax`, not `strict`: the GitHub OAuth callback is a cross-site navigation. */
    sameSite: 'lax',
    path: '/',
  },
} as const

/** The variable nuxt-auth-utils reads the seal key from, before runtimeConfig. */
export const SESSION_PASSWORD_ENV = 'NUXT_SESSION_PASSWORD'

/** `iron-webcrypto` derives its keys from this and refuses shorter input. */
export const MIN_SESSION_PASSWORD_LENGTH = 32

/**
 * Substrings that mean "nobody replaced this". Deliberately short: the point is
 * to catch `.env.example` being copied verbatim, not to grade entropy. A real
 * generated key (`openssl rand -base64 32`) cannot contain any of them.
 */
const PLACEHOLDER_MARKERS = [
  'your-',
  'your_',
  'change-me',
  'changeme',
  'placeholder',
  'at-least-32-chars',
] as const

/**
 * The floor on distinct characters. Thirty-two copies of `a` satisfies the
 * length rule and carries about five bits; this rejects that class of "key"
 * without pretending to be an entropy estimator.
 */
const MIN_DISTINCT_CHARACTERS = 10

/** The cookie attributes this module has an opinion about. */
export interface SessionCookieSettings {
  readonly httpOnly?: boolean | undefined
  readonly secure?: boolean | undefined
  readonly sameSite?: boolean | string | undefined
  readonly path?: string | undefined
}

/**
 * The shape of `runtimeConfig.session` this module reads, declared structurally
 * so a test passes a literal rather than a whole Nuxt config.
 *
 * The `| string` on `sessionHeader` and `maxAge` is the point of the exercise
 * rather than defensive noise — see the note above on what an environment
 * variable does to a boolean.
 */
export interface SessionHardeningInput {
  readonly name?: string | undefined
  readonly maxAge?: number | string | undefined
  readonly sessionHeader?: boolean | string | undefined
  readonly cookie?: SessionCookieSettings | false | undefined
}

export interface HardeningContext {
  /** The seal key actually in force: `process.env` first, then runtime config. */
  readonly password: string
  /** `import.meta.dev`. */
  readonly dev: boolean
  /** `import.meta.prerender` — true while `nuxt build` renders static routes. */
  readonly prerender: boolean
}

export interface HardeningReport {
  /** Problems that must stop the process. Empty means the config is sound. */
  readonly fatal: readonly string[]
  /** Problems worth saying once at boot that do not justify refusing to serve. */
  readonly warnings: readonly string[]
}

/**
 * Audits the resolved session config.
 *
 * Returns everything it found rather than throwing on the first problem: an
 * operator fixing a misconfigured deployment should get the whole list in one
 * boot, not one item per restart.
 */
export function evaluateSessionHardening(
  session: SessionHardeningInput | undefined,
  context: HardeningContext,
): HardeningReport {
  const fatal: string[] = []
  const warnings: string[] = []

  if (!session) {
    fatal.push(
      'runtimeConfig.session is missing entirely, so the session cookie has no ' +
        'configured name, lifetime or attributes. See nuxt.config.ts.',
    )
    return { fatal, warnings }
  }

  collectTransportProblems(session, fatal)
  collectPasswordProblems(context, fatal, warnings)

  return { fatal, warnings }
}

/** Everything about how the sealed session travels. */
function collectTransportProblems(session: SessionHardeningInput, fatal: string[]): void {
  if (session.sessionHeader !== false) {
    const header = `x-${(session.name ?? 'h3').toLowerCase()}-session`
    fatal.push(
      `runtimeConfig.session.sessionHeader is ${describe(session.sessionHeader)}, not the ` +
        `boolean false, so h3 will accept a sealed session in the "${header}" request ` +
        'header as well as in the cookie. A header is not httpOnly. Set ' +
        'NUXT_SESSION_SESSION_HEADER=false, or leave the nuxt.config.ts default in place.',
    )
  }

  if (session.cookie === false) {
    fatal.push(
      'runtimeConfig.session.cookie is false, which stops h3 writing the session cookie ' +
        'at all. Sessions would be issued and immediately lost.',
    )
    return
  }

  const cookie = session.cookie ?? {}

  if (cookie.httpOnly !== true) {
    fatal.push(
      `runtimeConfig.session.cookie.httpOnly is ${describe(cookie.httpOnly)}, not true. ` +
        'The session cookie would be readable by any script on the page, which is the ' +
        'one property this whole module exists to keep.',
    )
  }

  if (cookie.secure !== true) {
    fatal.push(
      `runtimeConfig.session.cookie.secure is ${describe(cookie.secure)}, not true. The ` +
        'session cookie would travel over plaintext HTTP. Browsers treat localhost as a ' +
        'secure origin, so this stays true in development too.',
    )
  }

  if (cookie.sameSite === 'none' || cookie.sameSite === false) {
    fatal.push(
      `runtimeConfig.session.cookie.sameSite is ${describe(cookie.sameSite)}, so the ` +
        'session cookie is attached to cross-site requests and every state-changing route ' +
        'becomes CSRF-reachable.',
    )
  } else if (cookie.sameSite !== 'lax' && cookie.sameSite !== 'strict') {
    fatal.push(
      `runtimeConfig.session.cookie.sameSite is ${describe(cookie.sameSite)}. Browsers ` +
        'default an unset attribute to Lax, but they do not agree on when, so this app ' +
        "states it: 'lax' keeps the GitHub OAuth callback working, 'strict' does not.",
    )
  }

  if (cookie.path !== '/') {
    fatal.push(
      `runtimeConfig.session.cookie.path is ${describe(cookie.path)}, not "/". A narrower ` +
        'path silently signs the user out on the routes it does not cover.',
    )
  }

  const maxAge = toPositiveSeconds(session.maxAge)
  if (maxAge === null) {
    fatal.push(
      `runtimeConfig.session.maxAge is ${describe(session.maxAge)}, not a positive number ` +
        'of seconds. Without it h3 seals with no TTL and sets a cookie with no expiry, so ' +
        'a session ends only when the browser closes — and never, on the server.',
    )
  }
}

/** Everything about the seal key. */
function collectPasswordProblems(
  context: HardeningContext,
  fatal: string[],
  warnings: string[],
): void {
  const password = context.password

  if (password === '') {
    const message =
      `${SESSION_PASSWORD_ENV} is not set, so sessions cannot be sealed. ` +
      'nuxt-auth-utils logs this and carries on; the first sign-in then fails inside ' +
      'iron-webcrypto with an error about key length.'

    // Dev generates one and writes it to `.env`; a prerender pass renders no
    // user's session. Everywhere else this is the deploy that should not happen.
    if (context.dev || context.prerender) warnings.push(message)
    else fatal.push(message)
    return
  }

  if (password.length < MIN_SESSION_PASSWORD_LENGTH) {
    fatal.push(
      `${SESSION_PASSWORD_ENV} is ${password.length} characters; iron-webcrypto needs at ` +
        `least ${MIN_SESSION_PASSWORD_LENGTH}. Generate one with \`openssl rand -base64 32\`.`,
    )
  }

  const lowered = password.toLowerCase()
  const marker = PLACEHOLDER_MARKERS.find((candidate) => lowered.includes(candidate))
  if (marker !== undefined) {
    // The marker is named; the key is not. A boot error goes to the logs.
    fatal.push(
      `${SESSION_PASSWORD_ENV} still contains "${marker}", so it is the placeholder from ` +
        '.env.example rather than a generated key. Anyone with the repository can forge a ' +
        'session. Generate one with `openssl rand -base64 32`.',
    )
    return
  }

  if (new Set(password).size < MIN_DISTINCT_CHARACTERS) {
    fatal.push(
      `${SESSION_PASSWORD_ENV} is long enough but uses fewer than ` +
        `${MIN_DISTINCT_CHARACTERS} distinct characters, so it is padding rather than a ` +
        'key. Generate one with `openssl rand -base64 32`.',
    )
  }
}

/**
 * A positive integer count of seconds, or `null`.
 *
 * Shares the coercion problem `server/utils/storage.ts` documents: a
 * `NUXT_SESSION_MAX_AGE` that arrives as `"604800"` is still a usable lifetime,
 * and `""` or `"0"` is not.
 */
export function toPositiveSeconds(value: number | string | undefined): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

/**
 * Renders a value for an operator-facing message, keeping the type visible.
 *
 * `false` and `"false"` are the same word in a log line and completely different
 * to h3, which is the whole reason this file exists — so strings keep their
 * quotes.
 */
function describe(value: unknown): string {
  if (value === undefined) return 'unset'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * The one line to log, or the error to throw, given a report.
 *
 * Split out so the plugin has no formatting in it and a test can assert the
 * operator-facing text without catching anything.
 */
export function formatHardeningFailure(report: HardeningReport): string {
  return [
    `Refusing to start: the session configuration is not safe (${report.fatal.length} ` +
      `${report.fatal.length === 1 ? 'problem' : 'problems'}).`,
    ...report.fatal.map((problem, index) => `  ${index + 1}. ${problem}`),
    '  See docs/session-security.md.',
  ].join('\n')
}
