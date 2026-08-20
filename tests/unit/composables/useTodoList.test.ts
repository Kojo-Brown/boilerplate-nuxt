import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import type { Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, it, expect, vi } from 'vitest'

import {
  createTodoList,
  provideTodoList,
  todoListInjection,
  useTodoList,
} from '../../../composables/useTodoList'
import { createInMemoryTodoGateway, todoGatewayInjection } from '../../../utils/todoGateway'

import type { TodoGateway, TodoItem } from '~/types/todos'

const SEED: readonly TodoItem[] = [
  { id: 'a', title: 'Alpha', completed: false, createdAt: '2026-01-01T09:00:00.000Z' },
  { id: 'b', title: 'Beta', completed: true, createdAt: '2026-01-01T09:05:00.000Z' },
]

/**
 * The payoff of the port: every test below runs against a gateway handed in by
 * hand. No `$fetch` stub, no MSW, no database, and no component either — the
 * controller is built from an interface, so it can be driven directly.
 */
function memoryGateway(seed: readonly TodoItem[] = SEED): TodoGateway {
  let issued = 0
  return createInMemoryTodoGateway({
    seed,
    nextId: () => `new-${(issued += 1)}`,
    now: () => new Date('2026-02-02T12:00:00.000Z'),
  })
}

/** A gateway whose calls the test resolves by hand, for testing overlap. */
function deferredGateway() {
  const pending: { resolve: (items: readonly TodoItem[]) => void }[] = []

  const gateway: TodoGateway = {
    list: () =>
      new Promise<readonly TodoItem[]>((resolve) => {
        pending.push({ resolve })
      }),
    create: () => Promise.reject(new Error('not used')),
    setCompleted: () => Promise.reject(new Error('not used')),
    remove: () => Promise.reject(new Error('not used')),
  }

  return { gateway, pending }
}

describe('createTodoList', () => {
  it('starts empty and not loaded', () => {
    const list = createTodoList(memoryGateway())

    expect(list.items.value).toEqual([])
    expect(list.loaded.value).toBe(false)
    expect(list.pending.value).toBe(false)
    expect(list.error.value).toBeNull()
  })

  it('refreshes from the gateway', async () => {
    const list = createTodoList(memoryGateway())

    await list.refresh()

    expect(list.items.value).toEqual(SEED)
    expect(list.loaded.value).toBe(true)
    expect(list.remaining.value).toBe(1)
  })

  it('reports pending while a call is in flight', async () => {
    const { gateway, pending } = deferredGateway()
    const list = createTodoList(gateway)

    const refreshing = list.refresh()
    await nextTick()
    expect(list.pending.value).toBe(true)

    pending[0]?.resolve(SEED)
    await refreshing
    expect(list.pending.value).toBe(false)
  })

  it('appends what the gateway returned rather than what was typed', async () => {
    const list = createTodoList(memoryGateway())
    await list.refresh()

    expect(await list.add('  Gamma  ')).toBe(true)

    // The trimmed title and the issued id both come back from the adapter,
    // which is the authority on what was stored.
    expect(list.items.value.at(-1)).toEqual({
      id: 'new-1',
      title: 'Gamma',
      completed: false,
      createdAt: '2026-02-02T12:00:00.000Z',
    })
    expect(list.remaining.value).toBe(2)
  })

  it('toggles a todo and keeps its position', async () => {
    const list = createTodoList(memoryGateway())
    await list.refresh()

    expect(await list.toggle('a')).toBe(true)

    expect(list.items.value.map((item) => item.id)).toEqual(['a', 'b'])
    expect(list.items.value[0]?.completed).toBe(true)
    expect(list.remaining.value).toBe(0)
  })

  it('removes a todo', async () => {
    const list = createTodoList(memoryGateway())
    await list.refresh()

    expect(await list.remove('b')).toBe(true)

    expect(list.items.value.map((item) => item.id)).toEqual(['a'])
  })

  it('refuses to toggle something that is not in the list', async () => {
    const gateway = memoryGateway()
    const setCompleted = vi.spyOn(gateway, 'setCompleted')
    const list = createTodoList(gateway)
    await list.refresh()

    expect(await list.toggle('ghost')).toBe(false)

    expect(list.error.value?.message).toBe('Todo "ghost" is not in this list')
    expect(setCompleted).not.toHaveBeenCalled()
  })

  describe('failure', () => {
    /** Rejects everything, the way an unreachable backend does. */
    function brokenGateway(message = 'backend down'): TodoGateway {
      const fail = (): Promise<never> => Promise.reject(new Error(message))
      return { list: fail, create: fail, setCompleted: fail, remove: fail }
    }

    it('captures a failed refresh and keeps the previous items', async () => {
      const list = createTodoList(memoryGateway())
      await list.refresh()

      const failing = createTodoList(brokenGateway())
      await failing.refresh()

      expect(failing.error.value?.message).toBe('backend down')
      expect(failing.items.value).toEqual([])
      // `loaded` still flips: the list is not loading any more, it failed.
      expect(failing.loaded.value).toBe(true)
      expect(failing.pending.value).toBe(false)
    })

    it('reports a failed add without dropping the list', async () => {
      const gateway = memoryGateway()
      const list = createTodoList(gateway)
      await list.refresh()

      vi.spyOn(gateway, 'create').mockRejectedValueOnce(new Error('rejected by the service'))

      expect(await list.add('Gamma')).toBe(false)
      expect(list.error.value?.message).toBe('rejected by the service')
      expect(list.items.value).toEqual(SEED)
    })

    it('leaves a todo alone when the toggle fails', async () => {
      const gateway = memoryGateway()
      const list = createTodoList(gateway)
      await list.refresh()

      vi.spyOn(gateway, 'setCompleted').mockRejectedValueOnce(new Error('conflict'))

      expect(await list.toggle('a')).toBe(false)
      expect(list.items.value[0]?.completed).toBe(false)
    })

    it('keeps a todo when its delete fails', async () => {
      const gateway = memoryGateway()
      const list = createTodoList(gateway)
      await list.refresh()

      vi.spyOn(gateway, 'remove').mockRejectedValueOnce(new Error('conflict'))

      expect(await list.remove('a')).toBe(false)
      expect(list.items.value.map((item) => item.id)).toEqual(['a', 'b'])
    })

    it('wraps a non-Error rejection so `error.message` is always readable', async () => {
      const gateway = memoryGateway()
      vi.spyOn(gateway, 'list').mockRejectedValueOnce('just a string')

      const list = createTodoList(gateway)
      await list.refresh()

      expect(list.error.value).toBeInstanceOf(Error)
      expect(list.error.value?.message).toBe('just a string')
    })

    it('clears the error once something succeeds', async () => {
      const gateway = memoryGateway()
      const list = createTodoList(gateway)

      vi.spyOn(gateway, 'list').mockRejectedValueOnce(new Error('transient'))
      await list.refresh()
      expect(list.error.value).not.toBeNull()

      await list.refresh()
      expect(list.error.value).toBeNull()
      expect(list.items.value).toEqual(SEED)
    })
  })

  it('ignores a refresh that finishes after a newer one', async () => {
    // Two refreshes, answered out of order. Without the generation guard the
    // list settles on the older response — the classic "I clicked twice and got
    // yesterday's data" bug.
    const { gateway, pending } = deferredGateway()
    const list = createTodoList(gateway)

    const first = list.refresh()
    const second = list.refresh()
    await nextTick()
    expect(pending).toHaveLength(2)

    pending[1]?.resolve(SEED)
    await second
    pending[0]?.resolve([])
    await first

    expect(list.items.value).toEqual(SEED)
  })
})

