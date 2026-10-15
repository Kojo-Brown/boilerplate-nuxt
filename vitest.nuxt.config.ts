import { fileURLToPath } from 'node:url'

import { defineVitestProject } from '@nuxt/test-utils/config'
import replace from '@rollup/plugin-replace'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

/**
 * The two suites that need a Nuxt app rather than a module.
 *
 * `vitest.config.ts` is the other side of the split: a plain `node` environment
 * where a composable, a store or a server util is imported directly and the few
 * Nuxt globals it touches are stubbed in `tests/setup.ts`. That is the right
 * environment for code that is Nuxt-flavoured TypeScript and the wrong one for a
 * component, which needs the auto-imports, the component resolver, the router,
 * the i18n messages and the module plugins that exist only inside a built app.
 *
 * - **`component`** (`tests/nuxt/`) mounts components with
 *   `mountSuspended`, in the `nuxt` environment `@nuxt/test-utils` provides:
 *   Nuxt's own Vite config, a Nuxt app booted in happy-dom, and the auto-imports
 *   resolved the way the application resolves them.
 * - **`ssr`** (`tests/ssr/`) asserts on server-rendered HTML, which that
 *   environment cannot produce — it is a client app in a DOM. These tests start
 *   a real Nuxt server (`@nuxt/test-utils/e2e`) and read the bytes it sends.
 *
 * Both live here rather than in `vitest.config.ts` because resolving this file
 * boots Nuxt (~20s), and making the 200-test node suite pay that on every watch
 * cycle would be a bad trade. `pnpm test` runs both configs, so CI gates on
 * everything; `pnpm test:unit` and `pnpm test:nuxt` are the halves, and
 * `pnpm test:nuxt --project component` is the inner loop while writing a
 * component test.
 *
 * See docs/component-testing.md.
 */
export default defineConfig(async () => {
  const component = await defineVitestProject({
    test: {
      name: 'component',
      globals: true,
      include: ['tests/nuxt/**/*.nuxt.test.ts'],
      environmentOptions: {
        nuxt: {
          // happy-dom, which is also @nuxt/test-utils' default: it implements
          // `matchMedia`, which `@nuxtjs/color-mode` calls while the app boots,
          // and it needs no dependency jsdom would not also need.
          domEnvironment: 'happy-dom',
        },
      },
    },
  })

  // Patched in place, through a narrower view of the same object, so the value
  // handed to `projects` below keeps the type Vitest declares for it.
  patchNuxtViteConfig(component as NuxtVitestProject)

  return {
    test: {
      projects: [
        component,
        {
          test: {
            name: 'ssr',
            globals: true,
            environment: 'node',
            include: ['tests/ssr/**/*.test.ts'],
            // One Nuxt dev server, started once and shared by every file in the
            // project; `@nuxt/test-utils/e2e`'s `setup()` builds the app's first
            // response inside the test that asks for it, so the budget has to
            // cover a cold compile rather than a request.
            testTimeout: 180_000,
            hookTimeout: 180_000,
            // The server is the fixture. Two files hitting it in parallel would
            // each call `setup()` and each get their own.
            fileParallelism: false,
          },
          // The same four aliases `vitest.config.ts` mirrors from Nuxt, for the
          // same reason: a test imports a module the way the application does.
          resolve: { alias: { '~~': root, '@@': root, '~': root, '@': root } },
        },
      ],
    },
  }
})

/**
 * The shape of what `defineVitestProject` returns that this file reaches into.
 * It is a resolved Vite config — Nuxt's own, with Vitest's additions — and
 * `@nuxt/test-utils` types it as Vitest's project config, which does not promise
 * `plugins` or `define` are present. Both always are; narrowing here is what
 * keeps the two patches below from needing `any`.
 */
interface NuxtVitestProject {
  define?: Record<string, string>
  plugins?: (VitePluginLike | null | undefined)[]
  test?: { setupFiles?: string[] }
}

/**
 * As much of a Vite plugin as this file touches. Importing Vite's own `Plugin`
 * would be the obvious thing and is not possible: `vite` is not a dependency of
 * this project — it arrives under Nuxt and under Vitest, in two different majors
 * — so there is no `vite` for TypeScript to resolve from the root, and no answer
 * to which of the two majors' `Plugin` this would be.
 */
