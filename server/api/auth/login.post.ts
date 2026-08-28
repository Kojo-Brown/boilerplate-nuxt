import type { User } from '#auth-utils'

import { credentialsSchema } from '~/server/utils/auth-schemas'
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

  await setUserSession(event, { user })

  // Registers the new session so it can be revoked before it expires. The id
  // only exists once `setUserSession` has minted it, which is why this follows
  // rather than being part of the call above.
  await registerCurrentSession(event, user)

  return { ok: true }
})
