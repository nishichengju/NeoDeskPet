// TTS 播报文本的抽取与分段稳定性判断（自 App.tsx 拆出，纯函数）

import type {
  AppSettings,
} from '../../electron/types'

export function trimTrailingCommaForSegment(text: string): string {
  const raw = String(text ?? '')
  const trimmed = raw.replace(/[，,]\s*$/u, '').trimEnd()
  return trimmed || raw
}

export function extractQuotedTtsParts(text: string): string[] {
  const raw = String(text ?? '')
  if (!raw.trim()) return []

  const patterns: RegExp[] = [/“([^”]+)”/gu, /"([^"\n]+)"/gu, /「([^」]+)」/gu, /『([^』]+)』/gu, /《([^》]+)》/gu]
  const out: string[] = []
  const seen = new Set<string>()

  for (const re of patterns) {
    for (const m of raw.matchAll(re)) {
      const content = String(m[1] ?? '').trim()
      if (!content) continue
      if (seen.has(content)) continue
      seen.add(content)
      out.push(content)
      if (out.length >= 80) return out
    }
  }
  return out
}

export function normalizeTtsRegexFlags(rawFlags: string): string {
  const seen = new Set<string>()
  let out = ''
  for (const ch of String(rawFlags ?? '')) {
    if (!/[dgimsuvy]/.test(ch)) continue
    if (seen.has(ch)) continue
    seen.add(ch)
    out += ch
    if (out.length >= 12) break
  }
  return out
}

export function resolveTtsPlaybackText(rawText: string, tts: AppSettings['tts'] | null | undefined): string {
  const source = String(rawText ?? '').trim()
  if (!source) return ''

  const mode = String(tts?.playbackTextMode ?? 'full').trim()
  if (mode === 'quoted') {
    return extractQuotedTtsParts(source).join('\n').trim()
  }

  if (mode === 'regex') {
    const pattern = String(tts?.playbackRegex ?? '').trim()
    if (!pattern) return source
    const flags = normalizeTtsRegexFlags(String(tts?.playbackRegexFlags ?? ''))

    try {
      const re = new RegExp(pattern, flags)
      const out: string[] = []
      if (re.global) {
        for (const m of source.matchAll(re)) {
          const captured = m.length > 1 ? String(m[1] ?? '') : String(m[0] ?? '')
          const text = captured.trim()
          if (!text) continue
          out.push(text)
          if (out.length >= 80) break
        }
      } else {
        const m = re.exec(source)
        if (m) {
          const captured = m.length > 1 ? String(m[1] ?? '') : String(m[0] ?? '')
          const text = captured.trim()
          if (text) out.push(text)
        }
      }
      return out.join('\n').trim()
    } catch {
      // 自定义正则非法时回退全文，避免误配置导致完全无声。
      return source
    }
  }

  return source
}

export function isLikelyTtsSentenceBoundary(text: string): boolean {
  const raw = String(text ?? '')
  const trimmed = raw.replace(/\s+$/g, '')
  if (!trimmed) return false
  const last = trimmed[trimmed.length - 1]
  return last === '\n' || /[。！？!?…]/u.test(last)
}

export function countStableTtsSegments(text: string, segments: string[], forceAll: boolean): number {
  if (segments.length === 0) return 0
  if (forceAll) return segments.length
  if (isLikelyTtsSentenceBoundary(text)) return segments.length
  return Math.max(0, segments.length - 1)
}
