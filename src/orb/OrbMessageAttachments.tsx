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
            <div
              key={key}
              className="ndp-orbpanel-attachment"
              title={path}
              onClick={() => void props.onOpenAttachment(path, attachment.resourceId)}
            >
              <OrbLocalVideo
                api={props.api}
                className="ndp-orbpanel-video"
                videoPath={path}
                resourceId={attachment.resourceId}
                controls
                preload="metadata"
                playsInline
              />
              <div className="ndp-orbpanel-attachment-meta">{attachment.filename || 'video'}</div>
            </div>
          )
        }

        if (!source) return null
        const viewerIndex = imageViewerItems.findIndex((item) => item.source === source)
        return (
          <div
            key={key}
            className="ndp-orbpanel-attachment"
            title={source}
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
            <div className="ndp-orbpanel-attachment-meta">{attachment.filename || 'image'}</div>
          </div>
        )
      })}
    </div>
  )
}
