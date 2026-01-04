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

// -----------------------------
// GPT-SoVITS v2 分句对齐（TTS 怎么分，UI 就怎么分）
// 参考：GPT_SoVITS/TTS_infer_pack/text_segmentation_method.py + TextPreprocessor.py
// -----------------------------

const GPT_SOVITS_SPLITS = new Set(['，', '。', '？', '！', ',', '.', '?', '!', '~', ':', '：', '—', '…'])
const GPT_SOVITS_CUT5_PUNDS = new Set([',', '.', ';', '?', '!', '、', '，', '。', '？', '！', '：', '…'])

function replaceConsecutivePunctuationForGptSovits(text: string): string {
  // TextPreprocessor.replace_consecutive_punctuation: ([!?…,.\\-])([!?…,.\\-])+ -> \\1
  return String(text ?? '').replace(/([!?…,.-])([!?…,.-])+/g, '$1')
}

function getFirstBySplits(text: string): string {
  const raw = String(text ?? '')
  let out = ''
  for (const ch of raw) {
    if (GPT_SOVITS_SPLITS.has(ch)) break
    out += ch
  }
  return out.trim()
}

function mergeShortTextInArray(texts: string[], threshold: number): string[] {
  if (!Array.isArray(texts) || texts.length < 2) return texts
  const result: string[] = []
  let acc = ''

  for (const ele of texts) {
    acc += ele
    if (acc.length >= threshold) {
      result.push(acc)
      acc = ''
    }
  }

  if (acc.length > 0) {
    if (result.length === 0) result.push(acc)
    else result[result.length - 1] += acc
  }

  return result
}

function isAllCharsInSet(text: string, set: Set<string>): boolean {
  if (!text) return true
  for (const ch of text) {
    if (!set.has(ch)) return false
  }
  return true
}

function cut5ToNewlineSeparatedText(inp: string): string {
  const raw = String(inp ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
  const mergeitems: string[] = []
  let buf = ''

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (GPT_SOVITS_CUT5_PUNDS.has(ch)) {
      if (ch === '.' && i > 0 && i < raw.length - 1 && /\d/.test(raw[i - 1]) && /\d/.test(raw[i + 1])) {
        buf += ch
      } else {
        buf += ch
        mergeitems.push(buf)
        buf = ''
      }
    } else {
      buf += ch
    }
  }

  if (buf) mergeitems.push(buf)

  const filtered = mergeitems.filter((item) => !isAllCharsInSet(item, GPT_SOVITS_CUT5_PUNDS))
  return filtered.join('\n')
}

function splitBigTextByPunctuation(text: string, maxLen: number): string[] {
  const raw = String(text ?? '')
  const parts: string[] = []
  let buf = ''

  for (const ch of raw) {
    if (GPT_SOVITS_SPLITS.has(ch)) {
      if (buf) parts.push(buf)
      parts.push(ch)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf) parts.push(buf)

  const result: string[] = []
  let current = ''
  for (const part of parts) {
    if ((current + part).length > maxLen) {
      if (current) result.push(current)
      current = part
    } else {
      current += part
    }
  }
  if (current) result.push(current)
  return result
}

function hasAnyLettersOrNumbers(text: string): boolean {
  // Python 的 `re.sub("\\W+", "", text)` 会保留中文/日文等 Unicode 字母；这里用 Unicode 属性模拟
  return /[\p{L}\p{N}]/u.test(text)
}

export function splitTextIntoTtsSegments(text: string, opts?: { lang?: 'zh' | 'en'; textSplitMethod?: 'cut5' }): string[] {
  const lang = opts?.lang ?? 'zh'
  const method = opts?.textSplitMethod ?? 'cut5'

  let raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
  if (!raw.trim()) return []

  raw = replaceConsecutivePunctuationForGptSovits(raw)
  if (!GPT_SOVITS_SPLITS.has(raw[0]) && getFirstBySplits(raw).length < 4) {
    raw = `${lang === 'en' ? '.' : '。'}${raw}`
  }

  let segText = raw
  if (method === 'cut5') segText = cut5ToNewlineSeparatedText(raw)

  segText = segText.replace(/\n{2,}/g, '\n')

  let segments = segText
    .split('\n')
    .filter((s) => s != null && s !== '' && s !== ' ' && s !== '\n')

  segments = mergeShortTextInArray(segments, 5)

  const out: string[] = []
  for (let seg of segments) {
    seg = String(seg ?? '')
    if (!seg.trim()) continue
    if (!hasAnyLettersOrNumbers(seg)) continue

    if (!GPT_SOVITS_SPLITS.has(seg[seg.length - 1])) {
      seg += lang === 'en' ? '.' : '。'
    }

    if (seg.length > 510) out.push(...splitBigTextByPunctuation(seg, 510))
    else out.push(seg)
  }

  return out.map((s) => sanitizeSegmentText(s)).filter(Boolean)
}
