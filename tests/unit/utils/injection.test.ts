import { createApp, createSSRApp, defineComponent, h, ref } from 'vue'
import type { Component, Ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, it, expect } from 'vitest'

import { defineInjection, InjectionNotProvidedError } from '../../../utils/injection'

/**
 * Provide/inject only exists inside a component tree, so these tests render
 * one. `renderToString` is used rather than a DOM mount because the unit suite
 * runs in the `node` environment — and because SSR is where the interesting
 * claim lives: a provided value belongs to the app being rendered, which is one
 * request on the server, not the process.
 */
async function render(root: Component): Promise<string> {
  return renderToString(createSSRApp(root))
}

/** A component that renders whatever `setup` returns, or the error it threw. */
function probe(setup: () => unknown): Component {
  return defineComponent({
    setup() {
      let result: string
      try {
        result = String(setup())
      } catch (error) {
        result = `threw:${(error as Error).message}`
      }
      return () => h('span', result)
    },
  })
}

describe('defineInjection', () => {
  it('carries the value from a provider to a descendant with no props between', async () => {
    const greeting = defineInjection<string>('test.greeting')

    const leaf = probe(() => greeting.inject())
    const middle = defineComponent({ render: () => h(leaf) })
    const root = defineComponent({
      setup() {
        greeting.provide('hello')
        return () => h(middle)
      },
    })

    expect(await render(root)).toBe('<span>hello</span>')
  })

  it('types both ends from one key, so neither side annotates', async () => {
    // The assertion here is the compile, not the string: `provide` accepts only
    // a `{ id: number }` and `inject` returns one without a cast. A `string`
    // passed to `provide` below would fail `pnpm typecheck`.
    const session = defineInjection<{ id: number }>('test.session')

    const leaf = probe(() => session.inject().id + 1)
    const root = defineComponent({
      setup() {
        session.provide({ id: 41 })
        return () => h(leaf)
      },
    })

    expect(await render(root)).toBe('<span>42</span>')
  })

  it('throws a named error when nothing provided the key', async () => {
    const missing = defineInjection<string>('test.missing')

    const output = await render(probe(() => missing.inject()))

    expect(output).toContain('threw:')
    expect(output).toContain('test.missing')
    expect(output).toContain('was not provided by any ancestor')
  })

  it('throws InjectionNotProvidedError, carrying the injection name', () => {
    const missing = defineInjection<string>('test.named')
    const app = createApp({ render: () => null })

    // `runWithContext` gives the injection an app context without a component,
    // which is the shape a Nuxt plugin or a route middleware runs in.
    expect(() => app.runWithContext(() => missing.inject())).toThrow(InjectionNotProvidedError)

    try {
      app.runWithContext(() => missing.inject())
      expect.unreachable('inject() should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(InjectionNotProvidedError)
      expect((error as InjectionNotProvidedError).injectionName).toBe('test.named')
    }
  })

  it('reports being called outside an injection context separately', () => {
    const anything = defineInjection<string>('test.context')

    // No app, no component: not "nobody provided it" but "asked in the wrong
    // place", and the message has to say so or the reader goes looking for a
    // missing provider that is right there.
    expect(() => anything.inject()).toThrow(/outside of a setup\(\) or app context/)
    expect(() => anything.provide('x')).toThrow(/outside of a component setup\(\)/)
  })

  it('injectOr and injectOptional fall back instead of throwing', async () => {
    const optional = defineInjection<string>('test.optional')

    const fallbacks = probe(
      () => `${optional.injectOr('default')}|${String(optional.injectOptional())}`,
    )
    expect(await render(fallbacks)).toBe('<span>default|undefined</span>')

    const provided = probe(() => `${optional.injectOr('default')}|${optional.injectOptional()}`)
    const root = defineComponent({
      setup() {
        optional.provide('given')
        return () => h(provided)
      },
    })
    expect(await render(root)).toBe('<span>given|given</span>')
  })

  it('tells a provided undefined apart from nothing at all', async () => {
    // The reason `inject` is not implemented as `inject(key) ?? throw`: for a
    // nullable `T`, `undefined` is a legitimate value and Vue returns the same
    // `undefined` for both cases.
    const nullable = defineInjection<string | undefined>('test.nullable')

    const leaf = probe(() => `${nullable.isProvided()}|${nullable.injectOr('fallback')}`)
    const root = defineComponent({
      setup() {
        nullable.provide(undefined)
        return () => h(leaf)
      },
    })

    expect(await render(root)).toBe('<span>true|undefined</span>')
    expect(await render(probe(() => nullable.isProvided()))).toBe('<span>false</span>')
  })

  it('keeps two injections apart even when they share a description', async () => {
    // A string key would have collided here. Every `defineInjection` call mints
    // its own symbol, so the description is a label, not an identity.
    const first = defineInjection<string>('duplicate')
    const second = defineInjection<string>('duplicate')

    const leaf = probe(() => `${first.inject()}|${second.injectOr('untouched')}`)
    const root = defineComponent({
      setup() {
        first.provide('mine')
        return () => h(leaf)
      },
    })

    expect(await render(root)).toBe('<span>mine|untouched</span>')
  })

  it('lets a nearer provider shadow a farther one', async () => {
    const level = defineInjection<string>('test.level')

    const leaf = probe(() => level.inject())
    const inner = defineComponent({
      setup() {
        level.provide('inner')
        return () => h(leaf)
      },
    })
    const outer = defineComponent({
      setup() {
        level.provide('outer')
        return () => h(inner, null)
      },
    })

    expect(await render(outer)).toBe('<span>inner</span>')
  })

  it('passes reactivity through when the provided value is a ref', async () => {
    // Injection copies no values and creates no reactivity of its own: what
    // arrives is the same object that was provided, so a ref stays live and a
    // plain number stays a snapshot.
    const counter = defineInjection<{ count: Ref<number> }>('test.counter')
    const source = ref(1)

    const leaf = defineComponent({
      setup() {
        const injected = counter.inject()
        return () => h('span', String(injected.count.value))
      },
    })
    const root = defineComponent({
      setup() {
        counter.provide({ count: source })
        return () => h(leaf)
      },
    })

    source.value = 7
    expect(await render(root)).toBe('<span>7</span>')
  })

  describe('provideTo', () => {
    it('reaches every component in the app, and runWithContext', async () => {
      const config = defineInjection<string>('test.appwide')
      const leaf = probe(() => config.inject())

      const app = createSSRApp(defineComponent({ render: () => h(leaf) }))
      config.provideTo(app, 'from-plugin')

      expect(await renderToString(app)).toBe('<span>from-plugin</span>')
      expect(app.runWithContext(() => config.inject())).toBe('from-plugin')
    })

    it('scopes the value to one app, the way SSR scopes it to one request', () => {
      // The property this whole pattern rests on: a provided dependency lives
      // on the app instance, and Nuxt builds one app per request. A module-scope
      // singleton would answer both of these with the same value.
      const tenant = defineInjection<string>('test.tenant')

      const first = createApp({ render: () => null })
      const second = createApp({ render: () => null })
      tenant.provideTo(first, 'acme')
      tenant.provideTo(second, 'globex')

      expect(first.runWithContext(() => tenant.inject())).toBe('acme')
      expect(second.runWithContext(() => tenant.inject())).toBe('globex')
    })
  })

  it('exposes the raw key for the APIs a wrapper cannot cover', () => {
    const raw = defineInjection<number>('test.raw')

    expect(typeof raw.key).toBe('symbol')
    expect(String(raw.key)).toBe('Symbol(test.raw)')
    expect(raw.name).toBe('test.raw')

    const app = createApp({ render: () => null })
    app.provide(raw.key, 5)
    expect(app.runWithContext(() => raw.inject())).toBe(5)
  })
})
