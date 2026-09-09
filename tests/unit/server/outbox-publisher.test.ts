import { describe, expect, it, vi } from 'vitest'

import type { OutboxRecord } from '~/server/utils/outbox'
import {
  OUTBOX_EVENT_HEADER,
  OUTBOX_IDEMPOTENCY_HEADER,
  createHttpOutboxPublisher,
  createLoggingOutboxPublisher,
  toOutboxEnvelope,
} from '~/server/utils/outbox-publisher'

const RECORD: OutboxRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  aggregateType: 'todo',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  eventType: 'todo.created',
  payload: { id: '22222222-2222-4222-8222-222222222222', title: 'Write the relay' },
  attempts: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

/** A `fetch` that answers however the test says, and records the call. */
function stubFetch(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const impl: typeof globalThis.fetch = (input, init) => {
    const request = new Request(typeof input === 'string' ? input : String(input), init)
    calls.push(request)
    return Promise.resolve(respond(request))
  }
  return { impl, calls }
}

describe('toOutboxEnvelope', () => {
  it('is the wire form of a record', () => {
    expect(toOutboxEnvelope(RECORD)).toEqual({
      id: RECORD.id,
      type: 'todo.created',
      aggregate: { type: 'todo', id: RECORD.aggregateId },
      occurredAt: '2026-01-01T00:00:00.000Z',
      attempt: 2,
      payload: RECORD.payload,
    })
  })

  it('dates the event by the commit, not by the delivery', () => {
    // A consumer ordering by `occurredAt` must see when the transaction
    // committed; a retry an hour later is still the same event.
    const retried = toOutboxEnvelope({ ...RECORD, attempts: 9 })
    expect(retried.occurredAt).toBe('2026-01-01T00:00:00.000Z')
    expect(retried.attempt).toBe(9)
  })
})

describe('createHttpOutboxPublisher', () => {
  it('POSTs the envelope as JSON', async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 204 }))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: fetchStub.impl,
    })

    await publish(RECORD)

    const request = fetchStub.calls[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('https://example.test/hooks')
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(await request?.json()).toEqual(toOutboxEnvelope(RECORD))
  })

  it('sends the row id as an Idempotency-Key', async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 200 }))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: fetchStub.impl,
    })

    await publish(RECORD)

    // Delivery is at-least-once; this header is the half of exactly-once the
    // producer can supply. It is stable across retries because it is the row id.
    expect(fetchStub.calls[0]?.headers.get(OUTBOX_IDEMPOTENCY_HEADER)).toBe(RECORD.id)
    expect(fetchStub.calls[0]?.headers.get(OUTBOX_EVENT_HEADER)).toBe('todo.created')
  })

  it('resolves on any 2xx', async () => {
    for (const status of [200, 201, 202, 204]) {
      const fetchStub = stubFetch(() => new Response(null, { status }))
      const publish = createHttpOutboxPublisher({
        url: 'https://example.test/hooks',
        timeoutMs: 5_000,
        fetchImpl: fetchStub.impl,
      })
      await expect(publish(RECORD)).resolves.toBeUndefined()
    }
  })

  it('throws on a 5xx, with the consumer’s reason', async () => {
    const fetchStub = stubFetch(
      () => new Response('upstream timed out', { status: 503, statusText: 'Service Unavailable' }),
    )
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: fetchStub.impl,
    })

    await expect(publish(RECORD)).rejects.toThrow('Webhook responded 503')
    await expect(publish(RECORD)).rejects.toThrow('upstream timed out')
  })

  it('throws on a 4xx too, rather than dropping the event', async () => {
    // A 4xx usually will not succeed on a retry, but dropping an event because a
    // consumer answered 400 loses data on a consumer bug. The attempt cap ends
    // it, and `failed_at` is where an operator finds it.
    const fetchStub = stubFetch(() => new Response('bad request', { status: 400 }))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: fetchStub.impl,
    })

    await expect(publish(RECORD)).rejects.toThrow('Webhook responded 400')
  })

  it('truncates a consumer that answers with a wall of text', async () => {
    const fetchStub = stubFetch(() => new Response('x'.repeat(10_000), { status: 500 }))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: fetchStub.impl,
    })

    await expect(publish(RECORD)).rejects.toThrow(/…$/)
  })

  it('still reports the status when the body cannot be read', async () => {
    const unreadable = new Response('ignored', { status: 502 })
    vi.spyOn(unreadable, 'text').mockRejectedValue(new Error('stream closed'))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: stubFetch(() => unreadable).impl,
    })

    await expect(publish(RECORD)).rejects.toThrow('Webhook responded 502')
  })

  it('lets a transport failure through unchanged', async () => {
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })

    // The relay is what decides a failure means "retry"; a publisher that
    // swallowed a connection refusal would report a delivery that never happened.
    await expect(publish(RECORD)).rejects.toThrow('fetch failed')
  })

  it('bounds every delivery with a timeout signal', async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 204 }))
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 1_000,
      fetchImpl: fetchStub.impl,
    })

    await publish(RECORD)

    // Without it a consumer that accepts a connection and never answers would
    // hold the row's claim until the lease expired, once per attempt.
    expect(fetchStub.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('drains a successful response so its socket returns to the pool', async () => {
    const response = new Response('{"ok":true}', { status: 200 })
    const publish = createHttpOutboxPublisher({
      url: 'https://example.test/hooks',
      timeoutMs: 5_000,
      fetchImpl: stubFetch(() => response).impl,
    })

    await publish(RECORD)

    expect(response.bodyUsed).toBe(true)
  })
})

describe('createLoggingOutboxPublisher', () => {
  it('names the event, the aggregate and the row', async () => {
    const lines: string[] = []
    await createLoggingOutboxPublisher((message) => lines.push(message))(RECORD)

    expect(lines).toEqual([`[outbox] todo.created todo/${RECORD.aggregateId} (${RECORD.id})`])
  })
})
