import { watch } from 'vue'
import type { ColorModePreference } from '@/composables/useAppColorMode'

export default defineNuxtPlugin({
  name: 'color-mode-sync',
  setup() {
    const colorMode = useColorMode()
    const preferences = usePreferencesStore()

    // Bootstrap: mirror the persisted Pinia preference into the color-mode module.
    // The preferences store survives page reloads via pinia-plugin-persistedstate,
    // so it wins as the initial source of truth on the client.
    colorMode.preference = preferences.colorMode

    // Keep the preferences store in sync when colorMode changes (e.g. OS toggle).
    watch(
      () => colorMode.preference,
      (val) => preferences.setColorMode(val as ColorModePreference),
    )
  },
})
