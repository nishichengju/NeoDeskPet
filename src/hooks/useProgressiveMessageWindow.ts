import { useCallback, useMemo, useState } from 'react'

export const DEFAULT_MESSAGE_RENDER_COUNT = 60

export function resolveProgressiveMessageWindow<T>(items: readonly T[], requestedCount: number) {
  const safeRequestedCount = Number.isFinite(requestedCount) ? Math.max(0, Math.trunc(requestedCount)) : 0
  const visibleCount = Math.min(items.length, safeRequestedCount)
  const hiddenCount = Math.max(0, items.length - visibleCount)
  return {
    visibleItems: items.slice(hiddenCount),
    hiddenCount,
  }
}

export function useProgressiveMessageWindow<T>(
  items: readonly T[],
  resetKey: string,
  options: { initialCount?: number; batchSize?: number } = {},
) {
  const initialCount = Math.max(1, Math.trunc(options.initialCount ?? DEFAULT_MESSAGE_RENDER_COUNT))
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? initialCount))
  const [windowState, setWindowState] = useState({ key: resetKey, count: initialCount })
  const requestedCount = windowState.key === resetKey ? windowState.count : initialCount
  const window = useMemo(
    () => resolveProgressiveMessageWindow(items, requestedCount),
    [items, requestedCount],
  )
  const loadEarlier = useCallback(() => {
    setWindowState((current) => {
      const currentCount = current.key === resetKey ? current.count : initialCount
      return { key: resetKey, count: Math.min(items.length, currentCount + batchSize) }
    })
  }, [batchSize, initialCount, items.length, resetKey])

  return { ...window, loadEarlier }
}
