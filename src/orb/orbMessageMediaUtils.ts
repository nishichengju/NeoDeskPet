import type { NeoDeskPetApi } from '../neoDeskPetApi'
import { toLocalMediaSrc } from '../utils/chatMessages'

export type OrbMediaApi = Pick<NeoDeskPetApi, 'readChatAttachmentDataUrl' | 'getChatAttachmentUrl'>

export function formatDurationMs(ms: number): string {
  const safeMs = Number.isFinite(ms) ? ms : 0
  const totalSeconds = Math.max(0, Math.floor(safeMs / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`)
  return parts.join('')
}

export type OrbImageSourceOptions = {
  imagePath: string
  resourceId?: string
  dataUrl?: string
}

export function getImageFallback(options: OrbImageSourceOptions): string {
  return toLocalMediaSrc(String(options.dataUrl ?? options.imagePath ?? '').trim())
}

export async function resolveOrbImageSource(
  api: OrbMediaApi | null,
  options: OrbImageSourceOptions,
): Promise<string> {
  const fallback = getImageFallback(options)
  if (fallback) return fallback

  const imagePath = String(options.imagePath ?? '').trim()
  if (!api || !imagePath) return ''

  try {
    const result = await api.readChatAttachmentDataUrl(
      options.resourceId ? { resourceId: options.resourceId, path: imagePath } : imagePath,
    )
    return result?.ok && typeof result.dataUrl === 'string' ? result.dataUrl : ''
  } catch {
    return ''
  }
}

export type OrbVideoSourceOptions = {
  videoPath: string
  resourceId?: string
}

export function getVideoFallback(options: OrbVideoSourceOptions): string {
  return toLocalMediaSrc(String(options.videoPath ?? '').trim())
}

export async function resolveOrbVideoSource(
  api: OrbMediaApi | null,
  options: OrbVideoSourceOptions,
): Promise<string> {
  const fallback = getVideoFallback(options)
  if (fallback) return fallback

  const videoPath = String(options.videoPath ?? '').trim()
  if (!api || !videoPath) return ''

  try {
    const result = await api.getChatAttachmentUrl(
      options.resourceId ? { resourceId: options.resourceId, path: videoPath } : videoPath,
    )
    return result?.ok && typeof result.url === 'string' ? result.url : ''
  } catch {
    return ''
  }
}
