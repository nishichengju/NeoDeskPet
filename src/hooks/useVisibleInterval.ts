import { useEffect, useRef } from 'react'

export type VisibilityAwareIntervalOptions = {
  callback: () => void
  delayMs: number
  isVisible: () => boolean
  subscribe: (listener: () => void) => () => void
  runOnVisible?: boolean
}

export function startVisibilityAwareInterval(options: VisibilityAwareIntervalOptions): () => void {
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0
  let timer: ReturnType<typeof globalThis.setInterval> | null = null
  let visible = options.isVisible()
  let disposed = false

  const stop = () => {
    if (timer == null) return
    globalThis.clearInterval(timer)
    timer = null
  }
  const start = () => {
    if (timer != null || disposed) return
    timer = globalThis.setInterval(options.callback, delayMs)
  }
  const syncVisibility = () => {
    if (disposed) return
    const nextVisible = options.isVisible()
    if (nextVisible) {
      if (!visible && options.runOnVisible !== false) options.callback()
      start()
    } else {
      stop()
    }
    visible = nextVisible
  }

  const unsubscribe = options.subscribe(syncVisibility)
  if (visible) start()

  return () => {
    disposed = true
    stop()
    unsubscribe()
  }
}

export function useVisibleInterval(callback: () => void, delayMs: number, enabled = true) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    return startVisibilityAwareInterval({
      callback: () => callbackRef.current(),
      delayMs,
      isVisible: () => document.visibilityState === 'visible',
      subscribe: (listener) => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
    })
  }, [delayMs, enabled])
}
