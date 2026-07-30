// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'vue/multi-word-component-names': 'off',
    // Off because it contradicts Prettier: this rule wants `<input>` for void
    // elements while Prettier writes `<input />`, so `lint --fix` and `format`
    // would undo each other forever. Prettier owns tag formatting.
    'vue/html-self-closing': 'off',
  },
})
