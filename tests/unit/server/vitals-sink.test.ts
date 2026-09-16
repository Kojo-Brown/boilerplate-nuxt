import { describe, it, expect, vi } from 'vitest'

import {
  assertSinkUrl,
  createHttpVitalsSink,
  createLoggingVitalsSink,
  createThrottledLogger,
  deliverVitals,
  resolveVitalsSinkPlan,
  toTimeoutMs,
  vitalsBootWarning,
  type VitalsSink,
} from '~/server/utils/vitals-sink'
import type { VitalsBatch } from '~/types/vitals'

const batch: VitalsBatch = {
  sentAt: '2026-02-01T10:00:00.000Z',
  page: { visitId: 'visit-1' },
  samples: [
    {
      name: 'LCP',
      value: 2100,
      rating: 'good',
      id: 'v1-1',
      navigationType: 'navigate',
      route: '/pricing',
    },
  ],
}

describe('assertSinkUrl', () => {
  it('accepts an http(s) URL', () => {
    expect(() => assertSinkUrl('https://collector.test/v1/vitals')).not.toThrow()
    expect(() => assertSinkUrl('http://localhost:9000/collect')).not.toThrow()
  })

  it('rejects a non-URL and a non-HTTP scheme', () => {
    expect(() => assertSinkUrl('collector.test')).toThrow(/NUXT_VITALS_SINK_URL is not a URL/)
    expect(() => assertSinkUrl('redis://host:6379')).toThrow(/not an HTTP scheme/)
  })

  it('never echoes the URL, which routinely carries an API key', () => {
    try {
      assertSinkUrl('ftp://collector.test/ingest?key=super-secret-token')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-token')
    }
  })
})

describe('toTimeoutMs', () => {
  it('defaults, coerces and clamps', () => {
    expect(toTimeoutMs(undefined)).toBe(3000)
    expect(toTimeoutMs('1500')).toBe(1500)
    expect(toTimeoutMs(5)).toBe(100)
    expect(toTimeoutMs(999_999)).toBe(30_000)
    expect(toTimeoutMs('not a number')).toBe(3000)
  })
})

describe('resolveVitalsSinkPlan', () => {
  it('logs in dev and does nothing else when no sink is configured', () => {
    expect(resolveVitalsSinkPlan({}, true)).toEqual({
      forwardUrl: null,
      timeoutMs: 3000,
      logging: true,
    })
    expect(resolveVitalsSinkPlan({ vitals: { sinkUrl: '  ' } }, false)).toEqual({
      forwardUrl: null,
      timeoutMs: 3000,
      logging: false,
    })
  })

  it('forwards, and stops logging, once a URL is set', () => {
    expect(
      resolveVitalsSinkPlan(
        { vitals: { sinkUrl: 'https://collector.test/v1', timeoutMs: '800' } },
        true,
      ),
    ).toEqual({ forwardUrl: 'https://collector.test/v1', timeoutMs: 800, logging: false })
  })

  it('throws on a URL that is set but unusable', () => {
    // Misconfigured is fatal, the stance `storage.ts` documents: a server that
    // booted with a typo'd collector would look configured and forward nothing.
    expect(() => resolveVitalsSinkPlan({ vitals: { sinkUrl: 'collector.test' } }, false)).toThrow()
  })
})

describe('vitalsBootWarning', () => {
  it('warns a built server that its only copy is in memory', () => {
    const warning = vitalsBootWarning({ forwardUrl: null, timeoutMs: 3000, logging: false }, false)

    expect(warning).toContain('NUXT_VITALS_SINK_URL is unset')
    expect(warning).toContain('/api/vitals/summary')
  })

  it('says nothing in dev, or when forwarding is configured', () => {
    expect(vitalsBootWarning({ forwardUrl: null, timeoutMs: 3000, logging: true }, true)).toBeNull()
    expect(
      vitalsBootWarning(
        { forwardUrl: 'https://collector.test', timeoutMs: 3000, logging: false },
        false,
      ),
    ).toBeNull()
  })
})

describe('createHttpVitalsSink', () => {
  it('POSTs the batch unchanged, with nothing added to it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    const sink = createHttpVitalsSink({
      url: 'https://collector.test/v1',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    })

    await sink.deliver(batch)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://collector.test/v1')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Verbatim: no user agent, no client IP, no session. Enriching a third
    // party's payload with request metadata is not this route's call to make.
    expect(JSON.parse(String(init.body))).toEqual(batch)
  })

  it('throws with the status and an excerpt of the body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('quota exceeded for this project', { status: 429 })),
    )
    const sink = createHttpVitalsSink({
      url: 'https://collector.test/v1',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    })

    await expect(sink.deliver(batch)).rejects.toThrow(/429.*quota exceeded/s)
  })

  it('truncates a long error body rather than logging all of it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('x'.repeat(5000), { status: 500 })))
    const sink = createHttpVitalsSink({
      url: 'https://collector.test/v1',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    })

    await expect(sink.deliver(batch)).rejects.toThrow(/…$/)
  })
})

describe('createLoggingVitalsSink', () => {
  it('writes one readable line per batch', () => {
    const lines: string[] = []
    createLoggingVitalsSink((line) => lines.push(line)).deliver(batch)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/pricing')
    expect(lines[0]).toContain('visit=visit-1')
    expect(lines[0]).toContain('LCP=2100(good)')
  })
})

describe('deliverVitals', () => {
  it('reports every sink, and a failing one does not stop the others', async () => {
    const written: string[] = []
    const sinks: VitalsSink[] = [
      { name: 'aggregate', deliver: () => void written.push('aggregate') },
      {
        name: 'forward',
        deliver: () => Promise.reject(new Error('collector unreachable')),
      },
      { name: 'log', deliver: () => void written.push('log') },
    ]

    const results = await deliverVitals(batch, sinks)

    expect(written).toEqual(['aggregate', 'log'])
    expect(results).toEqual([
      { name: 'aggregate', ok: true },
      { name: 'forward', ok: false, error: 'collector unreachable' },
      { name: 'log', ok: true },
    ])
  })

  it('describes a thrown non-Error without throwing itself', async () => {
    const results = await deliverVitals(batch, [
      {
        name: 'forward',
        deliver: () => {
          throw 'nope'
        },
      },
    ])

    expect(results).toEqual([{ name: 'forward', ok: false, error: 'nope' }])
  })
})

describe('createThrottledLogger', () => {
  it('passes the first message and suppresses the rest of the interval', () => {
    const clock = 0
    const lines: string[] = []
    const log = createThrottledLogger(
      (line) => lines.push(line),
      1000,
      () => clock,
    )

    log('sink failed')
    log('sink failed')
    log('sink failed')

    expect(lines).toEqual(['sink failed'])
  })

  it('reports how many it swallowed when the interval passes', () => {
    let clock = 0
    const lines: string[] = []
    const log = createThrottledLogger(
      (line) => lines.push(line),
      1000,
      () => clock,
    )

    log('sink failed')
    log('sink failed')
    log('sink failed')

    clock = 1000
    log('sink failed')

    expect(lines[1]).toBe('sink failed (2 similar suppressed)')

    // The counter resets, so the next window does not inherit the last one's.
    clock = 2000
    log('sink failed')
    expect(lines[2]).toBe('sink failed')
  })
})
