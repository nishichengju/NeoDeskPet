import type { ChatMessageBlock, ChatMessageRecord } from '../../../electron/types'
import { DeferredMarkdownMessage } from '../../components/DeferredMarkdownMessage'
import { splitTextIntoTtsSegments } from '../../services/textSegmentation'
import { normalizeInterleavedTextSegment } from '../../utils/chatMessages'
import { trimTrailingCommaForSegment } from '../../utils/ttsText'
import type { MouseEvent, ReactNode, RefObject } from 'react'

export type ChatMessageBodyProps = {
  message: ChatMessageRecord
  blocks: ChatMessageBlock[]
  avatar?: string
  segmentedActive: boolean
  revealCount?: number
  isEditing: boolean
  editingContent: string
  editingTextareaRef: RefObject<HTMLTextAreaElement>
  attachments?: ReactNode
  overlay?: ReactNode
  renderToolUse: (taskId: string, runId?: string) => ReactNode
  onEditingContentChange: (value: string) => void
  onSaveEdit: () => void | Promise<void>
  onCancelEdit: () => void
  onContextMenu: (event: MouseEvent, messageId: string) => void
  onPickAvatar: (kind: 'user' | 'assistant') => void
}

export function ChatMessageBody({
  message,
  blocks,
  avatar,
  segmentedActive,
  revealCount,
  isEditing,
  editingContent,
  editingTextareaRef,
  attachments,
  overlay,
  renderToolUse,
  onEditingContentChange,
  onSaveEdit,
  onCancelEdit,
  onContextMenu,
  onPickAvatar,
}: ChatMessageBodyProps) {
  const isUser = message.role === 'user'
  const hasToolBlock = !isUser && blocks.some((block) => block.type === 'tool_use')

  if (segmentedActive && !hasToolBlock && !isEditing) {
    const segments = splitTextIntoTtsSegments(message.content, { lang: 'zh', textSplitMethod: 'cut5' })
    const effectiveReveal = typeof revealCount === 'number' ? revealCount : segments.length
    const visible = segments.slice(0, Math.max(0, Math.min(segments.length, effectiveReveal)))
    if (visible.length === 0) return null

    return (
      <>
        <div
          className="ndp-msg-row ndp-msg-row-pet"
          data-message-id={message.id}
          onContextMenu={(event) => onContextMenu(event, message.id)}
          title={new Date(message.createdAt).toLocaleString()}
        >
          <button
            type="button"
            className="ndp-avatar ndp-avatar-clickable"
            onClick={() => onPickAvatar('assistant')}
            title="点击更换头像"
            aria-label="更换助手头像"
          >
            {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map((segment, index) => {
              const displaySegment = trimTrailingCommaForSegment(segment)
              const isLast = index === visible.length - 1
              return (
                <div key={`${message.id}-${index}`} className="ndp-msg ndp-msg-pet">
                  <div className="ndp-msg-content">
                    {displaySegment}
                    {isLast ? attachments : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {overlay}
      </>
    )
  }

  return (
    <>
      <div
        className={`ndp-msg-row ${isUser ? 'ndp-msg-row-user' : 'ndp-msg-row-pet'}`}
        data-message-id={message.id}
        onContextMenu={(event) => onContextMenu(event, message.id)}
        title={new Date(message.createdAt).toLocaleString()}
      >
        {!isUser ? (
          <button
            type="button"
            className="ndp-avatar ndp-avatar-clickable"
            onClick={() => onPickAvatar('assistant')}
            title="点击更换头像"
            aria-label="更换助手头像"
          >
            {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
          </button>
        ) : null}

        <div className={`ndp-msg ndp-msg-${isUser ? 'user' : 'pet'}`}>
          {isEditing ? (
            <div className="ndp-msg-edit">
              <textarea
                ref={editingTextareaRef}
                className="ndp-inline-textarea"
                value={editingContent}
                rows={1}
                onChange={(event) => onEditingContentChange(event.target.value)}
                onInput={(event) => {
                  const element = event.currentTarget
                  element.style.height = '0px'
                  element.style.height = `${element.scrollHeight}px`
                }}
              />
              <div className="ndp-msg-edit-actions">
                <button className="ndp-btn" onClick={onSaveEdit}>
                  保存
                </button>
                <button className="ndp-btn" onClick={onCancelEdit}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="ndp-msg-content">
              {isUser ? message.content : renderAssistantContent(message, blocks, renderToolUse)}
              {attachments}
            </div>
          )}
        </div>

        {isUser ? (
          <button
            type="button"
            className="ndp-avatar ndp-avatar-clickable"
            onClick={() => onPickAvatar('user')}
            title="点击更换头像"
            aria-label="更换用户头像"
          >
            {avatar ? <img src={avatar} alt="user" /> : <span>我</span>}
          </button>
        ) : null}
      </div>
      {overlay}
    </>
  )
}

function renderAssistantContent(
  message: ChatMessageRecord,
  blocks: ChatMessageBlock[],
  renderToolUse: (taskId: string, runId?: string) => ReactNode,
): ReactNode {
  if (blocks.length === 0) {
    const text = normalizeInterleavedTextSegment(String(message.content ?? ''))
    return text ? <DeferredMarkdownMessage text={text} /> : null
  }

  let toolSeen = 0
  let statusSeen = 0
  let textSeen = 0
  return blocks.map((block) => {
    if (block.type === 'text') {
      const text = normalizeInterleavedTextSegment(String(block.text ?? ''))
      if (!text) return null
      const key = `${message.id}-text-${toolSeen}-${textSeen++}`
      return <DeferredMarkdownMessage key={key} text={text} />
    }
    if (block.type === 'status') {
      const text = String(block.text ?? '').trim()
      if (!text) return null
      return (
        <div key={`${message.id}-status-${statusSeen++}`} className="ndp-muted">
          {text}
        </div>
      )
    }
    if (block.type === 'tool_use') {
      const runId = block.runId
      const key = runId?.trim() ? `${message.id}-tool-${runId}` : `${message.id}-tool-${block.taskId}-${toolSeen}`
      toolSeen += 1
      return <div key={key}>{renderToolUse(block.taskId, runId)}</div>
    }
    return null
  })
}
