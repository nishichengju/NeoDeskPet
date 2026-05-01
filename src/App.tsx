import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import type {
  AppSettings,
  ChatMessageBlock,
  ChatMessageRecord,
  ChatSessionSummary,
  ContextUsageSnapshot,
  McpStateSnapshot,
  MemoryRetrieveResult,
  Persona,
  TaskCreateArgs,
  TaskRecord,
  TaskStepRecord,
  WorldBookEntry,
} from '../electron/types'
import { getBuiltinToolDefinitions, isToolEnabled } from '../electron/toolRegistry'
import { getApi } from './neoDeskPetApi'
import { getWindowType } from './windowType'
import { MemoryConsoleWindow } from './windows/MemoryConsoleWindow'
import { Live2DView } from './live2d/Live2DView'
import { SpeechBubble } from './components/SpeechBubble'
import { ContextUsageOrb } from './components/ContextUsageOrb'
import { MarkdownMessage } from './components/MarkdownMessage'
import { OrbApp } from './orb/OrbApp'
import { OrbMenuWindow } from './orb/OrbMenuWindow'
import {
  getAvailableModels,
  parseModelMetadata,
  scanAvailableModels,
  type Live2DModelInfo,
} from './live2d/live2dModels'
import { ABORTED_ERROR, AIService, getAIService, setModelInfoToAIService, type ChatMessage, type ChatUsage } from './services/aiService'
import { TtsPlayer } from './services/ttsService'
import { splitTextIntoTtsSegments } from './services/textSegmentation'
import { stripToolProtocolDisplayArtifacts } from './utils/toolProtocolDisplay'
import {
  isOpenTypelessAsrWsUrl,
  clampIntValue,
} from './utils/settingsHelpers'
import { TaskPanelSettingsTab } from './windows/settings/TaskPanelTab'
import { Live2DSettingsTab } from './windows/settings/Live2DTab'
import { BubbleSettingsTab } from './windows/settings/BubbleTab'
import { ChatUiSettingsTab } from './windows/settings/ChatUiTab'
import { TtsSettingsTab } from './windows/settings/TtsTab'
import { AsrSettingsTab } from './windows/settings/AsrTab'
import { AISettingsTab } from './windows/settings/AiTab'
import { ToolsSettingsTab } from './windows/settings/ToolsTab'
import { PersonaSettingsTab } from './windows/settings/PersonaTab'
import { WorldBookSettingsTab } from './windows/settings/WorldBookTab'

const BUBBLE_PREVIEW_FALLBACK_PREFIX = '__NDP_BUBBLE_PREVIEW__:'

function clampPcmFloat(v: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0))
}

function floatToPcm16(v: number): number {
  const s = clampPcmFloat(v)
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length <= 0) return b
  if (b.length <= 0) return a
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function createOpenTypelessPcmSender(ws: WebSocket, inputSampleRate: number): (pcm: Float32Array) => void {
  const targetSampleRate = 16000
  let carry = new Float32Array(0)

  const sendInt16 = (source: Float32Array) => {
    if (!source.length) return
    const out = new Int16Array(source.length)
    for (let i = 0; i < source.length; i++) out[i] = floatToPcm16(source[i])
    ws.send(out.buffer)
  }

  return (pcm: Float32Array) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (!(pcm instanceof Float32Array) || pcm.length <= 0) return

    const merged = carry.length ? concatFloat32(carry, pcm) : pcm

    // OpenTypeless demo ws 默认按 16kHz / int16 PCM 读取；优先用 16k AudioContext，必要时在前端降采样兜底。
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || Math.abs(inputSampleRate - targetSampleRate) < 1) {
      carry = new Float32Array(0)
      sendInt16(merged)
      return
    }

    if (inputSampleRate < targetSampleRate) {
      carry = new Float32Array(0)
      sendInt16(merged)
      return
    }

    const ratio = inputSampleRate / targetSampleRate
    const outLen = Math.floor(merged.length / ratio)
    if (outLen <= 0) {
      carry = merged.slice()
      return
    }

    const out = new Int16Array(outLen)
    let sourceIndex = 0
    for (let i = 0; i < outLen; i++) {
      const nextSourceIndex = Math.min(merged.length, Math.max(sourceIndex + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      let count = 0
      while (sourceIndex < nextSourceIndex) {
        sum += merged[sourceIndex]
        sourceIndex += 1
        count += 1
      }
      out[i] = floatToPcm16(count > 0 ? sum / count : 0)
    }
    carry = sourceIndex < merged.length ? merged.slice(sourceIndex) : new Float32Array(0)
    ws.send(out.buffer)
  }
}

function escapeRegExp(input: string): string {
  return String(input ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseAsrReplacementRules(raw: string): Array<[string, string]> {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*(?:=>|->|=)\s*(.*?)$/)
      if (!m) return null
      const from = String(m[1] ?? '').trim()
      const to = String(m[2] ?? '').trim()
      if (!from || !to) return null
      return [from, to] as [string, string]
    })
    .filter((x): x is [string, string] => Boolean(x))
    .sort((a, b) => b[0].length - a[0].length)
}

function parseAsrWordList(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw ?? '')
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length)
}

function normalizeAsrDisplayText(text: string): string {
  return String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([，。！？；：、,.!?;:])\s*/g, '$1')
    .replace(/([，。！？；：、,.!?;:]){2,}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function applyAsrLocalRules(
  text: string,
  asr: AppSettings['asr'] | undefined,
  opts?: { forInterim?: boolean },
): string {
  const raw = String(text ?? '')
  if (!raw) return ''
  if (!asr) return normalizeAsrDisplayText(raw)

  const replacements = parseAsrReplacementRules(asr.replaceRules ?? '')
  const fillerWords = parseAsrWordList(asr.fillerWords ?? '')
  const stripFillers = asr.stripFillers ?? true
  const ignoreCaseReplace = asr.ignoreCaseReplace ?? true
  const processInterim = asr.processInterim ?? false
  const forInterim = opts?.forInterim === true

  let out = raw
  for (const [from, to] of replacements) {
    const flags = ignoreCaseReplace ? 'gi' : 'g'
    out = out.replace(new RegExp(escapeRegExp(from), flags), to)
  }

  if (stripFillers && (!forInterim || processInterim)) {
    for (const word of fillerWords) {
      out = out.replace(new RegExp(escapeRegExp(word), 'g'), '')
    }
  }

  return normalizeAsrDisplayText(out)
}

function getOpenTypelessHealthUrlFromWs(rawUrl: string): string | null {
  try {
    const u = new URL(String(rawUrl ?? '').trim())
    if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !/^\/demo\/ws\/realtime\/?$/.test(u.pathname)) return null
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/health'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

async function waitForOpenTypelessAsrReady(rawWsUrl: string, opts?: { timeoutMs?: number }): Promise<boolean> {
  const healthUrl = getOpenTypelessHealthUrlFromWs(rawWsUrl)
  if (!healthUrl) return true

  const timeoutMs = Math.max(500, Math.trunc(opts?.timeoutMs ?? 25_000))
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const ac = new AbortController()
    const timer = window.setTimeout(() => ac.abort(), 1200)
    try {
      const res = await fetch(healthUrl, { method: 'GET', cache: 'no-store', signal: ac.signal })
      if (res.ok) return true
    } catch {
      /* ignore */
    } finally {
      window.clearTimeout(timer)
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  }

  return false
}

function App() {
  const windowType = getWindowType()
  const api = useMemo(() => getApi(), [])

  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  if (windowType === 'chat') {
    return <ChatWindow api={api} />
  }

  if (windowType === 'settings') {
    return <SettingsWindow api={api} settings={settings} />
  }

  if (windowType === 'memory') {
    return <MemoryConsoleWindow api={api} settings={settings} />
  }

  if (windowType === 'orb') {
    return <OrbApp api={api} />
  }

  if (windowType === 'orb-menu') {
    return <OrbMenuWindow api={api} />
  }

  return <PetWindow />
}

export default App

type EffectiveChatMessage = {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

function collapseAssistantRuns(messages: ChatMessageRecord[]): EffectiveChatMessage[] {
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

function sliceTail<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  return items.slice(items.length - max)
}

function toLocalMediaSrc(mediaPath: string): string {
  const p = String(mediaPath ?? '').trim()
  if (!p) return ''
  if (/^(https?:|file:|data:|blob:)/i.test(p)) return p
  if (/^[a-zA-Z]:[\\/]/.test(p)) return `file:///${p.replace(/\\/g, '/')}`
  if (p.startsWith('\\\\')) return `file:${p.replace(/\\/g, '/')}`
  if (p.startsWith('/')) return `file://${p}`
  return p
}

function MmvectorImagePreview(props: { api: ReturnType<typeof getApi> | null; imagePath: string; alt: string }) {
  const { api, imagePath, alt } = props
  const [src, setSrc] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(imagePath ?? '').trim()
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) return
    api
      .readChatAttachmentDataUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.dataUrl === 'string') setSrc(res.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, imagePath])

  return <img className="ndp-mmvector-image" src={src || toLocalMediaSrc(imagePath)} alt={alt} loading="lazy" />
}

function useLocalMediaUrl(api: ReturnType<typeof getApi> | null, inputPath: string): string {
  const [url, setUrl] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(inputPath ?? '').trim()
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) {
      setUrl(p)
      return
    }
    api
      .getChatAttachmentUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.url === 'string') setUrl(res.url)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, inputPath])

  return url || toLocalMediaSrc(inputPath)
}

function LocalVideo(props: {
  api: ReturnType<typeof getApi> | null
  videoPath: string
  className?: string
  controls?: boolean
  muted?: boolean
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
}) {
  const { api, videoPath, className, controls = true, muted, playsInline, preload } = props
  const src = useLocalMediaUrl(api, videoPath)
  return <video className={className} src={src} controls={controls} muted={muted} playsInline={playsInline} preload={preload} />
}


