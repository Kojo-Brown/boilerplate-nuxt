import type { CachedEntryContext } from '~/server/utils/cache-tags'
import type { RequestAuth } from '~/server/utils/request-auth'

/**
 * Typed `H3Event` context.
 *
 * `H3EventContext` is declared by h3 as `interface H3EventContext extends
 * Record<string, any>`, so `event.context.anything` already compiles — and is
 * already `any`. Nothing is unlocked by declaring these members; what is gained
 * is that they stop being `any`. `event.context.auth` narrows through the
 * `authenticated` discriminant, `event.context.requestId` is a `string` that
 * cannot be handed to something expecting a number, and a typo in the property
 * name is the one thing the index signature will still happily accept — which is
 * why handlers should reach for `requireAuth(event)` rather than the raw
 * property.
 *
 * Augmenting the module (rather than declaring these on some wrapper type) is
 * what makes them visible on every `H3Event` in the project: middleware,
 * handlers, and `server/utils` alike, with no cast at the boundary.
 *
 * Populated by `server/middleware/`, plus one member written by the cached-route
 * wrapper:
 *
 *  - `requestId` / `requestReceivedAt` — `00.request-context.ts`, which runs for
 *    every request, so both are always present by the time a handler executes.
 *  - `cspNonce` — the `request` hook in `server/plugins/security-headers.ts`,
 *    for every response except those served from shared (prerendered or
 *    cached) HTML. It is a plugin rather than middleware because static and
 *    prerendered output never reaches the middleware chain; see that file.
 *  - `auth` — `10.auth.ts`, and only for paths `server/utils/access-policy.ts`
 *    manages. It is optional because that is the truth: a page or asset request
 *    never has one. `requireAuth(event)` is the accessor that turns the absent
 *    case into an error naming the policy file, so handler code never needs `?.`
 *    or `!` — the same trade the app-side `defineInjection` makes in
 *    `docs/provide-inject.md`.
 */
declare module 'h3' {
  interface H3EventContext {
    /**
     * Correlation id for this request. Echoed to the client as `x-request-id`,
     * and taken from the caller's own `x-request-id` / `x-correlation-id` header
     * when it sends a usable one.
     */
    requestId: string

    /** `Date.now()` at the moment the request entered the middleware chain. */
    requestReceivedAt: number

    /**
     * The Content-Security-Policy nonce minted for this response by
     * `server/utils/security-response.ts`, and written onto the document's
     * inline tags by `server/plugins/security-headers.ts`.
     *
     * Optional because its absence is meaningful rather than accidental: a path
     * whose HTML is prerendered or cached is served the same body to everyone,
     * so it gets a policy with no nonce in it at all. See
     * `server/utils/security-headers.ts` and `docs/security-headers.md`.
     */
    cspNonce?: string

    /**
     * Who is calling, resolved once per request. Absent on paths the access
     * policy does not manage — read it through `requireAuth(event)`.
     */
    auth?: RequestAuth

    /**
     * The cache entry this request maps to, resolved by
     * `server/utils/cached-route.ts` before Nitro decides whether it is a hit.
     * Present only on routes wrapped in `defineCachedApiHandler`, which is why
     * it is the one member here `server/middleware/` does not populate.
     */
    cachedEntry?: CachedEntryContext
  }
}

export {}
