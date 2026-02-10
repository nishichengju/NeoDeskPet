import './orb.css'
import { useCallback, useEffect, useMemo, type CSSProperties } from 'react'
import { getApi } from '../neoDeskPetApi'

const MENU_WIDTH = 240
const MENU_RADIUS = 16

export function OrbMenuWindow(props: { api: ReturnType<typeof getApi> }) {
  const api = props.api

  const dockSide: 'left' | 'right' = useMemo(() => {
    try {
      const winCenterX = window.screenX + window.outerWidth / 2
      const screenCenterX = window.screen.width / 2
      return winCenterX < screenCenterX ? 'left' : 'right'
    } catch {
      return 'left'
    }
  }, [])

  const arrowX = dockSide === 'left' ? 22 : MENU_WIDTH - 22

  const popoverStyle = useMemo(() => {
    return {
      width: MENU_WIDTH,
      borderRadius: MENU_RADIUS,
      position: 'relative',
      '--ndp-orbapp-popover-arrow-x': `${arrowX}px`,
    } as CSSProperties
  }, [arrowX])

  const closeSelf = useCallback(() => void api?.closeCurrent().catch(() => undefined), [api])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      closeSelf()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSelf])

  return (
    <div
      className="ndp-orbapp-root"
      style={{
        padding: 12,
        paddingTop: 18,
        paddingBottom: 12,
        boxSizing: 'border-box',
        justifyContent: 'flex-start',
      }}
      onMouseDown={(e) => {
        // 点击空白区域关闭（点击菜单项由按钮本身处理）
        if ((e.target as HTMLElement | null)?.closest?.('[data-orb-popover="true"]')) return
        closeSelf()
      }}
    >
      <div className="ndp-orbapp-popover" data-orb-popover="true" style={popoverStyle}>
        <button
          className="ndp-orbapp-popover-item"
          onClick={() => {
            void api?.openSettings().catch(() => undefined)
            closeSelf()
          }}
          title="设置"
        >
          <span className="ndp-orbapp-popover-icon">⚙</span>
          <span className="ndp-orbapp-popover-text">设置</span>
        </button>

        <button
          className="ndp-orbapp-popover-item"
          onClick={() => {
            void api?.setDisplayMode('live2d').catch(() => undefined)
            closeSelf()
          }}
          title="切换到 Live2D 桌宠"
        >
          <span className="ndp-orbapp-popover-icon">↺</span>
          <span className="ndp-orbapp-popover-text">切换到 Live2D 桌宠</span>
        </button>

        <button
          className="ndp-orbapp-popover-item"
          onClick={() => {
            void api?.setDisplayMode('hidden').catch(() => undefined)
            closeSelf()
          }}
          title="隐藏（仅托盘）"
        >
          <span className="ndp-orbapp-popover-icon">⨯</span>
          <span className="ndp-orbapp-popover-text">隐藏（仅托盘）</span>
        </button>

        <div className="ndp-orbapp-popover-divider" />

        <button
          className="ndp-orbapp-popover-item"
          onClick={() => {
            void api?.quit().catch(() => undefined)
            closeSelf()
          }}
          title="退出"
        >
          <span className="ndp-orbapp-popover-icon">⏻</span>
          <span className="ndp-orbapp-popover-text">退出</span>
        </button>
      </div>
    </div>
  )
}
