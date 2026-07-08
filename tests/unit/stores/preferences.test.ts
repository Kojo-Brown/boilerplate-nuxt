import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePreferencesStore } from '../../../stores/preferences'

describe('usePreferencesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has default state', () => {
    const store = usePreferencesStore()
    expect(store.colorMode).toBe('system')
    expect(store.sidebarState).toBe('open')
    expect(store.language).toBe('en')
    expect(store.pageSize).toBe(10)
  })

  it('sets color mode to dark', () => {
    const store = usePreferencesStore()
    store.setColorMode('dark')
    expect(store.colorMode).toBe('dark')
  })

  it('isDarkMode is true only when colorMode is dark', () => {
    const store = usePreferencesStore()
    store.setColorMode('dark')
    expect(store.isDarkMode).toBe(true)
    store.setColorMode('light')
    expect(store.isDarkMode).toBe(false)
    store.setColorMode('system')
    expect(store.isDarkMode).toBe(false)
  })

  it('isSidebarOpen reflects sidebarState', () => {
    const store = usePreferencesStore()
    expect(store.isSidebarOpen).toBe(true)
    store.toggleSidebar()
    expect(store.isSidebarOpen).toBe(false)
  })

  it('toggleSidebar switches between open and closed', () => {
    const store = usePreferencesStore()
    store.toggleSidebar()
    expect(store.sidebarState).toBe('closed')
    store.toggleSidebar()
    expect(store.sidebarState).toBe('open')
  })

  it('sets language', () => {
    const store = usePreferencesStore()
    store.setLanguage('fr')
    expect(store.language).toBe('fr')
  })

  it('sets page size', () => {
    const store = usePreferencesStore()
    store.setPageSize(25)
    expect(store.pageSize).toBe(25)
  })

  it('page size defaults to 10', () => {
    const store = usePreferencesStore()
    expect(store.pageSize).toBe(10)
  })

  it('store instances are reactive', () => {
    const store = usePreferencesStore()
    store.setPageSize(50)
    const store2 = usePreferencesStore()
    expect(store2.pageSize).toBe(50)
  })
})
