import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  AIThinkingEffort,
  AppSettings,
  BubbleStyle,
  ChatMessageBlock,
  ChatMessageRecord,
  ChatSessionSummary,
  ContextUsageSnapshot,
  McpStateSnapshot,
  McpServerConfig,
  MemoryRetrieveResult,
  Persona,
  PersonaSummary,
  TaskCreateArgs,
  TaskRecord,
  TaskStepRecord,
  TailDirection,
} from '../electron/types'
import { getBuiltinToolDefinitions, getToolGroupId, isToolEnabled } from '../electron/toolRegistry'
import { getApi } from './neoDeskPetApi'
import { getWindowType } from './windowType'
import { MemoryConsoleWindow } from './windows/MemoryConsoleWindow'
import { Live2DView } from './live2d/Live2DView'
import { SpeechBubble } from './components/SpeechBubble'
import { ContextUsageOrb } from './components/ContextUsageOrb'
import {
  getAvailableModels,
  parseModelMetadata,
  scanAvailableModels,
  type Live2DModelInfo,
} from './live2d/live2dModels'
import { ABORTED_ERROR, AIService, getAIService, setModelInfoToAIService, type ChatMessage, type ChatUsage } from './services/aiService'
import { TtsPlayer } from './services/ttsService'
import { splitTextIntoTtsSegments } from './services/textSegmentation'

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

function clampIntValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function normalizeAssistantDisplayText(text: string, opts?: { trim?: boolean }): string {
  const cleaned = String(text ?? '')
    .replace(/\[表情[：:]\s*[^\]]+\]/g, '')
    .replace(/\[动作[：:]\s*[^\]]+\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
  return opts?.trim ? cleaned.trim() : cleaned
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
  return String(text ?? '')
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

function trimTrailingCommaForSegment(text: string): string {
  const raw = String(text ?? '')
  const trimmed = raw.replace(/[，,]\s*$/u, '').trimEnd()
  return trimmed || raw
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
  lines.push('- delay.sleep：{"ms":200}')
  lines.push('')
  lines.push('策略：')
  lines.push('- 能直接执行就 create_task；缺信息就 need_info；都不是就 chat。')
  lines.push('- 如果用户是在询问“你能做什么/有哪些工具/工具列表/能力说明”，一律输出 chat：列出可用工具与典型用法示例，不要创建任务、更不要实际执行。')
  lines.push('- 抓取/总结网页：优先 browser.fetch（更快）；遇到动态/需要登录/需要点击交互，才用 browser.playwright。')
  lines.push('- 仅“打开某网站”：优先 browser.open；需要截图/交互/登录才用 browser.playwright（默认不做 extract）。')
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
  const [bubblePayload, setBubblePayload] = useState<
    | { text: string; startAt: number | null; mode: 'typing' | 'append'; autoHideDelay?: number }
    | null
  >(null)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null)
  const toolAnimRef = useRef<{ motionGroups: string[]; expressions: string[] }>({ motionGroups: [], expressions: [] })

  // 默认不提供任何“固定人设台词”，避免与 AI 设置里的人设割裂
  const defaultPhrases: string[] = []

  const [asrSubtitle, setAsrSubtitle] = useState<string>('')
  const [asrRecording, setAsrRecording] = useState(false)
  const asrSubtitleHideTimerRef = useRef<number | null>(null)

  const asrClientRef = useRef<{
    ws: WebSocket
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

  const clearAsrSubtitleTimer = useCallback(() => {
    if (asrSubtitleHideTimerRef.current) {
      window.clearTimeout(asrSubtitleHideTimerRef.current)
      asrSubtitleHideTimerRef.current = null
    }
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

  const stopAsr = useCallback(() => {
    const client = asrClientRef.current
    if (!client) return
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
      client.ws.close()
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

      const msg = payload as { type?: string; text?: string; message?: string }
      const msgType = String(msg.type ?? '').trim()
      const text = String(msg.text ?? '').trim()

      if (msgType === 'partial') {
        asrPartialRef.current = text
        if (text) showAsrSubtitle(text)
        return
      }

      if (msgType === 'result') {
        asrPartialRef.current = ''
        if (!text) return

        const asr = settingsRef.current?.asr
        const mode = asr?.mode ?? 'continuous'
        if (mode === 'hotkey') {
          asrFinalSegmentsRef.current.push(text)
          showAsrSubtitle(asrFinalSegmentsRef.current.join(' '))
          return
        }

        // continuous: one result == one utterance
        showAsrSubtitle(text, { autoHideMs: 6000 })
        try {
          api?.reportAsrTranscript(text)
        } catch (_) {
          /* ignore */
        }
        return
      }

      if (msgType === 'debug') {
        const hint = String(msg.message ?? '').trim()
        if (hint && (settingsRef.current?.asr?.debug ?? false)) {
          console.debug('[ASR]', hint)
        }
      }
    },
    [api, showAsrSubtitle],
  )

  const startAsr = useCallback(async () => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (asrClientRef.current) return
    if (asrStartingRef.current) return
    asrStartingRef.current = true

    try {
      if (!asr.wsUrl.trim()) {
        showAsrSubtitle('ASR WebSocket 地址为空', { autoHideMs: 4000 })
        return
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

      // 使用系统默认采样率：音质更稳定；服务端会按 VAD 分块自行重采样
      const audioContext = new AudioContext()
      const sampleRate = audioContext.sampleRate || 48000

      const source = audioContext.createMediaStreamSource(mediaStream)

      // 避免把麦克风音频直通到扬声器造成回声/啸叫
      const sink = audioContext.createGain()
      sink.gain.value = 0
      sink.connect(audioContext.destination)

      const ws = new WebSocket(asr.wsUrl)
      ws.binaryType = 'arraybuffer'

      const bufferSize = 4096

      const sendPcm = (pcm: Float32Array) => {
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

      asrClientRef.current = { ws, mediaStream, audioContext, node, sink, stopFeeder, sampleRate }
      setAsrRecording(true)
      showAsrSubtitle('录音中…')
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

  // Listen for bubble messages from chat window
  useEffect(() => {
    if (!api) return
    return api.onBubbleMessage((message) => {
      const s = settingsRef.current
      if (!s) return

      const showBubble = s.bubble?.showOnChat ?? false
      const tts = s.tts ? { ...s.tts, segmented: false } : s.tts
      const useQueue = Boolean(tts?.enabled) && !(s.tts?.segmented ?? false)

      const startTypingNow = (text: string) => {
        if (!showBubble) return
        setBubblePayload({ text, startAt: Date.now(), mode: 'typing' })
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

                if (showBubble) setBubblePayload({ text, startAt: null, mode: 'typing' })
                if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
                const player = ttsPlayerRef.current
                if (!player) continue

                await new Promise<void>((resolve) => {
                  void player
                    .speak(text, tts, {
                      onFirstPlay: () => {
                        if (showBubble) setBubblePayload({ text, startAt: Date.now(), mode: 'typing' })
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
              bubbleTtsRunningRef.current = false
            }
          })()
          return
        }

        if (showBubble) setBubblePayload({ text: message, startAt: null, mode: 'typing' })
        if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

        void ttsPlayerRef.current
          .speak(message, tts, {
            onFirstPlay: () => {
              if (showBubble) setBubblePayload({ text: message, startAt: Date.now(), mode: 'typing' })
            },
            onEnded: () => setMouthOpen(0),
          })
          .catch(() => {
            // TTS 失败时也要能正常显示气泡
            startTypingNow(message)
          })
        return
      }

      startTypingNow(message)
    })
  }, [api])

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

          await new Promise<void>((resolve) => {
            void player
              .speak(segText, ttsSettings, {
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

  // Get model URL directly from settings
  const modelJsonUrl = settings?.live2dModelFile ?? '/live2d/Haru/Haru.model3.json'

  // 解析当前 Live2D 模型的可用表情/动作名，用于工具调用时做更通用的触发（尽量不硬编码具体名字）
  useEffect(() => {
    let cancelled = false
    parseModelMetadata(modelJsonUrl)
      .then((metadata) => {
        if (cancelled) return
        const expressions = metadata.expressions?.map((e) => e.name).filter(Boolean) ?? []
        const motions = metadata.motionGroups?.map((g) => g.name).filter(Boolean) ?? []
        toolAnimRef.current = { motionGroups: motions, expressions }
      })
      .catch(() => {
        if (cancelled) return
        toolAnimRef.current = { motionGroups: [], expressions: [] }
      })
    return () => {
      cancelled = true
    }
  }, [modelJsonUrl])

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
      {bubblePayload && (
        <SpeechBubble
          key={`${bubblePayload.startAt ?? 'pending'}-${bubblePayload.mode}`}
          text={bubblePayload.text}
          startAt={bubblePayload.startAt}
          mode={bubblePayload.mode}
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
          className="ndp-task-panel"
          style={{ left: `${taskPanelX}%`, top: `${taskPanelY}%`, transform: 'translate(-50%, 0)' }}
          onMouseEnter={() => api?.setPetOverlayHover(true)}
          onMouseLeave={() => api?.setPetOverlayHover(false)}
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
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.pauseTask(task.id).catch((err) => console.error(err))}
                    >
                      暂停
                    </button>
                  )}
                  {task.status === 'paused' && (
                    <button
                      className="ndp-task-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.resumeTask(task.id).catch((err) => console.error(err))}
                    >
                      继续
                    </button>
                  )}
                  <button
                    className="ndp-task-btn ndp-task-btn-danger"
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
  const plannerPendingRef = useRef(false)
  const pendingAsrAutoSendRef = useRef<string[]>([])
  const asrAutoSendFlushingRef = useRef(false)
  const tasksRef = useRef<TaskRecord[]>([])
  const taskOriginSessionRef = useRef<Map<string, string>>(new Map())
  const taskOriginMessageRef = useRef<Map<string, string>>(new Map())
  const taskOriginBlocksRef = useRef<Map<string, ChatMessageBlock[]>>(new Map())
  const taskToolUseSplitRef = useRef<Map<string, { runIds: string[]; segments: string[]; lastDisplay: string }>>(new Map())
  const taskUiDebugSigRef = useRef<Map<string, string>>(new Map())
  const taskBubbleTtsProgressRef = useRef<Map<string, { spokenFrozen: number; spokeFinal: boolean }>>(new Map())
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
  const [contextRetrieveAddon, setContextRetrieveAddon] = useState<string>('')
  const contextRetrieveAddonReqIdRef = useRef(0)

  const debugLog = useCallback(
    (event: string, data?: unknown) => {
      try {
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

      setCurrentSessionId(nextSessionId)

      const session = await api.getChatSession(nextSessionId ?? undefined)
      if (cancelled) return
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
          if (taskFinalizingRef.current.has(t.id)) continue
          taskFinalizingRef.current.add(t.id)

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
                if (!pending) return
                acc += pending
                pending = ''

                const displayFinal = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc))
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
                onDelta: (delta) => {
                  pending += delta
                  scheduleFlush()
                },
              })

              if (raf) {
                window.cancelAnimationFrame(raf)
                raf = 0
              }
              flush()

              if (response.error) {
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

              const finalText = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc, { trim: true }))
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

            const response = await aiService.chat(prompt, { systemAddon: mergedAddon })
            if (response.error) {
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
            })

          continue
        }

        // 兼容旧链路（agent.run 等）：直接使用任务 finalReply/draftReply 回填
        const rawText = String((isFinal ? (t.finalReply ?? t.draftReply ?? t.lastError) : (t.draftReply ?? t.lastError ?? t.finalReply)) ?? '')
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
            // 未开启普通 TTS（或启用分句模式），保持原行为：仅在最终时把完整自然语言发给气泡
            if (displayText) api.sendBubbleMessage(displayText)
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
        }
      }
    })

    return () => off()
  }, [addSessionToolFacts, api, currentSessionId, debugLog, runAutoExtractIfNeeded])

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

  const systemAddonForUsage = useMemo(() => {
    const parts = [contextRetrieveAddon.trim(), toolDirectoryAddon.trim()].filter(Boolean)
    return parts.join('\n\n')
  }, [contextRetrieveAddon, toolDirectoryAddon])

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

      isLoadingRef.current = false
      setIsLoading(false)
    },
    [api],
  )

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
    const text = (override?.text ?? input).trim()
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
    const baseMessages = override?.baseMessages ?? messages
    const nextMessages = [...baseMessages, userMessage]
    setMessages(nextMessages)
    if (source === 'manual') {
      setInput('')
      setPendingAttachments([])
    }
    setError(null)
    isLoadingRef.current = true
    setIsLoading(true)
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
          const toolContext = [memoryAddon, toolFactsAddon, attachmentAddon].filter(Boolean).join('\n\n')

          // 使用 token 预算动态截断历史，而非硬编码轮数，充分利用模型的上下文窗口
          const historyForAgent: ChatMessage[] = chatHistory
            .slice(0, -1)
            .map((m) => ({ role: m.role, content: toPlainText(m.content).trim() }))
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.length > 0)
          const trimmedHistory = trimChatHistoryToMaxContext(historyForAgent, toolContext)
          const history = trimmedHistory.history

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
          const plannerTrimmed = trimChatHistoryToMaxContext(plannerHistoryRaw, attachmentAddon ?? '')
          const plannerHistory = plannerTrimmed.history

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
              ...(attachmentAddon ? [{ role: 'system' as const, content: attachmentAddon }] : []),
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
              const mergedSystemAddon = [systemAddon.trim(), toolFactsAddon.trim()].filter(Boolean).join('\n\n')

              const historyWithPreface = [...chatHistory, { role: 'assistant' as const, content: assistantMessage.content }]
              const trimmed = trimChatHistoryToMaxContext(historyWithPreface, mergedSystemAddon)
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
        const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
        if (toolFactsAddon.trim()) systemAddonParts.push(toolFactsAddon.trim())
      }

      const systemAddon = systemAddonParts.filter(Boolean).join('\n\n')

      {
        const trimmed = trimChatHistoryToMaxContext(chatHistory, systemAddon)
        chatHistory = trimmed.history
        if (trimmed.trimmedCount > 0) {
          setError(
            `提示：对话上下文过长，已自动截断为最近 ${chatHistory.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`,
          )
        }
      }

      const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false
      const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)

      if (ttsSegmented) {
        const utteranceId = newMessageId()
        setTtsPendingUtteranceId(utteranceId)
        setTtsRevealedSegments((prev) => ({ ...prev, [utteranceId]: 0 }))

        try {
          const response = enableChatStreaming
            ? await (async () => {
                let acc = ''
                const res = await aiService.chatStream(chatHistory, {
                  signal: abort.signal,
                  systemAddon,
                  onDelta: (delta) => {
                    acc += delta
                  },
                })
                if (!res.error) {
                  const merged = res.content?.trim().length ? res.content : acc
                  return { ...res, content: merged }
                }
                return res
              })()
            : await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
              setTtsRevealedSegments((prev) => {
                const next = { ...prev }
                delete next[utteranceId]
                return next
              })
              return
            }
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
        let raf = 0
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

        const scheduleFlush = () => {
          if (raf) return
          raf = window.requestAnimationFrame(() => {
            raf = 0
            flush()
          })
        }

        const response = await aiService.chatStream(chatHistory, {
          signal: abort.signal,
          systemAddon,
          onDelta: (delta) => {
            pending += delta
            scheduleFlush()
          },
        })

        if (raf) {
          window.cancelAnimationFrame(raf)
          raf = 0
        }
        flush()

        if (response.error) {
          if (response.error === ABORTED_ERROR) {
            // 被打断：不写入错误信息，直接结束
            return
          }
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const nextContent = `[错误] ${response.error}`
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
        if (finalContent) api.sendBubbleMessage(finalContent)
        void runAutoExtractIfNeeded(currentSessionId)
        return
      }

      const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

      if (response.error) {
        if (response.error === ABORTED_ERROR) return
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
      if (response.content) api.sendBubbleMessage(response.content)
      void runAutoExtractIfNeeded(currentSessionId)
    } catch (err) {
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
    input,
    messages,
    newMessageId,
    pendingAttachments,
    buildSessionToolFactsAddon,
    refreshSessions,
    retrieveEnabled,
    interrupt,
    runAutoExtractIfNeeded,
    trimChatHistoryToMaxContext,
    formatAiErrorForUser,
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

    const handleTranscript = (text: string) => {
      const cleaned = String(text ?? '').trim()
      if (!cleaned) return

      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return

      if (asr.autoSend) {
        if (!currentSessionId) {
          pendingAsrAutoSendRef.current.push(cleaned)
          return
        }
        void send({ text: cleaned, source: 'asr' }).then(() => flushAsrAutoSendQueue())
        return
      }

      setInput((prev) => {
        const base = prev.trim()
        if (!base) return cleaned
        return `${prev} ${cleaned}`
      })
    }

    void (async () => {
      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return
      const cached = await api.takeAsrTranscript().catch(() => '')
      if (cancelled) return
      handleTranscript(cached)
    })()

    const off = api.onAsrTranscript(handleTranscript)
    return () => {
      cancelled = true
      off()
    }
  }, [api, currentSessionId, flushAsrAutoSendQueue, send])

  useEffect(() => {
    flushAsrAutoSendQueue()
  }, [flushAsrAutoSendQueue])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
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
      setEditingMessageId(messageId)
      setEditingMessageContent(msg.content)
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
    const nextContent = editingMessageContent
    setMessages((prev) =>
      prev.map((m) => (m.id === editingMessageId ? { ...m, content: nextContent, updatedAt: Date.now() } : m)),
    )
    await api.updateChatMessage(currentSessionId, editingMessageId, nextContent)
    await refreshSessions()
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [api, currentSessionId, editingMessageId, editingMessageContent, refreshSessions])

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
          const trimmed = trimChatHistoryToMaxContext(chatHistory, systemAddon)
          chatHistory = trimmed.history
          if (trimmed.trimmedCount > 0) {
            setError(
              `提示：对话上下文过长，已自动截断为最近 ${chatHistory.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`,
            )
          }
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
          let raf = 0
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

          const scheduleFlush = () => {
            if (raf) return
            raf = window.requestAnimationFrame(() => {
              raf = 0
              flush()
            })
          }

          const response = await aiService.chatStream(chatHistory, {
            signal: abort.signal,
            systemAddon,
            onDelta: (delta) => {
              pending += delta
              scheduleFlush()
            },
          })

          if (raf) {
            window.cancelAnimationFrame(raf)
            raf = 0
          }
          flush()

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              return
            }
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            const nextContent = `[错误] ${response.error}`
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

          if (finalContent) api.sendBubbleMessage(finalContent)
          void runAutoExtractIfNeeded(currentSessionId)
          return
        }

        const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
        if (response.error) {
          if (response.error === ABORTED_ERROR) return
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
        if (response.content) api.sendBubbleMessage(response.content)
        void runAutoExtractIfNeeded(currentSessionId)
      } catch (err) {
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
      settings?.ai?.enableChatStreaming,
      settings?.memory?.enabled,
      settings?.memory?.includeSharedOnRetrieve,
      settings?.tts?.enabled,
      settings?.tts?.segmented,
      runAutoExtractIfNeeded,
      trimChatHistoryToMaxContext,
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
            title="auto=优先原生tools，失败降级文本协议；native=强制原生；text=强制文本协议（更稳）"
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
          const profile = settings?.chatProfile
          const isUser = m.role === 'user'
          const avatar = isUser ? profile?.userAvatar : profile?.assistantAvatar
          const ttsSegmentedUi = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)
          const isSegmentedAssistant = !isUser && ttsSegmentedUi && !!ttsSegmentedMessageFlags[m.id]

          const renderToolUseNode = (taskId: string, runId?: string): React.ReactNode => {
            const t = tasks.find((x) => x.id === taskId) ?? null
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
              const mm = r.outputPreview ? parseMmvectorResults(r.outputPreview) : null
              const mmMedia =
                mm?.results?.filter((x) => {
                  const t = String(x?.type ?? '')
                  if (t === 'video') return String(x?.videoUrl ?? '').trim() || String(x?.videoPath ?? '').trim()
                  if (t === 'image') return String(x?.imagePath ?? '').trim()
                  return false
                }) ?? []
              return (
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
                    {isUser || blocks.length === 0
                      ? m.content
                      : (() => {
                          let toolSeen = 0
                          let statusSeen = 0
                          let textSeen = 0
                          return blocks.map((b) => {
                          if (b.type === 'text') {
                            const text = String(b.text ?? '')
                            if (!text) return null
                            const key = `${m.id}-text-${toolSeen}-${textSeen++}`
                            return <div key={key}>{text}</div>
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
            onChange={(e) => setInput(e.target.value)}
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
          <button className="ndp-btn" onClick={() => send()} disabled={!input.trim() && pendingAttachments.length === 0 && !isLoading}>
            {isLoading ? (!input.trim() && pendingAttachments.length === 0 ? '打断' : '打断并发送') : '发送'}
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
    'live2d' | 'bubble' | 'taskPanel' | 'ai' | 'tools' | 'persona' | 'chat' | 'tts' | 'asr'
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

function ToolsSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const toolSettings = settings?.tools
  const mcpSettings = settings?.mcp

  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [subTab, setSubTab] = useState<'builtin' | 'mcp'>('builtin')
  const [mcpState, setMcpState] = useState<McpStateSnapshot | null>(null)

  useEffect(() => {
    if (!api) return
    let disposed = false

    api
      .listTasks()
      .then((res) => {
        if (disposed) return
        setTasks(Array.isArray(res.items) ? res.items : [])
      })
      .catch((err) => console.error('[Tools] listTasks failed:', err))

    const off = api.onTasksChanged((payload) => setTasks(Array.isArray(payload.items) ? payload.items : []))
    return () => {
      disposed = true
      off()
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    let disposed = false

    api
      .getMcpState()
      .then((snap) => {
        if (disposed) return
        setMcpState(snap)
      })
      .catch((err) => console.error('[MCP] getMcpState failed:', err))

    const off = api.onMcpChanged((snap) => setMcpState(snap))
    return () => {
      disposed = true
      off()
    }
  }, [api])

  const allDefs = useMemo(() => getBuiltinToolDefinitions(), [])
  const effectiveToolSettings = useMemo(() => {
    return toolSettings ?? { enabled: true, groups: {}, tools: {} }
  }, [toolSettings])

  const latestRunByTool = useMemo(() => {
    const out = new Map<
      string,
      { status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number; error?: string; taskId: string; taskTitle: string }
    >()

    for (const t of tasks) {
      const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
      for (const r of runs) {
        const toolName = typeof r?.toolName === 'string' ? r.toolName : ''
        if (!toolName) continue
        const startedAt = typeof r.startedAt === 'number' ? r.startedAt : 0
        const prev = out.get(toolName)
        if (!prev || startedAt > prev.startedAt) {
          out.set(toolName, {
            status: r.status,
            startedAt,
            endedAt: r.endedAt,
            error: r.error,
            taskId: t.id,
            taskTitle: t.title,
          })
        }
      }
    }
    return out
  }, [tasks])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleDefs = useMemo(() => {
    if (!normalizedQuery) return allDefs
    return allDefs.filter((d) => {
      const hay = `${d.name}\n${d.callName}\n${d.description}\n${d.tags?.join(' ') ?? ''}`.toLowerCase()
      return hay.includes(normalizedQuery)
    })
  }, [allDefs, normalizedQuery])

  const groups = useMemo(() => {
    const map = new Map<string, typeof visibleDefs>()
    for (const d of visibleDefs) {
      const g = getToolGroupId(d.name)
      const arr = map.get(g)
      if (arr) arr.push(d)
      else map.set(g, [d])
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [visibleDefs])

  const totalCount = allDefs.length
  const enabledCount = allDefs.filter((d) => isToolEnabled(d.name, effectiveToolSettings)).length

  const updateToolSettings = useCallback(
    async (patch: Partial<AppSettings['tools']>) => {
      if (!api) return
      try {
        await api.setToolSettings(patch)
      } catch (err) {
        console.error('[Tools] setToolSettings failed:', err)
      }
    },
    [api],
  )

  const updateMcpSettings = useCallback(
    async (patch: Partial<AppSettings['mcp']>) => {
      if (!api) return
      try {
        await api.setMcpSettings(patch)
      } catch (err) {
        console.error('[MCP] setMcpSettings failed:', err)
      }
    },
    [api],
  )

  const onToggleGlobal = useCallback(
    (next: boolean) => {
      void updateToolSettings({ enabled: next })
    },
    [updateToolSettings],
  )

  const onToggleGroup = useCallback(
    (groupId: string, next: boolean) => {
      const nextGroups = { ...(effectiveToolSettings.groups ?? {}) }
      nextGroups[groupId] = next
      void updateToolSettings({ groups: nextGroups })
    },
    [effectiveToolSettings.groups, updateToolSettings],
  )

  const onResetGroup = useCallback(
    (groupId: string) => {
      const nextGroups = { ...(effectiveToolSettings.groups ?? {}) }
      delete nextGroups[groupId]
      void updateToolSettings({ groups: nextGroups })
    },
    [effectiveToolSettings.groups, updateToolSettings],
  )

  const onToggleTool = useCallback(
    (toolName: string, next: boolean) => {
      const nextTools = { ...(effectiveToolSettings.tools ?? {}) }
      nextTools[toolName] = next
      void updateToolSettings({ tools: nextTools })
    },
    [effectiveToolSettings.tools, updateToolSettings],
  )

  const onResetTool = useCallback(
    (toolName: string) => {
      const nextTools = { ...(effectiveToolSettings.tools ?? {}) }
      delete nextTools[toolName]
      void updateToolSettings({ tools: nextTools })
    },
    [effectiveToolSettings.tools, updateToolSettings],
  )

  const mcpEnabled = mcpSettings?.enabled ?? false
  const mcpServersRaw = mcpSettings?.servers
  const mcpServers = useMemo(() => {
    return Array.isArray(mcpServersRaw) ? mcpServersRaw : []
  }, [mcpServersRaw])
  const mcpStateById = useMemo(() => {
    const map = new Map<string, (McpStateSnapshot['servers'][number] | null)>()
    const servers = Array.isArray(mcpState?.servers) ? mcpState!.servers : []
    for (const s of servers) {
      if (!s || typeof s.id !== 'string') continue
      map.set(s.id, s)
    }
    return map
  }, [mcpState])

  const parseArgsText = useCallback((text: string): string[] => {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  }, [])

  const formatArgsText = useCallback((args: string[] | undefined | null): string => {
    return Array.isArray(args) ? args.filter((v) => typeof v === 'string' && v.trim()).join('\n') : ''
  }, [])

  const parseEnvText = useCallback((text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (!key) continue
      out[key] = value
    }
    return out
  }, [])

  const formatEnvText = useCallback((env: Record<string, string> | undefined | null): string => {
    if (!env) return ''
    return Object.entries(env)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  }, [])

  const updateMcpServer = useCallback(
    (idx: number, patch: Partial<McpServerConfig>) => {
      const next = mcpServers.map((s, i) => (i === idx ? { ...s, ...patch } : s))
      void updateMcpSettings({ servers: next })
    },
    [mcpServers, updateMcpSettings],
  )

  const removeMcpServer = useCallback(
    (idx: number) => {
      const next = mcpServers.filter((_, i) => i !== idx)
      void updateMcpSettings({ servers: next })
    },
    [mcpServers, updateMcpSettings],
  )

  const addMcpServer = useCallback(() => {
    const used = new Set(mcpServers.map((s) => (s?.id ?? '').trim()).filter(Boolean))
    let id = 'server'
    if (used.has(id)) {
      for (let i = 2; i < 9999; i += 1) {
        const candidate = `server-${i}`
        if (!used.has(candidate)) {
          id = candidate
          break
        }
      }
    }

    const next: McpServerConfig = {
      id,
      enabled: true,
      label: '',
      transport: 'stdio',
      command: '',
      args: [],
      cwd: '',
      env: {},
    }
    void updateMcpSettings({ servers: [...mcpServers, next] })
  }, [mcpServers, updateMcpSettings])

  const [mcpImportText, setMcpImportText] = useState('')
  const [mcpImportError, setMcpImportError] = useState<string | null>(null)

  const buildMcpExportText = useCallback((servers: McpServerConfig[]) => {
    const mcpServers: Record<
      string,
      { command: string; args: string[]; cwd?: string; env?: Record<string, string> }
    > = {}

    for (const s of servers) {
      const id = (s?.id ?? '').trim()
      if (!id) continue
      mcpServers[id] = {
        command: s.command ?? '',
        args: Array.isArray(s.args) ? s.args : [],
        cwd: s.cwd || undefined,
        env: s.env && Object.keys(s.env).length ? s.env : undefined,
      }
    }

    return JSON.stringify({ mcpServers }, null, 2)
  }, [])

  const parseMcpImport = useCallback((text: string): { servers: McpServerConfig[] } => {
    const raw = (text ?? '').trim()
    if (!raw) throw new Error('请输入 JSON')

    const obj = JSON.parse(raw) as unknown

    const acceptObjectServers = (value: unknown): McpServerConfig[] => {
      const serversObj = typeof value === 'object' && value && !Array.isArray(value) ? (value as Record<string, unknown>) : null
      if (!serversObj) return []

      const out: McpServerConfig[] = []
      for (const [idRaw, cfgRaw] of Object.entries(serversObj)) {
        const id = String(idRaw ?? '').trim()
        if (!id) continue
        const cfg = typeof cfgRaw === 'object' && cfgRaw && !Array.isArray(cfgRaw) ? (cfgRaw as Record<string, unknown>) : null
        if (!cfg) continue

        const command = typeof cfg.command === 'string' ? cfg.command : ''
        const args = Array.isArray(cfg.args) ? cfg.args.filter((x) => typeof x === 'string') : []
        const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
        const env =
          typeof cfg.env === 'object' && cfg.env && !Array.isArray(cfg.env)
            ? Object.fromEntries(Object.entries(cfg.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
            : {}

        out.push({
          id,
          enabled: cfg.enabled === false ? false : true,
          label: typeof cfg.label === 'string' ? cfg.label : id,
          transport: 'stdio',
          command,
          args,
          cwd,
          env,
        })
      }
      return out
    }

    const acceptArrayServers = (value: unknown): McpServerConfig[] => {
      if (!Array.isArray(value)) return []
      const out: McpServerConfig[] = []
      for (const it of value) {
        const cfg = typeof it === 'object' && it && !Array.isArray(it) ? (it as Record<string, unknown>) : null
        if (!cfg) continue
        const id = typeof cfg.id === 'string' ? cfg.id.trim() : ''
        if (!id) continue
        const command = typeof cfg.command === 'string' ? cfg.command : ''
        const args = Array.isArray(cfg.args) ? cfg.args.filter((x) => typeof x === 'string') : []
        const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
        const env =
          typeof cfg.env === 'object' && cfg.env && !Array.isArray(cfg.env)
            ? Object.fromEntries(Object.entries(cfg.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
            : {}

        out.push({
          id,
          enabled: cfg.enabled === false ? false : true,
          label: typeof cfg.label === 'string' ? cfg.label : id,
          transport: 'stdio',
          command,
          args,
          cwd,
          env,
        })
      }
      return out
    }

    // 支持两种格式：
    // 1) { "mcpServers": { "id": { command,args,cwd,env } } }
    // 2) { "servers": [ {id,enabled,label,transport,command,args,cwd,env} ] } / 直接 array
    const fromObject = acceptObjectServers((obj as { mcpServers?: unknown }).mcpServers)
    const fromServersArray = acceptArrayServers((obj as { servers?: unknown }).servers)
    const fromDirectArray = acceptArrayServers(obj)

    const servers = fromObject.length ? fromObject : fromServersArray.length ? fromServersArray : fromDirectArray

    if (!servers.length) throw new Error('未解析到任何 MCP Server（支持 {mcpServers:{...}} 或 {servers:[...]}）')
    return { servers }
  }, [])

  const onMcpImportReplace = useCallback(() => {
    try {
      const parsed = parseMcpImport(mcpImportText)
      setMcpImportError(null)
      void updateMcpSettings({ servers: parsed.servers })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMcpImportError(msg)
    }
  }, [mcpImportText, parseMcpImport, updateMcpSettings])

  const onMcpImportMerge = useCallback(() => {
    try {
      const parsed = parseMcpImport(mcpImportText)
      const map = new Map(mcpServers.map((s) => [String(s.id), s] as const))
      for (const s of parsed.servers) map.set(String(s.id), s)
      const next = Array.from(map.values())
      setMcpImportError(null)
      void updateMcpSettings({ servers: next })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMcpImportError(msg)
    }
  }, [mcpImportText, mcpServers, parseMcpImport, updateMcpSettings])

  const onMcpExportToTextarea = useCallback(() => {
    setMcpImportError(null)
    setMcpImportText(buildMcpExportText(mcpServers))
  }, [buildMcpExportText, mcpServers])

  return (
    <div className="ndp-settings-section">
      <h3>工具中心</h3>

      <div className="ndp-setting-item">
        <label>工具总开关</label>
        <div className="ndp-row">
          <input
            type="checkbox"
            checked={effectiveToolSettings.enabled}
            onChange={(e) => onToggleGlobal(e.currentTarget.checked)}
            disabled={!api}
          />
          <div className="ndp-setting-hint">关闭后：Planner/Agent/执行器都不会使用任何工具</div>
        </div>
      </div>

      <div className="ndp-toolcenter-subtabs">
        <button className={`ndp-btn ${subTab === 'builtin' ? 'active' : ''}`} onClick={() => setSubTab('builtin')}>
          内置工具
        </button>
        <button className={`ndp-btn ${subTab === 'mcp' ? 'active' : ''}`} onClick={() => setSubTab('mcp')}>
          MCP
        </button>
      </div>

      {subTab === 'builtin' ? (
        <>
          <div className="ndp-setting-item">
            <label>搜索</label>
            <div className="ndp-row">
              <input
                className="ndp-input"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="按名称/描述/tags 搜索…"
              />
              <div className="ndp-setting-hint">
                启用：{enabledCount}/{totalCount}
              </div>
            </div>
          </div>

          <div className="ndp-toolcenter-list">
            {groups.map(([groupId, defs]) => {
              const groupOverride = (effectiveToolSettings.groups ?? {})[groupId]
              const groupEffective = effectiveToolSettings.enabled && (typeof groupOverride === 'boolean' ? groupOverride : true)
              const groupEnabledCount = defs.filter((d) => isToolEnabled(d.name, effectiveToolSettings)).length

              return (
                <details key={groupId} className="ndp-toolcenter-group" open={normalizedQuery ? true : undefined}>
                  <summary className="ndp-toolcenter-group-summary">
                    <div className="ndp-toolcenter-group-left">
                      <span className="ndp-toolcenter-group-name">{groupId}</span>
                      <span className="ndp-setting-hint">
                        {groupEnabledCount}/{defs.length}
                      </span>
                    </div>

                    <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                      <label className="ndp-toolcenter-toggle" title="分组开关（可覆盖总开关以外的默认）">
                        <input
                          type="checkbox"
                          checked={groupEffective}
                          onChange={(e) => onToggleGroup(groupId, e.currentTarget.checked)}
                          disabled={!api || !effectiveToolSettings.enabled}
                        />
                        <span>启用</span>
                      </label>
                      {typeof groupOverride === 'boolean' ? (
                        <button className="ndp-btn ndp-btn-mini" onClick={() => onResetGroup(groupId)} disabled={!api}>
                          重置
                        </button>
                      ) : null}
                    </div>
                  </summary>

                  <div className="ndp-toolcenter-group-body">
                    {defs
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((d) => {
                        const toolOverride = (effectiveToolSettings.tools ?? {})[d.name]
                        const toolEnabled = isToolEnabled(d.name, effectiveToolSettings)
                        const last = latestRunByTool.get(d.name) ?? null

                        return (
                          <details key={d.name} className={`ndp-toolcenter-tool ${toolEnabled ? '' : 'ndp-toolcenter-tool-disabled'}`}>
                            <summary className="ndp-toolcenter-tool-summary">
                              <div className="ndp-toolcenter-tool-left">
                                <span className="ndp-toolcenter-tool-name">{d.name}</span>
                                <span className="ndp-setting-hint">{d.risk}/{d.cost}</span>
                                {last ? (
                                  <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${last.status}`}>
                                    {last.status}
                                  </span>
                                ) : (
                                  <span className="ndp-setting-hint">未调用</span>
                                )}
                              </div>

                              <div className="ndp-toolcenter-tool-actions" onClick={(e) => e.stopPropagation()}>
                                <label className="ndp-toolcenter-toggle">
                                  <input
                                    type="checkbox"
                                    checked={toolEnabled}
                                    onChange={(e) => onToggleTool(d.name, e.currentTarget.checked)}
                                    disabled={!api || !effectiveToolSettings.enabled}
                                  />
                                  <span>启用</span>
                                </label>
                                {typeof toolOverride === 'boolean' ? (
                                  <button className="ndp-btn ndp-btn-mini" onClick={() => onResetTool(d.name)} disabled={!api}>
                                    重置
                                  </button>
                                ) : null}
                              </div>
                            </summary>

                            <div className="ndp-toolcenter-tool-body">
                              <div className="ndp-toolcenter-desc">{d.description}</div>
                              {Array.isArray(d.tags) && d.tags.length ? (
                                <div className="ndp-setting-hint">tags: {d.tags.join(', ')}</div>
                              ) : null}

                              <div className="ndp-toolcenter-meta">
                                <div className="ndp-setting-hint">callName: {d.callName}</div>
                                <div className="ndp-setting-hint">version: {d.version}</div>
                              </div>

                              {last ? (
                                <div className="ndp-toolcenter-last">
                                  <div className="ndp-setting-hint">
                                    最近一次：{new Date(last.startedAt).toLocaleString()}（任务：{last.taskTitle}）
                                  </div>
                                  {last.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {last.error}</div> : null}
                                </div>
                              ) : null}

                              <details className="ndp-toolcenter-sub">
                                <summary className="ndp-toolcenter-sub-summary">inputSchema</summary>
                                <pre className="ndp-toolcenter-pre">{JSON.stringify(d.inputSchema ?? {}, null, 2)}</pre>
                              </details>

                              <details className="ndp-toolcenter-sub">
                                <summary className="ndp-toolcenter-sub-summary">examples</summary>
                                <div className="ndp-toolcenter-examples">
                                  {(Array.isArray(d.examples) ? d.examples : []).map((ex, idx) => (
                                    <div key={`${d.name}-ex-${idx}`} className="ndp-toolcenter-example">
                                      <div className="ndp-toolcenter-example-title">{ex.title}</div>
                                      <pre className="ndp-toolcenter-pre">{JSON.stringify(ex.input ?? {}, null, 2)}</pre>
                                    </div>
                                  ))}
                                  {!d.examples?.length ? <div className="ndp-setting-hint">无</div> : null}
                                </div>
                              </details>
                            </div>
                          </details>
                        )
                      })}
                  </div>
                </details>
              )
            })}
          </div>
        </>
      ) : (
        <>
          <div className="ndp-setting-item">
            <label>MCP 总开关</label>
            <div className="ndp-row">
              <input
                type="checkbox"
                checked={mcpEnabled}
                onChange={(e) => void updateMcpSettings({ enabled: e.currentTarget.checked })}
                disabled={!api}
              />
              <div className="ndp-setting-hint">
                开启后：连接成功的 MCP Server 会把工具暴露到 Agent（仍受“工具总开关/分组/单工具”影响）
              </div>
            </div>
          </div>

          <details className="ndp-toolcenter-group" open={false}>
            <summary className="ndp-toolcenter-group-summary">
              <div className="ndp-toolcenter-group-left">
                <span className="ndp-toolcenter-group-name">一键导入/导出（JSON）</span>
                <span className="ndp-setting-hint">兼容 {`{ "mcpServers": { ... } }`}</span>
              </div>
              <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                <button className="ndp-btn ndp-btn-mini" onClick={onMcpExportToTextarea} disabled={!api}>
                  导出到文本框
                </button>
              </div>
            </summary>

            <div className="ndp-toolcenter-group-body">
              <textarea
                className="ndp-input ndp-textarea"
                value={mcpImportText}
                onChange={(e) => setMcpImportText(e.currentTarget.value)}
                placeholder={`{
  "mcpServers": {
    "exa": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "exa-mcp-server@latest"],
      "env": { "EXA_API_KEY": "..." }
    }
  }
}`}
              />
              {mcpImportError ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {mcpImportError}</div> : null}
              <div className="ndp-row">
                <button className="ndp-btn" onClick={onMcpImportReplace} disabled={!api}>
                  覆盖导入
                </button>
                <button className="ndp-btn" onClick={onMcpImportMerge} disabled={!api}>
                  合并导入（按 id 更新/新增）
                </button>
                <div className="ndp-setting-hint">导入后会触发自动重连；server id 会在保存时自动规范化并去重。</div>
              </div>
            </div>
          </details>

          <div className="ndp-setting-item">
            <div className="ndp-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>MCP Servers</div>
                <div className="ndp-setting-hint">仅支持 stdio；修改 command/args/cwd/env 后会自动重连。</div>
              </div>
              <button className="ndp-btn" onClick={addMcpServer} disabled={!api}>
                + 添加
              </button>
            </div>
          </div>

          <div className="ndp-toolcenter-list">
            {mcpServers.length ? null : <div className="ndp-setting-hint">暂无 MCP Server，点击“+ 添加”创建一个。</div>}

            {mcpServers.map((cfg, idx) => {
              const cfgId = (cfg?.id ?? '').trim() || `server-${idx + 1}`
              const state = mcpStateById.get(cfgId) ?? null
              const status = state?.status ?? 'disconnected'
              const tools = Array.isArray(state?.tools) ? state!.tools : []
              const enabledToolCount = tools.filter((t) => isToolEnabled(t.toolName, effectiveToolSettings)).length
              const groupId = `mcp.${cfgId}`
              const groupOverride = (effectiveToolSettings.groups ?? {})[groupId]
              const groupEffective = effectiveToolSettings.enabled && (typeof groupOverride === 'boolean' ? groupOverride : true)

              return (
                <details key={`${cfgId}-${idx}`} className="ndp-toolcenter-group">
                  <summary className="ndp-toolcenter-group-summary">
                    <div className="ndp-toolcenter-group-left">
                      <span className="ndp-toolcenter-group-name">{cfg.label?.trim() || cfgId}</span>
                      <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${status}`}>{status}</span>
                      <span className="ndp-setting-hint">
                        工具：{enabledToolCount}/{tools.length}
                      </span>
                    </div>

                    <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                      <label className="ndp-toolcenter-toggle" title="MCP Server 开关（关闭会断开连接并隐藏工具）">
                        <input
                          type="checkbox"
                          checked={cfg.enabled !== false}
                          onChange={(e) => updateMcpServer(idx, { enabled: e.currentTarget.checked })}
                          disabled={!api}
                        />
                        <span>启用</span>
                      </label>
                      <button className="ndp-btn ndp-btn-mini" onClick={() => removeMcpServer(idx)} disabled={!api}>
                        删除
                      </button>
                    </div>
                  </summary>

                  <div className="ndp-toolcenter-group-body">
                    <div className="ndp-setting-item">
                      <label>Server ID（mcp.&lt;serverId&gt;.*）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfgId}
                          placeholder="例如：local-tools"
                          onBlur={(e) => updateMcpServer(idx, { id: e.currentTarget.value.trim() || cfgId })}
                          disabled={!api}
                        />
                        <div className="ndp-setting-hint">仅允许字母/数字/_/-；变更会自动规范化。</div>
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>label（可选）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.label ?? ''}
                          placeholder="显示名称"
                          onBlur={(e) => updateMcpServer(idx, { label: e.currentTarget.value })}
                          disabled={!api}
                        />
                        <div className="ndp-setting-hint">用于工具中心显示，不影响 toolName。</div>
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>command</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.command ?? ''}
                          placeholder="例如：node"
                          onBlur={(e) => updateMcpServer(idx, { command: e.currentTarget.value })}
                          disabled={!api}
                        />
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>args（每行一个）</label>
                      <textarea
                        className="ndp-input ndp-textarea"
                        defaultValue={formatArgsText(cfg.args)}
                        placeholder="例如：path/to/server.js"
                        onBlur={(e) => updateMcpServer(idx, { args: parseArgsText(e.currentTarget.value) })}
                        disabled={!api}
                      />
                    </div>

                    <div className="ndp-setting-item">
                      <label>cwd（可选）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.cwd ?? ''}
                          placeholder="工作目录（空=默认）"
                          onBlur={(e) => updateMcpServer(idx, { cwd: e.currentTarget.value })}
                          disabled={!api}
                        />
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>env（KEY=VALUE，每行一个，可选）</label>
                      <textarea
                        className="ndp-input ndp-textarea"
                        defaultValue={formatEnvText(cfg.env)}
                        placeholder={'# 例如：\nOPENAI_API_KEY=xxxx\nHTTP_PROXY=http://127.0.0.1:7890'}
                        onBlur={(e) => updateMcpServer(idx, { env: parseEnvText(e.currentTarget.value) })}
                        disabled={!api}
                      />
                    </div>

                    <div className="ndp-setting-item">
                      <label>工具分组开关：{groupId}</label>
                      <div className="ndp-row">
                        <label className="ndp-toolcenter-toggle" title="分组开关（可覆盖总开关以外的默认）">
                          <input
                            type="checkbox"
                            checked={groupEffective}
                            onChange={(e) => onToggleGroup(groupId, e.currentTarget.checked)}
                            disabled={!api || !effectiveToolSettings.enabled}
                          />
                          <span>启用</span>
                        </label>
                        {typeof groupOverride === 'boolean' ? (
                          <button className="ndp-btn ndp-btn-mini" onClick={() => onResetGroup(groupId)} disabled={!api}>
                            重置
                          </button>
                        ) : null}
                        <div className="ndp-setting-hint">关闭分组会隐藏该 server 下所有工具。</div>
                      </div>
                    </div>

                    {state?.lastError ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {state.lastError}</div> : null}

                    {Array.isArray(state?.stderrTail) && state.stderrTail.length ? (
                      <details className="ndp-toolcenter-sub">
                        <summary className="ndp-toolcenter-sub-summary">stderr（最近 {state.stderrTail.length} 行）</summary>
                        <pre className="ndp-toolcenter-pre">{state.stderrTail.join('\n')}</pre>
                      </details>
                    ) : null}

                    <details className="ndp-toolcenter-sub" open={tools.length ? undefined : false}>
                      <summary className="ndp-toolcenter-sub-summary">
                        tools（{enabledToolCount}/{tools.length}）
                      </summary>
                      <div className="ndp-toolcenter-list">
                        {tools
                          .slice()
                          .sort((a, b) => a.toolName.localeCompare(b.toolName))
                          .map((t) => {
                            const toolOverride = (effectiveToolSettings.tools ?? {})[t.toolName]
                            const toolEnabled = isToolEnabled(t.toolName, effectiveToolSettings)

                            return (
                              <details
                                key={t.toolName}
                                className={`ndp-toolcenter-tool ${toolEnabled ? '' : 'ndp-toolcenter-tool-disabled'}`}
                              >
                                <summary className="ndp-toolcenter-tool-summary">
                                  <div className="ndp-toolcenter-tool-left">
                                    <span className="ndp-toolcenter-tool-name">{t.toolName}</span>
                                    <span className="ndp-setting-hint">{t.callName}</span>
                                  </div>
                                  <div className="ndp-toolcenter-tool-actions" onClick={(e) => e.stopPropagation()}>
                                    <label className="ndp-toolcenter-toggle">
                                      <input
                                        type="checkbox"
                                        checked={toolEnabled}
                                        onChange={(e) => onToggleTool(t.toolName, e.currentTarget.checked)}
                                        disabled={!api || !effectiveToolSettings.enabled}
                                      />
                                      <span>启用</span>
                                    </label>
                                    {typeof toolOverride === 'boolean' ? (
                                      <button className="ndp-btn ndp-btn-mini" onClick={() => onResetTool(t.toolName)} disabled={!api}>
                                        重置
                                      </button>
                                    ) : null}
                                  </div>
                                </summary>

                                <div className="ndp-toolcenter-tool-body">
                                  {t.description ? <div className="ndp-toolcenter-desc">{t.description}</div> : null}
                                  <div className="ndp-toolcenter-meta">
                                    <div className="ndp-setting-hint">callName: {t.callName}</div>
                                    <div className="ndp-setting-hint">name: {t.name}</div>
                                  </div>

                                  <details className="ndp-toolcenter-sub">
                                    <summary className="ndp-toolcenter-sub-summary">inputSchema</summary>
                                    <pre className="ndp-toolcenter-pre">{JSON.stringify(t.inputSchema ?? {}, null, 2)}</pre>
                                  </details>
                                  {t.outputSchema ? (
                                    <details className="ndp-toolcenter-sub">
                                      <summary className="ndp-toolcenter-sub-summary">outputSchema</summary>
                                      <pre className="ndp-toolcenter-pre">{JSON.stringify(t.outputSchema ?? {}, null, 2)}</pre>
                                    </details>
                                  ) : null}
                                </div>
                              </details>
                            )
                          })}
                      </div>
                    </details>
                  </div>
                </details>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function PersonaSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const activePersonaId = settings?.activePersonaId ?? 'default'
  const memoryEnabled = settings?.memory?.enabled ?? true
  const includeSharedOnRetrieve = settings?.memory?.includeSharedOnRetrieve ?? true
  const vectorDedupeThreshold = settings?.memory?.vectorDedupeThreshold ?? 0.9

  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const autoExtractEveryEffectiveMessages = settings?.memory?.autoExtractEveryEffectiveMessages ?? 20
  const autoExtractMaxEffectiveMessages = settings?.memory?.autoExtractMaxEffectiveMessages ?? 60
  const autoExtractCooldownMs = settings?.memory?.autoExtractCooldownMs ?? 120000
  const autoExtractUseCustomAi = settings?.memory?.autoExtractUseCustomAi ?? false
  const autoExtractAiBaseUrl = settings?.memory?.autoExtractAiBaseUrl ?? ''
  const autoExtractAiApiKey = settings?.memory?.autoExtractAiApiKey ?? ''
  const autoExtractAiModel = settings?.memory?.autoExtractAiModel ?? ''
  const autoExtractAiTemperature = settings?.memory?.autoExtractAiTemperature ?? 0.2
  const autoExtractAiMaxTokens = settings?.memory?.autoExtractAiMaxTokens ?? 1600

  const tagEnabled = settings?.memory?.tagEnabled ?? true
  const tagMaxExpand = settings?.memory?.tagMaxExpand ?? 6

  const vectorEnabled = settings?.memory?.vectorEnabled ?? false
  const vectorEmbeddingModel = settings?.memory?.vectorEmbeddingModel ?? 'text-embedding-3-small'
  const vectorMinScore = settings?.memory?.vectorMinScore ?? 0.35
  const vectorTopK = settings?.memory?.vectorTopK ?? 20
  const vectorScanLimit = settings?.memory?.vectorScanLimit ?? 2000
  const vectorUseCustomAi = settings?.memory?.vectorUseCustomAi ?? false
  const vectorAiBaseUrl = settings?.memory?.vectorAiBaseUrl ?? ''
  const vectorAiApiKey = settings?.memory?.vectorAiApiKey ?? ''

  const mmVectorEnabled = settings?.memory?.mmVectorEnabled ?? false
  const mmVectorEmbeddingModel = settings?.memory?.mmVectorEmbeddingModel ?? 'qwen3-vl-embedding-8b'
  const mmVectorUseCustomAi = settings?.memory?.mmVectorUseCustomAi ?? false
  const mmVectorAiBaseUrl = settings?.memory?.mmVectorAiBaseUrl ?? ''
  const mmVectorAiApiKey = settings?.memory?.mmVectorAiApiKey ?? ''

  const kgEnabled = settings?.memory?.kgEnabled ?? false
  const kgIncludeChatMessages = settings?.memory?.kgIncludeChatMessages ?? false
  const kgUseCustomAi = settings?.memory?.kgUseCustomAi ?? true
  const kgAiBaseUrl = settings?.memory?.kgAiBaseUrl ?? ''
  const kgAiApiKey = settings?.memory?.kgAiApiKey ?? ''
  const kgAiModel = settings?.memory?.kgAiModel ?? 'gpt-4o-mini'
  const kgAiTemperature = settings?.memory?.kgAiTemperature ?? 0.2
  const kgAiMaxTokens = settings?.memory?.kgAiMaxTokens ?? 1200

  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [subTab, setSubTab] = useState<'persona' | 'memory' | 'recall' | 'textVector' | 'mmVector' | 'manage'>('persona')
  const [memScope, setMemScope] = useState<'persona' | 'shared' | 'all'>('persona')
  const [memRole, setMemRole] = useState<'all' | 'user' | 'assistant' | 'note'>('all')
  const [memQuery, setMemQuery] = useState('')
  const [memItems, setMemItems] = useState<Array<{ rowid: number; createdAt: number; role: string | null; kind: string; scope: string; content: string }>>([])
  const [memTotal, setMemTotal] = useState(0)
  const [memOffset, setMemOffset] = useState(0)
  const [memNewText, setMemNewText] = useState('')
  const [memNewScope, setMemNewScope] = useState<'persona' | 'shared'>('persona')
  const saveTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (!api) return
    const list = await api.listPersonas()
    setPersonas(list)
  }, [api])

  const refreshMemoryList = useCallback(async () => {
    if (!api) return
    const res = await api.listMemory({
      personaId: activePersonaId,
      scope: memScope,
      role: memRole,
      query: memQuery.trim() || undefined,
      limit: 50,
      offset: memOffset,
    })
    setMemTotal(res.total)
    setMemItems(res.items)
  }, [api, activePersonaId, memScope, memRole, memQuery, memOffset])

  useEffect(() => {
    if (!api) return
    void refresh().catch((err) => console.error('[Persona] listPersonas failed:', err))
  }, [api, refresh])

  useEffect(() => {
    void (async () => {
      if (!api) return
      const p = await api.getPersona(activePersonaId)
      setCurrentPersona(p)
      setDraftName(p?.name ?? '')
      setDraftPrompt(p?.prompt ?? '')
      setMemScope('persona')
      setMemRole('all')
      setMemQuery('')
      setMemOffset(0)
    })().catch((err) => console.error('[Persona] getPersona failed:', err))
  }, [api, activePersonaId])

  useEffect(() => {
    if (!api) return
    void refreshMemoryList().catch((err) => console.error('[Memory] list failed:', err))
  }, [api, refreshMemoryList])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [])

  const scheduleSavePrompt = useCallback(
    (personaId: string, prompt: string) => {
      if (!api) return
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        void api
          .updatePersona(personaId, { prompt })
          .then((p) => setCurrentPersona(p))
          .catch((err) => console.error('[Persona] updatePersona failed:', err))
      }, 450)
    },
    [api],
  )

  const scheduleSavePersonaFlags = useCallback(
    (personaId: string, patch: { captureEnabled?: boolean; captureUser?: boolean; captureAssistant?: boolean; retrieveEnabled?: boolean }) => {
      if (!api) return
      void api
        .updatePersona(personaId, patch)
        .then((p) => setCurrentPersona(p))
        .catch((err) => console.error('[Persona] updatePersona flags failed:', err))
    },
    [api],
  )

  const onChangePersona = useCallback(
    async (personaId: string) => {
      if (!api) return
      await api.setActivePersonaId(personaId)
    },
    [api],
  )

  const onToggleGlobalMemory = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ enabled })
    },
    [api],
  )

  const onToggleIncludeShared = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ includeSharedOnRetrieve: enabled })
    },
    [api],
  )

  const onSetAutoExtractSettings = useCallback(
    async (patch: Partial<AppSettings['memory']>) => {
      if (!api) return
      await api.setMemorySettings(patch)
    },
    [api],
  )

  const onCreatePersona = useCallback(async () => {
    if (!api) return
    const created = await api.createPersona('新角色')
    await refresh()
    await api.setActivePersonaId(created.id)
  }, [api, refresh])

  const onRenamePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    const nextName = draftName.trim()
    if (!nextName) return
    await api.updatePersona(currentPersona.id, { name: nextName })
    await refresh()
  }, [api, currentPersona, draftName, refresh])

  const onDeletePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    if (currentPersona.id === 'default') return
    const ok = window.confirm(`确定删除角色「${currentPersona.name}」？\n该操作会删除人设配置；聊天会话仍会保留在本地。`)
    if (!ok) return
    await api.deletePersona(currentPersona.id)
    await refresh()
    await api.setActivePersonaId('default')
  }, [api, currentPersona, refresh])

  const onAddManualMemory = useCallback(async () => {
    if (!api) return
    const content = memNewText.trim()
    if (!content) return
    await api.upsertManualMemory({ personaId: activePersonaId, scope: memNewScope, content })
    setMemNewText('')
    setMemOffset(0)
    await refreshMemoryList()
  }, [api, activePersonaId, memNewScope, memNewText, refreshMemoryList])

  const onDeleteMemory = useCallback(
    async (rowid: number) => {
      if (!api) return
      const ok = window.confirm('确定删除这条记忆？')
      if (!ok) return
      await api.deleteMemory({ rowid })
      await refreshMemoryList()
    },
    [api, refreshMemoryList],
  )

  if (!api) {
    return (
      <div className="ndp-settings-section">
        <h3>角色</h3>
        <p className="ndp-setting-hint">API 未就绪，请稍后再试。</p>
      </div>
    )
  }

  return (
    <div className="ndp-settings-section">
      <div className="ndp-settings-subtabs">
        <button className={`ndp-tab-btn ${subTab === 'persona' ? 'active' : ''}`} onClick={() => setSubTab('persona')}>
          角色
        </button>
        <button className={`ndp-tab-btn ${subTab === 'memory' ? 'active' : ''}`} onClick={() => setSubTab('memory')}>
          记忆
        </button>
        <button className={`ndp-tab-btn ${subTab === 'recall' ? 'active' : ''}`} onClick={() => setSubTab('recall')}>
          召回
        </button>
        <button className={`ndp-tab-btn ${subTab === 'textVector' ? 'active' : ''}`} onClick={() => setSubTab('textVector')}>
          文本向量
        </button>
        <button className={`ndp-tab-btn ${subTab === 'mmVector' ? 'active' : ''}`} onClick={() => setSubTab('mmVector')}>
          多模态向量
        </button>
        <button className={`ndp-tab-btn ${subTab === 'manage' ? 'active' : ''}`} onClick={() => setSubTab('manage')}>
          管理
        </button>
      </div>

      {subTab === 'persona' ? (
        <>
          <h3>角色</h3>

          <div className="ndp-setting-item">
            <label>当前角色</label>
            <div className="ndp-row">
              <select className="ndp-select" value={activePersonaId} onChange={(e) => void onChangePersona(e.target.value)}>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="ndp-btn" onClick={() => void onCreatePersona()}>
                新建
              </button>
              <button className="ndp-btn" disabled={!currentPersona || currentPersona.id === 'default'} onClick={() => void onDeletePersona()}>
                删除
              </button>
            </div>
            <p className="ndp-setting-hint">每个角色的长期记忆与会话列表隔离；公共事实层后续再加。</p>
          </div>

          <div className="ndp-setting-item">
            <label>角色名称</label>
            <div className="ndp-row">
              <input className="ndp-input" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              <button className="ndp-btn" disabled={!currentPersona} onClick={() => void onRenamePersona()}>
                保存
              </button>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>人设补充提示词</label>
            <textarea
              className="ndp-textarea"
              rows={10}
              value={draftPrompt}
              placeholder="写下这个角色的口癖、价值观、禁忌、关系设定等（会追加到全局 systemPrompt 后）"
              onChange={(e) => {
                const next = e.target.value
                setDraftPrompt(next)
                if (currentPersona) scheduleSavePrompt(currentPersona.id, next)
              }}
            />
            <p className="ndp-setting-hint">建议只写“稳定约束”。对话原文会自动写入长期记忆库用于召回。</p>
          </div>
        </>
      ) : null}

      {subTab === 'memory' ? <h3>记忆开关</h3> : null}

      {subTab === 'memory' ? (
        <>
          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input type="checkbox" checked={memoryEnabled} onChange={(e) => void onToggleGlobalMemory(e.target.checked)} />
              <span>启用长期记忆（全局）</span>
            </label>
            <p className="ndp-setting-hint">关闭后不会再记录新内容，也不会将记忆注入到提示词。</p>
          </div>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={includeSharedOnRetrieve}
                onChange={(e) => void onToggleIncludeShared(e.target.checked)}
              />
              <span>检索时包含共享记忆（默认）</span>
            </label>
          </div>
        </>
      ) : null}

      {subTab === 'textVector' ? (
        <>
          <h3>向量去重</h3>

          <div className="ndp-setting-item">
            <label>向量去重阈值（越高越保守）</label>
            <input
              className="ndp-input"
              type="number"
              min={0.1}
              max={0.99}
              step={0.01}
              value={vectorDedupeThreshold}
              onChange={(e) => void onSetAutoExtractSettings({ vectorDedupeThreshold: Number(e.target.value) })}
            />
            <p className="ndp-setting-hint">每次写入记忆时：先用 embeddings 做相似度匹配，命中相似条目就立即合并，不新增重复记录。</p>
          </div>
        </>
      ) : null}

      {subTab === 'recall' ? (
        <>
          <h3>召回增强（M5）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={tagEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ tagEnabled: e.target.checked })}
              />
              <span>启用 Tag 网络（模糊问法扩展，本地低延迟）</span>
            </label>
            <p className="ndp-setting-hint">把重点词拆成轻量 Tag，用于模糊问法的扩展与召回。</p>
          </div>

          <div className="ndp-setting-item">
            <label>Tag 扩展数（0=不扩展）</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={40}
              value={tagMaxExpand}
              onChange={(e) => void onSetAutoExtractSettings({ tagMaxExpand: Number(e.target.value) })}
            />
          </div>
        </>
      ) : null}

      {subTab === 'textVector' ? (
        <>
          <h3>文本向量召回（M5）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={vectorEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ vectorEnabled: e.target.checked })}
              />
              <span>启用向量召回（更强，需 embeddings API）</span>
            </label>
            <p className="ndp-setting-hint">启用后会在后台逐步补齐你的记忆嵌入，不会阻塞聊天。</p>
          </div>

      <div className="ndp-setting-item">
        <label>embeddings 模型</label>
        <input
          className="ndp-input"
          value={vectorEmbeddingModel}
          placeholder="例如：text-embedding-3-small"
          onChange={(e) => void onSetAutoExtractSettings({ vectorEmbeddingModel: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量最低相似度（0~1）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={vectorMinScore}
          onChange={(e) => void onSetAutoExtractSettings({ vectorMinScore: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量 TopK</label>
        <input
          className="ndp-input"
          type="number"
          min={1}
          max={100}
          value={vectorTopK}
          onChange={(e) => void onSetAutoExtractSettings({ vectorTopK: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量扫描上限（降低延迟）</label>
        <input
          className="ndp-input"
          type="number"
          min={200}
          max={200000}
          value={vectorScanLimit}
          onChange={(e) => void onSetAutoExtractSettings({ vectorScanLimit: Number(e.target.value) })}
        />
        <p className="ndp-setting-hint">数值越大→召回上限更高，但也会更慢。建议先从 2000 开始。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={vectorUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ vectorUseCustomAi: e.target.checked })}
          />
          <span>向量使用单独 API Key/BaseUrl</span>
        </label>
        {!vectorUseCustomAi ? <p className="ndp-setting-hint">当前将使用聊天的 API Key/BaseUrl。</p> : null}
      </div>

      {vectorUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>embeddings BaseUrl</label>
            <input
              className="ndp-input"
              value={vectorAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>embeddings API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={vectorAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiApiKey: e.target.value })}
            />
          </div>
        </>
      ) : null}
        </>
      ) : null}

      {subTab === 'mmVector' ? (
        <>
          <h3>多模态向量（按需）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={mmVectorEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ mmVectorEnabled: e.target.checked })}
              />
              <span>启用多模态向量（图片/视频）</span>
            </label>
            <p className="ndp-setting-hint">建议按需手动开启：服务成本高，不常开时保持关闭即可。</p>
          </div>

          <div className="ndp-setting-item">
            <label>多模态 embeddings 模型</label>
            <input
              className="ndp-input"
              value={mmVectorEmbeddingModel}
              placeholder="例如：qwen3-vl-embedding-8b"
              onChange={(e) => void onSetAutoExtractSettings({ mmVectorEmbeddingModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={mmVectorUseCustomAi}
                onChange={(e) => void onSetAutoExtractSettings({ mmVectorUseCustomAi: e.target.checked })}
              />
              <span>多模态向量使用单独 API Key/BaseUrl</span>
            </label>
            {!mmVectorUseCustomAi ? <p className="ndp-setting-hint">当前将使用聊天的 API Key/BaseUrl。</p> : null}
          </div>

          {mmVectorUseCustomAi ? (
            <>
              <div className="ndp-setting-item">
                <label>多模态 embeddings BaseUrl</label>
                <input
                  className="ndp-input"
                  value={mmVectorAiBaseUrl}
                  placeholder="例如：http://127.0.0.1:8000/v1"
                  onChange={(e) => void onSetAutoExtractSettings({ mmVectorAiBaseUrl: e.target.value })}
                />
              </div>

              <div className="ndp-setting-item">
                <label>多模态 embeddings API Key</label>
                <input
                  className="ndp-input"
                  type="password"
                  value={mmVectorAiApiKey}
                  placeholder="留空则不发送 Authorization"
                  onChange={(e) => void onSetAutoExtractSettings({ mmVectorAiApiKey: e.target.value })}
                />
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {subTab === 'recall' ? <h3>图谱层（M6，可选）</h3> : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={kgEnabled} onChange={(e) => void onSetAutoExtractSettings({ kgEnabled: e.target.checked })} />
          <span>启用 KG（实体/关系）召回</span>
        </label>
        <p className="ndp-setting-hint">开启后会在后台用 LLM 抽取实体/关系，并在召回时用“图谱证据”补命中（仍以低延迟为优先）。</p>
        </div>
      ) : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgIncludeChatMessages}
            onChange={(e) => void onSetAutoExtractSettings({ kgIncludeChatMessages: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>抽取 chat_message（更全但更噪）</span>
        </label>
        </div>
      ) : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ kgUseCustomAi: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>KG 抽取使用单独 API</span>
        </label>
        </div>
      ) : null}

      {subTab === 'recall' && kgEnabled && kgUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>KG BaseUrl</label>
            <input
              className="ndp-input"
              value={kgAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={kgAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ kgAiApiKey: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG 模型</label>
            <input
              className="ndp-input"
              value={kgAiModel}
              placeholder="例如：gpt-4o-mini"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={kgAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiTemperature: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG MaxTokens</label>
            <input
              className="ndp-input"
              type="number"
              min={200}
              max={8000}
              value={kgAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </>
      ) : null}

      {subTab === 'memory' ? (
        <>
          <h3>自动提炼</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractEnabled}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractEnabled: e.target.checked })}
          />
          <span>对话超过阈值自动提炼（写入长期记忆）</span>
        </label>
        <p className="ndp-setting-hint">
          计数采用“有效消息”：会把连续的助手分句（例如 TTS 分句产生的多条助手消息）合并为 1 条来计算，避免过于频繁提炼。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>每新增多少条有效消息触发一次</label>
        <input
          className="ndp-input"
          type="number"
          min={2}
          max={2000}
          value={autoExtractEveryEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractEveryEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>提炼窗口：最多取最近多少条有效消息</label>
        <input
          className="ndp-input"
          type="number"
          min={10}
          max={2000}
          value={autoExtractMaxEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractMaxEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>自动提炼最小间隔（秒）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={3600}
          value={Math.round(autoExtractCooldownMs / 1000)}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractCooldownMs: Number(e.target.value) * 1000 })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractUseCustomAi: e.target.checked })}
          />
          <span>自动提炼使用单独的 LLM 配置（不影响聊天主模型）</span>
        </label>
      </div>

      {autoExtractUseCustomAi && (
        <div className="ndp-setting-item">
          <label>自动提炼 LLM 配置</label>
          <div className="ndp-setting-hint">留空表示继承聊天主模型对应字段。</div>
          <div className="ndp-setting-item">
            <label>Base URL</label>
            <input
              className="ndp-input"
              placeholder="例如：https://api.openai.com/v1"
              value={autoExtractAiBaseUrl}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiBaseUrl: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>API Key</label>
            <input
              className="ndp-input"
              type="password"
              placeholder="留空则继承聊天主模型"
              value={autoExtractAiApiKey}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiApiKey: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Model</label>
            <input
              className="ndp-input"
              placeholder="例如：gpt-4o-mini"
              value={autoExtractAiModel}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiModel: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={autoExtractAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiTemperature: Number(e.target.value) })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Max Tokens</label>
            <input
              className="ndp-input"
              type="number"
              min={128}
              max={64000}
              step={128}
              value={autoExtractAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

          <div className="ndp-setting-item">
            <label>当前角色：写入 / 召回</label>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureEnabled ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureEnabled: e.target.checked })}
                />
                <span>允许写入该角色的长期记忆</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureUser ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureUser: e.target.checked })}
                />
                <span>记录用户消息</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureAssistant ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureAssistant: e.target.checked })}
                />
                <span>记录 AI 消息</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.retrieveEnabled ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { retrieveEnabled: e.target.checked })}
                />
                <span>允许该角色参与召回注入</span>
              </label>
            </div>
          </div>
        </>
      ) : null}

      {subTab === 'manage' ? (
        <>
          <h3>记忆管理</h3>

          <div className="ndp-setting-item">
            <label>手动添加</label>
            <div className="ndp-row">
              <select className="ndp-select" value={memNewScope} onChange={(e) => setMemNewScope(e.target.value as 'persona' | 'shared')}>
                <option value="persona">当前角色</option>
                <option value="shared">共享</option>
              </select>
              <button className="ndp-btn" onClick={() => void onAddManualMemory()} disabled={!memNewText.trim()}>
                添加
              </button>
            </div>
            <textarea
              className="ndp-textarea ndp-textarea-compact"
              rows={3}
              value={memNewText}
              placeholder="写一条手动记忆（例如：长期设定、重要事实、约束）"
              onChange={(e) => setMemNewText(e.target.value)}
            />
          </div>

          <div className="ndp-setting-item">
            <label>筛选</label>
            <div className="ndp-row">
              <select
                className="ndp-select"
                value={memScope}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'persona' || v === 'shared' || v === 'all') setMemScope(v)
                  setMemOffset(0)
                }}
              >
                <option value="persona">当前角色</option>
                <option value="shared">共享</option>
                <option value="all">当前角色 + 共享</option>
              </select>
              <select
                className="ndp-select"
                value={memRole}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'all' || v === 'user' || v === 'assistant' || v === 'note') setMemRole(v)
                  setMemOffset(0)
                }}
              >
                <option value="all">全部</option>
                <option value="user">用户</option>
                <option value="assistant">AI</option>
                <option value="note">笔记</option>
              </select>
            </div>
            <div className="ndp-row" style={{ marginTop: 10 }}>
              <input className="ndp-input" value={memQuery} placeholder="关键词（LIKE）" onChange={(e) => setMemQuery(e.target.value)} />
              <button
                className="ndp-btn"
                onClick={() => {
                  setMemOffset(0)
                  void refreshMemoryList()
                }}
              >
                搜索
              </button>
            </div>
            <p className="ndp-setting-hint">共 {memTotal} 条</p>
          </div>

          <div className="ndp-setting-item">
            <label>列表</label>
            <div className="ndp-memory-list">
              {memItems.length === 0 && <div className="ndp-setting-hint">暂无记录</div>}
              {memItems.map((m) => (
                <div key={m.rowid} className="ndp-memory-item">
                  <div className="ndp-memory-meta">
                    <span>#{m.rowid}</span>
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                    <span>{m.scope}</span>
                    <span>{m.role ?? 'note'}</span>
                    <span>{m.kind}</span>
                  </div>
                  <div className="ndp-memory-content">{m.content}</div>
                  <div className="ndp-memory-actions">
                    <button className="ndp-btn" onClick={() => void onDeleteMemory(m.rowid)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="ndp-row" style={{ marginTop: 10 }}>
              <button className="ndp-btn" disabled={memOffset === 0} onClick={() => setMemOffset((o) => Math.max(0, o - 50))}>
                上一页
              </button>
              <button className="ndp-btn" disabled={memOffset + 50 >= memTotal} onClick={() => setMemOffset((o) => o + 50)}>
                下一页
              </button>
              <button className="ndp-btn" onClick={() => void refreshMemoryList()}>
                刷新
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

// Live2D Settings Tab Component
function Live2DSettingsTab(props: {
  api: ReturnType<typeof getApi>
  petScale: number
  petOpacity: number
  live2dModelId: string
  live2dMouseTrackingEnabled: boolean
  live2dIdleSwayEnabled: boolean
  availableModels: Live2DModelInfo[]
  selectedModelInfo: Live2DModelInfo | null
  isLoadingModels: boolean
  refreshModels: (opts?: { force?: boolean }) => Promise<void>
}) {
  const {
    api,
    petScale,
    petOpacity,
    live2dModelId,
    live2dMouseTrackingEnabled,
    live2dIdleSwayEnabled,
    availableModels,
    selectedModelInfo,
    isLoadingModels,
    refreshModels,
  } = props
  const triggerRefresh = useCallback(() => {
    void refreshModels()
  }, [refreshModels])

  return (
    <div className="ndp-settings-section">
      <h3>Live2D 模型设置</h3>

      {/* Model Selection */}
      <div className="ndp-setting-item">
        <label>选择模型</label>
        <select
          className="ndp-select"
          value={live2dModelId}
          onMouseDown={triggerRefresh}
          onFocus={triggerRefresh}
          onChange={(e) => {
            const selectedModel = availableModels.find((m) => m.id === e.target.value)
            if (selectedModel) {
              api?.setLive2dModel(selectedModel.id, selectedModel.modelFile)
            }
          }}
          disabled={isLoadingModels}
        >
          {isLoadingModels ? (
            <option value="">扫描模型中...</option>
          ) : availableModels.length === 0 ? (
            <option value="">未找到模型</option>
          ) : (
            availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))
          )}
        </select>
        <p className="ndp-setting-hint">
          {isLoadingModels ? '正在扫描 live2d 目录...' : `共 ${availableModels.length} 个模型可用`}
        </p>
      </div>

      {/* Model Info */}
      {selectedModelInfo && (
        <div className="ndp-model-info">
          <p className="ndp-model-path">
            路径: <code>{selectedModelInfo.modelFile}</code>
          </p>
          <div className="ndp-model-features">
            {selectedModelInfo.hasPhysics && <span className="ndp-feature-tag">物理</span>}
            {selectedModelInfo.hasPose && <span className="ndp-feature-tag">姿势</span>}
            {selectedModelInfo.expressions && selectedModelInfo.expressions.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.expressions.length} 表情</span>
            )}
            {selectedModelInfo.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.motionGroups.length} 动作组</span>
            )}
          </div>
        </div>
      )}

      {/* Expression Test */}
      {selectedModelInfo?.expressions && selectedModelInfo.expressions.length > 0 && (
        <div className="ndp-setting-item">
          <label>表情测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.expressions.map((exp) => (
              <button
                key={exp.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerExpression(exp.name)}
              >
                {exp.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Motion Test */}
      {selectedModelInfo?.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
        <div className="ndp-setting-item">
          <label>动作测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.motionGroups.map((group) => (
              <button
                key={group.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerMotion(group.name, 0)}
              >
                {group.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={live2dMouseTrackingEnabled}
            onChange={(e) => api?.setLive2dMouseTrackingEnabled(e.target.checked)}
          />
          <span>鼠标跟随</span>
        </label>
        <p className="ndp-setting-hint">开启后模型会跟随鼠标方向。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={live2dIdleSwayEnabled}
            onChange={(e) => api?.setLive2dIdleSwayEnabled(e.target.checked)}
          />
          <span>物理摇摆</span>
        </label>
        <p className="ndp-setting-hint">关闭后禁用待机摇摆，模型姿态更稳定。</p>
      </div>

      <div className="ndp-setting-item">
        <label>模型大小</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="5"
            step="0.1"
            value={petScale}
            onChange={(e) => api?.setPetScale(parseFloat(e.target.value))}
          />
          <span>{petScale.toFixed(1)}x</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的显示大小（高分辨率模型可能需要更大的值）</p>
      </div>

      <div className="ndp-setting-item">
        <label>模型透明度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.3"
            max="1.0"
            step="0.1"
            value={petOpacity}
            onChange={(e) => api?.setPetOpacity(parseFloat(e.target.value))}
          />
          <span>{Math.round(petOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的透明度</p>
      </div>
    </div>
  )
}

// Bubble Settings Tab Component
function BubbleSettingsTab(props: {
  api: ReturnType<typeof getApi>
  bubbleSettings: AppSettings['bubble'] | undefined
}) {
  const { api, bubbleSettings } = props
  const [phrasesText, setPhrasesText] = useState('')

  const style = bubbleSettings?.style ?? 'cute'
  const positionX = bubbleSettings?.positionX ?? 75
  const positionY = bubbleSettings?.positionY ?? 10
  const tailDirection = bubbleSettings?.tailDirection ?? 'down'
  const showOnClick = bubbleSettings?.showOnClick ?? true
  const showOnChat = bubbleSettings?.showOnChat ?? true
  const autoHideDelay = bubbleSettings?.autoHideDelay ?? 5000
  const clickPhrases = bubbleSettings?.clickPhrases ?? []
  const clickPhrasesText = clickPhrases.join('\n')
  const contextOrbEnabled = bubbleSettings?.contextOrbEnabled ?? false
  const contextOrbX = bubbleSettings?.contextOrbX ?? 12
  const contextOrbY = bubbleSettings?.contextOrbY ?? 16

  // Sync phrases text with settings
  useEffect(() => {
    setPhrasesText(clickPhrasesText)
  }, [clickPhrasesText])

  const styleOptions: { value: BubbleStyle; label: string; desc: string }[] = [
    { value: 'cute', label: '可爱粉', desc: '粉色渐变，带爱心装饰' },
    { value: 'pixel', label: '像素风', desc: '复古像素游戏风格' },
    { value: 'minimal', label: '简约白', desc: '简洁现代风格' },
    { value: 'cloud', label: '云朵蓝', desc: '蓝色云朵造型' },
  ]

  const tailOptions: { value: TailDirection; label: string; icon: string }[] = [
    { value: 'up', label: '上', icon: '↑' },
    { value: 'down', label: '下', icon: '↓' },
    { value: 'left', label: '左', icon: '←' },
    { value: 'right', label: '右', icon: '→' },
  ]

  const handlePhrasesChange = (text: string) => {
    setPhrasesText(text)
  }

  const handlePhrasesSave = () => {
    const phrases = phrasesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    api?.setBubbleSettings({ clickPhrases: phrases })
  }

  return (
    <div className="ndp-settings-section">
      <h3>气泡样式</h3>

      {/* Style Selection */}
      <div className="ndp-setting-item">
        <label>气泡风格</label>
        <div className="ndp-style-grid">
          {styleOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-style-btn ${style === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ style: opt.value })}
            >
              <span className="ndp-style-label">{opt.label}</span>
              <span className="ndp-style-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Position X */}
      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionX}
            onChange={(e) => api?.setBubbleSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      {/* Position Y */}
      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionY}
            onChange={(e) => api?.setBubbleSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>

      {/* Tail Direction */}
      <div className="ndp-setting-item">
        <label>尾巴方向</label>
        <div className="ndp-tail-grid">
          {tailOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-tail-btn ${tailDirection === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ tailDirection: opt.value })}
            >
              <span className="ndp-tail-icon">{opt.icon}</span>
              <span className="ndp-tail-label">{opt.label}</span>
            </button>
          ))}
        </div>
        <p className="ndp-setting-hint">气泡尾巴指向的方向</p>
      </div>

      <h3>显示设置</h3>

      {/* Show on Click */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnClick}
            onChange={(e) => api?.setBubbleSettings({ showOnClick: e.target.checked })}
          />
          <span>点击宠物时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">点击桌宠时随机显示可爱的台词</p>
      </div>

      {/* Show on Chat */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnChat}
            onChange={(e) => api?.setBubbleSettings({ showOnChat: e.target.checked })}
          />
          <span>AI 回复时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">AI 回复消息时在桌宠旁边显示气泡</p>
      </div>

      {/* Auto Hide Delay */}
      <div className="ndp-setting-item">
        <label>自动隐藏延迟</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="15000"
            step="1000"
            value={autoHideDelay}
            onChange={(e) => api?.setBubbleSettings({ autoHideDelay: parseInt(e.target.value) })}
          />
          <span>{autoHideDelay === 0 ? '手动关闭' : `${autoHideDelay / 1000}秒`}</span>
        </div>
        <p className="ndp-setting-hint">气泡显示后自动消失的时间，0 表示需要手动关闭</p>
      </div>

      <h3>上下文情况</h3>
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={contextOrbEnabled}
            onChange={(e) => api?.setBubbleSettings({ contextOrbEnabled: e.target.checked })}
          />
          <span>显示上下文小球</span>
        </label>
        <p className="ndp-setting-hint">在桌宠窗口显示一个可拖动的小球，鼠标悬停可查看上下文占用。</p>
        <div className="ndp-setting-actions">
          <button
            className="ndp-btn"
            onClick={() => api?.setBubbleSettings({ contextOrbX: 12, contextOrbY: 16 })}
            disabled={!contextOrbEnabled}
            title="重置到默认位置"
          >
            重置位置
          </button>
          <span className="ndp-setting-hint" style={{ marginLeft: 10 }}>
            当前位置：{Math.round(contextOrbX)}% / {Math.round(contextOrbY)}%
          </span>
        </div>
      </div>

      <h3>自定义台词</h3>

      {/* Custom Click Phrases */}
      <div className="ndp-setting-item">
        <label>点击台词</label>
        <textarea
          className="ndp-textarea"
          value={phrasesText}
          placeholder="每行一句台词..."
          rows={6}
          onChange={(e) => handlePhrasesChange(e.target.value)}
          onBlur={handlePhrasesSave}
        />
        <p className="ndp-setting-hint">每行一句，点击桌宠时随机显示（共 {clickPhrases.length} 句）</p>
      </div>
    </div>
  )
}

function TaskPanelSettingsTab(props: {
  api: ReturnType<typeof getApi>
  taskPanelSettings: AppSettings['taskPanel'] | undefined
}) {
  const { api, taskPanelSettings } = props
  const positionX = taskPanelSettings?.positionX ?? 50
  const positionY = taskPanelSettings?.positionY ?? 78

  return (
    <div className="ndp-settings-section">
      <h3>任务面板</h3>
      <p className="ndp-setting-hint">仅在有任务进行中时出现，用于查看进度与暂停/终止。</p>

      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionX}
            onChange={(e) => api?.setTaskPanelSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionY}
            onChange={(e) => api?.setTaskPanelSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>
    </div>
  )
}

// Chat UI Settings Tab Component
function ChatUiSettingsTab(props: { api: ReturnType<typeof getApi>; chatUi: AppSettings['chatUi'] | undefined }) {
  const { api, chatUi } = props

  const background = chatUi?.background ?? 'rgba(20, 20, 24, 0.45)'
  const userBubbleBackground = chatUi?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)'
  const assistantBubbleBackground = chatUi?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)'
  const bubbleRadius = chatUi?.bubbleRadius ?? 14
  const backgroundImage = chatUi?.backgroundImage ?? ''
  const backgroundImageOpacity = chatUi?.backgroundImageOpacity ?? 0.6
  const contextOrbEnabled = chatUi?.contextOrbEnabled ?? false
  const contextOrbX = chatUi?.contextOrbX ?? 6
  const contextOrbY = chatUi?.contextOrbY ?? 14
  const backgroundImageInputRef = useRef<HTMLInputElement>(null)

  const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))
  const clampFloat = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const parseRgba = (
    value: string,
    fallback: { r: number; g: number; b: number; a: number },
  ): { r: number; g: number; b: number; a: number } => {
    const m = value
      .trim()
      .match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i)
    if (!m) return fallback
    const r = clampInt(parseInt(m[1] || '0'), 0, 255)
    const g = clampInt(parseInt(m[2] || '0'), 0, 255)
    const b = clampInt(parseInt(m[3] || '0'), 0, 255)
    const a = clampFloat(m[4] == null ? 1 : parseFloat(m[4]), 0, 1)
    return { r, g, b, a }
  }

  const toRgba = (rgba: { r: number; g: number; b: number; a: number }) =>
    `rgba(${clampInt(rgba.r, 0, 255)}, ${clampInt(rgba.g, 0, 255)}, ${clampInt(rgba.b, 0, 255)}, ${clampFloat(
      rgba.a,
      0,
      1,
    ).toFixed(2)})`

  const renderRgbaEditor = (opts: {
    label: string
    value: string
    onChange: (next: string) => void
  }) => {
    const rgba = parseRgba(opts.value, { r: 20, g: 20, b: 24, a: 0.45 })

    const set = (next: Partial<typeof rgba>) => {
      const safe: Partial<typeof rgba> = {}
      if (typeof next.r === 'number' && Number.isFinite(next.r)) safe.r = next.r
      if (typeof next.g === 'number' && Number.isFinite(next.g)) safe.g = next.g
      if (typeof next.b === 'number' && Number.isFinite(next.b)) safe.b = next.b
      if (typeof next.a === 'number' && Number.isFinite(next.a)) safe.a = next.a

      const merged = { ...rgba, ...safe }
      opts.onChange(toRgba(merged))
    }

    return (
      <div className="ndp-setting-item">
        <label>{opts.label}</label>
        <div className="ndp-rgba-editor">
          <div className="ndp-rgba-preview" style={{ background: opts.value }} />

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">R</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">G</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">B</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">A</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
    )
  }

  const readBackgroundFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 5 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => api?.setChatUiSettings({ backgroundImage: String(reader.result || '') })
    reader.readAsDataURL(file)
  }

  return (
    <div className="ndp-settings-section">
      <h3>聊天界面美化</h3>
      <p className="ndp-setting-hint">头像在聊天窗口中点击头像即可更换（不在设置里）。</p>

      {renderRgbaEditor({
        label: '聊天背景 RGBA',
        value: background,
        onChange: (next) => api?.setChatUiSettings({ background: next }),
      })}

      <div className="ndp-setting-item">
        <label>背景图片</label>
        <div className="ndp-bgimg-row">
          <div className="ndp-bgimg-preview">{backgroundImage ? <img src={backgroundImage} alt="bg" /> : <span>无</span>}</div>
          <div className="ndp-bgimg-actions">
            <button className="ndp-btn" onClick={() => backgroundImageInputRef.current?.click()}>
              选择图片
            </button>
            <button
              className="ndp-btn"
              onClick={() => api?.setChatUiSettings({ backgroundImage: '' })}
              disabled={!backgroundImage}
            >
              清除
            </button>
          </div>
        </div>
        <input
          ref={backgroundImageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            readBackgroundFile(file)
            e.currentTarget.value = ''
          }}
        />
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={backgroundImageOpacity}
            onChange={(e) => api?.setChatUiSettings({ backgroundImageOpacity: parseFloat(e.target.value) })}
          />
          <span>{Math.round(backgroundImageOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">拖动调整背景图片透明度（建议图片小于 5MB）</p>
      </div>

      {renderRgbaEditor({
        label: '用户气泡 RGBA',
        value: userBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ userBubbleBackground: next }),
      })}

      {renderRgbaEditor({
        label: '助手气泡 RGBA',
        value: assistantBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ assistantBubbleBackground: next }),
      })}

      <div className="ndp-setting-item">
        <label>气泡圆角</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="6"
            max="24"
            step="1"
            value={bubbleRadius}
            onChange={(e) => api?.setChatUiSettings({ bubbleRadius: parseInt(e.target.value) })}
          />
          <span>{bubbleRadius}px</span>
        </div>
      </div>

      <h3>上下文情况</h3>
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={contextOrbEnabled}
            onChange={(e) => api?.setChatUiSettings({ contextOrbEnabled: e.target.checked })}
          />
          <span>显示上下文小球</span>
        </label>
        <p className="ndp-setting-hint">在聊天窗口显示一个可拖动的小球，鼠标悬停可查看上下文占用。</p>
        <div className="ndp-setting-actions">
          <button
            className="ndp-btn"
            onClick={() => api?.setChatUiSettings({ contextOrbX: 6, contextOrbY: 14 })}
            disabled={!contextOrbEnabled}
            title="重置到默认位置"
          >
            重置位置
          </button>
          <span className="ndp-setting-hint" style={{ marginLeft: 10 }}>
            当前位置：{Math.round(contextOrbX)}% / {Math.round(contextOrbY)}%
          </span>
        </div>
      </div>
    </div>
  )
}

