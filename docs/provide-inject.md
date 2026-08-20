# provide / inject with a typed `InjectionKey`

Two problems live in the same API, and it is worth keeping them apart.

**Prop drilling** is a plumbing problem: a value is needed four levels down and
every component in between declares a prop it only forwards. `provide`/`inject`
removes the plumbing.

**Dependency inversion** is a design problem: a component that calls
`$fetch('/api/todos')` depends on the network, so it can only run where the
network, the database, and a session all exist. Injection is what lets it depend
on an interface instead, with an ancestor deciding which implementation that is.

The first is a convenience. The second is why this repo has
[`utils/injection.ts`](../utils/injection.ts), and it is what
[`/dependency-inversion`](../pages/dependency-inversion.vue) demonstrates
against a live UI.

---

## The typing problem

Vue's raw API is untyped at both ends:

```ts
provide('gateway', createHttpTodoGateway()) // any value, any key
const gateway = inject('gateway') // unknown
```

A string key carries no type, so `inject` returns `unknown` and every call site
casts. Strings also collide silently — two libraries that both pick `'store'`
shadow one another with no diagnostic at all.

`InjectionKey<T>` is a `Symbol` with a phantom `T` attached. One declaration
types both ends:

```ts
const key: InjectionKey<TodoGateway> = Symbol('todos.gateway')

provide(key, createHttpTodoGateway()) // rejects anything else
const gateway = inject(key) //  TodoGateway | undefined
```

Note the `| undefined`. `InjectionKey<T>` types the value but not its absence,
and for a dependency that is mandatory in every real render the honest type is
just `T` — which is how the pattern degenerates into `inject(key)!` and hands
back a non-null type for something that can genuinely be missing. When it is
missing, Vue logs a warning and returns `undefined`, and the failure surfaces
later as a `TypeError` in the first line that touched it, usually far from the
provider that was forgotten.

## `defineInjection`

`defineInjection<T>(name)` mints the key and returns the operations bound to it:

```ts
// utils/todoGateway.ts
export const todoGatewayInjection = defineInjection<TodoGateway>('todos.gateway')

// an ancestor component
todoGatewayInjection.provide(createInMemoryTodoGateway())

// any descendant, at any depth
const gateway = todoGatewayInjection.inject()
```

