export type ComposerMediaKind = 'image' | 'video'

export function getComposerMediaKind(type: unknown): ComposerMediaKind | null {
  const normalized = String(type ?? '').trim().toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  return null
}
