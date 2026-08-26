import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  publicApiPatterns,
  resolveAccess,
  serverAccessRules,
  type RouteAccess,
} from '~/server/utils/access-policy'
import { normalisePathname } from '~/server/utils/request-path'

const SERVER_DIR = fileURLToPath(new URL('../../../server', import.meta.url))

/**
 * Every request path `server/api/` and `server/routes/` can serve, derived from
 * the filenames rather than listed by hand — a hand-written list would be the
 * thing that goes stale.
 *
 * Nitro's filename conventions: the trailing `.get`/`.post`/… is the method,
 * `index` is the directory itself, and `[id]` is a dynamic segment (substituted
 * with a sample value here, since the policy matches on prefixes).
 */
function routePaths(dir: string, prefix: string): string[] {
  const paths: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      paths.push(...routePaths(`${dir}/${entry.name}`, `${prefix}/${entry.name}`))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue

    const withoutMethod = entry.name
      .replace(/\.(get|post|put|patch|delete|head|options)\.ts$/, '')
      .replace(/\.ts$/, '')
    const segment = withoutMethod.replace(/\[(\w+)\]/, 'sample-id')
    paths.push(segment === 'index' ? prefix : `${prefix}/${segment}`)
  }

  return paths
}

const apiPaths = routePaths(`${SERVER_DIR}/api`, '/api')
const serverRoutePaths = routePaths(`${SERVER_DIR}/routes`, '')

describe('resolveAccess', () => {
  it('leaves page and asset traffic unmanaged', () => {
    for (const path of ['/', '/login', '/data-patterns', '/_nuxt/entry.js', '/favicon.ico']) {
      expect(resolveAccess(path)).toBe('unmanaged')
    }
  })

  it('defaults every API path to authenticated', () => {
    expect(resolveAccess('/api')).toBe('authenticated')
    expect(resolveAccess('/api/anything/not/in/the/table')).toBe('authenticated')
  })

  it('applies the public carve-outs to the prefix itself and everything under it', () => {
    expect(resolveAccess('/api/auth')).toBe('public')
    expect(resolveAccess('/api/auth/login')).toBe('public')
    expect(resolveAccess('/api/route-rules/swr')).toBe('public')
    expect(resolveAccess('/api/rendering/info')).toBe('public')
    expect(resolveAccess('/auth/github')).toBe('public')
  })

  it('does not let a public prefix match a longer sibling name', () => {
    // `/api/authorised` shares a string prefix with `/api/auth` but is not
    // below it, so the wildcard must not reach it.
    expect(resolveAccess('/api/authorised')).toBe('authenticated')
    expect(resolveAccess('/api/rendering-secrets')).toBe('authenticated')
  })

  it('protects the routes that read or write real data', () => {
    expect(resolveAccess('/api/todos')).toBe('authenticated')
    expect(resolveAccess('/api/todos/sample-id')).toBe('authenticated')
    expect(resolveAccess('/api/uploads')).toBe('authenticated')
    expect(resolveAccess('/api/uploads/presign')).toBe('authenticated')
    expect(resolveAccess('/api/metrics')).toBe('authenticated')
    expect(resolveAccess('/api/posts')).toBe('authenticated')
  })

  it('lets an exact key beat a wildcard of the same prefix length', () => {
    const rules: Record<string, RouteAccess> = {
      '/**': 'unmanaged',
      '/api/**': 'authenticated',
      '/api/demo': 'public',
      '/api/demo/**': 'authenticated',
    }
    expect(resolveAccess('/api/demo', rules)).toBe('public')
    expect(resolveAccess('/api/demo/nested', rules)).toBe('authenticated')
  })

  it('picks the most specific rule regardless of table order', () => {
    const general: Record<string, RouteAccess> = {
      '/api/**': 'authenticated',
      '/api/a/b/**': 'public',
    }
    const reversed: Record<string, RouteAccess> = {
      '/api/a/b/**': 'public',
      '/api/**': 'authenticated',
    }
    expect(resolveAccess('/api/a/b/c', general)).toBe('public')
    expect(resolveAccess('/api/a/b/c', reversed)).toBe('public')
  })

  it('falls back to unmanaged when nothing matches', () => {
    expect(resolveAccess('/api/todos', { '/other/**': 'public' })).toBe('unmanaged')
  })
})

/**
 * The anti-rot gates. A default-deny table only stays trustworthy while its
 * carve-outs describe routes that exist and while the rules it names are
 * reachable at all.
 */
describe('the policy and the route tree agree', () => {
  it('finds the routes it is meant to be checking', () => {
    // Guards the two gates below: a broken `routePaths` would make them vacuous.
    expect(apiPaths).toContain('/api/todos')
    expect(apiPaths).toContain('/api/todos/sample-id')
    expect(apiPaths).toContain('/api/auth/login')
    expect(apiPaths.length).toBeGreaterThan(10)
    expect(serverRoutePaths).toEqual(['/auth/github'])
  })

  it('has no public carve-out left over from a deleted route', () => {
    for (const pattern of publicApiPatterns()) {
      const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
      const covered = apiPaths.filter(
        (path) => path === prefix || path.startsWith(`${prefix}/`) || pattern === path,
      )
      expect(covered, `no route under the public rule ${pattern}`).not.toHaveLength(0)
    }
  })

  it('classifies every route the server actually serves', () => {
    for (const path of [...apiPaths, ...serverRoutePaths]) {
      const access = resolveAccess(normalisePathname(path))
      expect(
        access,
        `${path} is unmanaged — server routes must be public or authenticated`,
      ).not.toBe('unmanaged')
    }
  })

  it('declares every rule with a leading-slash key', () => {
    for (const pattern of Object.keys(serverAccessRules)) {
      expect(pattern.startsWith('/')).toBe(true)
    }
  })
})
