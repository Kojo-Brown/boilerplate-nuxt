import { isCspNonce, stampNonce } from '~/server/utils/csp-nonce'
import { applySecurityHeaders } from '~/server/utils/security-response'

/** The sections of a Nuxt document the renderer lets a plugin rewrite. */
const SECTIONS = ['head', 'bodyPrepend', 'body', 'bodyAppend'] as const

/**
 * Security response headers, and the CSP nonce that makes them wearable.
 *
 * ## Why this is a plugin and not `server/middleware/`
 *
 * `server/middleware/` is where this belongs by convention (see
 * `docs/server-middleware.md`) and it is the wrong place for it, for one
 * concrete reason: Nitro serves `public/` and every prerendered page from a
 * handler that is matched *before* the middleware chain. A header set in
 * `server/middleware/` never reaches them, so `/route-rules/static` — a page,
 * with a full HTML document, prerendered by a route rule — would answer every
 * visitor with no CSP, no HSTS and no `nosniff` at all. Static output is
 * precisely the traffic that gets served for months without anyone looking at
 * it.
 *
 * The `request` hook does not have that hole. h3 calls it at the top of the app
 * handler, before the stack is walked, so it sees the static asset, the
 * prerendered page, the 404, and every rendered route alike. It also runs before
 * `server/middleware/10.auth.ts`, which means the 401 that file throws is
 * already carrying these headers — a rejected request is exactly the response an
 * attacker is most likely to be looking at, and exactly the one a policy applied
 * after the gate would miss.
 *
 * ## Stamping the document
 *
 * `render:html` is the last hook before a document is serialised, which makes it
 * the only place that sees every inline `<script>` Nuxt, `@nuxtjs/color-mode`
 * and the runtime-config injector have added. `server/utils/csp-nonce.ts` lists
 * which those are and why none of them can be a file instead. Nothing is minted
 * here: a second value would be a value the header does not know about.
 *
 * ## The prerender guard
 *
 * Prerendering runs `render:html` at *build* time, so whatever it writes into
 * the markup is frozen into a file that later serves every visitor. A nonce is
 * per request, so a prerendered route must be one the request hook already knows
 * not to mint one for — which it decides from `route-rules.config.ts`.
 *
 * A route can also be prerendered by `definePageMeta({ prerender: true })`,
 * which is a page-level declaration the server has no way to read. That is the
 * one path by which the two could disagree, and the disagreement would not show
 * up as a failing test — it would show up as a blank page in production, because
 * the served HTML's nonce and the response header's nonce were minted an
 * eternity apart. So it fails the build instead, here, with the fix in the
 * message.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    applySecurityHeaders(event)
  })

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = event.context.cspNonce

    if (import.meta.prerender && isCspNonce(nonce)) {
      throw new Error(
        `${event.path} is being prerendered but is not covered by a prerender/swr/isr rule in ` +
          'route-rules.config.ts, so the security-headers request hook will serve it a ' +
          'per-request CSP nonce that its frozen HTML cannot match. Add the route rule (see ' +
          'docs/security-headers.md) rather than relying on definePageMeta({ prerender: true }) ' +
          'alone.',
      )
    }

    if (!isCspNonce(nonce)) return

    for (const section of SECTIONS) {
      html[section] = html[section].map((chunk) => stampNonce(chunk, nonce))
    }
  })
})
