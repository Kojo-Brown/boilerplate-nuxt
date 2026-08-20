import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'

import { defineInjection } from '../utils/injection'
import { todoGatewayInjection } from '../utils/todoGateway'

import type { TodoGateway, TodoItem } from '~/types/todos'

/** The todo list as a subtree sees it: state to render, actions to call. */
export interface TodoListController {
  /** The current todos, oldest first. Read-only; mutate through the actions. */
  items: ComputedRef<readonly TodoItem[]>
  /** True while any gateway call is in flight. */
  pending: ComputedRef<boolean>
  /** The last failure, or `null`. Cleared when an operation succeeds. */
  error: ComputedRef<Error | null>
  /** How many todos are not yet completed. */
  remaining: ComputedRef<number>
  /** True once a refresh has completed, successfully or not. */
  loaded: ComputedRef<boolean>
  /** Replaces the list with what the gateway currently holds. */
  refresh: () => Promise<void>
  /** Creates a todo. Returns false and sets `error` if the gateway rejected. */
  add: (title: string) => Promise<boolean>
  /** Flips a todo's completed flag. Returns false on failure. */
  toggle: (id: string) => Promise<boolean>
  /** Deletes a todo. Returns false on failure. */
  remove: (id: string) => Promise<boolean>
}

/**
 * The controller shared by a todo subtree.
 *
 * Separate from {@link todoGatewayInjection} because the two answer different
 * questions. The gateway injection says *which backend*; this one says *which
 * list* — one board's state, shared by the composer, the rows, and the summary
 * without any of them being children of each other.
 */
export const todoListInjection = defineInjection<TodoListController>('todos.list')

/**
 * Builds a controller over a gateway.
 *
 * Takes the gateway as an argument rather than injecting it, so it is callable
 * from a plain test with no component and no app — the injection wiring lives
 * in {@link provideTodoList}, one layer up. Everything below depends on the
 * `TodoGateway` interface and nothing else: no `$fetch`, no route, no import of
 * an adapter.
 */
export function createTodoList(gateway: TodoGateway): TodoListController {
  const items = ref<readonly TodoItem[]>([])
  const error = ref<Error | null>(null)
  const loaded = ref(false)
  const inFlight = ref(0)

  /**
   * Incremented on every refresh so a slow response can be dropped when a
   * newer one has already landed. Without it, two refreshes a user triggered in
   * the order A, B render in whatever order the network answered, and the list
   * can settle on the older of the two.
   */
  let generation = 0

  function toError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause))
  }

  /**
   * Runs a gateway call with the bookkeeping every one of them needs: the
   * pending count, clearing the previous error on success, capturing the new
   * one on failure. Returns `null` when the call rejected, which is what the
   * public methods turn into `false`.
   */
  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    inFlight.value += 1
    try {
      const result = await operation()
      error.value = null
      return result
    } catch (cause) {
      error.value = toError(cause)
      return null
    } finally {
      inFlight.value -= 1
    }
  }

  async function refresh(): Promise<void> {
    generation += 1
    const current = generation

    const result = await run(() => gateway.list())

    // A newer refresh started while this one was in flight; its result is the
    // one that should win, whichever arrives first.
    if (current !== generation) return

    loaded.value = true
    if (result !== null) {
      items.value = result
    }
  }

  async function add(title: string): Promise<boolean> {
    const created = await run(() => gateway.create({ title }))
    if (created === null) return false

    // Appended from the gateway's own response rather than refetching: the
    // adapter is the authority on what was stored (trimmed title, assigned id),
    // and a second round trip would only re-read what it just returned.
    items.value = [...items.value, created]
    return true
  }

  async function toggle(id: string): Promise<boolean> {
    const existing = items.value.find((item) => item.id === id)
    if (existing === undefined) {
      error.value = new Error(`Todo "${id}" is not in this list`)
      return false
    }

    const updated = await run(() => gateway.setCompleted(id, !existing.completed))
    if (updated === null) return false

    items.value = items.value.map((item) => (item.id === id ? updated : item))
    return true
  }

  async function remove(id: string): Promise<boolean> {
    const result = await run(async () => {
      await gateway.remove(id)
      return true as const
    })
    if (result === null) return false

    items.value = items.value.filter((item) => item.id !== id)
    return true
  }

  return {
    items: computed(() => items.value),
    pending: computed(() => inFlight.value > 0),
    error: computed(() => error.value),
    remaining: computed(() => items.value.filter((item) => !item.completed).length),
    loaded: computed(() => loaded.value),
    refresh,
    add,
    toggle,
    remove,
  }
}

/**
 * Creates a todo list over the injected gateway and provides it to this
 * component's descendants.
 *
 * Call it in the component that owns the board. Everything below reaches the
 * same controller with {@link useTodoList}, at any depth, with no props
 * forwarded through the components in between.
 *
 * @param gateway Overrides the injected adapter. Left out — the normal case —
 *   the gateway comes from {@link todoGatewayInjection}, so the component that
 *   owns the list still does not choose the backend.
 */
export function provideTodoList(gateway?: TodoGateway): TodoListController {
  const controller = createTodoList(gateway ?? todoGatewayInjection.inject())
  todoListInjection.provide(controller)
  return controller
}

/**
 * The shared todo list, from any descendant of the component that called
 * {@link provideTodoList}.
 *
 * Throws when there is none: a todo row rendered outside a board is a wiring
 * mistake, and the alternative — silently building a second, empty list — would
 * render as a component that simply shows nothing.
 */
export function useTodoList(): TodoListController {
  return todoListInjection.inject()
}
