# Component testing

Until now this project's unit suite ran entirely in Vitest's `node` environment,
with Nuxt's auto-imports stubbed in [`tests/setup.ts`](../tests/setup.ts). That
is the right environment for a composable, a store or a server util — code that
is Nuxt-flavoured TypeScript and nothing more — and it cannot mount a component.
`.vue` files were the gap: of the two thousand-odd tests in it, the only ones
that rendered anything were [`dataTable.test.ts`](../tests/unit/components/dataTable.test.ts), which
renders two `.tsx` render functions through `vue/server-renderer` because they
happen to need no Nuxt at all.

A single-file component usually does. `AppSkipLink` calls `useI18n()`,
`ColorModeToggle` goes through `@nuxtjs/color-mode`'s plugin and a Pinia store,
`ContentIndex` awaits `$fetch` in its `setup()`, and `app.vue` resolves
`<ClientOnly>` and `<NuxtPage>`. Stubbing all of that is possible and pointless:
the test then measures the stubs.

So there are now three suites, in two configs:

| Suite       | Environment        | Config                                              | What it is for                                     |
| ----------- | ------------------ | --------------------------------------------------- | -------------------------------------------------- |
| `unit`      | `node`             | [`vitest.config.ts`](../vitest.config.ts)           | Composables, stores, utils, server handlers.       |
| `component` | `nuxt` (happy-dom) | [`vitest.nuxt.config.ts`](../vitest.nuxt.config.ts) | Mounting components in a real Nuxt app.            |
| `ssr`       | `node` + a server  | [`vitest.nuxt.config.ts`](../vitest.nuxt.config.ts) | Assertions about the HTML a server actually sends. |

```
pnpm test        # all three — what CI runs
pnpm test:unit   # the node suite, ~25s, no Nuxt boot
pnpm test:nuxt   # component + ssr
pnpm test:nuxt --project component   # the inner loop while writing one
```

The split is a cost, not a preference. Resolving `vitest.nuxt.config.ts` boots
Nuxt to borrow its Vite config, which takes about twenty seconds before a single
test collects; charging that to every run of the node suite would make the fast
suite slow for the benefit of fifty tests.

## The component suite

