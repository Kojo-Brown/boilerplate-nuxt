import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import AppModal from '~/components/AppModal.vue'

/**
 * Everything about `AppModal` lives outside its own subtree: the dialog is
 * `<Teleport>`ed to `document.body`, and the Escape key is a listener on
 * `document`. Both are the kind of claim the node suite cannot check — there is
 * no document — and both are what this suite is for.
 *
 * Each test unmounts its own modal. Teleported markup is appended to the body,
 * which `mountSuspended` does not own and nothing resets between tests, so a
 * modal left mounted is a dialog the next test's `document.body` query finds.
 */
async function mountModal(props: Partial<InstanceType<typeof AppModal>['$props']> = {}) {
  const modal = await mountSuspended(AppModal, {
    props: { modelValue: true, ...props },
    slots: { default: () => 'Discard your draft?' },
  })
  onTestFinished(() => modal.unmount())
  return modal
}

/** The teleported dialog, which is in the body rather than in the wrapper. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]')
}

describe('AppModal', () => {
  it('teleports the dialog to the body, not into its own subtree', async () => {
    const modal = await mountModal()

    expect(modal.find('[role="dialog"]').exists()).toBe(false)
    expect(dialog()).not.toBeNull()
    expect(dialog()?.textContent).toContain('Discard your draft?')
  })

  it('renders nothing while closed', async () => {
    await mountModal({ modelValue: false })

    expect(dialog()).toBeNull()
  })

  it('marks the dialog modal and names it from the title', async () => {
    await mountModal({ title: 'Discard draft' })

    expect(dialog()?.getAttribute('aria-modal')).toBe('true')
    expect(dialog()?.getAttribute('aria-labelledby')).toBe('modal-title')
    expect(document.body.querySelector('#modal-title')?.textContent?.trim()).toBe('Discard draft')
  })

  it('leaves the dialog unnamed rather than pointing at a heading it did not render', async () => {
    await mountModal()

    // An `aria-labelledby` whose target does not exist is worse than none: a
    // screen reader announces an unnamed dialog either way, and the broken
    // reference hides the fact that the modal has no heading.
    expect(dialog()?.hasAttribute('aria-labelledby')).toBe(false)
    expect(document.body.querySelector('#modal-title')).toBeNull()
  })

  it('emits a closing update:modelValue from the close button', async () => {
    const modal = await mountModal({ title: 'Discard draft' })
    const close = document.body.querySelector<HTMLElement>('[aria-label="Close modal"]')

    close?.click()
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toEqual([[false]])
  })

  it('closes on a backdrop click', async () => {
    const modal = await mountModal()

    backdrop()?.click()
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toEqual([[false]])
  })

  it('keeps the dialog open on a backdrop click when told to', async () => {
    const modal = await mountModal({ closeOnBackdrop: false })

    backdrop()?.click()
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toBeUndefined()
  })

  it('closes on Escape from anywhere in the document', async () => {
    const modal = await mountModal()

    // Dispatched on the document, not on the dialog: the listener is there
    // because focus is usually inside the dialog's content, and a keydown on an
    // input does not reach a handler bound to the dialog's own element.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toEqual([[false]])
  })

  it('ignores Escape while closed', async () => {
    const modal = await mountModal({ modelValue: false })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toBeUndefined()
  })

  it('ignores other keys', async () => {
    const modal = await mountModal()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await modal.vm.$nextTick()

    expect(modal.emitted('update:modelValue')).toBeUndefined()
  })

  it('removes its document listener when unmounted', async () => {
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    onTestFinished(() => {
      vi.restoreAllMocks()
    })

    const modal = await mountSuspended(AppModal, { props: { modelValue: true } })
    const registered = keydownHandlers(added)
    modal.unmount()

    // Handler identity, not a dispatched key: a leaked listener fires on an
    // unmounted component, whose `emit` goes nowhere, so a modal that never
    // cleaned up would emit nothing and look like one that did. What the leak
    // actually costs is a handler per open on a page that opens a modal per row,
    // and that is this comparison.
    expect(registered).toHaveLength(1)
    expect(keydownHandlers(removed)).toEqual(registered)
  })

  it('renders the slot content a caller passed instead of the default header', async () => {
    const modal = await mountSuspended(AppModal, {
      props: { modelValue: true, title: 'Ignored' },
      slots: { header: () => 'Custom header', footer: () => 'Custom footer' },
    })
    onTestFinished(() => modal.unmount())

    expect(dialog()?.textContent).toContain('Custom header')
    expect(dialog()?.textContent).toContain('Custom footer')
    expect(dialog()?.textContent).not.toContain('Ignored')
  })
})

/** The `keydown` handlers passed to one of the spied `document` methods. */
function keydownHandlers(spy: MockInstance<typeof document.addEventListener>): unknown[] {
  return spy.mock.calls.filter(([type]) => type === 'keydown').map(([, handler]) => handler)
}

/** The backdrop, which is the dialog's first child and `aria-hidden`. */
function backdrop(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"] [aria-hidden="true"]')
}
