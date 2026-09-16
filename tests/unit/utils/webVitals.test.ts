import { describe, it, expect, vi } from 'vitest'
import {
  CLSThresholds,
  FCPThresholds,
  INPThresholds,
  LCPThresholds,
  TTFBThresholds,
} from 'web-vitals'

import { rateVital, VITAL_THRESHOLDS, type VitalSample, type VitalsBatch } from '~/types/vitals'
import {
  createBeaconTransport,
  createVitalsReporter,
  newVisitId,
  normaliseVitalValue,
  resolveVitalsClientOptions,
  routeFromUrl,
  shouldReportVisit,
  toVitalSample,
} from '~/utils/webVitals'

function sample(overrides: Partial<VitalSample> = {}): VitalSample {
  return {
    name: 'LCP',
    value: 1200,
    rating: 'good',
    id: 'v1-1',
    navigationType: 'navigate',
    route: '/',
    ...overrides,
  }
}

describe('VITAL_THRESHOLDS', () => {
  // The reason this file imports the library at all. `types/vitals.ts` keeps its
  // own copy of the thresholds so server code does not have to import a browser
  // package for two numbers; this is the gate that stops the copy drifting when
  // Google revises a band and `web-vitals` ships it.
  it('matches the thresholds web-vitals itself publishes', () => {
    expect(VITAL_THRESHOLDS.CLS).toEqual(CLSThresholds)
    expect(VITAL_THRESHOLDS.FCP).toEqual(FCPThresholds)
    expect(VITAL_THRESHOLDS.INP).toEqual(INPThresholds)
    expect(VITAL_THRESHOLDS.LCP).toEqual(LCPThresholds)
    expect(VITAL_THRESHOLDS.TTFB).toEqual(TTFBThresholds)
  })
})

describe('rateVital', () => {
  it('rates the boundaries as good and needs-improvement, not the next band up', () => {
    expect(rateVital('LCP', 2500)).toBe('good')
    expect(rateVital('LCP', 2500.01)).toBe('needs-improvement')
    expect(rateVital('LCP', 4000)).toBe('needs-improvement')
    expect(rateVital('LCP', 4000.01)).toBe('poor')
  })

  it('rates every metric on its own scale', () => {
    expect(rateVital('CLS', 0.09)).toBe('good')
    expect(rateVital('CLS', 0.3)).toBe('poor')
    expect(rateVital('INP', 200)).toBe('good')
    expect(rateVital('INP', 501)).toBe('poor')
    expect(rateVital('TTFB', 800)).toBe('good')
    expect(rateVital('FCP', 2000)).toBe('needs-improvement')
  })
})

