import type { ChatMessageRecord } from '../../electron/types'
import { ORB_MESSAGE_MENU_RADIUS, ORB_MESSAGE_MENU_WIDTH } from './orbMessageMenuUtils'

export type OrbMessageMenuProps = {
  message: ChatMessageRecord
  left: number
  top: number
  onCopyAssistantText: () => void
  onEdit: () => void
  onResend: () => void
  onDeleteMessage: () => void
  onDeleteTurn: () => void
}

export function OrbMessageMenu(props: OrbMessageMenuProps) {
  return (
    <div
      className="ndp-orbapp-msgmenu"
      data-orb-msgmenu="true"
      style={{
        left: props.left,
        top: props.top,
        width: ORB_MESSAGE_MENU_WIDTH,
        borderRadius: ORB_MESSAGE_MENU_RADIUS,
      }}
    >
      {props.message.role === 'assistant' ? (
        <button className="ndp-orbapp-msgmenu-item" onClick={props.onCopyAssistantText}>
          复制正文
        </button>
      ) : null}
      <button className="ndp-orbapp-msgmenu-item" onClick={props.onEdit}>
        编辑
      </button>
      <button className="ndp-orbapp-msgmenu-item" onClick={props.onResend}>
        重新生成
      </button>
      <button className="ndp-orbapp-msgmenu-item" onClick={props.onDeleteMessage}>
        删除此条
      </button>
      <button className="ndp-orbapp-msgmenu-item" onClick={props.onDeleteTurn}>
        删除本轮
      </button>
    </div>
  )
}
