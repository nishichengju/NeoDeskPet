import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { getSettings } from './store'
import { executeBuiltinTool, type ToolInput } from './toolExecutor'
import {
  filterToolDefinitionsBySettings,
  getDefaultAgentToolDefinitions,
  isToolEnabled,
  toOpenAITools,
  type OpenAIFunctionToolSpec,
  type ToolDefinition,
} from './toolRegistry'
import type { McpManager } from './mcpManager'
import type { TaskCreateArgs, TaskListResult, TaskRecord, TaskStepRecord, TaskStatus } from './types'

type TaskStoreState = {
  version: 1
  tasks: TaskRecord[]
}

type TaskRuntime = {
  paused: boolean
  canceled: boolean
  waiters: Array<() => void>
  cancelCurrent?: () => void
}

const MAX_TASKS = 200
const MAX_STEP_INPUT_CHARS = 8000
const MAX_STEP_OUTPUT_CHARS = 5000
const LIVE2D_TAG_MAX_LIST = { expressions: 20, motions: 10 }

type Live2dTagExtracted = { cleanedText: string; expression?: string; motion?: string }
type Live2dModelTagHints = { expressions: string[]; motions: string[] }

const live2dTagHintsCache = new Map<string, Live2dModelTagHints>()

function extractLive2dTags(text: string): Live2dTagExtracted {
  const raw = String(text ?? '')
  if (!raw.trim()) return { cleanedText: raw.trim() }

  let expression: string | undefined
  let motion: string | undefined
  let cleaned = raw

  const expRe = /\[表情[：:]\s*([^\]]+)\]/u
  const motionRe = /\[动作[：:]\s*([^\]]+)\]/u

  const expMatch = cleaned.match(expRe)
  if (expMatch?.[1]) {
    expression = expMatch[1].trim()
    cleaned = cleaned.replace(/\[表情[：:]\s*[^\]]+\]/gu, '')
  }

  const motionMatch = cleaned.match(motionRe)
  if (motionMatch?.[1]) {
    motion = motionMatch[1].trim()
    cleaned = cleaned.replace(/\[动作[：:]\s*[^\]]+\]/gu, '')
  }

  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleanedText: cleaned, expression, motion }
}

function getLive2dDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'live2d')
  }
  return path.join(app.getAppPath(), 'public', 'live2d')
}

function readLive2dTagHintsFromModelFile(modelFileUrl: string): Live2dModelTagHints {
  const raw = String(modelFileUrl ?? '').trim()
  if (!raw) return { expressions: [], motions: [] }
  if (live2dTagHintsCache.has(raw)) return live2dTagHintsCache.get(raw)!

  try {
    const normalized = raw.replace(/\\/g, '/')
    const idx = normalized.indexOf('/live2d/')
    if (idx < 0) return { expressions: [], motions: [] }
    const rel = normalized.slice(idx + '/live2d/'.length).replace(/^\/+/, '')
    if (!rel) return { expressions: [], motions: [] }

    const filePath = path.join(getLive2dDir(), rel)
    if (!fs.existsSync(filePath)) return { expressions: [], motions: [] }
    const jsonText = fs.readFileSync(filePath, 'utf-8')
    const modelJson = JSON.parse(jsonText) as Record<string, unknown>
    const fileRefs = (modelJson?.FileReferences ?? {}) as Record<string, unknown>

    const expressionsRaw = (fileRefs?.Expressions ?? null) as unknown
    const expressions =
      Array.isArray(expressionsRaw)
        ? expressionsRaw
            .map((e) => (e && typeof e === 'object' ? String((e as Record<string, unknown>).Name ?? '').trim() : ''))
            .filter(Boolean)
        : []

    const motionsRaw = (fileRefs?.Motions ?? null) as unknown
    const motions =
      motionsRaw && typeof motionsRaw === 'object' && !Array.isArray(motionsRaw)
        ? Object.keys(motionsRaw as Record<string, unknown>).map((k) => String(k).trim()).filter(Boolean)
        : []

    const hints = {
      expressions: expressions.slice(0, 200),
      motions: motions.slice(0, 200),
    }
    live2dTagHintsCache.set(raw, hints)
    return hints
  } catch {
    return { expressions: [], motions: [] }
  }
}

function buildLive2dTagSystemAddon(hints: Live2dModelTagHints): string {
  const exps = (hints.expressions ?? []).slice(0, LIVE2D_TAG_MAX_LIST.expressions)
  const motions = (hints.motions ?? []).slice(0, LIVE2D_TAG_MAX_LIST.motions)
  if (exps.length === 0 && motions.length === 0) return ''

  const lines: string[] = []
  if (exps.length) {
    lines.push(
      `【表情系统】可用表情：${exps.join('、')}\n` +
        `请在你每次输出自然语言文本的末尾都附加 1 个表情标签（包括调用工具前的前置话术、以及拿到工具结果后的收尾话术），格式：[表情:表情名]。` +
        `注意：表情标签只放在自然语言文本的末尾，不要放进工具参数/JSON 里。`,
    )
  }
  if (motions.length) {
    lines.push(
      `【动作系统】可用动作组：${motions.join('、')}\n` +
        `如需触发动作，可在自然语言文本末尾附加 1 个动作标签，格式：[动作:动作组名]。` +
        `注意：动作标签只放在自然语言文本的末尾，不要放进工具参数/JSON 里。`,
    )
  }
  return lines.join('\n\n')
}

function now(): number {
  return Date.now()
}

function clampText(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.max(min, Math.min(max, i))
}

function normalizeTaskRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<TaskRecord>
  if (typeof v.id !== 'string' || !v.id.trim()) return null
  if (typeof v.title !== 'string' || !v.title.trim()) return null
  const status = v.status
  const allowedStatus: TaskStatus[] = ['pending', 'running', 'paused', 'failed', 'done', 'canceled']
  if (!allowedStatus.includes(status as TaskStatus)) return null

  const steps = Array.isArray(v.steps) ? (v.steps as TaskStepRecord[]) : []
  const safeSteps = steps
    .filter((s) => s && typeof s === 'object' && typeof (s as TaskStepRecord).title === 'string')
    .slice(0, 120)
      .map((s) => ({
        id: typeof s.id === 'string' && s.id.trim() ? s.id : randomUUID(),
        title: clampText(s.title, 80),
        status: (s.status ?? 'pending') as TaskStepRecord['status'],
        tool: typeof s.tool === 'string' ? clampText(s.tool, 80) : undefined,
        input: typeof s.input === 'string' ? clampText(s.input, MAX_STEP_INPUT_CHARS) : undefined,
        output: typeof s.output === 'string' ? clampText(s.output, 1200) : undefined,
        error: typeof s.error === 'string' ? clampText(s.error, 1200) : undefined,
        startedAt: typeof s.startedAt === 'number' ? s.startedAt : undefined,
        endedAt: typeof s.endedAt === 'number' ? s.endedAt : undefined,
    }))

  const toolsUsed = Array.isArray(v.toolsUsed) ? v.toolsUsed.filter((x) => typeof x === 'string').slice(0, 80) : []
  const finalReply = typeof v.finalReply === 'string' ? clampText(v.finalReply, 12000) : undefined
  const draftReply = typeof v.draftReply === 'string' ? clampText(v.draftReply, 12000) : undefined
  const live2dExpression = typeof v.live2dExpression === 'string' ? clampText(v.live2dExpression, 80) : undefined
  const live2dMotion = typeof v.live2dMotion === 'string' ? clampText(v.live2dMotion, 80) : undefined

  const toolRuns = Array.isArray(v.toolRuns)
    ? (v.toolRuns as Array<Record<string, unknown>>)
        .filter((x) => x && typeof x === 'object')
        .slice(0, 80)
        .map((r, idx) => ({
          id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `run_${idx}`,
          toolName: typeof r.toolName === 'string' ? clampText(r.toolName, 80) : '',
          status: (r.status === 'running' || r.status === 'done' || r.status === 'error' ? r.status : 'done') as
            | 'running'
            | 'done'
            | 'error',
          inputPreview: typeof r.inputPreview === 'string' ? clampText(r.inputPreview, 500) : undefined,
          outputPreview: typeof r.outputPreview === 'string' ? clampText(r.outputPreview, 800) : undefined,
          error: typeof r.error === 'string' ? clampText(r.error, 800) : undefined,
          startedAt: typeof r.startedAt === 'number' ? r.startedAt : now(),
          endedAt: typeof r.endedAt === 'number' ? r.endedAt : undefined,
        }))
        .filter((r) => r.toolName.trim().length > 0)
    : undefined

  return {
    id: v.id,
    queue: (v.queue ?? 'other') as TaskRecord['queue'],
    title: clampText(v.title, 120),
    why: typeof v.why === 'string' ? clampText(v.why, 240) : '',
    status: status as TaskStatus,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : now(),
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : undefined,
    endedAt: typeof v.endedAt === 'number' ? v.endedAt : undefined,
    steps: safeSteps,
    currentStepIndex: typeof v.currentStepIndex === 'number' ? Math.max(0, Math.trunc(v.currentStepIndex)) : 0,
    toolsUsed,
    finalReply,
    draftReply,
    live2dExpression,
    live2dMotion,
    toolRuns,
    lastError: typeof v.lastError === 'string' ? clampText(v.lastError, 1600) : undefined,
  }
}

function normalizeState(state: TaskStoreState | undefined): TaskStoreState {
  const s = state ?? ({ version: 1, tasks: [] } as TaskStoreState)
  const rawTasks = Array.isArray(s.tasks) ? s.tasks : []
  const tasks = rawTasks.map(normalizeTaskRecord).filter(Boolean) as TaskRecord[]

  const next: TaskStoreState = { version: 1, tasks: tasks.slice(0, MAX_TASKS) }
  return next
}

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function parseToolInput(input: string | undefined): ToolInput {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as ToolInput
    } catch {
      return raw
    }
  }
  return raw
}

function resolveTemplateString(template: string, task: TaskRecord): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_m, exprRaw: string) => {
    const expr = String(exprRaw || '').trim()
    if (!expr) return ''

    if (expr === 'task.id') return task.id
    if (expr === 'task.title') return task.title
    if (expr === 'task.why') return task.why
    if (expr === 'task.queue') return task.queue
    if (expr === 'task.status') return task.status

    const stepMatch = expr.match(/^steps\[(\d+)\]\.(output|input|title)$/)
    if (stepMatch) {
      const idx = Number(stepMatch[1])
      const key = stepMatch[2] as 'output' | 'input' | 'title'
      const s = task.steps[idx]
      if (!s) return ''
      const v = (s as Record<string, unknown>)[key]
      return typeof v === 'string' ? v : ''
    }

    return ''
  })
}

function resolveTemplates(value: ToolInput, task: TaskRecord): ToolInput {
  if (typeof value === 'string') return resolveTemplateString(value, task)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v as ToolInput, task))

  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveTemplates(v as ToolInput, task)
  }
  return out as ToolInput
}

function clampStepOutput(text: string): string {
  return clampText(text, MAX_STEP_OUTPUT_CHARS)
}

export class TaskService {
  private readonly store: Store<TaskStoreState>
  private readonly runtime = new Map<string, TaskRuntime>()
  private readonly onChanged: () => void
  private readonly userDataDir: string
  private readonly mcpManager: McpManager | null
  private schedulerTimer: NodeJS.Timeout | null = null

  constructor(opts: { onChanged: () => void; userDataDir: string; mcpManager?: McpManager | null }) {
    this.store = new Store<TaskStoreState>({
      name: 'neodeskpet-tasks',
      defaults: { version: 1, tasks: [] },
    })
    this.onChanged = opts.onChanged
    this.userDataDir = opts.userDataDir
    this.mcpManager = opts.mcpManager ?? null

    // 如果上次异常退出，pending/running/paused 状态会悬挂；这里统一标记为 failed（便于用户看见原因）
    this.writeState((draft) => {
      const ts = now()
      for (const t of draft.tasks) {
        const prev = t.status
        if (prev === 'pending' || prev === 'running' || prev === 'paused') {
          t.status = 'failed'
          t.updatedAt = ts
          t.endedAt = ts
          t.lastError =
            t.lastError ||
            (prev === 'pending'
              ? '任务在上次运行时尚未开始（应用被重启/崩溃）'
              : '任务在上次运行时中断（应用被重启/崩溃）')
        }
      }
    })
  }

  listTasks(): TaskListResult {
    const state = normalizeState(this.store.store)
    const items = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    return { items }
  }

  getTask(id: string): TaskRecord | null {
    const tid = (id ?? '').trim()
    if (!tid) return null
    const state = normalizeState(this.store.store)
    return state.tasks.find((t) => t.id === tid) ?? null
  }

  createTask(args: TaskCreateArgs): TaskRecord {
    const title = clampText(args.title, 120)
    if (!title) throw new Error('任务标题不能为空')

    const id = randomUUID()
    const ts = now()
    const stepsInput = Array.isArray(args.steps) ? args.steps : []
    const steps: TaskStepRecord[] =
      stepsInput.length > 0
        ? stepsInput.slice(0, 20).map((s) => ({
            id: randomUUID(),
            title: clampText(s.title, 80),
            status: 'pending',
            tool: typeof s.tool === 'string' ? clampText(s.tool, 80) : undefined,
            input: typeof s.input === 'string' ? clampText(s.input, MAX_STEP_INPUT_CHARS) : undefined,
          }))
        : [
            { id: randomUUID(), title: '准备', status: 'pending' },
            { id: randomUUID(), title: '执行', status: 'pending' },
            { id: randomUUID(), title: '收尾', status: 'pending' },
          ]

    const record: TaskRecord = {
      id,
      queue: args.queue ?? 'other',
      title,
      why: typeof args.why === 'string' ? clampText(args.why, 240) : '',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      steps,
      currentStepIndex: 0,
      toolsUsed: [],
    }

    this.writeState((draft) => {
      draft.tasks.unshift(record)
      draft.tasks = draft.tasks.slice(0, MAX_TASKS)
    })

    this.kickScheduler()
    return record
  }

  pauseTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status !== 'running') return t
    const rt = this.ensureRuntime(t.id)
    rt.paused = true
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'paused'
      it.updatedAt = now()
    })
    return this.getTask(t.id)
  }

  resumeTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status !== 'paused') return t
    const rt = this.ensureRuntime(t.id)
    rt.paused = false
    for (const w of rt.waiters.splice(0)) w()
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'running'
      it.updatedAt = now()
    })
    this.kickScheduler()
    return this.getTask(t.id)
  }

  cancelTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') return t

    const rt = this.ensureRuntime(t.id)
    rt.canceled = true
    rt.paused = false
    try {
      rt.cancelCurrent?.()
    } catch {
      // ignore
    }
    for (const w of rt.waiters.splice(0)) w()

    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'canceled'
      it.updatedAt = now()
      it.endedAt = now()
    })

    return this.getTask(t.id)
  }

  // 仅用于 UI 清理：从任务列表中移除（不会影响已完成输出的文件等副作用）
  dismissTask(id: string): { ok: true } | null {
    const t = this.getTask(id)
    if (!t) return null

    this.runtime.delete(t.id)
    this.writeState((draft) => {
      draft.tasks = draft.tasks.filter((x) => x.id !== t.id)
    })

    return { ok: true }
  }

  // =====================
  // Internal runner logic
  // =====================

  private ensureRuntime(id: string): TaskRuntime {
    const existing = this.runtime.get(id)
    if (existing) return existing
    const rt: TaskRuntime = { paused: false, canceled: false, waiters: [] }
    this.runtime.set(id, rt)
    return rt
  }

  private kickScheduler(): void {
    if (this.schedulerTimer) return
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null
      this.runScheduler()
    }, 30)
  }

  private runScheduler(): void {
    const state = normalizeState(this.store.store)
    const running = state.tasks.filter((t) => t.status === 'running').length
    const capacity = Math.max(0, 3 - running)
    if (capacity <= 0) return

    const pending = state.tasks.filter((t) => t.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
    const toStart = pending.slice(0, capacity)
    for (const task of toStart) {
      this.startTask(task.id)
    }
  }

  private startTask(id: string): void {
    const t = this.getTask(id)
    if (!t) return
    if (t.status !== 'pending') return

    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === id)
      if (!it) return
      it.status = 'running'
      it.startedAt = it.startedAt ?? now()
      it.updatedAt = now()
    })

    void this.runTask(id)
  }

  private async waitIfPaused(id: string): Promise<void> {
    const rt = this.ensureRuntime(id)
    if (!rt.paused) return
    await new Promise<void>((resolve) => {
      rt.waiters.push(resolve)
    })
  }

  private async executeToolByName(toolName: string, input: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    const settings = getSettings()
    if (!isToolEnabled(toolName, settings.tools)) {
      throw new Error(`tool disabled: ${toolName}`)
    }

    if (toolName.startsWith('mcp.')) {
      if (!this.mcpManager) throw new Error('MCP manager not initialized')
      return this.mcpManager.callTool(toolName, input)
    }

    return executeBuiltinTool(
      toolName,
      input,
      {
        task,
        userDataDir: this.userDataDir,
        waitIfPaused: () => this.waitIfPaused(task.id),
        isCanceled: () => rt.canceled,
        setCancelCurrent: (fn) => {
          rt.cancelCurrent = fn
        },
      },
      { maxStepOutputChars: MAX_STEP_OUTPUT_CHARS },
    )
  }

  private async runTool(tool: string | undefined, input: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    const toolName = typeof tool === 'string' ? tool.trim() : ''
    const resolved = resolveTemplates(input, task)

    if (!toolName) {
      // 没有工具：作为“备注/占位 step”，直接通过
      await sleep(60)
      return '跳过（无 tool）'
    }

    if (toolName === 'agent.run') {
      return this.runAgentRunTool(resolved, task, rt)
    }

    return this.executeToolByName(toolName, resolved, task, rt)
  }

  private async runAgentRunTool(resolved: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
    const request = typeof obj?.request === 'string' ? obj.request : typeof resolved === 'string' ? resolved : ''

    if (!request.trim()) throw new Error('agent.run 需要 request 文本')

    const settings = getSettings()
    const orch = settings.orchestrator
    const configuredMaxTurns = clampInt(orch?.toolAgentMaxTurns, 8, 1, 30)
    const maxTurns = clampInt(obj?.maxTurns, configuredMaxTurns, 1, configuredMaxTurns)

    const normalizeMode = (v: unknown): 'auto' | 'native' | 'text' | null => {
      const s = typeof v === 'string' ? v.trim() : ''
      if (!s) return null
      if (s === 'auto' || s === 'native' || s === 'text') return s
      return null
    }

    // 注意：由于 gcli2api 等代理不支持在 tool_use 上添加 thoughtSignature，
    // 对于思考模型（如 claude-sonnet-4-5-thinking）使用 native 模式会导致上游 API 报错。
    // 因此默认使用 'text' 模式，通过 VCP 文本协议调用工具，更稳定可靠。
    const modeRaw = normalizeMode(obj?.mode) ?? normalizeMode(orch?.toolCallingMode) ?? 'text'
    // auto：默认走 text（VCP 文本协议），避免不同 OpenAI-compat/代理对原生 tools 的兼容差异导致割裂与报错
    const mode: 'auto' | 'native' | 'text' = modeRaw

    // 桌宠“人设/语气”只允许来自 AI 设置里的 systemPrompt；agent.run 不允许覆盖 system（避免多处人设割裂）
    const system = typeof settings.ai.systemPrompt === 'string' ? settings.ai.systemPrompt.trim() : ''
    const extraContext = typeof obj?.context === 'string' ? obj.context.trim() : ''

    type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
    type RawToolCall = Record<string, unknown>

    type AssistantMessage = Record<string, unknown> & {
      role?: string
      content?: unknown
      tool_calls?: unknown
      function_call?: unknown
    }

    const builtinDefs = getDefaultAgentToolDefinitions()
    const mcpDefs = this.mcpManager?.getToolDefinitions() ?? []
    const toolDefs = filterToolDefinitionsBySettings([...builtinDefs, ...mcpDefs], settings.tools)
    const tools: OpenAIFunctionToolSpec[] = toOpenAITools(toolDefs)

    const toolByName = new Map<string, ToolDefinition>()
    const toolByCallName = new Map<string, ToolDefinition>()
    for (const d of toolDefs) {
      toolByName.set(d.name, d)
      toolByCallName.set(d.callName, d)
    }

    const resolveToolDefByCallName = (callNameRaw: string): ToolDefinition | null => {
      const needle = (callNameRaw ?? '').trim()
      if (!needle) return null

      const exact = toolByCallName.get(needle) ?? null
      if (exact) return exact

      // Gemini(OpenAI-compat) 可能会返回类似 "default_api:ndp_xxx" 的前缀
      if (needle.includes(':')) {
        const tail = needle.split(':').pop()?.trim() ?? ''
        if (tail && tail !== needle) return toolByCallName.get(tail) ?? null
      }

      return toolByName.get(needle) ?? null
    }

    const messages: Array<Record<string, unknown>> = []
    if (system) messages.push({ role: 'system', content: system })
    if (extraContext) messages.push({ role: 'system', content: extraContext })

    // Live2D：让 agent.run 的输出也能像普通对话一样，通过 [表情:...] / [动作:...] 标签驱动模型表现
    // - 标签不会显示在对话正文（后续会被清洗掉）
    // - 表情/动作列表从当前 Live2D 模型文件解析，避免硬编码
    const live2dHints = readLive2dTagHintsFromModelFile(String(settings.live2dModelFile ?? ''))
    const live2dAddon = buildLive2dTagSystemAddon(live2dHints)
    if (live2dAddon) messages.push({ role: 'system', content: live2dAddon })
    messages.push({
      role: 'system',
      content:
        '重要：工具输出是事实来源。严禁编造/猜测工具执行结果。若工具输出为空、乱码或无法解析，必须明确说明失败，并优先重试或改用更稳的命令（例如 PowerShell 加 -NoProfile）。最终回复不要出现工具内部名（如 cli.exec/browser.open/mcp.*）；需要链接/日期等事实时，只能引用工具输出或用户提供。',
    })
    messages.push({ role: 'user', content: request })

    const logs: string[] = []
    let lastProgressAt = 0
    let draftReply = ''
    let live2dExpression: string | undefined
    let live2dMotion: string | undefined
    let toolRuns: TaskRecord['toolRuns'] = []

    // 初始化一次：避免复用上次残留的 draft/toolRuns
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === task.id)
      if (!it) return
      it.draftReply = ''
      it.finalReply = undefined
      it.live2dExpression = undefined
      it.live2dMotion = undefined
      it.toolRuns = []
      it.updatedAt = now()
    })

    const updateProgress = (force?: boolean) => {
      const nowTs = Date.now()
      if (!force && nowTs - lastProgressAt < 250) return
      lastProgressAt = nowTs
      const text = clampStepOutput(logs.join('\n') || '执行中…')
      this.writeState((draft) => {
        const it = draft.tasks.find((x) => x.id === task.id)
        if (!it) return
        const s = it.steps[it.currentStepIndex]
        if (!s) return
        s.output = text
        it.draftReply = draftReply
        it.live2dExpression = live2dExpression
        it.live2dMotion = live2dMotion
        it.toolRuns = toolRuns
        it.updatedAt = now()
      })
    }

    const pushLog = (line: string, force?: boolean) => {
      logs.push(clampText(line, 800))
      if (logs.length > 120) logs.splice(0, logs.length - 120)
      updateProgress(force)
    }

    const appendDraft = (text: string) => {
      const cleaned = (text ?? '').trim()
      if (!cleaned) return
      const extracted = extractLive2dTags(cleaned)
      if (extracted.expression) live2dExpression = extracted.expression
      if (extracted.motion) live2dMotion = extracted.motion
      const piece = extracted.cleanedText
      // 允许“只输出标签不输出文本”的情况：此时不更新 draftReply，但也要把表情/动作变更落到任务状态里
      if (piece) {
        draftReply = draftReply ? `${draftReply}\n${piece}` : piece
        updateProgress(true)
        return
      }
      if (extracted.expression || extracted.motion) updateProgress(true)
    }

    const toolPreview = (v: unknown, max: number) => clampText(typeof v === 'string' ? v : JSON.stringify(v ?? ''), max)

    const upsertToolRun = (patch: {
      id: string
      toolName: string
      status: 'running' | 'done' | 'error'
      inputPreview?: string
      outputPreview?: string
      error?: string
      startedAt?: number
      endedAt?: number
    }) => {
      const id = patch.id.trim() || randomUUID()
      const existingIdx = (toolRuns ?? []).findIndex((r) => r?.id === id)
      const base = existingIdx >= 0 ? (toolRuns?.[existingIdx] ?? null) : null
      const next = {
        id,
        toolName: patch.toolName,
        status: patch.status,
        inputPreview: patch.inputPreview ?? base?.inputPreview,
        outputPreview: patch.outputPreview ?? base?.outputPreview,
        error: patch.error ?? base?.error,
        startedAt: typeof patch.startedAt === 'number' ? patch.startedAt : base?.startedAt ?? now(),
        endedAt: typeof patch.endedAt === 'number' ? patch.endedAt : base?.endedAt,
      }
      if (existingIdx >= 0) toolRuns = [...toolRuns!.slice(0, existingIdx), next, ...toolRuns!.slice(existingIdx + 1)]
      else toolRuns = [...(toolRuns ?? []), next].slice(0, 80)
      updateProgress(true)
    }

    const baseAi = settings.ai
    const apiOverride =
      obj?.api && typeof obj.api === 'object' && obj.api && !Array.isArray(obj.api) ? (obj.api as Record<string, unknown>) : obj

    const prefer = orch.toolUseCustomAi
      ? {
          apiKey: String(orch.toolAiApiKey ?? '').trim() || String(baseAi.apiKey ?? '').trim(),
          baseUrl: String(orch.toolAiBaseUrl ?? '').trim() || String(baseAi.baseUrl ?? '').trim(),
          model: String(orch.toolAiModel ?? '').trim() || String(baseAi.model ?? '').trim(),
          temperature: typeof orch.toolAiTemperature === 'number' ? orch.toolAiTemperature : baseAi.temperature ?? 0.2,
          maxTokens: typeof orch.toolAiMaxTokens === 'number' ? orch.toolAiMaxTokens : baseAi.maxTokens ?? 900,
          timeoutMs: typeof orch.toolAiTimeoutMs === 'number' ? orch.toolAiTimeoutMs : 60000,
        }
      : {
          apiKey: String(baseAi.apiKey ?? '').trim(),
          baseUrl: String(baseAi.baseUrl ?? '').trim(),
          model: String(baseAi.model ?? '').trim(),
          temperature: typeof baseAi.temperature === 'number' ? baseAi.temperature : 0.2,
          maxTokens: typeof baseAi.maxTokens === 'number' ? baseAi.maxTokens : 900,
          timeoutMs: 60000,
        }

    const readString = (src: Record<string, unknown> | null | undefined, key: string): string => {
      const v = src?.[key]
      return typeof v === 'string' ? v.trim() : ''
    }
    const readNumber = (src: Record<string, unknown> | null | undefined, key: string): number | null => {
      const v = src?.[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }

    const baseUrl = readString(apiOverride, 'baseUrl') || prefer.baseUrl || ''
    const apiKey = readString(apiOverride, 'apiKey') || prefer.apiKey || ''
    const model = readString(apiOverride, 'model') || prefer.model || ''

    const tempOverride = readNumber(apiOverride, 'temperature')
    const temperature = Math.max(0, Math.min(2, tempOverride ?? prefer.temperature))

    const maxTokensOverride = readNumber(apiOverride, 'maxTokens')
    const maxTokens = Math.max(64, Math.min(8192, Math.trunc(maxTokensOverride ?? prefer.maxTokens)))
    const timeoutMs =
      typeof obj?.timeoutMs === 'number'
        ? Math.max(2000, Math.min(180000, Math.trunc(obj.timeoutMs)))
        : Math.max(2000, Math.min(180000, Math.trunc(prefer.timeoutMs)))

    if (!baseUrl || !model) throw new Error('未配置工具 LLM baseUrl/model（设置 → AI 设置 → 工具/Agent 或 AI 设置）')

    const join = (b: string, p: string) => `${b.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`
    const endpoint = join(baseUrl, 'chat/completions')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    // 使用任务ID作为sessionId，让API代理可以缓存和复用签名
    const sessionId = task.id

    const callLlmNative = async (): Promise<{ contentText: string; toolCalls: ToolCall[]; rawToolCalls: RawToolCall[]; assistantMsgRaw: AssistantMessage }> => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs)
      rt.cancelCurrent = () => ac.abort(new Error('canceled'))

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: ac.signal,
          headers,
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages,
            tools,
            tool_choice: 'auto',
            sessionId,
          }),
        })

        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: Array<{ message?: AssistantMessage }> }
        if (!res.ok) {
          const errMsg = data?.error?.message || `HTTP ${res.status}`
          throw new Error(errMsg)
        }

        const msg = (data.choices?.[0]?.message ?? {}) as AssistantMessage

        const contentText =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((p) => {
                    if (p && typeof p === 'object') {
                      const t = (p as Record<string, unknown>).text
                      if (typeof t === 'string') return t
                    }
                    return ''
                  })
                  .filter(Boolean)
                  .join('\n')
              : ''

        const toolCallsRawUnknown = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : []
        const rawToolCallsFromToolCalls = toolCallsRawUnknown
          .map((c) => (c && typeof c === 'object' && !Array.isArray(c) ? (c as RawToolCall) : null))
          .filter((c): c is RawToolCall => Boolean(c))

        const legacyRawToolCalls: RawToolCall[] = (() => {
          const fc = msg.function_call
          if (!fc || typeof fc !== 'object' || Array.isArray(fc)) return []
          const fcObj = fc as Record<string, unknown>
          const name = typeof fcObj.name === 'string' ? fcObj.name : ''
          const args = typeof fcObj.arguments === 'string' ? fcObj.arguments : fcObj.arguments != null ? JSON.stringify(fcObj.arguments) : ''
          if (!name.trim()) return []
          return [{ id: 'call_legacy', type: 'function', function: { name, arguments: args } }]
        })()

        const rawToolCalls = rawToolCallsFromToolCalls.length ? rawToolCallsFromToolCalls : legacyRawToolCalls

        const ensureToolCallId = (raw: RawToolCall, idx: number): RawToolCall => {
          const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `call_${idx}`
          if (raw.id === id) return raw
          return { ...raw, id }
        }

        const parseToolCall = (rawIn: RawToolCall, idx: number): ToolCall | null => {
          const raw = ensureToolCallId(rawIn, idx)
          const id = typeof raw.id === 'string' ? raw.id : `call_${idx}`

          const fn = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? (raw.function as Record<string, unknown>) : null
          const fnCall =
            (raw as Record<string, unknown>).functionCall &&
            typeof (raw as Record<string, unknown>).functionCall === 'object' &&
            !Array.isArray((raw as Record<string, unknown>).functionCall)
              ? ((raw as Record<string, unknown>).functionCall as Record<string, unknown>)
              : null

          const name =
            (typeof fn?.name === 'string' ? fn.name : '') ||
            (typeof fnCall?.name === 'string' ? fnCall.name : '') ||
            (typeof (raw as Record<string, unknown>).name === 'string' ? ((raw as Record<string, unknown>).name as string) : '')

          const argVal = fn?.arguments ?? fnCall?.args ?? (raw as Record<string, unknown>).arguments
          const argumentsStr =
            typeof argVal === 'string'
              ? argVal
              : argVal != null
                ? (() => {
                    try {
                      return JSON.stringify(argVal)
                    } catch {
                      return ''
                    }
                  })()
                : ''

          if (!name.trim()) return null
          return { id, type: 'function', function: { name, arguments: argumentsStr } }
        }

        const toolCalls: ToolCall[] = rawToolCalls.map((c, idx) => parseToolCall(c, idx)).filter((c): c is ToolCall => Boolean(c))

        const assistantMsgRaw: AssistantMessage = { ...msg, role: typeof msg.role === 'string' ? msg.role : 'assistant' }
        if (rawToolCalls.length) assistantMsgRaw.tool_calls = rawToolCalls.map((c, idx) => ensureToolCallId(c, idx))

        return { contentText, toolCalls, rawToolCalls: rawToolCalls.map((c, idx) => ensureToolCallId(c, idx)), assistantMsgRaw }
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
      }
    }

    const callLlmText = async (): Promise<{ contentText: string; assistantMsgRaw: AssistantMessage }> => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs)
      rt.cancelCurrent = () => ac.abort(new Error('canceled'))

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: ac.signal,
          headers,
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages,
            sessionId,
          }),
        })

        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: Array<{ message?: AssistantMessage }> }
        if (!res.ok) {
          const errMsg = data?.error?.message || `HTTP ${res.status}`
          throw new Error(errMsg)
        }

        const msg = (data.choices?.[0]?.message ?? {}) as AssistantMessage

        const contentText =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((p) => {
                    if (p && typeof p === 'object') {
                      const t = (p as Record<string, unknown>).text
                      if (typeof t === 'string') return t
                    }
                    return ''
                  })
                  .filter(Boolean)
                  .join('\n')
              : ''

        const assistantMsgRaw: AssistantMessage = { ...msg, role: typeof msg.role === 'string' ? msg.role : 'assistant' }
        if (typeof assistantMsgRaw.content !== 'string') assistantMsgRaw.content = contentText

        return { contentText, assistantMsgRaw }
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
      }
    }

    const TOOL_REQUEST_START = '<<<[TOOL_REQUEST]>>>'
    const TOOL_REQUEST_END = '<<<[END_TOOL_REQUEST]>>>'
    const TOOL_RESULT_START = '<<<[TOOL_RESULT]>>>'
    const TOOL_RESULT_END = '<<<[END_TOOL_RESULT]>>>'
    const VCP_VALUE_START = '「始」'
    const VCP_VALUE_END = '「末」'

    const parseToolRequests = (text: string): { cleaned: string; calls: Array<{ toolName: string; input: ToolInput }> } => {
      const raw = String(text ?? '')
      if (!raw.includes(TOOL_REQUEST_START)) return { cleaned: raw.trim(), calls: [] }

      const calls: Array<{ toolName: string; input: ToolInput }> = []
      let cleaned = ''
      let cursor = 0
      while (cursor < raw.length) {
        const s = raw.indexOf(TOOL_REQUEST_START, cursor)
        if (s < 0) {
          cleaned += raw.slice(cursor)
          break
        }
        cleaned += raw.slice(cursor, s)
        const e = raw.indexOf(TOOL_REQUEST_END, s + TOOL_REQUEST_START.length)
        if (e < 0) {
          cleaned += raw.slice(s)
          break
        }
        const block = raw.slice(s + TOOL_REQUEST_START.length, e).trim()
        cursor = e + TOOL_REQUEST_END.length

        const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g
        let m: RegExpExecArray | null
        let toolName = ''
        let inputJson = ''
        const kv: Record<string, unknown> = {}
        while ((m = paramRegex.exec(block)) !== null) {
          const key = m[1]
          const val = m[2]?.trim() ?? ''
          if (key === 'tool_name') toolName = val
          else if (key === 'input_json') inputJson = val
          else kv[key] = val
        }

        toolName = toolName.trim()
        if (!toolName) continue

        let input: ToolInput = {}
        if (inputJson.trim()) {
          try {
            input = JSON.parse(inputJson) as ToolInput
          } catch {
            input = inputJson
          }
        } else {
          input = kv as ToolInput
        }

        calls.push({ toolName, input })
      }

      return { cleaned: cleaned.trim(), calls }
    }

    const buildToolGuideForTextMode = (): string => {
      const lines: string[] = []
      lines.push('重要：工具输出是事实来源。严禁编造/猜测工具执行结果。')
      lines.push('如果 TOOL_RESULT 为空、乱码、或与你需要的答案不一致：必须明确说明“工具输出不可用/无法解析”，并优先选择重试（可换更简单/更稳的命令或加 -NoProfile）。')
      lines.push('只有当不需要工具时，才直接给最终回答。')
      lines.push('当你需要调用工具时：不要输出任何自然语言前置话术，直接输出一个或多个 TOOL_REQUEST。')
      lines.push('')
      lines.push('你可以通过“文本协议 TOOL_REQUEST”来调用工具。')
      lines.push('重要：用户仅说“打开/进入某网站”时，只需打开网页（优先 browser.open；必要时截图/交互才用 browser.playwright），不要擅自抓取全文/总结；只有用户明确要“抓取/总结/提炼”时才做 extract 或 summarize。')
      lines.push('')
      lines.push('格式（必须严格匹配，不要放在代码块里）：')
      lines.push(TOOL_REQUEST_START)
      lines.push(`tool_name:${VCP_VALUE_START}browser.fetch${VCP_VALUE_END}`)
      lines.push(`input_json:${VCP_VALUE_START}{"url":"https://example.com","stripHtml":true}${VCP_VALUE_END}`)
      lines.push(TOOL_REQUEST_END)
      lines.push('')
      lines.push('工具返回后，你会收到 TOOL_RESULT 块；然后继续下一步或给出最终答复。')
      lines.push('')
      lines.push('可用工具（tool_name 必须使用下面的内部名，不要编造）：')
      for (const d of toolDefs) {
        const schema = (() => {
          try {
            const s = JSON.stringify(d.inputSchema)
            return s.length > 800 ? s.slice(0, 800) + '…' : s
          } catch {
            return '{}'
          }
        })()
        lines.push(`- ${d.name}：${d.description}`)
        lines.push(`  input_schema: ${schema}`)
      }
      return lines.join('\n')
    }

    const executeTextToolCall = async (
      toolNameRaw: string,
      input: ToolInput,
    ): Promise<{ output: string; images: Array<{ mimeType: string; data: string }> }> => {
      const needle = (toolNameRaw ?? '').trim()
      const def = toolByName.get(needle) ?? resolveToolDefByCallName(needle)
      if (!def) throw new Error(`未知工具：${toolNameRaw}`)

      const key = makeCallKey(def.name, input)
      const cached = executedCalls.get(key)
      if (cached && typeof cached === 'object') {
        pushLog(`[Tool] ${def.name} skip duplicate`, true)
        return cached
      }

      this.writeState((draft) => {
        const it = draft.tasks.find((x) => x.id === task.id)
        if (!it) return
        if (!it.toolsUsed.includes(def.name)) it.toolsUsed = [...it.toolsUsed, def.name].slice(0, 80)
        it.updatedAt = now()
      })

      if (def.name.startsWith('mcp.') && this.mcpManager) {
        const res = await this.mcpManager.callToolDetailed(def.name, input)
        const out = res.text
        const exec = { output: out, images: res.images }
        executedCalls.set(key, exec)
        executedCallOrder.push({ toolName: def.name, input, output: out })
        return exec
      }

      const out = await this.executeToolByName(def.name, input, task, rt)
      const exec = { output: out, images: [] as Array<{ mimeType: string; data: string }> }
      executedCalls.set(key, exec)
      executedCallOrder.push({ toolName: def.name, input, output: out })
      return exec
    }

    pushLog(`[Agent] request: ${clampText(request, 120)}`, true)

    const executedCalls = new Map<string, { output: string; images: Array<{ mimeType: string; data: string }> }>()
    const executedCallOrder: Array<{ toolName: string; input: ToolInput; output: string }> = []

    const stableStringify = (v: unknown): string => {
      if (v == null) return 'null'
      const t = typeof v
      if (t === 'string') return JSON.stringify(v)
      if (t === 'number' || t === 'boolean') return String(v)
      if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
      if (t !== 'object') return JSON.stringify(String(v))

      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
    }

    const makeCallKey = (toolName: string, input: ToolInput): string => `${toolName}::${stableStringify(input)}`

    const toolResultBlockFor = (toolName: string, toolMsg: string): string =>
      [
        TOOL_RESULT_START,
        `tool_name:${VCP_VALUE_START}${toolName}${VCP_VALUE_END}`,
        `result:${VCP_VALUE_START}${toolMsg}${VCP_VALUE_END}`,
        TOOL_RESULT_END,
      ].join('\n')

    const buildEvidenceText = (): string => {
      const parts: string[] = []
      if (request.trim()) parts.push(request.trim())
      for (const r of executedCallOrder) {
        if (typeof r?.output === 'string' && r.output.trim()) parts.push(r.output)
      }
      return parts.join('\n\n')
    }

    const normalizeUrl = (raw: string): string => {
      const u = (raw ?? '').trim()
      if (!u) return ''
      return u.replace(/[)\]}>"'’”。，！？,.!?:;]+$/g, '').replace(/\/+$/g, '')
    }

    const extractUrls = (text: string): string[] => {
      const urls = text.match(/https?:\/\/[^\s<>()]+/g) ?? []
      return urls.map(normalizeUrl).filter(Boolean)
    }

    const sanitizeInternalToolNames = (text: string): string => {
      // UI 会展示 ToolUse，最终回复不要暴露内部调用名
      return text.replace(/\b(?:mcp|cli|browser|file|llm|delay)\.[A-Za-z0-9_:\-./]+/g, '').replace(/[ \t]{2,}/g, ' ')
    }

    const validateFinalText = (finalText: string): { ok: true } | { ok: false; reason: string } => {
      const text = (finalText ?? '').trim()
      if (!text) return { ok: true }

      const internalNameHit = /\b(?:mcp|cli|browser|file|llm|delay)\.[A-Za-z0-9_:\-./]+/g.test(text)
      if (internalNameHit) return { ok: false, reason: '最终回复包含工具内部名（如 cli.exec/browser.open/mcp.*）' }

      const urls = extractUrls(text)
      if (!urls.length) return { ok: true }

      const evidence = buildEvidenceText()
      const missing = urls.filter((u) => !evidence.includes(u) && !evidence.includes(`${u}/`))
      if (missing.length) return { ok: false, reason: `最终回复包含未在工具结果/用户输入出现的 URL：${missing[0]}` }

      return { ok: true }
    }

    const finalize = (finalText: string): string => {
      const raw = (finalText ?? '').trim()
      const extracted = extractLive2dTags(raw)
      if (extracted.expression) live2dExpression = extracted.expression
      if (extracted.motion) live2dMotion = extracted.motion

      const text = extracted.cleanedText
      const out = text || draftReply || ''
      this.writeState((draft) => {
        const it = draft.tasks.find((x) => x.id === task.id)
        if (!it) return
        it.finalReply = out
        it.draftReply = out
        it.live2dExpression = live2dExpression
        it.live2dMotion = live2dMotion
        it.toolRuns = toolRuns
        it.updatedAt = now()
      })
      return out
    }

    const tryFinalizeOrContinue = (candidateText: string, turn: number): { done: boolean; text: string } => {
      const raw = (candidateText ?? '').trim()
      const v = validateFinalText(raw)
      if (v.ok) return { done: true, text: finalize(raw) }

      if (turn < maxTurns - 1) {
        pushLog(`[Agent] final reply rejected: ${v.reason}`, true)
        messages.push({
          role: 'system',
          content: `校验失败：${v.reason}。请基于工具输出重答；需要链接/事实请先调用工具获取，且最终回复不要输出工具内部名。`,
        })
        return { done: false, text: '' }
      }

      // 最后一轮：做一次保守净化，避免把未验证的 URL/内部名直接发给用户
      const sanitized = sanitizeInternalToolNames(candidateText).replace(/https?:\/\/[^\s<>()]+/g, '[链接未验证]')
      pushLog(`[Agent] final reply sanitized at maxTurns: ${v.reason}`, true)
      return { done: true, text: finalize(sanitized) }
    }

    const runNative = async (): Promise<string> => {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        await this.waitIfPaused(task.id)
        if (rt.canceled) throw new Error('canceled')

        pushLog(`[Agent] turn ${turn + 1}/${maxTurns}`)
        const { contentText, toolCalls, assistantMsgRaw } = await callLlmNative()
        messages.push(assistantMsgRaw)
        appendDraft(contentText)

        if (!toolCalls.length) {
          pushLog('[Agent] done', true)
          const fin = tryFinalizeOrContinue(contentText, turn)
          if (fin.done) return fin.text
          continue
        }

        pushLog(`[Agent] tool_calls: ${toolCalls.map((c) => c.function.name).join(', ')}`)

        for (const call of toolCalls) {
          await this.waitIfPaused(task.id)
          if (rt.canceled) throw new Error('canceled')

          const def = resolveToolDefByCallName(call.function.name)
          if (!def) {
            const errText = `未知工具：${call.function.name}`
            pushLog(`[Tool] ${errText}`)
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: errText })
            continue
          }

          this.writeState((draft) => {
            const it = draft.tasks.find((x) => x.id === task.id)
            if (!it) return
            if (!it.toolsUsed.includes(def.name)) it.toolsUsed = [...it.toolsUsed, def.name].slice(0, 80)
            it.updatedAt = now()
          })

          const argStr = call.function.arguments || ''
          let toolInput: ToolInput = {}
          try {
            toolInput = argStr.trim() ? (JSON.parse(argStr) as ToolInput) : {}
          } catch {
            toolInput = argStr
          }

          pushLog(`[Tool] ${def.name} input: ${clampText(argStr, 240)}`)
          upsertToolRun({
            id: call.id,
            toolName: def.name,
            status: 'running',
            inputPreview: toolPreview(toolInput, 500),
            startedAt: now(),
          })

          let toolOut = ''
          try {
            const key = makeCallKey(def.name, toolInput)
            const cached = executedCalls.get(key)
            if (cached && typeof cached === 'object') {
              pushLog(`[Tool] ${def.name} skip duplicate`, true)
              toolOut = cached.output
            } else {
              toolOut = await this.executeToolByName(def.name, toolInput, task, rt)
              executedCalls.set(key, { output: toolOut, images: [] })
              executedCallOrder.push({ toolName: def.name, input: toolInput, output: toolOut })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toolOut = `[error] ${msg}`
            const key = makeCallKey(def.name, toolInput)
            if (!executedCalls.has(key)) {
              executedCalls.set(key, { output: toolOut, images: [] })
              executedCallOrder.push({ toolName: def.name, input: toolInput, output: toolOut })
            }
            upsertToolRun({
              id: call.id,
              toolName: def.name,
              status: 'error',
              error: clampText(msg, 800),
              outputPreview: clampText(toolOut, 800),
              endedAt: now(),
            })
          }

          const toolMsg = clampText(toolOut, 4000) || '(空)'
          pushLog(`[Tool] ${def.name} done`)
          upsertToolRun({
            id: call.id,
            toolName: def.name,
            status: toolOut.startsWith('[error]') ? 'error' : 'done',
            outputPreview: clampText(toolOut, 800),
            endedAt: now(),
          })
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: toolMsg })
        }
      }

      pushLog('[Agent] reach maxTurns, stop', true)
      return finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
    }

    const runText = async (): Promise<string> => {
      const guide = buildToolGuideForTextMode()
      const userIdx = messages.findIndex((m) => m.role === 'user')
      if (userIdx > 0) messages.splice(userIdx, 0, { role: 'system', content: guide })
      else messages.push({ role: 'system', content: guide })

      for (let turn = 0; turn < maxTurns; turn += 1) {
        await this.waitIfPaused(task.id)
        if (rt.canceled) throw new Error('canceled')

        pushLog(`[Agent] turn ${turn + 1}/${maxTurns}`)
        const { contentText, assistantMsgRaw } = await callLlmText()
        messages.push(assistantMsgRaw)

        const { cleaned, calls } = parseToolRequests(contentText)
        appendDraft(cleaned)
        if (!calls.length) {
          pushLog('[Agent] done', true)
          const fin = tryFinalizeOrContinue(cleaned, turn)
          if (fin.done) return fin.text
          continue
        }

        pushLog(`[Agent] tool_requests: ${calls.map((c) => c.toolName).join(', ')}`)

        for (const c of calls) {
          await this.waitIfPaused(task.id)
          if (rt.canceled) throw new Error('canceled')

          pushLog(`[Tool] ${c.toolName} input: ${clampText(JSON.stringify(c.input ?? {}), 240)}`)
          const runId = randomUUID()
          upsertToolRun({
            id: runId,
            toolName: c.toolName,
            status: 'running',
            inputPreview: toolPreview(c.input ?? {}, 500),
            startedAt: now(),
          })

          let toolOut = ''
          try {
            const key = makeCallKey(c.toolName, c.input ?? {})
            const cached = executedCalls.get(key)
            if (cached && typeof cached === 'object') {
              pushLog(`[Tool] ${c.toolName} skip duplicate`, true)
              toolOut = cached.output
            } else {
              const exec = await executeTextToolCall(c.toolName, c.input)
              toolOut = exec.output
              executedCalls.set(key, exec)
              executedCallOrder.push({ toolName: c.toolName, input: c.input ?? {}, output: toolOut })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toolOut = `[error] ${msg}`
            const key = makeCallKey(c.toolName, c.input ?? {})
            if (!executedCalls.has(key)) {
              executedCalls.set(key, { output: toolOut, images: [] })
              executedCallOrder.push({ toolName: c.toolName, input: c.input ?? {}, output: toolOut })
            }
            upsertToolRun({
              id: runId,
              toolName: c.toolName,
              status: 'error',
              error: clampText(msg, 800),
              outputPreview: clampText(toolOut, 800),
              endedAt: now(),
            })
          }

          const toolMsg = clampText(toolOut, 4000) || '(空)'
          pushLog(`[Tool] ${c.toolName} done`)
          upsertToolRun({
            id: runId,
            toolName: c.toolName,
            status: toolOut.startsWith('[error]') ? 'error' : 'done',
            outputPreview: clampText(toolOut, 800),
            endedAt: now(),
          })

          const toolResultBlock = [
            TOOL_RESULT_START,
            `tool_name:${VCP_VALUE_START}${c.toolName}${VCP_VALUE_END}`,
            `result:${VCP_VALUE_START}${toolMsg}${VCP_VALUE_END}`,
            TOOL_RESULT_END,
          ].join('\n')

          const images = executedCalls.get(makeCallKey(c.toolName, c.input ?? {}))?.images ?? []
          if (images.length > 0) {
            messages.push({
              role: 'user',
              content: [{ type: 'text', text: toolResultBlock }, ...toImageUrlParts(images)],
            })
          } else {
            messages.push({ role: 'user', content: toolResultBlock })
          }
        }
      }

      pushLog('[Agent] reach maxTurns, stop', true)
      return finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
    }

    if (mode === 'text') return runText()
    if (mode === 'native') return runNative()

    try {
      return await runNative()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 自适应：auto 模式下若检测到 thought_signature/thoughtSignature 兼容错误，则本次回退到 text（不修改用户设置）
      if (modeRaw === 'auto' && /thought[_ ]?signature/i.test(msg)) {
        pushLog('[Agent] auto detected native tools incompatibility, fallback to text', true)
      }
      pushLog(`[Agent] native tools failed, fallback to text: ${clampText(msg, 240)}`, true)

      messages.splice(0, messages.length)
      messages.push({ role: 'system', content: system })
      if (extraContext) messages.push({ role: 'system', content: extraContext })
      messages.push({ role: 'user', content: request })

      if (executedCallOrder.length > 0) {
        messages.push({
          role: 'system',
          content: `注意：以下工具已执行完成（或已得到错误结果）。除非需要不同参数，否则不要重复调用同名同参工具；请基于 TOOL_RESULT 直接给出最终答复。`,
        })
        for (const r of executedCallOrder) {
          const toolMsg = clampText(r.output, 4000) || '(空)'
          messages.push({ role: 'user', content: toolResultBlockFor(r.toolName, toolMsg) })
        }
      }

      return runText()
    }
  }

  private async runTask(id: string): Promise<void> {
    const rt = this.ensureRuntime(id)
    try {
      while (!rt.canceled) {
        const t = this.getTask(id)
        if (!t) return
        if (t.status !== 'running' && t.status !== 'paused') return

        if (t.status === 'paused') {
          await this.waitIfPaused(id)
          continue
        }

        const idx = t.currentStepIndex
        const step = t.steps[idx]
        if (!step) {
          this.writeState((draft) => {
            const it = draft.tasks.find((x) => x.id === id)
            if (!it) return
            it.status = 'done'
            it.updatedAt = now()
            it.endedAt = now()
          })
          this.runtime.delete(id)
          this.kickScheduler()
          return
        }

        // 标记 step running
        this.writeState((draft) => {
          const it = draft.tasks.find((x) => x.id === id)
          if (!it) return
          const s = it.steps[it.currentStepIndex]
          if (!s) return
          s.status = 'running'
          s.startedAt = s.startedAt ?? now()
          it.updatedAt = now()
          if (s.tool && !it.toolsUsed.includes(s.tool)) {
            it.toolsUsed = [...it.toolsUsed, s.tool].slice(0, 80)
          }
        })

        await this.waitIfPaused(id)
        if (rt.canceled) return

        const toolInput = parseToolInput(step.input)
        const output = await this.runTool(step.tool, toolInput, t, rt)

        await this.waitIfPaused(id)
        if (rt.canceled) return

        this.writeState((draft) => {
          const it = draft.tasks.find((x) => x.id === id)
          if (!it) return
          const s = it.steps[it.currentStepIndex]
          if (!s) return
          s.status = 'done'
          s.endedAt = now()
          s.output = clampStepOutput(output || '完成')
          it.currentStepIndex += 1
          it.updatedAt = now()
        })
      }
    } catch (err) {
      if (rt.canceled) return
      const msg = err instanceof Error ? err.message : String(err)
      this.writeState((draft) => {
        const it = draft.tasks.find((x) => x.id === id)
        if (!it) return
        it.status = 'failed'
        it.lastError = clampText(msg, 1600) || '任务失败'
        it.updatedAt = now()
        it.endedAt = now()
        const s = it.steps[it.currentStepIndex]
        if (s && s.status === 'running') {
          s.status = 'failed'
          s.error = it.lastError
          s.endedAt = now()
        }
      })
    } finally {
      rt.cancelCurrent = undefined
      this.runtime.delete(id)
      this.kickScheduler()
    }
  }

  private writeState(mutator: (draft: TaskStoreState) => void): void {
    const draft = normalizeState(this.store.store)
    mutator(draft)
    this.store.store = draft
    this.onChanged()
  }
}
    const toImageUrlParts = (images: Array<{ mimeType: string; data: string }>): Array<Record<string, unknown>> => {
      const parts: Array<Record<string, unknown>> = []
      for (const it of images) {
        const mime = (it?.mimeType ?? '').trim() || 'image/png'
        const raw = (it?.data ?? '').trim()
        if (!raw) continue
        const url = raw.startsWith('data:') ? raw : `data:${mime};base64,${raw}`
        parts.push({ type: 'image_url', image_url: { url } })
      }
      return parts
    }
