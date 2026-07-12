// 聊天消息的规范化/分块/工具边界处理（自 App.tsx 拆出，纯函数）

import type {
  ChatMessageBlock,
  ChatMessageRecord,
} from '../../electron/types'
import { type ChatMessage } from '../services/aiService'
import { stripToolProtocolDisplayArtifacts } from './toolProtocolDisplay'

export const BUBBLE_PREVIEW_FALLBACK_PREFIX = '__NDP_BUBBLE_PREVIEW__:'

// agent.run 是“对话代理”的编排壳：聊天里只应展示其内部真实工具调用。
// 壳自身若混入 toolRuns/steps（旧存档或旧版本主进程写入），渲染时统一过滤，
// 否则纯聊天也会看到一张“DONE agent.run”工具卡。
export const AGENT_SHELL_TOOL_NAME = 'agent.run'
export const INTERNAL_CHAT_TOOL_NAMES = new Set([AGENT_SHELL_TOOL_NAME, 'vision.look'])

export function isAgentShellToolName(tool: unknown): boolean {
  return typeof tool === 'string' && tool.trim() === AGENT_SHELL_TOOL_NAME
}

export function isInternalChatToolName(tool: unknown): boolean {
  return typeof tool === 'string' && INTERNAL_CHAT_TOOL_NAMES.has(tool.trim())
}

export function filterVisibleToolRuns<T extends { toolName?: unknown }>(runs: readonly T[] | undefined | null): T[] {
  if (!Array.isArray(runs)) return []
  return runs.filter((r) => !isInternalChatToolName((r as { toolName?: unknown })?.toolName))
}

// 工具输出常见“JSON 转义残留”路径（C:\\Users\\...）：与正常形态（C:\Users\...）指向同一文件，
// 收集图片路径时必须折叠成同一字符串，否则字符串级去重会把同一张图当成两张。
export function canonicalizeLocalImagePath(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\\{2,}/g, '\\')
  if (s.startsWith('\\\\')) return `\\${s.replace(/\\{2,}/g, '\\')}` // UNC：保留头部双反斜杠
  return s
}

export type EffectiveChatMessage = {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export function collapseAssistantRuns(messages: ChatMessageRecord[]): EffectiveChatMessage[] {
  const out: EffectiveChatMessage[] = []
  for (const m of messages) {
    const content = (m.content ?? '').trim()
    if (!content) continue

    if (m.role === 'assistant') {
      const last = out[out.length - 1]
      if (last && last.role === 'assistant') {
        last.content = `${last.content}\n${content}`
        last.createdAt = Math.min(last.createdAt, m.createdAt)
        continue
      }
      out.push({ role: 'assistant', content, createdAt: m.createdAt })
      continue
    }

    out.push({ role: 'user', content, createdAt: m.createdAt })
  }
  return out
}

export function sliceTail<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  return items.slice(items.length - max)
}

export function toLocalMediaSrc(mediaPath: string): string {
  const p = String(mediaPath ?? '').trim()
  if (!p) return ''
  if (/^(https?:|file:|data:|blob:)/i.test(p)) return p
  if (/^[a-zA-Z]:[\\/]/.test(p)) return `file:///${p.replace(/\\/g, '/')}`
  if (p.startsWith('\\\\')) return `file:${p.replace(/\\/g, '/')}`
  if (p.startsWith('/')) return `file://${p}`
  return p
}

export function normalizeAssistantDisplayText(text: string, opts?: { trim?: boolean }): string {
  const cleaned = stripToolProtocolDisplayArtifacts(String(text ?? ''))
    .replace(/\[表情[：:]\s*[^\]]+\]/g, '')
    .replace(/\[动作[：:]\s*[^\]]+\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
  return opts?.trim ? cleaned.trim() : cleaned
}

export function buildInterruptedStreamContent(partialText: string, errorText: string): string {
  const partial = normalizeAssistantDisplayText(partialText, { trim: true })
  const err = String(errorText ?? '').trim()
  if (!partial) return `[错误] ${err || '未知错误'}`
  return err ? `${partial}\n\n[中断] ${err}` : `${partial}\n\n[中断]`
}

export function toPlainTextFromChatContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return typeof part.text === 'string' ? part.text : ''
      if (part.type === 'image_url') return '[图片]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function buildContextCompressionSummaryPrompt(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统'
    const text = toPlainTextFromChatContent(msg.content).trim()
    if (!text) continue
    lines.push(`${role}：${text}`)
  }
  return lines.join('\n\n').trim()
}

