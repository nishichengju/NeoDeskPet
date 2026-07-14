import { useCallback, useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { applyOrbImageViewerWheelScale, moveOrbImageViewerIndex } from './orbImageViewerUtils'

export type OrbImageViewerItem = {
  src: string
  title: string
}

export type OrbImageViewerProps = {
  items: OrbImageViewerItem[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}

export function OrbImageViewer({ items, index, onIndexChange, onClose }: OrbImageViewerProps) {
  const [scale, setScale] = useState(1)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const item = items[index]

  useDialogFocus({
    active: Boolean(item),
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  })

  useEffect(() => {
    setScale(1)
  }, [index, item?.src])

  const move = useCallback(
    (offset: number) => {
      if (items.length <= 1) return
      onIndexChange(moveOrbImageViewerIndex(index, offset, items.length))
    },
    [index, items.length, onIndexChange],
  )

  useEffect(() => {
    if (!item) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        move(-1)
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') {
        event.preventDefault()
        move(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, move])

  if (!item) return null

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    setScale((current) => applyOrbImageViewerWheelScale(current, event.deltaY))
  }

  return (
    <div className="ndp-orbimg-viewer" data-orb-nodrag="true" onClick={onClose}>
      <div
        ref={dialogRef}
        className="ndp-orbimg-viewer-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ndp-orb-image-viewer-title"
        tabIndex={-1}
        data-orb-nodrag="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ndp-orbimg-viewer-toolbar" data-orb-nodrag="true">
          <div id="ndp-orb-image-viewer-title" className="ndp-orbimg-viewer-title" title={item.title}>
            {item.title || `图片 ${index + 1}`}
          </div>
          <div className="ndp-orbimg-viewer-meta">
            {index + 1}/{items.length}
          </div>
          <div className="ndp-orbimg-viewer-tools">
            <button type="button" className="ndp-orbimg-viewer-btn" onClick={() => setScale(1)} title="重置缩放" data-orb-nodrag="true">
              1:1
            </button>
            <button ref={closeButtonRef} type="button" className="ndp-orbimg-viewer-btn" onClick={onClose} title="关闭" data-orb-nodrag="true">
              关闭
            </button>
          </div>
        </div>
        <div className="ndp-orbimg-viewer-stage" data-orb-nodrag="true" onWheel={onWheel}>
          {items.length > 1 ? (
            <button type="button" className="ndp-orbimg-viewer-nav" aria-label="上一张图片" onClick={() => move(-1)} title="上一张" data-orb-nodrag="true">
              ◀
            </button>
          ) : (
            <div />
          )}
          <img
            className="ndp-orbimg-viewer-img"
            src={item.src}
            alt={item.title || 'image'}
            style={{ transform: `scale(${scale})` }}
          />
          {items.length > 1 ? (
            <button type="button" className="ndp-orbimg-viewer-nav" aria-label="下一张图片" onClick={() => move(1)} title="下一张" data-orb-nodrag="true">
              ▶
            </button>
          ) : (
            <div />
          )}
        </div>
        <div className="ndp-orbimg-viewer-tip">滚轮缩放 · ←/→ 或 A/D 切换 · Esc 关闭</div>
      </div>
    </div>
  )
}
