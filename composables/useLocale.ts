export function useLocale() {
  const { locale, locales, setLocale, t } = useI18n()

  const currentLocale = computed(() =>
    locales.value.find((l) => typeof l === 'object' && 'code' in l && l.code === locale.value),
  )

  async function switchLocale(code: string) {
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
