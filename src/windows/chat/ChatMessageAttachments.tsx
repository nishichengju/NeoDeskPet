import type { ChatMessageRecord } from '../../../electron/types'
import { LocalVideo, MmvectorImagePreview } from '../../components/MediaPreviews'
import { getApi } from '../../neoDeskPetApi'
import { buildLocalMediaReference, resolveLocalMediaUrl } from '../../services/localMediaCache'
import { normalizeMessageAttachments } from './messageAttachments'

export type ChatMessageAttachmentsProps = {
  message: ChatMessageRecord
  api: ReturnType<typeof getApi> | null
  hidden?: boolean
  onOpenImageViewer: (paths: string[], index: number) => void | Promise<void>
}

export function ChatMessageAttachments({
  message,
  api,
  hidden = false,
  onOpenImageViewer,
}: ChatMessageAttachmentsProps) {
  if (hidden) return null
  const attachments = normalizeMessageAttachments(message)
  if (attachments.length === 0) return null
  const imageSources = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => String(attachment.dataUrl ?? attachment.path ?? '').trim())
    .filter(Boolean)

  const openAttachment = async (pathOrUrl: string, resourceId?: string) => {
    const raw = String(pathOrUrl ?? '').trim()
    if (!raw) return
    const url = await resolveLocalMediaUrl(api, buildLocalMediaReference(raw, resourceId))
    if (url) window.open(url, '_blank')
  }

  return (
    <div className="ndp-msg-attachments">
      {attachments.map((attachment, index) => {
        const key = `${message.id}-att-${index}-${attachment.kind}-${String(attachment.path ?? attachment.dataUrl ?? '')}`
        if (attachment.kind === 'video') {
          const path = String(attachment.path ?? '').trim()
          if (!path) return null
          return (
            <div key={key} className="ndp-msg-attachment">
              <LocalVideo
                api={api}
                className="ndp-msg-video"
                videoPath={path}
                resourceId={attachment.resourceId}
                controls
                preload="metadata"
                playsInline
              />
              <button
                className="ndp-attachment-open"
                onClick={() => void openAttachment(path, attachment.resourceId)}
                title="打开"
              >
                打开
              </button>
            </div>
          )
        }

        const dataUrl = String(attachment.dataUrl ?? '').trim()
        const path = String(attachment.path ?? '').trim()
        const source = dataUrl || path
        if (!source) return null
        const imageIndex = Math.max(0, imageSources.findIndex((item) => item === source))
        return (
          <div key={key} className="ndp-msg-attachment">
            {dataUrl ? (
              <img
                className="ndp-msg-image"
                src={dataUrl}
                alt="attachment"
                onClick={() => void onOpenImageViewer(imageSources, imageIndex)}
              />
            ) : (
              <div className="ndp-msg-image-hit" onClick={() => void onOpenImageViewer(imageSources, imageIndex)}>
                <MmvectorImagePreview
                  api={api}
                  imagePath={path}
                  resourceId={attachment.resourceId}
                  alt="attachment"
                />
              </div>
            )}
            <button
              className="ndp-attachment-open"
              onClick={() => void onOpenImageViewer(imageSources, imageIndex)}
              title="查看"
            >
              查看
            </button>
          </div>
        )
      })}
    </div>
  )
}
