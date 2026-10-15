import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import AppButton from '~/components/AppButton.vue'

/**
 * The simplest thing this suite can do, and the reason it exists: mount a
 * single-file component and read the DOM it produced.
 *
 * Nothing here needs Nuxt — `AppButton` has no auto-imports and no module
 * dependency — which makes it the honest place to show what `mountSuspended`
 * adds over `@vue/test-utils`' own `mount`: it resolves the component through
 * Nuxt's Vite config (so `~/components/...` and the `<script setup>` compiler
 * behave as they do in the app) and it awaits an async `setup()`. See
 * `contentIndex.nuxt.test.ts` for a component that has one.
 */
describe('AppButton', () => {
  it('renders its slot inside a button of the declared type', async () => {
    const button = await mountSuspended(AppButton, {
      props: { type: 'submit' },
      slots: { default: () => 'Save changes' },
    })

    expect(button.get('button').attributes('type')).toBe('submit')
    expect(button.text()).toBe('Save changes')
  })

  it('defaults to a primary button of type="button"', async () => {
    const button = await mountSuspended(AppButton)

    // `type` is stated rather than left to the browser because a button inside a
    // form submits it by default; the default here is the inert one.
    expect(button.get('button').attributes('type')).toBe('button')
    expect(button.get('button').classes()).toContain('bg-[var(--color-primary)]')
  })

  it.each([
    ['secondary', 'bg-[var(--color-muted)]'],
    ['outline', 'bg-transparent'],
    ['ghost', 'bg-transparent'],
    ['danger', 'bg-red-600'],
  ] as const)('applies the %s variant', async (variant, expected) => {
    const button = await mountSuspended(AppButton, { props: { variant } })

    expect(button.get('button').classes()).toContain(expected)
  })

  it.each([
    ['sm', 'text-xs'],
    ['md', 'text-sm'],
    ['lg', 'text-base'],
  ] as const)('applies the %s size', async (size, expected) => {
    const button = await mountSuspended(AppButton, { props: { size } })

    expect(button.get('button').classes()).toContain(expected)
  })

  it('stretches only when asked to', async () => {
    const plain = await mountSuspended(AppButton)
    const full = await mountSuspended(AppButton, { props: { fullWidth: true } })

    expect(plain.get('button').classes()).not.toContain('w-full')
    expect(full.get('button').classes()).toContain('w-full')
  })

  it('disables the button while loading, not only when disabled', async () => {
    const loading = await mountSuspended(AppButton, { props: { loading: true } })

    // The point of the `disabled || loading` binding: a submit button that is
    // mid-request is still a button a double-click would submit twice.
    expect(loading.get('button').attributes('disabled')).toBeDefined()
    expect(loading.find('svg').exists()).toBe(true)
  })

  it('renders no spinner when idle', async () => {
    const idle = await mountSuspended(AppButton, { slots: { default: () => 'Save' } })

    expect(idle.find('svg').exists()).toBe(false)
    expect(idle.get('button').attributes('disabled')).toBeUndefined()
  })

  it('hides the spinner from assistive technology', async () => {
    const loading = await mountSuspended(AppButton, {
      props: { loading: true },
      slots: { default: () => 'Saving' },
    })

    // The accessible name has to stay the label. A spinner that is not
    // `aria-hidden` is read as part of it.
    expect(loading.get('svg').attributes('aria-hidden')).toBe('true')
    expect(loading.text()).toBe('Saving')
  })
})
