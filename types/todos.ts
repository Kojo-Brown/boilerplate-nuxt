/**
 * The todo domain as the UI needs it, and the port it talks to.
 *
 * Nothing here mentions HTTP, Drizzle, or the shape the database happens to
 * store — that is the point. The types are owned by the consumer, and each
 * adapter in `utils/todoGateway.ts` is responsible for mapping its own
 * transport onto them.
 */

/** A todo as every component in this app understands it. */
export interface TodoItem {
  id: string
  title: string
  completed: boolean
  /** ISO-8601. A string rather than a `Date` so it survives SSR serialization. */
  createdAt: string
  /**
   * Which revision of this todo the value describes.
   *
   * Part of the domain type rather than an HTTP detail the adapter hides,
   * because the *caller* is what has to carry it: a write says which version it
   * believed it was changing, and only the code holding the item knows that. An
   * adapter that swallowed the version would have to invent one at write time,
   * which is last-write-wins with extra steps. See
   * `docs/optimistic-concurrency.md`.
   */
  version: number
}

/** Everything the caller supplies when creating a todo; the rest is the store's. */
export interface TodoDraft {
  title: string
}

/**
 * The port: what the todo UI needs from the outside world, stated as an
 * interface it owns.
 *
 * The dependency-inversion part is which way this interface points. A
 * component that calls `$fetch('/api/todos')` depends on the transport, so it
 * can only run where that transport works — the network, a database, a signed
 * session — and a test either starts all of it or mocks the global. With the
 * call behind a port, both the component and the HTTP client depend on *this*,
 * and swapping one for another is a different value provided at the top of the
 * subtree. `createInMemoryTodoGateway` and `createHttpTodoGateway` are peers,
 * not "the fake" and "the real one".
 *
 * Every method rejects rather than returning an error union, so a caller that
 * forgets to handle failure fails loudly instead of rendering an error object.
 */
export interface TodoGateway {
  /** All todos, oldest first. */
  list: () => Promise<readonly TodoItem[]>
  /** Creates a todo and returns it as stored. */
  create: (draft: TodoDraft) => Promise<TodoItem>
  /**
   * Sets the completed flag and returns the updated todo.
   *
   * @param expectedVersion The {@link TodoItem.version} the caller is working
   *   from. Rejects with a {@link TodoConflict}-carrying error if the stored
   *   todo has moved past it — see `docs/optimistic-concurrency.md`. It is a
   *   required argument and not an optional one on purpose: a default would be
   *   a default answer to "what did you think you were overwriting", and there
   *   is no safe one.
   */
  setCompleted: (id: string, completed: boolean, expectedVersion: number) => Promise<TodoItem>
  /**
   * Removes a todo. Rejects if `id` does not exist, or if the stored todo has
   * moved past `expectedVersion`.
   */
  remove: (id: string, expectedVersion: number) => Promise<void>
}

/**
 * What a rejected write found instead of the version the caller expected.
 *
 * Carried on the rejection rather than left for the caller to fetch: the client
 * is already behind at this point, and a re-read would both cost a round trip
 * and open a second race — it can land after *another* edit, showing a third
 * version that neither writer ever saw.
 */
export interface TodoConflict {
  /** The todo the write was aimed at. */
  readonly id: string
  /** The version the caller said it held. */
  readonly expectedVersion: number
  /** The todo as it is stored now, or `null` when it has been deleted. */
  readonly current: TodoItem | null
}

/** The operations a {@link TodoGateway} exposes, for policies that name them. */
export type TodoGatewayOperation = keyof TodoGateway