function TtsSettingsTab(props: { api: ReturnType<typeof getApi>; ttsSettings: AppSettings['tts'] | undefined }) {
  const { api, ttsSettings } = props

  const enabled = ttsSettings?.enabled ?? false
  const gptWeightsPath = ttsSettings?.gptWeightsPath ?? 'GPT_SoVITS/pretrained_models/s1v3.ckpt'
  const sovitsWeightsPath = ttsSettings?.sovitsWeightsPath ?? 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'
  const speedFactor = ttsSettings?.speedFactor ?? 1.0
  const refAudioPath = ttsSettings?.refAudioPath ?? ''
  const promptText = ttsSettings?.promptText ?? ''
  const streaming = ttsSettings?.streaming ?? true
  const segmented = ttsSettings?.segmented ?? false
  const pauseMs = Math.max(0, Math.min(60000, ttsSettings?.pauseMs ?? 280))

  const [options, setOptions] = useState<
    | {
        gptModels: Array<{ label: string; weightsPath: string }>
        sovitsModels: Array<{ label: string; weightsPath: string }>
        refAudios: Array<{ label: string; value: string; promptText: string }>
        ttsRoot: string
      }
    | null
  >(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const lastOptionsRefreshAtRef = useRef(0)

  const refreshOptions = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!api) return
      const now = Date.now()
      if (!opts?.force && now - lastOptionsRefreshAtRef.current < 800) return
      lastOptionsRefreshAtRef.current = now

      setOptionsError(null)
      try {
        const data = await api.listTtsOptions()
        setOptions(data)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setOptionsError(msg)
      }
    },
    [api],
  )

  useEffect(() => {
    void refreshOptions({ force: true })
  }, [refreshOptions])

  const onSelectRefAudio = (value: string) => {
    const selected = options?.refAudios?.find((x) => x.value === value)
    api?.setTtsSettings({
      refAudioPath: value,
      promptText: selected?.promptText ?? promptText,
    })
  }

  return (
    <div className="ndp-settings-section">
      <h3>TTS 语音</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setTtsSettings({ enabled: e.target.checked })} />
          <span>启用 TTS（助手消息自动播报）</span>
        </label>
        <p className="ndp-setting-hint">需要先启动 `GPT-SoVITS-v2_ProPlus` 的 API 服务（默认: http://127.0.0.1:9880）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>GPT 模型</label>
        <select
          className="ndp-select"
          value={gptWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ gptWeightsPath: e.target.value })}
        >
          {(options?.gptModels?.length ?? 0) > 0 ? (
            options!.gptModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={gptWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>SoVITS 模型</label>
        <select
          className="ndp-select"
          value={sovitsWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ sovitsWeightsPath: e.target.value })}
        >
          {(options?.sovitsModels?.length ?? 0) > 0 ? (
            options!.sovitsModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={sovitsWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
        <p className="ndp-setting-hint">默认“直接推底模”只需要设置参考音频即可。</p>
      </div>

      <div className="ndp-setting-item">
        <label>语速</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={speedFactor}
            onChange={(e) => api?.setTtsSettings({ speedFactor: parseFloat(e.target.value) })}
          />
          <span>{speedFactor.toFixed(2)}x</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频</label>
        <select
          className="ndp-select"
          value={refAudioPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => onSelectRefAudio(e.target.value)}
        >
          <option value="">请选择（从 `参考音频` 目录扫描）</option>
          {(options?.refAudios ?? []).map((a) => (
            <option key={a.value} value={a.value} title={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="ndp-setting-hint">下拉框仅显示文件名里 `[]` 内的内容（例如角色名）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频文本（自动从文件名解析，可编辑）</label>
        <textarea
          className="ndp-textarea"
          value={promptText}
          rows={3}
          placeholder="例如：该做的事都做完了么？好，别睡下了才想起来日常没做，拜拜。"
          onChange={(e) => api?.setTtsSettings({ promptText: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={streaming} onChange={(e) => api?.setTtsSettings({ streaming: e.target.checked })} />
          <span>流式处理（边生成边播放）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={segmented} onChange={(e) => api?.setTtsSettings({ segmented: e.target.checked })} />
          <span>分句同步显示（TTS 念一句，聊天/气泡显示一句）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label>分句停顿（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="60000"
            step="20"
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0}
            max={60000}
            step={20}
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value || '0') })}
          />
        </div>
      </div>

      {options?.ttsRoot ? <p className="ndp-setting-hint">扫描目录: {options.ttsRoot}</p> : null}
      {optionsError ? <p className="ndp-setting-hint">扫描失败: {optionsError}</p> : null}
    </div>
  )
}

function AsrSettingsTab(props: { api: ReturnType<typeof getApi>; asrSettings: AppSettings['asr'] | undefined }) {
  const { api, asrSettings } = props

  const enabled = asrSettings?.enabled ?? false
  const wsUrl = asrSettings?.wsUrl ?? 'ws://127.0.0.1:8766/ws'
  const micDeviceId = asrSettings?.micDeviceId ?? ''
  const captureBackend = (asrSettings?.captureBackend ?? 'script') as 'auto' | 'script' | 'worklet'
  const language = asrSettings?.language ?? 'auto'
  const useItn = asrSettings?.useItn ?? true
  const autoSend = asrSettings?.autoSend ?? false
  const mode = (asrSettings?.mode ?? 'continuous') as 'continuous' | 'hotkey'
  const hotkey = asrSettings?.hotkey ?? 'F8'
  const showSubtitle = asrSettings?.showSubtitle ?? true

  const vadChunkMs = Math.max(40, Math.min(800, asrSettings?.vadChunkMs ?? 200))
  const maxEndSilenceMs = Math.max(80, Math.min(4000, asrSettings?.maxEndSilenceMs ?? 800))
  const minSpeechMs = Math.max(0, Math.min(5000, asrSettings?.minSpeechMs ?? 600))
  const maxSpeechMs = Math.max(800, Math.min(60000, asrSettings?.maxSpeechMs ?? 15000))
  const prerollMs = Math.max(0, Math.min(2000, asrSettings?.prerollMs ?? 120))
  const postrollMs = Math.max(0, Math.min(2000, asrSettings?.postrollMs ?? 80))

  const enableAgc = asrSettings?.enableAgc ?? true
  const agcTargetRms = Math.max(0.005, Math.min(0.2, asrSettings?.agcTargetRms ?? 0.05))
  const agcMaxGain = Math.max(1, Math.min(80, asrSettings?.agcMaxGain ?? 20))
  const debug = asrSettings?.debug ?? false

  const applyInt = (value: string, fallback: number) => {
    const n = parseInt(value || '', 10)
    return Number.isFinite(n) ? n : fallback
  }

  const applyFloat = (value: string, fallback: number) => {
    const n = parseFloat(value || '')
    return Number.isFinite(n) ? n : fallback
  }

  const [micDevices, setMicDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const [micLoading, setMicLoading] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const refreshMicDevices = useCallback(async () => {
    setMicLoading(true)
    setMicError(null)

    try {
      if (!navigator.mediaDevices) {
        setMicDevices([])
        setMicError('当前环境不支持枚举音频设备')
        return
      }

      // 先请求一次权限，否则 device.label 可能为空，且部分环境 enumerateDevices 不完整
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `麦克风（${d.deviceId.slice(0, 6)}…）` }))
        setMicDevices(mics)
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMicDevices([])
      setMicError(msg)
    } finally {
      setMicLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshMicDevices()
  }, [refreshMicDevices])

  return (
    <div className="ndp-settings-section">
      <h3>语音识别（ASR）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setAsrSettings({ enabled: e.target.checked })} />
          <span>启用语音识别（麦克风转文字）</span>
        </label>
        <p className="ndp-setting-hint">
          需要先启动本地 ASR 服务端（推荐：WebSocket 实时音频流 + FSMN-VAD 断句 + SenseVoiceSmall 转写）。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>WebSocket 地址</label>
        <input type="text" className="ndp-input" value={wsUrl} onChange={(e) => api?.setAsrSettings({ wsUrl: e.target.value })} />
        <p className="ndp-setting-hint">示例：ws://127.0.0.1:8766/ws（默认端口 8766）</p>
      </div>

      <div className="ndp-setting-item">
        <label>采集方式</label>
        <select
          className="ndp-select"
          value={captureBackend}
          onChange={(e) => api?.setAsrSettings({ captureBackend: e.target.value as AppSettings['asr']['captureBackend'] })}
        >
          <option value="script">ScriptProcessor（更稳定，推荐）</option>
          <option value="worklet">AudioWorklet（更低延迟）</option>
          <option value="auto">自动（优先 worklet）</option>
        </select>
        <p className="ndp-setting-hint">如果识别结果出现大量“🎼”等富文本标记或明显异常，优先切到 ScriptProcessor</p>
      </div>

      <div className="ndp-setting-item">
        <label>选择麦克风</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            className="ndp-select"
            style={{ flex: 1 }}
            value={micDeviceId}
            onMouseDown={() => refreshMicDevices()}
            onFocus={() => refreshMicDevices()}
            onChange={(e) => api?.setAsrSettings({ micDeviceId: e.target.value })}
          >
            <option value="">系统默认</option>
            {micDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} title={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ndp-btn" onClick={() => refreshMicDevices()} disabled={micLoading} type="button">
            {micLoading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <p className="ndp-setting-hint">
          如果下拉框为空或无法选择，先点一次“刷新”并允许麦克风权限；设备名称只有在授权后才会显示
        </p>
        {micError ? <p className="ndp-setting-hint">刷新失败：{micError}</p> : null}
      </div>

      <div className="ndp-setting-item">
        <label>识别语言</label>
        <select className="ndp-select" value={language} onChange={(e) => api?.setAsrSettings({ language: e.target.value as AppSettings['asr']['language'] })}>
          <option value="auto">自动 (auto)</option>
          <option value="zn">中文 (zn)</option>
          <option value="yue">粤语 (yue)</option>
          <option value="en">英文 (en)</option>
          <option value="ja">日文 (ja)</option>
          <option value="ko">韩文 (ko)</option>
          <option value="nospeech">无语音 (nospeech)</option>
        </select>
        <p className="ndp-setting-hint">建议默认 auto；如果混识别，可固定为 zn/en 等</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={useItn} onChange={(e) => api?.setAsrSettings({ useItn: e.target.checked })} />
          <span>标点/ITN（更像输入法）</span>
        </label>
        <p className="ndp-setting-hint">开启后会自动补标点、数字等格式化，通常更可读</p>
      </div>

      <h3>启动方式</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="radio" name="asrMode" checked={mode === 'continuous'} onChange={() => api?.setAsrSettings({ mode: 'continuous' })} />
          <span>持续录音（无需按键）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input type="radio" name="asrMode" checked={mode === 'hotkey'} onChange={() => api?.setAsrSettings({ mode: 'hotkey' })} />
          <span>按键录音（按一下开始，再按一下结束）</span>
        </label>

        {mode === 'hotkey' && (
          <div style={{ marginTop: 10 }}>
            <label>录音快捷键</label>
            <input type="text" className="ndp-input" value={hotkey} onChange={(e) => api?.setAsrSettings({ hotkey: e.target.value })} />
            <p className="ndp-setting-hint">示例：F8 / Ctrl+Alt+V / A（全局快捷键，可能和系统/软件冲突）</p>
          </div>
        )}
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={showSubtitle} onChange={(e) => api?.setAsrSettings({ showSubtitle: e.target.checked })} />
          <span>桌宠窗口显示识别字幕</span>
        </label>
        <p className="ndp-setting-hint">字幕显示在桌宠（Live2D）左侧，用于确认识别到的文本。</p>
      </div>

      <h3>识别结果处理</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="radio" name="asrSendMode" checked={autoSend} onChange={() => api?.setAsrSettings({ autoSend: true })} />
          <span>直接发送（识别完自动发给 LLM）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="radio"
            name="asrSendMode"
            checked={!autoSend}
            onChange={() => api?.setAsrSettings({ autoSend: false })}
          />
          <span>仅在输入框（识别完只填入输入框，手动发送）</span>
        </label>
        <p className="ndp-setting-hint">开启“直接发送”后，会把每次端点结束的一段识别结果作为一条用户消息发送</p>
      </div>

      <h3>端点检测（VAD）</h3>

      <div className="ndp-setting-item">
        <label>VAD 分块大小（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="40"
            max="500"
            step="10"
            value={vadChunkMs}
            onChange={(e) => api?.setAsrSettings({ vadChunkMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={40}
            max={500}
            step={10}
            value={vadChunkMs}
            onChange={(e) => api?.setAsrSettings({ vadChunkMs: applyInt(e.target.value, vadChunkMs) })}
          />
        </div>
        <p className="ndp-setting-hint">越小越低延迟，但 CPU 开销更高；建议 160-240ms</p>
      </div>

      <div className="ndp-setting-item">
        <label>尾部静音判停（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="200"
            max="2000"
            step="20"
            value={maxEndSilenceMs}
            onChange={(e) => api?.setAsrSettings({ maxEndSilenceMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={80}
            max={4000}
            step={20}
            value={maxEndSilenceMs}
            onChange={(e) => api?.setAsrSettings({ maxEndSilenceMs: applyInt(e.target.value, maxEndSilenceMs) })}
          />
        </div>
        <p className="ndp-setting-hint">过低易截断，过高会“停得慢”；普通说话建议 600-1000ms</p>
      </div>

      <div className="ndp-setting-item">
        <label>最短语音段（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="2000"
            step="20"
            value={minSpeechMs}
            onChange={(e) => api?.setAsrSettings({ minSpeechMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0}
            max={5000}
            step={20}
            value={minSpeechMs}
            onChange={(e) => api?.setAsrSettings({ minSpeechMs: applyInt(e.target.value, minSpeechMs) })}
          />
        </div>
        <p className="ndp-setting-hint">用于过滤短噪声（键盘、鼠标、喷麦）；太大可能漏掉短词</p>
      </div>

      <div className="ndp-setting-item">
        <label>最长语音段（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="2000"
            max="30000"
            step="200"
            value={maxSpeechMs}
            onChange={(e) => api?.setAsrSettings({ maxSpeechMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={800}
            max={60000}
            step={200}
            value={maxSpeechMs}
            onChange={(e) => api?.setAsrSettings({ maxSpeechMs: applyInt(e.target.value, maxSpeechMs) })}
          />
        </div>
        <p className="ndp-setting-hint">超长句会强制切分，避免一直不出结果；建议 10-20 秒</p>
      </div>

      <div className="ndp-setting-item">
        <label>起点预留 / 终点补偿（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            value={prerollMs}
            onChange={(e) => api?.setAsrSettings({ prerollMs: parseInt(e.target.value) })}
          />
          <span>起点 {prerollMs}ms</span>
        </div>
        <div className="ndp-range-input" style={{ marginTop: 8 }}>
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            value={postrollMs}
            onChange={(e) => api?.setAsrSettings({ postrollMs: parseInt(e.target.value) })}
          />
          <span>终点 {postrollMs}ms</span>
        </div>
        <p className="ndp-setting-hint">防止吞掉开头/结尾的辅音；太大可能把环境音也带进去</p>
      </div>

      <h3>音量处理</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enableAgc} onChange={(e) => api?.setAsrSettings({ enableAgc: e.target.checked })} />
          <span>自动增益（AGC）</span>
        </label>
        <p className="ndp-setting-hint">当麦克风声音太小时自动放大，提升识别稳定性；如果容易爆音/喷麦可关闭</p>
      </div>

      <div className="ndp-setting-item">
        <label>AGC 目标 RMS / 最大增益</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.01"
            max="0.12"
            step="0.005"
            value={agcTargetRms}
            onChange={(e) => api?.setAsrSettings({ agcTargetRms: parseFloat(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0.005}
            max={0.2}
            step={0.005}
            value={agcTargetRms}
            onChange={(e) => api?.setAsrSettings({ agcTargetRms: applyFloat(e.target.value, agcTargetRms) })}
          />
        </div>
        <div className="ndp-range-input" style={{ marginTop: 8 }}>
          <input
            type="range"
            min="1"
            max="40"
            step="1"
            value={agcMaxGain}
            onChange={(e) => api?.setAsrSettings({ agcMaxGain: parseInt(e.target.value) })}
          />
          <span>{agcMaxGain}x</span>
        </div>
        <p className="ndp-setting-hint">目标 RMS 建议 0.03-0.08；最大增益建议 10-30x</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={debug} onChange={(e) => api?.setAsrSettings({ debug: e.target.checked })} />
          <span>调试日志</span>
        </label>
        <p className="ndp-setting-hint">开启后服务端/前端会输出更多处理信息，便于定位断句与识别问题</p>
      </div>
    </div>
  )
}

// AI Settings Tab Component
function AISettingsTab(props: {
  api: ReturnType<typeof getApi>
  aiSettings: AppSettings['ai'] | undefined
  orchestrator: AppSettings['orchestrator'] | undefined
  aiProfiles: AppSettings['aiProfiles'] | undefined
  activeAiProfileId: string | undefined
}) {
  const { api, aiSettings, orchestrator, aiProfiles, activeAiProfileId } = props

  const apiKey = aiSettings?.apiKey ?? ''
  const baseUrl = aiSettings?.baseUrl ?? 'https://api.openai.com/v1'
  const model = aiSettings?.model ?? 'gpt-4o-mini'
  const temperature = aiSettings?.temperature ?? 0.7
  const maxTokens = aiSettings?.maxTokens ?? 64000
  const maxContextTokens = aiSettings?.maxContextTokens ?? 128000
  const thinkingEffort = aiSettings?.thinkingEffort ?? 'disabled'
  const systemPrompt = aiSettings?.systemPrompt ?? ''
  const enableVision = aiSettings?.enableVision ?? false
  const enableChatStreaming = aiSettings?.enableChatStreaming ?? false

  const profiles = Array.isArray(aiProfiles) ? aiProfiles : []
  const activeProfile = profiles.find((p) => p.id === (activeAiProfileId ?? '')) ?? null
  const [profileName, setProfileName] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')

  useEffect(() => {
    setProfileName(activeProfile?.name ?? '')
  }, [activeProfile?.id, activeProfile?.name])

  const saveApiProfile = async (opts?: { overwrite?: boolean }) => {
    if (!api) return
    const overwrite = opts?.overwrite ?? false
    const id = overwrite ? activeProfile?.id : undefined
    const fallbackName = `${baseUrl || '接口'} ${model || ''}`.trim() || '新配置'
    const name = profileName.trim() || fallbackName
    await api.saveAIProfile({ id, name, apiKey, baseUrl, model })
  }

  const deleteApiProfile = async () => {
    if (!api || !activeProfile?.id) return
    await api.deleteAIProfile(activeProfile.id)
  }

  const applyApiProfile = async (id: string) => {
    if (!api || !id) return
    await api.applyAIProfile(id)
  }

  const fetchModelList = async () => {
    if (!api) return
    setModelsLoading(true)
    setModelsError('')
    try {
      const res = await api.listAIModels({ apiKey, baseUrl })
      if (!res.ok) {
        setModelOptions([])
        setModelsError(res.error || '拉取模型列表失败')
        return
      }
      const incoming = Array.isArray(res.models) ? res.models : []
      const merged = Array.from(new Set([model, ...incoming].map((x) => String(x ?? '').trim()).filter(Boolean)))
      setModelOptions(merged)
      setModelsError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setModelOptions([])
      setModelsError(msg || '拉取模型列表失败')
    } finally {
      setModelsLoading(false)
    }
  }

  const toolMode = orchestrator?.toolCallingMode ?? 'auto'
  const toolUseCustomAi = orchestrator?.toolUseCustomAi ?? false
  const toolAiApiKey = orchestrator?.toolAiApiKey ?? ''
  const toolAiBaseUrl = orchestrator?.toolAiBaseUrl ?? ''
  const toolAiModel = orchestrator?.toolAiModel ?? ''
  const toolAiTemperature = orchestrator?.toolAiTemperature ?? 0.2
  const toolAiMaxTokens = orchestrator?.toolAiMaxTokens ?? 900
  const toolAiTimeoutMs = orchestrator?.toolAiTimeoutMs ?? 60000
  const toolAgentMaxTurns = orchestrator?.toolAgentMaxTurns ?? 8

  // Format large numbers for display
  const formatTokens = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}K`
    return String(n)
  }

  return (
    <div className="ndp-settings-section">
      <h3>API 设置</h3>

      <div className="ndp-setting-item">
        <label>已保存的 API 配置</label>
        <div className="ndp-row">
          <select className="ndp-select" value={activeAiProfileId ?? ''} onChange={(e) => void applyApiProfile(e.target.value)}>
            <option value="">（无）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ndp-setting-actions">
          <input
            type="text"
            className="ndp-input"
            value={profileName}
            placeholder="配置名称"
            onChange={(e) => setProfileName(e.target.value)}
          />
          <button className="ndp-btn" onClick={() => void saveApiProfile()}>
            保存新配置
          </button>
          <button className="ndp-btn" disabled={!activeProfile?.id} onClick={() => void saveApiProfile({ overwrite: true })}>
            覆盖当前配置
          </button>
          <button className="ndp-btn ndp-btn-danger" disabled={!activeProfile?.id} onClick={() => void deleteApiProfile()}>
            删除配置
          </button>
        </div>
        <p className="ndp-setting-hint">可在多个 API 之间快速切换，不需要重复输入 Key / Base URL / 模型。</p>
      </div>

      {/* API Key */}
      <div className="ndp-setting-item">
        <label>API Key</label>
        <input
          type="password"
          className="ndp-input"
          value={apiKey}
          placeholder="sk-..."
          onChange={(e) => api?.setAISettings({ apiKey: e.target.value })}
        />
        <p className="ndp-setting-hint">支持 OpenAI 兼容的 API</p>
      </div>

      {/* Base URL */}
      <div className="ndp-setting-item">
        <label>API Base URL</label>
        <input
          type="text"
          className="ndp-input"
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => api?.setAISettings({ baseUrl: e.target.value })}
        />
        <p className="ndp-setting-hint">可配置代理或其他兼容 API 地址</p>
      </div>

      {/* Model */}
      <div className="ndp-setting-item">
        <label>模型名称</label>
        <input
          type="text"
          className="ndp-input"
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(e) => api?.setAISettings({ model: e.target.value })}
        />
        <div className="ndp-setting-actions">
          <button className="ndp-btn" onClick={() => void fetchModelList()} disabled={modelsLoading}>
            {modelsLoading ? '加载中...' : '拉取模型列表'}
          </button>
          {modelOptions.length > 0 ? (
            <select className="ndp-select" value={model} onChange={(e) => api?.setAISettings({ model: e.target.value })}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {modelsError ? <p className="ndp-setting-hint">{modelsError}</p> : null}
        <p className="ndp-setting-hint">可手动输入模型 ID，也可以先拉取后选择。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableVision}
            onChange={(e) => api?.setAISettings({ enableVision: e.target.checked })}
          />
          <span>启用识图能力（发送图片）</span>
        </label>
        <p className="ndp-setting-hint">部分模型不支持图片输入，关闭后聊天窗口将禁用“图片”按钮</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableChatStreaming}
            onChange={(e) => api?.setAISettings({ enableChatStreaming: e.target.checked })}
          />
          <span>聊天流式生成（逐步输出）</span>
        </label>
        <p className="ndp-setting-hint">开启后会以 SSE 方式逐步生成文本；若同时开启 TTS 分句同步，会按句子分段出现</p>
      </div>

      <h3>生成设置</h3>

      <div className="ndp-setting-item">
        <label>思考强度</label>
        <select
          className="ndp-select"
          value={thinkingEffort}
          onChange={(e) => api?.setAISettings({ thinkingEffort: e.target.value as AIThinkingEffort })}
        >
          <option value="disabled">禁用（disabled）</option>
          <option value="low">低（low）</option>
          <option value="medium">中（medium）</option>
          <option value="high">高（high）</option>
        </select>
        <p className="ndp-setting-hint">
          Claude 会映射为 thinking(type=enabled/budget_tokens)，OpenAI 推理模型会映射为 reasoning_effort。
        </p>
      </div>

      {/* Temperature */}
      <div className="ndp-setting-item">
        <label>温度 (Temperature)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => api?.setAISettings({ temperature: parseFloat(e.target.value) })}
          />
          <span>{temperature.toFixed(1)}</span>
        </div>
        <p className="ndp-setting-hint">较低值更确定，较高值更有创意</p>
      </div>

      {/* Max Tokens */}
      <div className="ndp-setting-item">
        <label>最大回复长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="1000"
            max="128000"
            step="1000"
            value={maxTokens}
            onChange={(e) => api?.setAISettings({ maxTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxTokens)}</span>
        </div>
        <p className="ndp-setting-hint">AI 单次回复的最大 token 数量</p>
      </div>

      {/* Max Context Tokens */}
      <div className="ndp-setting-item">
        <label>最大上下文长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="4000"
            max="1000000"
            step="4000"
            value={maxContextTokens}
            onChange={(e) => api?.setAISettings({ maxContextTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxContextTokens)}</span>
        </div>
        <p className="ndp-setting-hint">对话历史的最大 token 数量</p>
      </div>

      <h3>工具(Agent) 设置</h3>

      <div className="ndp-setting-item">
        <label>工具执行模式</label>
        <select
          className="ndp-select"
          value={toolMode}
          onChange={(e) => api?.setOrchestratorSettings({ toolCallingMode: e.target.value as 'auto' | 'native' | 'text' })}
        >
          <option value="auto">auto（优先原生tools，失败降级文本协议）</option>
          <option value="native">native（强制原生 tools/tool_calls）</option>
          <option value="text">text（强制文本协议 TOOL_REQUEST，最稳）</option>
        </select>
        <p className="ndp-setting-hint">
          Gemini/部分代理的 OpenAI-compat 原生 tools 可能要求 thought_signature，容易出错；选 text 可绕开此类兼容坑。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>Agent 最大回合数 (maxTurns)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            value={toolAgentMaxTurns}
            onChange={(e) => api?.setOrchestratorSettings({ toolAgentMaxTurns: parseInt(e.target.value) })}
          />
          <span>{toolAgentMaxTurns}</span>
        </div>
        <p className="ndp-setting-hint">命中“已达到最大回合”时可调大；建议 6~12，过大会更慢且更耗工具调用。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={toolUseCustomAi}
            onChange={(e) => api?.setOrchestratorSettings({ toolUseCustomAi: e.target.checked })}
          />
          <span>工具/Agent 使用单独的 API</span>
        </label>
        <p className="ndp-setting-hint">开启后，工具任务会优先使用下面的 API 配置；否则沿用上面的“API 设置”。</p>
      </div>

      {toolUseCustomAi && (
        <>
          <div className="ndp-setting-item">
            <label>工具 API Key</label>
            <input
              type="password"
              className="ndp-input"
              value={toolAiApiKey}
              placeholder="(可留空，沿用主 API Key)"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiApiKey: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>工具 API Base URL</label>
            <input
              type="text"
              className="ndp-input"
              value={toolAiBaseUrl}
              placeholder="例如 https://generativelanguage.googleapis.com/v1beta/openai/"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiBaseUrl: e.target.value })}
            />
            <p className="ndp-setting-hint">
              Gemini 官方 OpenAI 兼容基址：<code>https://generativelanguage.googleapis.com/v1beta/openai/</code>
            </p>
          </div>

          <div className="ndp-setting-item">
            <label>工具模型名称</label>
            <input
              type="text"
              className="ndp-input"
              value={toolAiModel}
              placeholder="例如 gemini-2.5-flash / gpt-4o-mini"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>工具温度 (Temperature)</label>
            <div className="ndp-range-input">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={toolAiTemperature}
                onChange={(e) => api?.setOrchestratorSettings({ toolAiTemperature: parseFloat(e.target.value) })}
              />
              <span>{toolAiTemperature.toFixed(1)}</span>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>工具最大输出 (maxTokens)</label>
            <div className="ndp-range-input">
              <input
                type="range"
                min="128"
                max="8192"
                step="64"
                value={toolAiMaxTokens}
                onChange={(e) => api?.setOrchestratorSettings({ toolAiMaxTokens: parseInt(e.target.value) })}
              />
              <span>{toolAiMaxTokens}</span>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>工具超时 (ms)</label>
            <input
              type="number"
              className="ndp-input"
              value={toolAiTimeoutMs}
              min={2000}
              max={180000}
              step={500}
              onChange={(e) => api?.setOrchestratorSettings({ toolAiTimeoutMs: parseInt(e.target.value) })}
            />
          </div>
        </>
      )}

      {/* System Prompt */}
      <div className="ndp-setting-item">
        <label>系统提示词</label>
        <textarea
          className="ndp-textarea"
          value={systemPrompt}
          placeholder="在这里填写桌宠的人设（system prompt）"
          rows={4}
          onChange={(e) => api?.setAISettings({ systemPrompt: e.target.value })}
        />
        <p className="ndp-setting-hint">定义 AI 的角色和行为</p>
      </div>
    </div>
  )
}
