# Core Web Vitals: measuring them, and getting them somewhere

Lighthouse measures one load, on one machine, on a connection you chose. It is a
lab tool and it is genuinely useful for finding regressions before they ship —
but the number Google assesses a site on, and the number that describes what
visitors actually experience, is **field data**: real loads, real devices, real
networks, summarised at the 75th percentile.

This is the field half. The browser measures five metrics, batches them, and
beacons them to `/api/vitals`; the server validates each batch and hands it to
whichever sinks are configured.

```
┌ browser ─────────────────────────────┐   ┌ server ──────────────────────────────┐
│ web-vitals → utils/webVitals.ts      │   │ /api/vitals                          │
│   onLCP/onCLS/onINP/onFCP/onTTFB     │   │   parse (vitals-schemas.ts)          │
│   buffer, dedupe by instance id      │──▶│   ├─▶ aggregate  (always)            │
│   flush on visibilitychange/pagehide │   │   ├─▶ forward    (NUXT_VITALS_SINK_URL)
│   navigator.sendBeacon               │   │   └─▶ log        (dev, no sink URL)  │
└──────────────────────────────────────┘   └──────────────────────────────────────┘
                                                        │
                                             GET /api/vitals/summary → p75 per route
```

| File                               | What it owns                                  |
| ---------------------------------- | --------------------------------------------- |
| `types/vitals.ts`                  | The wire format and the rating thresholds     |
| `utils/webVitals.ts`               | Buffering, batching, the beacon — all pure    |
| `plugins/web-vitals.client.ts`     | Library subscriptions and lifecycle listeners |
| `server/utils/vitals-schemas.ts`   | What the public endpoint will accept          |
| `server/utils/vitals-sink.ts`      | The destinations, and which are active        |
| `server/utils/vitals-aggregate.ts` | The in-process p75 window                     |
| `server/api/vitals/index.post.ts`  | Ingest                                        |
| `server/api/vitals/summary.get.ts` | The summary read-back                         |

## The five metrics

| Metric  | What it measures                                 | Good     | Poor     |
| ------- | ------------------------------------------------ | -------- | -------- |
| **LCP** | When the largest content element painted         | ≤ 2.5 s  | > 4 s    |
| **CLS** | How much the layout moved, unitless              | ≤ 0.1    | > 0.25   |
| **INP** | The worst interaction-to-next-paint of the visit | ≤ 200 ms | > 500 ms |
| FCP     | When anything first painted                      | ≤ 1.8 s  | > 3 s    |
| TTFB    | When the first byte of the document arrived      | ≤ 0.8 s  | > 1.8 s  |

The first three are the Core Web Vitals. FCP and TTFB are diagnostics: an LCP
regression with TTFB moving underneath it is a server or a cache problem, and the
same regression with TTFB flat is a front-end one. Collecting them costs nothing
extra — the same library, the same beacon — and it is the difference between
knowing something got slower and knowing where to look.

FID is not here. It was replaced by INP as a Core Web Vital in March 2024 and
removed from `web-vitals` in v5.

## Why the report is sent when the page is going away

None of these metrics is final while the page is alive:

- **LCP** is whatever painted largest _so far_. A late-loading hero image can
  replace it seconds in. It is finalised by the first interaction, or by the page
  being hidden.
- **CLS** accumulates for the entire life of the page.
- **INP** is the worst interaction so far, and can only get worse.

So the report goes out on `visibilitychange` → hidden, with `pagehide` as the
second trigger. That pair is what replaced `unload`: mobile Safari does not fire
`unload` at all, and merely _listening_ for `unload` or `beforeunload`
disqualifies the page from the back/forward cache — instrumentation that makes
navigation slower to measure how slow navigation is.

At that moment the page may never run JavaScript again, which rules out anything
that depends on a promise resolving. `navigator.sendBeacon` hands the request to
the browser process, which delivers it after the document is gone. What it costs
is that a beacon cannot carry headers and its result is one boolean — "queued" or
"not queued", never a status code. The ingest route is built for exactly that:
public, no custom header, nothing worth reading in the response.

