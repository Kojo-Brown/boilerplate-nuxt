import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'

// Nuxt auto-imports + @nuxtjs/i18n composables are unavailable in the node test environment.
// Stub them globally before importing the composable.

const mockLocale = ref('en')
const mockSetLocale = vi.fn(async (code: string) => {
  mockLocale.value = code
})

const mockLocales = ref([
  { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
  { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
])

const mockT = vi.fn((key: string, params?: Record<string, unknown>) => {
  const paramStr = params ? ` ${JSON.stringify(params)}` : ''
  return `${key}${paramStr}`
})

vi.stubGlobal('useI18n', () => ({
  locale: mockLocale,
  locales: mockLocales,
  setLocale: mockSetLocale,
  t: mockT,
}))

vi.stubGlobal('computed', computed)

import { useLocale } from '../../../composables/useLocale'

describe('useLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocale.value = 'en'
    mockSetLocale.mockImplementation(async (code: string) => {
      mockLocale.value = code
    })
  })

  it('exposes current locale', () => {
    const { locale } = useLocale()
    expect(locale.value).toBe('en')
  })

  it('exposes all available locales', () => {
    const { locales } = useLocale()
    expect(locales.value).toHaveLength(2)
    expect(locales.value[0]).toMatchObject({ code: 'en', name: 'English' })
    expect(locales.value[1]).toMatchObject({ code: 'fr', name: 'Français' })
  })

  it('resolves currentLocale from locale ref', () => {
    const { currentLocale } = useLocale()
    expect(currentLocale.value).toMatchObject({ code: 'en', name: 'English' })
  })

  it('updates currentLocale when locale changes', () => {
    const { currentLocale } = useLocale()
    mockLocale.value = 'fr'
    expect(currentLocale.value).toMatchObject({ code: 'fr', name: 'Français' })
  })

  it('switchLocale calls setLocale with the given code', async () => {
    const { switchLocale } = useLocale()
    await switchLocale('fr')
    expect(mockSetLocale).toHaveBeenCalledWith('fr')
  })

  it('switchLocale updates locale value', async () => {
    const { locale, switchLocale } = useLocale()
    await switchLocale('fr')
    expect(locale.value).toBe('fr')
  })

  it('exposes t function for translations', () => {
    const { t } = useLocale()
    expect(typeof t).toBe('function')
    expect(t('common.signOut')).toBe('common.signOut')
  })
})
