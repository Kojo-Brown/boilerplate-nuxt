/**
 * Minting a nonce, and putting it on the tags that need one.
 *
 * Two functions, separated from `server/utils/security-headers.ts` because they
 * are the only part of the CSP story that touches the response *body*. The
 * header module decides what the policy says; this one makes the document agree
 * with it.
 *
 * ## Why Nuxt pages need this at all
 *
 * A production build of this app emits three inline `<script>` blocks on every
 * rendered page, none of which the project wrote and none of which can be moved
 * to a file:
 *
 *  - the `importmap` that maps `#entry` to the hashed entry chunk,
 *  - `@nuxtjs/color-mode`'s pre-hydration script, which has to run before first
 *    paint or the page flashes the wrong theme,
 *  - `window.__NUXT__.config`, which carries `runtimeConfig.public` and so
 *    cannot be a build-time asset — its contents change with the environment.
 *
 * Under `script-src 'self'` all three are blocked and the page does not boot.
 * The nonce is what lets the policy say "these three, and nothing else an
 * injection can add".
 *
 * That last point is also why hashing them instead is not an option: a hash is
 * fixed at build time and `window.__NUXT__.config` is not.
 */

/** 16 bytes. CSP asks for at least 128 bits of entropy; this is exactly that. */
const NONCE_BYTES = 16

/** What a value has to look like before it is written into an attribute. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A fresh base64 nonce.
 *
 * `crypto.getRandomValues` rather than `Math.random`: the whole guarantee is
 * that an attacker who can inject a `<script>` tag cannot guess the value that
 * would make it run, and a predictable nonce is worth less than no policy at
 * all, because it reads like one.
 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/** Whether a value is safe to interpolate into a `nonce="…"` attribute. */
export function isCspNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && NONCE_PATTERN.test(value)
}

/**
 * Opening `<script>` / `<style>` tags. The second group is the attribute run,
 * which is kept verbatim so nothing already on the tag is disturbed.
 */
const INLINE_TAG = /<(script|style)((?:\s[^>]*)?)>/gi

/** A tag that already carries a nonce is left alone. */
const HAS_NONCE = /\snonce\s*=/i

/**
 * Adds `nonce="…"` to every `<script>` and `<style>` opening tag in a chunk of
 * rendered markup.
 *
 * Applied to the head, body and body-append arrays Nuxt hands the `render:html`
 * hook — strings that Nuxt itself just produced, not arbitrary input, which is
 * what makes a regex the right tool here rather than a parser. The cost of being
 * wrong is bounded in the right direction too: a tag this misses is a tag the
 * browser refuses to run, which is loud, rather than a tag it wrongly allows.
 *
 * Tags carrying a `src` are stamped as well. The policy does not need it —
 * they are same-origin and `'self'` already covers them — but it means adding
 * `'strict-dynamic'` later is a one-line change to the policy instead of a hunt
 * for the scripts it would start blocking.
 *
 * @throws if the nonce is not something that can be written into an attribute.
 * A caller that has lost hold of its nonce should fail, not emit a document
 * whose attributes it cannot account for.
 */
export function stampNonce(markup: string, nonce: string): string {
  if (!isCspNonce(nonce)) {
    throw new Error(`Refusing to stamp a malformed CSP nonce: ${JSON.stringify(nonce)}`)
  }

  return markup.replace(INLINE_TAG, (tag, name: string, attributes: string) => {
    if (HAS_NONCE.test(attributes)) return tag
    // A self-closing spelling (`<script … />`) would otherwise become
    // `<script …/ nonce="…">`, which puts the slash inside the attribute run.
    const trimmed = attributes.replace(/\s*\/$/, '')
    return `<${name}${trimmed} nonce="${nonce}">`
  })
}
