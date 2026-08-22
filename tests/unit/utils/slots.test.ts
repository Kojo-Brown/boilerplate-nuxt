import { describe, it, expect, vi } from 'vitest'

import { forwardSlots } from '../../../utils/slots'

/**
 * `forwardSlots` is tested against a plain object rather than a mounted
 * component on purpose: the properties that matter — that it reads through
 * instead of copying, that it never calls a slot, that Vue's own bookkeeping
 * survives it — are properties of the object it returns, and asserting them
 * directly says which one broke. `tests/unit/components/dataTable.test.ts`
 * covers the other half, that a real wrapper really does deliver a real slot to
 * a real child.
 */

/** Stand-ins for slot functions. Identity is what the assertions check. */
function slot(name: string): () => string[] {
  return () => [name]
}

describe('forwardSlots', () => {
  it('exposes every slot of the source by default', () => {
    const source = { header: slot('header'), footer: slot('footer') }

    const forwarded = forwardSlots(source)

    expect(Object.keys(forwarded)).toEqual(['header', 'footer'])
    expect(forwarded.header).toBe(source.header)
    expect(forwarded.footer).toBe(source.footer)
  })

  it('hides the names the wrapper renders itself', () => {
    const source = { title: slot('title'), 'cell:amount': slot('cell:amount') }

    const forwarded = forwardSlots(source, { except: ['title'] })

    expect(Object.keys(forwarded)).toEqual(['cell:amount'])
    expect(forwarded.title).toBeUndefined()
    expect('title' in forwarded).toBe(false)
  })

  it('forwards only the named slots when `only` is given', () => {
    const source = { a: slot('a'), b: slot('b'), c: slot('c') }

    expect(Object.keys(forwardSlots(source, { only: ['a', 'c'] }))).toEqual(['a', 'c'])
  })

  it('applies `except` on top of `only`', () => {
    const source = { a: slot('a'), b: slot('b') }

    expect(Object.keys(forwardSlots(source, { only: ['a', 'b'], except: ['b'] }))).toEqual(['a'])
  })

  it("never passes on Vue's own bookkeeping keys", () => {
    // `_` says "these slots were compiled together, skip normalization" and
    // `$stable` says "the child need not re-render when the parent does".
    // Both describe the source object, not this one.
    const source = { _: 1, $stable: true, _ctx: {}, header: slot('header') }

    const forwarded = forwardSlots(source)

    expect(Object.keys(forwarded)).toEqual(['header'])
    expect(forwarded._).toBeUndefined()
    expect(forwarded.$stable).toBeUndefined()
  })

  it('reads through to the source instead of copying it', () => {
    // The bug this rules out: a wrapper that spreads `ctx.slots` in `setup()`
    // captures the key set as it was at first render. A parent whose slot sits
    // behind a `v-if` then adds the key later and it never arrives.
    const source: Record<string, () => string[]> = { header: slot('header') }
    const forwarded = forwardSlots(source)

    expect(Object.keys(forwarded)).toEqual(['header'])

    source['empty'] = slot('empty')
    expect(Object.keys(forwarded)).toEqual(['header', 'empty'])
    expect(forwarded['empty']).toBe(source['empty'])

    delete source['header']
    expect(Object.keys(forwarded)).toEqual(['empty'])
    expect('header' in forwarded).toBe(false)
  })

  it('sees a slot function replaced on the source, not the one it first saw', () => {
    const source: Record<string, () => string[]> = { header: slot('first') }
    const forwarded = forwardSlots(source)
    const replacement = slot('second')

    source['header'] = replacement

    expect(forwarded['header']).toBe(replacement)
  })

  it('never calls a slot', () => {
    const header = vi.fn(slot('header'))
    const forwarded = forwardSlots({ header })

    // Reading, enumerating and describing all have to stay lazy: a slot is
    // rendered by the child, in the child's render pass, exactly once.
    Object.keys(forwarded)
    void forwarded.header
    Object.getOwnPropertyDescriptor(forwarded, 'header')

    expect(header).not.toHaveBeenCalled()
  })

  it('lets Vue keep its own state on the forwarded object without leaking it as a slot', () => {
    // Vue writes `_ctx` onto a raw slots object to record which instance owns
    // the slot functions. It has to round-trip, or the child renders slots with
    // no owner — and it must not show up as a slot named `_ctx`.
    const forwarded = forwardSlots<Record<string, unknown>>({ header: slot('header') })
    const owner = { instance: true }

    forwarded['_ctx'] = owner

    expect(forwarded['_ctx']).toBe(owner)
    expect(Object.keys(forwarded)).toEqual(['header'])
  })

  it('supports `for...in`, which is how Vue itself walks raw slots', () => {
    const source = { _: 1, header: slot('header'), footer: slot('footer') }
    const seen: string[] = []

    for (const name in forwardSlots(source)) seen.push(name)

    expect(seen).toEqual(['header', 'footer'])
  })
})
