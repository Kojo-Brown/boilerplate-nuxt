import redisDriver from 'unstorage/drivers/redis'

import { resolveStorageMounts, storageBootWarning } from '~/server/utils/storage'

/**
 * Mounts the Redis driver onto Nitro's storage at startup.
 *
 * Everything in `server/plugins/` runs once per server process, before the
 * first request. There is only one plugin, so — unlike `server/middleware/`,
 * where the `00.`/`10.` prefixes are load-bearing — this filename carries no
 * ordering and is not numbered. Add a second plugin that has to run after this
 * one and both should be renamed then, not pre-emptively now.
 *
 * All of the decisions live in `server/utils/storage.ts`, which is a pure
 * function of runtime config and is unit-tested. This file is the part that
 * cannot be: it reads the live config, calls `mount`, and disposes on shutdown.
 *
 * A bad `NUXT_REDIS_URL` throws here and the process does not start. That is the
 * intended outcome — see the note in `storage.ts` on why a server that boots
 * without the shared storage it was configured for is worse than one that
 * refuses to.
 */
export default defineNitroPlugin((nitro) => {
  const config = useRuntimeConfig()
  const plan = resolveStorageMounts(config)

  const warning = storageBootWarning(plan, import.meta.dev)
  if (warning) console.warn(warning)

  const storage = useStorage()

  for (const mount of plan.redisMounts) {
    // `preConnect` is left at its default (`false`): the driver connects lazily
    // on the first read or write. Connecting eagerly here would make Redis
    // availability a condition of *booting*, so a Redis blip during a rollout
    // would fail the new pods' readiness instead of degrading a cache lookup.
    storage.mount(mount.base, redisDriver(mount.options))
  }

  // Nitro's `close` hook fires on shutdown. `unmount` with `dispose: true` (the
  // default) runs each driver's own teardown, which for Redis means quitting the
  // ioredis connection instead of leaving the socket for the runtime to reap —
  // the difference between a clean exit and a process that hangs on SIGTERM.
  nitro.hooks.hook('close', async () => {
    for (const mount of plan.redisMounts) {
      await storage.unmount(mount.base)
    }
  })
})
