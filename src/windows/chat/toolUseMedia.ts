export type MmvectorResult = {
  id?: number
  type?: string
  score?: number
  filename?: string
  imagePath?: string
  videoUrl?: string
  videoPath?: string
}

export type MmvectorResults = {
  count?: number
  results: MmvectorResult[]
}

export function parseMmvectorResults(raw: string): MmvectorResults | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return JSON.parse(text.slice(first, last + 1)) as unknown
      }
    })()
    if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) return null
    const results = (parsed as { results?: unknown }).results
    if (!Array.isArray(results)) return null
    return {
      count: typeof (parsed as { count?: unknown }).count === 'number' ? (parsed as { count: number }).count : undefined,
      results: results as MmvectorResult[],
    }
  } catch {
    return null
  }
}

export function toToolMediaSrc(mediaUrl: string, mediaPath: string): string {
  const url = String(mediaUrl ?? '').trim()
  if (url) return url
  return String(mediaPath ?? '').trim()
}

export function isPreviewableToolImagePath(raw: string): boolean {
  const value = String(raw ?? '').trim()
  if (!value) return false
  if (/^data:image\//i.test(value)) return true
  if (/^blob:/i.test(value)) return true
  if (/^file:\/\//i.test(value)) return true
  if (/^https?:\/\//i.test(value)) return /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(value)
  if (/^\/\//.test(value)) return false
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(value)) return false
  return true
}
