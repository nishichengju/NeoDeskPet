// 流式输出中的 Live2D 标签提取与 flush 节流（自 App.tsx 拆出，纯函数）

import { normalizeAssistantDisplayText } from './chatMessages'

export function extractLive2DTags(text: string): { displayText: string; expression?: string; motion?: string } {
  const raw = String(text ?? '')
  let expression: string | undefined
  let motion: string | undefined

  for (const m of raw.matchAll(/\[表情[：:]\s*([^\]]+)\]/g)) {
    expression = m[1]?.trim() || undefined
  }

  for (const m of raw.matchAll(/\[动作[：:]\s*([^\]]+)\]/g)) {
    motion = m[1]?.trim() || undefined
  }
  const displayText = normalizeAssistantDisplayText(raw, { trim: true })
  return {
    displayText,
    expression,
    motion,
  }
}

export function extractLastLive2DTags(text: string): { expression?: string; motion?: string } {
  const raw = String(text ?? '')

  let expression: string | undefined
  let motion: string | undefined

  for (const m of raw.matchAll(/\[表情[：:]\s*([^\]]+)\]/g)) {
    expression = m[1]?.trim() || undefined
  }

  for (const m of raw.matchAll(/\[动作[：:]\s*([^\]]+)\]/g)) {
    motion = m[1]?.trim() || undefined
  }

  return { expression, motion }
}

// 流式 flush 节流器：onDelta 按 token 高频到达时合并为每 intervalMs 一次刷新，
// 避免每个 token 都触发 全文 normalize + setMessages 重渲染 + 气泡 IPC。
// 流结束（含错误/中断路径）必须调用 finalize() 立即冲刷剩余内容。
export function createStreamFlushThrottle(flush: () => void, intervalMs = 80): { schedule: () => void; finalize: () => void } {
  let timer = 0
  let lastRun = 0
  return {
    schedule() {
      if (timer) return
      const delay = Math.max(0, intervalMs - (Date.now() - lastRun))
      timer = window.setTimeout(() => {
        timer = 0
        lastRun = Date.now()
        flush()
      }, delay)
    },
    finalize() {
      if (timer) {
        window.clearTimeout(timer)
        timer = 0
      }
      flush()
    },
  }
}

// 流式期间对 Live2D 标签只扫描本次新增的尾部片段（含 64 字符回看，覆盖跨 flush 边界的标签），
// 避免每次 flush 对全文跑正则（整体 O(n²)）。
export function extractTailLive2DTags(acc: string, appendedLength: number): { expression?: string; motion?: string } {
  return extractLastLive2DTags(acc.slice(Math.max(0, acc.length - appendedLength - 64)))
}
