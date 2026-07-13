import type { ChatMessageRecord } from '../../../electron/types'

export type NormalizedMessageAttachment = {
  kind: 'image' | 'video'
  path?: string
  resourceId?: string
  dataUrl?: string
  filename?: string
}

export function normalizeMessageAttachments(message: ChatMessageRecord): NormalizedMessageAttachment[] {
  const normalized: NormalizedMessageAttachment[] = []
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (!attachment || typeof attachment !== 'object') continue
      const kind = attachment.kind === 'video' ? 'video' : attachment.kind === 'image' ? 'image' : ''
      const path = typeof attachment.path === 'string' ? attachment.path.trim() : ''
      const resourceId = typeof attachment.resourceId === 'string' ? attachment.resourceId.trim() : ''
      const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : ''
      if (!kind || !path) continue
      normalized.push({
        kind,
        path,
        ...(resourceId ? { resourceId } : {}),
        ...(filename ? { filename } : {}),
      })
    }
  }

  if (normalized.length === 0) {
    if (message.imagePath) normalized.push({ kind: 'image', path: String(message.imagePath) })
    if (message.videoPath) normalized.push({ kind: 'video', path: String(message.videoPath) })
    if (message.image && !message.imagePath) normalized.push({ kind: 'image', dataUrl: String(message.image) })
  }
  return normalized
}
