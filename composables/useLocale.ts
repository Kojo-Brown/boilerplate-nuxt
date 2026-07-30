export function useLocale() {
  const { locale, locales, setLocale, t } = useI18n()

  const currentLocale = computed(() =>
    locales.value.find((l) => typeof l === 'object' && 'code' in l && l.code === locale.value),
  )

  // Derived from setLocale rather than hardcoded: @nuxtjs/i18n generates a
  // union of the configured codes ('en' | 'fr'), so this stays in sync when a
  // locale is added to nuxt.config.
  type LocaleCode = Parameters<typeof setLocale>[0]

  async function switchLocale(code: LocaleCode) {
    await setLocale(code)
  }

  return {
    locale,
    locales,
    currentLocale,
    switchLocale,
    t,
  }
}
