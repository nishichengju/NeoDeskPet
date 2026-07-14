import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function getDialogFocusWrapTarget(
  activeIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | null {
  if (focusableCount <= 0) return null
  if (activeIndex < 0) return backwards ? focusableCount - 1 : 0
  if (backwards && activeIndex === 0) return focusableCount - 1
  if (!backwards && activeIndex === focusableCount - 1) return 0
  return null
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  )
}

export function useDialogFocus(options: {
  active?: boolean
  containerRef: RefObject<HTMLElement>
  initialFocusRef?: RefObject<HTMLElement>
  returnFocusRef?: RefObject<HTMLElement>
  onEscape: () => void
}) {
  const { active = true, containerRef, initialFocusRef, returnFocusRef, onEscape } = options
  const onEscapeRef = useRef(onEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!active || typeof document === 'undefined') return
    const container = containerRef.current
    if (!container) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const returnFocus = returnFocusRef?.current ?? previousFocus
    const focusFrame = requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container
      target.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(container)
      if (focusable.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const targetIndex = getDialogFocusWrapTarget(activeIndex, focusable.length, event.shiftKey)
      if (targetIndex == null) return
      event.preventDefault()
      focusable[targetIndex]?.focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown, true)
      queueMicrotask(() => {
        if (container.isConnected) return
        if (returnFocus?.isConnected) returnFocus.focus()
      })
    }
  }, [active, containerRef, initialFocusRef, returnFocusRef])
}
