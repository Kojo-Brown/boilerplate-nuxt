import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { beforeAll, describe, expect, it } from 'vitest'

import { MAIN_CONTENT_ID } from '~/utils/routeNavigation'

/**
 * What the server sends, before a line of JavaScript runs.
 *
 * The component suite (`tests/nuxt/`) cannot answer any of this. Its
 * environment is a Nuxt app booted in happy-dom — a client — so "is this in the
 * server's HTML", "does this script run before the first paint" and "is this
 * route sent as an empty shell" are all unaskable there. These tests read the
 * bytes instead, from a real Nuxt server that `@nuxt/test-utils/e2e` starts for
 * the whole project.
 *
 * A dev server rather than a production build: the markup assertions below are
 * about what the renderer produces, which is the same either way, and a build
 * would add minutes to `pnpm test` to re-measure what `pnpm build` and the a11y
 * job already cover. The one claim that is build-specific — the client bundle's
 * size — has its own gate in `scripts/assert-bundle-budget.ts`.
 *
 * Every assertion here is about SSR specifically. Anything that is true of the
 * rendered DOM in general belongs in the component suite, where it costs
 * milliseconds instead of a server.
 */
await setup({ dev: true, server: true, browser: false })

describe('server-rendered HTML', () => {
  let login = ''

  beforeAll(async () => {
    login = await $fetch<string>('/login')
  })

  it('renders the page content, not a shell for the client to fill', async () => {
    // The login form is in the document the browser receives: visible without
    // JavaScript, and indexable. The same assertion is what would fail if the
    // page accidentally became client-only.
    expect(login).toContain('Sign in to your account')
    expect(login).toContain('Email address')
    expect(login).toContain('autocomplete="email"')
  })

  it('carries the locale on <html>, resolved to a BCP 47 tag', async () => {
    // `lang` has to be in the server's HTML: a screen reader picks its voice
    // from the document it loads, not from one a hydration later. `en-US` rather
    // than `en` — the URL prefix is `en`, the language tag is not. See app.vue.
    expect(login).toMatch(/<html[^>]*lang="en-US"/)
    expect(login).toMatch(/<html[^>]*dir="ltr"/)
  })

  it('puts the skip link before the content it skips', async () => {
    const skipLink = login.indexOf(`href="#${MAIN_CONTENT_ID}"`)
    const main = login.indexOf(`<main id="${MAIN_CONTENT_ID}"`)

    // A bypass block has to be the first focusable element, and "first" is a
    // fact about document order — so it is a fact about this string, and about
    // nothing a test in a DOM can see once the document is already parsed.
    expect(skipLink).toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(-1)
    expect(skipLink).toBeLessThan(main)
  })

  it('runs the colour-mode script before any app markup', async () => {
    const helper = login.indexOf('__NUXT_COLOR_MODE__')
    const app = login.indexOf('id="__nuxt"')

    // This is the whole mechanism behind `@nuxtjs/color-mode` being flash-free:
    // a blocking inline script that puts the class on `<html>` before the
    // browser paints. A deferred script, or one after the app, means a white
    // flash on every load for every dark-mode user — and the page would look
    // correct in every DOM-level test.
    expect(helper).toBeGreaterThan(-1)
    expect(helper).toBeLessThan(app)
  })

  it('leaves the live region empty on the server', async () => {
    // `AppRouteAnnouncer` renders a live region with nothing in it, which is
    // what keeps the first page load quiet: a screen reader announces changes to
    // a region it is already watching, and says nothing about one that arrives
    // with its text already in place. Server markup is the only place that is
    // observable.
    expect(login).toMatch(/<p class="sr-only" role="status" aria-live="polite"><\/p>/)
  })

  it('omits <ClientOnly> content from the server render', async () => {
    // The language/colour-mode cluster is client-only, so it must not be in the
    // HTML — markup that renders on the server and not on the client (or the
    // reverse) is a hydration mismatch. `tests/nuxt/languageSwitcher...` is
    // where that select is asserted to exist, once there is a client.
    expect(login).not.toContain('id="language-select"')
    expect(login).not.toContain('Switch to dark mode')
  })

  it('sends a page marked ssr: false as an empty shell', async () => {
    const spa = await $fetch<string>('/rendering/spa')

    // `definePageMeta({ ssr: false })` is a routing claim with no DOM
    // consequence once the page has hydrated: the only difference between this
    // page and a server-rendered one is in the bytes.
    expect(spa).toContain('id="__nuxt"')
    expect(spa).not.toContain('This page is rendered entirely in the browser')
    expect(spa).not.toContain('Loading in browser')
    // Not even the title the page declares: with `ssr: false` nothing of the
    // page is rendered, so `definePageMeta({ title })` reaches the document
    // only once the client has it.
    expect(spa).not.toContain('SPA — Client-Side Rendering')
  })

  it('serialises no server-only runtime config into the payload', async () => {
    // Everything under `runtimeConfig.public` is in the HTML by design; nothing
    // else may be. The keys below are the ones that would hurt — a database URL,
    // AWS credentials, the session and ticket signing keys — and `CLAUDE.md`'s
    // rule about them is only as good as something that checks the output.
    for (const key of [
      'databaseUrl',
      'awsAccessKeyId',
      'awsSecretAccessKey',
      'ticketSecret',
      'sessionRotation',
    ]) {
      expect(login).not.toContain(key)
    }

    expect(login).toContain('webVitals')
  })
})
