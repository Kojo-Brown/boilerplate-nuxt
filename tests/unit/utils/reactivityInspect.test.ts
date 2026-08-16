import { describe, it, expect, vi } from 'vitest'
import {
  computed,
  customRef,
  reactive,
  readonly,
  ref,
  shallowReactive,
  shallowReadonly,
  shallowRef,
  toRef,
  toRefs,
  watchSyncEffect,
} from 'vue'

import {
  assertTracked,
  describeReactivity,
  formatReactivity,
} from '../../../utils/reactivityInspect'
import type { ReactivityKind } from '../../../utils/reactivityInspect'

describe('describeReactivity', () => {
  describe('kinds', () => {
    const cases: Array<[string, () => unknown, ReactivityKind]> = [
      ['ref', () => ref(0), 'ref'],
      ['writable computed', () => computed({ get: () => 0, set: () => {} }), 'ref'],
      [
        'customRef',
        () => customRef((track, trigger) => ({ get: () => (track(), 0), set: trigger })),
        'ref',
      ],
      ['shallowRef', () => shallowRef(0), 'shallowRef'],
      ['read-only computed', () => computed(() => 0), 'readonlyRef'],
      ['readonly(ref)', () => readonly(ref(0)), 'readonlyRef'],
      ['reactive', () => reactive({ a: 1 }), 'reactive'],
      ['shallowReactive', () => shallowReactive({ a: 1 }), 'shallowReactive'],
      ['readonly(reactive)', () => readonly(reactive({ a: 1 })), 'readonlyReactive'],
      ['readonly(plain)', () => readonly({ a: 1 }), 'readonly'],
      ['shallowReadonly(plain)', () => shallowReadonly({ a: 1 }), 'shallowReadonly'],
      ['plain object', () => ({ a: 1 }), 'plain'],
      ['array', () => [1, 2], 'plain'],
      ['number', () => 1, 'plain'],
      ['string', () => 'x', 'plain'],
      ['null', () => null, 'plain'],
      ['undefined', () => undefined, 'plain'],
    ]

    it.each(cases)('classifies %s as %s', (_label, build, expected) => {
      expect(describeReactivity(build()).kind).toBe(expected)
    })
  })

  describe('flags', () => {
    it('marks every non-plain kind as tracked', () => {
      expect(describeReactivity(ref(0)).tracked).toBe(true)
      expect(describeReactivity(reactive({ a: 1 })).tracked).toBe(true)
      expect(describeReactivity(readonly({ a: 1 })).tracked).toBe(true)
    })

    it('marks a value flattened by destructuring as untracked', () => {
      const state = reactive({ count: 0 })
      const { count } = state

      expect(describeReactivity(state).tracked).toBe(true)
      expect(describeReactivity(count).tracked).toBe(false)
    })

    it('reports shallow only for the shallow constructors', () => {
      expect(describeReactivity(shallowRef(0)).shallow).toBe(true)
      expect(describeReactivity(shallowReactive({ a: 1 })).shallow).toBe(true)
      expect(describeReactivity(shallowReadonly({ a: 1 })).shallow).toBe(true)
      expect(describeReactivity(ref(0)).shallow).toBe(false)
      expect(describeReactivity(reactive({ a: 1 })).shallow).toBe(false)
    })

    it('reports readonly for readonly proxies and read-only computeds', () => {
      expect(describeReactivity(readonly({ a: 1 })).readonly).toBe(true)
      expect(describeReactivity(computed(() => 0)).readonly).toBe(true)
      expect(describeReactivity(computed({ get: () => 0, set: () => {} })).readonly).toBe(false)
      expect(describeReactivity(reactive({ a: 1 })).readonly).toBe(false)
    })

    it('reports deep for tracked, non-shallow values only', () => {
      expect(describeReactivity(reactive({ a: 1 })).deep).toBe(true)
      expect(describeReactivity(ref({ a: 1 })).deep).toBe(true)
      expect(describeReactivity(shallowReactive({ a: 1 })).deep).toBe(false)
      expect(describeReactivity(shallowRef({ a: 1 })).deep).toBe(false)
      expect(describeReactivity({ a: 1 }).deep).toBe(false)
    })
  })

  it('adds no dependency to the effect that calls it', () => {
    // The whole point of a diagnostic is that inspecting a value cannot change
    // which effects re-run. Reading `.value` here would make this effect
    // depend on the ref and re-run on every write.
    const source = ref(0)
    const runs = vi.fn()

    watchSyncEffect(() => {
      describeReactivity(source)
      formatReactivity(source)
      runs()
    })
    expect(runs).toHaveBeenCalledTimes(1)

    source.value = 1
    expect(runs).toHaveBeenCalledTimes(1)
  })

  it('does not read through a reactive proxy either', () => {
    const state = reactive({ a: 1 })
    const runs = vi.fn()

    watchSyncEffect(() => {
      describeReactivity(state)
      runs()
    })

    state.a = 2
    expect(runs).toHaveBeenCalledTimes(1)
  })
})

describe('formatReactivity', () => {
  it.each([
    [() => ref(0), 'ref (deep)'],
    [() => reactive({ a: 1 }), 'reactive (deep)'],
    [() => shallowRef(0), 'shallowRef'],
    [() => shallowReactive({ a: 1 }), 'shallowReactive'],
    [() => computed(() => 0), 'readonlyRef (deep, read-only)'],
    [() => readonly({ a: 1 }), 'readonly (deep)'],
    [() => shallowReadonly({ a: 1 }), 'shallowReadonly'],
    [() => 42, 'plain (not tracked)'],
  ])('renders %#', (build, expected) => {
    expect(formatReactivity(build())).toBe(expected)
  })

  it('separates the two sides of a destructure', () => {
    const state = reactive({ count: 0 })
    const { count } = state
    const live = toRef(state, 'count')

    expect(formatReactivity(state)).toBe('reactive (deep)')
    expect(formatReactivity(count)).toBe('plain (not tracked)')
    expect(formatReactivity(live)).toBe('ref (deep)')
  })
})

describe('assertTracked', () => {
  it('accepts refs and reactive proxies', () => {
    expect(() => assertTracked(ref(0), 'state')).not.toThrow()
    expect(() => assertTracked(shallowRef(0), 'state')).not.toThrow()
    expect(() =>
      assertTracked(
        computed(() => 0),
        'state',
      ),
    ).not.toThrow()
    expect(() => assertTracked(reactive({ a: 1 }), 'state')).not.toThrow()
    expect(() => assertTracked(readonly({ a: 1 }), 'state')).not.toThrow()
  })

  it('accepts the refs toRefs hands back', () => {
    const { a } = toRefs(reactive({ a: 1 }))
    expect(() => assertTracked(a, 'useThing(a)')).not.toThrow()
  })

  it('rejects a destructured copy, naming the call site', () => {
    const state = reactive({ count: 0 })
    const { count } = state

    expect(() => assertTracked(count, 'useFilters(state.count)')).toThrow(TypeError)
    expect(() => assertTracked(count, 'useFilters(state.count)')).toThrow(
      /useFilters\(state\.count\) must be a ref or a reactive object/,
    )
  })

  it('points at toRef/toRefs as the fix', () => {
    expect(() => assertTracked(0, 'state')).toThrow(/toRef\(\)\/toRefs\(\)/)
  })

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [1, 'a number'],
    ['x', 'a string'],
    [{ a: 1 }, 'a plain object'],
    [[1], 'a plain array'],
  ])('describes what it got instead (%#)', (value, expected) => {
    expect(() => assertTracked(value, 'state')).toThrow(new RegExp(`\\(${expected}\\)`))
  })
})
