import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import axe from 'axe-core'
import { describe, expect, it } from 'vitest'

import {
  AUDITED_ROUTES,
  COLOUR_SCHEMES,
  RULES_AXE_SHIPS_DISABLED,
  RULES_OMITTED_WHEN_NOTHING_MATCHES,
  WCAG_22_AA_TAGS,
} from '../../../a11y.config'

/**
 * The gate behind the gate: `a11y.config.ts` still describes a real audit.
 *
 * `tests/e2e/a11y.test.ts` needs a browser, a build and a server, which means it
 * runs in its own CI job and takes minutes. Nothing in it can detect the two ways
 * an axe gate stops being one, because both make it *pass*:
 *
 *  1. **It audits fewer rules than it claims.** The tag list is the whole of the
 *     audit's coverage, and axe treats an unknown tag as "no rules matched"
 *     rather than as an error — so a typo narrows the gate silently and it still
 *     reports zero violations. The rules here resolve the tag list against axe's
 *     own metadata in both directions, and keep the opt-in list equal to the
 *     disabled rules actually inside the set, so an axe release that moves a
 *     rule lands as a failure with a name that says so rather than as a quietly
 *     smaller audit.
 *
 *  2. **It audits fewer pages than exist.** A route table maintained by memory
 *     is a table new pages are missing from. `pages/` is walked below and every
 *     file has to appear in `AUDITED_ROUTES`, so a page is audited from the
 *     commit that adds it or `pnpm test` fails.
 *
 * Neither of these is hypothetical: both are how an accessibility gate comes to
 * be green for a year while the app regresses underneath it.
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..')

/** Every `.vue` file under `pages/`, repo-relative, with `/` separators. */
async function pageFiles(dir = 'pages'): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await pageFiles(relative)))
    else if (entry.name.endsWith('.vue')) found.push(relative)
  }

  return found.sort()
}

/**
 * The route Nuxt serves a page file at.
 *
 * Only the two conventions this project uses — `index.vue` naming a directory,
 * and a plain filename naming a path segment. A dynamic segment (`[id].vue`)
 * would need a parameter to visit and so would need a decision from whoever adds
 * the first one; `throw` rather than guess, so that decision cannot be made by
 * this helper's default.
 */
