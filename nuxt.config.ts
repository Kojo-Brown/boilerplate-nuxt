import tailwindcss from '@tailwindcss/vite'
import { routeRules } from './route-rules.config'

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

  modules: ['@nuxt/eslint', 'nuxt-auth-utils', '@pinia/nuxt', '@nuxtjs/color-mode', '@nuxtjs/i18n'],

  // Tailwind 4 ships its own Vite plugin. @nuxtjs/tailwindcss is a Tailwind 3
  // module — it registers `tailwindcss` as a PostCSS plugin, which Tailwind 4
  // rejects outright, so the plugin is wired directly instead.
  css: ['~/assets/css/tailwind.css'],

  vite: {
    plugins: [tailwindcss()],
  },

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
    session: {
      // Placeholder only — nuxt-auth-utils requires the key to be present in the
      // schema. The real value comes from NUXT_SESSION_PASSWORD at runtime and
      // the server refuses to start without it.
      password: '',
      maxAge: 60 * 60 * 24 * 7,
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
  },
})
