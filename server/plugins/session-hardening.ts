import {
  SESSION_PASSWORD_ENV,
  evaluateSessionHardening,
  formatHardeningFailure,
} from '~/server/utils/session-hardening'
import { resolveRotationSettings } from '~/server/utils/session-rotation'

/**
 * Checks the session configuration once, at startup, and refuses to serve a
 * deployment that is not safe.
 *
 * All of the judgement is in `server/utils/session-hardening.ts`, which is pure
 * and unit-tested. This file is the two things that cannot be: reading the live
 * config — including the seal key, which nuxt-auth-utils takes from
 * `process.env` before it looks at `runtimeConfig` — and throwing.
 *
 * Throwing from a Nitro plugin aborts startup, which is the intended outcome and
 * the same stance `server/plugins/storage.ts` takes on an unusable
 * `NUXT_REDIS_URL`: a server that boots with a session cookie readable by
 * scripts, or with no seal key, is worse than one that does not boot. The
 * failure is loud, it is at deploy time, and it names the setting.
 *
 * Rotation being off is not part of the audit, because it is a choice a
 * deployment is allowed to make — a smaller one than any of the above, and one
 * whose cost (a captured cookie stays usable until it expires) falls short of
 * refusing to serve. It gets a warning in a built server and silence in dev,
 * matching how `server/plugins/storage.ts` reports a missing Redis.
 */
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()

  const report = evaluateSessionHardening(config.session, {
    // nuxt-auth-utils resolves the key the same way round, so this is the key
    // that will actually seal cookies — not necessarily the one in the config.
    password: process.env[SESSION_PASSWORD_ENV] ?? config.session?.password ?? '',
    dev: import.meta.dev,
    // `=== true` because the flag is only defined in a Nitro build; an
    // undefined one means "serving", which is the strict side to be on.
    prerender: import.meta.prerender === true,
  })

  for (const warning of report.warnings) {
    console.warn(`[auth] ${warning}`)
  }

  if (report.fatal.length > 0) {
    throw new Error(formatHardeningFailure(report))
  }

  if (resolveRotationSettings(config).intervalSeconds === 0 && !import.meta.dev) {
    console.warn(
      '[auth] session id rotation is off (NUXT_SESSION_ROTATION_INTERVAL_SECONDS=0), so a ' +
        'captured session cookie is usable until it expires. See docs/session-security.md.',
    )
  }
})
