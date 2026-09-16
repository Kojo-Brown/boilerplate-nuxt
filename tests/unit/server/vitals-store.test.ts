import { describe, it, expect } from 'vitest'

import { createVitalsAggregate } from '~/server/utils/vitals-aggregate'
import {
  createAggregateVitalsSink,
  useVitalsAggregate,
  vitalsSinksFor,
} from '~/server/utils/vitals-store'
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
    {
      name: 'CLS',
      value: 0.3,
      rating: 'poor',
      id: 'v1-2',
      navigationType: 'navigate',
      route: '/pricing',
    },
  ],
}

describe('createAggregateVitalsSink', () => {
  it('records every sample in the batch', () => {
    const aggregate = createVitalsAggregate()

    createAggregateVitalsSink(aggregate).deliver(batch)

    const snapshot = aggregate.snapshot()
    expect(snapshot.seenSamples).toBe(2)
    expect(snapshot.keys.map((key) => [key.name, key.p75, key.rating])).toEqual([
      ['CLS', 0.3, 'poor'],
      ['LCP', 2100, 'good'],
    ])
  })
})

describe('useVitalsAggregate', () => {
  it('is one instance per process, so the summary route reads what ingest wrote', () => {
    expect(useVitalsAggregate()).toBe(useVitalsAggregate())
  })
})

describe('vitalsSinksFor', () => {
  it('always aggregates, and aggregates first so a slow forward cannot delay it', () => {
    const sinks = vitalsSinksFor({ forwardUrl: null, timeoutMs: 3000, logging: false })

    expect(sinks.map((sink) => sink.name)).toEqual(['aggregate'])
  })

  it('adds the forwarding sink when a URL is configured', () => {
    const sinks = vitalsSinksFor({
      forwardUrl: 'https://collector.test/v1',
      timeoutMs: 3000,
      logging: false,
    })

    expect(sinks.map((sink) => sink.name)).toEqual(['aggregate', 'forward'])
  })

  it('logs instead, in dev, when nothing is configured to forward to', () => {
    const sinks = vitalsSinksFor({ forwardUrl: null, timeoutMs: 3000, logging: true })

    expect(sinks.map((sink) => sink.name)).toEqual(['aggregate', 'log'])
  })
})
