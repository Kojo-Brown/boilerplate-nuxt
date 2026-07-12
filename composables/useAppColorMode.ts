import { computed } from 'vue'

export type ColorModePreference = 'light' | 'dark' | 'system'

export function useAppColorMode() {
  const colorMode = useColorMode()
  const preferences = usePreferencesStore()

  const isDark = computed(() => colorMode.value === 'dark')
  const preference = computed(() => colorMode.preference as ColorModePreference)

  function set(mode: ColorModePreference): void {
    colorMode.preference = mode
    preferences.setColorMode(mode)
  }

  function toggle(): void {
    set(colorMode.preference === 'dark' ? 'light' : 'dark')
  }

  return { isDark, preference, set, toggle }
}