describe('normaliseVitalValue', () => {
  it('keeps four decimals for CLS and whole milliseconds for the rest', () => {
    expect(normaliseVitalValue('CLS', 0.123456)).toBe(0.1235)
    expect(normaliseVitalValue('LCP', 2499.6)).toBe(2500)
    expect(normaliseVitalValue('TTFB', 12.4)).toBe(12)
  })

  it('clamps a negative or non-finite value to zero rather than dropping it', () => {
    expect(normaliseVitalValue('TTFB', -3)).toBe(0)
    expect(normaliseVitalValue('LCP', Number.NaN)).toBe(0)
    expect(normaliseVitalValue('LCP', Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('routeFromUrl', () => {
  it('keeps the pathname and drops the origin, query and hash', () => {
    expect(routeFromUrl('https://app.test/pricing?plan=pro#faq')).toBe('/pricing')
    expect(routeFromUrl('/search?q=someone@example.test')).toBe('/search')
  })

  it('falls back to "/" for an empty or unparseable value', () => {
    expect(routeFromUrl('')).toBe('/')
    expect(routeFromUrl('http://')).toBe('/')
  })
})

describe('toVitalSample', () => {
  it('attributes the metric to its own navigationURL when it carries one', () => {
    const result = toVitalSample(
      {
        name: 'CLS',
        value: 0.05,
        id: 'v1-2',
        navigationType: 'soft-navigation',
        navigationURL: 'https://app.test/a?b=1',
      },
      'https://app.test/elsewhere',
    )

    expect(result.route).toBe('/a')
    expect(result.navigationType).toBe('soft-navigation')
  })

  it('falls back to the URL the callback was fired on', () => {
    const result = toVitalSample(
      { name: 'LCP', value: 900, id: 'v1-3', navigationType: 'navigate' },
      'https://app.test/dashboard',
    )

    expect(result.route).toBe('/dashboard')
  })

  it('rates the rounded value, so the rating and the value it ships with agree', () => {
    // 2500.4 is "needs-improvement" unrounded and "good" once rounded to 2500.
    // The sent rating has to describe the sent value or the server's own rating
    // of the number disagrees with the field next to it.
    const result = toVitalSample(
      { name: 'LCP', value: 2500.4, id: 'v1-4', navigationType: 'navigate' },
      'https://app.test/',
    )

    expect(result.value).toBe(2500)
    expect(result.rating).toBe('good')
  })

  it('degrades an unrecognised navigation type instead of losing the sample', () => {
    const result = toVitalSample(
      { name: 'INP', value: 120, id: 'v1-5', navigationType: 'teleport' },
      'https://app.test/',
    )

    expect(result.navigationType).toBe('navigate')
    expect(result.value).toBe(120)
  })
})

describe('createVitalsReporter', () => {
  const page = { visitId: 'visit-1' }

  it('keeps the latest report of a metric instance and the first-seen order', () => {
    const sent: VitalsBatch[] = []
    const reporter = createVitalsReporter({
      page,
      transport: (batch) => (sent.push(batch), true),
      now: () => new Date('2026-02-01T10:00:00.000Z'),
    })

    reporter.record(sample({ name: 'CLS', id: 'cls-1', value: 0.02 }))
    reporter.record(sample({ name: 'LCP', id: 'lcp-1', value: 1800 }))
    // CLS accumulates: the same instance reported again, with a larger value.
    reporter.record(sample({ name: 'CLS', id: 'cls-1', value: 0.14 }))

    expect(reporter.pending()).toBe(2)
    expect(reporter.flush()).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sentAt).toBe('2026-02-01T10:00:00.000Z')
    expect(sent[0]?.page).toEqual(page)
    expect(sent[0]?.samples.map((s) => [s.name, s.value])).toEqual([
      ['CLS', 0.14],
      ['LCP', 1800],
    ])
  })

  it('sends nothing, and reports nothing sent, when the buffer is empty', () => {
    const transport = vi.fn(() => true)
    const reporter = createVitalsReporter({ page, transport })

    expect(reporter.flush()).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps the samples when the transport refuses them', () => {
    const transport = vi.fn(() => false)
    const reporter = createVitalsReporter({ page, transport })

    reporter.record(sample({ id: 'lcp-1' }))

    expect(reporter.flush()).toBe(false)
    expect(reporter.pending()).toBe(1)

    // …and the next attempt carries them.
    transport.mockReturnValue(true)
    expect(reporter.flush()).toBe(true)
    expect(reporter.pending()).toBe(0)
  })

  it('flushes early rather than growing past the batch cap', () => {
    const sent: VitalsBatch[] = []
    const reporter = createVitalsReporter({
      page,
      maxSamples: 2,
      transport: (batch) => (sent.push(batch), true),
    })

    reporter.record(sample({ id: 'a' }))
    reporter.record(sample({ id: 'b' }))

    expect(sent).toHaveLength(1)
    expect(sent[0]?.samples).toHaveLength(2)
    expect(reporter.pending()).toBe(0)
  })
})

describe('createBeaconTransport', () => {
  it('sends a JSON blob through sendBeacon and reports what it returned', async () => {
    const calls: Array<{ url: string; body: BodyInit }> = []
    const transport = createBeaconTransport({
      endpoint: '/api/vitals',
      sendBeacon: (url, body) => (calls.push({ url, body }), true),
    })

    const batch: VitalsBatch = {
      sentAt: '2026-02-01T10:00:00.000Z',
      page: { visitId: 'visit-1' },
      samples: [sample()],
    }

    expect(transport(batch)).toBe(true)
    expect(calls[0]?.url).toBe('/api/vitals')

    const blob = calls[0]?.body as Blob
    // `application/json` and not the `text/plain` a string body would produce:
    // `readValidatedBody` on the ingest route refuses to parse the latter.
    expect(blob.type).toBe('application/json')
    expect(JSON.parse(await blob.text())).toEqual(batch)
  })

  it('passes a refusal from a full beacon queue through to the caller', () => {
    const transport = createBeaconTransport({ endpoint: '/api/vitals', sendBeacon: () => false })

    expect(transport({ sentAt: '', page: { visitId: 'v' }, samples: [sample()] })).toBe(false)
  })

  it('falls back to a keepalive fetch where sendBeacon is missing', () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 202 })),
    )
    const transport = createBeaconTransport({
      endpoint: '/api/vitals',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    })

    expect(transport({ sentAt: '', page: { visitId: 'v' }, samples: [sample()] })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()

    const init = fetchImpl.mock.calls[0]?.[1]
    // Keepalive is the whole point of the fallback: without it the request is
    // cancelled with the document it was sent from.
    expect(init?.keepalive).toBe(true)
    expect(init?.method).toBe('POST')
  })

  it('swallows a rejected fallback request — the page is already unloading', async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new Error('network down')),
    )
    const transport = createBeaconTransport({
      endpoint: '/api/vitals',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    })

    expect(transport({ sentAt: '', page: { visitId: 'v' }, samples: [sample()] })).toBe(true)
    // An unhandled rejection here would fail the suite; awaiting a tick is what
    // proves the `.catch` is attached rather than assumed.
    await Promise.resolve()
  })

  it('reports no send when the browser offers neither transport', () => {
    const transport = createBeaconTransport({ endpoint: '/api/vitals' })

    expect(transport({ sentAt: '', page: { visitId: 'v' }, samples: [sample()] })).toBe(false)
  })
})

