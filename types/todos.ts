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
  /** Sets the completed flag and returns the updated todo. */
  setCompleted: (id: string, completed: boolean) => Promise<TodoItem>
  /** Removes a todo. Rejects if `id` does not exist. */
  remove: (id: string) => Promise<void>
}

/** The operations a {@link TodoGateway} exposes, for policies that name them. */
export type TodoGatewayOperation = keyof TodoGateway