`plugins/web-vitals.client.ts` passes `reportSoftNavs: true`, because a Nuxt app
is a SPA after hydration. Without it, everything after the first client-side
navigation is attributed to the landing route or not measured at all. With it,
each soft navigation starts fresh LCP/CLS/INP instances carrying their own
`navigationURL`, and `toVitalSample` attributes on that rather than on wherever
the router happens to be when the batch is flushed. In a browser with no Soft
Navigations API the flag is inert, not broken.

## What a beacon contains, and what it does not

```json
{
  "sentAt": "2026-02-01T10:00:00.000Z",
  "page": { "visitId": "…", "connection": "4g", "viewport": { "width": 390, "height": 844 } },
  "samples": [
    {
      "name": "LCP",
      "value": 2100,
      "rating": "good",
      "id": "v1-1",
      "navigationType": "navigate",
      "route": "/pricing"
    }
  ]
}
```

No user id, no session id, no user agent, and **no query string** — `route` is a
pathname, stripped in the browser by `routeFromUrl` before anything is sent. The
privacy argument is the smaller one: a query string routinely carries a search
term or an email address from a signup link. The larger argument is that grouping
by full URL gives one bucket per visitor, and a p75 over a bucket of one is that
visitor's number rather than the route's.

`visitId` is random per page load, generated in the browser, never stored and
never reused. It groups one visit's beacons at a sink without a cookie.

## The endpoint is public, and that is a constraint, not an oversight

The loads worth measuring most are first visits by logged-out people, and
`sendBeacon` cannot attach an `Authorization` header even when a session exists.
So `/api/vitals` is a `public` carve-out in `server/utils/access-policy.ts`, and
its body is attacker-controlled by definition. `vitals-schemas.ts` is what makes
that safe:

- closed enums for `name`, `rating` and `navigationType`, so the aggregate's key
  space is finite no matter what is posted;
- bounded strings and arrays, so a batch that parses is small;
- `.strict()` on every object, so a forged batch cannot smuggle extra JSON
  through this app into a third-party sink — without it the route would be an
  open relay with a schema in front of it;
- `route` must be a path, so nothing can put an external URL into a dashboard.

What no schema can check is truthfulness. Nothing can distinguish a real
four-second LCP from a fabricated one — that is true of every client-reported
metric from every analytics vendor. The mitigation is that this data is
aggregated and advisory: nothing is gated on it, and nothing is billed by it.

`GET /api/vitals/summary` is the opposite: it stays behind the `/api/**`
default-deny, because handing an anonymous caller a route inventory with a
traffic-weighted p75 next to each entry would be a poor trade.

## Configuration

| Variable                             | Default | Meaning                                    |
| ------------------------------------ | ------- | ------------------------------------------ |
| `NUXT_VITALS_SINK_URL`               | _unset_ | Collector each batch is POSTed to          |
| `NUXT_VITALS_TIMEOUT_MS`             | `3000`  | Per-delivery timeout, clamped to 100…30000 |
| `NUXT_PUBLIC_WEB_VITALS_ENABLED`     | `true`  | Off switch for the browser half            |
| `NUXT_PUBLIC_WEB_VITALS_SAMPLE_RATE` | `1`     | Fraction of page loads that report, 0…1    |

Sampling is decided **once per page load**, not per metric. A per-metric decision
would ship batches missing an arbitrary subset of the five, which shows up in the
data as routes whose LCP and TTFB counts differ for no reason.

Unconfigured is a supported mode; misconfigured is not. With no
`NUXT_VITALS_SINK_URL` the app still collects into the in-process aggregate and a
built server says so once at boot. With a URL that does not parse, the server
does not start — `server/plugins/vitals.ts` resolves the same plan at startup, so
a typo is found there rather than on every beacon, where the 500 would go to a
caller that ignores it. Same stance as `docs/nitro-storage.md` takes on Redis.