describe('shouldReportVisit', () => {
  it('retains everything at 1 and nothing at 0, without consulting the source', () => {
    const random = vi.fn(() => 0)

    expect(shouldReportVisit(1, random)).toBe(true)
    expect(shouldReportVisit(0, random)).toBe(false)
    expect(random).not.toHaveBeenCalled()
  })

  it('retains the fraction below the rate', () => {
    expect(shouldReportVisit(0.1, () => 0.09)).toBe(true)
    expect(shouldReportVisit(0.1, () => 0.1)).toBe(false)
    expect(shouldReportVisit(0.1, () => 0.9)).toBe(false)
  })
})

describe('resolveVitalsClientOptions', () => {
  const defaults = { enabled: true, endpoint: '/api/vitals', sampleRate: 1 }

  it('coerces the strings an environment override arrives as', () => {
    expect(resolveVitalsClientOptions({ enabled: 'false', sampleRate: '0.25' }, defaults)).toEqual({
      enabled: false,
      endpoint: '/api/vitals',
      sampleRate: 0.25,
    })
  })

  it('clamps a sample rate outside 0…1', () => {
    expect(resolveVitalsClientOptions({ sampleRate: 4 }, defaults).sampleRate).toBe(1)
    expect(resolveVitalsClientOptions({ sampleRate: -1 }, defaults).sampleRate).toBe(0)
  })

  it('falls back to the default rate — not to zero — when the value is unusable', () => {
    // A typo'd override should show up as too much data, not as a dashboard
    // that is silently empty.
    expect(resolveVitalsClientOptions({ sampleRate: 'half' }, defaults).sampleRate).toBe(1)
    expect(resolveVitalsClientOptions(undefined, defaults)).toEqual(defaults)
  })

  it('treats any non-"false" string as enabled, and an empty endpoint as unset', () => {
    expect(resolveVitalsClientOptions({ enabled: 'true' }, defaults).enabled).toBe(true)
    expect(resolveVitalsClientOptions({ endpoint: '   ' }, defaults).endpoint).toBe('/api/vitals')
    expect(resolveVitalsClientOptions({ endpoint: '/collect' }, defaults).endpoint).toBe('/collect')
  })
})

describe('newVisitId', () => {
  it('uses randomUUID where the browser exposes it', () => {
    expect(newVisitId({ randomUUID: () => '11111111-2222-3333-4444-555555555555' })).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })

  it('falls back on an insecure context, where randomUUID is unavailable', () => {
    const id = newVisitId(null)

    expect(id).toMatch(/^v-[a-z\d]+$/)
    expect(newVisitId(null)).not.toBe(id)
  })
})
