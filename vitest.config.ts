import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// `new URL('.', …)` keeps a trailing separator; the alias replacement is a
// prefix substitution, so leaving it produces `<root>//server/…`.
const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

export default defineConfig({
  // The four aliases Nuxt itself defines for the project root, mirrored from
  // `.nuxt/tsconfig.server.json`. Vitest runs outside Nuxt, so without them a
  // module that imports the way the rest of the codebase does — `~/server/utils/…`
  // — is unresolvable in a test, and the only importable server code is code
  // written with relative paths. Aliasing here means a test imports a module
  // exactly as production does, instead of the module being written around the
  // test runner.
  resolve: {
    alias: {
      '~~': root,
      '@@': root,
      '~': root,
      '@': root,
    },
  },

  // `.tsx` components need a JSX transform here as well as in the app. Nuxt's
  // Vite builder registers `@vitejs/plugin-vue-jsx` itself; Vitest runs its own
  // Vite, outside Nuxt, where esbuild would otherwise apply its default React
  // pragma and a `.tsx` component would fail to import with `React is not
  // defined` — a message that says nothing about the actual problem.
  //
  // The transform is configured rather than plugged in. Vue ships
  // `vue/jsx-runtime`, so esbuild's automatic runtime compiles Vue JSX with no
  // plugin at all, and these two lines say exactly what `.nuxt/tsconfig.json`
  // already tells TypeScript (`jsx: "preserve"`, `jsxImportSource: "vue"`).
  // Adding `@vitejs/plugin-vue-jsx` as a devDependency instead would have had
  // to bind its `vite` peer to one of the two Vites this project already
  // resolves — Nuxt builds on 8, Vitest runs on 7 — and whichever it picked,
  // the other config's `Plugin` type would no longer accept it.
  //
  // What this does not cover is the Babel plugin's extra JSX syntax (`v-model`,
  // `v-slots`, `v-show`). None of it is used: `components/*.tsx` render
  // intrinsic elements and pass slots through `h()`, which both transforms
  // compile identically.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'vue',
  },

  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'composables/**',
        'stores/**',
        'utils/**',
        'middleware/**',
        'server/utils/**',
        'server/middleware/**',
      ],
      exclude: ['**/*.d.ts', '**/*.config.*'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    reporters: ['verbose'],
    typecheck: {
      enabled: false,
    },
  },
})
