import { defineStore } from 'pinia'

type ColorMode = 'light' | 'dark' | 'system'
type SidebarState = 'open' | 'closed'

interface PreferencesState {
  colorMode: ColorMode
  sidebarState: SidebarState
  language: string
  pageSize: number
}

export const usePreferencesStore = defineStore('preferences', {
  state: (): PreferencesState => ({
    colorMode: 'system',
    sidebarState: 'open',
    language: 'en',
    pageSize: 10,
  }),
  getters: {
    isDarkMode: (state): boolean => state.colorMode === 'dark',
    isSidebarOpen: (state): boolean => state.sidebarState === 'open',
  },
  actions: {
    setColorMode(mode: ColorMode) {
      this.colorMode = mode
    },
    toggleSidebar() {
      this.sidebarState = this.sidebarState === 'open' ? 'closed' : 'open'
    },
    setLanguage(lang: string) {
      this.language = lang
    },
    setPageSize(size: number) {
      this.pageSize = size
    },
  },
  persist: {
    pick: ['colorMode', 'sidebarState', 'language', 'pageSize'],
  },
})
