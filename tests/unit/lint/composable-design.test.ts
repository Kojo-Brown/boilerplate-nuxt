import path from 'node:path'

import { ESLint } from 'eslint'
import { describe, it, expect, beforeAll } from 'vitest'

import { composableDesignPlugin } from '../../../eslint-rules/composable-design.mjs'

/**
 * These run the project's real `eslint.config.mjs` rather than ESLint's
 * `RuleTester`, so a rule that works but is wired to the wrong glob — or not
 * wired at all — fails here. The trade-off is that a fixture is linted by every
 * other rule too, so the assertions filter to this plugin's own reports.
 */
let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() })
})

interface Report {
  line: number
  ruleId: string
  messageId: string
}

/**
 * Lints `code` as though it were the file at `relativePath`. The file does not
 * exist on disk: ESLint resolves configuration by path, and a fixture that
 * existed would itself have to pass `pnpm lint`.
 */
async function lint(relativePath: string, code: string): Promise<Report[]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativePath),
  })

  return (results[0]?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('composable-design/') === true)
    .map((message) => ({
      line: message.line,
      ruleId: message.ruleId ?? '',
      messageId: message.messageId ?? '',
    }))
}

/** Lints a fixture as a composable, where both rules are enabled. */
function lintComposable(code: string): Promise<Report[]> {
  return lint('composables/__fixture__.ts', code)
}

describe('composable-design plugin', () => {
  it('exports both rules under the name the config references', () => {
    expect(composableDesignPlugin.meta?.name).toBe('composable-design')
    expect(Object.keys(composableDesignPlugin.rules ?? {}).sort()).toEqual([
      'no-import-side-effects',
      'no-module-state',
    ])
  })

  it('gives every rule a schema and messages, so a config typo fails loudly', () => {
    for (const rule of Object.values(composableDesignPlugin.rules ?? {})) {
      expect(rule.meta?.schema).toEqual([])
      expect(Object.keys(rule.meta?.messages ?? {}).length).toBeGreaterThan(0)
    }
  })
})

describe('composable-design/no-module-state', () => {
  it('reports a module-scope `ref()`', async () => {
    const reports = await lintComposable(`const items = ref<string[]>([])\n`)
    expect(reports).toEqual([
      { line: 1, ruleId: 'composable-design/no-module-state', messageId: 'reactiveState' },
    ])
  })

  it('reports every reactive factory, not just `ref`', async () => {
    const reports = await lintComposable(
      [
        'const a = shallowRef(0)',
        'const b = reactive({})',
        'const c = shallowReactive({})',
        'const d = computed(() => 1)',
        'const e = customRef(() => ({ get: () => 1, set: () => {} }))',
        'export const f = toRef(() => 1)',
        '',
      ].join('\n'),
    )
    expect(reports.map((r) => r.messageId)).toEqual(Array(6).fill('reactiveState'))
  })

  it('reports a module-scope `let` and `var` whatever they hold', async () => {
    const reports = await lintComposable(`let cursor = 0\nvar started = false\n`)
    expect(reports).toEqual([
      { line: 1, ruleId: 'composable-design/no-module-state', messageId: 'mutableBinding' },
      { line: 2, ruleId: 'composable-design/no-module-state', messageId: 'mutableBinding' },
    ])
  })

  it('reports module-scope mutable containers', async () => {
    const reports = await lintComposable(
      `const cache = new Map<string, number>()\nconst seen = new WeakSet()\n`,
    )
    expect(reports.map((r) => r.messageId)).toEqual(['mutableContainer', 'mutableContainer'])
  })

  it('reports a bare object or array literal', async () => {
    const reports = await lintComposable(`const defaults = { retries: 3 }\nconst queue = []\n`)
    expect(reports.map((r) => r.messageId)).toEqual(['mutableLiteral', 'mutableLiteral'])
  })

  it('looks through `export` so an exported ref is still reported', async () => {
    const reports = await lintComposable(`export const items = ref<string[]>([])\n`)
    expect(reports.map((r) => r.messageId)).toEqual(['reactiveState'])
  })

  it('sees through a type assertion to the literal underneath', async () => {
    const reports = await lintComposable(`const rows = [] as string[]\n`)
    expect(reports.map((r) => r.messageId)).toEqual(['mutableLiteral'])
  })

  it('accepts a literal made readonly by `as const` or `Object.freeze`', async () => {
    const reports = await lintComposable(
      [
        "const LEVELS = ['info', 'error'] as const",
        'const LIMITS = Object.freeze({ retries: 3 })',
        'export const KEY = "app:thing"',
        'const PATTERN = /^\\d+$/',
        'const MAX = 10',
        '',
      ].join('\n'),
    )
    expect(reports).toEqual([])
  })

  it('accepts state and mutable bindings declared inside the composable', async () => {
    const reports = await lintComposable(
      [
        'export function useCounter() {',
        '  const count = ref(0)',
        '  const cache = new Map<string, number>()',
        '  let calls = 0',
        '  return { count, cache, calls }',
        '}',
        '',
      ].join('\n'),
    )
    expect(reports).toEqual([])
  })

  it('accepts a module-scope function, class, or arrow', async () => {
    const reports = await lintComposable(
      [
        'function helper(): number { return 1 }',
        'const arrow = (): number => helper()',
        'class Box { value = 1 }',
        'export { helper, arrow, Box }',
        '',
      ].join('\n'),
    )
    expect(reports).toEqual([])
  })
})

