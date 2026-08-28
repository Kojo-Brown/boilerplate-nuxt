import { z } from 'zod'

export const credentialsSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export type CredentialsInput = z.infer<typeof credentialsSchema>

/**
 * Sign-out scope.
 *
 * `current` ends this session; `all` revokes every session the user has, which
 * is the "sign out of all devices" the session registry exists to make possible
 * (see server/utils/session-store.ts). The default is `current` so a client that
 * posts an empty body gets the conservative behaviour rather than a 422.
 */
export const logoutSchema = z.object({
  scope: z.enum(['current', 'all']).default('current'),
})

export type LogoutInput = z.infer<typeof logoutSchema>
