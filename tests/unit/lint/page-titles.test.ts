import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pageTitle } from '../../../utils/routeNavigation'

/**
 * Every page names itself, and no two pages name themselves the same thing.
 *
 * This is the gate that makes the route announcer work, which is why it is a test
 * rather than a convention. `app.vue` builds both the document `<title>` and the
 * announcement from `definePageMeta({ title })`, and a live region announces a
 * *change* to its contents — so two consecutive pages whose titles are identical
 * produce no announcement at all. Not a mutation a screen reader ignores: no
 * mutation. The region is assigned the string it already holds, Vue does not
 * re-render, and nothing is said.
 *
 * That was the state of this app. `<NuxtRouteAnnouncer />` was mounted and read
 * `document.title`, twelve of the twenty-four pages declared no title, and every
 * one of those fell back to the same `titleTemplate` default — so navigating
 * between any two of them announced nothing while looking, in the markup, exactly
 * like a working announcer. The same twelve pages also shared one `<title>`, which
 * is SC 2.4.2 failed in substance while `document-title` (axe only checks that the
 * element is non-empty) reported clean on all of them.
 *
 * ## What this does not check
 *
 * That a title *describes* its page — "Page 4" would satisfy every rule here.
 * And it says nothing about dynamic routes: `/orders/[id]` would give every order
 * one title, and the announcement for the second one in a row would be silent for
 * the reason above. `useRouteAnnouncement` handles that case at runtime by
 * clearing the region first; this test is what keeps the static routes in `pages/`
 * from needing it.
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
 * A page's `<script setup>` block with its comments removed.
 *
 * Both halves matter, and both were found by this test failing. Several pages
 * document `definePageMeta` in a block comment above the real call —
 * `pages/rendering/ssg.vue` opens with `* definePageMeta({ prerender: true }) tells
 * the Nuxt build to …` — and others hold the macro's own source as a string in a
 * code sample rendered by the template (`pages/rendering/index.vue`). Searching the
 * whole file finds the prose first and the declaration never.
 *
 * The line-comment pattern refuses a `//` preceded by `:` or `/` so that a URL in
 * a comment or a string does not swallow the rest of its line.
 */
function scriptBody(source: string): string {
  const script = /<script setup[^>]*>([\s\S]*?)<\/script>/.exec(source)
  return (script?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:/])\/\/[^\n]*/g, '')
}

/**
 * The `title` a page declares, read out of its source.
 *
 * `definePageMeta` is a compiler macro: its argument is extracted at build time
 * and never evaluated, so there is no module to import and ask. Reading the source
 * is the only way to answer this without a Nuxt build, which is what keeps this
 * check in `pnpm test` rather than behind the multi-minute a11y job.
 *
 * Deliberately narrow, and it accepts only what this project writes: a single
 * quoted literal on the `title` key, on one line or inside a multi-line call (see
 * `pages/rendering/ssg.vue`). Anything else — a computed title, a nested object
 * that ends the match early — reads as absent and fails the first test below
 * rather than being quietly skipped. That is the right direction to fail in: a
 * title assembled at runtime cannot be checked for uniqueness here, and whoever
 * writes the first one should have to decide what this gate does about it.
 */
function declaredTitle(source: string): string | null {
  const call = /definePageMeta\(\{([\s\S]*?)\}\)/.exec(scriptBody(source))
  if (call?.[1] === undefined) return null

  const title = /(?:^|[\s,{])title:\s*(['"])(.*?)\1/.exec(call[1])
  if (title?.[2] === undefined) return null

  return pageTitle({ title: title[2] })
}

const pages = await pageFiles()
const titles = new Map<string, string | null>(
  await Promise.all(
    pages.map(
      async (file) =>
        [file, declaredTitle(await readFile(path.join(repoRoot, file), 'utf8'))] as const,
    ),
  ),
)

describe('page titles', () => {
  it('found pages to check', () => {
    // Without this, a `pages/` that moved or a glob that stopped matching would
    // turn both assertions below into zero-length loops that still report green.
    expect(pages.length).toBeGreaterThanOrEqual(20)
    expect(pages).toContain('pages/index.vue')
    expect(pages).toContain('pages/rendering/ssg.vue')
  })

  it('every page declares a non-empty title in definePageMeta', () => {
    const missing = [...titles].filter(([, title]) => title === null).map(([file]) => file)

    expect(
      missing,
      `${missing.length} page(s) declare no title, so they fall back to the bare product ` +
        `name — identical to each other, which is both SC 2.4.2 in substance and a ` +
        `route announcement that cannot fire:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('no two pages share a title', () => {
    const byTitle = new Map<string, string[]>()
    for (const [file, title] of titles) {
      if (title === null) continue
      byTitle.set(title, [...(byTitle.get(title) ?? []), file])
    }

    const duplicated = [...byTitle]
      .filter(([, files]) => files.length > 1)
      .map(([title, files]) => `${title} — ${files.join(', ')}`)

    expect(
      duplicated,
      `pages sharing a title announce nothing when one follows the other:\n  ` +
        duplicated.join('\n  '),
    ).toEqual([])
  })
})
