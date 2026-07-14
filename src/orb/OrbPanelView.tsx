import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import type { ChatMessageRecord, ChatSessionSummary } from '../../electron/types'
import { DeferredMarkdownMessage } from '../components/DeferredMarkdownMessage'
import { getLiveRegionProps } from '../components/liveRegion'

export type OrbPanelViewProps = {
  sessionName?: string
  summary: ChatSessionSummary | null
  loading: boolean
  error: string | null
  messages: ChatMessageRecord[]
  hiddenMessageCount: number
  listRef: RefObject<HTMLDivElement>
  endRef: RefObject<HTMLDivElement>
  editingMessageId: string | null
  editingMessageContent: string
  renderAssistantMessage: (message: ChatMessageRecord) => ReactNode
  renderAttachments: (message: ChatMessageRecord) => ReactNode
  onOpenFullChat: () => void
  onLoadEarlierMessages: () => void
  onMessageContextMenu: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void
  onEditingMessageContentChange: (value: string) => void
  onSaveEdit: (resend: boolean) => void
  onCancelEdit: () => void
}

export function OrbPanelView(props: OrbPanelViewProps) {
  const title = props.sessionName || '未命名会话'

  return (
    <div className="ndp-orbpanel">
      <div className="ndp-orbpanel-header" data-orb-nodrag="true">
        <div className="ndp-orbpanel-title" title={title}>
          {title}
        </div>
        <div className="ndp-orbpanel-actions">
          {props.summary ? (
            <div className="ndp-orbpanel-meta">
              {(props.summary.messageCount ?? 0) > 0 ? `${props.summary.messageCount}条` : '空对话'}
            </div>
          ) : null}
          <button className="ndp-orbpanel-action" onClick={props.onOpenFullChat} title="打开完整聊天窗口">
            ↗
          </button>
        </div>
      </div>

      <div className="ndp-orbpanel-body" ref={props.listRef} data-orb-nodrag="true">
        {props.loading ? <div className="ndp-orbpanel-empty" {...getLiveRegionProps('polite')}>加载中</div> : null}
        {props.error ? <div className="ndp-orbpanel-empty ndp-orbpanel-empty-error" {...getLiveRegionProps('assertive')}>{props.error}</div> : null}
        {!props.loading && !props.error && props.messages.length === 0 ? (
          <div className="ndp-orbpanel-empty">还没有消息</div>
        ) : null}

        {props.hiddenMessageCount > 0 ? (
          <button type="button" className="ndp-message-history-more" onClick={props.onLoadEarlierMessages}>
            加载更早消息（还有 {props.hiddenMessageCount} 条）
          </button>
        ) : null}

        {props.messages.map((message) => {
          const isUser = message.role === 'user'
          const isEditing = props.editingMessageId === message.id
          return (
            <div
              key={message.id}
              className={isUser ? 'ndp-orbpanel-msg ndp-orbpanel-msg-user' : 'ndp-orbpanel-msg ndp-orbpanel-msg-assistant'}
              data-message-id={message.id}
              onContextMenu={(event) => props.onMessageContextMenu(event, message.id)}
            >
              {isEditing ? (
                <div className="ndp-orbpanel-edit" data-orb-nodrag="true">
                  <textarea
                    className="ndp-orbpanel-edit-textarea"
                    value={props.editingMessageContent}
                    onChange={(event) => props.onEditingMessageContentChange(event.target.value)}
                    rows={3}
                    data-orb-nodrag="true"
                  />
                  <div className="ndp-orbpanel-edit-actions" data-orb-nodrag="true">
                    <button className="ndp-orbpanel-edit-btn" onClick={() => props.onSaveEdit(false)} data-orb-nodrag="true">
                      保存
                    </button>
                    {isUser ? (
                      <button className="ndp-orbpanel-edit-btn" onClick={() => props.onSaveEdit(true)} data-orb-nodrag="true">
                        保存并重发
                      </button>
                    ) : null}
                    <button
                      className="ndp-orbpanel-edit-btn ndp-orbpanel-edit-btn-ghost"
                      onClick={props.onCancelEdit}
                      data-orb-nodrag="true"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : isUser ? (
                <DeferredMarkdownMessage text={String(message.content ?? '')} />
              ) : (
                props.renderAssistantMessage(message)
              )}
              {props.renderAttachments(message)}
            </div>
          )
        })}
        <div ref={props.endRef} />
      </div>
    </div>
  )
}
