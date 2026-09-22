import tailwindcss from '@tailwindcss/vite'
import { imageConfig } from './image.config'
import { routeRules } from './route-rules.config'
import { VITALS_ENDPOINT } from './types/vitals'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-08',

  /**
   * Per-route rendering mode examples (see pages/rendering/).
   *
   * definePageMeta approach (co-located, preferred for prerender / ssr:false):
   *   pages/rendering/ssg.vue → definePageMeta({ prerender: true })
   *   pages/rendering/spa.vue → definePageMeta({ ssr: false })
   *
   * routeRules approach (required for swr / isr / prerender / cors) lives in
   * `route-rules.config.ts` so it can be unit-tested. See that file and
   * `docs/nitro-route-rules.md` for the full ISR / SWR / prerender / CORS matrix.
   */
  routeRules,

  experimental: {
    // Server islands (`components/islands/`, rendered with `<NuxtIsland>`).
    //
    // `true`, not `{ selectiveClient: true }`: selective client components let
    // an island mark a child as `nuxt-client` and ship it after all, which is a
    // useful escape hatch and the wrong default here — it makes "this component
    // is in no client chunk" a per-child question rather than a property of the
    // directory. An island that needs interactivity is a component that should
    // not have been an island.
    //
    // "experimental" is the flag, not the maturity: the island endpoint and the
    // `<NuxtIsland>` API are what Nuxt's own docs tell you to build on, and
    // `getIslandHash`/`serializeIslandProps` are exported from `nuxt/app` as
    // public API. What the flag buys is that none of it is compiled in for
    // projects that do not use it. See docs/server-islands.md.
    componentIslands: true,
  },

  nitro: {
    experimental: {
      // Required for `defineWebSocketHandler` (server/api/ws/echo.ts). Without
      // it Nitro does not bundle the crossws adapter and never attaches an
      // `upgrade` listener, so the route answers a WebSocket handshake with the
      // 426 its HTTP half throws — a failure that looks like a client bug.
      //
      // "experimental" is Nitro's flag for the API surface, not for the
      // transport: it is stable enough to build on, and the flag is what the
      // Nuxt and Nitro docs both still require. See docs/websockets.md for
      // which deployment presets support it.
      websocket: true,
    },
  },

  // `./modules/bundle-budget` is listed explicitly rather than relying on the
  // `modules/` directory scan, so that reading this array tells you everything
  // that hooks into the build. It only writes the client manifest out for
  // `scripts/assert-bundle-budget.ts`; see the module for why that is needed.
  modules: [
    '@nuxt/eslint',
    'nuxt-auth-utils',
    '@pinia/nuxt',
    '@nuxtjs/color-mode',
    '@nuxtjs/i18n',
    '@nuxt/image',
    './modules/bundle-budget',
  ],

  // Tailwind 4 ships its own Vite plugin. @nuxtjs/tailwindcss is a Tailwind 3
  // module — it registers `tailwindcss` as a PostCSS plugin, which Tailwind 4
  // rejects outright, so the plugin is wired directly instead.
  css: ['~/assets/css/tailwind.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  // Formats, candidate widths and the transformer, kept in their own module so
  // they can be unit-tested; `components/AppImage.vue` is what makes a page use
  // them safely. See image.config.ts and docs/images.md.
  image: imageConfig,

  i18n: {
    locales: [
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
    ],
    defaultLocale: 'en',
    langDir: 'locales/',
    strategy: 'prefix_except_default',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_redirected',
      redirectOn: 'root',
      alwaysRedirect: false,
    },
  },

  pinia: {
    storesDirs: ['./stores/**'],
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  colorMode: {
    classSuffix: '',
    preference: 'system',
    fallback: 'light',
    storageKey: 'nuxt-color-mode',
  },

  runtimeConfig: {
    // Defaults only — never read process.env here; doing so bakes the value
    // into the Nitro bundle at build time. Override at runtime via NUXT_* env
    // vars (e.g. NUXT_DATABASE_URL, NUXT_AWS_SECRET_ACCESS_KEY).
    databaseUrl: '',
    awsRegion: 'us-east-1',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    s3Bucket: '',
    redis: {
      // Unset means "no Redis": Nitro keeps its own per-process driver for the
      // `cache` and `sessions` bases, which is the right setup for `pnpm dev`
      // and a single instance. Set NUXT_REDIS_URL to share both across a
      // deployment. See docs/nitro-storage.md and server/utils/storage.ts.
      url: '',
      keyPrefix: 'nuxt',
      // 0 = no driver-level expiry on cache keys; Nitro's cache entries carry
      // their own `maxAge`. Set NUXT_REDIS_CACHE_TTL for a hard ceiling.
      cacheTtlSeconds: 0,
    },
    idempotency: {
      // How long a completed record stays replayable, in seconds, clamped to
      // 60…604800 by server/utils/idempotency.ts. A day matches the window
      // Stripe gives an Idempotency-Key, and is the TTL the `idempotency`
      // storage base is mounted with. Override with
      // NUXT_IDEMPOTENCY_RETENTION_SECONDS.
      retentionSeconds: 60 * 60 * 24,
      // How long an in-flight claim is honoured before a retry may take it over,
      // clamped to 5…600. This is how long a key stays stuck after a process
      // dies mid-handler, so it wants to be comfortably longer than the slowest
      // wrapped handler and no longer. NUXT_IDEMPOTENCY_CLAIM_TIMEOUT_SECONDS.
      claimTimeoutSeconds: 60,
    },
    outbox: {
      // Where the relay POSTs each event. Unset means "nowhere": `pnpm dev`
      // logs events instead so the path is observable, and a built server
      // refuses to pretend — it warns at boot and does not poll. See
      // server/utils/outbox.ts and docs/outbox.md.
      // NUXT_OUTBOX_WEBHOOK_URL.
      webhookUrl: '',
      relay: {
        // Set false on instances that should write outbox rows but not deliver
        // them — a deployment running the relay in one place rather than in
        // every web process. NUXT_OUTBOX_RELAY_ENABLED.
        enabled: true,
        // Idle poll interval. Only an under-full pass waits: a pass that filled
        // its batch polls again immediately, so a backlog drains at the
        // consumer's speed rather than at batchSize per interval. Clamped to
        // 50…60000. NUXT_OUTBOX_RELAY_POLL_INTERVAL_MS.
        pollIntervalMs: 1000,
        // Rows per claim, clamped to 1…500. A batch is published sequentially
        // and holds its lease for the whole pass.
        // NUXT_OUTBOX_RELAY_BATCH_SIZE.
        batchSize: 20,
        // First retry delay, doubled per attempt and capped, with jitter over
        // the upper half of the window. Clamped to 100…60000 and
        // 1000…3600000 respectively; the cap is also floored at the base delay,
        // since a cap below it would make every retry wait the same amount.
        // NUXT_OUTBOX_RELAY_BASE_BACKOFF_MS, NUXT_OUTBOX_RELAY_MAX_BACKOFF_MS.
        baseBackoffMs: 1000,
        maxBackoffMs: 5 * 60_000,
        // Attempts before a row is dead-lettered (`failed_at` set, kept for an
        // operator). Ten at the default backoff is roughly forty minutes of
        // trying. Clamped to 1…50. NUXT_OUTBOX_RELAY_MAX_ATTEMPTS.
        maxAttempts: 10,
        // How long a claim holds a row. Must exceed publishTimeoutMs or a second
        // relay claims a row the first is still delivering. Clamped to
        // 1000…600000. NUXT_OUTBOX_RELAY_CLAIM_LEASE_MS.
        claimLeaseMs: 30_000,
        // Per-delivery timeout, clamped to 100…60000.
        // NUXT_OUTBOX_RELAY_PUBLISH_TIMEOUT_MS.
        publishTimeoutMs: 5_000,
      },
    },
    vitals: {
      // Where `/api/vitals` forwards each batch of Core Web Vitals — an
      // analytics collector, a log shipper, whatever owns the durable copy.
      // Unset is a supported mode, not a broken one: the in-process aggregate
      // behind `/api/vitals/summary` still collects, and a built server says so
      // once at boot. A URL that is set but unparseable is fatal at startup.
      // NUXT_VITALS_SINK_URL.
      sinkUrl: '',
      // Per-delivery timeout in milliseconds, clamped to 100…30000. A batch is
      // never retried — the next page load brings a fresh one, and a relay in
      // front of a metric would cost more than the metric is worth. See
      // server/utils/vitals-sink.ts. NUXT_VITALS_TIMEOUT_MS.
      timeoutMs: 3000,
    },
    session: {
      // Placeholder only — nuxt-auth-utils requires the key to be present in the
      // schema. The real value comes from NUXT_SESSION_PASSWORD at runtime and
      // the server refuses to start without it.
      password: '',
      maxAge: 60 * 60 * 24 * 7,
    },
    security: {
      csp: {
        // 'enforce' | 'report-only' | 'off'. Report-only is how a policy change
        // is rolled out: the browser reports what *would* have been blocked and
        // blocks nothing, so a directive that is one origin short shows up in
        // the reports instead of in a support ticket.
        // NUXT_SECURITY_CSP_MODE.
        mode: 'enforce',
        // Where violation reports are POSTed. A same-origin path or an absolute
        // http(s) URL; anything else is dropped. Empty means the policy carries
        // no `report-uri`, which is the honest default for a boilerplate that
        // has no collector to point at. NUXT_SECURITY_CSP_REPORT_URI.
        reportUri: '',
        // Extra origins for `connect-src` / `img-src`, comma-separated — the API
        // a deployment talks to, the CDN it loads images from. Same-origin needs
        // no configuration, and quoted keywords are rejected: every keyword this
        // policy uses is decided in server/utils/security-headers.ts, where it
        // gets a code review. NUXT_SECURITY_CSP_CONNECT_SRC,
        // NUXT_SECURITY_CSP_IMG_SRC.
        connectSrc: '',
        imgSrc: '',
        // Who may frame this app. Empty means `'none'`, which is also what
        // `X-Frame-Options: DENY` says to older clients.
        // NUXT_SECURITY_CSP_FRAME_ANCESTORS.
        frameAncestors: '',
      },
      hsts: {
        // One year, the floor the preload list requires, clamped to 0…2 years.
        // Zero is not "off": it is the documented way back off HSTS, since a
        // browser that has already seen the header keeps honouring it until the
        // max-age it was given expires. Sent only on TLS requests.
        // NUXT_SECURITY_HSTS_MAX_AGE_SECONDS.
        maxAgeSeconds: 60 * 60 * 24 * 365,
        // NUXT_SECURITY_HSTS_INCLUDE_SUBDOMAINS.
        includeSubdomains: true,
        // Off by default, because submitting a domain to the preload list is
        // close to irreversible and is not a decision a boilerplate should make
        // for its consumer. Dropped unless includeSubdomains is on and max-age
        // is at least a year, which is what the list requires.
        // NUXT_SECURITY_HSTS_PRELOAD.
        preload: false,
      },
    },

    ws: {
      // Signing key for WebSocket handshake tickets. Empty means "derive one
      // from session.password with HKDF", which is the supported default — the
      // two keys stay cryptographically unrelated either way. Set
      // NUXT_WS_TICKET_SECRET only to rotate ticket signing independently of the
      // session cookie. See server/utils/ws-ticket.ts.
      ticketSecret: '',
      // Ticket lifetime in seconds, clamped to 1…300. Seconds because a ticket
      // is a bearer credential that may travel in a URL.
      ticketTtlSeconds: 30,
      // Extra origins allowed to open a socket, comma-separated. The request's
      // own host is always allowed, so same-origin needs no configuration. Set
      // NUXT_WS_ALLOWED_ORIGINS when a separate front end connects to this API.
      allowedOrigins: '',
    },

    // Everything above is server-only. This block is serialised into the HTML
    // payload and readable by every visitor, which is why the project's rule is
    // that a secret never goes in it (CLAUDE.md, and the note in
    // `server/utils/storage.ts` on what gets baked into a build).
    //
    // These three are not secrets by nature — they describe behaviour the
    // browser performs in the open. Overridden with NUXT_PUBLIC_WEB_VITALS_*.
    public: {
      webVitals: {
        // Off switch. `NUXT_PUBLIC_WEB_VITALS_ENABLED=false` stops the plugin
        // before it registers an observer or sends anything.
        enabled: true,
        // Same-origin by design: a cross-origin beacon with a JSON content type
        // needs a CORS preflight, which an unloading page cannot complete.
        endpoint: VITALS_ENDPOINT,
        // Fraction of page loads that report, clamped to 0…1. One is right for
        // dev and for a site that is not yet busy; lower it when the beacon
        // volume starts mattering — p75 over a sample is still p75.
        // NUXT_PUBLIC_WEB_VITALS_SAMPLE_RATE.
        sampleRate: 1,
      },
    },
  },
})
