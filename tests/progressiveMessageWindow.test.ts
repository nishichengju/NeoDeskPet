import { describe, expect, it } from 'vitest'
import { resolveProgressiveMessageWindow } from '../src/hooks/useProgressiveMessageWindow'

describe('progressive message window', () => {
  const items = Array.from({ length: 180 }, (_, index) => `message-${index}`)

  it('renders the newest requested messages and reports the hidden prefix', () => {
    const window = resolveProgressiveMessageWindow(items, 60)
    expect(window.hiddenCount).toBe(120)
    expect(window.visibleItems).toHaveLength(60)
    expect(window.visibleItems[0]).toBe('message-120')
    expect(window.visibleItems.at(-1)).toBe('message-179')
  })

  it('expands toward older messages without changing their order', () => {
    const window = resolveProgressiveMessageWindow(items, 120)
    expect(window.hiddenCount).toBe(60)
    expect(window.visibleItems[0]).toBe('message-60')
    expect(window.visibleItems.at(-1)).toBe('message-179')
  })

  it('returns every message when the request exceeds the session length', () => {
    const window = resolveProgressiveMessageWindow(items.slice(0, 12), 60)
    expect(window.hiddenCount).toBe(0)
    expect(window.visibleItems).toEqual(items.slice(0, 12))
  })
})
