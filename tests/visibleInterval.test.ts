import { afterEach, describe, expect, it, vi } from 'vitest'
import { startVisibilityAwareInterval } from '../src/hooks/useVisibleInterval'

function createVisibilitySource(initialVisible: boolean) {
  let visible = initialVisible
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    setVisible(nextVisible: boolean) {
      visible = nextVisible
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
  }
}

describe('visibility-aware interval', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pauses while hidden and refreshes immediately when visible again', () => {
    vi.useFakeTimers()
    const source = createVisibilitySource(true)
    const callback = vi.fn()
    const dispose = startVisibilityAwareInterval({
      callback,
      delayMs: 1000,
      isVisible: source.isVisible,
      subscribe: source.subscribe,
    })

    vi.advanceTimersByTime(2500)
    expect(callback).toHaveBeenCalledTimes(2)

    source.setVisible(false)
    vi.advanceTimersByTime(5000)
    expect(callback).toHaveBeenCalledTimes(2)

    source.setVisible(true)
    expect(callback).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1000)
    expect(callback).toHaveBeenCalledTimes(4)

    dispose()
    vi.advanceTimersByTime(5000)
    expect(callback).toHaveBeenCalledTimes(4)
    expect(source.listenerCount()).toBe(0)
  })

  it('does not start hidden intervals before the page becomes visible', () => {
    vi.useFakeTimers()
    const source = createVisibilitySource(false)
    const callback = vi.fn()
    const dispose = startVisibilityAwareInterval({
      callback,
      delayMs: 1500,
      isVisible: source.isVisible,
      subscribe: source.subscribe,
    })

    vi.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()

    source.setVisible(true)
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1500)
    expect(callback).toHaveBeenCalledTimes(2)

    dispose()
  })
})
