import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEventHandler,
  RefObject,
} from 'react'
import type { NeoDeskPetApi } from '../neoDeskPetApi'
import { OrbImagePreview } from './OrbMessageMedia'

export type OrbPendingAttachment = {
  id: string
  kind: 'image' | 'video'
  path: string
  resourceId?: string
  filename: string
  previewDataUrl?: string
}

export type OrbBarViewProps = {
  api: NeoDeskPetApi | null
  inputRef: RefObject<HTMLInputElement>
  input: string
  pendingAttachments: OrbPendingAttachment[]
  sending: boolean
  onBarMouseDown: MouseEventHandler<HTMLDivElement>
  onBarMouseUp: MouseEventHandler<HTMLDivElement>
  onNewConversation: () => void
  onToggleHistory: (anchorCenterX: number) => void
  onRemoveAttachment: (id: string) => void
  onInputChange: (value: string) => void
  onMediaFiles: (files: File[]) => void
  onInvalidDrop: () => void
  onSubmit: () => void
  onClose: () => void
}

function mediaFiles(files: Iterable<File> | ArrayLike<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'))
}

function handlePaste(event: ReactClipboardEvent<HTMLInputElement>, onMediaFiles: (files: File[]) => void) {
  const transfer = event.clipboardData
  if (!transfer) return

  const files = mediaFiles(transfer.files ?? [])
  if (files.length > 0) {
    event.preventDefault()
    onMediaFiles(files)
    return
  }

  const items = Array.from(transfer.items ?? []).filter(
    (item) => item.type.startsWith('image/') || item.type.startsWith('video/'),
  )
  if (items.length === 0) return

  event.preventDefault()
  onMediaFiles(items.map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)))
}

function handleDrop(
  event: ReactDragEvent<HTMLInputElement>,
  onMediaFiles: (files: File[]) => void,
  onInvalidDrop: () => void,
) {
  event.preventDefault()
  const files = mediaFiles(event.dataTransfer?.files ?? [])
  if (files.length === 0) {
    onInvalidDrop()
    return
  }
  onMediaFiles(files)
}

function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, onSubmit: () => void, onClose: () => void) {
  if (event.key === 'Enter' && !event.shiftKey) {
    if (event.repeat || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSubmit()
  }
  if (event.key === 'Escape') onClose()
}

export function OrbBarView(props: OrbBarViewProps) {
  return (
    <div className="ndp-orbapp-bar-frame">
      <div className="ndp-orbapp-bar-pill" aria-hidden="true">
        <div className="ndp-orbapp-ball-icon"></div>
      </div>
      <div className="ndp-orbapp-bar" title="输入栏" onMouseDown={props.onBarMouseDown} onMouseUp={props.onBarMouseUp}>
        <div className="ndp-orbapp-bar-left" data-orb-nodrag="true">
          <button className="ndp-orbapp-btn" onClick={props.onNewConversation} title="新对话">
            ＋
          </button>
          <button
            className="ndp-orbapp-btn"
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              props.onToggleHistory(rect.left + rect.width / 2)
            }}
            title="历史对话"
            data-orb-noclose="true"
          >
            🕒
          </button>

          {props.pendingAttachments.length > 0 ? (
            <div
              className="ndp-orbapp-pending"
              data-orb-nodrag="true"
              title={`已添加附件：${props.pendingAttachments.length}个`}
            >
              {props.pendingAttachments.slice(0, 3).map((attachment) => {
                const label = attachment.filename || attachment.kind
                return (
                  <button
                    key={attachment.id}
                    type="button"
                    className="ndp-orbapp-pending-item"
                    onClick={() => props.onRemoveAttachment(attachment.id)}
                    title={`移除${label}`}
                  >
                    {attachment.kind === 'video' ? (
                      <span className="ndp-orbapp-pending-video">🎞</span>
                    ) : attachment.previewDataUrl ? (
                      <img className="ndp-orbapp-pending-img" src={attachment.previewDataUrl} alt={label} />
                    ) : (
                      <OrbImagePreview
                        api={props.api}
                        className="ndp-orbapp-pending-img"
                        imagePath={attachment.path}
                        resourceId={attachment.resourceId}
                        alt={label}
                      />
                    )}
                    <span className="ndp-orbapp-pending-x">×</span>
                  </button>
                )
              })}
              {props.pendingAttachments.length > 3 ? (
                <span className="ndp-orbapp-pending-more">+{props.pendingAttachments.length - 3}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <input
          ref={props.inputRef}
          className="ndp-orbapp-input"
          data-orb-nodrag="true"
          value={props.input}
          onChange={(event) => props.onInputChange(event.target.value)}
          onPaste={(event) => handlePaste(event, props.onMediaFiles)}
          onDrop={(event) => handleDrop(event, props.onMediaFiles, props.onInvalidDrop)}
          onDragOver={(event) => event.preventDefault()}
          onKeyDown={(event) => handleKeyDown(event, props.onSubmit, props.onClose)}
          placeholder="描述任务需求（可拖拽图片/视频或粘贴截图）"
        />

        <div className="ndp-orbapp-bar-right" data-orb-nodrag="true">
          <button
            className="ndp-orbapp-send"
            onClick={props.onSubmit}
            disabled={!props.input.trim() && props.pendingAttachments.length === 0 && !props.sending}
            title={props.sending ? '点击取消' : '发送'}
          >
            ▶
          </button>
        </div>
      </div>
    </div>
  )
}
