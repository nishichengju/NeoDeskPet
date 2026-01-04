import type { CSSProperties, PointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextUsageSnapshot } from '../../electron/types'
import './ContextUsageOrb.css'

export type ContextOrbPosition = { x: number; y: number } // percent: 0-100

export function ContextUsageOrb(props: {
  enabled: boolean
  usage: ContextUsageSnapshot | null
  position: ContextOrbPosition
  onPositionChange?: (next: ContextOrbPosition) => void
  title?: string
  interactionDisabled?: boolean
}) {
  const { enabled, usage, position, onPositionChange } = props
  const title = props.title ?? 'Context window:'
  const interactionDisabled = props.interactionDisabled ?? false
  const positionX = position.x
  const positionY = position.y
  const orbRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const dragPointerIdRef = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [localPos, setLocalPos] = useState<ContextOrbPosition>(position)

  useEffect(() => {
    if (dragging) return
    setLocalPos({ x: positionX, y: positionY })
  }, [dragging, positionX, positionY])

  const clampPct = (v: number) => Math.max(0, Math.min(100, v))

  const resetDragging = useCallback(() => {
    draggingRef.current = false
    setDragging(false)
    setLocalPos({ x: positionX, y: positionY })
    const pointerId = dragPointerIdRef.current
    dragPointerIdRef.current = null
    if (pointerId != null) {
      try {
        orbRef.current?.releasePointerCapture(pointerId)
      } catch (_) {
        /* ignore */
      }
    }
  }, [positionX, positionY])

  useEffect(() => {
    if (!dragging) return

    const handleGlobalPointerUp = () => {
      window.setTimeout(() => {
        if (draggingRef.current) resetDragging()
      }, 0)
    }
    const handleBlur = () => resetDragging()
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') resetDragging()
    }

    window.addEventListener('pointerup', handleGlobalPointerUp)
    window.addEventListener('pointercancel', handleGlobalPointerUp)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp)
      window.removeEventListener('pointercancel', handleGlobalPointerUp)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [dragging, resetDragging])

  useEffect(() => {
    if (!interactionDisabled) return
    if (draggingRef.current) resetDragging()
  }, [interactionDisabled, resetDragging])

  const pct = useMemo(() => {
    const used = usage?.usedTokens ?? 0
    const max = usage?.maxContextTokens ?? 0
    if (!max || max <= 0) return 0
    return clampPct(Math.round((used / max) * 100))
  }, [usage?.maxContextTokens, usage?.usedTokens])

  const formatK = (n: number): string => {
    const v = Math.max(0, Math.floor(n))
    if (v >= 1000000) return `${Math.round(v / 100000) / 10}m`
    if (v >= 1000) return `${Math.round(v / 1000)}k`
    return String(v)
  }

  const usedText = useMemo(() => {
    const used = usage?.usedTokens ?? 0
    const max = usage?.maxContextTokens ?? 0
    return `${formatK(used)} / ${formatK(max)} tokens used`
  }, [usage?.maxContextTokens, usage?.usedTokens])

  if (!enabled) return null

  const onPointerDown = (e: PointerEvent) => {
    if (interactionDisabled) return
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    setDragging(true)
    try {
      orbRef.current?.setPointerCapture(e.pointerId)
      dragPointerIdRef.current = e.pointerId
    } catch (_) {
      /* ignore */
    }
  }

  const updateFromClientPoint = (clientX: number, clientY: number) => {
    const el = orbRef.current?.parentElement
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return
    const x = clampPct(((clientX - rect.left) / rect.width) * 100)
    const y = clampPct(((clientY - rect.top) / rect.height) * 100)
    setLocalPos({ x, y })
  }

  const onPointerMove = (e: PointerEvent) => {
    if (interactionDisabled) return
    if (!dragging) return
    e.preventDefault()
    e.stopPropagation()
    updateFromClientPoint(e.clientX, e.clientY)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (interactionDisabled) {
      resetDragging()
      return
    }
    if (!dragging) return
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = false
    setDragging(false)
    const next = { x: clampPct(localPos.x), y: clampPct(localPos.y) }
    onPositionChange?.(next)
    try {
      orbRef.current?.releasePointerCapture(e.pointerId)
    } catch (_) {
      /* ignore */
    }
    dragPointerIdRef.current = null
  }

  const onPointerCancel = (e: PointerEvent) => {
    if (interactionDisabled) {
      resetDragging()
      return
    }
    if (!dragging) return
    e.preventDefault()
    e.stopPropagation()
    resetDragging()
    try {
      orbRef.current?.releasePointerCapture(e.pointerId)
    } catch (_) {
      /* ignore */
    }
    dragPointerIdRef.current = null
  }

  return (
    <div
      ref={orbRef}
      className="ndp-context-orb"
      data-no-window-drag="true"
      style={
        {
          left: `${localPos.x}%`,
          top: `${localPos.y}%`,
          ['--ndp-context-pct' as unknown as string]: `${pct}%`,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => resetDragging()}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseUp={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="ndp-context-orb-ring" />
      <div className="ndp-context-orb-inner" />
      {hovered ? (
        <div className="ndp-context-orb-tooltip">
          <div className="ndp-context-orb-tooltip-title">{title}</div>
          <div className="ndp-context-orb-tooltip-line">
            <span className="ndp-context-orb-tooltip-strong">{pct}%</span> full
          </div>
          <div className="ndp-context-orb-tooltip-line">{usedText}</div>
        </div>
      ) : null}
    </div>
  )
}
