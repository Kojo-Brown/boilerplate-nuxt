# Streaming SSR responses and progressive rendering

A normal handler returns a value and Nitro serialises it into one response. That
response is as slow as its slowest part, and nothing reaches the client until all
of it is ready. `sendStream` breaks that: the response starts as soon as the
first byte exists, and the rest is written as it is produced.

The transport is easy. What makes it a feature rather than a demo is the four
things it does not come with — cancellation, in-band failure reporting, the
headers that keep an intermediary from undoing the streaming, and a source that
is actually consumed lazily. Those are what `server/utils/stream.ts` adds.

| File                                | What it is                                                            |
| ----------------------------------- | --------------------------------------------------------------------- |
| `types/streaming.ts`                | The NDJSON frame protocol, shared by both sides. No runtime code.     |
| `server/utils/stream.ts`            | `sendNdjson`, `sendProgressiveHtml`, and the `sendStream` wiring.     |
| `utils/ndjson.ts`                   | Incremental NDJSON parsing. Pure; unit-tested.                        |
| `composables/useNdjsonStream.ts`    | Reads a stream in the browser and exposes records as they arrive.     |
| `server/api/streaming/feed.get.ts`  | The NDJSON demo behind `/streaming`.                                  |
| `server/api/streaming/shell.get.ts` | A progressively rendered HTML document, no JavaScript on either side. |

## Writing a streaming route

```ts
// server/api/streaming/feed.get.ts
export default defineEventHandler((event) => {
  const signal = requestAbortSignal(event)
  return sendNdjson(event, records(signal), { signal })
})

async function* records(signal: AbortSignal): AsyncGenerator<FeedItem> {
  try {
    for (const row of await cursor()) {
      if (signal.aborted) return
      yield row
    }
  } finally {
    // Runs on disconnect too, because the stream calls the generator's return().
    await cursor.close()
  }
}
```

The signal is created once and passed to both halves on purpose: `sendNdjson`
ends the stream when it fires, and the source uses it to stop producing. Passing
it to only one of them means either a stream that closes while the generator
keeps running, or a generator that stops while the response stays open.

On the client:

```ts
const { items, status, error, expected, start, stop } = useNdjsonStream<FeedItem>(
  '/api/streaming/feed?count=8',
)
```

`items` grows as records arrive. `status` moves `idle → streaming → done`, or to
`error` / `aborted`.

## Four things `sendStream` does not do

### 1. It never stops

`sendStream` pipes a source into `event.node.res` and does not watch the
request. When the browser navigates away, the source keeps producing and the
writes land on a closed socket — a generator reading a database cursor holds that
cursor until it finishes a response nobody is receiving.

`requestAbortSignal(event)` is the signal that says the client is gone, and
`streamFromIterable` calls the source's `return()` when it fires, which is what
runs a generator's `finally`.

The signal watches `res`, not `req`. `req` emits `close` as soon as the _request_
has been read, which for a `GET` is immediately — a signal derived from it aborts
every stream before it sends anything. `res` emits `close` once either way, and
`writableEnded` separates "we finished" from "the connection went away".

Measured against the built server: disconnecting `curl` mid-stream logs

```
[stream] /api/streaming/feed ended after 2/20 records (client disconnected)
```

which is the generator's `finally` running, from a `return()` that only happens
because something was watching.

### 2. Errors have nowhere to go

The status line left with the first chunk. A handler that throws on record 900
of 1000 cannot become a 500, because the client was told `200 OK` 899 records
ago. Throwing from the source truncates the body and says nothing.

So failure is reported _in_ the body. Every line of an NDJSON response here is a
frame — `item`, `end`, or `error` — and the last one says how the stream ended:

```json
{"type":"item","index":0,"data":{"id":1}}
{"type":"item","index":1,"data":{"id":2}}
{"type":"error","message":"The stream ended early. Retry the request."}
```

The message is a constant, not the thrown error's. A handler that fails before
the first byte gets Nitro's error handling, which decides what a caller may see;
after the first byte there is no such layer, and copying `error.message` into the
body would route around the one that exists. The real error goes to the log.

The `end` frame is the other half. A body that stops without either terminator
was truncated — a proxy timeout, a killed process — and that is a third outcome,
distinct from both success and failure. Without a terminator it is
indistinguishable from success at the point where the reader sees the body end,
so `useNdjsonStream` reports a missing one as an error.

### 3. Nothing else knows the response is a stream

`applyStreamHeaders` sets three, and each of them is a way the stream quietly
stops being one:

