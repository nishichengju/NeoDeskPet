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
  const pointerOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [localPos, setLocalPos] = useState<ContextOrbPosition>(position)
  const localPosRef = useRef<ContextOrbPosition>(position)

  useEffect(() => {
    if (dragging) return
    const next = { x: positionX, y: positionY }
    localPosRef.current = next
    setLocalPos(next)
  }, [dragging, positionX, positionY])

  const clampPct = (v: number) => Math.max(0, Math.min(100, v))

  const clearDraggingState = useCallback((opts?: { restoreFromProps?: boolean }) => {
    draggingRef.current = false
    setDragging(false)
    if (opts?.restoreFromProps !== false) {
      const next = { x: positionX, y: positionY }
      localPosRef.current = next
      setLocalPos(next)
    }
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
        if (draggingRef.current) clearDraggingState()
      }, 0)
    }
    const handleBlur = () => clearDraggingState()
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') clearDraggingState()
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
  }, [clearDraggingState, dragging])

  useEffect(() => {
    if (!interactionDisabled) return
    if (draggingRef.current) clearDraggingState()
  }, [clearDraggingState, interactionDisabled])

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
    const orbRect = orbRef.current?.getBoundingClientRect()
    if (orbRect) {
      pointerOffsetRef.current = {
        x: e.clientX - (orbRect.left + orbRect.width / 2),
        y: e.clientY - (orbRect.top + orbRect.height / 2),
      }
    } else {
      pointerOffsetRef.current = { x: 0, y: 0 }
    }
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
    const centerX = clientX - pointerOffsetRef.current.x
    const centerY = clientY - pointerOffsetRef.current.y
    const x = clampPct(((centerX - rect.left) / rect.width) * 100)
    const y = clampPct(((centerY - rect.top) / rect.height) * 100)
    const next = { x, y }
    localPosRef.current = next
    setLocalPos(next)
    return next
  }

  const onPointerMove = (e: PointerEvent) => {
    if (interactionDisabled) return
    if (!draggingRef.current) return
    e.preventDefault()
    e.stopPropagation()
    updateFromClientPoint(e.clientX, e.clientY)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (interactionDisabled) {
      clearDraggingState()
      return
    }
    if (!draggingRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const nextFromPointer = updateFromClientPoint(e.clientX, e.clientY)
    const stable = nextFromPointer ?? localPosRef.current
    const next = { x: clampPct(stable.x), y: clampPct(stable.y) }
    localPosRef.current = next
    setLocalPos(next)
    onPositionChange?.(next)
    clearDraggingState({ restoreFromProps: false })
  }

  const onPointerCancel = (e: PointerEvent) => {
    if (interactionDisabled) {
      clearDraggingState()
      return
    }
    if (!draggingRef.current) return
    e.preventDefault()
    e.stopPropagation()
    clearDraggingState()
  }

  return (
    <div
      ref={orbRef}
      className={`ndp-context-orb${interactionDisabled ? ' ndp-context-orb--window-dragging' : ''}`}
      data-no-window-drag="true"
      style={
        {
          left: `calc(${localPos.x}% - 8px)`,
          top: `calc(${localPos.y}% - 8px)`,
          ['--ndp-context-pct' as unknown as string]: `${pct}%`,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => {
        if (!draggingRef.current) return
        clearDraggingState()
      }}
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