describe('provideTodoList / useTodoList', () => {
  /** Renders `leaf` under a board that provides a list over `gateway`. */
  async function renderBoard(gateway: TodoGateway, leaf: Component): Promise<string> {
    const board = defineComponent({
      setup() {
        provideTodoList()
        return () => h(leaf)
      },
    })
    const root = defineComponent({
      setup() {
        todoGatewayInjection.provide(gateway)
        return () => h(board)
      },
    })

    return renderToString(createSSRApp(root))
  }

  it('builds the list over the injected gateway', async () => {
    const leaf = defineComponent({
      async setup() {
        const list = useTodoList()
        await list.refresh()
        return () => h('span', list.items.value.map((item) => item.title).join(','))
      },
    })

    expect(await renderBoard(memoryGateway(), leaf)).toBe('<span>Alpha,Beta</span>')
  })

  it('hands the same controller to every descendant, at any depth', async () => {
    // What the injection is for: the deep leaf sees the todo the shallow one
    // added, and no component in between forwarded anything.
    const deep = defineComponent({
      setup() {
        const list = useTodoList()
        return () => h('em', String(list.items.value.length))
      },
    })
    const middle = defineComponent({ render: () => h('div', [h(deep)]) })
    const shallow = defineComponent({
      async setup() {
        const list = useTodoList()
        await list.refresh()
        await list.add('Gamma')
        return () => h('div', [h(middle)])
      },
    })

    expect(await renderBoard(memoryGateway(), shallow)).toBe('<div><div><em>3</em></div></div>')
  })

  it('accepts an explicit gateway, overriding the injected one', async () => {
    const leaf = defineComponent({
      async setup() {
        const list = useTodoList()
        await list.refresh()
        return () => h('span', String(list.items.value.length))
      },
    })
    const board = defineComponent({
      setup() {
        provideTodoList(memoryGateway([]))
        return () => h(leaf)
      },
    })
    const root = defineComponent({
      setup() {
        todoGatewayInjection.provide(memoryGateway())
        return () => h(board)
      },
    })

    expect(await renderToString(createSSRApp(root))).toBe('<span>0</span>')
  })

  it('fails with a named error when the gateway was never provided', async () => {
    const board = defineComponent({
      setup() {
        try {
          provideTodoList()
        } catch (error) {
          return () => h('span', (error as Error).message)
        }
        return () => h('span', 'provided')
      },
    })

    const output = await renderToString(createSSRApp(board))

    expect(output).toContain('todos.gateway')
    expect(output).toContain('was not provided by any ancestor')
  })

  it('fails with a named error when a todo component is rendered outside a board', async () => {
    const orphan = defineComponent({
      setup() {
        try {
          useTodoList()
        } catch (error) {
          return () => h('span', (error as Error).message)
        }
        return () => h('span', 'injected')
      },
    })

    expect(await renderToString(createSSRApp(orphan))).toContain('todos.list')
  })

  it('gives each app its own list, the way each request gets its own', async () => {
    // Two renders of the same components, sharing nothing: the injection lives
    // on the app, and a Nuxt server builds one app per request.
    const leaf = defineComponent({
      async setup() {
        const list = useTodoList()
        await list.refresh()
        await list.add('added by this request')
        return () => h('span', String(list.items.value.length))
      },
    })

    const first = await renderBoard(memoryGateway(), leaf)
    const second = await renderBoard(memoryGateway(), leaf)

    expect(first).toBe('<span>3</span>')
    expect(second).toBe('<span>3</span>')
  })

  it('exposes the key for wiring that cannot call provide()', () => {
    expect(String(todoListInjection.key)).toBe('Symbol(todos.list)')
    expect(String(todoGatewayInjection.key)).toBe('Symbol(todos.gateway)')
  })
})
