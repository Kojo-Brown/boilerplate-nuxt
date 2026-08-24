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
    session: {
      // Placeholder only — nuxt-auth-utils requires the key to be present in the
      // schema. The real value comes from NUXT_SESSION_PASSWORD at runtime and
      // the server refuses to start without it.
      password: '',
      maxAge: 60 * 60 * 24 * 7,
    },
  },
})