interface VitePluginLike {
  name?: string
  enforce?: 'pre' | 'post'
}

/** Both fixes the Nuxt-supplied Vite config needs before Vitest can run it. */
function patchNuxtViteConfig(project: NuxtVitestProject): void {
  replaceRolldownReplacePlugin(project)
  prependColorModeSetup(project)
}

/**
 * Swaps Nuxt's `nuxt:replace` plugin for the Rollup-compatible equivalent.
 *
 * `nuxt:replace` is what turns `import.meta.client` and `import.meta.server`
 * into `true`/`false`. Nuxt 4.5 implements it by returning rolldown's native
 * `replacePlugin` from `applyToEnvironment` — a `BuiltinPlugin` that only Vite
 * 8's rolldown pipeline can execute. Nuxt builds on 8; Vitest 3 runs on 7 (the
 * note in `vitest.config.ts` has the rest of that story), and handed to Vite 7
 * the plugin throws a bare object, which Vitest can only report as
 * `Unhandled Error: [object Object]` — no stack, no file, before a single test
 * runs.
 *
 * Dropping it is not an option. Vite's own `define` does not substitute
 * `import.meta.*` in the dev/SSR transform these tests go through, so
 * `import.meta.client` stays `undefined` — and Nuxt's app entry assigns the
 * function that boots the app inside `if (import.meta.client)`. What that
 * produces is `TypeError: entry is not a function`: no Nuxt app at all.
 *
 * So it is replaced, with the plugin whose API rolldown's copies — the same keys,
 * read from the same `define` map, the same `preventAssignment` — which also
 * keeps the sourcemaps that a hand-rolled regex pass over every module would
 * drop. Both guards below are failures to notice, not to survive: either one
 * means this function is now describing a Nuxt that no longer exists, and the
 * substitution it performs has to be rethought rather than skipped.
 */
function replaceRolldownReplacePlugin(project: NuxtVitestProject): void {
  // `.flat()`: Nuxt nests plugin arrays, and `name` has to be readable to filter.
  const plugins = (project.plugins ?? []).flat(3)
  const remaining = plugins.filter((plugin) => plugin?.name !== 'nuxt:replace')

  if (remaining.length === plugins.length) {
    throw new Error(
      'Nuxt no longer registers a `nuxt:replace` plugin. Check what replaced it ' +
        'and whether Vitest can run it before deleting this.',
    )
  }

  const importMetaDefines = Object.fromEntries(
    Object.entries(project.define ?? {}).filter(([key]) => key.startsWith('import.meta.')),
  )

  if (!('import.meta.client' in importMetaDefines)) {
    throw new Error(
      'Nuxt resolved no `import.meta.client` define, so the substitution below ' +
        'would leave the app entry unable to boot. Check what ' +
        '`getVitestConfigFromNuxt()` now returns in `define`.',
    )
  }

  project.plugins = [
    ...remaining,
    // `enforce: 'post'`, as `nuxt:replace` declares: the substitution has to
    // happen after the Vue compiler has turned a template into JavaScript.
    { ...replace({ ...importMetaDefines, preventAssignment: true }), enforce: 'post' },
  ]
}

/**
 * Puts `tests/nuxt/setup.ts` in front of `@nuxt/test-utils`' own setup entry.
 *
 * That entry creates the Nuxt app as it is imported, and `@nuxt/test-utils`
 * unshifts it onto `setupFiles` — so a file configured as `setupFiles` above
 * would run after the app exists, which for the one stub that file installs is
 * too late: `@nuxtjs/color-mode`'s plugin reads `window.__NUXT_COLOR_MODE__`
 * into a module constant while it is being imported. Hence an explicit unshift.
 */
function prependColorModeSetup(project: NuxtVitestProject): void {
  const setupFiles = project.test?.setupFiles ?? []
  const setup = fileURLToPath(new URL('tests/nuxt/setup.ts', import.meta.url))

  project.test = { ...project.test, setupFiles: [setup, ...setupFiles] }
}
