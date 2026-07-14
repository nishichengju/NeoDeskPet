import type { ChatMessageRecord } from '../../electron/types'
import type { NeoDeskPetApi } from '../neoDeskPetApi'
import { OrbImagePreview, OrbLocalVideo } from './OrbMessageMedia'
import {
  buildOrbAttachmentImageItems,
  normalizeOrbMessageAttachments,
  type OrbImageViewerRequestItem,
} from './orbMessageContentUtils'

export type OrbMessageAttachmentsProps = {
  api: NeoDeskPetApi | null
  message: ChatMessageRecord
  onOpenAttachment: (pathOrUrl: string, resourceId?: string) => void | Promise<void>
  onOpenImageViewer: (items: OrbImageViewerRequestItem[], index: number) => void | Promise<void>
}

export function OrbMessageAttachments(props: OrbMessageAttachmentsProps) {
  const attachments = normalizeOrbMessageAttachments(props.message)
  if (attachments.length === 0) return null

  const imageViewerItems = buildOrbAttachmentImageItems(attachments)
  return (
    <div className="ndp-orbpanel-attachments" data-orb-nodrag="true">
      {attachments.map((attachment, index) => {
        const source = String(attachment.dataUrl ?? attachment.path ?? '').trim()
        const key = `${attachment.kind}-${source}-${index}`
        if (attachment.kind === 'video') {
          const path = String(attachment.path ?? '').trim()
          if (!path) return null
          return (
            <div key={key} className="ndp-orbpanel-attachment ndp-orbpanel-attachment-video" title={path}>
              <OrbLocalVideo
                api={props.api}
                className="ndp-orbpanel-video"
                videoPath={path}
                resourceId={attachment.resourceId}
                controls
                preload="metadata"
                playsInline
              />
              <button
                type="button"
                className="ndp-orbpanel-attachment-meta ndp-orbpanel-attachment-open"
                aria-label={`打开视频 ${attachment.filename || index + 1}`}
                onClick={() => void props.onOpenAttachment(path, attachment.resourceId)}
              >
                {attachment.filename || 'video'}
              </button>
            </div>
          )
        }

        if (!source) return null
        const viewerIndex = imageViewerItems.findIndex((item) => item.source === source)
        const imageNumber = viewerIndex >= 0 ? viewerIndex + 1 : index + 1
        return (
          <button
            key={key}
            type="button"
            className="ndp-orbpanel-attachment"
            title={source}
            aria-label={`查看图片 ${attachment.filename || imageNumber}`}
            onClick={() => {
              if (viewerIndex >= 0) void props.onOpenImageViewer(imageViewerItems, viewerIndex)
            }}
          >
            {attachment.dataUrl ? (
              <img className="ndp-orbpanel-image" src={attachment.dataUrl} alt={attachment.filename || 'image'} />
            ) : (
              <OrbImagePreview
                api={props.api}
                className="ndp-orbpanel-image"
                imagePath={String(attachment.path ?? '')}
                resourceId={attachment.resourceId}
                alt={attachment.filename || 'image'}
              />
            )}
            <span className="ndp-orbpanel-attachment-meta">{attachment.filename || 'image'}</span>
          </button>
        )
      })}
    </div>
  )
}
