import { beforeEach, describe, expect, it } from 'vitest'

import { useRouteAnnouncement } from '~/composables/useRouteAnnouncement'
import { createFakeNuxtApp, resetFakeNuxtApp, withFakeNuxtApp } from '../../helpers/nuxtApp'

/**
 * The live region's message, and the property the whole announcer rests on: a
 * screen reader announces a *change* to a live region's contents, so assigning
 * the string it already holds announces nothing.
 */

beforeEach(() => {
  resetFakeNuxtApp()
})

/**
 * The composable with its `flush` replaced by a recorder.
 *
 * `renders` holds what the region contained each time a render was awaited, which
 * is the only way to observe the two-step write from outside: by the time
 * `announce` resolves, the intermediate empty string is gone.
 */
function recordingAnnouncer() {
  const renders: string[] = []
  const api = useRouteAnnouncement({
    flush: () => {
      renders.push(api.message.value)
      return Promise.resolve()
    },
  })
  return { ...api, renders }
}

describe('useRouteAnnouncement', () => {
  it('starts empty, so the initial render announces nothing', () => {
    // A live region announces what changes after it is registered. The first
    // render is what registers it, and the document the browser just loaded has
    // already announced itself.
    const { message } = useRouteAnnouncement()

    expect(message.value).toBe('')
  })

  it('publishes a message', async () => {
    const { message, announce } = useRouteAnnouncement()

    await announce('Navigated to Streaming SSR')

    expect(message.value).toBe('Navigated to Streaming SSR')
  })

  it('writes a new message once, without clearing first', async () => {
    // The common path. Clearing here would push an empty region through a render
    // for no benefit, and `tests/unit/lint/page-titles.test.ts` is what makes
    // consecutive announcements differ for every route in `pages/`.
    const { message, announce, renders } = recordingAnnouncer()

    await announce('Navigated to Rendering Modes')
    await announce('Navigated to Streaming SSR')

    expect(renders).toEqual([])
    expect(message.value).toBe('Navigated to Streaming SSR')
  })

  it('clears the region before repeating a message, so the repeat is announced', async () => {
    // Two routes that produce the same announcement — a dynamic route's
    // `/orders/1` and `/orders/2`, say. Without the clear the assignment is a
    // no-op: no re-render, no mutation, and silence.
    const { message, announce, renders } = recordingAnnouncer()

    await announce('Navigated to Order')
    await announce('Navigated to Order')

    // The region was empty for the render between the two writes, which is what
    // makes the second write a change.
    expect(renders).toEqual([''])
    expect(message.value).toBe('Navigated to Order')
  })

  it('keeps one message per Nuxt app', async () => {
    // `useState`, not a module-scope ref. The server builds one app per request,
    // and a live region rendered into the wrong visitor's page is exactly the leak
    // rule 3 of `docs/composable-design-rules.md` is about.
    const first = createFakeNuxtApp()
    const second = createFakeNuxtApp()

    await withFakeNuxtApp(first, () => useRouteAnnouncement().announce('Navigated to Dashboard'))
    const { message } = withFakeNuxtApp(second, () => useRouteAnnouncement())

    expect(message.value).toBe('')
  })

  it('shares one message within a Nuxt app', async () => {
    // The announcer component and the router hooks reach the same state by calling
    // the composable separately; neither passes it to the other.
    const app = createFakeNuxtApp()

    await withFakeNuxtApp(app, () => useRouteAnnouncement().announce('Navigated to File Upload'))
    const { message } = withFakeNuxtApp(app, () => useRouteAnnouncement())

    expect(message.value).toBe('Navigated to File Upload')
  })
})
