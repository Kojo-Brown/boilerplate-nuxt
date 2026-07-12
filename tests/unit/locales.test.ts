import { describe, it, expect } from 'vitest'
import en from '../../locales/en.json'
import fr from '../../locales/fr.json'

type NestedRecord = { [key: string]: string | NestedRecord }

function flattenKeys(obj: NestedRecord, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const fullKey = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' ? flattenKeys(v, fullKey) : [fullKey]
  })
}

function getNestedValue(obj: NestedRecord, key: string): string | NestedRecord | undefined {
  return key.split('.').reduce<string | NestedRecord | undefined>((acc, part) => {
    if (acc === undefined || typeof acc === 'string') return undefined
    return acc[part]
  }, obj)
}

describe('locale files', () => {
  const enKeys = flattenKeys(en as NestedRecord).sort()
  const frKeys = flattenKeys(fr as NestedRecord).sort()

  it('en and fr have the same set of keys', () => {
    expect(frKeys).toEqual(enKeys)
  })

  it('en has no empty string values', () => {
    const emptyKeys = enKeys.filter((k) => getNestedValue(en as NestedRecord, k) === '')
    expect(emptyKeys).toEqual([])
  })

  it('fr has no empty string values', () => {
    const emptyKeys = frKeys.filter((k) => getNestedValue(fr as NestedRecord, k) === '')
    expect(emptyKeys).toEqual([])
  })

  it('en locale has expected top-level namespaces', () => {
    expect(Object.keys(en)).toEqual(
      expect.arrayContaining(['common', 'nav', 'auth', 'dashboard', 'counter', 'preferences']),
    )
  })
})