| Header                       | Why                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cache-control: no-store`    | A cached stream replays instantly with none of the timing that was the point.                                         |
| `no-transform` (same header) | Forbids an intermediary re-encoding the body, which is how a compressing proxy ends up buffering it.                  |
| `x-accel-buffering: no`      | nginx buffers proxied responses by default and will hold a whole stream to deliver it at once. This is how to say no. |

`x-accel-buffering` is a no-op behind anything that is not nginx, which is the
right trade for a header that is invisible until it is deployed behind one and
inexplicable once it is.

### 4. An eager source is not a stream

Building the whole payload and wrapping it in a `ReadableStream` streams nothing;
it delays it. `streamFromIterable` is pull-driven: `pull` asks the iterator for
exactly one value each time the consumer's queue has room, so a source that takes
a second per record is entered once per second rather than drained into memory up
front. The same loop written in `start()` — the shape that reads more naturally —
gives you a buffer with a stream's API.

## What is not honoured: backpressure

h3 1.x pipes a web `ReadableStream` into a `WritableStream` whose `write()` calls
`res.write(chunk)` and returns immediately, without waiting for the `drain` that
a `false` return asks for. A source faster than the socket therefore buffers in
the Node response rather than being slowed by it, and the pull-driven design
above does not, on this path, reach all the way to the network.

Stating it rather than implying it, because the alternative is to stop using
`sendStream`: `Readable.fromWeb(stream).pipe(res)` does honour it. It is left as
it is because every other consumer (`fetch`, a test reading the stream, `new
Response(stream)`) applies the pull semantics correctly, so the property holds
everywhere except the last hop — and because a route whose source can outrun a
socket by enough to matter should be paged rather than streamed harder. The
`count` and `delay` clamps in `feed.get.ts` are that limit for the demo, and are
asserted in `tests/unit/server/streaming-feed.test.ts` for the same reason.

## Reading a stream in the browser

`$fetch` and `useAsyncData` read the whole body before resolving. Against a
streaming route they work perfectly and take exactly as long as the slowest
record, which is the cost the stream existed to avoid. The body has to be read
through `response.body.getReader()`, and then two boundary problems are yours:

- **A chunk boundary is not a line boundary.** A record can be split across two
  chunks, at any offset. `createNdjsonParser` keeps one buffer across chunks and
  parses only lines it has seen the end of.
- **A chunk boundary is not a character boundary either.** It can fall inside a
  multi-byte UTF-8 sequence. `TextDecoder` with `{ stream: true }` holds the
  incomplete sequence for the next call instead of decoding it to `U+FFFD`.

A malformed line throws rather than being skipped: it means a truncated stream or
a protocol mismatch, and dropping it turns either into a response that is quietly
missing records.

### Client only

`useNdjsonStream().start()` returns immediately on the server. A stream consumed
during SSR has to be fully read before the HTML can be sent — the render cannot
pause — so it would serialise the whole response into the payload and hydrate a
client with nothing left to watch. `useAsyncData` is the tool for data a page
should be server-rendered _with_; this one is for data that arrives after the
page does.

### One run at a time

`start()` aborts whatever was running and clears the collected records. Every
write below an `await` is guarded on the run still being the current one, because
a superseded run's pending `read()` rejects a tick _after_ the new one has begun
— and without the guard it reports its own abort as the state of the stream that
replaced it.

## Progressive HTML

`/api/streaming/shell` is the same transport carrying a document instead of data:
a plain HTTP response, opened in a tab, with no JavaScript on either side. The
shell is written to the socket immediately and each section follows as its data
resolves. Against the built server:

```
+0 ms     <head>, <h1>, the shell        (1,289 bytes)
+150 ms   <section id="fast">
+1,050 ms <section id="medium">
+2,850 ms <section id="slow">, </html>
```

Three things make that work, and each is a way to get it wrong:

1. **The head is flushed before anything is fetched.** Awaiting the sections and
   then writing the document is a normal response with extra steps.
2. **The head is over ~1 KB.** Browsers do not begin parsing until they have a
   first buffer's worth — historically 1024 bytes — which is why a small shell
   "does not stream" on a fast local connection while identical code streams in
   production behind a bigger document. The inline stylesheet is what carries
   this one past it, deliberately: 1,289 bytes.
3. **Tags are closed by whoever ends the response**, including the error path.
   An HTML parser recovers from a truncated document by rendering it as though
   it were finished, so `htmlErrorChunk` writes a visible message _and_ closes
   the tags the source never got to.

Section order is the order the data resolves in, because a chunk that has been
written cannot be moved. Out-of-order streaming — a placeholder in the shell,
filled by a script in a later chunk — is what React's Suspense boundaries and
Nuxt's `<NuxtIsland>` build on top of this, and is a separate concern.

## Why these routes need a session

Both sit under the default-deny half of `server/utils/access-policy.ts`, with no
carve-out. That is the opposite of the decision made for `/api/cached/**` and
`/api/route-rules/**`, and for the same reason: those responses are _stored_ and
served to every caller, so they must not depend on who asked. A streamed response
is rendered per request and shared with nobody, so there is no such constraint —
and `cache-control: no-store` says as much on the way out.

`useNdjsonStream` uses `fetch`, which sends same-origin cookies by default, so
the session travels with the request from the demo page. A stream started from
server-side code would need `useRequestFetch()` for the same reason described in
[server-middleware.md](./server-middleware.md) — but see _Client only_ above.
