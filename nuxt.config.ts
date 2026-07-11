// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-08',

  modules: [
    'nuxt-auth-utils',
    '@pinia/nuxt',
    '@nuxtjs/tailwindcss',
    '@nuxtjs/color-mode',
  ],

  pinia: {
    storesDirs: ['./stores/**'],
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  colorMode: {
    classSuffix: '',
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
