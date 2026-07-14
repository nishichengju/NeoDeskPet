import type { CSSProperties, MouseEvent } from 'react'
import {
  ORB_HISTORY_POPOVER_RADIUS,
  ORB_HISTORY_POPOVER_WIDTH,
  type OrbHistoryItem,
} from './orbHistoryUtils'
import { getLiveRegionProps } from '../components/liveRegion'

export type OrbHistoryPopoverProps = {
  left: number
  top: number
  arrowX: number
  loading: boolean
  sessions: OrbHistoryItem[]
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onOpenAll: () => void
}

export function OrbHistoryPopover(props: OrbHistoryPopoverProps) {
  const style = {
    left: props.left,
    top: props.top,
    width: ORB_HISTORY_POPOVER_WIDTH,
    borderRadius: ORB_HISTORY_POPOVER_RADIUS,
    '--ndp-orbapp-popover-arrow-x': `${props.arrowX}px`,
  } as CSSProperties

  const deleteSession = (event: MouseEvent<HTMLButtonElement>, sessionId: string) => {
    event.preventDefault()
    event.stopPropagation()
    props.onDelete(sessionId)
  }

  return (
    <div className="ndp-orbapp-popover" data-orb-popover="true" style={style}>
      {props.sessions.length > 0 ? (
        props.sessions.map((session) => (
          <div key={session.id} className="ndp-orbapp-popover-row">
            <button
              className="ndp-orbapp-popover-item ndp-orbapp-popover-item-main"
              onClick={() => props.onSelect(session.id)}
              title={session.name}
            >
              <span className="ndp-orbapp-popover-icon">🕒</span>
              <span className="ndp-orbapp-popover-text">
                {session.name || '未命名会话'}
                <span className="ndp-orbapp-popover-count">{session.messageCount > 0 ? String(session.messageCount) : '空'}</span>
              </span>
            </button>
            <button
              className="ndp-orbapp-popover-action"
              aria-label="删除该会话"
              title="删除该会话"
              onClick={(event) => deleteSession(event, session.id)}
            >
              ×
            </button>
          </div>
        ))
      ) : props.loading ? (
        <div className="ndp-orbapp-popover-empty" {...getLiveRegionProps('polite')}>加载中</div>
      ) : (
        <div className="ndp-orbapp-popover-empty">暂无历史对话</div>
      )}
      <div className="ndp-orbapp-popover-divider" />
      <button className="ndp-orbapp-popover-item" onClick={props.onOpenAll}>
        <span className="ndp-orbapp-popover-icon">→</span>
        <span className="ndp-orbapp-popover-text">查看全部历史对话</span>
      </button>
    </div>
  )
}
