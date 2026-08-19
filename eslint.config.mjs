// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import composableDesign from './eslint-rules/composable-design.mjs'

export default withNuxt(
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'vue/multi-word-component-names': 'off',
      // Off because it contradicts Prettier: this rule wants `<input>` for void
      // elements while Prettier writes `<input />`, so `lint --fix` and `format`
      // would undo each other forever. Prettier owns tag formatting.
      'vue/html-self-closing': 'off',
    },
  },
  {
    // The auto-imported app layers, and only those. Every module here is
    // evaluated once per server process and its exports are reachable from any
    // request, so module scope is process scope — see
    // `docs/composable-design-rules.md`. Plugins and `server/` are excluded on
    // purpose: a Nuxt plugin exists to do setup work at import time, and Nitro
    // handlers are already written against a per-request `H3Event`.
    files: ['composables/**/*.ts', 'utils/**/*.ts', 'stores/**/*.ts'],
    plugins: { 'composable-design': composableDesign },
    rules: {
      'composable-design/no-module-state': 'error',
      'composable-design/no-import-side-effects': 'error',
    },
  },
)
