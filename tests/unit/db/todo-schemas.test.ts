import { describe, it, expect } from 'vitest'
import { createTodoSchema, updateTodoSchema } from '../../../server/utils/todo-schemas'

describe('createTodoSchema', () => {
  it('accepts a valid title', () => {
    const result = createTodoSchema.safeParse({ title: 'Buy milk' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('Buy milk')
  })

  it('rejects an empty title', () => {
    const result = createTodoSchema.safeParse({ title: '' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toBe('Title is required')
  })

  it('rejects a title longer than 255 characters', () => {
    const result = createTodoSchema.safeParse({ title: 'a'.repeat(256) })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe('Title must be 255 characters or less')
  })

  it('rejects missing title', () => {
    const result = createTodoSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects non-string title', () => {
    const result = createTodoSchema.safeParse({ title: 42 })
    expect(result.success).toBe(false)
  })

  it('trims to exactly 255 characters when at limit', () => {
    const result = createTodoSchema.safeParse({ title: 'a'.repeat(255) })
    expect(result.success).toBe(true)
  })
})

describe('updateTodoSchema', () => {
  it('accepts a valid title update', () => {
    const result = updateTodoSchema.safeParse({ title: 'Updated title' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('Updated title')
  })

  it('accepts a completed toggle', () => {
    const result = updateTodoSchema.safeParse({ completed: true })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.completed).toBe(true)
  })

  it('accepts updating both fields', () => {
    const result = updateTodoSchema.safeParse({ title: 'Done', completed: true })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('Done')
      expect(result.data.completed).toBe(true)
    }
  })

  it('accepts an empty object (no fields to change, handler rejects this)', () => {
    const result = updateTodoSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('rejects an empty string title', () => {
    const result = updateTodoSchema.safeParse({ title: '' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toBe('Title is required')
  })

  it('rejects non-boolean completed value', () => {
    const result = updateTodoSchema.safeParse({ completed: 'yes' })
    expect(result.success).toBe(false)
  })
})
