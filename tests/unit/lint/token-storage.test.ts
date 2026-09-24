import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

/**
 * "httpOnly cookies only", enforced against the client bundle.
 *
 * The server side of that promise is `server/utils/session-hardening.ts`, which
 * refuses to boot with a cookie a script could read or with h3's session request
 * header left enabled. Neither of those checks can see the other half of the
 * problem: nothing stops a component from putting a token in `localStorage`
 * itself. A sealed session cookie the browser guards is worth very little if the
 * same credential is also sitting in web storage, where any injected script —
 * or any extension, or anyone at the keyboard with devtools open — can read it.
 *
 * So this walks every file that ships to the browser and fails on a
 * credential-shaped write to web storage or to `document.cookie`.
 *
 * ## What it can and cannot catch
 *
 * It is a source scan, so it catches the literal forms someone actually writes —
 * `localStorage.setItem('token', …)`, a persisted Pinia store whose name reads
 * like a session — and it does not catch a key assembled at runtime. It is a
 * guard rail on the obvious mistake, not a proof. The proof is that the server
 * never issues a bearer credential to client JavaScript in the first place:
 * there is no token endpoint, `useAuth()` returns the user and not a token, and
 * the sealed session never leaves the cookie.
 *
 * The one credential this app does hand to the browser is the WebSocket
 * handshake ticket (`server/api/ws/ticket.post.ts`), and `useWsChannel` keeps it
 * in a local variable for the few seconds it is valid. If that ever changes,
 * this test is where it will be noticed.
 */

/** Directories whose files are compiled into the client bundle. */
const CLIENT_LAYERS = [
  'app.vue',
  'components',
  'composables',
  'layouts',
  'middleware',
  'pages',
  'plugins',
  'stores',
  'utils',
] as const

const SOURCE_EXTENSIONS = ['.ts', '.vue', '.mjs', '.js']

/** Storage APIs that persist beyond the page, plus the cookie jar. */
const STORAGE_APIS = /\b(localStorage|sessionStorage|document\s*\.\s*cookie|indexedDB)\b/

/**
 * Words that make a stored value a credential. Matched against the whole
 * statement rather than a parsed key, so `setItem(AUTH_KEY, …)` is caught by the
 * constant's name as readily as a string literal would be.
 *
 * Deliberately unanchored rather than `\b`-delimited: the name someone actually
 * reaches for is `access_token` or `authToken`, and a word boundary matches
 * neither — an underscore is a word character, so there is no boundary before
 * the `t`. Over-matching here costs an allowlist entry; under-matching costs the
 * point of the test.
 */
const CREDENTIAL_WORDS = /(token|jwt|bearer|secret|password|credential|session|auth|refresh)/i

/**
 * Keys this app does store in the browser, all of them display preferences that
 * survive a reload. None is a credential, and none is read by the server.
 */
const ALLOWED_KEYS = ['nuxt-color-mode', 'counter', 'preferences', 'i18n_redirected']

const projectRoot = path.resolve(import.meta.dirname, '../../..')

async function clientSources(): Promise<string[]> {
  const found: string[] = []

  async function walk(relative: string): Promise<void> {
    const absolute = path.join(projectRoot, relative)
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null)

    if (entries === null) {
      // A layer that is a single file (`app.vue`) rather than a directory.
      if (SOURCE_EXTENSIONS.some((extension) => relative.endsWith(extension))) found.push(relative)
      return
    }

    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
        found.push(child)
    }
  }

  await Promise.all(CLIENT_LAYERS.map(walk))
  return found.sort()
}

/** Every line that touches web storage, with its file and line number. */
async function storageLines(): Promise<{ file: string; line: number; text: string }[]> {
  const files = await clientSources()
  const hits: { file: string; line: number; text: string }[] = []

  for (const file of files) {
    const source = await readFile(path.join(projectRoot, file), 'utf8')
    source.split('\n').forEach((text, index) => {
      if (STORAGE_APIS.test(text)) hits.push({ file, line: index + 1, text: text.trim() })
    })
  }

  return hits
}

const hits = await storageLines()

describe('client-side token storage', () => {
  it('finds the client layers it is supposed to be scanning', async () => {
    // A guard that silently scans nothing passes forever. This is the canary:
    // if the directory layout changes, this fails before the rules below start
    // reporting a clean bill of health for an empty set.
    const files = await clientSources()

    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('composables/useAuth.ts')
    expect(files).toContain('stores/preferences.ts')
  })

  it('stores nothing credential-shaped in web storage or document.cookie', () => {
    const offenders = hits.filter(({ text }) => {
      if (ALLOWED_KEYS.some((key) => text.includes(key))) return false
      return CREDENTIAL_WORDS.test(text)
    })

    expect(
      offenders.map(({ file, line, text }) => `${file}:${line} ${text}`),
      'A credential in web storage is readable by any script on the page. Keep it in ' +
        'the httpOnly session cookie — see docs/session-security.md.',
    ).toEqual([])
  })

  it('keeps useAuth() free of any storage access at all', () => {
    // The composable every page uses to sign in and out is the one most likely
    // to grow a "remember me" that writes a token somewhere.
    expect(hits.filter(({ file }) => file === 'composables/useAuth.ts')).toEqual([])
  })

  it('persists only the preference stores, and only their non-credential fields', () => {
    // `pinia-plugin-persistedstate` writes a whole store to localStorage under
    // its id, so a store that ever holds a credential must not be persisted.
    const storeFiles = ['stores/counter.ts', 'stores/preferences.ts']
    const persisted: string[] = []

    return Promise.all(
      storeFiles.map(async (file) => {
        const source = await readFile(path.join(projectRoot, file), 'utf8')
        if (/^\s*persist:/m.test(source)) persisted.push(file)
        expect(CREDENTIAL_WORDS.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''))).toBe(false)
      }),
    ).then(() => {
      expect(persisted).toEqual(storeFiles)
    })
  })

  it('exposes no token from the session composable', () => {
    // `useUserSession()` returns the user, never the sealed value; anything in
    // useAuth's public surface named like a token would mean that changed.
    return readFile(path.join(projectRoot, 'composables/useAuth.ts'), 'utf8').then((source) => {
      const returned = /return\s*\{([\s\S]*?)\n\s*\}/.exec(source)?.[1] ?? ''

      expect(returned).not.toMatch(/\btoken\b/i)
      expect(returned.length).toBeGreaterThan(0)
    })
  })
})
