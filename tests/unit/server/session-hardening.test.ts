import { describe, it, expect } from 'vitest'

import {
  HARDENED_SESSION_TRANSPORT,
  MIN_SESSION_PASSWORD_LENGTH,
  SESSION_PASSWORD_ENV,
  evaluateSessionHardening,
  formatHardeningFailure,
  toPositiveSeconds,
  type HardeningContext,
  type SessionHardeningInput,
} from '~/server/utils/session-hardening'

/**
 * A seal key that passes every rule, so a test about cookies is not also a test
 * about passwords. Obviously fake, and long enough for iron-webcrypto.
 */
const GOOD_PASSWORD = 'mock-session-seal-key-q7Wd3Zt9Rb2Yh5Nk'

/** What `nuxt.config.ts` actually ships, plus the two keys it sets by hand. */
const SHIPPED: SessionHardeningInput = {
  name: 'nuxt-session',
  maxAge: 60 * 60 * 24 * 7,
  ...HARDENED_SESSION_TRANSPORT,
}

function evaluate(
  session: SessionHardeningInput | undefined,
  context: Partial<HardeningContext> = {},
) {
  return evaluateSessionHardening(session, {
    password: GOOD_PASSWORD,
    dev: false,
    prerender: false,
    ...context,
  })
}

/** The fatal problems, as one string, for `toContain` assertions. */
function fatalText(session: SessionHardeningInput, context: Partial<HardeningContext> = {}) {
  return evaluate(session, context).fatal.join('\n')
}

describe('HARDENED_SESSION_TRANSPORT', () => {
  it('is what nuxt.config.ts ships, and passes its own audit', () => {
    // The constant and the checks are in one module on purpose; this is the test
    // that they agree, so a weakened default cannot pass by also weakening the
    // rule that would have caught it.
    expect(evaluate(SHIPPED)).toEqual({ fatal: [], warnings: [] })
  })

  it('disables the session request header with the boolean, not a string', () => {
    // h3 tests `config.sessionHeader !== false`, so only the boolean turns the
    // header path off. This pins the type, not just the value.
    expect(HARDENED_SESSION_TRANSPORT.sessionHeader).toBe(false)
  })

  it('states all four cookie attributes rather than leaning on defaults', () => {
    expect(HARDENED_SESSION_TRANSPORT.cookie).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
  })
})

describe('evaluateSessionHardening — transport', () => {
  it('rejects a config with no session block at all', () => {
    expect(evaluate(undefined).fatal).toHaveLength(1)
  })

  it('rejects the session request header being left enabled', () => {
    const { sessionHeader: _removed, ...rest } = SHIPPED
    void _removed

    expect(fatalText(rest)).toContain('x-nuxt-session-session')
  })

  it('rejects the string "false", which h3 would treat as enabled', () => {
    // The failure this exists for: an environment variable that Nuxt could not
    // coerce arrives as a string, `"false" !== false`, and the header path stays
    // open while every config dump reads as though it were closed.
    const problems = fatalText({ ...SHIPPED, sessionHeader: 'false' })

    expect(problems).toContain('sessionHeader is "false"')
    expect(problems).toContain('not the boolean false')
  })

  it('names the header it would accept, using the configured session name', () => {
    expect(fatalText({ ...SHIPPED, name: 'my-app', sessionHeader: true })).toContain(
      'x-my-app-session',
    )
  })

  it('rejects httpOnly being turned off', () => {
    const session = {
      ...SHIPPED,
      cookie: { ...HARDENED_SESSION_TRANSPORT.cookie, httpOnly: false },
    }

    expect(fatalText(session)).toContain('httpOnly is false')
  })

  it('rejects httpOnly merely being absent', () => {
    // h3's own default would still set it. The point is that this app does not
    // find that out from h3's changelog.
    const session = { ...SHIPPED, cookie: { secure: true, sameSite: 'lax', path: '/' } }

    expect(fatalText(session)).toContain('httpOnly is unset')
  })

  it('rejects a cookie-less session config, which would issue sessions and lose them', () => {
    expect(fatalText({ ...SHIPPED, cookie: false })).toContain('cookie is false')
  })

  it('reports only the cookie problem when the cookie is disabled outright', () => {
    // Listing four missing attributes on a cookie that is not being set would
    // bury the one thing wrong.
    expect(evaluate({ ...SHIPPED, cookie: false }).fatal).toHaveLength(1)
  })

  it('rejects secure being turned off', () => {
    const session = { ...SHIPPED, cookie: { ...HARDENED_SESSION_TRANSPORT.cookie, secure: false } }

    expect(fatalText(session)).toContain('secure is false')
  })

  it('rejects SameSite=None, which is what makes a session CSRF-reachable', () => {
    const session = {
      ...SHIPPED,
      cookie: { ...HARDENED_SESSION_TRANSPORT.cookie, sameSite: 'none' },
    }

    expect(fatalText(session)).toContain('CSRF-reachable')
  })

  it('accepts strict, which is stricter than what this app needs', () => {
    const session = {
      ...SHIPPED,
      cookie: { ...HARDENED_SESSION_TRANSPORT.cookie, sameSite: 'strict' },
    }

    expect(evaluate(session).fatal).toEqual([])
  })

  it('rejects sameSite being left to the browser', () => {
    const session = { ...SHIPPED, cookie: { httpOnly: true, secure: true, path: '/' } }

    expect(fatalText(session)).toContain('sameSite is unset')
  })

  it('rejects a narrowed cookie path', () => {
    const session = { ...SHIPPED, cookie: { ...HARDENED_SESSION_TRANSPORT.cookie, path: '/api' } }

    expect(fatalText(session)).toContain('path is "/api"')
  })

  it('rejects a missing or unusable maxAge', () => {
    for (const maxAge of [undefined, 0, -1, 'soon']) {
      expect(fatalText({ ...SHIPPED, maxAge })).toContain('maxAge is')
    }
  })

  it('accepts a maxAge that arrived from the environment as a string', () => {
    expect(evaluate({ ...SHIPPED, maxAge: '604800' }).fatal).toEqual([])
  })

  it('collects every problem in one pass rather than stopping at the first', () => {
    // An operator fixing a deployment should get the whole list in one boot.
    const report = evaluate({ maxAge: 0, sessionHeader: true, cookie: { httpOnly: false } })

    expect(report.fatal.length).toBeGreaterThanOrEqual(5)
  })
})

