import {
  createOutboxRelay,
  outboxBootWarning,
  resolveOutboxRelayPlan,
  type OutboxLogger,
  type OutboxPublisher,
  type OutboxRelayPlan,
} from '~/server/utils/outbox'
import {
  createHttpOutboxPublisher,
  createLoggingOutboxPublisher,
} from '~/server/utils/outbox-publisher'
import { createDrizzleOutboxStore } from '~/server/utils/outbox-store'

/**
 * Starts the outbox relay at server startup, and stops it at shutdown.
 *
 * All of the decisions live in `server/utils/outbox.ts`, which depends on
 * nothing but its own ports and is unit-tested. This file is the part that
 * cannot be: it reads the live config, reaches for the database, picks a
 * publisher, and hooks shutdown.
 *
 * ## Ordering against `storage.ts`
 *
 * There are now two plugins and neither filename is numbered, unlike
 * `server/middleware/`. That is still correct rather than an omission: the relay
 * touches Postgres and never `useStorage()`, so it does not care whether the
 * Redis mounts exist yet. A third plugin that *does* depend on one of these
 * should renumber all of them at that point.
 *
 * ## One relay per process, competing on purpose
 *
 * Every instance runs this, and they all poll the same table. That is the
 * design, not a deployment mistake — the claim is `FOR UPDATE SKIP LOCKED`
 * (`server/utils/outbox-store.ts`), so instances divide the queue between
 * themselves and a dead one's rows return by lease expiry. Scaling the web tier
 * scales the relay with it, and there is no separate worker deployment to keep
 * in step with the schema.
 *
 * A deployment that would rather run the relay somewhere else sets
 * `NUXT_OUTBOX_RELAY_ENABLED=false` on the web instances and leaves it on for
 * one. Nothing else changes: the routes keep writing outbox rows either way,
 * because that half is a database transaction and not a background job.
 *
 * ## Failures here do not take the server down
 *
 * The relay is started and left to run. A pass that throws — a consumer that is
 * down, a database that is unreachable — is logged and retried on the next poll,
 * and never reaches a request. The one thing that *does* fail the boot is a
 * `NUXT_OUTBOX_WEBHOOK_URL` that is set and unusable, which
 * {@link resolveOutboxRelayPlan} throws on for the reason `storage.ts` gives
 * about `NUXT_REDIS_URL`: it means somebody intended delivery and will not get
 * it.
 */
/**
 * Relay log lines go to the console, which is where a Nitro deployment's log
 * collector is already looking.
 *
 * A retry is a `warn` and a dead letter is an `error`, because they are
 * different events for an operator: the first is the system working, the second
 * is an event that will never be delivered unless somebody acts.
 */
const relayLogger: OutboxLogger = (level, message, error) => {
  if (level === 'error') console.error(message, error ?? '')
  else console.warn(message)
}

export default defineNitroPlugin((nitro) => {
  const config = useRuntimeConfig()
  const plan = resolveOutboxRelayPlan(config, import.meta.dev)

  const warning = outboxBootWarning(plan, import.meta.dev)
  if (warning) console.warn(warning)

  if (plan.mode === 'disabled') return

  const relay = createOutboxRelay({
    // `useDb()` is lazy — `postgres()` does not open a connection until the
    // first query — so building the store here costs nothing on an instance
    // whose first poll finds an empty queue.
    store: createDrizzleOutboxStore(useDb()),
    publish: publisherFor(plan),
    settings: plan.settings,
    log: relayLogger,
  })

  relay.start()

  // Nitro's `close` hook fires on shutdown. Awaiting `stop` lets the pass in
  // flight finish marking its rows delivered rather than being cut off after
  // publishing them, which is the difference between a clean rolling restart and
  // one that redelivers whatever was in flight.
  nitro.hooks.hook('close', async () => {
    await relay.stop()
  })
})

/** The destination the boot plan chose. */
function publisherFor(plan: Extract<OutboxRelayPlan, { mode: 'http' | 'log' }>): OutboxPublisher {
  return plan.mode === 'http'
    ? createHttpOutboxPublisher({ url: plan.url, timeoutMs: plan.settings.publishTimeoutMs })
    : // Development only, and routed through the relay's own logger so a
      // non-delivery reads as the warning it is rather than as information.
      createLoggingOutboxPublisher((message) => relayLogger('warn', message))
}