describe('composable-design/no-import-side-effects', () => {
  it('reports a bare call at module scope', async () => {
    const reports = await lintComposable(
      `function connect(): void {}\nconnect()\nexport { connect }\n`,
    )
    expect(reports).toEqual([
      {
        line: 2,
        ruleId: 'composable-design/no-import-side-effects',
        messageId: 'topLevelExpression',
      },
    ])
  })

  it('reports top-level await, including inside an initializer', async () => {
    const reports = await lintComposable(
      [
        'declare function load(): Promise<number>',
        'export const config = await load()',
        'await load()',
        '',
      ].join('\n'),
    )
    // Source order: the initializer on line 2, then the bare `await load()` on
    // line 3, which both rules report — one as work done at import time, the
    // other as the reason it blocks.
    expect(reports.map((r) => ({ line: r.line, messageId: r.messageId }))).toEqual([
      { line: 2, messageId: 'topLevelAwait' },
      { line: 3, messageId: 'topLevelExpression' },
      { line: 3, messageId: 'topLevelAwait' },
    ])
  })

  it('does not report `await` inside the composable itself', async () => {
    const reports = await lintComposable(
      [
        'declare function load(): Promise<number>',
        'export async function useThing(): Promise<number> {',
        '  return await load()',
        '}',
        '',
      ].join('\n'),
    )
    expect(reports).toEqual([])
  })

  it('accepts imports, type-only statements, and declarations', async () => {
    const reports = await lintComposable(
      [
        "import { ref } from 'vue'",
        "import type { Ref } from 'vue'",
        'export type Counter = { count: Ref<number> }',
        'export interface Options { start: number }',
        'export function useCounter(options: Options): Counter {',
        '  return { count: ref(options.start) }',
        '}',
        '',
      ].join('\n'),
    )
    expect(reports).toEqual([])
  })
})

describe('rule scope', () => {
  const offending = `const items = ref<string[]>([])\nconsole.warn('loaded')\n`

  it.each([
    ['composables/useThing.ts', 2],
    ['utils/thing.ts', 2],
    ['stores/thing.ts', 2],
  ])('applies to %s', async (file, expected) => {
    expect(await lint(file, offending)).toHaveLength(expected)
  })

  it.each([['plugins/thing.ts'], ['server/utils/thing.ts'], ['middleware/thing.ts']])(
    'does not apply to %s, where import-time work is the point',
    async (file) => {
      expect(await lint(file, offending)).toEqual([])
    },
  )
})