describe('evaluateSessionHardening — seal key', () => {
  it('accepts a generated-looking key', () => {
    expect(evaluate(SHIPPED, { password: GOOD_PASSWORD }).fatal).toEqual([])
  })

  it('refuses to serve with no key', () => {
    const report = evaluate(SHIPPED, { password: '' })

    expect(report.fatal.join('\n')).toContain(SESSION_PASSWORD_ENV)
    expect(report.warnings).toEqual([])
  })

  it('only warns about a missing key in dev, where the module generates one', () => {
    const report = evaluate(SHIPPED, { password: '', dev: true })

    expect(report.fatal).toEqual([])
    expect(report.warnings).toHaveLength(1)
  })

  it('only warns about a missing key while prerendering, which renders no session', () => {
    // `pnpm build` on a machine with no secrets is a supported thing to do, and
    // this plugin runs inside the prerenderer's Nitro instance.
    const report = evaluate(SHIPPED, { password: '', prerender: true })

    expect(report.fatal).toEqual([])
    expect(report.warnings).toHaveLength(1)
  })

  it('rejects a key that is too short for iron-webcrypto', () => {
    const short = 'x7Qm2Vp9Zt4Bn'

    expect(short.length).toBeLessThan(MIN_SESSION_PASSWORD_LENGTH)
    expect(fatalText(SHIPPED, { password: short })).toContain('iron-webcrypto needs at least')
  })

  it('rejects a short key in dev too — there is no environment where it is right', () => {
    expect(evaluate(SHIPPED, { password: 'too-short', dev: true }).fatal).not.toEqual([])
  })

  it('rejects the placeholder from .env.example, which is long enough to pass on length', () => {
    const placeholder = 'your-super-secret-session-password-at-least-32-chars'

    expect(placeholder.length).toBeGreaterThanOrEqual(MIN_SESSION_PASSWORD_LENGTH)
    expect(fatalText(SHIPPED, { password: placeholder })).toContain('.env.example')
  })

  it('names the marker it matched but never echoes the key itself', () => {
    const problems = fatalText(SHIPPED, { password: 'change-me-change-me-change-me-change-me' })

    expect(problems).toContain('"change-me"')
    expect(problems).not.toContain('change-me-change-me-change-me-change-me')
  })

  it('rejects padding that satisfies the length rule', () => {
    expect(fatalText(SHIPPED, { password: 'a'.repeat(64) })).toContain('distinct characters')
  })

  it('reports one problem per key, not both the marker and the padding', () => {
    // `your-your-your…` is both. Two messages about one setting is noise.
    const report = evaluate(SHIPPED, { password: 'your-'.repeat(10) })

    expect(report.fatal).toHaveLength(1)
  })
})

describe('formatHardeningFailure', () => {
  it('numbers the problems and points at the doc', () => {
    const message = formatHardeningFailure({ fatal: ['first thing', 'second thing'], warnings: [] })

    expect(message).toContain('2 problems')
    expect(message).toContain('1. first thing')
    expect(message).toContain('2. second thing')
    expect(message).toContain('docs/session-security.md')
  })

  it('says "problem" for one', () => {
    expect(formatHardeningFailure({ fatal: ['only thing'], warnings: [] })).toContain('1 problem)')
  })
})

describe('toPositiveSeconds', () => {
  it('accepts a number and a numeric string', () => {
    expect(toPositiveSeconds(900)).toBe(900)
    expect(toPositiveSeconds('900')).toBe(900)
  })

  it('floors a fractional value rather than passing it on', () => {
    expect(toPositiveSeconds(900.9)).toBe(900)
  })

  it('rejects everything that is not a usable lifetime', () => {
    for (const value of [undefined, 0, -1, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toPositiveSeconds(value)).toBeNull()
    }
  })
})
