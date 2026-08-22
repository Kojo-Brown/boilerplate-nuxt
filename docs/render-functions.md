# Render functions and JSX

Vue templates compile to render functions. Writing one by hand is not a
different rendering model, it is the same one with the compiler step removed —
so the question is never "which is better", it is which of the two describes
_this_ component more honestly.

Almost always that is the template. This file is about the minority of cases
where it is not, using the one in this repo as the worked example:
`components/DataTable.tsx`, its wrapper `components/DataTableSection.tsx`, and
the page that drives both, `pages/render-functions.vue`.

## Setup

Almost none, and no new dependency. Nuxt's Vite builder already registers
`@vitejs/plugin-vue-jsx`, and the generated `.nuxt/tsconfig.json` already sets
`jsx: "preserve"` and `jsxImportSource: "vue"`.

Two things do need saying explicitly.

**A `.tsx` component needs a default export.** Nuxt scans `components/` and
resolves each entry to that module's default export — implicit in a `.vue` file,
explicit in a `.tsx` one. Without it the generated `components.d.ts` still
declares the component and the first page to use the auto-import fails with
`"default" is not exported`. Nothing short of `pnpm build` catches that: lint,
typecheck and the unit suite all pass, because they read the named export.

**Vitest needs its own JSX transform.** It runs its own Vite, outside Nuxt,
where esbuild would apply its default React pragma and a `.tsx` import would
fail with `React is not defined`. `vitest.config.ts` sets

```ts
esbuild: { jsx: 'automatic', jsxImportSource: 'vue' }
```

which is the same thing the tsconfig already tells TypeScript. Vue ships
`vue/jsx-runtime`, so this needs no plugin — deliberately, because adding
`@vitejs/plugin-vue-jsx` as a devDependency would have had to bind its `vite`
peer to one of the two Vites this project already resolves (Nuxt builds on 8,
Vitest runs on 7), and whichever it picked, the other config's `Plugin` type
would stop accepting it. What the esbuild route gives up is the Babel plugin's
extra JSX syntax — `v-model`, `v-slots`, `v-show` — so `components/*.tsx` use
none of it: they render intrinsic elements and pass slots through `h()`, which
both transforms compile identically.

## When a template is the right answer

Keep the template when the component is a fixed tree of elements — which is most
of them. Templates are statically analysable, so the compiler hoists static
subtrees, generates patch flags that skip unchanged bindings at runtime, and
type-checks `v-model`, slot scopes and event names against the component's own
types. A hand-written render function gets none of that. Choosing one costs real
runtime performance and real type coverage; it has to buy something back.

## When a render function is the right answer

It buys something back when the _shape_ of the output is data rather than markup.

**The elements are a list decided at runtime.** `DataTable` renders one `<th>`
and one `<td>` per entry in a `columns` array it is handed. A template can
`v-for` over columns too — that is not the hard part.

**The slot names are computed.** This is the hard part. `DataTable` looks for a
`cell:${column.id}` slot per cell:

```tsx
const slot = slots[`cell:${column.id}`]
return <td>{slot ? slot({ row, rowIndex, column, text }) : text}</td>
```

Three sources — the parent's slot, the column's own `text`, nothing — resolved
in one expression that TypeScript checks. The template equivalent needs
`<slot :name="'cell:' + column.id">` for the dynamic name plus a fallback, and
the dynamic name is a string expression the compiler cannot check at all.

**A wrapper has to forward slots it does not know about.** `DataTableSection`
renders a heading and a row count and then hands everything else down:

```tsx
h(DataTable<Row>, tableProps, forwardSlots(slots, { except: ['title'] }))
```

As a template that is a `<template #name>` per slot, restated in the wrapper —
and here it is not merely tedious but impossible, because the set of names is
open: `cell:<column id>`, for whatever columns some page passes. Any slot the
wrapper failed to list would be accepted and silently dropped. See
`utils/slots.ts` for why `forwardSlots` returns a proxy rather than a spread.

## Generic components, and the three things that erase the type parameter

`DataTable` is generic over its row type, which is what makes `#cell:status="{ row }"`
on `pages/render-functions.vue` a typed `Invoice` instead of an `unknown`.
Getting `Row` to survive from the definition to that slot scope takes three
deliberate choices, each working around a place TypeScript or Vue drops it.

**It is a functional component, not `defineComponent`.** The obvious form does
not work:

```tsx
// Erases Row. Every consumer sees the props at `Row = unknown`.
export const DataTable = defineComponent(
  <Row,>(props: DataTableProps<Row>) => () => /* … */,
  { props: [/* … */] },
)
```

