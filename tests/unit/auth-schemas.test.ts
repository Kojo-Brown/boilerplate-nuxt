import { describe, it, expect } from 'vitest'
import { credentialsSchema } from '../../server/utils/auth-schemas'

describe('credentialsSchema', () => {
  it('accepts valid email and password', () => {
    const result = credentialsSchema.safeParse({
      email: 'user@example.com',
      password: 'securepassword',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email format', () => {
    const result = credentialsSchema.safeParse({
      email: 'not-an-email',
      password: 'securepassword',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Invalid email address')
    }
  })

  it('rejects password shorter than 8 characters', () => {
    const result = credentialsSchema.safeParse({
      email: 'user@example.com',
      password: 'short',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Password must be at least 8 characters')
    }
  })

  it('rejects empty object', () => {
    const result = credentialsSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects missing password', () => {
    const result = credentialsSchema.safeParse({ email: 'user@example.com' })
    expect(result.success).toBe(false)
  })

  it('rejects missing email', () => {
    const result = credentialsSchema.safeParse({ password: 'securepassword' })
    expect(result.success).toBe(false)
  })

  it('infers correct type for valid input', () => {
    const result = credentialsSchema.safeParse({
      email: 'user@example.com',
      password: 'securepassword',
    })
    if (result.success) {
      const data: { email: string; password: string } = result.data
      expect(data.email).toBe('user@example.com')
      expect(data.password).toBe('securepassword')
    }
  })
})
