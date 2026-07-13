import { useEffect, useRef, useState } from 'react'

export type ImageViewerItem = {
  src: string
  title: string
}

export type ImageViewerProps = {
  items: ImageViewerItem[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}

export function ImageViewer({ items, index, onIndexChange, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ pointerId: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const item = items[index]

  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onIndexChange(Math.max(0, index - 1))
      if (event.key === 'ArrowRight') onIndexChange(Math.min(items.length - 1, index + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onClose, onIndexChange])

  if (!item) return null

  const reset = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  return (
    <div className="ndp-image-viewer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="ndp-image-viewer-shell">
        <div className="ndp-image-viewer-toolbar">
          <div className="ndp-image-viewer-title" title={item.title}>{item.title}</div>
          <div className="ndp-image-viewer-meta">{index + 1} / {items.length} · {Math.round(scale * 100)}%</div>
          <div className="ndp-image-viewer-tools">
            <button className="ndp-image-viewer-btn" onClick={() => setScale((value) => Math.max(0.2, Number((value - 0.2).toFixed(2))))}>-</button>
            <button className="ndp-image-viewer-btn" onClick={reset}>重置</button>
            <button className="ndp-image-viewer-btn" onClick={() => setScale((value) => Math.min(8, Number((value + 0.2).toFixed(2))))}>+</button>
            <button className="ndp-image-viewer-btn" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div
          className="ndp-image-viewer-stage"
          onWheel={(event) => {
            event.preventDefault()
            const delta = event.deltaY < 0 ? 0.15 : -0.15
            setScale((value) => Math.max(0.2, Math.min(8, Number((value + delta).toFixed(2)))))
          }}
        >
          <button className="ndp-image-viewer-nav" disabled={index <= 0} onClick={() => onIndexChange(Math.max(0, index - 1))}>‹</button>
          <div
            className="ndp-image-viewer-canvas"
            onDoubleClick={reset}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                ox: offset.x,
                oy: offset.y,
              }
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId) return
              setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y })
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
            }}
            onPointerCancel={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
            }}
          >
            <img
              className="ndp-image-viewer-img"
              src={item.src}
              alt={item.title}
              draggable={false}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            />
          </div>
          <button
            className="ndp-image-viewer-nav"
            disabled={index >= items.length - 1}
            onClick={() => onIndexChange(Math.min(items.length - 1, index + 1))}
          >
            ›
          </button>
        </div>
        <div className="ndp-image-viewer-tip">滚轮缩放，按住左键拖动，双击重置，Esc 关闭</div>
      </div>
    </div>
  )
}