function normalizeAssistantDisplayText(text: string, opts?: { trim?: boolean }): string {
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

function buildInterruptedStreamContent(partialText: string, errorText: string): string {
  const partial = normalizeAssistantDisplayText(partialText, { trim: true })
  const err = String(errorText ?? '').trim()
  if (!partial) return `[错误] ${err || '未知错误'}`
  return err ? `${partial}\n\n[中断] ${err}` : `${partial}\n\n[中断]`
}

function toPlainTextFromChatContent(content: ChatMessage['content']): string {
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

function buildContextCompressionSummaryPrompt(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统'
    const text = toPlainTextFromChatContent(msg.content).trim()
    if (!text) continue
    lines.push(`${role}：${text}`)
  }
  return lines.join('\n\n').trim()
}

function extractLive2DTags(text: string): { displayText: string; expression?: string; motion?: string } {
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

function extractLastLive2DTags(text: string): { expression?: string; motion?: string } {
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

function normalizeMessageBlocks(m: ChatMessageRecord): ChatMessageBlock[] {
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

function joinTextBlocks(blocks: ChatMessageBlock[]): string {
  const parts = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String((b as { text: string }).text ?? '').trim())
    .filter(Boolean)
  return parts.join('\n\n')
}

function normalizeInterleavedTextSegment(text: string): string {
  return stripToolProtocolDisplayArtifacts(String(text ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/g, '')
    .replace(/\n+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function computeAppendDelta(prev: string, next: string): string {
  const p = String(prev ?? '')
  const n = String(next ?? '')
  if (!p) return n
  if (n.startsWith(p)) return n.slice(p.length)
  const pTrimEnd = p.replace(/\s+$/, '')
  if (pTrimEnd && n.startsWith(pTrimEnd)) return n.slice(pTrimEnd.length)
  return ''
}

function mergeLeadingPunctuationAcrossToolBoundary(segments: string[], runIds: string[]): string[] {
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

function pickRicherToolBlocks(a: ChatMessageBlock[], b: ChatMessageBlock[]): ChatMessageBlock[] {
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

function buildToolResultSystemAddon(task: TaskRecord): string {
  const t = task
  const lines: string[] = []
  lines.push('【工具执行结果】')
  lines.push(`任务：${t.title}`)
  lines.push(`状态：${t.status}`)

  const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
  if (runs.length > 0) {
    lines.push('')
    for (const r of runs.slice(0, 12)) {
      lines.push(`- ${r.toolName} (${r.status})`)
      if (r.inputPreview) lines.push(`  in: ${r.inputPreview}`)
      if (r.outputPreview) lines.push(`  out: ${r.outputPreview}`)
      if (r.error) lines.push(`  err: ${r.error}`)
    }
  } else {
    const steps = Array.isArray(t.steps) ? t.steps : []
    const useful = steps.filter((s) => s.tool || s.output || s.error)
    if (useful.length > 0) {
      lines.push('')
      for (const s of useful.slice(0, 12)) {
        const tool = typeof s.tool === 'string' ? s.tool : ''
        lines.push(`- ${tool || s.title} (${s.status})`)
        if (s.output) lines.push(`  out: ${String(s.output).slice(0, 800)}`)
        if (s.error) lines.push(`  err: ${String(s.error).slice(0, 800)}`)
      }
    }
  }

  if (t.lastError) {
    lines.push('')
    lines.push(`任务错误：${t.lastError}`)
  }

  lines.push('')
  lines.push('约束：以上为工具事实来源。最终回复只输出自然语言结果，不要提到工具内部名/执行日志。')
  return lines.join('\n')
}

function buildWorldBookAddon(settings: AppSettings | null | undefined, activePersonaId: string): string {
  const worldBook = settings?.worldBook
  if (!worldBook || worldBook.enabled === false) return ''

  const activeTagKeys = new Set(
    (Array.isArray(worldBook.activeTagIds) ? worldBook.activeTagIds : [])
      .map((tag) => String(tag ?? '').trim().toLowerCase())
      .filter(Boolean),
  )
  const personaId = String(activePersonaId ?? '').trim() || 'default'
  const entriesRaw = Array.isArray(worldBook.entries) ? worldBook.entries : []
  const entries = entriesRaw
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!entry || entry.enabled === false) return false
      const content = String(entry.content ?? '').trim()
      if (!content) return false
      if (entry.scope === 'persona') {
        const entryPersonaId = String(entry.personaId ?? '').trim()
        if (entryPersonaId && entryPersonaId !== personaId) return false
      }
      const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag ?? '').trim()).filter(Boolean) : []
      if (tags.length === 0) return true
      return tags.some((tag) => activeTagKeys.has(tag.toLowerCase()))
    })
    .sort((a, b) => {
      const priorityA = Number.isFinite(a.entry.priority) ? a.entry.priority : 100
      const priorityB = Number.isFinite(b.entry.priority) ? b.entry.priority : 100
      if (priorityA !== priorityB) return priorityA - priorityB
      const updatedA = Number.isFinite(a.entry.updatedAt) ? a.entry.updatedAt : 0
      const updatedB = Number.isFinite(b.entry.updatedAt) ? b.entry.updatedAt : 0
      if (updatedA !== updatedB) return updatedB - updatedA
      return a.index - b.index
    })

  if (entries.length === 0) return ''

  const maxCharsRaw = Number.isFinite(worldBook.maxChars) ? Math.trunc(worldBook.maxChars) : 6000
  const maxChars = Math.max(500, Math.min(30000, maxCharsRaw))
  const lines: string[] = [
    '【设定库（世界书，当前启用）】',
    '规则：以下为用户手写的长期设定上下文；与更高优先级系统规则冲突时服从系统规则。',
  ]
  let current = lines.join('\n')

  const appendChunk = (chunk: string): boolean => {
    const sep = current ? '\n\n' : ''
    const next = `${current}${sep}${chunk}`
    if (next.length <= maxChars) {
      current = next
      return true
    }

    const suffix = '\n...（设定库已按最大字符数截断）'
    const remaining = maxChars - current.length - sep.length - suffix.length
    if (remaining > 80) {
      current = `${current}${sep}${chunk.slice(0, remaining).trimEnd()}${suffix}`
    } else if (!current.includes('设定库已按最大字符数截断')) {
      current = `${current.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
    }
    return false
  }

  for (const { entry } of entries) {
    const e = entry as WorldBookEntry
    const title = String(e.title ?? '').trim() || '未命名设定'
    const tags = Array.isArray(e.tags) ? e.tags.map((tag) => String(tag ?? '').trim()).filter(Boolean) : []
    const content = String(e.content ?? '').trim()
    const chunkLines = [`[${title}]`]
    if (tags.length > 0) chunkLines.push(`标签：${tags.join('、')}`)
    if (e.scope === 'persona') chunkLines.push(`作用域：当前角色（${String(e.personaId ?? personaId).trim() || personaId}）`)
    chunkLines.push(`内容：${content}`)
    if (!appendChunk(chunkLines.join('\n'))) break
  }

  return current.trim()
}

function trimTrailingCommaForSegment(text: string): string {
  const raw = String(text ?? '')
  const trimmed = raw.replace(/[，,]\s*$/u, '').trimEnd()
  return trimmed || raw
}

function extractQuotedTtsParts(text: string): string[] {
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

function normalizeTtsRegexFlags(rawFlags: string): string {
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

function resolveTtsPlaybackText(rawText: string, tts: AppSettings['tts'] | null | undefined): string {
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

function isLikelyTtsSentenceBoundary(text: string): boolean {
  const raw = String(text ?? '')
  const trimmed = raw.replace(/\s+$/g, '')
  if (!trimmed) return false
  const last = trimmed[trimmed.length - 1]
  return last === '\n' || /[。！？!?…]/u.test(last)
}

function countStableTtsSegments(text: string, segments: string[], forceAll: boolean): number {
  if (segments.length === 0) return 0
  if (forceAll) return segments.length
  if (isLikelyTtsSentenceBoundary(text)) return segments.length
  return Math.max(0, segments.length - 1)
}

type PlannerDecision =
  | { type: 'create_task'; assistantReply: string; task: TaskCreateArgs }
  | { type: 'need_info'; assistantReply: string; questions?: string[] }
  | { type: 'chat'; assistantReply: string }

function extractFirstJsonObject(text: string): string | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function normalizePlannerTask(raw: unknown): TaskCreateArgs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!title) return null

  const queue = typeof obj.queue === 'string' ? obj.queue.trim() : undefined
  const why = typeof obj.why === 'string' ? obj.why.trim() : undefined

  const stepsRaw = Array.isArray(obj.steps) ? (obj.steps as unknown[]) : []
  const steps = stepsRaw.slice(0, 20).map((step) => {
    const s = step && typeof step === 'object' && !Array.isArray(step) ? (step as Record<string, unknown>) : {}
    const tool = typeof s.tool === 'string' ? s.tool.trim() : undefined
    const title = typeof s.title === 'string' ? s.title.trim() : tool ? tool : '步骤'

    let input: string | undefined
    if (typeof s.input === 'string') input = s.input
    else if (s.input && (typeof s.input === 'object' || Array.isArray(s.input))) {
      try {
        input = JSON.stringify(s.input)
      } catch {
        input = undefined
      }
    }

    return { title, tool, input }
  })

  return { queue: queue as TaskCreateArgs['queue'], title, why, steps }
}

function parsePlannerDecision(text: string): PlannerDecision | null {
  const jsonStr = extractFirstJsonObject(text)
  if (!jsonStr) return null

  let obj: unknown
  try {
    obj = JSON.parse(jsonStr) as unknown
  } catch {
    return null
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const root = obj as Record<string, unknown>
  const type = typeof root.type === 'string' ? root.type.trim() : ''
  const assistantReply = typeof root.assistantReply === 'string' ? root.assistantReply.trim() : ''

  if (type === 'need_info') {
    const qRaw = Array.isArray(root.questions) ? (root.questions as unknown[]) : []
    const questions = qRaw.filter((x) => typeof x === 'string').map((x) => String(x).trim()).filter(Boolean)
    return {
      type: 'need_info',
      assistantReply: assistantReply || (questions[0] ? questions.join('\n') : '我还需要你补充一些信息。'),
      questions: questions.length ? questions : undefined,
    }
  }

  if (type === 'create_task') {
    const task = normalizePlannerTask(root.task)
    if (!task) return null
    return {
      type: 'create_task',
      assistantReply: assistantReply || `好的，我会开始执行：${task.title}`,
      task,
    }
  }

  if (type === 'chat') {
    return { type: 'chat', assistantReply: assistantReply || '' }
  }

  return null
}

function isToolCapabilityQuestion(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  return /(?:你|桌宠|明澈).{0,8}(?:能做什么|会做什么|有什么能力|有哪些工具|工具列表|怎么用工具|支持哪些工具)/u.test(raw)
}

function requestLikelyNeedsToolAction(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw || isToolCapabilityQuestion(raw)) return false

  const actionPatterns = [
    /(?:截图|截屏|当前画面|当前页面|当前视频|播放.{0,8}内容|看剧|识图|看图|分析.{0,8}(?:图片|截图|画面|视频))/u,
    /(?:搜索|搜一下|帮我搜|查一下|查询|查找|检索|最新|实时|新闻|官网|价格|定价|来源|链接)/u,
    /(?:打开|进入|点击|填写|提交|登录|下载|安装|运行|执行|调用|读取|读一下|写入|保存|创建|生成文件|修改|修复|复制|移动|压缩|解压)/u,
    /(?:调用工具|用工具|别只说|不要只说|实际操作|帮我弄|处理一下)/u,
  ]
  return actionPatterns.some((re) => re.test(raw))
}

function buildPlannerSystemPrompt(opts?: {
  systemPrompt?: string
  toolNames?: string[]
  expressions?: string[]
  motions?: string[]
}): string {
  const lines: string[] = []
  lines.push('你是 NeoDeskPet 的“任务规划器（Planner）”。你的工作是：根据用户的自然语言请求，决定是否要创建“可执行任务（Task）”，并输出严格 JSON。')
  const systemPrompt = (opts?.systemPrompt ?? '').trim()
  if (systemPrompt) {
    lines.push('')
    lines.push('桌宠人设（assistantReply 必须遵循）：')
    lines.push(systemPrompt)
  }

  const expressions = (opts?.expressions ?? []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  const motions = (opts?.motions ?? []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  if (expressions.length > 0 || motions.length > 0) {
    lines.push('')
    lines.push('Live2D 可用表情/动作（可选，不需要就不要写标签）：')
    if (expressions.length > 0) lines.push(`- 表情：${expressions.slice(0, 20).join('、')}`)
    if (motions.length > 0) lines.push(`- 动作组：${motions.slice(0, 10).join('、')}`)
    lines.push('可以在 assistantReply 的开头或第一句末尾（前20字）选择性加标签：')
    lines.push('- [表情:表情名称]')
    lines.push('- [动作:动作组名称]')
    lines.push('要点：')
    lines.push('- 如果 assistantReply 非空，建议根据语气选择 1 个表情标签（可选）。')
    lines.push('- 不需要变化就不要写标签，没有标签就不会触发。')
    lines.push('- 如果写了标签，名称必须从上面可用列表中选，禁止编造。')
    lines.push('- 为降低界面延迟，尽量前置标签（前20字）。')
  }

  const toolNames = (opts?.toolNames ?? getBuiltinToolDefinitions().map((t) => t.name))
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)

  lines.push('')
  lines.push('你只能输出一个 JSON 对象，禁止输出 Markdown、代码块、解释文字。')
  lines.push('')
  lines.push('优化目标：优先选择“延迟最低且成功率高”的方案；只有在必要时才用更重的工具。')
  lines.push('')
  lines.push('你有三种输出类型：')
  lines.push('1) create_task：当用户想让桌宠做事（抓取网页/截图/运行命令/写文件/总结等）时。')
  lines.push('2) need_info：当信息不足以执行时（例如“抓取B站”但没有 URL/关键词/目标）。你要用一句话追问。')
  lines.push('3) chat：普通闲聊/不需要工具时。')
  lines.push('')
  lines.push('输出 JSON 结构：')
  lines.push('- create_task:')
  lines.push(
    '  {"type":"create_task","assistantReply":"...","task":{"queue":"browser|file|cli|chat|learning|play|other","title":"...","why":"...","steps":[{"title":"...","tool":"...","input":"..."}]}}',
  )
  lines.push('- need_info:')
  lines.push('  {"type":"need_info","assistantReply":"...","questions":["..."]}')
  lines.push('- chat:')
  lines.push('  {"type":"chat","assistantReply":"..."}')
  lines.push('')
  lines.push(`工具列表（step.tool 只能从这里选）：${toolNames.join(', ')}`)
  lines.push('')
  lines.push('各工具输入约定（step.input 必须是字符串；如果是 JSON，请把 JSON stringify 成字符串）：')
  lines.push('- browser.fetch：{"url":"https://...","maxChars":5000,"timeoutMs":15000,"stripHtml":false}')
  lines.push('- browser.open：{"url":"https://...","appPath":"(可选)指定浏览器exe","args":["(可选)启动参数"]}（仅“打开网站/保持登录态”优先用这个）')
  lines.push(
    '- browser.playwright：{"url":"https://...","headless":true,"channel":"msedge","profile":"default","screenshot":{"path":"task-output/xxx.png","fullPage":false},"extract":{"selector":"body","format":"innerText|text|html","maxChars":1200,"optional":true},"actions":[{"type":"waitMs","ms":1200},{"type":"click","selector":"..."},{"type":"fill","selector":"...","text":"..."},{"type":"press","selector":"...","key":"Enter"},{"type":"waitForLoad","state":"networkidle"}]}（省略 extract 表示不提取页面文本；只“打开网页”不要加 extract）',
  )
  lines.push('- file.write：{"path":"task-output/xxx.txt"} 或 {"filename":"xxx.txt","content":"...","append":false,"encoding":"utf8"}')
  lines.push('- cli.exec："dir"（字符串命令）或 {"cmd":"powershell","args":["-NoProfile","-Command","..."]}')
  lines.push('- llm.summarize / llm.chat：{"prompt":"...","system":"(可选)","maxTokens":1200}')
  lines.push('- image.inspect：{"path":"task-output/xxx.png","prompt":"描述图片内容","maxTokens":600}（截图后看图/识图用这个，不需要 filesystem MCP）')
  lines.push('- delay.sleep：{"ms":200}')
  lines.push('')
  lines.push('策略：')
  lines.push('- 能直接执行就 create_task；缺信息就 need_info；都不是就 chat。')
  lines.push('- 行动请求：用户明确要求截图、识图、搜索/查询最新信息、打开并操作网页、读取/写入/修改文件、运行命令、下载/安装/执行程序时，优先输出 create_task；但普通聊天、解释、角色互动、情绪交流或不需要真实工具结果的请求应输出 chat。')
  lines.push('- 如果用户是在询问“你能做什么/有哪些工具/工具列表/能力说明”，一律输出 chat：列出可用工具与典型用法示例，不要创建任务、更不要实际执行。')
  lines.push('- 抓取/总结网页：优先 browser.fetch（更快）；遇到动态/需要登录/需要点击交互，才用 browser.playwright。')
  lines.push('- 仅“打开某网站”且不需要后续操作时才用 browser.open；需要搜索/点击/截图/登录/读取页面状态时用 browser.playwright。')
  lines.push('- 用户要求“看截图/识图/分析画面”时，使用 image.inspect 读取应用生成图片路径。')
  lines.push('- assistantReply 用中文，简短说明你要做什么/需要什么，并尽量点出将使用的 tool。语气/人设只允许来自“桌宠人设”。')
  return lines.join('\n')
}

function PetWindow() {
  const api = useMemo(() => getApi(), [])
  const isDragging = useRef(false)
  const [windowDragging, setWindowDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isOverModel = useRef(true)
  const clickStartTime = useRef(0)
  const dragPointerId = useRef<number | null>(null)
  const lastDragPoint = useRef<{ x: number; y: number } | null>(null)
  const dragMoveRafRef = useRef<number>(0)
  const pendingDragPointRef = useRef<{ x: number; y: number } | null>(null)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const ttsPlayerRef = useRef<TtsPlayer | null>(null)
  const bubbleTtsQueueRef = useRef<string[]>([])
  const bubbleTtsRunningRef = useRef(false)
  const ttsQueueRef = useRef<
    { utteranceId: string; segments: string[]; finalized: boolean; playIndex: number } | null
  >(null)
  const ttsQueueWakeRef = useRef<(() => void) | null>(null)
  const ttsQueueRunningRef = useRef(false)
  const ttsActiveUtteranceRef = useRef<string | null>(null)
  const [mouthOpen, setMouthOpen] = useState(0)
  type BubbleUiPayload = {
    text: string
    startAt: number | null
    mode: 'typing' | 'append'
    autoHideDelay?: number
    animateAppend?: boolean
    resetAppendFromEmpty?: boolean
  }
  const [bubblePayload, setBubblePayload] = useState<BubbleUiPayload | null>(null)
  const [bubblePinnedPayload, setBubblePinnedPayload] = useState<(BubbleUiPayload & { id: number }) | null>(null)
  const bubblePayloadRef = useRef<BubbleUiPayload | null>(null)
  const bubblePinnedPayloadRef = useRef<(BubbleUiPayload & { id: number }) | null>(null)
  const bubblePinnedSeqRef = useRef(0)
  const bubblePreviewActiveRef = useRef(false)
  const bubblePreviewStartAtRef = useRef<number | null>(null)
  const bubblePreviewTextRef = useRef('')
  const bubblePreviewDebugAtRef = useRef(0)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null)
  const toolAnimRef = useRef<{ motionGroups: string[]; expressions: string[] }>({ motionGroups: [], expressions: [] })
  const taskPanelRef = useRef<HTMLDivElement | null>(null)
  const lastTaskPanelRectSigRef = useRef<string>('')

  // 默认不提供任何“固定人设台词”，避免与 AI 设置里的人设割裂
  const defaultPhrases: string[] = []

  const [asrSubtitle, setAsrSubtitle] = useState<string>('')
  const [asrRecording, setAsrRecording] = useState(false)
  const asrSubtitleHideTimerRef = useRef<number | null>(null)

  const asrClientRef = useRef<{
    ws: WebSocket
    protocol: 'legacy' | 'opentypeless'
    mediaStream: MediaStream
    audioContext: AudioContext
    node: AudioNode
    sink: GainNode
    stopFeeder: () => void
    sampleRate: number
  } | null>(null)
  const asrStartingRef = useRef(false)
  const asrStartKindRef = useRef<'continuous' | 'hotkey' | null>(null)
  const asrFinalSegmentsRef = useRef<string[]>([])
  const asrPartialRef = useRef<string>('')
  const asrComposeBaseTextRef = useRef<string>('')
  const asrComposeBaseControlledRef = useRef(false)

  const clearAsrSubtitleTimer = useCallback(() => {
    if (asrSubtitleHideTimerRef.current) {
      window.clearTimeout(asrSubtitleHideTimerRef.current)
      asrSubtitleHideTimerRef.current = null
    }
  }, [])

  const buildAsrCompositeSubtitle = useCallback(() => {
    const hasExternalBaseControl = asrComposeBaseControlledRef.current
    const externalBase = hasExternalBaseControl ? asrComposeBaseTextRef.current.trim() : ''
    const finals = asrFinalSegmentsRef.current.map((s) => s.trim()).filter(Boolean)
    const partial = asrPartialRef.current.trim()
    // 只要聊天窗口已接管“累计基线”，即使基线被清空为 ''，也不能回退到本地 finals，
    // 否则会出现“输入框清空了但字幕还显示旧累计”的错位。
    if (hasExternalBaseControl) return partial ? `${externalBase} ${partial}`.trim() : externalBase
    if (finals.length > 0 && partial) return `${finals.join(' ')} ${partial}`.trim()
    if (finals.length > 0) return finals.join(' ').trim()
    return partial
  }, [])

  const showAsrSubtitle = useCallback(
    (text: string, options?: { autoHideMs?: number }) => {
      clearAsrSubtitleTimer()

      const asr = settingsRef.current?.asr
      if (!asr?.showSubtitle) return

      setAsrSubtitle(text)
      const ms = Math.max(0, Math.min(30000, Math.floor(options?.autoHideMs ?? 0)))
      if (ms > 0) {
        asrSubtitleHideTimerRef.current = window.setTimeout(() => {
          asrSubtitleHideTimerRef.current = null
          setAsrSubtitle('')
        }, ms)
      }
    },
    [clearAsrSubtitleTimer],
  )

  const syncAsrCompositeSubtitle = useCallback(
    (options?: { autoHideMs?: number }) => {
      showAsrSubtitle(buildAsrCompositeSubtitle(), options)
    },
    [buildAsrCompositeSubtitle, showAsrSubtitle],
  )

  const stopAsr = useCallback(() => {
    const client = asrClientRef.current
    if (!client) {
      asrStartingRef.current = false
      asrStartKindRef.current = null
      setAsrRecording(false)
      return
    }
    asrClientRef.current = null
    asrStartingRef.current = false
    asrStartKindRef.current = null
    setAsrRecording(false)

    try {
      client.stopFeeder()
    } catch (_) {
      /* ignore */
    }

    try {
      client.node.disconnect()
    } catch (_) {
      /* ignore */
    }

    try {
      client.sink.disconnect()
    } catch (_) {
      /* ignore */
    }

    try {
      client.audioContext.close()
    } catch (_) {
      /* ignore */
    }

    try {
      client.mediaStream.getTracks().forEach((t) => t.stop())
    } catch (_) {
      /* ignore */
    }

    try {
      if (client.protocol === 'opentypeless' && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send('stop')
        window.setTimeout(() => {
          try {
            client.ws.close()
          } catch (_) {
            /* ignore */
          }
        }, 120)
      } else {
        client.ws.close()
      }
    } catch (_) {
      /* ignore */
    }
  }, [])

  const sendAsrConfig = useCallback(() => {
    const client = asrClientRef.current
    if (!client) return
    if (client.ws.readyState !== WebSocket.OPEN) return

    const asr = settingsRef.current?.asr
    if (!asr) return
    if (isOpenTypelessAsrWsUrl(asr.wsUrl)) return

    client.ws.send(
      JSON.stringify({
        type: 'config',
        sampleRate: client.sampleRate,
        language: asr.language,
        useItn: asr.useItn,
        vadChunkMs: asr.vadChunkMs,
        maxEndSilenceMs: asr.maxEndSilenceMs,
        minSpeechMs: asr.minSpeechMs,
        maxSpeechMs: asr.maxSpeechMs,
        prerollMs: asr.prerollMs,
        postrollMs: asr.postrollMs,
        enableAgc: asr.enableAgc,
        agcTargetRms: asr.agcTargetRms,
        agcMaxGain: asr.agcMaxGain,
        debug: asr.debug,
      }),
    )
  }, [])

  const handleAsrWsText = useCallback(
    (raw: string) => {
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      const msg = payload as { type?: string; text?: string; message?: string; error?: string }
      const msgTypeRaw = String(msg.type ?? '').trim()
      const msgType = msgTypeRaw.toLowerCase()
      const msgTypeNorm = msgType.replace(/[^a-z]/g, '')
      const text = String(msg.text ?? '').trim()

      if (
        msgTypeNorm === 'partial' ||
        msgTypeNorm === 'partialresult' ||
        msgTypeNorm === 'interim' ||
        msgTypeNorm === 'interimresult' ||
        msgTypeNorm === 'midresult' ||
        msgTypeNorm === 'intermediateresult' ||
        (msgTypeNorm.includes('partial') && msgTypeNorm.includes('result'))
      ) {
        const asr = settingsRef.current?.asr
        const interimText = applyAsrLocalRules(text, asr, { forInterim: true })
        asrPartialRef.current = interimText
        syncAsrCompositeSubtitle()
        return
      }

      if (
        msgTypeNorm === 'result' ||
        msgTypeNorm === 'final' ||
        msgTypeNorm === 'finalresult' ||
        (msgTypeNorm.includes('final') && msgTypeNorm.includes('result'))
      ) {
        asrPartialRef.current = ''
        if (!text) return

        const asr = settingsRef.current?.asr
        const finalText = applyAsrLocalRules(text, asr, { forInterim: false })
        if (!finalText) return
        const mode = asr?.mode ?? 'continuous'
        if (mode === 'hotkey') {
          asrFinalSegmentsRef.current.push(finalText)
          syncAsrCompositeSubtitle()
          return
        }

        const autoSend = Boolean(asr?.autoSend)
        if (!autoSend) {
          asrFinalSegmentsRef.current.push(finalText)
        }

        // continuous: 保持“最终结果 + 当前中间结果”连续显示，避免新一段中间结果覆盖已确认文本。
        syncAsrCompositeSubtitle({ autoHideMs: 6000 })
        try {
          api?.reportAsrTranscript(finalText)
        } catch (_) {
          /* ignore */
        }
        if (autoSend) {
          asrFinalSegmentsRef.current = []
          syncAsrCompositeSubtitle({ autoHideMs: 0 })
        }
        return
      }

      if (msgTypeNorm === 'error') {
        const errText = String(msg.error ?? msg.message ?? msg.text ?? '').trim()
        if (errText) showAsrSubtitle(`ASR 错误：${errText}`, { autoHideMs: 5000 })
        return
      }

      if (msgTypeNorm === 'ready') {
        if (settingsRef.current?.asr?.debug ?? false) {
          console.debug('[ASR] ready', payload)
        }
        return
      }

      if (msgTypeNorm === 'debug' || msgTypeNorm === 'log') {
        const hint = String(msg.message ?? msg.error ?? '').trim()
        if (hint && (settingsRef.current?.asr?.debug ?? false)) {
          console.debug('[ASR]', hint)
        }
      }
    },
    [api, showAsrSubtitle, syncAsrCompositeSubtitle],
  )

  const startAsr = useCallback(async () => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (asrClientRef.current) return
    if (asrStartingRef.current) return
    asrStartingRef.current = true

    try {
      const wsUrl = asr.wsUrl.trim()
      if (!wsUrl) {
        showAsrSubtitle('ASR WebSocket 地址为空', { autoHideMs: 4000 })
        return
      }
      const useOpenTypelessWs = isOpenTypelessAsrWsUrl(wsUrl)
      asrFinalSegmentsRef.current = []
      asrPartialRef.current = ''

      if (useOpenTypelessWs) {
        showAsrSubtitle('ASR API 启动中…')
        const ready = await waitForOpenTypelessAsrReady(wsUrl, { timeoutMs: 30_000 })
        if (!ready) {
          showAsrSubtitle('ASR API 启动超时', { autoHideMs: 5000 })
          return
        }
        if (!(settingsRef.current?.asr?.enabled ?? false)) return
      }

      const pickStream = async () => {
        const deviceId = (asr.micDeviceId || '').trim()
        const base: MediaTrackConstraints = {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }

        if (!deviceId) {
          return navigator.mediaDevices.getUserMedia({ audio: base })
        }

        // 优先尝试 exact；失败时尝试 ideal；再失败回退系统默认
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
        } catch (_e1) {
          try {
            return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { ideal: deviceId } } })
          } catch (_e2) {
            return navigator.mediaDevices.getUserMedia({ audio: base })
          }
        }
      }

      const mediaStream = await pickStream()

      // OpenTypeless 实时 ws 默认使用 16kHz PCM16，优先直接请求 16k 采样率以减少前端重采样开销。
      let audioContext: AudioContext
      try {
        audioContext = useOpenTypelessWs ? new AudioContext({ sampleRate: 16000 }) : new AudioContext()
      } catch {
        audioContext = new AudioContext()
      }
      const sampleRate = audioContext.sampleRate || 48000

      const source = audioContext.createMediaStreamSource(mediaStream)

      // 避免把麦克风音频直通到扬声器造成回声/啸叫
      const sink = audioContext.createGain()
      sink.gain.value = 0
      sink.connect(audioContext.destination)

      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'

      const bufferSize = 4096

      const sendPcm = useOpenTypelessWs
        ? createOpenTypelessPcmSender(ws, sampleRate)
        : (pcm: Float32Array) => {
            if (ws.readyState !== WebSocket.OPEN) return
            const copy = new Float32Array(pcm.length)
            copy.set(pcm)
            ws.send(copy.buffer)
          }

      let node: AudioNode
      let stopFeeder: () => void

      const tryCreateWorklet = async () => {
        const backend = (settingsRef.current?.asr?.captureBackend ?? 'auto') as 'auto' | 'script' | 'worklet'
        if (backend === 'script') return null
        if (!audioContext.audioWorklet) return null

        const workletCode = `
class NdpPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${bufferSize});
    this._idx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      let off = 0;
      while (off < ch.length) {
        const take = Math.min(ch.length - off, this._buf.length - this._idx);
        this._buf.set(ch.subarray(off, off + take), this._idx);
        this._idx += take;
        off += take;
        if (this._idx >= this._buf.length) {
          this.port.postMessage(this._buf, [this._buf.buffer]);
          this._buf = new Float32Array(${bufferSize});
          this._idx = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ndp-pcm', NdpPcmProcessor);
`
        const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' }))
        try {
          await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
          URL.revokeObjectURL(blobUrl)
        }

        const workletNode = new AudioWorkletNode(audioContext, 'ndp-pcm', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        })

        workletNode.port.onmessage = (ev) => {
          const buf = ev.data
          if (buf instanceof Float32Array) {
            sendPcm(buf)
            return
          }
          if (buf instanceof ArrayBuffer) {
            sendPcm(new Float32Array(buf))
          }
        }

        source.connect(workletNode)
        workletNode.connect(sink)

        const stop = () => {
          try {
            workletNode.port.onmessage = null
          } catch (_) {
            /* ignore */
          }
          try {
            source.disconnect(workletNode)
          } catch (_) {
            /* ignore */
          }
          try {
            workletNode.disconnect()
          } catch (_) {
            /* ignore */
          }
        }

        return { node: workletNode, stop }
      }

      const created = await (async () => {
        const backend = (settingsRef.current?.asr?.captureBackend ?? 'auto') as 'auto' | 'script' | 'worklet'
        if (backend === 'worklet' && !audioContext.audioWorklet) {
          showAsrSubtitle('当前环境不支持 AudioWorklet，已回退为 ScriptProcessor', { autoHideMs: 4000 })
          return null
        }
        return tryCreateWorklet()
      })()
      if (created) {
        node = created.node
        stopFeeder = created.stop
      } else {
        const proc = audioContext.createScriptProcessor(bufferSize, 1, 1)
        proc.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0)
          sendPcm(input)
        }
        source.connect(proc)
        proc.connect(sink)

        node = proc
        stopFeeder = () => {
          try {
            proc.onaudioprocess = null
          } catch (_) {
            /* ignore */
          }
          try {
            source.disconnect(proc)
          } catch (_) {
            /* ignore */
          }
          try {
            proc.disconnect()
          } catch (_) {
            /* ignore */
          }
        }
      }

      ws.addEventListener('open', () => {
        sendAsrConfig()
        setAsrRecording(true)
        showAsrSubtitle('录音中…')
      })
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          handleAsrWsText(ev.data)
          return
        }
        if (ev.data instanceof ArrayBuffer) {
          try {
            const text = new TextDecoder('utf-8').decode(new Uint8Array(ev.data))
            handleAsrWsText(text)
          } catch {
            /* ignore */
          }
        }
      })
      ws.addEventListener('error', () => {
        showAsrSubtitle('ASR 连接失败', { autoHideMs: 4000 })
      })
      ws.addEventListener('close', () => {
        if (asrClientRef.current?.ws === ws) {
          asrClientRef.current = null
          setAsrRecording(false)
        }
      })

      asrClientRef.current = {
        ws,
        protocol: useOpenTypelessWs ? 'opentypeless' : 'legacy',
        mediaStream,
        audioContext,
        node,
        sink,
        stopFeeder,
        sampleRate,
      }
      showAsrSubtitle('ASR 连接中…')
    } finally {
      asrStartingRef.current = false
    }
  }, [handleAsrWsText, sendAsrConfig, showAsrSubtitle])

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  useEffect(() => {
    if (!api) return
    let disposed = false
    api
      .getContextUsage()
      .then((snap) => {
        if (disposed) return
        setContextUsage(snap)
      })
      .catch(() => {
        /* ignore */
      })
    const off = api.onContextUsageChanged((snap) => {
      if (disposed) return
      setContextUsage(snap)
    })
    return () => {
      disposed = true
      off()
    }
  }, [api])

  // Listen for task list updates (M2 mini panel)
  useEffect(() => {
    if (!api) return

    let disposed = false
    api
      .listTasks()
      .then((res) => {
        if (disposed) return
        setTasks(res.items ?? [])
      })
      .catch((err) => console.error(err))

    const off = api.onTasksChanged((payload) => setTasks(payload.items ?? []))
    return () => {
      disposed = true
      api.setPetOverlayHover(false)
      off()
    }
  }, [api])

  // Task (agent.run) 最终回复里携带的 Live2D 标签：优先按 LLM 指定的表情/动作触发（不再退化为“总是第一个”）
  const taskLive2dInitRef = useRef(false)
  const lastTaskLive2dRef = useRef<Map<string, { expression?: string; motion?: string }>>(new Map())
  useEffect(() => {
    if (!api) return

    const expressions = toolAnimRef.current.expressions ?? []
    const motions = toolAnimRef.current.motionGroups ?? []
    const normalize = (s: unknown) => String(s ?? '').trim()

    const resolveExpression = (nameRaw: string): string | null => {
      const name = normalize(nameRaw)
      if (!name) return null
      if (expressions.includes(name)) return name
      const lower = name.toLowerCase()
      const hit = expressions.find((e) => e.toLowerCase() === lower) ?? null
      return hit
    }

    const resolveMotion = (nameRaw: string): string | null => {
      const name = normalize(nameRaw)
      if (!name) return null
      if (motions.includes(name)) return name
      const lower = name.toLowerCase()
      const hit = motions.find((m) => m.toLowerCase() === lower) ?? null
      return hit
    }

    const next = new Map<string, { expression?: string; motion?: string }>()

    for (const t of tasks) {
      const expression = normalize((t as unknown as { live2dExpression?: unknown }).live2dExpression) || undefined
      const motion = normalize((t as unknown as { live2dMotion?: unknown }).live2dMotion) || undefined
      next.set(t.id, { expression, motion })

      if (!taskLive2dInitRef.current) continue

      const prev = lastTaskLive2dRef.current.get(t.id)
      if (expression && expression !== prev?.expression) {
        const exp = resolveExpression(expression)
        if (exp) api.triggerExpression(exp)
      }
      if (motion && motion !== prev?.motion) {
        const m = resolveMotion(motion)
        if (m) api.triggerMotion(m, 0)
      }
    }

    lastTaskLive2dRef.current = next
    if (!taskLive2dInitRef.current) taskLive2dInitRef.current = true
  }, [api, tasks])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    bubblePayloadRef.current = bubblePayload
  }, [bubblePayload])

  useEffect(() => {
    bubblePinnedPayloadRef.current = bubblePinnedPayload
  }, [bubblePinnedPayload])

  const asrEnabled = settings?.asr?.enabled ?? false
  const asrMode = settings?.asr?.mode ?? 'continuous'
  const asrWsUrl = settings?.asr?.wsUrl ?? ''
  const asrMicDeviceId = settings?.asr?.micDeviceId ?? ''
  const asrShowSubtitle = settings?.asr?.showSubtitle ?? true

  useEffect(() => {
    if (!asrShowSubtitle) {
      setAsrSubtitle('')
      clearAsrSubtitleTimer()
    }
  }, [asrShowSubtitle, clearAsrSubtitleTimer])

  useEffect(() => {
    if (!api) return
    return api.onAsrComposePreview((payload) => {
      const baseText = typeof payload?.baseText === 'string' ? payload.baseText : ''
      asrComposeBaseControlledRef.current = true
      asrComposeBaseTextRef.current = baseText
      if (payload?.clearFinals) {
        asrFinalSegmentsRef.current = []
      }
      syncAsrCompositeSubtitle()
    })
  }, [api, syncAsrCompositeSubtitle])

  // hotkey toggle: press once to start, press again to stop (only when mode=hotkey)
  useEffect(() => {
    if (!api) return

    return api.onAsrHotkeyToggle(() => {
      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return
      if ((asr.mode ?? 'continuous') !== 'hotkey') return

      if (asrClientRef.current) {
        stopAsr()
        const parts = [...asrFinalSegmentsRef.current]
        if (asrPartialRef.current.trim()) parts.push(asrPartialRef.current.trim())
        asrFinalSegmentsRef.current = []
        asrPartialRef.current = ''

        const finalText = parts.join(' ').trim()
        if (finalText) {
          try {
            api.reportAsrTranscript(finalText)
          } catch (_) {
            /* ignore */
          }
          showAsrSubtitle(finalText, { autoHideMs: 6000 })
        } else {
          showAsrSubtitle('', { autoHideMs: 0 })
        }
        return
      }

      asrFinalSegmentsRef.current = []
      asrPartialRef.current = ''
      asrStartKindRef.current = 'hotkey'
      void startAsr().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[ASR] start failed:', msg)
        showAsrSubtitle('ASR 启动失败', { autoHideMs: 4000 })
        stopAsr()
      })
    })
  }, [api, showAsrSubtitle, startAsr, stopAsr])

  // continuous mode: start/stop with switch (no hotkey needed)
  useEffect(() => {
    if (!asrEnabled) {
      stopAsr()
      return
    }

    if (asrMode !== 'continuous') {
      if (asrStartKindRef.current === 'continuous') stopAsr()
      return
    }

    if (asrStartKindRef.current !== 'continuous') {
      stopAsr()
      asrStartKindRef.current = 'continuous'
    }

    void startAsr().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[ASR] start failed:', msg)
      showAsrSubtitle('ASR 启动失败', { autoHideMs: 4000 })
      stopAsr()
    })
    return () => stopAsr()
  }, [asrEnabled, asrMicDeviceId, asrMode, asrWsUrl, showAsrSubtitle, startAsr, stopAsr])

  const asrConfigKey = useMemo(() => {
    const asr = settings?.asr
    if (!asr) return ''
    const payload = {
      language: asr.language,
      useItn: asr.useItn,
      vadChunkMs: asr.vadChunkMs,
      maxEndSilenceMs: asr.maxEndSilenceMs,
      minSpeechMs: asr.minSpeechMs,
      maxSpeechMs: asr.maxSpeechMs,
      prerollMs: asr.prerollMs,
      postrollMs: asr.postrollMs,
      enableAgc: asr.enableAgc,
      agcTargetRms: asr.agcTargetRms,
      agcMaxGain: asr.agcMaxGain,
      debug: asr.debug,
    }
    return JSON.stringify(payload)
  }, [settings?.asr])

  useEffect(() => {
    if (!asrEnabled) return
    if (!asrClientRef.current) return
    sendAsrConfig()
  }, [asrConfigKey, asrEnabled, sendAsrConfig])

  useEffect(() => {
    return () => {
      stopAsr()
      clearAsrSubtitleTimer()
    }
  }, [clearAsrSubtitleTimer, stopAsr])

  const applyBubblePreviewPayload = useCallback(
    (payload: { text?: string; clear?: boolean; placeholder?: boolean; autoHideDelay?: number; pinPrevious?: boolean }) => {
      const s = settingsRef.current
      if (!s) return
      const showBubble = s.bubble?.showOnChat ?? false
      const nowTs = Date.now()
      const debugPreview = (phase: string, data?: Record<string, unknown>) => {
        if (!api) return
        if (nowTs - bubblePreviewDebugAtRef.current < 180) return
        bubblePreviewDebugAtRef.current = nowTs
        try {
          api.appendDebugLog('pet:bubble.preview', { phase, ...(data ?? {}) })
        } catch {
          /* ignore */
        }
      }
      const commitBubblePayload = (next: BubbleUiPayload | null) => {
        try {
          flushSync(() => setBubblePayload(next))
        } catch {
          setBubblePayload(next)
        }
      }
      const commitPinnedBubblePayload = (next: (BubbleUiPayload & { id: number }) | null) => {
        try {
          flushSync(() => setBubblePinnedPayload(next))
        } catch {
          setBubblePinnedPayload(next)
        }
      }

      if (payload?.clear) {
        if (bubblePreviewActiveRef.current && showBubble) {
          commitBubblePayload(null)
        }
        commitPinnedBubblePayload(null)
        bubblePreviewActiveRef.current = false
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = ''
        debugPreview('clear', { showBubble })
        return
      }

      const rawText = typeof payload?.text === 'string' ? payload.text : ''
      const placeholder = payload?.placeholder === true
      const pinPrevious = payload?.pinPrevious === true
      const autoHideDelay =
        typeof payload?.autoHideDelay === 'number' && Number.isFinite(payload.autoHideDelay) ? payload.autoHideDelay : undefined

      if (pinPrevious && !bubblePreviewActiveRef.current) {
        const current = bubblePayloadRef.current
        const currentText = String(current?.text ?? '').trim()
        if (current && currentText) {
          const nextId = bubblePinnedSeqRef.current + 1
          bubblePinnedSeqRef.current = nextId
          const pinDelay = Math.max(2500, Math.min(15000, Math.floor(s.bubble?.autoHideDelay ?? 5000)))
          commitPinnedBubblePayload({
            id: nextId,
            text: current.text,
            startAt: Date.now(),
            mode: 'append',
            autoHideDelay: pinDelay,
          })
        }
      }

      if (placeholder) {
        bubblePreviewActiveRef.current = true
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = rawText.trim() || '思考中…'
        if (!showBubble) return
        commitBubblePayload({
          text: bubblePreviewTextRef.current,
          startAt: Date.now(),
          mode: 'typing',
          autoHideDelay: typeof autoHideDelay === 'number' ? autoHideDelay : 0,
          animateAppend: false,
          resetAppendFromEmpty: false,
        })
        debugPreview('placeholder', { len: bubblePreviewTextRef.current.length, text: bubblePreviewTextRef.current.slice(0, 32) })
        return
      }

      const firstContentAfterPlaceholder =
        bubblePreviewActiveRef.current && bubblePreviewTextRef.current.trim() === '思考中…' && rawText.trim() !== ''
      if (!rawText.trim()) return
      let startAt = bubblePreviewStartAtRef.current
      if (startAt == null) {
        startAt = Date.now()
        bubblePreviewStartAtRef.current = startAt
      }
      bubblePreviewActiveRef.current = true
      bubblePreviewTextRef.current = rawText
      if (!showBubble) return
      commitBubblePayload({
        text: rawText,
        startAt,
        mode: 'append',
        animateAppend: true,
        resetAppendFromEmpty: firstContentAfterPlaceholder,
        ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
      })
      debugPreview('text', { len: rawText.length, head: rawText.slice(0, 32), tail: rawText.slice(-24) })
    },
    [api],
  )

  // Listen for bubble messages from chat window
  useEffect(() => {
    if (!api) return
    return api.onBubblePreview((payload) => applyBubblePreviewPayload(payload ?? {}))
  }, [api, applyBubblePreviewPayload])

  useEffect(() => {
    if (!api) return
    return api.onBubbleMessage((message) => {
      const rawMessage = String(message ?? '')
      if (rawMessage.startsWith(BUBBLE_PREVIEW_FALLBACK_PREFIX)) {
        try {
          const payload = JSON.parse(rawMessage.slice(BUBBLE_PREVIEW_FALLBACK_PREFIX.length)) as {
            text?: string
            clear?: boolean
            placeholder?: boolean
            autoHideDelay?: number
            pinPrevious?: boolean
          }
          applyBubblePreviewPayload(payload ?? {})
          return
        } catch {
          // 兼容前缀解析失败时按普通消息继续处理
        }
      }

      const s = settingsRef.current
      if (!s) return

      const showBubble = s.bubble?.showOnChat ?? false
      const bubbleDelay = s.bubble?.autoHideDelay ?? 5000
      const normalizedMessage = String(message ?? '').trim()
      const canAdoptPreview =
        normalizedMessage.length > 0 &&
        bubblePreviewActiveRef.current &&
        bubblePreviewTextRef.current.trim() === normalizedMessage
      const previewStartAt = bubblePreviewStartAtRef.current
      const showBubbleTypingOrAdopt = (text: string, startNow: boolean) => {
        if (!showBubble) return
        if (canAdoptPreview) {
          const adoptedStart = previewStartAt ?? Date.now()
          bubblePreviewStartAtRef.current = adoptedStart
          setBubblePayload({ text, startAt: adoptedStart, mode: 'append', autoHideDelay: bubbleDelay })
          return
        }
        setBubblePayload({ text, startAt: startNow ? Date.now() : null, mode: 'typing' })
      }
      const finishPreviewSession = () => {
        bubblePreviewActiveRef.current = false
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = ''
      }
      const tts = s.tts ? { ...s.tts, segmented: false } : s.tts
      const useQueue = Boolean(tts?.enabled) && !(s.tts?.segmented ?? false)

      const startTypingNow = (text: string) => {
        showBubbleTypingOrAdopt(text, true)
      }

      if (tts?.enabled) {
        if (useQueue) {
          bubbleTtsQueueRef.current.push(message)
          if (bubbleTtsQueueRef.current.length > 20) {
            bubbleTtsQueueRef.current = bubbleTtsQueueRef.current.slice(-20)
          }

          if (bubbleTtsRunningRef.current) return
          bubbleTtsRunningRef.current = true

          void (async () => {
            try {
              while (bubbleTtsQueueRef.current.length > 0) {
                const next = bubbleTtsQueueRef.current.shift()
                const text = typeof next === 'string' ? next : ''
                if (!text.trim()) continue
                const speechText = resolveTtsPlaybackText(text, tts)
                if (!speechText) {
                  startTypingNow(text)
                  setMouthOpen(0)
                  continue
                }

                showBubbleTypingOrAdopt(text, false)
                if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
                const player = ttsPlayerRef.current
                if (!player) continue

                await new Promise<void>((resolve) => {
                  void player
                    .speak(speechText, tts, {
                      onFirstPlay: () => {
                        showBubbleTypingOrAdopt(text, true)
                      },
                      onEnded: () => {
                        setMouthOpen(0)
                        resolve()
                      },
                    })
                    .catch(() => {
                      // TTS 失败时也要能正常显示气泡
                      startTypingNow(text)
                      resolve()
                    })
                })
              }
            } finally {
              finishPreviewSession()
              bubbleTtsRunningRef.current = false
            }
          })()
          return
        }

        const speechText = resolveTtsPlaybackText(message, tts)
        if (!speechText) {
          finishPreviewSession()
          startTypingNow(message)
          setMouthOpen(0)
          return
        }

        showBubbleTypingOrAdopt(message, false)
        if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

        void ttsPlayerRef.current
          .speak(speechText, tts, {
            onFirstPlay: () => {
              showBubbleTypingOrAdopt(message, true)
            },
            onEnded: () => {
              setMouthOpen(0)
              finishPreviewSession()
            },
          })
          .catch(() => {
            // TTS 失败时也要能正常显示气泡
            startTypingNow(message)
            finishPreviewSession()
          })
        return
      }

      finishPreviewSession()
      startTypingNow(message)
    })
  }, [api, applyBubblePreviewPayload])

  // Listen for segmented TTS utterances from chat window
  useEffect(() => {
    if (!api) return

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

    const wakeQueue = () => {
      if (!ttsQueueWakeRef.current) return
      const w = ttsQueueWakeRef.current
      ttsQueueWakeRef.current = null
      w()
    }

    const runQueue = async () => {
      if (ttsQueueRunningRef.current) return
      ttsQueueRunningRef.current = true
      try {
        while (ttsQueueRef.current) {
          const current = ttsQueueRef.current
          const s = settingsRef.current
          if (!current || !s?.tts?.enabled || !s.tts.segmented) return

          if (current.playIndex >= current.segments.length) {
            if (current.finalized) {
              const utteranceId = current.utteranceId
              if (ttsActiveUtteranceRef.current === utteranceId) ttsActiveUtteranceRef.current = null
              ttsQueueRef.current = null
              setMouthOpen(0)
              setBubblePayload(null)
              api.reportTtsUtteranceEnded({ utteranceId })
              wakeQueue()
              return
            }

            await new Promise<void>((resolve) => {
              ttsQueueWakeRef.current = resolve
            })
            continue
          }

          const utteranceId = current.utteranceId
          const segmentIndex = current.playIndex
          current.playIndex = segmentIndex + 1
          const raw = String(current.segments[segmentIndex] ?? '')
          const segText = raw.trim()
          if (!segText) continue

          if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
          const player = ttsPlayerRef.current
          if (!player) continue

          ttsActiveUtteranceRef.current = utteranceId

          const showBubble = s.bubble?.showOnChat ?? false
          const bubbleDelay = s.bubble?.autoHideDelay ?? 5000
          const ttsSettings = { ...s.tts, streaming: true, segmented: false }
          const pauseMs = Math.max(0, Math.min(60000, Math.floor(s.tts.pauseMs ?? 0)))
          const speechText = resolveTtsPlaybackText(segText, s.tts)

          if (showBubble) setBubblePayload({ text: segText, startAt: null, mode: 'append', autoHideDelay: bubbleDelay })

          let ended = false
          let voiceReported = false

          const reportVoiceStart = () => {
            if (voiceReported) return
            voiceReported = true
            const spoken = trimTrailingCommaForSegment(segText)
            try {
              api.reportTtsSegmentStarted({ utteranceId, segmentIndex, text: spoken })
            } catch {
              /* ignore */
            }
            if (showBubble) {
              setBubblePayload({ text: spoken, startAt: Date.now(), mode: 'append', autoHideDelay: bubbleDelay })
            }
          }

          if (!speechText) {
            reportVoiceStart()
            setMouthOpen(0)
            if (pauseMs > 0) await sleep(Math.min(pauseMs, 200))
            continue
          }

          await new Promise<void>((resolve) => {
            void player
              .speak(speechText, ttsSettings, {
                onFirstPlay: () => {
                  const startedAt = Date.now()
                  const threshold = 0.006
                  const tick = () => {
                    if (ended) return
                    if (ttsActiveUtteranceRef.current !== utteranceId) return
                    const level = player.getLevel()
                    if (level >= threshold || Date.now() - startedAt > 1200) {
                      reportVoiceStart()
                      return
                    }
                    window.requestAnimationFrame(tick)
                  }
                  window.requestAnimationFrame(tick)
                },
                onEnded: () => {
                  ended = true
                  resolve()
                },
              })
              .catch((err) => {
                ended = true
                const msg = err instanceof Error ? err.message : String(err)
                try {
                  api.reportTtsUtteranceFailed({ utteranceId, error: msg })
                } catch {
                  /* ignore */
                }
                resolve()
              })
          })

          reportVoiceStart()
          if (pauseMs > 0) await sleep(pauseMs)
        }
      } finally {
        ttsQueueRunningRef.current = false
      }
    }

    const unsubEnqueue = api.onTtsEnqueue((payload) => {
      const s = settingsRef.current
      if (!s?.tts?.enabled || !s.tts.segmented) return

      if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

      const isReplace = payload.mode === 'replace'
      const prev = ttsQueueRef.current
      const differentUtterance = !prev || prev.utteranceId !== payload.utteranceId

      if (isReplace || differentUtterance) {
        if (prev && prev.utteranceId !== payload.utteranceId) {
          api.reportTtsUtteranceEnded({ utteranceId: prev.utteranceId })
        }
        ttsActiveUtteranceRef.current = null
        ttsPlayerRef.current?.stop()
        setMouthOpen(0)
        ttsQueueRef.current = {
          utteranceId: payload.utteranceId,
          segments: [],
          finalized: false,
          playIndex: 0,
        }
        setBubblePayload(null)
        wakeQueue()
      }

      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== payload.utteranceId) return

      if (payload.segments?.length) current.segments.push(...payload.segments)
      wakeQueue()
      void runQueue()
    })

    const unsubFinalize = api.onTtsFinalize((utteranceId) => {
      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== utteranceId) return
      current.finalized = true
      wakeQueue()
      void runQueue()
    })

    return () => {
      unsubEnqueue()
      unsubFinalize()
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onTtsStopAll(() => {
      const utteranceId = ttsActiveUtteranceRef.current ?? ttsQueueRef.current?.utteranceId ?? null
      if (utteranceId) {
        api.reportTtsUtteranceEnded({ utteranceId })
      }

      bubbleTtsQueueRef.current = []
      ttsActiveUtteranceRef.current = null
      ttsQueueRef.current = null
      ttsQueueRunningRef.current = false
      ttsPlayerRef.current?.stop()
      if (ttsQueueWakeRef.current) {
        const w = ttsQueueWakeRef.current
        ttsQueueWakeRef.current = null
        w()
      }
      setMouthOpen(0)
      setBubblePayload(null)
    })
  }, [api])

  // Lip sync: use analyser level to drive mouth openness
  useEffect(() => {
    let raf = 0

    const tick = () => {
      const player = ttsPlayerRef.current
      const level = player ? player.getLevel() : 0
      const target = Math.max(0, Math.min(1.25, level * 9.5))

      setMouthOpen((prev) => {
        const next = prev * 0.7 + target * 0.3
        return Math.abs(next - prev) < 0.01 ? prev : next
      })

      raf = window.requestAnimationFrame(tick)
    }

    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [api])

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dMouseTrackingEnabled = settings?.live2dMouseTrackingEnabled !== false
  const live2dIdleSwayEnabled = settings?.live2dIdleSwayEnabled !== false
  const bubbleSettings = settings?.bubble
  const taskPanelX = settings?.taskPanel?.positionX ?? 50
  const taskPanelY = settings?.taskPanel?.positionY ?? 78
  // 仅展示“进行中”任务：failed/done/canceled 不应长期挂在面板里（否则用户会误以为还在跑且无法终止）
  const visibleTasks = tasks.filter((t) => {
    const active = t.status === 'pending' || t.status === 'running' || t.status === 'paused'
    if (!active) return false

    // chat 来源的 agent.run：在聊天里看到第一张工具卡后再让面板出现，避免“任务面板抢跑”造成割裂观感。
    const isChatAgentRun = t.queue === 'chat' && typeof t.why === 'string' && t.why.includes('agent.run')
    if (isChatAgentRun) {
      const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
      if (runs.length === 0) return false
    }

    return true
  })

  useEffect(() => {
    if (!api) return

    let disposed = false
    let raf = 0
    let ro: ResizeObserver | null = null

    const sendTaskPanelRect = () => {
      if (disposed) return
      const el = taskPanelRef.current
      if (!el || visibleTasks.length === 0) {
        if (lastTaskPanelRectSigRef.current !== 'none') {
          lastTaskPanelRectSigRef.current = 'none'
          api.setPetOverlayRects(null)
        }
        return
      }

      const rect = el.getBoundingClientRect()
      const pad = 12
      const x = Math.round(rect.left - pad)
      const y = Math.round(rect.top - pad)
      const width = Math.round(rect.width + pad * 2)
      const height = Math.round(rect.height + pad * 2)
      const viewportWidth = Math.round(window.innerWidth || 0)
      const viewportHeight = Math.round(window.innerHeight || 0)
      const sig = `${x},${y},${width},${height},${viewportWidth},${viewportHeight}`
      if (sig === lastTaskPanelRectSigRef.current) return
      lastTaskPanelRectSigRef.current = sig
      api.setPetOverlayRects({ taskPanel: { x, y, width, height, viewportWidth, viewportHeight } })
    }

    sendTaskPanelRect()
    raf = window.requestAnimationFrame(sendTaskPanelRect)
    const onResize = () => sendTaskPanelRect()
    window.addEventListener('resize', onResize)

    if (typeof ResizeObserver !== 'undefined' && taskPanelRef.current) {
      ro = new ResizeObserver(() => sendTaskPanelRect())
      ro.observe(taskPanelRef.current)
    }

    return () => {
      disposed = true
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      lastTaskPanelRectSigRef.current = ''
      api.setPetOverlayRects(null)
    }
  }, [api, visibleTasks.length, taskPanelX, taskPanelY])

  // Get model URL directly from settings
  const modelJsonUrl = settings?.live2dModelFile ?? '/live2d/Haru/Haru.model3.json'

  // 解析当前 Live2D 模型的可用表情/动作名，用于工具调用时做更通用的触发（尽量不硬编码具体名字）
  useEffect(() => {
    let cancelled = false
    let watermarkTimer: number | null = null
    parseModelMetadata(modelJsonUrl)
      .then((metadata) => {
        if (cancelled) return
        const expressions = metadata.expressions?.map((e) => e.name).filter(Boolean) ?? []
        const motions = metadata.motionGroups?.map((g) => g.name).filter(Boolean) ?? []
        toolAnimRef.current = { motionGroups: motions, expressions }

        // 仅当当前模型声明了“关闭水印”表达式时，启动阶段自动触发几次，避免模型初始化时丢触发。
        const watermarkExpression = expressions.find((name) => name.trim() === '关闭水印') ?? null
        if (watermarkExpression && api) {
          let attempts = 0
          const triggerWatermarkExpression = () => {
            if (cancelled) return
            attempts += 1
            api.triggerExpression(watermarkExpression)
            if (attempts < 6) {
              watermarkTimer = window.setTimeout(triggerWatermarkExpression, 260)
            }
          }
          triggerWatermarkExpression()
        }
      })
      .catch(() => {
        if (cancelled) return
        toolAnimRef.current = { motionGroups: [], expressions: [] }
      })
    return () => {
      cancelled = true
      if (watermarkTimer) {
        window.clearTimeout(watermarkTimer)
        watermarkTimer = null
      }
    }
  }, [api, modelJsonUrl])

  // 与 Live2DView 内的模型摆放保持一致的近似命中（用于拖拽/右键判断）
  const isPointOverLive2D = (clientX: number, clientY: number) => {
    if (!containerRef.current) return false
    const rect = containerRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    const centerX = rect.width / 2
    const centerY = rect.height / 2 + rect.height * 0.06
    const radiusX = rect.width * 0.42
    const radiusY = rect.height * 0.48

    const normalizedX = (x - centerX) / radiusX
    const normalizedY = (y - centerY) / radiusY
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1
  }

  const cancelQueuedDragMove = useCallback(() => {
    if (!dragMoveRafRef.current) return
    window.cancelAnimationFrame(dragMoveRafRef.current)
    dragMoveRafRef.current = 0
  }, [])

  const flushQueuedDragMove = useCallback(
    (point?: { x: number; y: number }) => {
      if (point) pendingDragPointRef.current = point
      const next = pendingDragPointRef.current
      if (!next) return
      pendingDragPointRef.current = null
      api?.dragMove(next)
    },
    [api],
  )

  const scheduleDragMove = useCallback(
    (point: { x: number; y: number }) => {
      pendingDragPointRef.current = point
      if (dragMoveRafRef.current) return
      dragMoveRafRef.current = window.requestAnimationFrame(() => {
        dragMoveRafRef.current = 0
        flushQueuedDragMove()
      })
    },
    [flushQueuedDragMove],
  )

  const stopWindowDrag = useCallback(
    (point?: { x: number; y: number }) => {
      if (!isDragging.current) return
      cancelQueuedDragMove()
      flushQueuedDragMove(point)
      pendingDragPointRef.current = null
      isDragging.current = false
      dragPointerId.current = null
      setWindowDragging(false)
      api?.stopDrag(point)
    },
    [api, cancelQueuedDragMove, flushQueuedDragMove],
  )

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('[data-no-window-drag="true"]')) return
    if (e.button !== 0) return
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (!isOverModel.current) return

    isDragging.current = true
    dragPointerId.current = e.pointerId
    clickStartTime.current = Date.now()

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    pendingDragPointRef.current = null
    cancelQueuedDragMove()
    setWindowDragging(true)
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    api?.startDrag(point)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current) return

    if (!isDragging.current) {
      isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
      return
    }

    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    scheduleDragMove(point)
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    if (e.button !== 0) return
    if (!isDragging.current) return

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    stopWindowDrag(point)

    const clickDuration = Date.now() - clickStartTime.current
    if (clickDuration < 200 && bubbleSettings?.showOnClick) {
      const phrases = bubbleSettings?.clickPhrases?.length > 0 ? bubbleSettings.clickPhrases : defaultPhrases
      if (phrases.length > 0) {
        const phrase = phrases[Math.floor(Math.random() * phrases.length)]
        setBubblePayload({ text: phrase, startAt: Date.now(), mode: 'typing' })
      }
    }
  }

  const handlePointerCancel = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    const point = { x: e.screenX, y: e.screenY }
    stopWindowDrag(point)
  }

  const handleLostPointerCapture = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    const point = { x: e.screenX, y: e.screenY }
    stopWindowDrag(point)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (isOverModel.current) {
      e.preventDefault()
      api?.showContextMenu()
    }
  }

  const handleBubbleClose = useCallback(() => {
    setBubblePayload(null)
    bubblePreviewActiveRef.current = false
    bubblePreviewStartAtRef.current = null
    bubblePreviewTextRef.current = ''
  }, [])

  const handlePinnedBubbleClose = useCallback(() => {
    setBubblePinnedPayload(null)
  }, [])

  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!isDragging.current) return
      stopWindowDrag({ x: e.screenX, y: e.screenY })
    }
    const handleWindowBlur = () => {
      if (!isDragging.current) return
      stopWindowDrag(undefined)
    }
    const handleVisibilityChange = () => {
      if (!document.hidden) return
      if (!isDragging.current) return
      stopWindowDrag(undefined)
    }

    window.addEventListener('mouseup', handleGlobalMouseUp, true)
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp, true)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      cancelQueuedDragMove()
      pendingDragPointRef.current = null
    }
  }, [cancelQueuedDragMove, stopWindowDrag])

  return (
    <div
      ref={containerRef}
      className="ndp-pet-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
    >
      <Live2DView
        modelJsonUrl={modelJsonUrl}
        scale={petScale}
        opacity={petOpacity}
        mouthOpen={mouthOpen}
        windowDragging={windowDragging}
        mouseTrackingEnabled={live2dMouseTrackingEnabled}
        idleSwayEnabled={live2dIdleSwayEnabled}
      />
      <ContextUsageOrb
        enabled={bubbleSettings?.contextOrbEnabled ?? false}
        usage={contextUsage}
        position={{ x: bubbleSettings?.contextOrbX ?? 12, y: bubbleSettings?.contextOrbY ?? 16 }}
        onPositionChange={(next) => api?.setBubbleSettings({ contextOrbX: next.x, contextOrbY: next.y })}
        interactionDisabled={windowDragging}
      />
      {asrShowSubtitle && asrSubtitle.trim() && (
        <div className={`ndp-asr-subtitle${asrRecording ? ' ndp-asr-subtitle-recording' : ''}`}>{asrSubtitle}</div>
      )}
      {bubblePinnedPayload && (
        <SpeechBubble
          key={`pinned-${bubblePinnedPayload.id}`}
          text={bubblePinnedPayload.text}
          startAt={bubblePinnedPayload.startAt}
          mode={bubblePinnedPayload.mode}
          animateAppend={bubblePinnedPayload.animateAppend}
          resetAppendFromEmpty={bubblePinnedPayload.resetAppendFromEmpty}
          style={bubbleSettings?.style ?? 'cute'}
          positionX={bubbleSettings?.positionX ?? 75}
          positionY={(() => {
            const baseY = bubbleSettings?.positionY ?? 10
            return baseY >= 18 ? baseY - 12 : Math.min(100, baseY + 12)
          })()}
          tailDirection={bubbleSettings?.tailDirection ?? 'down'}
          autoHideDelay={bubblePinnedPayload.autoHideDelay ?? (bubbleSettings?.autoHideDelay ?? 5000)}
          onClose={handlePinnedBubbleClose}
        />
      )}
      {bubblePayload && (
        <SpeechBubble
          key={`${bubblePayload.startAt ?? 'pending'}-${bubblePayload.mode}`}
          text={bubblePayload.text}
          startAt={bubblePayload.startAt}
          mode={bubblePayload.mode}
          animateAppend={bubblePayload.animateAppend}
          resetAppendFromEmpty={bubblePayload.resetAppendFromEmpty}
          style={bubbleSettings?.style ?? 'cute'}
          positionX={bubbleSettings?.positionX ?? 75}
          positionY={bubbleSettings?.positionY ?? 10}
          tailDirection={bubbleSettings?.tailDirection ?? 'down'}
          autoHideDelay={bubblePayload.autoHideDelay ?? (bubbleSettings?.autoHideDelay ?? 5000)}
          onClose={handleBubbleClose}
        />
      )}
      {visibleTasks.length > 0 && (
        <div
          ref={taskPanelRef}
          className="ndp-task-panel"
          data-no-window-drag="true"
          style={{ left: `${taskPanelX}%`, top: `${taskPanelY}%`, transform: 'translate(-50%, 0)' }}
          onMouseEnter={() => api?.setPetOverlayHover(true)}
          onMouseLeave={() => api?.setPetOverlayHover(false)}
          onPointerEnter={() => api?.setPetOverlayHover(true)}
          onPointerLeave={() => api?.setPetOverlayHover(false)}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <div className="ndp-task-panel-header">
            <div className="ndp-task-panel-title">任务进行中</div>
            <div className="ndp-task-panel-count">{Math.min(visibleTasks.length, 3)}/{visibleTasks.length}</div>
          </div>
          {visibleTasks.slice(0, 3).map((task) => {
            const currentStep = task.steps?.[Math.max(0, Math.min(task.currentStepIndex, task.steps.length - 1))]
            const lastStep = task.currentStepIndex > 0 ? task.steps?.[task.currentStepIndex - 1] : null
            const outputPreview = ((lastStep?.output ?? '') || (currentStep?.output ?? '')).trim()
            const progressText =
              task.steps?.length > 0
                ? `${Math.min(task.currentStepIndex + 1, task.steps.length)}/${task.steps.length}`
                : ''

            return (
              <div key={task.id} className="ndp-task-card">
                <div className="ndp-task-card-title">
                  <span className={`ndp-task-badge ndp-task-badge-${task.status}`}>{task.status}</span>
                  <span className="ndp-task-title-text">{task.title}</span>
                  {progressText && <span className="ndp-task-progress">{progressText}</span>}
                </div>
                {task.why && <div className="ndp-task-card-sub">{task.why}</div>}
                {currentStep?.title && <div className="ndp-task-card-sub">当前：{currentStep.title}</div>}
                {currentStep?.tool && <div className="ndp-task-card-sub">当前工具：{currentStep.tool}</div>}
                {task.toolsUsed?.length > 0 && (
                  <div className="ndp-task-card-sub">工具：{task.toolsUsed.join('、')}</div>
                )}
                {outputPreview && <div className="ndp-task-card-sub ndp-task-card-mono">输出：{outputPreview}</div>}
                {task.lastError && <div className="ndp-task-card-error">失败：{task.lastError}</div>}
                <div className="ndp-task-card-actions">
                  {task.status === 'running' && (
                    <button
                      className="ndp-task-btn"
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.pauseTask(task.id).catch((err) => console.error(err))}
                    >
                      暂停
                    </button>
                  )}
                  {task.status === 'paused' && (
                    <button
                      className="ndp-task-btn"
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.resumeTask(task.id).catch((err) => console.error(err))}
                    >
                      继续
                    </button>
                  )}
                  <button
                    className="ndp-task-btn ndp-task-btn-danger"
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (!api) return
                      // 兜底：极少数情况下 terminal task 仍被渲染到面板里，此时“终止”改为清理
                      if (task.status === 'pending' || task.status === 'running' || task.status === 'paused') {
                        void api.cancelTask(task.id).catch((err) => console.error(err))
                      } else {
                        void api.dismissTask(task.id).catch((err) => console.error(err))
                      }
                    }}
                  >
                    {task.status === 'pending' || task.status === 'running' || task.status === 'paused' ? '终止' : '清除'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChatWindow(props: { api: ReturnType<typeof getApi> }) {
  const { api } = props
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [lastRetrieveDebug, setLastRetrieveDebug] = useState<MemoryRetrieveResult['debug'] | null>(null)
  const [mcpSnapshotForContext, setMcpSnapshotForContext] = useState<McpStateSnapshot | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const inputRef = useRef('')
  const messagesRef = useRef<ChatMessageRecord[]>([])
  const toolAnimRef = useRef<{ motionGroups: string[]; expressions: string[] }>({ motionGroups: [], expressions: [] })
  const isLoadingRef = useRef(false)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionName, setEditingSessionName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null)
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = useState('')
  type PendingAttachment = { id: string; kind: 'image' | 'video'; path: string; filename: string; previewDataUrl?: string }
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  // 存储最近一次 API 返回的真实 token usage（用于精确上下文统计）
  const [lastApiUsage, setLastApiUsage] = useState<ChatUsage | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const userAvatarInputRef = useRef<HTMLInputElement>(null)
  const assistantAvatarInputRef = useRef<HTMLInputElement>(null)
  const editingTextareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [ttsSegmentedMessageFlags, setTtsSegmentedMessageFlags] = useState<Record<string, true>>({})
  const [ttsRevealedSegments, setTtsRevealedSegments] = useState<Record<string, number>>({})
  const [ttsPendingUtteranceId, setTtsPendingUtteranceId] = useState<string | null>(null)
  const ttsUtteranceMetaRef = useRef<
    Record<
      string,
      {
        sessionId: string
        createdAt: number
        messageId: string
        displayedSegments: number
        fallbackContent?: string
      }
    >
  >({})
  const aiAbortRef = useRef<AbortController | null>(null)
  const chatStopSeqRef = useRef(0)
  const plannerPendingRef = useRef(false)
  const pendingAsrAutoSendRef = useRef<string[]>([])
  const asrAutoSendFlushingRef = useRef(false)
  const asrComposePreviewLastSigRef = useRef<string>('')
  const bubblePreviewLastSigRef = useRef<string>('')
  const bubblePreviewSendDebugAtRef = useRef(0)
  const tasksRef = useRef<TaskRecord[]>([])
  const taskOriginSessionRef = useRef<Map<string, string>>(new Map())
  const taskOriginMessageRef = useRef<Map<string, string>>(new Map())
  const taskOriginBlocksRef = useRef<Map<string, ChatMessageBlock[]>>(new Map())
  const taskToolUseSplitRef = useRef<Map<string, { runIds: string[]; segments: string[]; lastDisplay: string }>>(new Map())
  const taskUiDebugSigRef = useRef<Map<string, string>>(new Map())
  const taskBubbleTtsProgressRef = useRef<Map<string, { spokenFrozen: number; spokeFinal: boolean }>>(new Map())
  const taskBubblePreviewProgressRef = useRef<Map<string, { shownFrozen: number; lastShownAt: number; lastTailText: string }>>(new Map())
  const taskFinalizeContextRef = useRef<
    Map<
      string,
      {
        sessionId: string
        messageId: string
        chatHistory: ChatMessage[]
        systemAddon: string
        userText: string
      }
    >
  >(new Map())
  const taskFinalizingRef = useRef<Set<string>>(new Set())

  const toolFactsSeenRef = useRef<Set<string>>(new Set())
  const sessionToolFactsRef = useRef<Map<string, Array<{ at: number; lines: string[] }>>>(new Map())

  const addSessionToolFacts = useCallback((sessionId: string, lines: string[], at?: number) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return
    const cleaned = (lines ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)
    if (cleaned.length === 0) return
    const ts = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
    const prev = sessionToolFactsRef.current.get(sid) ?? []
    const next = [...prev, { at: ts, lines: cleaned }]
    // 仅保留最近 30 条“事实块”
    const sliced = next.length > 30 ? next.slice(next.length - 30) : next
    sessionToolFactsRef.current.set(sid, sliced)
  }, [])

  const buildSessionToolFactsAddon = useCallback((sessionId: string): string => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return ''
    const items = sessionToolFactsRef.current.get(sid) ?? []
    if (items.length === 0) return ''
    const nowTs = Date.now()
    const fresh = items.filter((x) => nowTs - x.at < 15 * 60 * 1000)
    if (fresh.length === 0) return ''
    const flat = fresh.flatMap((x) => x.lines).filter(Boolean)
    if (flat.length === 0) return ''
    const MAX_LINES = 24
    const lines = flat.length > MAX_LINES ? [...flat.slice(0, MAX_LINES), `- ...（已省略 ${flat.length - MAX_LINES} 行）`] : flat
    return [
      '【最近工具事实（用于减少你让我重复；仅供后续工具调用）】',
      ...lines,
      '',
      '规则：1) 工具调用必须优先复用这些事实里的 path/url；2) 严禁编造路径；3) 最终回复不要暴露本地路径。',
    ].join('\n')
  }, [])
  const contextUsageLastSentAtRef = useRef(0)
  const contextUsagePendingRef = useRef<ContextUsageSnapshot | null>(null)
  const contextUsageSendTimerRef = useRef<number | null>(null)
  const debugLogLastSentAtRef = useRef<Map<string, number>>(new Map())
  const [contextRetrieveAddon, setContextRetrieveAddon] = useState<string>('')
  const contextRetrieveAddonReqIdRef = useRef(0)

  const debugLog = useCallback(
    (event: string, data?: unknown) => {
      try {
        const key = String(event ?? '').trim()
        if (key === 'chat:task.blocks') {
          const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
          const isFinal = obj?.isFinal === true
          if (!isFinal) {
            const nowTs = Date.now()
            const last = debugLogLastSentAtRef.current.get(key) ?? 0
            if (nowTs - last < 250) return
            debugLogLastSentAtRef.current.set(key, nowTs)
          }
        }
        api?.appendDebugLog(event, data)
      } catch {
        // ignore
      }
    },
    [api],
  )

  const getActivePersonaId = useCallback((): string => {
    const pid = settingsRef.current?.activePersonaId
    return typeof pid === 'string' && pid.trim().length > 0 ? pid : 'default'
  }, [])

  const filterSessionsForPersona = useCallback(
    (all: ChatSessionSummary[]): ChatSessionSummary[] => all.filter((s) => s.personaId === getActivePersonaId()),
    [getActivePersonaId],
  )

  const autoExtractRunningRef = useRef<Record<string, boolean>>({})

  const runAutoExtractIfNeeded = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const settings = settingsRef.current
      const mem = settings?.memory
      if (!mem?.enabled) return
      if (!mem.autoExtractEnabled) return

      const updateSummary = (patch: Partial<ChatSessionSummary>) => {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)))
      }

      const formatAutoExtractError = (raw: string): { message: string; shouldAlert: boolean } => {
        const text = String(raw ?? '').trim()
        const lower = text.toLowerCase()
        const isContextTooLong =
          lower.includes('context_length') ||
          lower.includes('maximum context') ||
          (lower.includes('context') && lower.includes('length')) ||
          (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum')))

        if (!isContextTooLong) return { message: text || '自动提炼失败', shouldAlert: false }

        return {
          message: `上下文过长导致请求失败，可降低“提炼窗口”或右键“一键总结”。（原始错误：${text || 'unknown'}）`,
          shouldAlert: true,
        }
      }

      const every = clampIntValue(mem.autoExtractEveryEffectiveMessages, 20, 2, 2000)
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )
      const cooldownMs = clampIntValue(mem.autoExtractCooldownMs, 120000, 0, 3600000)

      if (autoExtractRunningRef.current[sessionId]) return
      autoExtractRunningRef.current[sessionId] = true

      let attemptAt = 0
      let effectiveCount = 0
      try {
        if (!settings?.ai) return

        const useCustomAi = !!mem.autoExtractUseCustomAi
        const base = settings.ai
        const extractAiSettings = useCustomAi
          ? {
              ...base,
              apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
              baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
              model: mem.autoExtractAiModel?.trim() || base.model,
              temperature:
                typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                  ? mem.autoExtractAiTemperature
                  : base.temperature,
              maxTokens:
                typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                  ? mem.autoExtractAiMaxTokens
                  : base.maxTokens,
            }
          : base

        const ai = new AIService(extractAiSettings)

        const session = await api.getChatSession(sessionId)
        attemptAt = Date.now()
        const lastRunAt = clampIntValue(session.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
        if (cooldownMs > 0 && attemptAt - lastRunAt < cooldownMs) return
        const effective = collapseAssistantRuns(session.messages)
        effectiveCount = effective.length
        const cursor = clampIntValue(session.autoExtractCursor ?? 0, 0, 0, 1_000_000)
        const delta = effectiveCount - cursor
        if (delta < every) return
        if (effectiveCount < 4) return

        const tail = sliceTail(effective, maxEffective)
        const conversation = tail
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
          .join('\n\n')
          .trim()
        if (!conversation) return

        const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。

规则：
1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。
2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。
3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。
4) 如果没有值得记的内容，返回空数组 []。
5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。

输出格式：
[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]

说明：
- scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

        const res = await ai.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
        ])
        if (res.error) {
          const errUi = formatAutoExtractError(res.error)
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          if (errUi.shouldAlert) window.alert(errUi.message)
          return
        }

        const parseJsonArray = (text: string): unknown[] | null => {
          const cleaned = (text ?? '').trim()
          if (!cleaned) return null
          try {
            const parsed = JSON.parse(cleaned)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            const start = cleaned.indexOf('[')
            const end = cleaned.lastIndexOf(']')
            if (start < 0 || end < 0 || end <= start) return null
            const slice = cleaned.slice(start, end + 1)
            try {
              const parsed = JSON.parse(slice)
              return Array.isArray(parsed) ? parsed : null
            } catch {
              return null
            }
          }
        }

        const arr = parseJsonArray(res.content)
        if (!arr) {
          const lastError = '自动提炼失败：无法解析模型输出（不是 JSON 数组）'
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          return
        }

        const uniq = new Set<string>()
        const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue
          const obj = it as Record<string, unknown>
          const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
          const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
          const content = typeof obj.content === 'string' ? obj.content.trim() : ''
          if (!content) continue
          const normalized = content.replace(/\s+/g, ' ').trim()
          if (!normalized) continue
          if (normalized.length > 140) continue
          if (uniq.has(normalized)) continue
          uniq.add(normalized)
          items.push({ scope, content: normalized })
        }

        // 即使返回空数组，也推进游标，避免同一段对话被重复“空提炼”
        for (const it of items) {
          const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
            ? (consoleSettings.personaId || session.personaId || 'default')
            : (session.personaId || 'default')
          const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'
          const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
          await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
        }
        await api.setChatAutoExtractMeta(sessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
        updateSummary({
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[AutoExtract] Failed:', err)
        const errUi = formatAutoExtractError(msg)
        try {
          const nextLastRunAt = attemptAt || Date.now()
          await api.setChatAutoExtractMeta(sessionId, {
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
        } catch (_) {
          /* ignore */
        }
        if (errUi.shouldAlert) window.alert(errUi.message)
      } finally {
        autoExtractRunningRef.current[sessionId] = false
      }
    },
    [api],
  )

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const syncAsrComposePreview = useCallback(
    (baseText: string, opts?: { clearFinals?: boolean; force?: boolean }) => {
      if (!api) return
      const normalizedBase = String(baseText ?? '')
      const clearFinals = opts?.clearFinals === true
      const sig = `${clearFinals ? '1' : '0'}\n${normalizedBase}`
      if (!opts?.force && asrComposePreviewLastSigRef.current === sig) return
      asrComposePreviewLastSigRef.current = sig
      try {
        api.syncAsrComposePreview({ baseText: normalizedBase, ...(clearFinals ? { clearFinals: true } : {}) })
      } catch {
        /* ignore */
      }
    },
    [api],
  )

  const sendBubblePreview = useCallback(
    (
      payload: { text?: string; clear?: boolean; placeholder?: boolean; autoHideDelay?: number; pinPrevious?: boolean },
      opts?: { force?: boolean },
    ) => {
      if (!api) return
      const text = typeof payload.text === 'string' ? payload.text : ''
      const clear = payload.clear === true
      const placeholder = payload.placeholder === true
      const pinPrevious = payload.pinPrevious === true
      const autoHideDelay =
        typeof payload.autoHideDelay === 'number' && Number.isFinite(payload.autoHideDelay) ? Math.trunc(payload.autoHideDelay) : undefined
      const normalizedPayload = {
        ...(text ? { text } : {}),
        ...(clear ? { clear: true as const } : {}),
        ...(placeholder ? { placeholder: true as const } : {}),
        ...(pinPrevious ? { pinPrevious: true as const } : {}),
        ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
      }
      const sig = `${clear ? '1' : '0'}|${placeholder ? '1' : '0'}|${pinPrevious ? '1' : '0'}|${typeof autoHideDelay === 'number' ? autoHideDelay : ''}|${text}`
      if (!opts?.force && bubblePreviewLastSigRef.current === sig) return
      bubblePreviewLastSigRef.current = sig
      {
        const nowTs = Date.now()
        if (nowTs - bubblePreviewSendDebugAtRef.current >= 180) {
          bubblePreviewSendDebugAtRef.current = nowTs
          debugLog('chat:bubble.preview.send', {
            clear,
            placeholder,
            pinPrevious,
            len: text.length,
            head: text.slice(0, 32),
            tail: text.slice(-24),
          })
        }
      }
      try {
        api.sendBubblePreview(normalizedPayload)
      } catch {
        /* ignore */
      }
      // 兼容回退：即使主进程/预加载的 preview 通道未生效，也通过既有 bubble:message 通道发送预览事件。
      try {
        api.sendBubbleMessage(`${BUBBLE_PREVIEW_FALLBACK_PREFIX}${JSON.stringify(normalizedPayload)}`)
      } catch {
        /* ignore */
      }
    },
    [api, debugLog],
  )

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    if (!api) return

    const unsubSegmentStarted = api.onTtsSegmentStarted((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (!meta) return

      const idx = clampIntValue(payload.segmentIndex, -1, 0, 1_000_000)
      if (idx < 0) return

      meta.displayedSegments = Math.max(meta.displayedSegments, idx + 1)

      if (idx === 0) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
      }

      setTtsRevealedSegments((prev) => ({ ...prev, [meta.messageId]: meta.displayedSegments }))
    })

    const unsubUtteranceFailed = api.onTtsUtteranceFailed((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
        setTtsRevealedSegments((prev) => {
          const next = { ...prev }
          delete next[meta.messageId]
          return next
        })
        delete ttsUtteranceMetaRef.current[payload.utteranceId]
      }
      setError(payload.error)
    })

    const unsubUtteranceEnded = api.onTtsUtteranceEnded((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      delete ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
        setTtsRevealedSegments((prev) => {
          const next = { ...prev }
          delete next[meta.messageId]
          return next
        })
      }
      const sessionId = meta?.sessionId
      if (sessionId) {
        void runAutoExtractIfNeeded(sessionId)
      }
    })

    return () => {
      unsubSegmentStarted()
      unsubUtteranceFailed()
      unsubUtteranceEnded()
    }
  }, [api, currentSessionId, debugLog, runAutoExtractIfNeeded])

  // Load settings
  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  useEffect(() => {
    if (!api) return
    const pid = settings?.activePersonaId?.trim() || 'default'
    api
      .getPersona(pid)
      .then((p) => setCurrentPersona(p))
      .catch(() => setCurrentPersona(null))
  }, [api, settings?.activePersonaId])

  // Load sessions and current messages
  useEffect(() => {
    if (!api) return

    let cancelled = false
    ;(async () => {
      const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
      if (cancelled) return

      const filtered = filterSessionsForPersona(allSessions)
      setSessions(filtered)

      // 当前会话可能属于其它人设：自动切到本人人设的最新会话（或创建一个）
      let nextSessionId =
        filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null)

      if (!nextSessionId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextSessionId = created.id
      } else if (nextSessionId !== currentSessionId) {
        await api.setCurrentChatSession(nextSessionId)
      }

      const session = await api.getChatSession(nextSessionId ?? undefined)
      if (cancelled) return
      // 同步设置会话 id 与消息，避免“id 已切换但消息尚未加载”导致首条发送上下文缺失。
      setCurrentSessionId(nextSessionId)
      setMessages(session.messages)
    })().catch((err) => console.error(err))

    return () => {
      cancelled = true
    }
  }, [api, filterSessionsForPersona, getActivePersonaId, settings?.activePersonaId])

  // Initialize AI service and set model info when settings change
  useEffect(() => {
    if (!settings?.ai) return
    getAIService(settings.ai)

    // Load model metadata and set to AI service
    const modelFile = settings.live2dModelFile
    if (modelFile) {
      parseModelMetadata(modelFile).then((metadata) => {
        const expressions = metadata.expressions?.map((e) => e.name) || []
        const motions = metadata.motionGroups?.map((g) => g.name) || []
        toolAnimRef.current = { motionGroups: motions, expressions }
        setModelInfoToAIService(expressions, motions)
      })
    } else {
      toolAnimRef.current = { motionGroups: [], expressions: [] }
    }
  }, [settings?.ai, settings?.live2dModelFile])

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, ttsRevealedSegments])

  const reloadCurrentSessionMessages = useCallback(async () => {
    if (!api || !currentSessionId) return
    if (isLoadingRef.current) return

    // 有进行中的任务（尤其是 agent.run 流式）时，避免用持久化 session 覆盖 UI，防止“点一下文本就没了只剩工具标签”。
    const hasActiveTask = (() => {
      const ids: string[] = []
      for (const [tid, sid] of taskOriginSessionRef.current.entries()) {
        if (sid === currentSessionId) ids.push(tid)
      }
      if (ids.length === 0) return false
      const list = tasksRef.current
      return ids.some((tid) => {
        const t = list.find((x) => x.id === tid) ?? null
        const st = String(t?.status ?? '').trim()
        return st === 'pending' || st === 'running' || st === 'paused'
      })
    })()
    if (hasActiveTask) return

    const session = await api.getChatSession(currentSessionId).catch(() => null)
    if (!session) return
    setMessages(session.messages)
  }, [api, currentSessionId])

  // 隐藏窗口后台 autoSend 后，首次打开聊天窗可能出现 UI state 未刷新（只看到 assistant、缺 user）的情况。
  // 这里在窗口变为可见/获得焦点时，主动从持久化 session 拉一次消息，保证 UI 与存储一致。
  useEffect(() => {
    let inflight = false
    const onShow = () => {
      if (document.visibilityState !== 'visible') return
      if (inflight) return
      inflight = true
      void reloadCurrentSessionMessages().finally(() => {
        inflight = false
      })
    }
    window.addEventListener('focus', onShow)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      window.removeEventListener('focus', onShow)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [reloadCurrentSessionMessages])

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )

  // 消息列表渲染热点：把 tasks 做成 id 索引，O(n×m) 扫描降为 O(1) 查表
  const tasksById = useMemo(
    () => new Map<string, TaskRecord>(tasks.map((t) => [t.id, t])),
    [tasks],
  )

  const currentActiveChatTaskIds = useMemo(() => {
    if (!currentSessionId) return []

    const isActive = (t: TaskRecord | undefined): boolean =>
      !t || t.status === 'pending' || t.status === 'running' || t.status === 'paused'
    const ids = new Set<string>()
    for (const m of messages) {
      const taskId = typeof m.taskId === 'string' ? m.taskId.trim() : ''
      if (taskId && tasksById.has(taskId) && isActive(tasksById.get(taskId))) ids.add(taskId)
    }
    for (const [taskId, sessionId] of taskOriginSessionRef.current.entries()) {
      if (sessionId === currentSessionId && isActive(tasksById.get(taskId))) ids.add(taskId)
    }
    return [...ids]
  }, [currentSessionId, messages, tasksById])

  // messages.map 外层预计算的稳定值，避免每条消息每次 render 都重复走 optional chain
  const chatProfile = settings?.chatProfile
  const userAvatar = chatProfile?.userAvatar
  const assistantAvatar = chatProfile?.assistantAvatar
  const ttsSegmentedUi = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)

  useEffect(() => {
    plannerPendingRef.current = false
  }, [currentSessionId])

  const memEnabled = settings?.memory?.enabled ?? true
  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const captureEnabled = currentPersona?.captureEnabled ?? true
  const retrieveEnabled = currentPersona?.retrieveEnabled ?? true
  const plannerEnabled = settings?.orchestrator?.plannerEnabled ?? false
  const plannerMode = settings?.orchestrator?.plannerMode ?? 'auto'
  const toolCallingEnabled = settings?.orchestrator?.toolCallingEnabled ?? false
  const toolCallingMode = settings?.orchestrator?.toolCallingMode ?? 'auto'

  const effectiveCountUi = useMemo(() => collapseAssistantRuns(messages).length, [messages])
  const cursorUi = clampIntValue(currentSession?.autoExtractCursor ?? 0, 0, 0, 1_000_000)
  const everyUi = clampIntValue(settings?.memory?.autoExtractEveryEffectiveMessages, 20, 2, 2000)
  const deltaUi = Math.max(0, effectiveCountUi - cursorUi)
  const remainingUi = memEnabled && autoExtractEnabled ? Math.max(0, everyUi - deltaUi) : 0

  const lastRunAtUi = clampIntValue(currentSession?.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
  const lastWriteCountUi = clampIntValue(currentSession?.autoExtractLastWriteCount ?? 0, 0, 0, 1_000_000)
  const lastErrorUi = (currentSession?.autoExtractLastError ?? '').trim()
  const lastErrorPreviewUi = lastErrorUi.length > 120 ? `${lastErrorUi.slice(0, 120)}…` : lastErrorUi

  const retrieveUi = useMemo(() => {
    if (!memEnabled || !retrieveEnabled) return { text: '-', title: '召回已关闭' }
    if (!lastRetrieveDebug) return { text: '-', title: '尚无召回记录（请先发送一条消息触发检索）' }

    const mapLayer = (l: NonNullable<MemoryRetrieveResult['debug']>['layers'][number]) => {
      if (l === 'timeRange') return 'TIME'
      if (l === 'fts') return 'FTS'
      if (l === 'like') return 'LIKE'
      if (l === 'tag') return 'TAG'
      if (l === 'kg') return 'KG'
      if (l === 'vector') return 'VEC'
      return 'NONE'
    }

    const layers = (lastRetrieveDebug.layers ?? []).map(mapLayer).join('+') || '-'
    const c = lastRetrieveDebug.counts
    const titleParts: string[] = []
    titleParts.push(`层级：${layers}`)
    titleParts.push(
      `命中：TIME=${c?.timeRange ?? 0} FTS=${c?.fts ?? 0} LIKE=${c?.like ?? 0} TAG=${c?.tag ?? 0} KG=${c?.kg ?? 0} VEC=${c?.vector ?? 0}`,
    )
    if (lastRetrieveDebug.tag) {
      titleParts.push(
        `Tag：query=${lastRetrieveDebug.tag.queryTags} matched=${lastRetrieveDebug.tag.matchedTags} expanded=${lastRetrieveDebug.tag.expandedTags}`,
      )
    }
    if (lastRetrieveDebug.vector) {
      const v = lastRetrieveDebug.vector
      const extra = [
        `enabled=${v.enabled ? '1' : '0'}`,
        `attempted=${v.attempted ? '1' : '0'}`,
        v.reason ? `reason=${v.reason}` : '',
        v.error ? `error=${v.error}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      titleParts.push(`向量：${extra}`)
    }
    titleParts.push(`耗时：${lastRetrieveDebug.tookMs}ms`)
    return { text: layers, title: titleParts.join('\n') }
  }, [lastRetrieveDebug, memEnabled, retrieveEnabled])

  const toggleCaptureEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { captureEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleRetrieveEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { retrieveEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleAutoExtractEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setMemorySettings({ autoExtractEnabled: enabled })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleTaskPlannerEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        // "工具"总开关：关闭时强制同时关闭 ToolAgent，避免 UI 关闭后仍在后台走 agent.run
        await api.setOrchestratorSettings(enabled ? { plannerEnabled: true } : { plannerEnabled: false, toolCallingEnabled: false })
        if (!enabled) plannerPendingRef.current = false
        // 切换工具开关时清空 lastApiUsage，让 token 统计立即反映新的上下文
        setLastApiUsage(null)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const setTaskPlannerMode = useCallback(
    async (mode: 'auto' | 'always') => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ plannerMode: mode })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleToolCallingEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ toolCallingEnabled: enabled })
        // 切换工具开关时清空 lastApiUsage，让 token 统计立即反映新的上下文（有/无工具定义）
        setLastApiUsage(null)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const setToolCallingMode = useCallback(
    async (mode: 'auto' | 'native' | 'text') => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ toolCallingMode: mode })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const newMessageId = useCallback(() => {
    if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  // 将任务的“人话回复”同步回对应会话（仅对 planner 创建的任务生效）
  useEffect(() => {
    if (!api) return

    api
      .listTasks()
      .then((res) => setTasks(res.items ?? []))
      .catch(() => undefined)

    const off = api.onTasksChanged((payload) => {
      const items = payload.items ?? []
      setTasks(items)
      for (const t of items) {
        const sessionId = taskOriginSessionRef.current.get(t.id)
        const messageId = taskOriginMessageRef.current.get(t.id)
        if (!sessionId || !messageId) continue

        // 将关键工具输出“摘要化”后注入到下次对话上下文，避免模型看不见 tool 卡片导致乱填参数。
        // 注意：这里只记录可复用的事实（路径/URL/ID/统计），不记录长文本与隐私内容。
        const toolRuns = Array.isArray(t.toolRuns) ? t.toolRuns : []
        for (const r of toolRuns) {
          const runId = typeof r?.id === 'string' ? r.id : ''
          if (!runId) continue
          const status = (r as { status?: unknown }).status
          if (status !== 'done' && status !== 'error') continue
          const sig = `${t.id}:${runId}:${String(status)}:${String((r as { endedAt?: unknown }).endedAt ?? '')}`
          if (toolFactsSeenRef.current.has(sig)) continue
          toolFactsSeenRef.current.add(sig)

          const toolName = typeof (r as { toolName?: unknown }).toolName === 'string' ? String((r as { toolName: string }).toolName) : ''
          const rawOut = typeof (r as { outputPreview?: unknown }).outputPreview === 'string' ? String((r as { outputPreview: string }).outputPreview) : ''
          const rawErr = typeof (r as { error?: unknown }).error === 'string' ? String((r as { error: string }).error) : ''
          const endedAt = typeof (r as { endedAt?: unknown }).endedAt === 'number' ? ((r as { endedAt: number }).endedAt as number) : Date.now()

          const parseJsonFromText = (raw: string): Record<string, unknown> | null => {
            const text = String(raw ?? '').trim()
            if (!text) return null
            const first = text.indexOf('{')
            const last = text.lastIndexOf('}')
            if (first < 0 || last <= first) return null
            try {
              return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
            } catch {
              return null
            }
          }

          const lines: string[] = []

          if (toolName.startsWith('mcp.mmvector.') && rawOut) {
            const parsed = parseJsonFromText(rawOut)
            const results = parsed && parsed.ok === true && Array.isArray(parsed.results) ? (parsed.results as unknown[]) : []
            const media = results
              .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null))
              .filter(Boolean)
              .map((x) => ({
                type: typeof x!.type === 'string' ? String(x!.type).trim() : '',
                score: typeof x!.score === 'number' && Number.isFinite(x!.score) ? (x!.score as number) : null,
                filename: typeof x!.filename === 'string' ? String(x!.filename).trim() : '',
                imagePath: typeof x!.imagePath === 'string' ? String(x!.imagePath).trim() : '',
                videoPath: typeof x!.videoPath === 'string' ? String(x!.videoPath).trim() : '',
                videoUrl: typeof x!.videoUrl === 'string' ? String(x!.videoUrl).trim() : '',
              }))
              .filter((x) => x.imagePath || x.videoPath || x.videoUrl)

            for (const it of media.slice(0, 6)) {
              const scoreText = it.score != null ? ` score=${it.score.toFixed(4)}` : ''
              if (it.type === 'video') {
                const parts = [
                  `mmvector.video:${scoreText}`,
                  it.filename ? ` filename=${it.filename}` : '',
                  it.videoPath ? ` videoPath=${it.videoPath}` : '',
                  it.videoUrl ? ` videoUrl=${it.videoUrl}` : '',
                ].filter(Boolean)
                lines.push(`- ${parts.join('')}`)
              } else {
                const parts = [
                  `mmvector.image:${scoreText}`,
                  it.filename ? ` filename=${it.filename}` : '',
                  it.imagePath ? ` imagePath=${it.imagePath}` : '',
                ].filter(Boolean)
                lines.push(`- ${parts.join('')}`)
              }
            }
          }

          if (toolName === 'media.video_qa' && rawOut) {
            const parsed = parseJsonFromText(rawOut)
            const ok = parsed?.ok === true
            const videoPath = ok && typeof parsed?.videoPath === 'string' ? String(parsed.videoPath).trim() : ''
            const q = ok && typeof parsed?.question === 'string' ? String(parsed.question).trim() : ''
            if (videoPath) lines.push(`- video_qa: videoPath=${videoPath}${q ? ` question=${q}` : ''}`)
          }

          if (lines.length === 0 && rawErr && toolName) {
            // 兜底：把关键错误也记录一条，便于模型后续避免重复踩坑
            lines.push(`- ${toolName}: error=${rawErr.slice(0, 180)}`)
          }

          if (lines.length > 0) addSessionToolFacts(sessionId, lines, endedAt)
        }

        const isFinal = t.status === 'done' || t.status === 'failed' || t.status === 'canceled'

        const finalizeCtx = taskFinalizeContextRef.current.get(t.id) ?? null
        if (finalizeCtx) {
          if (!isFinal) continue
          if (t.status === 'canceled') {
            taskFinalizeContextRef.current.delete(t.id)
            taskFinalizingRef.current.delete(t.id)
            taskOriginSessionRef.current.delete(t.id)
            taskOriginMessageRef.current.delete(t.id)
            taskOriginBlocksRef.current.delete(t.id)
            taskToolUseSplitRef.current.delete(t.id)
            taskBubblePreviewProgressRef.current.delete(t.id)
            sendBubblePreview({ clear: true }, { force: true })
            continue
          }
          if (taskFinalizingRef.current.has(t.id)) continue
          taskFinalizingRef.current.add(t.id)

          let finalizeAbort: AbortController | null = null
          let finalizeAbortExposed = false

          void (async () => {
            const loadFinalizeBaseBlocks = async (): Promise<ChatMessageBlock[]> => {
              const fromRef = normalizeMessageBlocks({ blocks: taskOriginBlocksRef.current.get(t.id) ?? [] } as ChatMessageRecord)
              try {
                const session = await api.getChatSession(sessionId)
                const msg = (session.messages ?? []).find((m) => m.id === messageId) ?? null
                if (!msg) return fromRef
                const fromStore = normalizeMessageBlocks(msg)
                return pickRicherToolBlocks(fromRef, fromStore)
              } catch {
                return fromRef
              }
            }

            const baseBlocks = await loadFinalizeBaseBlocks()
            debugLog('chat:finalize.start', {
              taskId: t.id,
              sessionId,
              messageId,
              status: t.status,
              baseBlocks: baseBlocks.map((b) =>
                b.type === 'tool_use' ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId } : { type: b.type },
              ),
            })
            const aiService = getAIService()
            if (!aiService) {
              const errText = '[错误] AI 服务未初始化'
              const nextBlocks = baseBlocks.map((b) => ({ ...b }))
              const lastTextIdx = (() => {
                for (let i = nextBlocks.length - 1; i >= 0; i -= 1) {
                  if (nextBlocks[i].type === 'text') return i
                }
                return -1
              })()
              if (lastTextIdx >= 0) nextBlocks[lastTextIdx] = { type: 'text', text: errText }
              else nextBlocks.push({ type: 'text', text: errText })
              const nextContent = joinTextBlocks(nextBlocks)

              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, blocks: nextBlocks } : m)),
                )
              }
              await api.updateChatMessageRecord(sessionId, messageId, { content: nextContent, blocks: nextBlocks }).catch(() => undefined)
              return
            }

            const buildBlocksWithFinal = (finalText: string): ChatMessageBlock[] => {
              const copied = Array.isArray(baseBlocks) ? baseBlocks.map((b) => ({ ...b })) : []
              const lastTextIdx = (() => {
                for (let i = copied.length - 1; i >= 0; i -= 1) {
                  if (copied[i].type === 'text') return i
                }
                return -1
              })()
              if (lastTextIdx >= 0) copied[lastTextIdx] = { type: 'text', text: finalText }
              else copied.push({ type: 'text', text: finalText })
              return copied
            }

            const toolAddon = buildToolResultSystemAddon(t)
            const mergedAddon = [finalizeCtx.systemAddon, toolAddon].filter(Boolean).join('\n\n')

            const prompt: ChatMessage[] = [
              ...finalizeCtx.chatHistory,
              {
                role: 'user',
                content: '工具已执行完毕。请基于工具执行结果继续完成刚才的请求：只输出最终自然语言回复，不要重复前置话术。',
              },
            ]

            finalizeAbort = new AbortController()
            finalizeAbortExposed = sessionId === currentSessionId
            const finalizeStopSeq = chatStopSeqRef.current
            const isFinalizeStopped = () => finalizeAbort?.signal.aborted === true || chatStopSeqRef.current !== finalizeStopSeq
            if (finalizeAbortExposed) {
              aiAbortRef.current = finalizeAbort
              isLoadingRef.current = true
              setIsLoading(true)
            }

            const previewProg = taskBubblePreviewProgressRef.current.get(t.id)
            const elapsedSincePreface = previewProg?.lastShownAt ? Date.now() - previewProg.lastShownAt : Number.POSITIVE_INFINITY
            const prefaceMinVisibleMs = 220
            if (elapsedSincePreface < prefaceMinVisibleMs) {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, prefaceMinVisibleMs - elapsedSincePreface)
              })
            }
            if (isFinalizeStopped()) return

            // 任务完成后的“二段回复”需要开启一个全新的气泡（前置话术气泡先结束，再显示新的思考/流式气泡）。
            sendBubblePreview({ clear: true }, { force: true })
            sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })

            const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false

            if (enableChatStreaming) {
              const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)
              const ttsUtteranceId = ttsSegmented ? `taskfinal-${messageId}-${Date.now().toString(36)}` : null
              let ttsSentSegments = 0

              let acc = ''
              let pending = ''
              let raf = 0
              let lastExpression: string | undefined
              let lastMotion: string | undefined

              const enqueueStableTts = (displayFinal: string, forceAll: boolean) => {
                if (!ttsUtteranceId) return
                const segs = splitTextIntoTtsSegments(displayFinal, { lang: 'zh', textSplitMethod: 'cut5' })
                const stableCount = countStableTtsSegments(displayFinal, segs, forceAll)
                if (stableCount <= ttsSentSegments) return
                const nextSegs = segs.slice(ttsSentSegments, stableCount)
                if (nextSegs.length === 0) return
                api.enqueueTtsUtterance({
                  utteranceId: ttsUtteranceId,
                  mode: ttsSentSegments === 0 ? 'replace' : 'append',
                  segments: nextSegs,
                  fullText: undefined,
                })
                ttsSentSegments = stableCount
              }

              const flush = () => {
                if (isFinalizeStopped()) {
                  pending = ''
                  return
                }
                if (!pending) return
                acc += pending
                pending = ''

                const displayFinal = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc))
                if (displayFinal.trim()) sendBubblePreview({ text: displayFinal, autoHideDelay: 0 })
                const nextBlocks = buildBlocksWithFinal(displayFinal)
                const nextContent = joinTextBlocks(nextBlocks)

                if (sessionId === currentSessionId) {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, blocks: nextBlocks } : m)),
                  )
                }

                enqueueStableTts(displayFinal, false)

                const tags = extractLastLive2DTags(acc)
                if (tags.expression && tags.expression !== lastExpression) {
                  lastExpression = tags.expression
                  api.triggerExpression(tags.expression)
                }
                if (tags.motion && tags.motion !== lastMotion) {
                  lastMotion = tags.motion
                  api.triggerMotion(tags.motion, 0)
                }
              }

              const scheduleFlush = () => {
                if (raf) return
                raf = window.requestAnimationFrame(() => {
                  raf = 0
                  flush()
                })
              }

              const response = await aiService.chatStream(prompt, {
                systemAddon: mergedAddon,
                signal: finalizeAbort.signal,
                onDelta: (delta) => {
                  if (isFinalizeStopped()) return
                  pending += delta
                  scheduleFlush()
                },
              })

              if (raf) {
                window.cancelAnimationFrame(raf)
                raf = 0
              }
              flush()
              if (isFinalizeStopped()) {
                sendBubblePreview({ clear: true }, { force: true })
                return
              }

              if (response.error) {
                sendBubblePreview({ clear: true }, { force: true })
                const nextText =
                  response.error === ABORTED_ERROR
                    ? normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc, { trim: true }))
                    : `[错误] ${response.error}`
                const nextBlocks = buildBlocksWithFinal(nextText)
                const nextContent = joinTextBlocks(nextBlocks)
                if (sessionId === currentSessionId) {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, blocks: nextBlocks } : m)),
                  )
                }
                await api.updateChatMessageRecord(sessionId, messageId, { content: nextContent, blocks: nextBlocks }).catch(() => undefined)
                return
              }

              const finalText = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc, { trim: true }))
              if (finalText.trim()) sendBubblePreview({ text: finalText, autoHideDelay: 0 })
              enqueueStableTts(finalText, true)
              if (ttsUtteranceId) {
                api.finalizeTtsUtterance(ttsUtteranceId)
              }
              const finalBlocks = buildBlocksWithFinal(finalText)
              const finalContent = joinTextBlocks(finalBlocks)
              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, content: finalContent, blocks: finalBlocks } : m)),
                )
                if (finalText && !ttsUtteranceId) api.sendBubbleMessage(finalText)
              }

              debugLog('chat:finalize.done', {
                taskId: t.id,
                sessionId,
                messageId,
                finalLen: finalText.length,
                finalBlocks: finalBlocks.map((b) =>
                  b.type === 'tool_use' ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId } : { type: b.type },
                ),
              })
              await api.updateChatMessageRecord(sessionId, messageId, { content: finalContent, blocks: finalBlocks }).catch(() => undefined)
              void runAutoExtractIfNeeded(sessionId)
              return
            }

            const response = await aiService.chat(prompt, { systemAddon: mergedAddon, signal: finalizeAbort.signal })
            if (isFinalizeStopped()) {
              sendBubblePreview({ clear: true }, { force: true })
              return
            }
            if (response.error) {
              sendBubblePreview({ clear: true }, { force: true })
              const nextText = response.error === ABORTED_ERROR ? '' : `[错误] ${response.error}`
              const nextBlocks = buildBlocksWithFinal(nextText)
              const nextContent = joinTextBlocks(nextBlocks)
              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, blocks: nextBlocks } : m)),
                )
              }
              await api.updateChatMessageRecord(sessionId, messageId, { content: nextContent, blocks: nextBlocks }).catch(() => undefined)
              return
            }

            const { displayText, expression, motion } = extractLive2DTags(response.content)
            if (displayText.trim()) sendBubblePreview({ text: displayText, autoHideDelay: 0 })
            const finalBlocks = buildBlocksWithFinal(displayText)
            const finalContent = joinTextBlocks(finalBlocks)

            if (sessionId === currentSessionId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === messageId ? { ...m, content: finalContent, blocks: finalBlocks } : m)),
              )
              if (displayText) api.sendBubbleMessage(displayText)
              if (expression) api.triggerExpression(expression)
              if (motion) api.triggerMotion(motion, 0)
            }

            await api.updateChatMessageRecord(sessionId, messageId, { content: finalContent, blocks: finalBlocks }).catch(() => undefined)
            void runAutoExtractIfNeeded(sessionId)
          })()
            .catch((err) => console.error('[TaskFinalize] failed:', err))
            .finally(() => {
              taskFinalizingRef.current.delete(t.id)
              taskFinalizeContextRef.current.delete(t.id)
              taskOriginSessionRef.current.delete(t.id)
              taskOriginMessageRef.current.delete(t.id)
              taskOriginBlocksRef.current.delete(t.id)
              taskToolUseSplitRef.current.delete(t.id)
              taskBubblePreviewProgressRef.current.delete(t.id)
              if (finalizeAbortExposed && aiAbortRef.current === finalizeAbort) {
                aiAbortRef.current = null
                isLoadingRef.current = false
                setIsLoading(false)
              }
            })

          continue
        }

        // 兼容旧链路（agent.run 等）：直接使用任务 finalReply/draftReply 回填
        const rawText = (() => {
          const fallback = String((isFinal ? (t.finalReply ?? t.draftReply ?? t.lastError) : (t.draftReply ?? t.lastError ?? t.finalReply)) ?? '')
          if (t.status !== 'failed') return fallback

          const baseText = String((isFinal ? (t.finalReply ?? t.draftReply) : (t.draftReply ?? t.finalReply)) ?? '').trim()
          const lastError = String(t.lastError ?? '').trim()
          if (!lastError) return baseText || fallback
          if (!baseText) return `[错误] ${lastError}`
          return baseText.includes(lastError) ? baseText : `${baseText}\n\n[错误] ${lastError}`
        })()
        const { displayText: displayTextRaw, expression, motion } = extractLive2DTags(rawText)
        const displayText = normalizeInterleavedTextSegment(displayTextRaw)

        const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
        const runIdsNow = runs.map((r) => String(r.id ?? '').trim()).filter(Boolean)

        let split = taskToolUseSplitRef.current.get(t.id) ?? { runIds: [], segments: [''], lastDisplay: '' }

        const knownIdsNow = new Set(runIdsNow)
        const hasOrphan = split.runIds.some((id) => !knownIdsNow.has(id)) || split.segments.length !== split.runIds.length + 1
        if (hasOrphan) {
          split = { runIds: [], segments: [''], lastDisplay: '' }
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        } else {
          split = { runIds: [...split.runIds], segments: [...split.segments], lastDisplay: String(split.lastDisplay ?? '') }
        }

        // 工具卡片不延迟：一旦发现新 toolRun，就立即插入到 turn 的 blocks 里（否则会出现“最后一刻工具卡才冒出来”的割裂感）。
        const prevRunIds = split.runIds
        const isPrefix = prevRunIds.every((id, i) => runIdsNow[i] === id)
        if (!isPrefix) {
          // 极少数情况：runId 顺序变化或被重置（例如任务重跑/存档异常），此时重置分块边界。
          split = {
            runIds: [...runIdsNow],
            segments: new Array(runIdsNow.length + 1).fill(''),
            lastDisplay: split.lastDisplay,
          }
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        } else if (runIdsNow.length > prevRunIds.length) {
          for (let i = prevRunIds.length; i < runIdsNow.length; i += 1) {
            split.runIds.push(runIdsNow[i])
            // 冻结当前文本段，新增一个“工具后的新段落”
            if (split.segments.length < split.runIds.length) split.segments.push('')
            split.segments.push('')
          }
        }

        {
          const frozenPrefix = split.segments.slice(0, Math.max(0, split.segments.length - 1)).join('')
          const tail = frozenPrefix && displayText.startsWith(frozenPrefix) ? displayText.slice(frozenPrefix.length) : displayText
          const lastIdx = Math.max(0, split.segments.length - 1)
          const prevTail = String(split.segments[lastIdx] ?? '')
          if (tail.startsWith(prevTail)) split.segments[lastIdx] = tail
          else if (!prevTail || computeAppendDelta(prevTail, tail)) split.segments[lastIdx] = tail
          else split.segments[lastIdx] = tail
        }
        split.lastDisplay = displayText

        const hasAnyText = displayText.trim().length > 0
        const segsForBlocks = mergeLeadingPunctuationAcrossToolBoundary(split.segments, split.runIds)
        const nextBlocks: ChatMessageBlock[] = (() => {
          const blocks: ChatMessageBlock[] = []

          if (!hasAnyText && split.runIds.length > 0 && !isFinal) {
            blocks.push({ type: 'status', text: '正在调用工具…' })
          }

          for (let i = 0; i < split.runIds.length + 1; i += 1) {
            const seg = String(segsForBlocks[i] ?? '')
            const normalizedSeg = normalizeInterleavedTextSegment(seg)
            if (normalizedSeg.trim().length > 0) blocks.push({ type: 'text', text: normalizedSeg })
            if (i < split.runIds.length) blocks.push({ type: 'tool_use', taskId: t.id, runId: split.runIds[i] })
          }
          if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
          return blocks
        })()

        const nextContent = joinTextBlocks(nextBlocks)
        taskOriginBlocksRef.current.set(t.id, nextBlocks)
        taskToolUseSplitRef.current.set(t.id, split)

        {
          const segLens = split.segments.map((s) => String(s ?? '').length).join(',')
          const sig = `${isFinal ? '1' : '0'}|${t.status}|${split.runIds.join(',')}|${segLens}|${displayText.length}|${nextBlocks
            .map((b) => (b.type === 'tool_use' ? `u:${String((b as { runId?: string }).runId ?? '')}` : b.type))
            .join(',')}`
          const prevSig = taskUiDebugSigRef.current.get(t.id) ?? ''
          if (sig !== prevSig) {
            taskUiDebugSigRef.current.set(t.id, sig)
            debugLog('chat:task.blocks', {
              taskId: t.id,
              status: t.status,
              isFinal,
              draftLen: displayText.length,
              runIds: split.runIds,
              segmentsLen: split.segments.map((s) => String(s ?? '').length),
              blocks: nextBlocks.slice(0, 40).map((b) =>
                b.type === 'tool_use'
                  ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId }
                  : { type: b.type },
              ),
            })
          }
        }

        if (sessionId === currentSessionId) {
          setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, blocks: nextBlocks } : m)))

          const frozenCount = split.runIds.length
          const previewPrev = taskBubblePreviewProgressRef.current.get(t.id) ?? { shownFrozen: 0, lastShownAt: 0, lastTailText: '' }
          const previewNext = { ...previewPrev }
          for (let i = previewNext.shownFrozen; i < frozenCount; i += 1) {
            const seg = normalizeInterleavedTextSegment(String(segsForBlocks[i] ?? ''))
            if (!seg.trim()) continue
            sendBubblePreview({ text: seg, autoHideDelay: 0 })
            previewNext.lastShownAt = Date.now()
          }
          previewNext.shownFrozen = Math.max(previewNext.shownFrozen, frozenCount)

          // agent.run 任务流（尤其“无工具卡”的场景）会持续通过 task.blocks 更新文本；
          // 这里把当前尾段实时同步到桌宠预览气泡，避免只停留在“思考中…”直到最终完成。
          if (!isFinal) {
            const tailIdx = Math.max(0, Math.min(segsForBlocks.length - 1, frozenCount))
            const tailText = normalizeInterleavedTextSegment(String(segsForBlocks[tailIdx] ?? ''))
            if (tailText.trim()) {
              if (tailText !== previewNext.lastTailText) {
                sendBubblePreview({ text: tailText, autoHideDelay: 0 })
                previewNext.lastShownAt = Date.now()
                previewNext.lastTailText = tailText
              }
            } else {
              previewNext.lastTailText = ''
            }
          } else {
            previewNext.lastTailText = ''
          }

          const previewHadVisibleText = previewNext.shownFrozen > 0 || previewPrev.lastTailText.trim().length > 0
          taskBubblePreviewProgressRef.current.set(t.id, previewNext)

          const tts = settingsRef.current?.tts
          const bubbleTtsEnabled = Boolean(tts?.enabled) && !(tts?.segmented ?? false)
          if (bubbleTtsEnabled) {
            const prev = taskBubbleTtsProgressRef.current.get(t.id) ?? { spokenFrozen: 0, spokeFinal: false }
            const nextProg = { ...prev }

            // 1) runId 增加时，前一段文本会被冻结；此时立刻播报该段（前置话术/工具间话术）
            const frozenCount = split.runIds.length
            for (let i = nextProg.spokenFrozen; i < frozenCount; i += 1) {
              const seg = normalizeInterleavedTextSegment(String(segsForBlocks[i] ?? ''))
              if (seg.trim()) api.sendBubbleMessage(seg)
            }
            nextProg.spokenFrozen = Math.max(nextProg.spokenFrozen, frozenCount)

            // 2) 任务结束时，只播报“最后一段”（工具后的最终回复），避免把前置话术重复念一遍
            if (isFinal && !nextProg.spokeFinal) {
              const lastSeg = normalizeInterleavedTextSegment(String(segsForBlocks[frozenCount] ?? ''))
              if (lastSeg.trim()) api.sendBubbleMessage(lastSeg)
              nextProg.spokeFinal = true
            }

            taskBubbleTtsProgressRef.current.set(t.id, nextProg)
          } else if (isFinal) {
            // 未开启普通 TTS（或启用分句模式）时：
            // - 若已经用预览流式展示过正文，则收尾时沿用“气泡自动隐藏”设置，不再重复打一遍完整气泡；
            // - 否则回退到旧行为（直接显示最终气泡）。
            const ttsEnabled = Boolean(tts?.enabled)
            if (!ttsEnabled && previewHadVisibleText) {
              const tailIdx = Math.max(0, Math.min(segsForBlocks.length - 1, frozenCount))
              const finalPreviewText = normalizeInterleavedTextSegment(String(segsForBlocks[tailIdx] ?? '')) || displayText
              const finalAutoHideDelay = Math.max(0, Math.min(60000, Math.floor(settingsRef.current?.bubble?.autoHideDelay ?? 5000)))
              if (finalPreviewText.trim()) {
                sendBubblePreview({ text: finalPreviewText, autoHideDelay: finalAutoHideDelay }, { force: true })
              } else {
                sendBubblePreview({ clear: true }, { force: true })
              }
            } else if (displayText) {
              api.sendBubbleMessage(displayText)
            }
          }

          if (isFinal) {
            if (expression) api.triggerExpression(expression)
            if (motion) api.triggerMotion(motion, 0)

            // 任务完成时，更新真实的 API usage 统计（用于上下文悬浮球）
            if (t.usage && t.usage.totalTokens > 0) {
              setLastApiUsage({
                promptTokens: t.usage.promptTokens,
                completionTokens: t.usage.completionTokens,
                totalTokens: t.usage.totalTokens,
              })
            }
          }
        }

        // 只在任务结束时落盘，避免频繁写入导致记忆/索引重复摄入
        if (isFinal) {
          api.updateChatMessageRecord(sessionId, messageId, { content: nextContent, blocks: nextBlocks }).catch(() => undefined)
          taskOriginSessionRef.current.delete(t.id)
          taskOriginMessageRef.current.delete(t.id)
          taskOriginBlocksRef.current.delete(t.id)
          taskToolUseSplitRef.current.delete(t.id)
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        }
      }
    })

    return () => off()
  }, [addSessionToolFacts, api, currentSessionId, debugLog, runAutoExtractIfNeeded, sendBubblePreview])

  const closeOverlays = useCallback(() => {
    setContextMenu(null)
    setSessionContextMenu(null)
    setShowSessionList(false)
  }, [])

  const readAvatarFile = useCallback((file: File, onLoaded: (dataUrl: string) => void) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 2 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => onLoaded(String(reader.result || ''))
    reader.readAsDataURL(file)
  }, [])

  const newAttachmentId = useCallback(() => {
    if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  const addPendingAttachment = useCallback((att: Omit<PendingAttachment, 'id'>) => {
    setPendingAttachments((prev) => [...prev, { id: newAttachmentId(), ...att }])
  }, [newAttachmentId])

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const readChatImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) return
      if (file.size > 5 * 1024 * 1024) {
        setError('图片太大（>5MB），请压缩后再发送')
        return
      }

      const readAsDataUrl = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('read failed'))
          reader.onload = () => resolve(String(reader.result || ''))
          reader.readAsDataURL(file)
        })

      try {
        const dataUrl = await readAsDataUrl()
        setError(null)

        const filePath = typeof (file as unknown as { path?: unknown }).path === 'string' ? String((file as unknown as { path: string }).path) : ''
        const saved = await api?.saveChatAttachment({
          kind: 'image',
          ...(filePath ? { sourcePath: filePath } : { dataUrl }),
          ...(file.name ? { filename: file.name } : {}),
        })
        if (saved?.ok) {
          addPendingAttachment({ kind: 'image', path: saved.path, filename: saved.filename, previewDataUrl: dataUrl })
        }
      } catch (err) {
        console.error('[chat] read/save image failed:', err)
        setError('读取/保存图片失败')
      }
    },
    [addPendingAttachment, api],
  )

  const readChatVideoFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/')) return
      const filePath = typeof (file as unknown as { path?: unknown }).path === 'string' ? String((file as unknown as { path: string }).path) : ''
      if (!filePath) {
        setError('当前视频无法读取本地路径（请用拖拽文件或“视频”按钮选择）')
        return
      }
      try {
        setError(null)
        const saved = await api?.saveChatAttachment({
          kind: 'video',
          sourcePath: filePath,
          ...(file.name ? { filename: file.name } : {}),
        })
        if (saved?.ok) addPendingAttachment({ kind: 'video', path: saved.path, filename: saved.filename })
      } catch (err) {
        console.error('[chat] save video failed:', err)
        setError('保存视频失败')
      }
    },
    [addPendingAttachment, api],
  )

  const canUseVision = settings?.ai?.enableVision ?? false

  const MmvectorImage = (props: { imagePath: string; alt: string }) => (
    <MmvectorImagePreview api={api} imagePath={props.imagePath} alt={props.alt} />
  )
  const chatOrbEnabled = settings?.chatUi?.contextOrbEnabled ?? false
  const chatOrbX = settings?.chatUi?.contextOrbX ?? 6
  const chatOrbY = settings?.chatUi?.contextOrbY ?? 14

  useEffect(() => {
    if (!api) return
    let disposed = false
    api
      .getMcpState()
      .then((snap) => {
        if (disposed) return
        setMcpSnapshotForContext(snap)
      })
      .catch(() => {
        /* ignore */
      })
    const off = api.onMcpChanged((snap) => {
      if (disposed) return
      setMcpSnapshotForContext(snap)
    })
    return () => {
      disposed = true
      off()
    }
  }, [api])

  const estimateTokensFromText = useCallback((text: string): number => {
    const cleaned = (text ?? '').trim()
    if (!cleaned) return 0
    return Math.max(1, Math.ceil(cleaned.length / 4))
  }, [])

  const estimateTokensForChatMessage = useCallback(
    (m: ChatMessage): number => {
      if (!m) return 0
      if (typeof m.content === 'string') return estimateTokensFromText(m.content)

      let total = 0
      for (const part of m.content) {
        if (part.type === 'text') total += estimateTokensFromText(part.text)
        else total += 800 // 图片大致占用（粗略估计）
      }
      return total
    },
    [estimateTokensFromText],
  )

  const toolDirectoryAddon = useMemo(() => {
    const defs = getBuiltinToolDefinitions()
    const lines: string[] = defs.map((d) => `- ${d.name}：${d.description}`)

    const servers = Array.isArray(mcpSnapshotForContext?.servers) ? mcpSnapshotForContext!.servers : []
    for (const s of servers) {
      const tools = Array.isArray(s.tools) ? s.tools : []
      for (const t of tools) {
        const toolName = typeof t?.toolName === 'string' ? t.toolName : ''
        if (!toolName) continue
        const desc =
          (typeof t?.description === 'string' && t.description.trim()) ||
          (typeof t?.title === 'string' && t.title.trim()) ||
          (typeof t?.name === 'string' && t.name.trim()) ||
          ''
        lines.push(`- ${toolName}：${desc || 'MCP tool'}`)
      }
    }

    const MAX_TOOL_LINES = 80
    const toolLines =
      lines.length > MAX_TOOL_LINES ? [...lines.slice(0, MAX_TOOL_LINES), `- ...（${lines.length - MAX_TOOL_LINES} 项已省略）`] : lines

    const toolSwitch = toolCallingEnabled ? `已启用（mode=${toolCallingMode}）` : '已关闭'
    const plannerSwitch = plannerEnabled ? `已启用（mode=${plannerMode}）` : '已关闭'

    return [
      '【可用工具（权威，本地注册表）】',
      toolLines.join('\n'),
      '',
      `当前开关：任务规划器${plannerSwitch}；工具执行${toolSwitch}`,
      '规则：只有当用户在问“你能做什么/有哪些工具/能力说明”时，才解释并列出工具；否则不要主动输出工具清单。',
      '注意：当“工具执行”为关闭时，不要承诺你会真的去执行这些工具；只能聊天/解释用法。',
    ]
      .filter(Boolean)
      .join('\n')
  }, [
    mcpSnapshotForContext,
    plannerEnabled,
    plannerMode,
    toolCallingEnabled,
    toolCallingMode,
  ])

  useEffect(() => {
    if (!api) return

    if (!memEnabled || !retrieveEnabled) {
      setContextRetrieveAddon('')
      return
    }

    const queryText = (input ?? '').trim()
    if (!queryText) {
      setContextRetrieveAddon('')
      return
    }

    const nowId = (contextRetrieveAddonReqIdRef.current += 1)
    const includeShared = settingsRef.current?.memory?.includeSharedOnRetrieve ?? true
    const personaId = getActivePersonaId()

    const timer = window.setTimeout(() => {
      void api
        .retrieveMemory({
          personaId,
          query: queryText,
          limit: 12,
          maxChars: 3200,
          includeShared,
          reinforce: false,
        })
        .then((res) => {
          if (contextRetrieveAddonReqIdRef.current !== nowId) return
          const addon = res.addon?.trim() ?? ''
          setContextRetrieveAddon(addon)
        })
        .catch(() => {
          if (contextRetrieveAddonReqIdRef.current !== nowId) return
          setContextRetrieveAddon('')
        })
    }, 800)

    return () => window.clearTimeout(timer)
  }, [api, getActivePersonaId, input, memEnabled, retrieveEnabled])

  const worldBookAddonForUsage = useMemo(() => {
    const activePersonaId = settings?.activePersonaId?.trim() || 'default'
    return buildWorldBookAddon(settings, activePersonaId)
  }, [settings])

  const systemAddonForUsage = useMemo(() => {
    const parts = [contextRetrieveAddon.trim(), worldBookAddonForUsage.trim(), toolDirectoryAddon.trim()].filter(Boolean)
    return parts.join('\n\n')
  }, [contextRetrieveAddon, toolDirectoryAddon, worldBookAddonForUsage])

  const trimChatHistoryToMaxContext = useCallback(
    (history: ChatMessage[], systemAddon: string): { history: ChatMessage[]; trimmedCount: number } => {
      const ai = settingsRef.current?.ai
      const maxContextTokensRaw = ai?.maxContextTokens ?? 128000
      const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

      const maxTokensRaw = ai?.maxTokens ?? 2048
      const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

      const systemPromptTokens = estimateTokensFromText(ai?.systemPrompt ?? '')
      const addonTokens = estimateTokensFromText(systemAddon ?? '')

      let budget = maxContextTokens - outputReserve - systemPromptTokens - addonTokens
      if (!Number.isFinite(budget) || budget < 256) budget = 256

      const kept: ChatMessage[] = []
      let total = 0
      for (let i = history.length - 1; i >= 0; i--) {
        const cost = estimateTokensForChatMessage(history[i])
        if (kept.length > 0 && total + cost > budget) break
        kept.push(history[i])
        total += cost
      }
      kept.reverse()
      return { history: kept, trimmedCount: Math.max(0, history.length - kept.length) }
    },
    [estimateTokensForChatMessage, estimateTokensFromText],
  )

  const maybeCompressChatHistoryToMaxContext = useCallback(
    async (
      _aiService: AIService,
      history: ChatMessage[],
      systemAddon: string,
      opts?: { signal?: AbortSignal; notify?: boolean; reason?: string },
    ): Promise<{ history: ChatMessage[]; trimmedCount: number; compressed: boolean }> => {
      const notify = opts?.notify ?? false
      const applyTrimOnly = (): { history: ChatMessage[]; trimmedCount: number; compressed: boolean } => {
        const trimmed = trimChatHistoryToMaxContext(history, systemAddon)
        if (notify && trimmed.trimmedCount > 0) {
          setError(`提示：对话上下文过长，已自动截断为最近 ${trimmed.history.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`)
        }
        return { ...trimmed, compressed: false }
      }

      const settingsSnapshot = settingsRef.current
      const ai = settingsSnapshot?.ai
      if (!ai) return applyTrimOnly()

      const compressionEnabled = ai.autoContextCompressionEnabled ?? true
      if (!compressionEnabled || history.length < 8) return applyTrimOnly()

      const maxContextTokensRaw = ai.maxContextTokens ?? 128000
      const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

      const maxTokensRaw = ai.maxTokens ?? 2048
      const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

      const systemPromptTokens = estimateTokensFromText(ai.systemPrompt ?? '')
      const addonTokens = estimateTokensFromText(systemAddon ?? '')
      const historyTokens = history.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
      const estimatedUsed = systemPromptTokens + addonTokens + historyTokens + outputReserve

      const thresholdPctRaw = ai.autoContextCompressionThresholdPct ?? 85
      const targetPctRaw = ai.autoContextCompressionTargetPct ?? 65
      const compressionModel = String(ai.autoContextCompressionModel ?? '').trim()
      const compressionApiSource = ai.autoContextCompressionApiSource === 'profile' ? 'profile' : 'main'
      const compressionProfileId = String(ai.autoContextCompressionProfileId ?? '').trim()
      const compressionProfile =
        compressionApiSource === 'profile'
          ? (Array.isArray(settingsSnapshot?.aiProfiles)
              ? settingsSnapshot.aiProfiles.find((p) => p.id === compressionProfileId) ?? null
              : null)
          : null
      const thresholdPct = Math.max(50, Math.min(99, Math.trunc(Number.isFinite(thresholdPctRaw) ? thresholdPctRaw : 85)))
      const targetPct = Math.max(35, Math.min(thresholdPct - 5, Math.trunc(Number.isFinite(targetPctRaw) ? targetPctRaw : 65)))

      const triggerTokens = Math.floor((maxContextTokens * thresholdPct) / 100)
      if (estimatedUsed <= triggerTokens) return applyTrimOnly()

      const targetUsedTokens = Math.floor((maxContextTokens * targetPct) / 100)
      let allowedHistoryTokensAfter = targetUsedTokens - outputReserve - systemPromptTokens - addonTokens
      if (!Number.isFinite(allowedHistoryTokensAfter) || allowedHistoryTokensAfter < 512) {
        allowedHistoryTokensAfter = 512
      }

      let keepRecentCount = Math.max(6, Math.min(12, history.length))
      while (keepRecentCount > 4) {
        const recent = history.slice(history.length - keepRecentCount)
        const recentTokens = recent.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
        if (recentTokens <= Math.max(256, allowedHistoryTokensAfter - 256)) break
        keepRecentCount -= 2
      }

      const oldMessages = history.slice(0, Math.max(0, history.length - keepRecentCount))
      const recentMessages = history.slice(Math.max(0, history.length - keepRecentCount))
      if (oldMessages.length < 4 || recentMessages.length === 0) return applyTrimOnly()

      const rawCompressionInput = buildContextCompressionSummaryPrompt(oldMessages)
      const compressionInput = rawCompressionInput.trim()
      if (!compressionInput) return applyTrimOnly()

      if (notify) {
        setError('提示：上下文接近阈值，正在自动压缩上下文…')
      }

        debugLog('chat:context.compress.start', {
          reason: opts?.reason ?? 'chat',
          totalMessages: history.length,
          oldMessages: oldMessages.length,
          keepRecentMessages: recentMessages.length,
          compressionApiSource,
          compressionProfileId: compressionProfile?.id ?? '',
          compressionModel: compressionModel || ai.model,
          estimatedUsed,
          maxContextTokens,
          thresholdPct,
        targetPct,
      })

      try {
        const compressionMaxTokens = Math.max(512, Math.min(2200, Math.trunc((ai.maxTokens ?? 2048) / 2)))
        const compressionAiSettings = {
          ...ai,
          apiKey: compressionProfile?.apiKey?.trim() || ai.apiKey,
          baseUrl: compressionProfile?.baseUrl?.trim() || ai.baseUrl,
          model: compressionModel || compressionProfile?.model?.trim() || ai.model,
        }
        const compactor = new AIService({
          ...compressionAiSettings,
          maxTokens: compressionMaxTokens,
          thinkingEffort: 'disabled',
          openaiReasoningEffort: 'disabled',
          claudeThinkingEffort: 'disabled',
          geminiThinkingEffort: 'disabled',
          enableVision: false,
          enableChatStreaming: false,
        })
        const summaryTargetChars = Math.max(600, Math.min(12000, allowedHistoryTokensAfter * 4))
        const compressionPrompt = compressionInput.length > 20000 ? `${compressionInput.slice(0, 20000)}\n\n（已截断过长历史）` : compressionInput

        const res = await compactor.chat(
          [
            {
              role: 'system',
              content:
                '你是“对话上下文压缩器”。请把更早对话压缩成可供后续回答继续使用的摘要。\n' +
                '要求：1) 只保留事实、偏好、约束、目标、已完成事项、未完成事项、关键结论；2) 不要编造；3) 用简体中文；4) 输出纯文本，不要 Markdown 标题/代码块；5) 尽量精简。',
            },
            {
              role: 'user',
              content:
                `请压缩以下较早对话（目标尽量简洁，约 ${summaryTargetChars} 字以内，不必严格）：\n\n` +
                compressionPrompt,
            },
          ],
          { signal: opts?.signal },
        )

        if (res.error) {
          if (res.error === ABORTED_ERROR) throw new DOMException('Aborted', 'AbortError')
          throw new Error(res.error)
        }

        let summaryText = normalizeAssistantDisplayText(res.content, { trim: true })
        if (!summaryText) throw new Error('压缩结果为空')
        if (summaryText.length > summaryTargetChars) {
          summaryText = `${summaryText.slice(0, summaryTargetChars).trim()}\n（摘要已截断）`
        }

        const summaryMessage: ChatMessage = {
          role: 'assistant',
          content: `【自动压缩上下文摘要（系统生成）】\n${summaryText}`,
        }

        const compressedHistory = [summaryMessage, ...recentMessages]
        const trimmed = trimChatHistoryToMaxContext(compressedHistory, systemAddon)

        debugLog('chat:context.compress.done', {
          reason: opts?.reason ?? 'chat',
          compressed: true,
          compressionApiSource,
          compressionProfileId: compressionProfile?.id ?? '',
          compressionModel: compressionAiSettings.model,
          oldMessages: oldMessages.length,
          keepRecentMessages: recentMessages.length,
          finalMessages: trimmed.history.length,
          trimmedCount: trimmed.trimmedCount,
        })

        if (notify) {
          const extraTrim = trimmed.trimmedCount > 0 ? `；另外又截断 ${trimmed.trimmedCount} 条` : ''
          setError(`提示：已自动压缩上下文（压缩 ${oldMessages.length} 条，保留最近 ${recentMessages.length} 条原文${extraTrim}）。`)
        }
        return { history: trimmed.history, trimmedCount: trimmed.trimmedCount, compressed: true }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.warn('[ContextCompression] failed:', err)
          debugLog('chat:context.compress.fail', {
            reason: opts?.reason ?? 'chat',
            error: err instanceof Error ? err.message : String(err),
          })
          if (notify) {
            setError('提示：自动压缩上下文失败，已回退为普通截断。')
          }
        }
        return applyTrimOnly()
      }
    },
    [debugLog, estimateTokensForChatMessage, estimateTokensFromText, trimChatHistoryToMaxContext],
  )

  const chatContextUsage = useMemo<ContextUsageSnapshot | null>(() => {
    const ai = settings?.ai
    if (!ai) return null

    const maxContextTokensRaw = ai.maxContextTokens ?? 128000
    const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

    const maxTokensRaw = ai.maxTokens ?? 2048
    const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

    // 如果有 API 返回的真实 usage，优先使用真实值
    if (lastApiUsage && lastApiUsage.promptTokens > 0) {
      // 真实的 usedTokens = 上次请求的 prompt_tokens + 上次请求的 completion_tokens
      // 这代表了当前上下文实际消耗的 token 数
      const realUsedTokens = lastApiUsage.promptTokens + lastApiUsage.completionTokens
      return {
        usedTokens: realUsedTokens,
        maxContextTokens,
        outputReserveTokens: outputReserve,
        systemPromptTokens: 0, // 真实 usage 时这些细分不再需要估算
        addonTokens: 0,
        historyTokens: lastApiUsage.promptTokens, // prompt_tokens 包含了 system + history
        trimmedCount: 0,
        updatedAt: Date.now(),
        isRealUsage: true, // 标记这是真实值
      }
    }

    // 没有真实 usage 时，使用估算值（发送前预测）
    const systemPromptTokens = estimateTokensFromText(ai.systemPrompt ?? '')
    const addonTokens = estimateTokensFromText(systemAddonForUsage ?? '')

    const chatHistory: ChatMessage[] = messages.map((m) => {
      if (m.role !== 'user') return { role: 'assistant', content: m.content }

      const imgCountFromAttachments = Array.isArray(m.attachments)
        ? m.attachments.filter((a) => a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'image').length
        : 0

      if ((m.image || imgCountFromAttachments > 0) && canUseVision) {
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
        const text = m.content === '[图片]' ? '' : m.content
        if (text.trim().length > 0) parts.push({ type: 'text', text })
        if (m.image) {
          parts.push({ type: 'image_url', image_url: { url: m.image } })
        } else {
          const n = Math.max(0, Math.min(4, imgCountFromAttachments))
          for (let i = 0; i < n; i += 1) parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
        }
        return { role: 'user', content: parts }
      }

      const plain = m.content.trim().length > 0 ? m.content : '[消息]'
      return { role: 'user', content: plain }
    })

    // 估算"下一次发送"时会附带的内容：把当前输入（以及待发送图片）也视为会进入上下文
    const inputText = (input ?? '').trim()
    const withPending: ChatMessage[] = [...chatHistory]
    const pendingImageCount = pendingAttachments.filter((a) => a.kind === 'image').length
    if (inputText || pendingImageCount > 0) {
      if (pendingImageCount > 0 && canUseVision) {
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
        if (inputText) parts.push({ type: 'text', text: inputText })
        const n = Math.max(0, Math.min(4, pendingImageCount))
        for (let i = 0; i < n; i += 1) parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
        withPending.push({ role: 'user', content: parts })
      } else {
        withPending.push({ role: 'user', content: inputText || '[消息]' })
      }
    }

    const trimmed = trimChatHistoryToMaxContext(withPending, systemAddonForUsage)
    const historyTokens = trimmed.history.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
    return {
      usedTokens: systemPromptTokens + addonTokens + historyTokens + outputReserve,
      maxContextTokens,
      outputReserveTokens: outputReserve,
      systemPromptTokens,
      addonTokens,
      historyTokens,
      trimmedCount: trimmed.trimmedCount,
      updatedAt: Date.now(),
    }
  }, [
    canUseVision,
    estimateTokensForChatMessage,
    estimateTokensFromText,
    input,
    lastApiUsage,
    messages,
    pendingAttachments,
    settings?.ai,
    systemAddonForUsage,
    trimChatHistoryToMaxContext,
  ])

  useEffect(() => {
    if (!api) return
    if (!chatContextUsage) return
    contextUsagePendingRef.current = chatContextUsage

    const flushPending = () => {
      const pending = contextUsagePendingRef.current
      if (!pending) return
      contextUsagePendingRef.current = null
      contextUsageLastSentAtRef.current = Date.now()
      try {
        api.setContextUsage(pending)
      } catch {
        /* ignore */
      }
    }

    const nowTs = Date.now()
    const waitMs = 250 - (nowTs - contextUsageLastSentAtRef.current)
    if (waitMs <= 0) {
      if (contextUsageSendTimerRef.current != null) {
        window.clearTimeout(contextUsageSendTimerRef.current)
        contextUsageSendTimerRef.current = null
      }
      flushPending()
      return
    }

    if (contextUsageSendTimerRef.current != null) return
    contextUsageSendTimerRef.current = window.setTimeout(() => {
      contextUsageSendTimerRef.current = null
      flushPending()
    }, waitMs)
  }, [api, chatContextUsage])

  useEffect(() => {
    return () => {
      if (contextUsageSendTimerRef.current != null) {
        window.clearTimeout(contextUsageSendTimerRef.current)
        contextUsageSendTimerRef.current = null
      }
      contextUsagePendingRef.current = null
    }
  }, [])

  const formatAiErrorForUser = useCallback((raw: string): { message: string; shouldAlert: boolean } => {
    const text = String(raw ?? '').trim()
    const lower = text.toLowerCase()
    const isContextTooLong =
      lower.includes('context_length') ||
      lower.includes('maximum context') ||
      (lower.includes('context') && lower.includes('length')) ||
      (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum'))) ||
      text.includes('上下文') ||
      text.includes('长度超出') ||
      text.includes('超出上下文')

    if (!isContextTooLong) return { message: text || '未知错误', shouldAlert: false }

    return {
      message: `上下文过长导致请求失败，可右键“一键总结”或清空对话后重试。（原始错误：${text || 'unknown'}）`,
      shouldAlert: true,
    }
  }, [])

  const pickAvatar = useCallback(
    (role: 'user' | 'assistant') => {
      if (role === 'user') userAvatarInputRef.current?.click()
      else assistantAvatarInputRef.current?.click()
    },
    [],
  )

  const refreshSessions = useCallback(async () => {
    if (!api) return
    const activePersonaId = getActivePersonaId()
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    let filtered = filterSessionsForPersona(allSessions)

    // 如果当前人设完全没有会话，则自动创建一个，避免出现“没有 currentSessionId 导致无法清空/发送”的卡死状态
    if (filtered.length === 0) {
      const created = await api.createChatSession(undefined, activePersonaId)
      const { sessions: again, currentSessionId: cur2 } = await api.listChatSessions()
      filtered = filterSessionsForPersona(again)
      setSessions(filtered)
      setCurrentSessionId(filtered.some((s) => s.id === cur2) ? cur2 : created.id)
      return
    }

    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null))
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const interrupt = useCallback(
    (opts?: { stopTts?: boolean }) => {
      chatStopSeqRef.current += 1
      try {
        aiAbortRef.current?.abort()
      } catch (_) {
        /* ignore */
      }
      aiAbortRef.current = null

      if (opts?.stopTts !== false) {
        try {
          api?.stopTtsAll()
        } catch (_) {
          /* ignore */
        }
      }

      sendBubblePreview({ clear: true }, { force: true })
      isLoadingRef.current = false
      setIsLoading(false)
    },
    [api, sendBubblePreview],
  )

  const isAssistantOutputting = isLoading || currentActiveChatTaskIds.length > 0

  const stopAssistantOutput = useCallback(() => {
    interrupt()
    if (!api || currentActiveChatTaskIds.length === 0) return

    for (const taskId of currentActiveChatTaskIds) {
      void api.cancelTask(taskId).catch((err) => console.error('[ChatStop] cancel task failed:', err))
    }
  }, [api, currentActiveChatTaskIds, interrupt])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        try {
          api?.stopTtsAll()
        } catch (_) {
          /* ignore */
        }
        if (isLoadingRef.current) {
          interrupt()
          return
        }
        closeOverlays()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [api, closeOverlays, interrupt])

  useEffect(() => {
    if (!editingMessageId) return
    const el = editingTextareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editingMessageId, editingMessageContent])

  const send = useCallback(async (override?: {
    text?: string
    source?: 'manual' | 'asr'
    baseMessages?: ChatMessageRecord[]
    attachments?: Array<{ kind: 'image' | 'video'; path: string; filename?: string }>
  }) => {
    const source = override?.source ?? 'manual'
    const text = (override?.text ?? inputRef.current).trim()
    const attachmentsRaw =
      source === 'manual'
        ? (override?.attachments ??
          pendingAttachments.map((a) => ({ kind: a.kind, path: a.path, filename: a.filename })))
        : (override?.attachments ?? [])
    const attachments = attachmentsRaw
      .map((a) => ({
        kind: a.kind,
        path: String(a.path ?? '').trim(),
        filename: typeof a.filename === 'string' ? a.filename.trim() : '',
      }))
      .filter((a) => (a.kind === 'image' || a.kind === 'video') && a.path.length > 0)
    if (!api || !currentSessionId) return

    // 发送新消息前先停止正在播放的 TTS/气泡（作为“打断”）
    try {
      api.stopTtsAll()
    } catch (_) {
      /* ignore */
    }

    if (isLoadingRef.current) {
      interrupt()
      if (!text && attachments.length === 0) return
    } else {
      if (!text && attachments.length === 0) return
    }

    const aiService = getAIService()
    if (!aiService) {
      setError('AI 服务未初始化，请先配置 AI 设置')
      return
    }

    // Add user message
    const attachmentLabel = (() => {
      const tags: string[] = []
      const imgCount = attachments.filter((a) => a.kind === 'image').length
      const vidCount = attachments.filter((a) => a.kind === 'video').length
      if (imgCount > 0) tags.push(imgCount === 1 ? '[图片]' : `[图片x${imgCount}]`)
      if (vidCount > 0) tags.push(vidCount === 1 ? '[视频]' : `[视频x${vidCount}]`)
      return tags.join('') || ''
    })()
    const firstImagePath = attachments.find((a) => a.kind === 'image')?.path ?? ''
    const firstVideoPath = attachments.find((a) => a.kind === 'video')?.path ?? ''
    const userMessage: ChatMessageRecord = {
      id: newMessageId(),
      role: 'user',
      content: text || attachmentLabel || '[消息]',
      attachments: attachments.length ? attachments : undefined,
      imagePath: firstImagePath || undefined, // 兼容旧逻辑：保留第一张图路径
      videoPath: firstVideoPath || undefined, // 兼容旧逻辑：保留第一个视频路径
      createdAt: Date.now(),
    }
    let baseMessages = override?.baseMessages ?? messagesRef.current
    let recoveredBaseFromStore = false
    if (!override?.baseMessages) {
      try {
        const persisted = await api.getChatSession(currentSessionId).catch(() => null)
        const persistedMessages = Array.isArray(persisted?.messages) ? persisted!.messages : []
        if (persistedMessages.length > baseMessages.length) {
          baseMessages = persistedMessages
          recoveredBaseFromStore = true
          messagesRef.current = persistedMessages
          setMessages((prev) => (prev.length >= persistedMessages.length ? prev : persistedMessages))
        }
      } catch {
        /* ignore */
      }
    }
    debugLog('chat:send.base', {
      sessionId: currentSessionId,
      source,
      inMemoryCount: (override?.baseMessages ?? messagesRef.current).length,
      baseCount: baseMessages.length,
      recoveredBaseFromStore,
    })
    const nextMessages = [...baseMessages, userMessage]
    messagesRef.current = nextMessages
    setMessages(nextMessages)
    if (source === 'manual') {
      inputRef.current = ''
      setInput('')
      syncAsrComposePreview('', { clearFinals: true })
      setPendingAttachments([])
    }
    if (source === 'asr' && (settingsRef.current?.asr?.autoSend ?? false)) {
      syncAsrComposePreview('', { clearFinals: true })
    }
    setError(null)
    isLoadingRef.current = true
    setIsLoading(true)
    sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })
    const abort = new AbortController()
    aiAbortRef.current = abort

    try {
      // Build chat history for context
      type VisionPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      const buildLastUserWithVision = async (m: ChatMessageRecord): Promise<ChatMessage> => {
        const text = String(m.content ?? '').trim()
        const imagePaths = attachments.filter((a) => a.kind === 'image').map((a) => a.path).slice(0, 4)
        if (!canUseVision || imagePaths.length === 0) return { role: 'user', content: text || attachmentLabel || '[消息]' }

        const parts: VisionPart[] = []
        if (text.length > 0) parts.push({ type: 'text', text })
        for (const p of imagePaths) {
          try {
            const res = await api.readChatAttachmentDataUrl(p)
            if (res?.ok && typeof res.dataUrl === 'string') parts.push({ type: 'image_url', image_url: { url: res.dataUrl } })
          } catch {
            /* ignore */
          }
        }
        if (parts.some((x) => x.type === 'image_url')) return { role: 'user', content: parts }
        return { role: 'user', content: text || attachmentLabel || '[消息]' }
      }

      let chatHistory: ChatMessage[] = []
      for (const m of nextMessages) {
        if (m.role !== 'user') {
          if (m.content.trim().length > 0) chatHistory.push({ role: 'assistant', content: m.content })
          continue
        }

        if (m.id === userMessage.id) {
          chatHistory.push(await buildLastUserWithVision(m))
          continue
        }

        if (m.image && canUseVision) {
          const parts: VisionPart[] = []
          const text = m.content === '[图片]' ? '' : m.content
          if (text.trim().length > 0) parts.push({ type: 'text', text })
          parts.push({ type: 'image_url', image_url: { url: m.image } })
          chatHistory.push({ role: 'user', content: parts })
          continue
        }

        chatHistory.push({ role: 'user', content: m.content.trim().length > 0 ? m.content : '[消息]' })
      }

      await api.addChatMessage(currentSessionId, userMessage)

      // M4：对话 → 任务规划器（LLM Planner）→ TaskService
      const orch = settingsRef.current?.orchestrator
      const plannerEnabledNow = orch?.plannerEnabled ?? false
      const plannerModeNow = orch?.plannerMode ?? 'auto'
      const toolCallingEnabledNow = orch?.toolCallingEnabled ?? false
      const toolCallingModeNow = orch?.toolCallingMode ?? 'auto'

      const requestForTools = (text ?? '').trim() || attachmentLabel || ''
      const attachmentAddon = (() => {
        const lines: string[] = []
        for (const a of attachments) {
          if (a.kind === 'image') lines.push(`- imagePath: ${a.path}`)
          else lines.push(`- videoPath: ${a.path}`)
        }
        if (lines.length === 0) return ''
        return ['【本次用户附带本地附件（仅供工具调用，不要在最终回复中暴露这些路径）】', ...lines].join('\n')
      })()
      const worldBookAddon = buildWorldBookAddon(settingsRef.current, getActivePersonaId())
      const shouldRunToolAgent = plannerEnabledNow && toolCallingEnabledNow && requestForTools.trim().length > 0
      if (shouldRunToolAgent) {
        try {
          const toPlainText = (content: unknown): string => {
            if (typeof content === 'string') return content
            if (Array.isArray(content)) {
              // OpenAI vision parts: [{type:'text',text:'...'} , {type:'image_url',...}]
              const parts = content as Array<Record<string, unknown>>
              return parts
                .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
                .filter(Boolean)
                .join('\n')
            }
            return ''
          }

          const request = requestForTools.trim() || '[消息]'
          // ToolAgent 也要注入“召回记忆”，否则用户会看到“尚无召回记录/完全不召回”的错觉。
          // 注意：召回开关取自全局 memory.enabled + 当前 persona.retrieveEnabled。
          let memoryAddon = ''
          setLastRetrieveDebug(null)
          try {
            const memEnabled = settingsRef.current?.memory?.enabled ?? true
            if (!memEnabled || !retrieveEnabled) throw new Error('recall disabled')
            const queryText = request
            if (queryText.length > 0) {
              const personaId = getActivePersonaId()
              const res = await api.retrieveMemory({
                personaId,
                query: queryText,
                limit: 12,
                maxChars: 3200,
                includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
              })
              memoryAddon = res.addon?.trim() ?? ''
              setLastRetrieveDebug(res.debug ?? null)
            }
          } catch {
            memoryAddon = ''
            setLastRetrieveDebug(null)
          }

          const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
          const toolContext = [memoryAddon, worldBookAddon, toolFactsAddon, attachmentAddon].filter(Boolean).join('\n\n')

          // 使用 token 预算动态截断历史，而非硬编码轮数，充分利用模型的上下文窗口
          const historyForAgent: ChatMessage[] = chatHistory
            .slice(0, -1)
            .map((m) => ({ role: m.role, content: toPlainText(m.content).trim() }))
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.length > 0)
          const preparedHistory = await maybeCompressChatHistoryToMaxContext(aiService, historyForAgent, toolContext, {
            signal: abort.signal,
            notify: true,
            reason: 'tool-agent',
          })
          const history = preparedHistory.history

          const title = request.length > 40 ? `${request.slice(0, 40)}…` : request
          const visionImagePaths = canUseVision ? attachments.filter((a) => a.kind === 'image').map((a) => a.path).slice(0, 4) : []

          const created = await api.createTask({
            queue: 'chat',
            title: title || '对话',
            why: '对话工具代理（agent.run）',
            steps: [
              {
                title: '对话/工具',
                tool: 'agent.run',
                input: JSON.stringify({
                  request,
                  mode: toolCallingModeNow,
                  history,
                  context: toolContext,
                  ...(visionImagePaths.length > 0 ? { imagePaths: visionImagePaths } : {}),
                }),
              },
            ],
          })

          taskOriginSessionRef.current.set(created.id, currentSessionId)
          taskToolUseSplitRef.current.set(created.id, { runIds: [], segments: [''], lastDisplay: '' })

          const assistantId = newMessageId()
          // 先用轻量状态占位，避免“空消息/无反馈”；真正的文本与工具卡片由任务流式进度增量驱动更新。
          const blocks: ChatMessageBlock[] = [{ type: 'status', text: '思考中…' }]
          const assistantMessage: ChatMessageRecord = {
            id: assistantId,
            role: 'assistant',
            content: joinTextBlocks(blocks),
            blocks,
            taskId: created.id,
            createdAt: Date.now(),
          }

          taskOriginMessageRef.current.set(created.id, assistantId)
          taskOriginBlocksRef.current.set(created.id, blocks)
          debugLog('chat:agentRun.created', {
            sessionId: currentSessionId,
            taskId: created.id,
            messageId: assistantId,
            blocks,
          })

          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          return
        } catch (err) {
          console.error('[ToolAgent] failed:', err)
          // 失败时回退到原先的 planner/普通聊天链路
        }
      }

      const shouldTryPlanner =
        plannerEnabledNow &&
        toolCallingEnabledNow &&
        (plannerModeNow === 'always' || plannerModeNow === 'auto') &&
        requestForTools.trim().length > 0

      if (shouldTryPlanner) {
        try {
          const toolSettingsNow = settingsRef.current?.tools
          const builtinToolNames = getBuiltinToolDefinitions().map((t) => t.name)

          let mcpToolNames: string[] = []
          try {
            const mcp = await api.getMcpState()
            const servers = Array.isArray(mcp.servers) ? mcp.servers : []
            mcpToolNames = servers.flatMap((s) => {
              const tools = Array.isArray(s.tools) ? s.tools : []
              return tools.map((t) => (typeof t?.toolName === 'string' ? t.toolName : '')).filter(Boolean)
            })
          } catch {
            mcpToolNames = []
          }

          const plannerToolNames = Array.from(new Set([...builtinToolNames, ...mcpToolNames].map((t) => t.trim()).filter(Boolean))).filter(
            (t) => isToolEnabled(t, toolSettingsNow),
          )
          const plannerToolSet = new Set(plannerToolNames)

          // Planner 也使用 token 预算动态截断历史
          const plannerHistoryRaw: ChatMessage[] = nextMessages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: typeof m.content === 'string' ? m.content : '',
          }))
          const plannerContext = [worldBookAddon, attachmentAddon].filter(Boolean).join('\n\n')
          const plannerPrepared = await maybeCompressChatHistoryToMaxContext(aiService, plannerHistoryRaw, plannerContext, {
            signal: abort.signal,
            notify: true,
            reason: 'planner',
          })
          const plannerHistory = plannerPrepared.history

          const planRes = await aiService.chat(
            [
              {
                role: 'system',
                content: buildPlannerSystemPrompt({
                  systemPrompt: settingsRef.current?.ai?.systemPrompt,
                  toolNames: plannerToolNames,
                  expressions: toolAnimRef.current.expressions ?? [],
                  motions: toolAnimRef.current.motionGroups ?? [],
                }),
              },
              ...(worldBookAddon ? [{ role: 'system' as const, content: worldBookAddon }] : []),
              ...(attachmentAddon ? [{ role: 'system' as const, content: attachmentAddon }] : []),
              ...(requestLikelyNeedsToolAction(requestForTools)
                ? [
                    {
                      role: 'system' as const,
                      content:
                        '程序提示：本轮用户请求可能需要工具行动。若确实需要截图、搜索、网页操作、文件读写或运行命令，优先输出 create_task；若只是普通聊天、解释、安慰、角色互动或不需要真实工具结果，允许输出 chat。',
                    },
                  ]
                : []),
              ...plannerHistory,
            ],
            { signal: abort.signal },
          )

          if (planRes.error) {
            if (planRes.error === ABORTED_ERROR) return
          } else {
            const decision = parsePlannerDecision(planRes.content)

            if (decision?.type === 'need_info') {
              plannerPendingRef.current = true
              const assistantMessage: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: decision.assistantReply,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              if (assistantMessage.content) api.sendBubbleMessage(assistantMessage.content)
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'create_task') {
              const runnable = (decision.task.steps ?? []).some((s) => typeof s.tool === 'string' && plannerToolSet.has(s.tool))
              if (!runnable) throw new Error('规划器未生成可执行步骤（没有可用 tool）')

              const inferQueue = (): TaskCreateArgs['queue'] => {
                if (decision.task.queue) return decision.task.queue
                const tools = (decision.task.steps ?? []).map((s) => (typeof s.tool === 'string' ? s.tool : ''))
                if (tools.some((t) => t.startsWith('browser.'))) return 'browser'
                if (tools.some((t) => t.startsWith('cli.'))) return 'cli'
                if (tools.some((t) => t.startsWith('file.'))) return 'file'
                if (tools.some((t) => t.startsWith('llm.'))) return 'chat'
                return 'other'
              }

              const queue = inferQueue()

              const created = await api.createTask({ ...decision.task, queue })

              taskOriginSessionRef.current.set(created.id, currentSessionId)

              plannerPendingRef.current = false

              // 统一为“单消息 turn 容器”：前置对话 + ToolUse 卡片 +（任务完成后追加的最终回复）
              const prefaceRaw = String(decision.assistantReply ?? '').trim()
              const prefaceText = prefaceRaw ? normalizeAssistantDisplayText(prefaceRaw, { trim: true }) : ''
              const prefaceTags = prefaceRaw ? extractLastLive2DTags(prefaceRaw) : { expression: undefined, motion: undefined }

              const assistantId = newMessageId()
              const blocks: ChatMessageBlock[] = [
                ...(prefaceText ? [{ type: 'text', text: prefaceText } as const] : []),
                { type: 'tool_use', taskId: created.id },
                { type: 'text', text: '' },
              ]

              const assistantMessage: ChatMessageRecord = {
                id: assistantId,
                role: 'assistant',
                content: joinTextBlocks(blocks),
                blocks,
                taskId: created.id,
                createdAt: Date.now(),
              }

              taskOriginMessageRef.current.set(created.id, assistantId)
              taskOriginBlocksRef.current.set(created.id, blocks)

              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)

              if (prefaceText) api.sendBubbleMessage(prefaceText)
              {
                const resolveFromList = (nameRaw: string, list: string[]): string | null => {
                  const name = String(nameRaw ?? '').trim()
                  if (!name) return null
                  if (list.includes(name)) return name
                  const lower = name.toLowerCase()
                  return list.find((x) => x.toLowerCase() === lower) ?? null
                }
                const exp = prefaceTags.expression
                  ? resolveFromList(prefaceTags.expression, toolAnimRef.current.expressions ?? [])
                  : null
                const motion = prefaceTags.motion ? resolveFromList(prefaceTags.motion, toolAnimRef.current.motionGroups ?? []) : null
                if (exp) api.triggerExpression(exp)
                if (motion) api.triggerMotion(motion, 0)
              }

              // 任务完成后：用“同一 turn 第二段 LLM 请求”生成最终回复（不把工具结果写进对话/记忆正文）
              let systemAddon = ''
              try {
                const memEnabled = settingsRef.current?.memory?.enabled ?? true
                if (!memEnabled) throw new Error('memory disabled')
                const queryText = (text ?? '').trim()
                if (queryText.length > 0) {
                  const personaId = getActivePersonaId()
                  const res = await api.retrieveMemory({
                    personaId,
                    query: queryText,
                    limit: 12,
                    maxChars: 3200,
                    includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
                  })
                  systemAddon = res.addon?.trim() ?? ''
                }
              } catch {
                systemAddon = ''
              }
              const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
              const mergedSystemAddon = [systemAddon.trim(), worldBookAddon.trim(), toolFactsAddon.trim()].filter(Boolean).join('\n\n')

              const historyWithPreface = [...chatHistory, { role: 'assistant' as const, content: assistantMessage.content }]
              const trimmed = await maybeCompressChatHistoryToMaxContext(aiService, historyWithPreface, mergedSystemAddon, {
                signal: abort.signal,
                notify: false,
                reason: 'task-finalize',
              })
              taskFinalizeContextRef.current.set(created.id, {
                sessionId: currentSessionId,
                messageId: assistantId,
                chatHistory: trimmed.history,
                systemAddon: mergedSystemAddon,
                userText: text,
              })
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'chat') {
              plannerPendingRef.current = false
              // 纯聊天：不使用 planner 的“代答复”，保持一次请求的流式对话体验
            }
          }
        } catch (err) {
          console.error('[Planner] failed:', err)
        }
      }

      const systemAddonParts: string[] = []
      setLastRetrieveDebug(null)
      try {
        const memEnabled = settingsRef.current?.memory?.enabled ?? true
        if (!memEnabled) throw new Error('memory disabled')
        const queryText = (text ?? '').trim()
        if (queryText.length > 0) {
          const personaId = getActivePersonaId()
          const res = await api.retrieveMemory({
            personaId,
            query: queryText,
            limit: 12,
            maxChars: 3200,
            includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
          })
          const addon = res.addon?.trim() ?? ''
          if (addon) systemAddonParts.push(addon)
          setLastRetrieveDebug(res.debug ?? null)
        }
      } catch (_) {
        setLastRetrieveDebug(null)
      }

      {
        if (worldBookAddon.trim()) systemAddonParts.push(worldBookAddon.trim())
      }

      {
        const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
        if (toolFactsAddon.trim()) systemAddonParts.push(toolFactsAddon.trim())
      }

      const systemAddon = systemAddonParts.filter(Boolean).join('\n\n')

      {
        const prepared = await maybeCompressChatHistoryToMaxContext(aiService, chatHistory, systemAddon, {
          signal: abort.signal,
          notify: true,
          reason: 'chat-send',
        })
        chatHistory = prepared.history
      }

      const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false
      const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)

      if (ttsSegmented) {
        const utteranceId = newMessageId()
        setTtsPendingUtteranceId(utteranceId)
        setTtsRevealedSegments((prev) => ({ ...prev, [utteranceId]: 0 }))
        const segmentedStopSeq = chatStopSeqRef.current
        const isSegmentedStopped = () => abort.signal.aborted || chatStopSeqRef.current !== segmentedStopSeq

        try {
          const response = enableChatStreaming
            ? await (async () => {
                let acc = ''

                const res = await aiService.chatStream(chatHistory, {
                  signal: abort.signal,
                  systemAddon,
                  onDelta: (delta) => {
                    if (isSegmentedStopped()) return
                    acc += delta
                    const display = normalizeAssistantDisplayText(acc)
                    if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
                  },
                })
                if (isSegmentedStopped()) return { content: '', error: ABORTED_ERROR }
                if (!res.error) {
                  const merged = res.content?.trim().length ? res.content : acc
                  return { ...res, content: merged }
                }
                return res
              })()
            : await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

          if (isSegmentedStopped()) {
            sendBubblePreview({ clear: true }, { force: true })
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            return
          }

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              sendBubblePreview({ clear: true }, { force: true })
              setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
              setTtsRevealedSegments((prev) => {
                const next = { ...prev }
                delete next[utteranceId]
                return next
              })
              return
            }
            sendBubblePreview({ clear: true }, { force: true })
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            const msg: ChatMessageRecord = {
              id: newMessageId(),
              role: 'assistant',
              content: `[错误] ${response.error}`,
              createdAt: Date.now(),
            }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
            return
          }

          const content = normalizeAssistantDisplayText(response.content, { trim: true })
          if (content.trim()) sendBubblePreview({ text: content, autoHideDelay: 0 })
          // 更新真实的 API usage 统计
          if (response.usage) setLastApiUsage(response.usage)
          const assistantCreatedAt = Date.now()

          const assistantMessage: ChatMessageRecord = {
            id: utteranceId,
            role: 'assistant',
            content,
            createdAt: assistantCreatedAt,
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          setTtsSegmentedMessageFlags((prev) => ({ ...prev, [utteranceId]: true }))

          const segs = splitTextIntoTtsSegments(content, { lang: 'zh', textSplitMethod: 'cut5' })
          ttsUtteranceMetaRef.current[utteranceId] = {
            sessionId: currentSessionId,
            createdAt: assistantCreatedAt,
            messageId: utteranceId,
            displayedSegments: 0,
            fallbackContent: content,
          }

          api.enqueueTtsUtterance({ utteranceId, mode: 'replace', segments: segs.length ? segs : [content], fullText: content })
          api.finalizeTtsUtterance(utteranceId)

          if (response.expression) api.triggerExpression(response.expression)
          if (response.motion) api.triggerMotion(response.motion, 0)
        } catch (err) {
          sendBubblePreview({ clear: true }, { force: true })
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
          setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
          setTtsRevealedSegments((prev) => {
            const next = { ...prev }
            delete next[utteranceId]
            return next
          })
          const assistantMessage: ChatMessageRecord = {
            id: newMessageId(),
            role: 'assistant',
            content: `[错误] ${msg}`,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
        }

        return
      }

      if (enableChatStreaming) {
        const assistantId = newMessageId()
        let created = false
        const createdAt = Date.now()
        let acc = ''
        let pending = ''
        let lastExpression: string | undefined
        let lastMotion: string | undefined
        const streamStopSeq = chatStopSeqRef.current
        const isStreamStopped = () => abort.signal.aborted || chatStopSeqRef.current !== streamStopSeq

        const ensureMessageCreated = () => {
          if (isStreamStopped()) return
          if (created) return
          created = true
          const assistantMessage: ChatMessageRecord = {
            id: assistantId,
            role: 'assistant',
            content: '',
            createdAt,
          }
          setMessages((prev) => [...prev, assistantMessage])
          api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
        }

        const flush = () => {
          if (isStreamStopped()) {
            pending = ''
            return
          }
          if (!pending) return
          acc += pending
          pending = ''
          if (!created) ensureMessageCreated()
          const display = normalizeAssistantDisplayText(acc)
          if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)))

          const tags = extractLastLive2DTags(acc)
          if (tags.expression && tags.expression !== lastExpression) {
            lastExpression = tags.expression
            api.triggerExpression(tags.expression)
          }
          if (tags.motion && tags.motion !== lastMotion) {
            lastMotion = tags.motion
            api.triggerMotion(tags.motion, 0)
          }
        }

        const response = await aiService.chatStream(chatHistory, {
          signal: abort.signal,
          systemAddon,
          onDelta: (delta) => {
            if (isStreamStopped()) return
            pending += delta
            flush()
          },
        })
        flush()
        if (isStreamStopped()) {
          sendBubblePreview({ clear: true }, { force: true })
          return
        }

        if (response.error) {
          if (response.error === ABORTED_ERROR) {
            // 被打断：不写入错误信息，直接结束
            sendBubblePreview({ clear: true }, { force: true })
            return
          }
          const partialForUi = normalizeAssistantDisplayText(response.content || acc, { trim: true })
          if (partialForUi) sendBubblePreview({ text: partialForUi, autoHideDelay: 0 })
          else sendBubblePreview({ clear: true }, { force: true })
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const nextContent = buildInterruptedStreamContent(partialForUi, response.error)
          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }
          return
        }

        const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
        // 更新真实的 API usage 统计
        if (response.usage) setLastApiUsage(response.usage)
        if (created) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalContent } : m)))
          await api.updateChatMessage(currentSessionId, assistantId, finalContent).catch(() => undefined)
        } else {
          const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: finalContent, createdAt }
          setMessages((prev) => [...prev, msg])
          await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
        }
        if (finalContent.trim()) sendBubblePreview({ text: finalContent, autoHideDelay: 0 })
        if (finalContent) api.sendBubbleMessage(finalContent)
        void runAutoExtractIfNeeded(currentSessionId)
        return
      }

      const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

      if (response.error) {
        if (response.error === ABORTED_ERROR) {
          sendBubblePreview({ clear: true }, { force: true })
          return
        }
        sendBubblePreview({ clear: true }, { force: true })
        const errUi = formatAiErrorForUser(response.error)
        setError(errUi.message)
        if (errUi.shouldAlert) window.alert(errUi.message)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${response.error}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)
        return
      }

      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      }
      // 更新真实的 API usage 统计
      if (response.usage) setLastApiUsage(response.usage)
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage)

      if (response.expression) api.triggerExpression(response.expression)
      if (response.motion) api.triggerMotion(response.motion, 0)
      if (response.content?.trim()) sendBubblePreview({ text: response.content, autoHideDelay: 0 })
      if (response.content) api.sendBubbleMessage(response.content)
      void runAutoExtractIfNeeded(currentSessionId)
    } catch (err) {
      sendBubblePreview({ clear: true }, { force: true })
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: `[错误] ${errorMessage}`,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
    } finally {
      if (aiAbortRef.current === abort) aiAbortRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      refreshSessions().catch(() => undefined)
    }
  }, [
    api,
    canUseVision,
    currentSessionId,
    debugLog,
    getActivePersonaId,
    newMessageId,
    pendingAttachments,
    buildSessionToolFactsAddon,
    refreshSessions,
    retrieveEnabled,
    interrupt,
    runAutoExtractIfNeeded,
    maybeCompressChatHistoryToMaxContext,
    formatAiErrorForUser,
    syncAsrComposePreview,
    sendBubblePreview,
  ])

  const flushAsrAutoSendQueue = useCallback(() => {
    if (!api) return
    if (!currentSessionId) return
    if (asrAutoSendFlushingRef.current) return

    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (!asr.autoSend) return

    const pending = pendingAsrAutoSendRef.current
    if (pending.length === 0) return

    asrAutoSendFlushingRef.current = true
    const batch = pending.slice(0, pending.length)
    pendingAsrAutoSendRef.current = []

    void (async () => {
      try {
        for (const text of batch) {
          const cleaned = String(text ?? '').trim()
          if (!cleaned) continue
          await send({ text: cleaned, source: 'asr' })
        }
      } finally {
        asrAutoSendFlushingRef.current = false
      }
      flushAsrAutoSendQueue()
    })()
  }, [api, currentSessionId, send])

  // ASR transcript from pet window: manual mode fills input only; autoSend mode triggers send（chat window 可隐藏）
  useEffect(() => {
    if (!api) return

    let cancelled = false
    let drainingPending = false

    const handleTranscript = (text: string) => {
      const cleaned = String(text ?? '').trim()
      if (!cleaned) return

      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return

      if (asr.autoSend) {
        if (!currentSessionId) {
          pendingAsrAutoSendRef.current.push(cleaned)
          syncAsrComposePreview('', { clearFinals: true })
          return
        }
        syncAsrComposePreview('', { clearFinals: true })
        void send({ text: cleaned, source: 'asr', baseMessages: messagesRef.current }).then(() => flushAsrAutoSendQueue())
        return
      }

      setInput((prev) => {
        const base = prev.trim()
        const next = !base ? cleaned : `${prev} ${cleaned}`
        inputRef.current = next
        queueMicrotask(() => syncAsrComposePreview(next))
        return next
      })
    }

    const notifyTranscriptReady = () => {
      try {
        api.notifyAsrTranscriptReady()
      } catch {
        /* ignore */
      }
    }

    const drainPendingTranscript = () => {
      if (drainingPending) return
      drainingPending = true
      void (async () => {
        try {
          // 告知主进程聊天窗口已可接收实时 transcript，避免文本长期堆积在 pending 队列里。
          notifyTranscriptReady()
          const asr = settingsRef.current?.asr
          if (!asr?.enabled) return
          const cached = await api.takeAsrTranscript().catch(() => '')
          if (cancelled) return
          handleTranscript(cached)
        } finally {
          drainingPending = false
        }
      })()
    }

    const off = api.onAsrTranscript(handleTranscript)
    drainPendingTranscript()
    const onWindowVisible = () => {
      notifyTranscriptReady()
      if (document.visibilityState !== 'visible') return
      drainPendingTranscript()
    }
    window.addEventListener('focus', onWindowVisible)
    document.addEventListener('visibilitychange', onWindowVisible)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onWindowVisible)
      document.removeEventListener('visibilitychange', onWindowVisible)
      off()
    }
  }, [api, currentSessionId, flushAsrAutoSendQueue, send, syncAsrComposePreview])

  useEffect(() => {
    flushAsrAutoSendQueue()
  }, [flushAsrAutoSendQueue])

  useEffect(() => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) {
      syncAsrComposePreview('', { clearFinals: true })
      return
    }
    if (asr.autoSend) {
      syncAsrComposePreview('', { clearFinals: true })
      return
    }
    syncAsrComposePreview(inputRef.current)
  }, [currentSessionId, input, settings?.asr?.enabled, settings?.asr?.autoSend, syncAsrComposePreview])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isAssistantOutputting) stopAssistantOutput()
      else send()
    }
  }

  const clearMessages = () => {
    if (!api) return
    setMessages([])
    setError(null)
    ;(async () => {
      const sid =
        currentSessionId ??
        (await api.listChatSessions().then((r) => r.currentSessionId).catch(() => '')) ??
        ''
      if (!sid) return
      await api.clearChatSession(sid)
      await refreshSessions()
    })().catch((err) => console.error(err))
  }

  const handleNewSession = useCallback(async () => {
    if (!api) return
    const session = await api.createChatSession(undefined, getActivePersonaId())
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    const filtered = filterSessionsForPersona(allSessions)
    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : session.id)
    setMessages(session.messages)
    setError(null)
    setShowSessionList(false)
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      await api.setCurrentChatSession(sessionId)
      const session = await api.getChatSession(sessionId)
      setCurrentSessionId(sessionId)
      setMessages(session.messages)
      setLastApiUsage(null) // 切换会话时清空真实 usage，使用估算值直到收到新的 API 响应
      setError(null)
      setShowSessionList(false)
    },
    [api],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const result = await api.deleteChatSession(sessionId)
      const filtered = filterSessionsForPersona(result.sessions)
      setSessions(filtered)
      let nextId =
        filtered.some((s) => s.id === result.currentSessionId) ? result.currentSessionId : (filtered[0]?.id ?? null)
      if (!nextId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextId = created.id
      }
      setCurrentSessionId(nextId)
      const session = await api.getChatSession(nextId)
      setMessages(session.messages)
      setError(null)
      setShowSessionList(false)
    },
    [api, filterSessionsForPersona, getActivePersonaId],
  )

  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      if (!api) return
      await api.renameChatSession(sessionId, name)
      const { sessions: allSessions } = await api.listChatSessions()
      setSessions(filterSessionsForPersona(allSessions))
      setEditingSessionId(null)
      setEditingSessionName('')
    },
    [api, filterSessionsForPersona],
  )

  const handleMessageContextMenu = useCallback((e: React.MouseEvent, messageId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setSessionContextMenu(null)
    setContextMenu({ messageId, x: e.clientX, y: e.clientY })
  }, [])

  const handleChatRootContextMenu = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    if (el.closest('.ndp-msg-row')) return
    if (el.closest('.ndp-session-list')) return
    if (el.closest('.ndp-context-menu')) return
    e.preventDefault()
    setContextMenu(null)
    setSessionContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const runQuickExtract = useCallback(async () => {
    if (!api) return
    if (!currentSessionId) return

    const settings = settingsRef.current
    const mem = settings?.memory
    if (!mem?.enabled) {
      window.alert('记忆功能已关闭，请先在设置中开启。')
      return
    }
    if (!settings?.ai) {
      window.alert('AI 服务未配置，请先在设置中配置 API Key。')
      return
    }

    if (autoExtractRunningRef.current[currentSessionId]) {
      window.alert('正在提炼中，请稍后再试。')
      return
    }
    autoExtractRunningRef.current[currentSessionId] = true

    let attemptAt = 0
    let effectiveCount = 0
    try {
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )

      const useCustomAi = !!mem.autoExtractUseCustomAi
      const base = settings.ai
      const extractAiSettings = useCustomAi
        ? {
            ...base,
            apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
            baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
            model: mem.autoExtractAiModel?.trim() || base.model,
            temperature:
              typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                ? mem.autoExtractAiTemperature
                : base.temperature,
            maxTokens:
              typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                ? mem.autoExtractAiMaxTokens
                : base.maxTokens,
          }
        : base

      const ai = new AIService(extractAiSettings)

      const session = await api.getChatSession(currentSessionId)
      attemptAt = Date.now()
      const effective = collapseAssistantRuns(session.messages)
      effectiveCount = effective.length
      if (effectiveCount < 4) {
        window.alert('对话内容太少，暂时不需要总结。')
        return
      }

      const tail = sliceTail(effective, maxEffective)
      const conversation = tail
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n\n')
        .trim()
      if (!conversation) {
        window.alert('对话内容为空，无法总结。')
        return
      }

      const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。
规则：1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。4) 如果没有值得记的内容，返回空数组 []。5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。
输出格式：[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]
说明：scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

      const res = await ai.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
      ])
      if (res.error) {
        const msg = `一键总结失败：${res.error}`
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const parseJsonArray = (text: string): unknown[] | null => {
        const cleaned = (text ?? '').trim()
        if (!cleaned) return null
        try {
          const parsed = JSON.parse(cleaned)
          return Array.isArray(parsed) ? parsed : null
        } catch {
          const start = cleaned.indexOf('[')
          const end = cleaned.lastIndexOf(']')
          if (start < 0 || end < 0 || end <= start) return null
          const slice = cleaned.slice(start, end + 1)
          try {
            const parsed = JSON.parse(slice)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            return null
          }
        }
      }

      const arr = parseJsonArray(res.content)
      if (!arr) {
        const msg = '一键总结失败：无法解析模型输出（不是 JSON 数组）。'
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const uniq = new Set<string>()
      const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        const obj = it as Record<string, unknown>
        const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
        const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
        const content = typeof obj.content === 'string' ? obj.content.trim() : ''
        if (!content) continue
        const normalized = content.replace(/\s+/g, ' ').trim()
        if (!normalized) continue
        if (normalized.length > 140) continue
        if (uniq.has(`${scope}::${normalized}`)) continue
        uniq.add(`${scope}::${normalized}`)
        items.push({ scope, content: normalized })
      }

      if (items.length === 0) {
        window.alert('模型没有返回可写入的长期记忆（空数组或无有效条目）。')
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: '',
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
        ? (consoleSettings.personaId || session.personaId || 'default')
        : (session.personaId || 'default')
      const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'

      for (const it of items) {
        const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
        await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
      }
      await api.setChatAutoExtractMeta(currentSessionId, {
        autoExtractCursor: effectiveCount,
        autoExtractLastRunAt: attemptAt,
        autoExtractLastWriteCount: items.length,
        autoExtractLastError: '',
      })
      refreshSessions().catch(() => undefined)
      setError(null)
      window.alert(`已写入 ${items.length} 条长期记忆。`)
    } catch (err) {
      const msg = `一键总结失败：${err instanceof Error ? err.message : String(err)}`
      console.error(err)
      setError(msg)
      window.alert(msg)
      try {
        await api.setChatAutoExtractMeta(currentSessionId, {
          ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
          autoExtractLastRunAt: attemptAt || Date.now(),
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
      } catch (_) {
        /* ignore */
      }
    } finally {
      autoExtractRunningRef.current[currentSessionId] = false
      setSessionContextMenu(null)
    }
  }, [api, currentSessionId, refreshSessions])

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      setContextMenu(null)
      await api.deleteChatMessage(currentSessionId, messageId)
      await refreshSessions()
    },
    [api, currentSessionId, refreshSessions],
  )

  const handleStartEdit = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      const editText =
        msg.role === 'assistant' && Array.isArray(msg.blocks) && msg.blocks.length > 0
          ? joinTextBlocks(normalizeMessageBlocks(msg)) || String(msg.content ?? '')
          : String(msg.content ?? '')
      setEditingMessageId(messageId)
      setEditingMessageContent(editText)
      setContextMenu(null)
    },
    [messages],
  )

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!api || !currentSessionId || !editingMessageId) return
    const nextContent = String(editingMessageContent ?? '')
    const target = messages.find((m) => m.id === editingMessageId)
    if (!target) return
    const isAssistant = target.role === 'assistant'
    const nextBlocks: ChatMessageBlock[] | undefined = isAssistant ? [{ type: 'text', text: nextContent }] : undefined

    setMessages((prev) =>
      prev.map((m) =>
        m.id === editingMessageId
          ? {
              ...m,
              content: nextContent,
              ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
              updatedAt: Date.now(),
            }
          : m,
      ),
    )
    await api.updateChatMessageRecord(currentSessionId, editingMessageId, {
      content: nextContent,
      ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
    })
    await refreshSessions()
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [api, currentSessionId, editingMessageId, editingMessageContent, messages, refreshSessions])

  const handleResend = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      if (isLoadingRef.current) interrupt()

      const msgIndex = messages.findIndex((m) => m.id === messageId)
      if (msgIndex === -1) return

      let userIndex = msgIndex
      if (messages[msgIndex].role === 'assistant') {
        for (let i = msgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            userIndex = i
            break
          }
        }
      }

      const userMsg = messages[userIndex]
      if (!userMsg || userMsg.role !== 'user') return

      // 重新生成：优先复用 send() 全链路（规划器 + 工具 + 流式/TTS），确保能触发工具
      try {
        setContextMenu(null)
        setError(null)

        const baseMessages = messages.slice(0, userIndex)
        setMessages(baseMessages)
        await api.setChatMessages(currentSessionId, baseMessages)

        const rawText = String(userMsg.content ?? '').trim()
        const hasText = rawText.replace(/\[[^\]]+\]/g, '').trim().length > 0
        const resendText = hasText ? rawText : ''
        const resendAttachmentsRaw =
          Array.isArray(userMsg.attachments) && userMsg.attachments.length > 0
            ? userMsg.attachments
            : [
                ...(userMsg.imagePath ? [{ kind: 'image' as const, path: userMsg.imagePath }] : []),
                ...(userMsg.videoPath ? [{ kind: 'video' as const, path: userMsg.videoPath }] : []),
              ]
        const resendAttachments = resendAttachmentsRaw
          .map((a) => {
            const kind = (a as { kind?: unknown }).kind === 'video' ? ('video' as const) : ('image' as const)
            const path = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
            const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
            return { kind, path, ...(filename ? { filename } : {}) }
          })
          .filter((a) => a.path.length > 0)
        await send({ text: resendText, attachments: resendAttachments, source: 'manual', baseMessages })
        return
      } catch (err) {
        console.error('[Resend] fallback legacy resend:', err)
      }

      const aiService = getAIService()
      if (!aiService) {
        setError('AI 服务未初始化，请先配置 AI 设置')
        return
      }

      setContextMenu(null)
      setError(null)
      setIsLoading(true)
      isLoadingRef.current = true
      sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })
      const abort = new AbortController()
      aiAbortRef.current = abort
      try {
        api.stopTtsAll()
      } catch (_) {
        /* ignore */
      }

      const truncated = messages.slice(0, userIndex + 1)
      setMessages(truncated)
      await api.setChatMessages(currentSessionId, truncated)

      try {
        let chatHistory: ChatMessage[] = truncated.map((m) => {
          if (m.role !== 'user') return { role: 'assistant', content: m.content }

          if (m.image && canUseVision) {
            const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
            const text = m.content === '[图片]' ? '' : m.content
            if (text.trim().length > 0) parts.push({ type: 'text', text })
            parts.push({ type: 'image_url', image_url: { url: m.image } })
            return { role: 'user', content: parts }
          }

          const plain = m.content.trim().length > 0 ? m.content : '[图片]'
          return { role: 'user', content: plain }
        })

        let systemAddon = ''
        try {
          const memEnabled = settings?.memory?.enabled ?? true
          if (!memEnabled) throw new Error('memory disabled')
          const queryText = userMsg.content.trim()
          if (queryText.length > 0) {
            const personaId = getActivePersonaId()
            const res = await api.retrieveMemory({
              personaId,
              query: queryText,
              limit: 12,
              maxChars: 3200,
              includeShared: settings?.memory?.includeSharedOnRetrieve ?? true,
            })
            systemAddon = res.addon?.trim() ?? ''
          }
        } catch (_) {
          systemAddon = ''
        }
        {
          const worldBookAddon = buildWorldBookAddon(settingsRef.current ?? settings, getActivePersonaId())
          systemAddon = [systemAddon.trim(), worldBookAddon.trim()].filter(Boolean).join('\n\n')
        }

        {
          const prepared = await maybeCompressChatHistoryToMaxContext(aiService, chatHistory, systemAddon, {
            signal: abort.signal,
            notify: true,
            reason: 'chat-regenerate',
          })
          chatHistory = prepared.history
        }

        const enableChatStreaming = settings?.ai?.enableChatStreaming ?? false
        const ttsSegmented = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)

        if (ttsSegmented) {
          const utteranceId = newMessageId()
          setTtsPendingUtteranceId(utteranceId)
          setTtsRevealedSegments((prev) => ({ ...prev, [utteranceId]: 0 }))

          try {
            const assistantCreatedAt = Date.now()
            let created = false
            let acc = ''
            let pending = ''
            let raf = 0
            let lastExpression: string | undefined
            let lastMotion: string | undefined
            let sentSegments = 0

            const ensureMessageCreated = (content: string) => {
              if (created) return
              created = true
              const assistantMessage: ChatMessageRecord = {
                id: utteranceId,
                role: 'assistant',
                content,
                createdAt: assistantCreatedAt,
              }
              setMessages((prev) => [...prev, assistantMessage])
              api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              setTtsSegmentedMessageFlags((prev) => ({ ...prev, [utteranceId]: true }))
              ttsUtteranceMetaRef.current[utteranceId] = {
                sessionId: currentSessionId,
                createdAt: assistantCreatedAt,
                messageId: utteranceId,
                displayedSegments: 0,
                fallbackContent: content,
              }
            }

            const enqueueStableSegments = (displayText: string, forceAll: boolean) => {
              const display = normalizeAssistantDisplayText(displayText)
              const segs = splitTextIntoTtsSegments(display, { lang: 'zh', textSplitMethod: 'cut5' })
              const stableCount = countStableTtsSegments(display, segs, forceAll)
              if (stableCount <= sentSegments) {
                if (created) {
                  setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: display } : m)))
                  ttsUtteranceMetaRef.current[utteranceId].fallbackContent = display
                }
                return
              }

              const nextSegs = segs.slice(sentSegments, stableCount)
              if (nextSegs.length === 0) return

              ensureMessageCreated(display)
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: display } : m)))
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = display

              api.enqueueTtsUtterance({
                utteranceId,
                mode: sentSegments === 0 ? 'replace' : 'append',
                segments: nextSegs,
                fullText: undefined,
              })
              sentSegments = stableCount
            }

            const flush = () => {
              if (!pending) return
              acc += pending
              pending = ''

              const display = normalizeAssistantDisplayText(acc)

              const tags = extractLastLive2DTags(acc)
              if (tags.expression && tags.expression !== lastExpression) {
                lastExpression = tags.expression
                api.triggerExpression(tags.expression)
              }
              if (tags.motion && tags.motion !== lastMotion) {
                lastMotion = tags.motion
                api.triggerMotion(tags.motion, 0)
              }

              enqueueStableSegments(display, false)
            }

            const scheduleFlush = () => {
              if (raf) return
              raf = window.requestAnimationFrame(() => {
                raf = 0
                flush()
              })
            }

            const response = enableChatStreaming
              ? await aiService.chatStream(chatHistory, {
                  signal: abort.signal,
                  systemAddon,
                  onDelta: (delta) => {
                    pending += delta
                    scheduleFlush()
                  },
                })
              : await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

            if (raf) {
              window.cancelAnimationFrame(raf)
              raf = 0
            }
            flush()

            if (response.error) {
              if (response.error === ABORTED_ERROR) {
                try {
                  api.stopTtsAll()
                } catch {
                  /* ignore */
                }
                setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
                setTtsRevealedSegments((prev) => {
                  const next = { ...prev }
                  delete next[utteranceId]
                  return next
                })
                // aborted：保留已生成的部分（若已创建 message），但不再走分句控制
                if (created) {
                  setTtsSegmentedMessageFlags((prev) => {
                    const next = { ...prev }
                    delete next[utteranceId]
                    return next
                  })
                }
                return
              }
              const errUi = formatAiErrorForUser(response.error)
              setError(errUi.message)
              if (errUi.shouldAlert) window.alert(errUi.message)
              try {
                api.stopTtsAll()
              } catch {
                /* ignore */
              }
              setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
              setTtsRevealedSegments((prev) => {
                const next = { ...prev }
                delete next[utteranceId]
                return next
              })
              const msg: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: `[错误] ${response.error}`,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, msg])
              await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
              return
            }

            const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
            // 更新真实的 API usage 统计
            if (response.usage) setLastApiUsage(response.usage)
            if (!created) {
              ensureMessageCreated(finalContent)
            } else {
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: finalContent } : m)))
              api.updateChatMessage(currentSessionId, utteranceId, finalContent).catch(() => undefined)
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = finalContent
            }

            enqueueStableSegments(finalContent, true)
            api.finalizeTtsUtterance(utteranceId)

            if (response.expression) api.triggerExpression(response.expression)
            if (response.motion) api.triggerMotion(response.motion, 0)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg)
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            const assistantMessage: ChatMessageRecord = {
              id: newMessageId(),
              role: 'assistant',
              content: `[错误] ${msg}`,
              createdAt: Date.now(),
            }
            setMessages((prev) => [...prev, assistantMessage])
            await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          }

          return
        }

        if (enableChatStreaming) {
          const assistantId = newMessageId()
          let created = false
          const createdAt = Date.now()
          let acc = ''
          let pending = ''
          let lastExpression: string | undefined
          let lastMotion: string | undefined

          const ensureMessageCreated = () => {
            if (created) return
            created = true
            const assistantMessage: ChatMessageRecord = {
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt,
            }
            setMessages((prev) => [...prev, assistantMessage])
            api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          }

          const flush = () => {
            if (!pending) return
            acc += pending
            pending = ''
            if (!created) ensureMessageCreated()
            const display = normalizeAssistantDisplayText(acc)
            if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)))

            const tags = extractLastLive2DTags(acc)
            if (tags.expression && tags.expression !== lastExpression) {
              lastExpression = tags.expression
              api.triggerExpression(tags.expression)
            }
            if (tags.motion && tags.motion !== lastMotion) {
              lastMotion = tags.motion
              api.triggerMotion(tags.motion, 0)
            }
          }

          const response = await aiService.chatStream(chatHistory, {
            signal: abort.signal,
            systemAddon,
            onDelta: (delta) => {
              pending += delta
              flush()
            },
          })
          flush()

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              sendBubblePreview({ clear: true }, { force: true })
              return
            }
            const partialForUi = normalizeAssistantDisplayText(response.content || acc, { trim: true })
            if (partialForUi) sendBubblePreview({ text: partialForUi, autoHideDelay: 0 })
            else sendBubblePreview({ clear: true }, { force: true })
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            const nextContent = buildInterruptedStreamContent(partialForUi, response.error)
            if (created) {
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
              await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
            } else {
              const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
              setMessages((prev) => [...prev, msg])
              await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
            }
            return
          }

          const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
          // 更新真实的 API usage 统计
          if (response.usage) setLastApiUsage(response.usage)
          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalContent } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, finalContent).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: finalContent, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }

          if (finalContent.trim()) sendBubblePreview({ text: finalContent, autoHideDelay: 0 })
          if (finalContent) api.sendBubbleMessage(finalContent)
          void runAutoExtractIfNeeded(currentSessionId)
          return
        }

        const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
        if (response.error) {
          if (response.error === ABORTED_ERROR) return
          sendBubblePreview({ clear: true }, { force: true })
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const assistantMessage: ChatMessageRecord = {
            id: newMessageId(),
            role: 'assistant',
            content: `[错误] ${response.error}`,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage)
          return
        }

        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: response.content,
          createdAt: Date.now(),
        }
        // 更新真实的 API usage 统计
        if (response.usage) setLastApiUsage(response.usage)
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)

        if (response.expression) api.triggerExpression(response.expression)
        if (response.motion) api.triggerMotion(response.motion, 0)
        if (response.content?.trim()) sendBubblePreview({ text: response.content, autoHideDelay: 0 })
        if (response.content) api.sendBubbleMessage(response.content)
        void runAutoExtractIfNeeded(currentSessionId)
      } catch (err) {
        sendBubblePreview({ clear: true }, { force: true })
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${errorMessage}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
      } finally {
        if (aiAbortRef.current === abort) aiAbortRef.current = null
        isLoadingRef.current = false
        setIsLoading(false)
        refreshSessions().catch(() => undefined)
      }
    },
    [
      api,
      canUseVision,
      currentSessionId,
      getActivePersonaId,
      interrupt,
      messages,
      send,
      newMessageId,
      refreshSessions,
      sendBubblePreview,
      settings,
      runAutoExtractIfNeeded,
      maybeCompressChatHistoryToMaxContext,
      formatAiErrorForUser,
    ],
  )

  const chatStyle = useMemo(() => {
    const ui = settings?.chatUi
    const bgImage = ui?.backgroundImage?.trim() ?? ''
    const imgOpacity = Math.max(0, Math.min(1, ui?.backgroundImageOpacity ?? 0.6))
    const overlay = bgImage ? 1 - imgOpacity : 0

    return {
      ['--ndp-chat-bg' as unknown as string]: ui?.background ?? 'rgba(20, 20, 24, 0.45)',
      ['--ndp-user-bubble-bg' as unknown as string]: ui?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)',
      ['--ndp-assistant-bubble-bg' as unknown as string]: ui?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)',
      ['--ndp-bubble-radius' as unknown as string]: `${ui?.bubbleRadius ?? 14}px`,
      backgroundImage: bgImage
        ? `linear-gradient(rgba(0,0,0,${overlay}), rgba(0,0,0,${overlay})), url(${bgImage})`
        : undefined,
      backgroundSize: bgImage ? 'cover' : undefined,
      backgroundPosition: bgImage ? 'center' : undefined,
      backgroundRepeat: bgImage ? 'no-repeat' : undefined,
    } as CSSProperties
  }, [settings?.chatUi])

  return (
    <div
      className="ndp-chat-root"
      style={chatStyle}
      onContextMenu={handleChatRootContextMenu}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.ndp-session-list')) return
        if ((e.target as HTMLElement).closest('.ndp-context-menu')) return
        closeOverlays()
      }}
    >
      <ContextUsageOrb
        enabled={chatOrbEnabled}
        usage={chatContextUsage}
        position={{ x: chatOrbX, y: chatOrbY }}
        onPositionChange={(next) => api?.setChatUiSettings({ contextOrbX: next.x, contextOrbY: next.y })}
      />
      <header className="ndp-chat-header">
        <button className="ndp-session-name" onClick={() => setShowSessionList((v) => !v)} title="对话管理">
          对话管理：{currentSession?.name ?? '新对话'}
          <span className={`ndp-session-arrow ${showSessionList ? 'open' : ''}`}>▾</span>
        </button>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={clearMessages} title="清空对话">
            清空
          </button>
          <button className="ndp-btn" onClick={() => api?.openSettings()}>
            设置
          </button>
          <button className="ndp-btn" onClick={() => api?.openMemory()}>
            记忆
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      <div className="ndp-chat-membar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ndp-chat-membar-left">
          <label className="ndp-chat-mem-toggle" title="采集：写入原文到长期记忆">
            <input type="checkbox" checked={captureEnabled} onChange={(e) => void toggleCaptureEnabled(e.target.checked)} />
            采集
          </label>
          <label className="ndp-chat-mem-toggle" title="召回：检索注入到对话上下文">
            <input type="checkbox" checked={retrieveEnabled} onChange={(e) => void toggleRetrieveEnabled(e.target.checked)} />
            召回
          </label>
          <label className="ndp-chat-mem-toggle" title="自动提炼：对话达到阈值后自动写入长期记忆">
            <input
              type="checkbox"
              checked={autoExtractEnabled}
              onChange={(e) => void toggleAutoExtractEnabled(e.target.checked)}
              disabled={!memEnabled}
            />
            自动提炼
          </label>
          <label className="ndp-chat-mem-toggle" title="工具：把“想做事”的话交给规划器生成任务（可在桌宠任务面板查看进度）">
            <input
              type="checkbox"
              checked={plannerEnabled}
              onChange={(e) => void toggleTaskPlannerEnabled(e.target.checked)}
            />
            工具
          </label>
          <select
            className="ndp-select ndp-chat-mem-select"
            value={plannerMode}
            onChange={(e) => void setTaskPlannerMode(e.target.value as 'auto' | 'always')}
            disabled={!plannerEnabled}
            title="auto=仅在像“想做事”的话时触发；always=每条消息都先过规划器"
          >
            <option value="auto">auto</option>
            <option value="always">always</option>
          </select>
          <label
            className="ndp-chat-mem-toggle"
            title="工具系统：让模型直接选择并调用工具执行（更通用，但会更频繁调用 LLM）"
          >
            <input
              type="checkbox"
              checked={toolCallingEnabled}
              onChange={(e) => void toggleToolCallingEnabled(e.target.checked)}
              disabled={!plannerEnabled}
            />
            工具Agent
          </label>
          <select
            className="ndp-select ndp-chat-mem-select"
            value={toolCallingMode}
            onChange={(e) => void setToolCallingMode(e.target.value as 'auto' | 'native' | 'text')}
            disabled={!plannerEnabled || !toolCallingEnabled}
            title="auto=优先原生工具调用，失败自动降级兼容模式；native=仅原生工具调用；text=兼容模式（通常更稳）"
          >
            <option value="auto">auto</option>
            <option value="native">native</option>
            <option value="text">text</option>
          </select>
        </div>
        <div className="ndp-chat-membar-right">
          <span title="有效消息=合并连续助手消息后的条数">有效 {effectiveCountUi}</span>
          <span>游标 {cursorUi}</span>
          <span title={`阈值=${everyUi}`}>还差 {memEnabled && autoExtractEnabled ? remainingUi : '-'}</span>
          <span>上次 {lastRunAtUi > 0 ? new Date(lastRunAtUi).toLocaleString() : '-'}</span>
          <span>写入 {lastWriteCountUi}</span>
          <span title={retrieveUi.title}>召回 {retrieveUi.text}</span>
          {lastErrorUi ? (
            <span className="ndp-chat-membar-error" title={lastErrorUi}>
              失败 {lastErrorPreviewUi}
            </span>
          ) : null}
        </div>
      </div>

      {showSessionList && (
        <div className="ndp-session-list" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ndp-session-list-header">
            <div className="ndp-session-current">{currentSession?.name ?? '对话'}</div>
            <button className="ndp-btn" onClick={handleNewSession}>
              新对话
            </button>
          </div>
          <div className="ndp-session-list-items">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`ndp-session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => handleSwitchSession(s.id)}
              >
                <div className="ndp-session-info">
                  {editingSessionId === s.id ? (
                    <input
                      className="ndp-session-rename-input"
                      value={editingSessionName}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingSessionName(e.target.value)}
                      onBlur={() => handleRenameSession(s.id, editingSessionName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSession(s.id, editingSessionName)
                        if (e.key === 'Escape') {
                          setEditingSessionId(null)
                          setEditingSessionName('')
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="ndp-session-item-name">{s.name}</span>
                      <span className="ndp-session-item-count">{s.messageCount} 条</span>
                    </>
                  )}
                </div>
                <div
                  className="ndp-session-actions"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="ndp-session-action"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingSessionId(s.id)
                      setEditingSessionName(s.name)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="ndp-session-action delete"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="ndp-chat-messages">
        {messages.length === 0 ? (
          <div className="ndp-chat-empty">
            <div className="ndp-muted">还没有消息</div>
            <div className="ndp-muted ndp-chat-hint">
              {settings?.ai?.apiKey ? (
                <>模型: {settings.ai.model}</>
              ) : (
                <>请先在设置中配置 API Key</>
              )}
            </div>
          </div>
        ) : null}
        {messages.map((m) => {
          const isUser = m.role === 'user'
          const avatar = isUser ? userAvatar : assistantAvatar
          const isSegmentedAssistant = !isUser && ttsSegmentedUi && !!ttsSegmentedMessageFlags[m.id]

          const renderToolUseNode = (taskId: string, runId?: string): React.ReactNode => {
            const t = tasksById.get(taskId) ?? null
            if (!t) return null
            const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
            const steps = Array.isArray(t.steps) ? t.steps : []

            const toMediaSrc = (mediaUrl: string, mediaPath: string): string => {
              const url = String(mediaUrl ?? '').trim()
              if (url) return url
              const p = String(mediaPath ?? '').trim()
              if (!p) return ''
              if (/^(https?:|file:|data:|blob:)/i.test(p)) return p
              if (/^[a-zA-Z]:[\\/]/.test(p)) return `file:///${p.replace(/\\/g, '/')}`
              if (p.startsWith('\\\\')) return `file:${p.replace(/\\/g, '/')}`
              if (p.startsWith('/')) return `file://${p}`
              return p
            }

            const parseMmvectorResults = (
              raw: string,
            ): null | {
              count?: number
              results: Array<{
                id?: number
                type?: string
                score?: number
                filename?: string
                imagePath?: string
                videoUrl?: string
                videoPath?: string
              }>
            } => {
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
                const obj = parsed
                if (!obj || typeof obj !== 'object') return null
                const ok = (obj as { ok?: unknown }).ok
                if (ok !== true) return null
                const results = (obj as { results?: unknown }).results
                if (!Array.isArray(results)) return null
                return {
                  count: typeof (obj as { count?: unknown }).count === 'number' ? (obj as { count: number }).count : undefined,
                  results: results as Array<{
                    id?: number
                    type?: string
                    score?: number
                    filename?: string
                    videoUrl?: string
                    videoPath?: string
                  }>,
                }
              } catch {
                return null
              }
            }

            const renderRun = (r: (typeof runs)[number], idx: number): React.ReactNode => {
              const progress = runs.length > 1 ? `${idx + 1}/${runs.length}` : ''
              const pillStatus = r.status === 'error' ? 'failed' : r.status
              const isPreviewableToolImagePath = (raw: string): boolean => {
                const s = String(raw ?? '').trim()
                if (!s) return false
                if (/^data:image\//i.test(s)) return true
                if (/^blob:/i.test(s)) return true
                if (/^file:\/\//i.test(s)) return true
                if (/^https?:\/\//i.test(s)) return /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(s)
                if (/^\/\//.test(s)) return false
                if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(s)) return false
                return true
              }
              const toolImagePaths = Array.isArray(r.imagePaths)
                ? Array.from(
                    new Set(
                      r.imagePaths
                        .map((x) => String(x ?? '').trim())
                        .filter((x) => x && isPreviewableToolImagePath(x)),
                    ),
                  ).slice(0, 1)
                : []
              const mm = r.outputPreview ? parseMmvectorResults(r.outputPreview) : null
              const mmMedia =
                mm?.results?.filter((x) => {
                  const t = String(x?.type ?? '')
                  if (t === 'video') return String(x?.videoUrl ?? '').trim() || String(x?.videoPath ?? '').trim()
                  if (t === 'image') return String(x?.imagePath ?? '').trim()
                  return false
                }) ?? []
              return (
                <>
                  {toolImagePaths.length > 0 ? (
                    <div className="ndp-mmvector-results">
                      <div className="ndp-mmvector-title">工具输出图片（可预览）</div>
                      <div className="ndp-mmvector-grid">
                        {toolImagePaths.map((imgPath, imgIdx) => (
                          <div key={`tool-img-${String(r.id ?? `${idx}`)}-${imgIdx}`} className="ndp-mmvector-item">
                            <div
                              className="ndp-mmvector-image-hit"
                              onClick={() => {
                                void (async () => {
                                  const raw = String(imgPath ?? '').trim()
                                  if (!raw) return
                                  if (/^(https?:|data:|blob:)/i.test(raw)) {
                                    window.open(raw, '_blank')
                                    return
                                  }
                                  if (api) {
                                    try {
                                      const res = await api.getChatAttachmentUrl(raw)
                                      if (res?.ok && typeof res.url === 'string') {
                                        window.open(res.url, '_blank')
                                        return
                                      }
                                    } catch {
                                      /* ignore */
                                    }
                                  }
                                  window.open(toLocalMediaSrc(raw), '_blank')
                                })()
                              }}
                              title={imgPath}
                            >
                              <MmvectorImagePreview api={api} imagePath={imgPath} alt={`tool-image-${imgIdx + 1}`} />
                            </div>
                            <div className="ndp-mmvector-meta" title={imgPath}>
                              image {imgIdx + 1}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <details key={r.id} className="ndp-tooluse">
                    <summary className="ndp-tooluse-summary">
                      <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                        DeskPet · ToolUse: {r.toolName}
                        {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
                      </span>
                    </summary>
                    <div className="ndp-tooluse-body">
                      <div className="ndp-tooluse-run">
                        <div className="ndp-tooluse-run-title">
                          <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${r.status}`}>{r.status}</span>
                          <span className="ndp-tooluse-run-name">{r.toolName}</span>
                        </div>
                        {r.inputPreview ? <div className="ndp-tooluse-run-io">in: {r.inputPreview}</div> : null}
                        {r.outputPreview ? <div className="ndp-tooluse-run-io">out: {r.outputPreview}</div> : null}
                        {mmMedia.length > 0 ? (
                          <div className="ndp-mmvector-results">
                            <div className="ndp-mmvector-title">多模态结果（可预览/播放）</div>
                            <div className="ndp-mmvector-grid">
                              {mmMedia.map((it) => {
                                const isVideo = String(it.type ?? '') === 'video'
                                const src = isVideo
                                  ? toMediaSrc(String(it.videoUrl ?? ''), String(it.videoPath ?? ''))
                                  : toMediaSrc('', String(it.imagePath ?? ''))
                                if (!src) return null
                                const labelParts: string[] = []
                                if (it.filename) labelParts.push(String(it.filename))
                                if (typeof it.score === 'number' && Number.isFinite(it.score)) labelParts.push(it.score.toFixed(4))
                                const label = labelParts.join(' · ')
                                return (
                                  <div key={`mmv-${String(it.id ?? '')}-${src}`} className="ndp-mmvector-item">
                                    {isVideo ? (
                                      <LocalVideo api={api} videoPath={src} className="ndp-mmvector-video" controls preload="metadata" playsInline />
                                    ) : (
                                      <MmvectorImage imagePath={String(it.imagePath ?? '')} alt={String(it.filename ?? 'image')} />
                                    )}
                                    <div className="ndp-mmvector-meta" title={src}>
                                      {label || src}
                                    </div>
                                    <div className="ndp-mmvector-actions">
                                      <button
                                        className="ndp-btn ndp-btn-mini"
                                        onClick={() => {
                                          const target = isVideo
                                            ? (String(it.videoUrl ?? '').trim() || String(it.videoPath ?? '').trim() || src)
                                            : (String(it.imagePath ?? '').trim() || src)
                                          void (async () => {
                                            const raw = String(target ?? '').trim()
                                            if (!raw) return
                                            if (/^(https?:|data:|blob:)/i.test(raw)) {
                                              window.open(raw, '_blank')
                                              return
                                            }
                                            if (api) {
                                              try {
                                                const res = await api.getChatAttachmentUrl(raw)
                                                if (res?.ok && typeof res.url === 'string') {
                                                  window.open(res.url, '_blank')
                                                  return
                                                }
                                              } catch {
                                                /* ignore */
                                              }
                                            }
                                            window.open(toLocalMediaSrc(raw), '_blank')
                                          })()
                                        }}
                                      >
                                        打开
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                        {r.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {r.error}</div> : null}
                      </div>
                    </div>
                  </details>
                </>
              )
            }

            const renderStep = (s: TaskStepRecord, idx: number): React.ReactNode => {
              const toolName = String(s.tool ?? '').trim()
              const name = toolName || s.title
              const input = String(s.input ?? '').trim()
              const output = String(s.output ?? '').trim()
              const error = String(s.error ?? '').trim()
              const statusText = String(s.status ?? '').trim() || 'pending'
              const statusKey = statusText === 'failed' ? 'error' : statusText === 'skipped' ? 'disconnected' : statusText
              const progress = steps.length > 1 ? `${idx + 1}/${steps.length}` : ''
              const pillStatus =
                statusText === 'failed'
                  ? 'failed'
                  : statusText === 'done'
                    ? 'done'
                    : statusText === 'running'
                      ? 'running'
                      : statusText === 'paused'
                        ? 'paused'
                        : 'pending'

              return (
                <details key={s.id || `${t.id}-step-${idx}`} className="ndp-tooluse">
                  <summary className="ndp-tooluse-summary">
                    <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                      DeskPet · ToolUse: {name}
                      {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
                    </span>
                  </summary>
                  <div className="ndp-tooluse-body">
                    <div className="ndp-tooluse-run">
                      <div className="ndp-tooluse-run-title">
                        <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${statusKey}`}>{statusText}</span>
                        <span className="ndp-tooluse-run-name">{name}</span>
                      </div>
                      {input ? <div className="ndp-tooluse-run-io">in: {input}</div> : null}
                      {output ? <div className="ndp-tooluse-run-io">out: {output}</div> : null}
                      {error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {error}</div> : null}
                    </div>
                  </div>
                </details>
              )
            }

            if (runId && runs.length > 0) {
              const idx = runs.findIndex((r) => String(r.id ?? '') === runId)
              if (idx >= 0) return renderRun(runs[idx], idx)
            }

            if (runs.length > 0) return <>{runs.map((r, idx) => renderRun(r, idx))}</>
            if (steps.length > 0) return <>{steps.map((s, idx) => renderStep(s, idx))}</>
            return null
          }

          const blocks = !isUser ? normalizeMessageBlocks(m) : []
          const hasToolBlock = !isUser && blocks.some((b) => b.type === 'tool_use')

          const openAttachment = async (pathOrUrl: string) => {
            const raw = String(pathOrUrl ?? '').trim()
            if (!raw) return
            if (/^(https?:|data:|blob:)/i.test(raw)) {
              window.open(raw, '_blank')
              return
            }
            if (!api) {
              window.open(toLocalMediaSrc(raw), '_blank')
              return
            }
            try {
              const res = await api.getChatAttachmentUrl(raw)
              if (res?.ok && typeof res.url === 'string') {
                window.open(res.url, '_blank')
                return
              }
            } catch {
              /* ignore */
            }
            window.open(toLocalMediaSrc(raw), '_blank')
          }

          const attachmentsNode = (() => {
            const normalized: Array<{ kind: 'image' | 'video'; path?: string; dataUrl?: string; filename?: string }> = []

            if (Array.isArray(m.attachments)) {
              for (const a of m.attachments) {
                if (!a || typeof a !== 'object') continue
                const kind = (a as { kind?: unknown }).kind === 'video' ? 'video' : (a as { kind?: unknown }).kind === 'image' ? 'image' : ''
                const p = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
                const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
                if (!kind || !p) continue
                normalized.push({ kind, path: p, ...(filename ? { filename } : {}) })
              }
            }

            if (normalized.length === 0) {
              if (m.imagePath) normalized.push({ kind: 'image', path: String(m.imagePath) })
              if (m.videoPath) normalized.push({ kind: 'video', path: String(m.videoPath) })
              if (m.image && !m.imagePath) normalized.push({ kind: 'image', dataUrl: String(m.image) })
            }

            if (normalized.length === 0) return null

            return (
              <div className="ndp-msg-attachments">
                {normalized.map((a, idx) => {
                  const key = `${m.id}-att-${idx}-${String(a.kind)}-${String(a.path ?? a.dataUrl ?? '')}`
                  if (a.kind === 'video') {
                    const p = String(a.path ?? '').trim()
                    if (!p) return null
                    return (
                      <div key={key} className="ndp-msg-attachment">
                        <LocalVideo api={api} className="ndp-msg-video" videoPath={p} controls preload="metadata" playsInline />
                        <button className="ndp-attachment-open" onClick={() => void openAttachment(p)} title="打开">
                          打开
                        </button>
                      </div>
                    )
                  }

                  const dataUrl = String(a.dataUrl ?? '').trim()
                  const p = String(a.path ?? '').trim()
                  const src = dataUrl || p
                  if (!src) return null
                  return (
                    <div key={key} className="ndp-msg-attachment">
                      {dataUrl ? (
                        <img className="ndp-msg-image" src={dataUrl} alt="attachment" />
                      ) : (
                        <MmvectorImagePreview api={api} imagePath={p} alt="attachment" />
                      )}
                      <button className="ndp-attachment-open" onClick={() => void openAttachment(src)} title="打开">
                        打开
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })()

          if (isSegmentedAssistant && !hasToolBlock && editingMessageId !== m.id) {
            const segments = splitTextIntoTtsSegments(m.content, { lang: 'zh', textSplitMethod: 'cut5' })
            const revealCount =
              typeof ttsRevealedSegments[m.id] === 'number' ? ttsRevealedSegments[m.id] : segments.length
            const visible = segments.slice(0, Math.max(0, Math.min(segments.length, revealCount)))
            if (visible.length === 0) return null

            return (
              <div
                key={m.id}
                className="ndp-msg-row ndp-msg-row-pet"
                onContextMenu={(e) => handleMessageContextMenu(e, m.id)}
                title={new Date(m.createdAt).toLocaleString()}
              >
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('assistant')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {visible.map((seg, i) => {
                    const displaySeg = trimTrailingCommaForSegment(seg)
                    const isLast = i === visible.length - 1
                    return (
                        <div key={`${m.id}-${i}`} className="ndp-msg ndp-msg-pet">
                          <div className="ndp-msg-content">
                            {displaySeg}
                            {isLast ? (
                              <>
                                {attachmentsNode}
                              </>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          }

          return (
            <div
              key={m.id}
              className={`ndp-msg-row ${isUser ? 'ndp-msg-row-user' : 'ndp-msg-row-pet'}`}
              onContextMenu={(e) => handleMessageContextMenu(e, m.id)}
              title={new Date(m.createdAt).toLocaleString()}
            >
              {!isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('assistant')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
                </div>
              ) : null}

              <div className={`ndp-msg ndp-msg-${isUser ? 'user' : 'pet'}`}>
                {editingMessageId === m.id ? (
                  <div className="ndp-msg-edit">
                    <textarea
                      ref={editingTextareaRef}
                      className="ndp-inline-textarea"
                      value={editingMessageContent}
                      rows={1}
                      onChange={(e) => setEditingMessageContent(e.target.value)}
                      onInput={(e) => {
                        const el = e.currentTarget
                        el.style.height = '0px'
                        el.style.height = `${el.scrollHeight}px`
                      }}
                    />
                    <div className="ndp-msg-edit-actions">
                      <button className="ndp-btn" onClick={handleSaveEdit}>
                        保存
                      </button>
                      <button className="ndp-btn" onClick={handleCancelEdit}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ndp-msg-content">
                    {isUser
                      ? m.content
                      : blocks.length === 0
                        ? (() => {
                            const text = normalizeInterleavedTextSegment(String(m.content ?? ''))
                            return text ? <MarkdownMessage text={text} /> : null
                          })()
                        : (() => {
                          let toolSeen = 0
                          let statusSeen = 0
                          let textSeen = 0
                          return blocks.map((b) => {
                          if (b.type === 'text') {
                            const text = normalizeInterleavedTextSegment(String(b.text ?? ''))
                            if (!text) return null
                            const key = `${m.id}-text-${toolSeen}-${textSeen++}`
                            return <MarkdownMessage key={key} text={text} />
                          }
                          if (b.type === 'status') {
                            const text = String(b.text ?? '').trim()
                            if (!text) return null
                            return (
                              <div key={`${m.id}-status-${statusSeen++}`} className="ndp-muted">
                                {text}
                              </div>
                            )
                          }
                          if (b.type === 'tool_use') {
                            const rid = (b as { runId?: string }).runId
                            const key = rid?.trim() ? `${m.id}-tool-${rid}` : `${m.id}-tool-${b.taskId}-${toolSeen}`
                            toolSeen += 1
                            return <div key={key}>{renderToolUseNode(b.taskId, rid)}</div>
                          }
                          return null
                        })
                        })()}
                    {attachmentsNode}
                  </div>
                )}
              </div>

              {isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('user')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="user" /> : <span>我</span>}
                </div>
              ) : null}
            </div>
          )
        })}
        {(settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false) && ttsPendingUtteranceId ? (
          <div className="ndp-msg-row ndp-msg-row-pet" title="生成中…">
            <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('assistant')} title="点击更换头像">
              {settings?.chatProfile?.assistantAvatar ? (
                <img src={settings.chatProfile.assistantAvatar} alt="assistant" />
              ) : (
                <span>宠</span>
              )}
            </div>
            <div className="ndp-msg ndp-msg-pet">
              <div className="ndp-msg-content ndp-muted">思考中…</div>
            </div>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </main>

      {error && (
        <div className="ndp-chat-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <footer className="ndp-chat-input">
        {pendingAttachments.length > 0 ? (
          <div className="ndp-input-previews" onMouseDown={(e) => e.stopPropagation()}>
            {pendingAttachments.map((a) => (
              <div key={a.id} className="ndp-input-preview">
                {a.kind === 'video' ? (
                  <LocalVideo api={api} videoPath={a.path} controls={false} muted playsInline preload="metadata" />
                ) : a.previewDataUrl ? (
                  <img src={a.previewDataUrl} alt="preview" />
                ) : (
                  <MmvectorImagePreview api={api} imagePath={a.path} alt="preview" />
                )}
                <div className="ndp-input-preview-meta" title={a.path}>
                  {a.filename || a.kind}
                </div>
                <button className="ndp-preview-remove" onClick={() => removePendingAttachment(a.id)} title="移除">
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="ndp-chat-input-row">
          <input
            value={input}
            onChange={(e) => {
              const next = e.target.value
              inputRef.current = next
              setInput(next)
              if ((settingsRef.current?.asr?.enabled ?? false) && !(settingsRef.current?.asr?.autoSend ?? false)) {
                syncAsrComposePreview(next)
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const dt = e.clipboardData
              if (!dt) return

              const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
              if (files.length > 0) {
                e.preventDefault()
                for (const f of files) {
                  if (f.type.startsWith('image/')) void readChatImageFile(f)
                  else void readChatVideoFile(f)
                }
                return
              }

              const items = dt.items
              if (!items) return
              const mediaItems = Array.from(items).filter((it) => it.type.startsWith('image/') || it.type.startsWith('video/'))
              if (mediaItems.length === 0) return
              e.preventDefault()
              for (const item of mediaItems) {
                const file = item.getAsFile()
                if (!file) continue
                if (file.type.startsWith('image/')) void readChatImageFile(file)
                else void readChatVideoFile(file)
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
              if (files.length === 0) {
                setError('只支持拖拽图片或视频文件')
                return
              }
              for (const file of files) {
                if (file.type.startsWith('image/')) void readChatImageFile(file)
                else void readChatVideoFile(file)
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            placeholder="输入一句话..."
          />
          <button className="ndp-btn" onClick={() => imageInputRef.current?.click()} title={canUseVision ? '选择图片' : '选择图片（不会发给模型，只用于存档/检索）'}>
            图片
          </button>
          <button className="ndp-btn" onClick={() => videoInputRef.current?.click()} title="选择视频（本地存档/检索用）">
            视频
          </button>
          <button className="ndp-btn" onClick={() => attachmentInputRef.current?.click()} title="选择附件（可多选图片/视频）">
            附件
          </button>
          <button
            className={`ndp-btn ${isAssistantOutputting ? 'ndp-btn-stop' : ''}`}
            onClick={() => {
              if (isAssistantOutputting) stopAssistantOutput()
              else send()
            }}
            disabled={!isAssistantOutputting && !input.trim() && pendingAttachments.length === 0}
            title={isAssistantOutputting ? '停止当前输出' : '发送'}
          >
            {isAssistantOutputting ? '停止' : '发送'}
          </button>
        </div>
      </footer>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            void readChatImageFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            void readChatVideoFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={attachmentInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            if (file.type.startsWith('image/')) void readChatImageFile(file)
            else if (file.type.startsWith('video/')) void readChatVideoFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={userAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ userAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />
      <input
        ref={assistantAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ assistantAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />

      {sessionContextMenu ? (
        <div className="ndp-context-menu" style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}>
          <button onClick={() => void runQuickExtract()}>一键总结（写入长期记忆）</button>
        </div>
      ) : null}

      {contextMenu ? (
        <div className="ndp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => handleResend(contextMenu.messageId)}>🔄 重新生成</button>
          <button onClick={() => handleStartEdit(contextMenu.messageId)}>✏️ 编辑</button>
          <button className="delete" onClick={() => handleDeleteMessage(contextMenu.messageId)}>
            🗑️ 删除
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SettingsWindow(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const [activeTab, setActiveTab] = useState<
    'live2d' | 'bubble' | 'taskPanel' | 'ai' | 'tools' | 'persona' | 'worldBook' | 'chat' | 'tts' | 'asr'
  >('live2d')
  const [availableModels, setAvailableModels] = useState<Live2DModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(true)
  const lastModelScanAtRef = useRef(0)

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dModelId = settings?.live2dModelId ?? 'haru'
  const live2dMouseTrackingEnabled = settings?.live2dMouseTrackingEnabled !== false
  const live2dIdleSwayEnabled = settings?.live2dIdleSwayEnabled !== false
  const aiSettings = settings?.ai
  const bubbleSettings = settings?.bubble
  const chatUi = settings?.chatUi
  const ttsSettings = settings?.tts
  const asrSettings = settings?.asr

  const refreshModels = useCallback(
    async (opts?: { force?: boolean }) => {
      const now = Date.now()
      if (!opts?.force && now - lastModelScanAtRef.current < 800) return
      lastModelScanAtRef.current = now

      setIsLoadingModels(true)
      try {
        const models = await scanAvailableModels()
        setAvailableModels(models)
      } catch (err) {
        console.error('[Settings] Failed to scan models:', err)
        // Fallback to cached models
        setAvailableModels(getAvailableModels())
      } finally {
        setIsLoadingModels(false)
      }
    },
    [setAvailableModels, setIsLoadingModels],
  )

  // Scan models on mount
  useEffect(() => {
    void refreshModels({ force: true })
  }, [refreshModels])
  const [selectedModelInfo, setSelectedModelInfo] = useState<Live2DModelInfo | null>(null)

  // Load model metadata when model changes or models are loaded
  useEffect(() => {
    const model = availableModels.find((m) => m.id === live2dModelId)
    if (!model) {
      setSelectedModelInfo(null)
      return
    }

    // Start with basic info
    setSelectedModelInfo(model)

    // Then load full metadata
    parseModelMetadata(model.modelFile).then((metadata) => {
      setSelectedModelInfo({
        ...model,
        ...metadata,
      })
    })
  }, [live2dModelId, availableModels])

  return (
    <div className="ndp-settings-root">
      {/* Header */}
      <header className="ndp-settings-header">
        <div className="ndp-settings-title">
          <span className="ndp-settings-icon">⚙️</span>
          <span>设置</span>
        </div>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={() => api?.openMemory()}>
            记忆控制台
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="ndp-settings-tabs">
        <button
          className={`ndp-tab-btn ${activeTab === 'live2d' ? 'active' : ''}`}
          onClick={() => setActiveTab('live2d')}
        >
          Live2D 模型
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'bubble' ? 'active' : ''}`}
          onClick={() => setActiveTab('bubble')}
        >
          气泡设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'taskPanel' ? 'active' : ''}`}
          onClick={() => setActiveTab('taskPanel')}
        >
          任务面板
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI 设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'tools' ? 'active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          工具中心
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'persona' ? 'active' : ''}`}
          onClick={() => setActiveTab('persona')}
        >
          角色/记忆
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'worldBook' ? 'active' : ''}`}
          onClick={() => setActiveTab('worldBook')}
        >
          设定库
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          聊天界面
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveTab('tts')}
        >
          TTS
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'asr' ? 'active' : ''}`}
          onClick={() => setActiveTab('asr')}
        >
          语音识别
        </button>
      </div>

      {/* Content */}
      <main className="ndp-settings-content">
        {activeTab === 'live2d' && (
          <Live2DSettingsTab
            api={api}
            petScale={petScale}
            petOpacity={petOpacity}
            live2dModelId={live2dModelId}
            live2dMouseTrackingEnabled={live2dMouseTrackingEnabled}
            live2dIdleSwayEnabled={live2dIdleSwayEnabled}
            availableModels={availableModels}
            selectedModelInfo={selectedModelInfo}
            isLoadingModels={isLoadingModels}
            refreshModels={refreshModels}
          />
        )}
        {activeTab === 'bubble' && <BubbleSettingsTab api={api} bubbleSettings={bubbleSettings} />}
        {activeTab === 'taskPanel' && <TaskPanelSettingsTab api={api} taskPanelSettings={settings?.taskPanel} />}
        {activeTab === 'ai' && (
          <AISettingsTab
            api={api}
            aiSettings={aiSettings}
            orchestrator={settings?.orchestrator}
            aiProfiles={settings?.aiProfiles}
            activeAiProfileId={settings?.activeAiProfileId}
          />
        )}
        {activeTab === 'tools' && <ToolsSettingsTab api={api} settings={settings} />}
        {activeTab === 'persona' && <PersonaSettingsTab api={api} settings={settings} />}
        {activeTab === 'worldBook' && <WorldBookSettingsTab api={api} settings={settings} />}
        {activeTab === 'chat' && <ChatUiSettingsTab api={api} chatUi={chatUi} />}
        {activeTab === 'tts' && <TtsSettingsTab api={api} ttsSettings={ttsSettings} />}
        {activeTab === 'asr' && <AsrSettingsTab api={api} asrSettings={asrSettings} />}
      </main>

      {/* Footer */}
      <footer className="ndp-settings-footer">
        <button className="ndp-reset-btn" disabled>
          重置默认
        </button>
      </footer>
    </div>
  )
}
