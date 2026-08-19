// @ts-check
/**
 * Local ESLint rules enforcing the composable design rules documented in
 * `docs/composable-design-rules.md`.
 *
 * These are deliberately narrow. A linter sees the shape of a module, not what
 * it does when it runs, so these rules cover the two things decidable from the
 * syntax alone — what a module *declares* at its top level, and what it
 * *executes* there — and nothing else. Effects that only appear at runtime (a
 * timer started from inside an initializer, a listener registered by a
 * transitive import) are caught by `tests/unit/composables/import-purity.test.ts`,
 * which imports every module with detectors armed. Neither half is sufficient
 * alone: the lint rules cannot see through a function call, and the runtime
 * test cannot see state that is merely declared and not yet written to.
 *
 * Written as ESM with JSDoc types rather than TypeScript because
 * `eslint.config.mjs` imports it directly: a `.ts` plugin would have to survive
 * both ESLint's config loader and Node's type stripping on every supported Node
 * major, which is a lot of machinery for two rules.
 *
 * @typedef {import('@typescript-eslint/types').TSESTree.Node} Node
 * @typedef {import('@typescript-eslint/types').TSESTree.Expression} Expression
 * @typedef {import('@typescript-eslint/types').TSESTree.ProgramStatement} ProgramStatement
 */

/**
 * Vue factories whose return value is reactive state. A module-scope call to
 * any of them creates one instance for the whole server process, shared by
 * every request it serves.
 */
const REACTIVE_FACTORIES = new Set([
  'ref',
  'shallowRef',
  'customRef',
  'toRef',
  'reactive',
  'shallowReactive',
  'computed',
])

/**
 * Built-ins whose instances are mutable containers. `new Map()` at module scope
 * is the classic accidental cache: it never gets smaller, and on the server it
 * holds whatever the first request that touched it put there.
 */
const MUTABLE_CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Date'])

/**
 * Strips TypeScript-only expression wrappers so the checks below see the value
 * itself. `const rows = [] as Row[]` and `const rows = <Row[]>[]` both parse to
 * an extra node between the declarator and the array literal.
 *
 * @param {Expression} node
 * @returns {Expression}
 */
function unwrap(node) {
  let current = node
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion'
  ) {
    current = current.expression
  }
  return current
}

/**
 * True for `expr as const` — the one annotation that makes a literal readonly
 * to the type system, and so the one that makes a module-scope literal safe to
 * share. It is a compile-time guarantee only, which is why `Object.freeze` is
 * accepted as well.
 *
 * @param {Expression} node
 */
function isAsConst(node) {
  return (
    node.type === 'TSAsExpression' &&
    node.typeAnnotation.type === 'TSTypeReference' &&
    node.typeAnnotation.typeName.type === 'Identifier' &&
    node.typeAnnotation.typeName.name === 'const'
  )
}

/**
 * True for `Object.freeze(...)`, which makes a literal readonly at runtime.
 *
 * @param {Expression} node
 */
function isFrozen(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Object' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'freeze'
  )
}

/**
 * ESLint types its visitors and `context.report` against `estree`, which has no
 * node for `as const` or for a type assertion. The parser really does hand over
 * `@typescript-eslint` nodes, so this pair of casts is where the two views of
 * the same tree are reconciled — once, on the way in and on the way out, rather
 * than at every use.
 *
 * @param {object} node A node as ESLint typed it, i.e. an `estree` node.
 * @returns {Node}
 */
function asTsNode(node) {
  return /** @type {Node} */ (/** @type {unknown} */ (node))
}

/**
 * @param {Node} node
 * @returns {import('eslint').Rule.Node}
 */
function asEslintNode(node) {
  return /** @type {import('eslint').Rule.Node} */ (/** @type {unknown} */ (node))
}

/**
 * The statements that make up a module's top level, looking through the
 * `export` keyword so `export const x = 1` is seen as the declaration it wraps.
 *
 * @param {readonly ProgramStatement[]} body
 * @returns {Node[]}
 */
