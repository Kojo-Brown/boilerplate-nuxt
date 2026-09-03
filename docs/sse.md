# Server-Sent Events: heartbeat and disconnect cleanup

SSE is a one-way stream of text events from server to browser, and its selling
point is the client: `EventSource` is built in, parses the framing, reconnects on
its own, and replays its position through a `Last-Event-ID` header. Nothing in
`utils/ndjson.ts` or `composables/useNdjsonStream.ts` is needed, and neither is
any reconnect logic.

The transport underneath is the one `docs/nitro-streaming.md` already describes —
a pull-driven `ReadableStream` handed to `sendStream`, cancelled by
`requestAbortSignal`. What `server/utils/sse.ts` adds is the framing, the
keepalive that stops the connection being culled while it is idle, and the
cleanup that runs when it is culled anyway.

| File                                 | What it is                                                   |
| ------------------------------------ | ------------------------------------------------------------ |
| `types/sse.ts`                       | The wire protocol and the two application-level event names. |
| `server/utils/sse.ts`                | `sendSse`, `withHeartbeat`, `encodeSseBlock`, `resumeFrom`.  |
| `server/api/streaming/events.get.ts` | The demo ticker, with flags for every failure mode below.    |

## Writing an SSE route

```ts
// server/api/streaming/events.get.ts
export default defineEventHandler((event) => {
  const signal = requestAbortSignal(event)
  return sendSse(event, ticks(resumeFrom(event), signal), { signal })
})

async function* ticks(resumeAfter: string | null, signal: AbortSignal) {
  const cursor = await open(resumeAfter)
  try {
    for await (const row of cursor) {
      if (signal.aborted) return
      yield { event: 'tick', id: String(row.seq), data: row }
    }
  } finally {
    await cursor.close() // Runs on disconnect too.
  }
}
```

The signal goes to both halves for the reason `docs/nitro-streaming.md` gives:
`sendSse` ends the stream when it fires, and the source uses it to stop
producing. There is a second reason here. An async generator queues `return()`
behind a pending `next()`, so a source sleeping on a bare `setTimeout` cannot be
cancelled at all — the cleanup does not run until the sleep it is trying to
interrupt has already elapsed. Use `abortableDelay(ms, signal)`.

On the client:

```ts
const source = new EventSource('/api/streaming/events?count=20')
source.addEventListener('tick', (ev) => console.log(JSON.parse(ev.data)))
source.addEventListener('done', () => source.close())
```

## The four things that go wrong

### 1. An idle connection is indistinguishable from a dead one

Every layer between the handler and the browser is counting the seconds since the
last byte: an AWS ALB with a 60-second idle timeout, nginx's `proxy_read_timeout`
(60s), Cloudflare (100s), a corporate proxy, a phone's NAT table. When one of
them reaches its number it closes the socket, and neither end is told anything.
The server's `res` emits `close`; `EventSource` fires `error` and reconnects.

The symptom is a stream that works locally and silently restarts every minute in
production, once per hop, on whichever layer has the smallest timeout. Nothing
logs an error, because from each layer's point of view nothing went wrong.

`withHeartbeat` writes an SSE comment when the source has been quiet for
`intervalMs`:

```text
: ping

```

A comment rather than an event because the specification tells the parser to
discard those lines outright. The keepalive never reaches `onmessage`, never
advances `lastEventId`, and cannot be mistaken for data. The default interval is
15 seconds — under the smallest timeout above, with enough margin that one
dropped packet does not reach it.

The interval is a **maximum idle gap, not a period**: a delivered message resets
it. A heartbeat sent 10ms after a real message proves nothing the message did not
already prove.

### 2. The heartbeat has to fire while the source is being awaited

This is the part that is actually hard, and it is why `withHeartbeat` is a
hand-written loop rather than four lines.

An async generator suspended in `await iterator.next()` cannot yield, so emitting
a beat during an idle stretch means racing the pending `next()` against a timer.
The trap is that the obvious race asks the source _again_ on each tick:

```ts
// Wrong. Every beat consumes a value.
const next = await Promise.race([iterator.next(), delay(intervalMs)])
```

An async generator queues concurrent `next()` calls. The second one is handed the
value the first was about to produce, and that result is discarded — so a
cursor-backed source advances once per beat rather than once per delivered row.
Counting output cannot see this: the beats look identical either way, and the
data loss only shows up as rows that never arrive.

