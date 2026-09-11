import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'

import { defineInjection } from '../utils/injection'
import { isTodoConflictError, todoGatewayInjection } from '../utils/todoGateway'

import type { TodoGateway, TodoItem } from '~/types/todos'

/** What this client was trying to do when somebody else got there first. */
export type TodoWriteIntent =
  { readonly kind: 'toggle'; readonly completed: boolean } | { readonly kind: 'remove' }

/**
 * An unresolved collision: two versions of one todo, and a decision to make.
 *
 * Held separately from `error` because it is not one. An error is something
 * that went wrong and that a retry might fix; this is a write that was refused
 * for a good reason, and retrying it unchanged would either fail again or —
 * worse, if the client simply re-read and re-sent — silently destroy somebody
 * else's edit. The only thing that resolves it is a choice, so it is modelled as
 * a question rather than as a failure.
 */
export interface TodoConflictState {
  /** The todo as this client had it, with the change it wanted applied. */
  readonly mine: TodoItem
  /** The todo as the gateway holds it now, or `null` when it was deleted. */
  readonly theirs: TodoItem | null
  /** What this client was attempting. */
  readonly intent: TodoWriteIntent
}

/** The todo list as a subtree sees it: state to render, actions to call. */
export interface TodoListController {
  /** The current todos, oldest first. Read-only; mutate through the actions. */
  items: ComputedRef<readonly TodoItem[]>
  /** True while any gateway call is in flight. */
  pending: ComputedRef<boolean>
  /** The last failure, or `null`. Cleared when an operation succeeds. */
  error: ComputedRef<Error | null>
  /** The unresolved write collision, or `null`. See {@link TodoConflictState}. */
  conflict: ComputedRef<TodoConflictState | null>
  /** How many todos are not yet completed. */
  remaining: ComputedRef<number>
  /** True once a refresh has completed, successfully or not. */
  loaded: ComputedRef<boolean>
  /** Replaces the list with what the gateway currently holds. */
  refresh: () => Promise<void>
  /** Creates a todo. Returns false and sets `error` if the gateway rejected. */
  add: (title: string) => Promise<boolean>
  /** Flips a todo's completed flag. Returns false on failure or conflict. */
  toggle: (id: string) => Promise<boolean>
  /** Deletes a todo. Returns false on failure or conflict. */
  remove: (id: string) => Promise<boolean>
  /**
   * Resolves the open conflict by re-applying this client's change on top of
   * the version the gateway holds. Returns false if that write conflicts too.
   */
  keepMine: () => Promise<boolean>
  /**
   * Resolves the open conflict by discarding this client's change and adopting
   * what the gateway holds.
   *
   * This is also what dismissing the conflict does, and deliberately so: the
   * list is known to be behind the moment a conflict is raised, and a "cancel"
   * that left the stale row on screen would leave the user looking at a todo
   * that the next write is going to reject for the same reason.
   */
  keepTheirs: () => void
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
  const conflict = ref<TodoConflictState | null>(null)
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
   *
   * `write` is what a conflict needs to be describable: the gateway knows which
   * version was refused and what the stored row is, and this side knows what the
   * user was trying to do and what they had on screen. Neither half is a
   * conflict on its own. A call made without it — `list`, `create`, neither of
   * which carries a version — treats a conflict as an ordinary error, which is
   * the correct reading: one arriving from there is a bug, not a collision.
   */
  async function run<T>(
    operation: () => Promise<T>,
    write?: { readonly mine: TodoItem; readonly intent: TodoWriteIntent },
  ): Promise<T | null> {
    inFlight.value += 1
    try {
      const result = await operation()
      error.value = null
      return result
    } catch (cause) {
      if (write !== undefined && isTodoConflictError(cause)) {
        // Not an error, and not recorded as one: `error` drives a red banner and
        // a conflict drives a dialog, and showing both would ask the user to
        // read a failure message about a request that did exactly what it should.
        conflict.value = { mine: write.mine, theirs: cause.conflict.current, intent: write.intent }
        error.value = null
        return null
      }
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

  /** The local copy an action names, or `null` with `error` already set. */
  function held(id: string): TodoItem | null {
    const existing = items.value.find((item) => item.id === id)
    if (existing === undefined) {
      error.value = new Error(`Todo "${id}" is not in this list`)
      return null
    }
    return existing
  }

  /**
   * Sends one `completed` write, guarded by `from.version`.
   *
   * Both `toggle` and `keepMine` go through here, which is the point: resolving
   * a conflict is not a special path with its own rules, it is the same write
   * sent again against a newer version — and it can therefore conflict again,
   * because a third client may have written while the user was deciding. A
   * resolver that bypassed the guard "because we already handled the conflict"
   * would be the one unguarded write in the application.
   */
  async function writeCompleted(from: TodoItem, completed: boolean): Promise<boolean> {
    const updated = await run(() => gateway.setCompleted(from.id, completed, from.version), {
      mine: { ...from, completed },
      intent: { kind: 'toggle', completed },
    })
    if (updated === null) return false

    items.value = items.value.map((item) => (item.id === from.id ? updated : item))
    return true
  }

  /** Sends one delete, guarded by `from.version`. Shared with `keepMine`. */
  async function writeRemoval(from: TodoItem): Promise<boolean> {
    const result = await run(
      async () => {
        await gateway.remove(from.id, from.version)
        return true as const
      },
      { mine: from, intent: { kind: 'remove' } },
    )
    if (result === null) return false

    items.value = items.value.filter((item) => item.id !== from.id)
    return true
  }

  async function toggle(id: string): Promise<boolean> {
    const existing = held(id)
    if (existing === null) return false
    return writeCompleted(existing, !existing.completed)
  }

  async function remove(id: string): Promise<boolean> {
    const existing = held(id)
    if (existing === null) return false
    return writeRemoval(existing)
  }

  async function keepMine(): Promise<boolean> {
    const open = conflict.value
    if (open === null) return false

    // Nothing to overwrite: the other client deleted the row. Re-creating it
    // would be a different decision from "keep my change" — the id would be new
    // and every other client's reference to it stale — so the honest resolution
    // is to accept the deletion and say so.
    if (open.theirs === null) {
      keepTheirs()
      return false
    }

    // The change is re-applied to *their* row, not sent as `mine`. `mine` is a
    // snapshot of a version that no longer exists, so writing it back would
    // revert whatever else they changed — the title, in the case the dialog
    // shows — while only intending to change the completed flag.
    conflict.value = null
    return open.intent.kind === 'remove'
      ? writeRemoval(open.theirs)
      : writeCompleted(open.theirs, open.intent.completed)
  }

  function keepTheirs(): void {
    const open = conflict.value
    if (open === null) return

    // Hoisted out of the property so the narrowing survives into the callback
    // below, which is where TypeScript would otherwise widen it back.
    const theirs = open.theirs

    conflict.value = null
    items.value =
      theirs === null
        ? items.value.filter((item) => item.id !== open.mine.id)
        : items.value.map((item) => (item.id === open.mine.id ? theirs : item))
  }

  return {
    items: computed(() => items.value),
    pending: computed(() => inFlight.value > 0),
    error: computed(() => error.value),
    conflict: computed(() => conflict.value),
    remaining: computed(() => items.value.filter((item) => !item.completed).length),
    loaded: computed(() => loaded.value),
    refresh,
    add,
    toggle,
    remove,
    keepMine,
    keepTheirs,
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
