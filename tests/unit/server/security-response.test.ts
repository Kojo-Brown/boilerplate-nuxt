import { describe, it, expect, beforeEach, vi } from 'vitest'

import { isCspNonce } from '~/server/utils/csp-nonce'
import { applySecurityHeaders } from '~/server/utils/security-response'

/**
 * `applySecurityHeaders`, invoked directly with a fake event.
 *
 * It is the whole body of the `request` hook in
 * `server/plugins/security-headers.ts`, split into its own module so that this
 * file needs no plugin machinery: everything it touches (`useRuntimeConfig`,
 * `getRequestHeader`, `setResponseHeader`) is a Nitro auto-import called at
 * request time, so a per-file stub is early enough.
 *
 * `tests/unit/server/security-headers.test.ts` asserts what the policy *says*.
 * This file asserts only what the request half decides: which path gets a nonce,
 * whether the nonce reaches the context, and that every header it built is set.
 */

interface FakeEvent {
  path: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  node?: { req: { socket: object } }
}

function createEvent(
  path: string,
  requestHeaders: Record<string, string> = {},
  socket: object = {},
): FakeEvent {
  return { path, context: {}, requestHeaders, responseHeaders: {}, node: { req: { socket } } }
}

/** Cast at the single boundary where a fake event meets a typed function. */
function run(event: FakeEvent): void {
  ;(applySecurityHeaders as unknown as (event: FakeEvent) => void)(event)
}

let runtimeConfig: Record<string, unknown> = {}

beforeEach(() => {
  runtimeConfig = {}

  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.requestHeaders[name])
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.responseHeaders[name] = value
  })
})

describe('applySecurityHeaders', () => {
  it('sets the full header set on an ordinary request', () => {
    const event = createEvent('/api/todos')

    run(event)

    expect(Object.keys(event.responseHeaders).sort()).toEqual([
      'content-security-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'permissions-policy',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
    ])
  })

  it('publishes a fresh, well-formed nonce on the context and in the policy', () => {
    const event = createEvent('/')

    run(event)

    const nonce = event.context.cspNonce
    expect(isCspNonce(nonce)).toBe(true)
    expect(event.responseHeaders['content-security-policy']).toContain(`'nonce-${nonce}'`)
  })

  it('mints a different nonce per request', () => {
    const first = createEvent('/')
    const second = createEvent('/')

    run(first)
    run(second)

    expect(first.context.cspNonce).not.toBe(second.context.cspNonce)
  })

  it('gives shared HTML no nonce at all, on the context or in the policy', () => {
    const event = createEvent('/route-rules/static')

    run(event)

    expect(event.context.cspNonce).toBeUndefined()
    const policy = event.responseHeaders['content-security-policy'] ?? ''
    expect(policy).not.toContain('nonce-')
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('normalises the path before deciding, so an escaped traversal cannot dodge the rule', () => {
    // `/rendering/isr` is cached, so it must not be handed a nonce however the
    // caller spells it. The same normalisation guards `10.auth.ts`; see
    // server/utils/request-path.ts.
    const event = createEvent('/rendering/%2e%2e/rendering/isr?x=1')

    run(event)

    expect(event.context.cspNonce).toBeUndefined()
  })

  it('adds HSTS when a proxy says the request arrived over TLS', () => {
    const event = createEvent('/', { 'x-forwarded-proto': 'https' })

    run(event)

    expect(event.responseHeaders['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
    expect(event.responseHeaders['content-security-policy']).toContain('upgrade-insecure-requests')
  })

  it('adds HSTS for a direct TLS connection with no proxy header', () => {
    const event = createEvent('/', {}, { encrypted: true })

    run(event)

    expect(event.responseHeaders).toHaveProperty('strict-transport-security')
  })

  it('reads runtimeConfig, so a deployment can widen a directive without a code change', () => {
    runtimeConfig = { security: { csp: { connectSrc: 'https://api.example.com' } } }
    const event = createEvent('/')

    run(event)

    expect(event.responseHeaders['content-security-policy']).toContain(
      "connect-src 'self' https://api.example.com",
    )
  })

  it('still sets the other headers when the CSP is turned off', () => {
    runtimeConfig = { security: { csp: { mode: 'off' } } }
    const event = createEvent('/')

    run(event)

    expect(event.responseHeaders).not.toHaveProperty('content-security-policy')
    expect(event.responseHeaders['x-content-type-options']).toBe('nosniff')
  })

  it('survives an event with no node socket, as a non-node preset produces', () => {
    const event = createEvent('/')
    delete event.node

    expect(() => run(event)).not.toThrow()
    expect(event.responseHeaders).not.toHaveProperty('strict-transport-security')
  })
})