`withHeartbeat` holds the one pending `next()` across every beat until it
settles. `tests/unit/server/sse.test.ts` pins it by counting entries into the
source rather than chunks out of it — against the naive race that assertion reads
`expected 6 to be 1`.

### 3. Three things have to unwind on disconnect

Each has its own hook, and the chain only works if all three are connected:

1. **The response stream ends.** `streamFromIterable` aborts on the signal.
2. **The heartbeat timer is cleared.** One timer is created per message, so
   `withHeartbeat` uses a _cancellable_ delay rather than `abortableDelay` from
   `server/utils/stream.ts`. A timer that can only end by elapsing leaves an
   `abort` listener attached to the signal for every message a busy stream
   delivers — a leak, and a `MaxListenersExceededWarning`, which under CI's
   `NODE_OPTIONS=--throw-deprecation` is not a warning.
3. **The source's `finally` runs.** The generator's `return()`, propagated from
   `streamFromIterable` through `withHeartbeat` to the caller's generator. This
   is where a cursor is closed or a subscription dropped.

Without (3) a disconnected client still costs a database cursor for as long as
the stream would have run.

### 4. Closing the body does not end the stream

`EventSource` treats a closed body as a connection to re-open after `retry`
milliseconds. A server that just ends the response has started a reconnect loop,
not finished a stream — and the only way out is for the client to call `close()`.

So `sendSse` writes a terminator the client can act on:

```text
retry: 3000

event: tick
id: 1
data: {"seq":1}

: ping

event: done
data: {"count":1,"elapsedMs":512}

```

`done` says the stream finished on purpose; `stream-error` says the source failed
after the response had started. Both are application-level events, because SSE
has no way to say either. A client that listens for neither reconnects forever.

The `stream-error` message is a constant rather than the thrown error's, for the
reason `docs/nitro-streaming.md` gives about `streamErrorFrame`: after the first
byte there is no layer deciding what a caller may see, and copying
`error.message` into the body would route around the one that exists.

## Resumption

`id` is what makes a stream resumable, and emitting one per message is the entire
cost. The browser stores the last `id` it dispatched and sends it back as
`Last-Event-ID` on every automatic reconnect; `resumeFrom(event)` reads it.

A handler that ignores it is not broken so much as silently lossy — the reconnect
succeeds, the client sees a stream, and everything produced during the gap is
never delivered.

Two rules the helpers enforce:

- **A resume token is untrusted input.** It is echoed back into an `id:` line by
  any handler that resumes from it, so `parseResumeToken` bounds its length and
  rejects `\r`, `\n` and NUL. A newline in an `id` lets the value write its own
  fields into the stream, including a `data:` line — header injection with a
  different delimiter.
- **An unrecognised token resumes from the beginning.** It may have come from a
  previous deployment of the endpoint, or a different one behind the same path.
  Losing the client's position is recoverable; inventing one is not.

Try it against the demo route, which ends the body with no terminator at
`?dropAt=`:

```bash
curl -N 'http://localhost:3000/api/streaming/events?count=6&dropAt=3&delay=200'
# … id: 1, id: 2, then the body ends.

curl -N -H 'Last-Event-ID: 2' 'http://localhost:3000/api/streaming/events?count=6'
# … resumes at id: 3, with "resumed": true.
```

`EventSource` does the second request by itself. `curl` needs the header spelled
out, and so does any client that wants to resume from a stored position rather
than from where this browser tab left off — which is what the `?lastEventId=`
query fallback is for, since `EventSource` has no API for request headers at all.

## Auth, and when not to use SSE

`/api/streaming/events` inherits the `/api/**` default in
`server/utils/access-policy.ts`, so it requires a session. That works with
`EventSource` only because the connection is same-origin and carries cookies by
default. Cross-origin it needs `withCredentials: true` **and** CORS on the route,
and there is no way to attach a bearer token, because `EventSource` cannot set
headers.

SSE is the right tool for server-to-client text events over an ordinary `GET`.
Reach for the WebSocket item instead when you need any of: a request body,
messages from the client, binary frames, or per-message headers. One more limit
worth knowing before it is discovered in production — over HTTP/1.1 a browser
allows about six connections per origin, and an open `EventSource` holds one of
them for the life of the page. HTTP/2 raises the limit to the stream concurrency
of the connection, which is why an SSE-heavy app wants it.
