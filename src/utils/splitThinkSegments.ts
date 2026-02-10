export type ThinkSplitSegment = { kind: 'markdown' | 'think'; content: string }

/**
 * 在渲染层把 <think>...</think> 从正文中拆出来，避免把“思考过程”直接展示给用户。
 * - 支持多个 <think> 段
 * - 如果缺失闭合标签，则从首个 <think> 起按普通文本处理（不做拆分）
 */
export function splitThinkSegments(input: string): ThinkSplitSegment[] {
  const text = String(input ?? '')
  if (!text) return [{ kind: 'markdown', content: '' }]

  const openTag = '<think>'
  const closeTag = '</think>'

  const firstOpen = text.indexOf(openTag)
  if (firstOpen < 0) return [{ kind: 'markdown', content: text }]

  // 如果没有闭合标签，避免误吞正文
  if (text.indexOf(closeTag, firstOpen + openTag.length) < 0) return [{ kind: 'markdown', content: text }]

  const segments: ThinkSplitSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    const open = text.indexOf(openTag, cursor)
    if (open < 0) break

    const before = text.slice(cursor, open)
    if (before) segments.push({ kind: 'markdown', content: before })

    const close = text.indexOf(closeTag, open + openTag.length)
    if (close < 0) {
      // 理论上不会到这里（上面已经检查过首个闭合），但为了健壮性兜底。
      segments.push({ kind: 'markdown', content: text.slice(open) })
      cursor = text.length
      break
    }

    const inner = text.slice(open + openTag.length, close)
    if (inner.trim().length > 0) segments.push({ kind: 'think', content: inner })

    cursor = close + closeTag.length
  }

  const tail = text.slice(cursor)
  if (tail) segments.push({ kind: 'markdown', content: tail })

  // 合并相邻 markdown，避免多段切碎导致多余的渲染节点/间距。
  const merged: ThinkSplitSegment[] = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.kind === 'markdown' && seg.kind === 'markdown') {
      last.content += seg.content
      continue
    }
    merged.push({ ...seg })
  }

  return merged.length > 0 ? merged : [{ kind: 'markdown', content: '' }]
}