Both of `defineComponent`'s setup-function overloads infer a concrete `Props`
and return `DefineSetupFnComponent<Props, …>`. Handing them a generic function
instantiates its parameter at `unknown` and returns a non-generic component;
there is no overload that keeps it. A plain function is a perfectly good Vue
component — `(props, ctx) => VNode`, with `props` and `emits` hung off it — and
being a plain function, it stays generic:

```tsx
export function DataTable<Row>(
  props: DataTableProps<Row>,
  { slots, emit }: DataTableContext<Row>,
): VNode {
  /* … */
}
DataTable.props = ['rows', 'columns', 'rowKey', 'sort', 'caption', 'emptyText']
DataTable.emits = ['update:sort']
```

`DataTable` is stateless — it renders the `sort` prop and emits changes to it —
so nothing is given up by not having a `setup`.

**The runtime prop declaration is a name list, not an object.** An object
declaration is typed `ComponentPropsOptions<P>`, and TypeScript will infer `P`
from it in preference to the call signature — pinning every consumer to the
erased props. `string[]` mentions no type, so inference falls back to the
signature. The cost is runtime defaults and `required` warnings, which that form
cannot express: defaults are applied in the function body instead, and
TypeScript already rejects a call that omits a required prop.

**Each consumer binds `Row` once, with an instantiation expression.**
TypeScript will not infer a type parameter _through_ a generic function passed
as an argument, and a template has no syntax for a type argument. Both problems
have the same one-line answer:

```ts
const InvoiceSection = DataTableSection<Invoice>
```

That is a TypeScript instantiation expression — the same function object at
runtime, a non-generic component to the type checker. `pages/render-functions.vue`
does it in `<script setup>` and writes `<InvoiceSection>` in its template;
`tests/unit/components/dataTable.test.ts` does it once at the top of the file;
`DataTableSection` does it as `h(DataTable<Row>, …)`, passing its own type
parameter down. Everything downstream — slot scopes included — is typed from
there.

The trailing comma in a generic arrow (`<Row,>`) is worth knowing even though
this file no longer needs one: in a `.tsx` file `<Row>` alone parses as a JSX
tag.

Two declarations of the same props is the standing cost of all this. In an SFC
`defineProps` produces the runtime and type declarations from one source, and
`<script setup lang="ts" generic="Row">` keeps the type parameter without any of
the three workarounds above. That is the honest comparison: a generic component
is cheaper as an SFC, and `.tsx` earns its place here for the dynamic slot names
and the forwarding, not for the generics.

## Erasing the cell value type

`ColumnDef<Row>` in `types/table.ts` is generic over the row but not over the
cell value, which `defineColumn` closes over instead:

```ts
defineColumn<Invoice, Invoice['status']>({
  id: 'status',
  header: 'Status',
  value: (row) => row.status,
  compare: (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b),
})
```

Inside that call, `value`, `format` and `compare` are checked against each
other with the value type visible. Afterwards the column is just
`(row) => string` and `(a, b) => number`. That is what lets a heterogeneous
column list — a string beside a number beside a date — live in one
`readonly ColumnDef<Invoice>[]` without widening anything to `unknown` and
casting it back at each use.

## Keeping logic out of the render function

The render function decides what the markup looks like and nothing else.
Everything that can be _wrong_ — which column is sorted, in which direction,
what order the rows come out in, what a cell says — is in `utils/dataTable.ts`,
as functions that take values and return values.

The payoff shows up in the tests. `tests/unit/utils/dataTable.test.ts` asserts
that ties keep their input order in both directions, and that ascending →
descending → ascending returns the original arrangement, without rendering
anything. `tests/unit/components/dataTable.test.ts` asserts markup, through
`renderToString`, and never has to reason about comparators. A table with the
sorting inside the component would need one suite doing both, against HTML.

## JSX and `h()` are the same thing

`<td>{text}</td>` compiles to `h('td', text)`. Mixing them is not a style
inconsistency: JSX reads better for the shape of the markup, and `h()` reads
better when the arguments are computed — which is why `DataTableSection` calls
`h(DataTable<Row>, props, forwardSlots(…))` rather than dressing a computed
slots object up as a `v-slots` attribute. Here it is also the only portable
spelling, since `v-slots` belongs to the Babel plugin and not to the transform
the tests run under.

## Accessibility does not come for free either way

Neither form gives you a correct table. `DataTable` renders `<th scope="col">`,
puts the sort control in a real `<button>` so it is reachable by keyboard, sets
`aria-sort` on sortable columns only — and to `"none"` rather than omitting it
while they are unsorted, because "sortable and not currently sorted" is
different information from "this column has no order". The arrow glyph is
`aria-hidden`; `aria-sort` already carries the state, and a screen reader
announcing "up arrow" carries none.