## The in-process aggregate, and what it is not

`GET /api/vitals/summary` answers from a rolling window held in memory:

```json
{
  "generatedAt": "2026-02-01T10:00:00.000Z",
  "keys": [
    {
      "name": "LCP",
      "route": "/pricing",
      "retained": 200,
      "seen": 4213,
      "p75": 2900,
      "rating": "needs-improvement",
      "distribution": { "good": 128, "needs-improvement": 51, "poor": 21 },
      "lastSeenAt": "2026-02-01T09:59:58.000Z"
    }
  ],
  "retainedSamples": 200,
  "seenSamples": 4213,
  "evictedKeys": 0,
  "forwarding": false,
  "instance": { "uptimeSeconds": 1820 }
}
```

It exists so that "no analytics vendor configured" is a working mode rather than
a hole — the same objection `docs/outbox.md` raises against a relay that marks
events delivered without delivering them. It is **not storage**: the last 200
samples per metric and route, per process, discarded on deploy, not shared
between instances. The payload says so in its own fields (`retained` beside
`seen`, `forwarding`, `instance`) rather than in a comment nobody reading JSON
will see.

`p75` is the nearest-rank 75th percentile of the retained window, and `rating` is
the rating _of that number_ — not a majority vote of the per-sample ratings. A
route whose samples are half good and half poor has a poor p75, and averaging the
ratings would hide exactly the population this metric exists to represent.
`distribution` is there so a bimodal route (fast on desktop, slow on mobile)
reads as one rather than as a mediocre average.

Anything that needs history, a window measured in days, or a view across
instances wants `NUXT_VITALS_SINK_URL` and a real backend behind it. The
forwarding sink POSTs the batch verbatim: no user agent, no client IP, no
session. Enriching a third party's payload with request metadata is how an
analytics integration quietly becomes a data-sharing one.

A batch is never retried. A failed delivery is gone, and that is the right trade
here — the next page load brings fresh numbers, and a relay in front of a metric
would cost more than the metric is worth. (The outbox makes the opposite call for
domain events, for the opposite reason: there, a lost event is a lost fact.) A
failing sink is a throttled warning and a `202`, at most one line a minute per
process, because a public endpoint that logged every failure would turn a broken
collector into a broken log pipeline.

## Trying it locally

```sh
pnpm dev
# load a page, then switch tabs — the flush happens on visibilitychange
# the dev logging sink prints:  [vitals] / visit=… LCP=812(good) CLS=0.02(good)

curl -s localhost:3000/api/vitals \
  -H 'content-type: application/json' \
  -d '{"sentAt":"2026-02-01T10:00:00.000Z","page":{"visitId":"v-demo"},
       "samples":[{"name":"LCP","value":2100,"rating":"good","id":"v1-1",
                   "navigationType":"navigate","route":"/pricing"}]}'
# {"accepted":1,"sinks":["aggregate","log"]}
```

The summary needs a session, so read it from a browser that is signed in, or with
the session cookie attached.

## What is deliberately not here

- **No demo page.** A page that renders your own vitals is a debug overlay: it
  measures the browser it runs in and tells you nothing about the field. The
  honest view is the p75 across visitors, which is `/api/vitals/summary`.
- **No attribution data.** `web-vitals/attribution` reports _which_ element was
  the LCP and which interaction was the worst INP. It is the obvious next step,
  it roughly doubles the payload, and it puts DOM selectors from the page into
  the beacon — a scoping and a privacy decision that belongs in its own change.
- **No lab gate in CI.** Catching a regression before it ships is the next
  `SPEC.md` item (bundle budgets and per-route payload reports), and a
  Lighthouse-in-CI step belongs with it.
- **No E2E coverage.** Playwright is still not wired into CI in this repo, so a
  spec driving a real page-hide flush would not be run by anything. Everything
  above the browser API surface is unit-tested instead.
