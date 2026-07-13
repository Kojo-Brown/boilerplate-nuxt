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
   * routeRules approach (required for swr / cache headers):
   *   /rendering/ssr  — default SSR (no rule needed)
   *   /rendering/isr  — stale-while-revalidate, 60 s TTL
   */
  routeRules: {
    '/rendering/isr': { swr: 60 },
  },

  modules: [
    'nuxt-auth-utils',
    '@pinia/nuxt',
    '@nuxtjs/tailwindcss',
    '@nuxtjs/color-mode',
    '@nuxtjs/i18n',
  ],

  i18n: {
    locales: [
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
    ],
    defaultLocale: 'en',
    lazy: true,
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
    databaseUrl: process.env['DATABASE_URL'] ?? '',
    awsRegion: process.env['AWS_REGION'] ?? 'us-east-1',
    awsAccessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
    awsSecretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    s3Bucket: process.env['S3_BUCKET'] ?? '',
    session: {
      maxAge: 60 * 60 * 24 * 7,
    },
  },
})
