import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'

// Nuxt auto-imports are unavailable in the node test environment.
// Use reactive refs so computed properties inside the composable actually track changes.

const mockPreference = ref<string>('system')
const mockColorValue = ref<string>('light')

vi.stubGlobal('useColorMode', () => ({
  get preference() {
    return mockPreference.value
  },
  set preference(v: string) {
    mockPreference.value = v
  },
  get value() {
    return mockColorValue.value
  },
}))

const mockSetColorMode = vi.fn()
vi.stubGlobal('usePreferencesStore', () => ({
  get colorMode() {
    return mockPreference.value
  },
  setColorMode: mockSetColorMode,
}))

vi.stubGlobal('computed', computed)

import { useAppColorMode } from '../../../composables/useAppColorMode'

describe('useAppColorMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPreference.value = 'system'
    mockColorValue.value = 'light'
  })

  it('returns isDark, preference, set, and toggle', () => {
    const result = useAppColorMode()
    expect(result.isDark).toBeDefined()
    expect(result.preference).toBeDefined()
    expect(typeof result.set).toBe('function')
    expect(typeof result.toggle).toBe('function')
  })

  it('isDark is false when colorMode.value is light', () => {
    mockColorValue.value = 'light'
    const { isDark } = useAppColorMode()
    expect(isDark.value).toBe(false)
  })

  it('isDark is true when colorMode.value is dark', () => {
    mockColorValue.value = 'dark'
    const { isDark } = useAppColorMode()
    expect(isDark.value).toBe(true)
  })

  it('preference reflects colorMode.preference', () => {
    mockPreference.value = 'dark'
    const { preference } = useAppColorMode()
    expect(preference.value).toBe('dark')
  })

  it('set() updates colorMode.preference and calls preferences.setColorMode', () => {
    const { set } = useAppColorMode()
    set('dark')
    expect(mockPreference.value).toBe('dark')
    expect(mockSetColorMode).toHaveBeenCalledWith('dark')
  })

  it('set() accepts all three valid modes', () => {
    const { set } = useAppColorMode()
    set('light')
    expect(mockPreference.value).toBe('light')
    set('system')
    expect(mockPreference.value).toBe('system')
    set('dark')
    expect(mockPreference.value).toBe('dark')
  })

  it('toggle() switches from dark to light', () => {
    mockPreference.value = 'dark'
    const { toggle } = useAppColorMode()
    toggle()
    expect(mockPreference.value).toBe('light')
    expect(mockSetColorMode).toHaveBeenCalledWith('light')
  })

  it('toggle() switches from light to dark', () => {
    mockPreference.value = 'light'
    const { toggle } = useAppColorMode()
    toggle()
    expect(mockPreference.value).toBe('dark')
    expect(mockSetColorMode).toHaveBeenCalledWith('dark')
  })

  it('toggle() switches from system to dark', () => {
    mockPreference.value = 'system'
    const { toggle } = useAppColorMode()
    toggle()
    expect(mockPreference.value).toBe('dark')
    expect(mockSetColorMode).toHaveBeenCalledWith('dark')
  })
})