function routeForPage(file: string): string {
  const withoutExtension = file.replace(/^pages\//, '').replace(/\.vue$/, '')
  if (/\[|\]/.test(withoutExtension)) {
    throw new Error(
      `${file} is a dynamic route. a11y.config.ts needs a concrete path to visit — ` +
        `add one, and teach this helper how the two relate.`,
    )
  }
  const segments = withoutExtension.replace(/(^|\/)index$/, '')
  return `/${segments}`
}

describe('the WCAG 2.2 AA tag set', () => {
  it('names only tags axe-core knows, and each selects at least one rule', () => {
    const empty = WCAG_22_AA_TAGS.filter((tag) => axe.getRules([tag]).length === 0)

    // A typo here is the cheapest way to produce a gate that checks nothing:
    // axe treats an unknown tag as "no rules matched" rather than as an error.
    expect(empty, `tags matching no axe rule: ${empty.join(', ')}`).toEqual([])
  })

  it('covers every Level A and AA rule axe-core implements', () => {
    const selected = new Set(axe.getRules([...WCAG_22_AA_TAGS]).map((rule) => rule.ruleId))

    // Anything axe tags as a WCAG success criterion at A or AA, found from the
    // other direction: by `wcagNNN` criterion tags rather than by level tags, so
    // a rule whose level tag is missing or new still shows up.
    const missing = axe
      .getRules()
      .filter((rule) => {
        const tags = rule.tags
        if (tags.some((tag) => tag.endsWith('-obsolete'))) return false
        // AAA-only and best-practice rules are out of scope by design.
        if (
          tags.includes('wcag2aaa') &&
          !tags.some((t) => /^wcag2a$|^wcag2aa$|^wcag21|^wcag22/.test(t))
        ) {
          return false
        }
        return (
          tags.some((tag) => /^wcag\d{3,4}$/.test(tag)) &&
          !tags.includes('wcag2aaa') &&
          !selected.has(rule.ruleId)
        )
      })
      .map((rule) => `${rule.ruleId} [${rule.tags.join(' ')}]`)

    expect(
      missing,
      `axe implements A/AA rules this tag list does not select:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })
})

/**
 * Rule ids axe-core ships with `enabled: false`.
 *
 * Read from `axe._audit`, which is the only place the flag is legible: the public
 * `getRules()` omits it, the published `axe.d.ts` has no accessor for it, and the
 * alternative — pinning the set as a literal — would be a list that has to be
 * re-read by hand on every bump and that says nothing in the gap.
 *
 * Reading an internal is safe *here* because the failure direction is right. If
 * the shape ever changes, this throws or returns an empty set, and
 * the first assertion below fails on it — a loud failure in a test named
 * for the thing that broke, rather than a vacuous pass that would let the audit
 * silently stop covering WCAG 2.2.
 */
function disabledByDefault(): Set<string> {
  const internals = axe as unknown as {
    _audit?: { rules?: { id?: unknown; enabled?: unknown }[] }
  }
  const rules = internals._audit?.rules
  if (!Array.isArray(rules)) return new Set()

  return new Set(
    rules
      .filter((rule) => rule.enabled === false && typeof rule.id === 'string')
      .map((rule) => rule.id as string),
  )
}

describe('rules axe-core ships disabled', () => {
  const disabled = disabledByDefault()

  it('can still read the flag out of axe-core', () => {
    // The guard on the accessor above. Without it, an axe release that moved
    // `_audit` would make every assertion below pass over an empty set, which is
    // precisely the quiet failure this file exists to prevent.
    expect(
      disabled.size,
      'axe._audit.rules no longer reports an `enabled` flag — the accessor above needs updating',
    ).toBeGreaterThan(0)
    expect(disabled).toContain('color-contrast-enhanced')
  })

  it('states every disabled rule that falls inside the audited tag set', () => {
    const inScope = axe
      .getRules([...WCAG_22_AA_TAGS])
      .map((rule) => rule.ruleId)
      .filter((id) => disabled.has(id))
      .sort()

    // `target-size` is the only rule axe implements for a criterion WCAG 2.2
    // introduced at AA, and it is one of the rules axe ships off — which is why
    // the audit names it explicitly. Whether it *ran* is answered in the browser
    // by `tests/e2e/a11y.test.ts`, not here.
    expect(inScope).toContain('target-size')

    // Equality, not containment: a future axe release that disables another rule
    // in this set fails here until someone decides, in a commit, whether to turn
    // it on or to narrow the claim.
    expect(Object.keys(RULES_AXE_SHIPS_DISABLED).sort()).toEqual(inScope)
  })

  it('says why axe holds each one back', () => {
    const known = new Set(axe.getRules().map((rule) => rule.ruleId))

    for (const [id, reason] of Object.entries(RULES_AXE_SHIPS_DISABLED)) {
      expect(known, `${id} is not an axe rule`).toContain(id)
      // Long enough to be a reason rather than a label: the field exists so a
      // reader can judge the opt-in without reading axe's source.
      expect(reason.length, `${id} has no real justification`).toBeGreaterThan(80)
    }
  })
})

describe('rules axe omits when nothing matches', () => {
  it('names real axe rules that are inside the audited tag set', () => {
    const inScope = new Set(axe.getRules([...WCAG_22_AA_TAGS]).map((rule) => rule.ruleId))

    // The list is an allowance the e2e coverage check honours, so an entry that is
    // not a rule — or not a rule this audit selects — is an allowance for nothing
    // and hides a typo.
    for (const id of RULES_OMITTED_WHEN_NOTHING_MATCHES) {
      expect(inScope, `${id} is not a rule this audit selects`).toContain(id)
    }
  })

  it('does not excuse target-size', () => {
    // `target-size` matches every interactive control, so it always has nodes on a
    // real page. Listing it here would be the one entry that silently removes WCAG
    // 2.2 from a gate named for it.
    expect(RULES_OMITTED_WHEN_NOTHING_MATCHES).not.toContain('target-size')
  })
})

describe('the audited route table', () => {
  it('has an entry for every page, so a new page cannot be born exempt', async () => {
    const files = await pageFiles()
    const audited = new Set(AUDITED_ROUTES.map((route) => route.page))

    const unaudited = files.filter((file) => !audited.has(file))
    expect(
      unaudited,
      `pages with no entry in a11y.config.ts:\n  ${unaudited.join('\n  ')}`,
    ).toEqual([])
  })

  it('names page files that exist, at the route Nuxt serves them at', async () => {
    for (const route of AUDITED_ROUTES) {
      const absolute = path.join(repoRoot, route.page)
      await expect(
        stat(absolute).then((s) => s.isFile()),
        `${route.path} cites ${route.page}, which is not a file`,
      ).resolves.toBe(true)

      expect(routeForPage(route.page), `${route.page} is served at a different path`).toBe(
        route.path,
      )
    }
  })

  it('lists each path once', () => {
    const paths = AUDITED_ROUTES.map((route) => route.path)
    expect([...new Set(paths)]).toHaveLength(paths.length)
  })

  it('agrees with the auth middleware about which routes are public', async () => {
    const middleware = await readFile(path.join(repoRoot, 'middleware/auth.global.ts'), 'utf8')
    const block = /const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/.exec(middleware)?.[1]
    expect(block, 'PUBLIC_PATHS is no longer a literal Set this test can read').toBeTruthy()

    const publicPaths = new Set([...(block ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]))

    // The two lists are maintained separately and have to agree: an `access` of
    // `session` on a public route wastes a sign-in, and `guest` on a gated one
    // audits the login form while reporting the gated route's name. The e2e
    // suite also asserts the landed path, so this is the cheap half of the same
    // check — it fails in `pnpm test` rather than after a build.
    for (const route of AUDITED_ROUTES) {
      const expected = publicPaths.has(route.path) ? 'guest' : 'session'
      expect(route.access, `${route.path} is ${expected} according to the middleware`).toBe(
        expected,
      )
    }
  })
})

describe('the colour schemes', () => {
  it('audits both palettes, because the dark tokens are a separate palette', () => {
    // `assets/css/tailwind.css` redefines every `--color-*` under `.dark`. A
    // light-only audit measures none of those values, so a dark-mode contrast
    // regression would ship green.
    expect([...COLOUR_SCHEMES]).toEqual(['light', 'dark'])
  })
})