[`@nuxt/test-utils`](https://nuxt.com/docs/getting-started/testing) provides the
`nuxt` environment: Nuxt's own Vite config, a Nuxt app booted in happy-dom, and
`mountSuspended` to mount into it.

```ts
import { mountSuspended } from '@nuxt/test-utils/runtime'

const button = await mountSuspended(AppButton, { slots: { default: () => 'Save' } })
expect(button.get('button').attributes('type')).toBe('button')
```

What it adds over `@vue/test-utils`' own `mount`:

- **Auto-imports resolve.** `useI18n`, `useColorMode`, `usePreferencesStore`,
  `MAIN_CONTENT_ID` — the test imports none of them and the component gets the
  real ones. Tests may call them too, with one caveat: a composable throws
  outside a `setup()`, so a test body reads app-wide i18n state through
  `useNuxtApp().$i18n` rather than `useI18n()`
  ([`languageSwitcher.nuxt.test.ts`](../tests/nuxt/languageSwitcher.nuxt.test.ts)).
- **Module plugins run.** `@nuxtjs/color-mode` really puts a class on `<html>`
  ([`colorModeToggle.nuxt.test.ts`](../tests/nuxt/colorModeToggle.nuxt.test.ts)),
  `@nuxtjs/i18n` really resolves `i18n/locales/*.json`.
- **It awaits an async `setup()`.** A component that awaits `$fetch` at the top
  level of `setup()` is a Suspense boundary, and `mount` would hand back a
  wrapper holding the fallback. `mountSuspended` resolves it first — which is
  what the name is about.
- **`registerEndpoint` answers `$fetch`.** `$fetch` inside the environment is
  routed to an h3 app the test owns, so a route is served without a server, a
  database, or a stubbed global `fetch`
  ([`contentIndex.nuxt.test.ts`](../tests/nuxt/contentIndex.nuxt.test.ts)).

`mockNuxtImport` and `mockComponent` are available and are deliberately unused
here. The suite exists to get the real auto-imports; a test that mocks them is a
node-environment test paying twenty seconds for the privilege. Reach for them
when the real thing cannot exist in a test — a module that talks to a third
party, say — and not to avoid arranging state.

### Three things that bite

**One Nuxt app serves a whole file.** `useState`, the i18n locale, the colour
mode and every Pinia store persist from test to test within a file, and nothing
resets them between files either. Tests that change app-wide state put it back:
`beforeEach` in the colour-mode tests, `afterEach` in the i18n ones.

**Teleported markup outlives its wrapper.** `AppModal` teleports to
`document.body`, which `mountSuspended` does not own, so a modal left mounted is
a dialog the next test's `document.body` query finds. Each test in
[`appModal.nuxt.test.ts`](../tests/nuxt/appModal.nuxt.test.ts) unmounts its own
through `onTestFinished`.

**An async handler needs more than a tick.** `LanguageSwitcher`'s `change`
handler awaits `setLocale`, which resolves a route before it commits;
`await nextTick()` is a microtask short. `flushPromises()` from
`@vue/test-utils`, then `nextTick`.

One more, which is about what a passing test proves rather than about the
environment: a leaked `document` listener fires on an unmounted component, whose
`emit` goes nowhere. "Press Escape after unmount and assert nothing was emitted"
passes whether or not the component cleaned up. The cleanup test in
`appModal.nuxt.test.ts` compares handler identity between
`addEventListener` and `removeEventListener` instead, and was checked against the
mutation it is meant to catch — deleting the `onUnmounted` call fails that test
and only that test.

## The SSR suite

The component environment is a client: a Nuxt app in a DOM. "Is this in the
server's HTML", "does this script run before the first paint" and "is this route
sent as an empty shell" are unaskable there, and they are the questions a
server-rendered app most needs answered, because none of them has a DOM-level
consequence once the page has hydrated. A `<ClientOnly>` that renders on the
server is a hydration mismatch, and the hydrated DOM looks identical.

So [`tests/ssr/render.test.ts`](../tests/ssr/render.test.ts) reads the bytes,
from a real Nuxt server that `@nuxt/test-utils/e2e` starts for the project:

```ts
await setup({ dev: true, server: true, browser: false })

const login = await $fetch<string>('/login')
expect(login).toMatch(/<html[^>]*lang="en-US"/)
```

A dev server, not a production build: the markup is what the renderer produces
and that is the same either way, while a build would add minutes to `pnpm test`
to re-measure what `pnpm build` and the WCAG audit job already cover. The one
claim that is genuinely build-specific — the size of the client bundle — has its
own gate in [`scripts/assert-bundle-budget.ts`](../scripts/assert-bundle-budget.ts).

What is in there now: that `/login` arrives rendered rather than as a shell, that
`<html lang>` is set on the server (a screen reader picks its voice from the
document it loads), that the skip link precedes `<main>` in document order, that
the colour-mode script is before the app markup, that the route announcer's live
region is empty, that `<ClientOnly>` content is absent, that `/rendering/spa`
ships no page content, and that no server-only runtime config is serialised into
the payload.

Only put a test here if it is about SSR specifically. Anything true of the
rendered DOM in general belongs in the component suite, where it costs
milliseconds instead of a server.

## Setup, and two Nuxt-version problems it works around

Both are in [`vitest.nuxt.config.ts`](../vitest.nuxt.config.ts), with the
reasoning next to the code. They are recorded here because the first one's
failure mode gives you nothing to search for.

**Nuxt 4.5 hands Vitest a plugin Vitest cannot run.** Nuxt's `nuxt:replace`
plugin — what turns `import.meta.client` into `true` — returns rolldown's native
`replacePlugin`, a `BuiltinPlugin` that only Vite 8's rolldown pipeline executes.
Nuxt builds on Vite 8; Vitest 3 runs on Vite 7. Handed to Vite 7 it throws a bare
object, and the whole run fails with

```
Unhandled Error: [object Object]
```

no stack, no file, before a single test collects. Dropping the plugin is not an
option either: Vite's own `define` does not substitute `import.meta.*` in the
dev/SSR transform these tests go through, and Nuxt's app entry assigns the
function that boots the app inside `if (import.meta.client)` — so without the
substitution, `TypeError: entry is not a function` and no Nuxt app at all. The
config replaces it with `@rollup/plugin-replace`, whose API rolldown's copies,
over the same `import.meta.*` keys from the same `define` map. Two guards throw
if Nuxt stops registering that plugin or stops defining those keys, because
either means the workaround is now describing a Nuxt that does not exist.

**`@nuxtjs/color-mode` needs its inline script.** The module's flash-free
behaviour comes from a blocking script in `<head>` that sets the class on
`<html>` before the first paint; its client plugin then reads the helper that
script left on `window`. There is no document to inject it into in a test, so the
plugin finds `{}` and the first watcher call dies on
`helper.getColorScheme is not a function` — reported inside whichever test
mounted something, not in the module that caused it.
[`tests/nuxt/setup.ts`](../tests/nuxt/setup.ts) installs the helper, built from
the same `#color-mode-options` the app is built from. It has to run before
`@nuxt/test-utils`' own setup entry, which creates the app as it is imported, so
the config unshifts it onto `setupFiles` rather than declaring it there.

## What this does not cover

- **Hydration mismatches.** The two suites approach the seam from either side —
  server markup in one, mounted DOM in the other — and neither hydrates server
  HTML into a client app, which is the only way to actually observe a mismatch.
- **A browser engine.** happy-dom is not Chromium: no layout, no real computed
  styles, no paint. Anything that depends on them is Playwright's
  ([`playwright.a11y.config.ts`](../playwright.a11y.config.ts), the WCAG job).
- **Coverage.** `vitest.config.ts`'s thresholds measure the node suite only; the
  component suite contributes nothing to them. Mounting a component to raise a
  number on a composable would be the wrong reason to write either test.
- **`renderSuspended`.** `@nuxt/test-utils`' Testing Library helper needs
  `@testing-library/vue`, which is not a dependency here. `mountSuspended` and
  `@vue/test-utils` cover what these tests do.
- **`tests/e2e/`.** The Playwright suite is still not wired into CI; only the
  WCAG audit config is.
