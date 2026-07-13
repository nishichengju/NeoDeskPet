import { LocalVideo, MmvectorImagePreview } from '../../components/MediaPreviews'
import type { NeoDeskPetApi } from '../../neoDeskPetApi'
import { useEffect, useRef } from 'react'
import { getComposerMediaKind } from './composerMedia'

export type PendingChatAttachment = {
  id: string
  kind: 'image' | 'video'
  path: string
  resourceId?: string
  filename: string
  previewDataUrl?: string
}

export type ChatComposerProps = {
  api: NeoDeskPetApi | null
  input: string
  pendingAttachments: PendingChatAttachment[]
  attachmentMenuOpen: boolean
  isAssistantOutputting: boolean
  onInputChange: (value: string) => void
  onAttachmentMenuOpenChange: (open: boolean) => void
  onReadImageFile: (file: File) => void | Promise<void>
  onReadVideoFile: (file: File) => void | Promise<void>
  onRemoveAttachment: (id: string) => void
  onInvalidDrop: (message: string) => void
  onSend: () => void | Promise<void>
  onStop: () => void
}

export function ChatComposer({
  api,
  input,
  pendingAttachments,
  attachmentMenuOpen,
  isAssistantOutputting,
  onInputChange,
  onAttachmentMenuOpenChange,
  onReadImageFile,
  onReadVideoFile,
  onRemoveAttachment,
  onInvalidDrop,
  onSend,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 152)}px`
  }, [input])

  const readFiles = (files: File[]) => {
    for (const file of files) {
      const kind = getComposerMediaKind(file.type)
      if (kind === 'image') void onReadImageFile(file)
      if (kind === 'video') void onReadVideoFile(file)
    }
  }

  return (
    <>
      <footer className="ndp-chat-input">
        {pendingAttachments.length > 0 ? (
          <div className="ndp-input-previews" onMouseDown={(event) => event.stopPropagation()}>
            {pendingAttachments.map((attachment) => (
              <div key={attachment.id} className="ndp-input-preview">
                {attachment.kind === 'video' ? (
                  <LocalVideo
                    api={api}
                    videoPath={attachment.path}
                    resourceId={attachment.resourceId}
                    controls={false}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : attachment.previewDataUrl ? (
                  <img src={attachment.previewDataUrl} alt="preview" />
                ) : (
                  <MmvectorImagePreview
                    api={api}
                    imagePath={attachment.path}
                    resourceId={attachment.resourceId}
                    alt="preview"
                  />
                )}
                <div className="ndp-input-preview-meta" title={attachment.path}>
                  {attachment.filename || attachment.kind}
                </div>
                <button
                  className="ndp-preview-remove"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  title="移除"
                  aria-label={`移除 ${attachment.filename || attachment.kind}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="ndp-chat-input-row">
          <div className="ndp-chat-menu-anchor ndp-chat-attachment-anchor">
            <button
              type="button"
              className="ndp-chat-icon-button ndp-chat-composer-button"
              onClick={() => onAttachmentMenuOpenChange(!attachmentMenuOpen)}
              title="添加附件"
              aria-label="添加附件"
              aria-haspopup="menu"
              aria-expanded={attachmentMenuOpen}
              onMouseDown={(event) => event.stopPropagation()}
            >
              ＋
            </button>
            {attachmentMenuOpen ? (
              <div className="ndp-chat-popover ndp-chat-attachment-menu" role="menu" aria-label="添加附件">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAttachmentMenuOpenChange(false)
                    imageInputRef.current?.click()
                  }}
                >
                  图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAttachmentMenuOpenChange(false)
                    videoInputRef.current?.click()
                  }}
                >
                  视频
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAttachmentMenuOpenChange(false)
                    attachmentInputRef.current?.click()
                  }}
                >
                  图片或视频
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return
              event.preventDefault()
              if (isAssistantOutputting) onStop()
              else void onSend()
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onPaste={(event) => {
              const clipboard = event.clipboardData
              if (!clipboard) return
              const files = Array.from(clipboard.files ?? []).filter((file) => getComposerMediaKind(file.type) !== null)
              if (files.length > 0) {
                event.preventDefault()
                readFiles(files)
                return
              }
              const mediaItems = Array.from(clipboard.items ?? []).filter((item) => getComposerMediaKind(item.type) !== null)
              if (mediaItems.length === 0) return
              event.preventDefault()
              readFiles(mediaItems.map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)))
            }}
            onDrop={(event) => {
              event.preventDefault()
              const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => getComposerMediaKind(file.type) !== null)
              if (files.length === 0) {
                onInvalidDrop('只支持拖拽图片或视频文件')
                return
              }
              readFiles(files)
            }}
            onDragOver={(event) => event.preventDefault()}
            placeholder="输入消息"
            aria-label="消息输入"
            rows={1}
          />
          <button
            className={`ndp-chat-icon-button ndp-chat-composer-button ${isAssistantOutputting ? 'ndp-btn-stop' : 'ndp-chat-send-button'}`}
            onClick={() => {
              if (isAssistantOutputting) onStop()
              else void onSend()
            }}
            disabled={!isAssistantOutputting && !input.trim() && pendingAttachments.length === 0}
            title={isAssistantOutputting ? '停止当前输出' : '发送'}
            aria-label={isAssistantOutputting ? '停止当前输出' : '发送'}
          >
            <span aria-hidden="true">{isAssistantOutputting ? '■' : '↑'}</span>
          </button>
        </div>
      </footer>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          readFiles(Array.from(event.target.files ?? []))
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          readFiles(Array.from(event.target.files ?? []))
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={attachmentInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          readFiles(Array.from(event.target.files ?? []))
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}
