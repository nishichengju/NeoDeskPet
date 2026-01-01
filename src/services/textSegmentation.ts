const EXPRESSION_TAG_PATTERN = /\[表情[：:]\s*([^\]]+)\]/g
const MOTION_TAG_PATTERN = /\[动作[：:]\s*([^\]]+)\]/g

export function sanitizeSegmentText(text: string): string {
  if (!text) return ''
  let out = text
  out = out.replace(EXPRESSION_TAG_PATTERN, '')
  out = out.replace(MOTION_TAG_PATTERN, '')
  out = out.replace(/\s+/g, ' ')
  return out.trim()
}

function isSentenceBoundary(ch: string): boolean {
  return ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n'
}

function isSoftBoundary(ch: string): boolean {
  return ch === '，' || ch === ',' || ch === '；' || ch === ';'
}

/**
 * 将完整文本按句子切分（保留标点）
 */
export function splitTextIntoSegments(text: string): string[] {
  const normalized = (text ?? '').replace(/\r\n/g, '\n')
  const out: string[] = []
  let buf = ''
  let bracketDepth = 0

  for (const ch of normalized) {
    if (ch === '[' || ch === '【') bracketDepth++
    if ((ch === ']' || ch === '】') && bracketDepth > 0) bracketDepth--

    buf += ch
    if (bracketDepth > 0) continue
    if (!isSentenceBoundary(ch)) continue

    const seg = sanitizeSegmentText(buf)
    if (seg) out.push(seg)
    buf = ''
  }

  const rest = sanitizeSegmentText(buf)
  if (rest) out.push(rest)
  return out
}

/**
 * 流式分句器：把流式 delta 按句子切成“可播放”的片段。
 * - 尽量在句末标点处切分
 * - 避免在标签/括号未闭合时切分（防止把 [表情:..] 这类切碎）
 * - 超长时允许在逗号/分号处软切分，避免等待太久
 */
export function createStreamingSentenceSegmenter() {
  let buffer = ''
  let bracketDepth = 0

  const push = (delta: string): string[] => {
    if (!delta) return []
    buffer += delta.replace(/\r\n/g, '\n')

    const out: string[] = []

    const findCutIndex = (): number => {
      bracketDepth = 0
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i]
        if (ch === '[' || ch === '【') bracketDepth++
        if ((ch === ']' || ch === '】') && bracketDepth > 0) bracketDepth--

        if (bracketDepth > 0) continue
        if (isSentenceBoundary(ch)) return i
      }

      if (buffer.length >= 160) {
        bracketDepth = 0
        for (let i = 0; i < buffer.length; i++) {
          const ch = buffer[i]
          if (ch === '[' || ch === '【') bracketDepth++
          if ((ch === ']' || ch === '】') && bracketDepth > 0) bracketDepth--
          if (bracketDepth > 0) continue
          if (isSoftBoundary(ch)) return i
        }
      }

      return -1
    }

    let idx = findCutIndex()
    while (idx >= 0) {

      const seg = buffer.slice(0, idx + 1)
      buffer = buffer.slice(idx + 1)

      const cleaned = sanitizeSegmentText(seg)
      if (cleaned) out.push(cleaned)

      idx = findCutIndex()
    }

    return out
  }

  const flush = (): string[] => {
    const cleaned = sanitizeSegmentText(buffer)
    buffer = ''
    bracketDepth = 0
    return cleaned ? [cleaned] : []
  }

  return { push, flush }
}
