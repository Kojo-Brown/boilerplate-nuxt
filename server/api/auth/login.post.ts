import type { User } from '#auth-utils'

import { credentialsSchema } from '~/server/utils/auth-schemas'
import { signInSession } from '~/server/utils/session-rotation'
import { registerCurrentSession } from '~/server/utils/session-store'

export default defineEventHandler(async (event) => {
  const result = await readValidatedBody(event, (raw) => credentialsSchema.safeParse(raw))

  if (!result.success) {
    throw createError({
      statusCode: 422,
      message: result.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  const { email, password } = result.data

  // Demo check — replace with real database lookup + argon2 verification
  const isValid = email === 'admin@example.com' && password === 'password123'
  if (!isValid) {
    throw createError({ statusCode: 401, message: 'Invalid email or password' })
  }

  const user: User = {
    id: '1',
    email,
    name: 'Admin User',
    provider: 'credentials',
  }

  // `signInSession` mints the session's `sid` and starts both of its clocks.
  // The fresh `sid` is what makes this immune to session fixation — h3's own
  // session id is recovered from whatever cookie the caller arrived with and no
  // API rotates it, so it cannot play that role. Starting the clocks here rather
  // than in the middleware is what makes the absolute cap mean "since you signed
  // in". See server/utils/session-rotation.ts.
  await setUserSession(event, signInSession(user))

  // Registers the new session so it can be revoked before it expires. The id
  // only exists once the session has been minted, which is why this follows
  // rather than being part of the call above.
  await registerCurrentSession(event, user)

  return { ok: true }
})