export function normalizeMessageBlocks(m: ChatMessageRecord): ChatMessageBlock[] {
  const blocksRaw = Array.isArray(m.blocks) ? m.blocks : []
  const cleaned: ChatMessageBlock[] = blocksRaw
    .map((b) => {
      if (!b || typeof b !== 'object') return null
      const t = (b as { type?: unknown }).type
      if (t === 'text') {
        const text = typeof (b as { text?: unknown }).text === 'string' ? String((b as { text?: unknown }).text) : ''
        return { type: 'text', text }
      }
      if (t === 'tool_use') {
        const taskId = typeof (b as { taskId?: unknown }).taskId === 'string' ? String((b as { taskId?: unknown }).taskId) : ''
        if (!taskId.trim()) return null
        const runId = typeof (b as { runId?: unknown }).runId === 'string' ? String((b as { runId?: unknown }).runId) : undefined
        return { type: 'tool_use', taskId, ...(runId?.trim() ? { runId } : {}) }
      }
      if (t === 'status') {
        const text = typeof (b as { text?: unknown }).text === 'string' ? String((b as { text?: unknown }).text) : ''
        return { type: 'status', text }
      }
      return null
    })
    .filter((x): x is ChatMessageBlock => Boolean(x))

  if (cleaned.length > 0) return cleaned

  // 兼容旧数据：content + taskId
  const legacy: ChatMessageBlock[] = []
  if (m.content) legacy.push({ type: 'text', text: m.content })
  if (m.taskId) legacy.push({ type: 'tool_use', taskId: m.taskId })
  return legacy
}

export function joinTextBlocks(blocks: ChatMessageBlock[]): string {
  const parts = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String((b as { text: string }).text ?? '').trim())
    .filter(Boolean)
  return parts.join('\n\n')
}

export function normalizeInterleavedTextSegment(text: string): string {
  return stripToolProtocolDisplayArtifacts(String(text ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/g, '')
    .replace(/\n+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

export function computeAppendDelta(prev: string, next: string): string {
  const p = String(prev ?? '')
  const n = String(next ?? '')
  if (!p) return n
  if (n.startsWith(p)) return n.slice(p.length)
  const pTrimEnd = p.replace(/\s+$/, '')
  if (pTrimEnd && n.startsWith(pTrimEnd)) return n.slice(pTrimEnd.length)
  return ''
}

export function mergeLeadingPunctuationAcrossToolBoundary(segments: string[], runIds: string[]): string[] {
  // 体验优化：流式时工具卡片可能“抢先”插入，导致少量尾缀（如“吗？”）被分到工具卡后面。
  // 这里把“极短的疑问/语气/标点前缀”回贴到前一段文本，让阅读更自然。
  const segs = Array.isArray(segments) ? [...segments] : ['']
  const ids = Array.isArray(runIds) ? runIds : []
  if (ids.length === 0 || segs.length < ids.length + 1) return segs

  const stripLeft = (s: string) => String(s ?? '').replace(/^[ \t\r\n]+/g, '')
  const endsWithPunc = (s: string) => /[，,。.!！?？…]\s*$/.test(String(s ?? ''))

  // 允许搬运的“短前缀”：2字以内语气词 + 可选标点；或连续标点
  const pickLead = (s: string): { lead: string; rest: string } => {
    const trimmed = stripLeft(s)
    if (!trimmed) return { lead: '', rest: '' }

    const m1 = trimmed.match(/^([吗嘛呢吧呀啊]{1,2}[？?！!。.]?)/u)
    if (m1?.[1]) {
      const lead = m1[1]
      return { lead, rest: trimmed.slice(lead.length) }
    }

    const m2 = trimmed.match(/^([，,。.!！?？…]{1,3})/u)
    if (m2?.[1]) {
      const lead = m2[1]
      return { lead, rest: trimmed.slice(lead.length) }
    }

    return { lead: '', rest: trimmed }
  }

  for (let i = 0; i < ids.length; i += 1) {
    const before = String(segs[i] ?? '')
    const after = String(segs[i + 1] ?? '')
    if (!before.trim()) continue
    if (!after.trim()) continue
    if (endsWithPunc(before)) continue

    const { lead, rest } = pickLead(after)
    if (!lead) continue
    if (lead.length > 4) continue

    segs[i] = before + lead
    segs[i + 1] = rest
  }

  return segs
}

export function pickRicherToolBlocks(a: ChatMessageBlock[], b: ChatMessageBlock[]): ChatMessageBlock[] {
  const score = (blocks: ChatMessageBlock[]): number => {
    let tool = 0
    let run = 0
    for (const x of blocks) {
      if (x.type !== 'tool_use') continue
      tool += 1
      const rid = (x as { runId?: string }).runId
      if (typeof rid === 'string' && rid.trim()) run += 1
    }
    return run * 1000 + tool * 10 + blocks.length
  }
  return score(b) > score(a) ? b : a
}