function topLevelStatements(body) {
  return body.map((statement) =>
    (statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration') &&
    statement.declaration !== null
      ? statement.declaration
      : statement,
  )
}

/** @type {import('eslint').Rule.RuleModule} */
const noModuleState = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow mutable state at module scope, which is shared by every request a server process handles.',
    },
    schema: [],
    messages: {
      mutableBinding:
        '`{{name}}` is a module-scope `{{kind}}`, so its value is shared by every request this server process handles and outlives them all. Declare it inside the composable, or hold it in `useState()` if it must survive hydration.',
      reactiveState:
        "`{{name}}` calls `{{factory}}()` at module scope, so one instance of this state is shared by every request this server process handles — one user's data can be rendered into another user's page. Move it inside the composable, or use `useState()` for state that must be per-request and survive hydration.",
      mutableContainer:
        '`{{name}}` is a module-scope `{{container}}`, so it accumulates across every request this server process handles and is never released. Move it inside the composable, or key it per-request through `useState()`.',
      mutableLiteral:
        '`{{name}}` is a mutable module-scope {{shape}} shared by every request this server process handles. Add `as const` or wrap it in `Object.freeze()` if it is a constant; move it inside the composable if it is not.',
    },
  },
  create(context) {
    return {
      Program(program) {
        const root = asTsNode(program)
        if (root.type !== 'Program') return

        for (const statement of topLevelStatements(root.body)) {
          if (statement.type !== 'VariableDeclaration') continue

          for (const declarator of statement.declarations) {
            if (declarator.id.type !== 'Identifier') continue
            const name = declarator.id.name

            // `let`/`var` is reassignable wherever it sits, so the kind alone
            // is enough — the initializer does not matter.
            if (statement.kind !== 'const') {
              context.report({
                node: asEslintNode(declarator),
                messageId: 'mutableBinding',
                data: { name, kind: statement.kind },
              })
              continue
            }

            const init = declarator.init
            if (init === null) continue
            if (isAsConst(init) || isFrozen(init)) continue

            const value = unwrap(init)
            /** @type {{ messageId: string, data: Record<string, string> } | null} */
            let problem = null

            if (
              value.type === 'CallExpression' &&
              value.callee.type === 'Identifier' &&
              REACTIVE_FACTORIES.has(value.callee.name)
            ) {
              problem = { messageId: 'reactiveState', data: { name, factory: value.callee.name } }
            } else if (
              value.type === 'NewExpression' &&
              value.callee.type === 'Identifier' &&
              MUTABLE_CONTAINERS.has(value.callee.name)
            ) {
              problem = {
                messageId: 'mutableContainer',
                data: { name, container: value.callee.name },
              }
            } else if (value.type === 'ObjectExpression' || value.type === 'ArrayExpression') {
              problem = {
                messageId: 'mutableLiteral',
                data: { name, shape: value.type === 'ArrayExpression' ? 'array' : 'object' },
              }
            }

            if (problem !== null) {
              context.report({
                node: asEslintNode(declarator),
                messageId: problem.messageId,
                data: problem.data,
              })
            }
          }
        }
      },
    }
  },
}

/** @type {import('eslint').Rule.RuleModule} */
const noImportSideEffects = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow work at module-evaluation time, which runs on import rather than on use.',
    },
    schema: [],
    messages: {
      topLevelExpression:
        'This statement runs when the module is imported, not when the composable is called — before any Nuxt app context exists, and once per process rather than once per request. Move it inside the composable, or into a Nuxt plugin if it is genuinely app setup.',
      topLevelAwait:
        'Top-level `await` blocks the import graph and makes every consumer of this module an async module. Do the work inside the composable and return the promise.',
    },
  },
  create(context) {
    return {
      Program(program) {
        const root = asTsNode(program)
        if (root.type !== 'Program') return

        for (const statement of topLevelStatements(root.body)) {
          // A bare expression at the top level exists only for its effect —
          // otherwise the value it produced would go somewhere.
          if (statement.type === 'ExpressionStatement') {
            context.report({
              node: asEslintNode(statement),
              messageId: 'topLevelExpression',
            })
          }
        }
      },

      // Matched as an expression rather than as a statement shape: `const config
      // = await load()` is an initializer and `for await (…)` is a loop, so a
      // scan of `Program.body` would miss both. An `await` inside a function
      // belongs to that function's scope, so the module scope — not the nesting
      // depth — is what separates top-level `await` from ordinary async code.
      AwaitExpression(node) {
        if (context.sourceCode.getScope(node).type === 'module') {
          context.report({ node, messageId: 'topLevelAwait' })
        }
      },
    }
  },
}

/** @type {import('eslint').ESLint.Plugin} */
export const composableDesignPlugin = {
  meta: {
    name: 'composable-design',
    version: '1.0.0',
  },
  rules: {
    'no-module-state': noModuleState,
    'no-import-side-effects': noImportSideEffects,
  },
}

export default composableDesignPlugin
