import { describe, expect, it } from 'vitest'
import { buildMemoryFtsQuery } from '../electron/memory/memoryFtsQuery'

describe('buildMemoryFtsQuery', () => {
  it('keeps a single Latin entity as one searchable FTS token', () => {
    expect(buildMemoryFtsQuery('Alice')).toBe('"Alice"')
  })

  it('joins whitespace-separated terms with OR and strips embedded quotes', () => {
    expect(buildMemoryFtsQuery(' Alice   "Tea" ')).toBe('"Alice" OR "Tea"')
  })

  it('retains character expansion for a no-space Han query', () => {
    expect(buildMemoryFtsQuery('爱丽丝')).toBe('"爱" OR "丽" OR "丝"')
    expect(buildMemoryFtsQuery('')).toBeNull()
  })
})
