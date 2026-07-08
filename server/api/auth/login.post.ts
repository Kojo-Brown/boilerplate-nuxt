import { credentialsSchema } from '~/server/utils/auth-schemas'

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

  await setUserSession(event, {
    user: {
      id: '1',
      email,
      name: 'Admin User',
      provider: 'credentials',
    },
  })

  return { ok: true }
})
