import type { ChatMessageBlock, ChatMessageRecord, TaskRecord } from '../../electron/types'
import { filterVisibleToolRuns } from '../utils/chatMessages'

export type OrbImageViewerRequestItem = { source: string; title?: string }

export type OrbNormalizedMessageAttachment = {
  kind: 'image' | 'video'
  path?: string
  resourceId?: string
  dataUrl?: string
  filename?: string
}

export function normalizeOrbMessageAttachments(message: ChatMessageRecord): OrbNormalizedMessageAttachment[] {
  const normalized: OrbNormalizedMessageAttachment[] = []
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
    if (message.videoPath) normalized.push({ kind: 'video', path: String(message.videoPath) })
    if (message.imagePath) normalized.push({ kind: 'image', path: String(message.imagePath) })
    if (message.image && !message.imagePath) normalized.push({ kind: 'image', dataUrl: String(message.image) })
  }
  return normalized
}

export function buildOrbAttachmentImageItems(
  attachments: OrbNormalizedMessageAttachment[],
): OrbImageViewerRequestItem[] {
  return attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment, index) => ({
      source: String(attachment.dataUrl ?? attachment.path ?? '').trim(),
      title: String(attachment.filename ?? '').trim() || `图片 ${index + 1}`,
    }))
    .filter((item) => Boolean(item.source))
}

export function resolveOrbMessageBlocks(message: ChatMessageRecord, task: TaskRecord | null): ChatMessageBlock[] {
  if (Array.isArray(message.blocks) && message.blocks.length > 0) return message.blocks

  const textBlock: ChatMessageBlock = { type: 'text', text: String(message.content ?? '') }
  const taskId = String(message.taskId ?? '').trim()
  if (!taskId) return [textBlock]

  const runs = filterVisibleToolRuns(Array.isArray(task?.toolRuns) ? task.toolRuns : [])
  if (runs.length === 0) return [textBlock]
  return [textBlock, { type: 'tool_use', taskId }]
}