| Call                    | Returns           | When nothing was provided                 |
| ----------------------- | ----------------- | ----------------------------------------- |
| `inject()`              | `T`               | throws `InjectionNotProvidedError`, named |
| `injectOr(fallback)`    | `T \| F`          | returns `fallback`                        |
| `injectOptional()`      | `T \| undefined`  | returns `undefined` (Vue's own semantics) |
| `isProvided()`          | `boolean`         | `false`                                   |
| `provide(value)`        | `void`            | —                                         |
| `provideTo(app, value)` | `void`            | — (app-wide; the Nuxt-plugin entry point) |
| `key`                   | `InjectionKey<T>` | — (for APIs the wrappers cannot cover)    |

Three details are not cosmetic:

- **`inject()` throws by default.** A missing mandatory dependency is a wiring
  bug, and it is cheapest to fix when the error names the key and fires at the
  injection site. `injectOr` is there for the genuinely optional case.
- **"Not provided" is a private symbol, not `undefined`.** For a nullable `T`,
  `undefined` is a legitimate provided value, and Vue returns the same
  `undefined` for both. The sentinel is what makes `isProvided()` and
  `injectOr()` correct for those types.
- **Injecting outside a setup context is reported separately.** After an
  `await`, in an event handler, in a `setTimeout`, there is no current instance
  and Vue resolves against nothing. "You asked in the wrong place" and "nobody
  provided it" send you looking in completely different directions, so they get
  different messages.

`Symbol()`, not `Symbol.for()`: the latter interns into a process-wide registry
shared by every request the server handles and by every module that guesses the
same string.

## Dependency inversion, concretely

The todo feature is split three ways:

| File                         | Role                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `types/todos.ts`             | the **port** — `TodoGateway`, owned by the consumer         |
| `utils/todoGateway.ts`       | the **adapters** — in-memory, HTTP, and a failure decorator |
| `composables/useTodoList.ts` | the **consumer** — depends on the port and nothing else     |

The direction of the arrows is the whole point. `TodoGateway` is declared next
to the UI that needs it, in the shape that UI wants — `createdAt` is a string
because that survives SSR serialization, and `updatedAt` is absent because
nothing renders it. The HTTP adapter is then responsible for mapping the wire
format onto that, so a change to the database schema or the response envelope
is a change to one file that renders nothing.

`createInMemoryTodoGateway` is not a mock. It enforces the same rules the API
route does — a blank title is rejected, an unknown id rejects rather than
resolving with `undefined` — which is what lets it back the demo page, a preview,
and a test alike. `createFaultyTodoGateway` wraps any of them and makes chosen
operations reject, so error handling is something you can look at on purpose
instead of something that first runs in production.

What that buys, measured in the test suite:
`tests/unit/composables/useTodoList.test.ts` covers loading, adding, toggling,
deleting, four failure paths and an out-of-order refresh with no `$fetch` stub,
no MSW, no database, and — for most of it — no component. It passes a gateway
in.

## Two injections, not one

`useTodoList.ts` defines a second contract, `todoListInjection`, and the split is
deliberate:

- `todoGatewayInjection` answers **which backend**. Provided at the top of the
  page by `TodoGatewayProvider`.
- `todoListInjection` answers **which list** — one board's state, shared by the
  composer, the rows, and the summary, none of which is a child of the others.
  Provided by `TodoBoard` via `provideTodoList()`.

Collapsing them would mean either the board choosing its own backend or every
descendant rebuilding the list from the gateway, each with its own copy of the
state.

## SSR

A provided value lives on the component instance, or on the app — never on the
module. Nuxt builds one app per request on the server, so an app-wide provide is
**per request**, which is exactly what a module-scope singleton is not:

```ts
// An app-wide default — one gateway per request, not one per process.
// Not shipped: the demo page provides at the subtree instead, so the adapter
// can be switched without a rebuild.
export default defineNuxtPlugin((nuxtApp) => {
  todoGatewayInjection.provideTo(nuxtApp.vueApp, createHttpTodoGateway())
})
```

This is the same property `useState` and Pinia rely on, and it is why injection
is a safe way to publish a request-scoped dependency — a per-user API client, a
tenant, a locale-aware formatter — while a module-level `const client = …` is
not. See [Rule 3 in the composable design rules](./composable-design-rules.md).

## Reactivity

Injection copies nothing and creates no reactivity of its own: the descendant
receives the same object that was provided. So provide a `ref`, a `computed`, or
an object of them if the value changes; provide a plain number and the child has
a snapshot.

An injected value should be read-only to its consumers. `useTodoList` returns
`ComputedRef`s for state and functions for the mutations, so a descendant cannot
write to the list behind the board's back.

Changing which value is provided is a different matter — Vue resolves an
injection when the child sets up, and re-providing later does not reach the
children that already read it. Either provide a `ref` and let the subtree watch
it, or remount the subtree. `pages/dependency-inversion.vue` remounts, with a
`:key` on `TodoGatewayProvider`, because switching adapters should also throw
away the state loaded from the previous one.

## When not to use it

- **Global app state.** Pinia stores and `useState` are per-app in the same way
  and come with devtools, persistence, and no wiring. Injection's advantage is
  that an _ancestor_ chooses the implementation.
- **A dependency of a single call.** Injecting it makes the composable
  unusable outside a component. Take it as an optional argument instead — Rule 2
  of the composable design rules.
- **Passing data one level down.** That is a prop. Injection makes the data flow
  invisible in the template, and that cost is only worth paying at depth.
