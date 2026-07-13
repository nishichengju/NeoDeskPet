import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSettings } from './store'
import { cancelCliExecStreamSessionsForTask, executeBuiltinTool, type ToolInput } from './toolExecutor'
import {
  filterToolDefinitionsBySettings,
  getDefaultAgentToolDefinitions,
  isToolEnabled,
  toOpenAITools,
  type OpenAIFunctionToolSpec,
} from './toolRegistry'
import { getLive2dCapabilities } from './live2dToolState'
import { readLive2dModelMetadata } from './live2dModelMetadata'
import { buildOpenAICompatReasoningOptions } from './reasoningConfig'
import { localMediaTypeFromPath } from './localMediaRegistry'
import { isPathWithinRoot } from './localMediaPolicy'
import { SkillManager, type SkillManagerRuntimeOptions } from './skillRegistry'
import type { McpManager } from './mcpManager'
import {
  buildToolResultBlock,
  hasToolRequestMarker,
  makeToolCallKey,
  stableStringify,
  stripToolRequestBlocksForDisplay,
  TaskAgentToolCatalog,
} from './task/taskAgentTools'
import {
  buildAgentEndpoint,
  buildAgentHeaders,
  isAbortLikeError,
} from './task/taskAgentLlmProtocol'
import { TaskAgentLlmClient } from './task/taskAgentLlmClient'
import { TaskRuntimeRegistry, TaskScheduler, type TaskRuntime } from './task/taskRuntime'
import { MAX_TASK_RECORDS, MAX_TASK_STEP_INPUT_CHARS, TaskStore, type TaskStoreState } from './task/taskStore'
import type { TaskCreateArgs, TaskListResult, TaskRecord, TaskStepRecord, VisualArtifactRef } from './types'
import { classifyVisionError, decideVisionRoute, resolveVisionFallbackProfile } from './visionRouter'

const MAX_STEP_OUTPUT_CHARS = 5000
const LIVE2D_TAG_MAX_LIST = { expressions: 20, motions: 10 }

type Live2dTagExtracted = { cleanedText: string; expression?: string; motion?: string }
type Live2dModelTagHints = { expressions: string[]; motions: string[] }

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

function readLive2dTagHintsFromModelFile(modelFileUrl: string): Live2dModelTagHints {
  const meta = readLive2dModelMetadata(modelFileUrl)
  return {
    expressions: (meta?.expressions ?? []).map((e) => e.name).filter(Boolean).slice(0, 200),
    motions: (meta?.motions ?? []).slice(0, 200),
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
        `说明：这是“可选标签”，用于在不调用 live2d.applyParamScript 时快速触发表情。` +
        `当你已经用 live2d.applyParamScript 完成表情/动作时，不要再额外追加标签，避免覆盖脚本效果。` +
        `格式：[表情:表情名]（只放在自然语言文本末尾，不要放进工具参数/JSON）。`,
    )
  }
  if (motions.length) {
    lines.push(
      `【动作系统】可用动作组：${motions.join('、')}\n` +
        `说明：这是“可选标签”，用于在不调用 live2d.applyParamScript 时快速触发动作。` +
        `当你已经用 live2d.applyParamScript 完成表情/动作时，不要再额外追加标签，避免覆盖脚本效果。` +
        `格式：[动作:动作组名]（只放在自然语言文本末尾，不要放进工具参数/JSON）。`,
    )
  }
  return lines.join('\n\n')
}

function buildLive2dParamSystemAddon(modelJsonUrlFallback?: string): string {
  const caps = getLive2dCapabilities()
  const modelJsonUrl = String(caps?.modelJsonUrl ?? modelJsonUrlFallback ?? '').trim()
  if (!modelJsonUrl) return ''

  const meta = readLive2dModelMetadata(modelJsonUrl)
  const nameMap = meta?.parameterDisplayNames ?? {}

  const maxList = 80
  const items = (() => {
    const fromCaps = Array.isArray(caps?.parameters) ? caps.parameters : []
    const mapped = fromCaps
      .filter((p) => p && typeof (p as { id?: unknown }).id === 'string')
      .slice(0, 800)
      .map((p) => ({
        id: String((p as { id: string }).id).trim(),
        min: typeof (p as { min?: unknown }).min === 'number' ? (p as { min: number }).min : undefined,
        max: typeof (p as { max?: unknown }).max === 'number' ? (p as { max: number }).max : undefined,
        def: typeof (p as { def?: unknown }).def === 'number' ? (p as { def: number }).def : undefined,
      }))
      .filter((p) => p.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id))

    const idPool = (() => {
      if (mapped.length > 0) return mapped.map((x) => x.id)
      return Object.keys(nameMap).filter((k) => k.trim().length > 0)
    })()

    const exprIds = (() => {
      const exps = meta?.expressions ?? []
      const ids: string[] = []
      for (const e of exps) {
        for (const p of e.params ?? []) {
          const id = String(p.id ?? '').trim()
          if (id) ids.push(id)
          if (ids.length >= 120) break
        }
        if (ids.length >= 120) break
      }
      return ids
    })()

    const commonIds = [
      'ParamEyeLOpen',
      'ParamEyeROpen',
      'ParamEyeLSmile',
      'ParamEyeRSmile',
      'ParamBrowLAngle',
      'ParamBrowRAngle',
      'ParamCheek',
      'ParamMouthForm',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamBodyAngleX',
      'ParamBodyAngleY',
      'ParamBodyAngleZ',
      'Param13',
    ]

    const pick = (ids: string[]) => ids.map((s) => s.trim()).filter(Boolean)
    const uniq = (xs: string[]) => Array.from(new Set(xs))
    const prioritized = uniq([...pick(commonIds), ...pick(exprIds)])
    const rest = uniq([...pick(idPool)]).filter((id) => !prioritized.includes(id)).sort((a, b) => a.localeCompare(b))
    const finalIds = [...prioritized, ...rest].slice(0, maxList)

    const byId = new Map<string, { min?: number; max?: number; def?: number }>()
    for (const p of mapped) byId.set(p.id, { min: p.min, max: p.max, def: p.def })

    return finalIds.map((id) => {
      const mm = byId.get(id) ?? {}
      return { id, min: mm.min, max: mm.max, def: mm.def }
    })
  })()

  const fmt = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
  const hasParam = (id: string): boolean => Boolean(items.some((p) => p.id === id) || typeof nameMap[id] === 'string')

  const lines: string[] = []
  lines.push('【Live2D 参数系统】')
  lines.push('你可以通过工具 live2d.applyParamScript 控制模型参数。')
  lines.push('当前系统提示已包含“当前模型参数清单”，通常不需要每次再调用 live2d.getCapabilities。仅当参数清单为空/明显不匹配当前模型时，再调用 live2d.getCapabilities。')
  lines.push('硬规则：当用户明确要求“眨眼/wink/单眼眨眼”时，你的参数脚本必须包含 ParamEyeLOpen 或 ParamEyeROpen 的变化（否则视为没完成 wink）。')
  lines.push('常见意图提示（优先改这些“语义参数”，不要用 ArtMesh 旋转类参数去硬凑表情）：')
  if (hasParam('ParamEyeLOpen') || hasParam('ParamEyeROpen')) {
    lines.push('- 眨眼/单眼 wink：用 ParamEyeLOpen / ParamEyeROpen 把其中一只眼睛从 1 → 0 → 1（另一只保持 1）')
  }
  if (hasParam('ParamEyeLSmile') || hasParam('ParamEyeRSmile')) {
    lines.push('- 眯眼/笑眼：用 ParamEyeLSmile / ParamEyeRSmile（可与 EyeOpen 联动）')
  }
  if (hasParam('Param13') && (nameMap.Param13?.includes('脸红') ?? false)) {
    lines.push('- 脸红：Param13（脸红）')
  }
  if (hasParam('ParamBodyAngleX') || hasParam('ParamBodyAngleZ')) {
    lines.push('- 扭扭捏捏/身体摆动：ParamBodyAngleX / ParamBodyAngleZ / ParamAngleX / ParamAngleZ')
  }
  lines.push('脚本格式（推荐）：')
  lines.push('- tween: {op:"tween", to:{ParamId: number}, durationMs:number, ease:"linear|in|out|inOut", holdMs?:number}')
  lines.push('- patch: {op:"patch", to:{ParamId: number}, holdMs?:number}')
  lines.push('- wait: {op:"wait", durationMs:number}')
  lines.push('- sequence: {op:"sequence", steps:[...] }')
  lines.push('- pulse(宏): {op:"pulse", id:"ParamId", down:0, up:1, downMs:100, holdMs:150, upMs:100}（等价于 tween+wait+tween）')
  lines.push('注意：口型/呼吸/鼠标追踪等桌宠内置效果可能会覆盖同名参数，避免被 LLM 控制。')
  lines.push('例如：若用户开启了“鼠标追踪”，可能会持续写入 ParamAngleX/Y、ParamBodyAngleX/Y、ParamEyeBallX/Y 等；此时尽量避免用这些参数做动作，或提示用户先关闭鼠标追踪。')
  const totalCount = Array.isArray(caps?.parameters) ? caps.parameters.length : 0
  lines.push(`当前模型参数（展示前 ${items.length}/${totalCount || items.length} 个，model=${modelJsonUrl}）：`)
  for (const p of items) {
    const display = nameMap[p.id]
    const nameSuffix = display ? ` (${display})` : ''
    const suffix = [fmt(p.min) && `min=${fmt(p.min)}`, fmt(p.max) && `max=${fmt(p.max)}`, fmt(p.def) && `def=${fmt(p.def)}`]
      .filter(Boolean)
      .join(' ')
    lines.push(`- ${p.id}${nameSuffix}${suffix ? ` ${suffix}` : ''}`)
  }

  const expressions = meta?.expressions ?? []
  if (expressions.length > 0) {
    lines.push('')
    lines.push('【Live2D 表情速查（来自模型 Expressions/*.exp3.json）】')
    lines.push('说明：表情本质上也是一组参数变化；你可以直接用 applyParamScript 复现，不必盲猜 ParamXX。')
    for (const e of expressions.slice(0, 16)) {
      const ps = (e.params ?? []).slice(0, 5).map((x) => {
        const dn = nameMap[x.id]
        const dnSuffix = dn ? `(${dn})` : ''
        const blend = x.blend ? x.blend : 'Set'
        return `${x.id}${dnSuffix} ${blend} ${x.value}`
      })
      lines.push(`- ${e.name}${ps.length ? `: ${ps.join(', ')}` : ''}`)
    }
  }

  return lines.join('\n')
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

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function finalTextClaimsToolAction(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  const negated = /(?:没有|没|未|无法|不能|失败|没能).{0,12}(?:调用|使用|运行|执行|搜索|搜|查询|截图|截屏|打开|点击|读取|写入|保存|修改|修复|工具)/u.test(raw)
  if (negated) return false
  return /(?:调用了|使用了|运行了|执行了|搜索了|搜到了|查到了|找到了|截图了|截屏了|打开了|点击了|读取了|写入了|保存了|修改了|下载了|安装了|创建了|生成了|修好了|已调用|已搜索|已截图|已打开|已读取|已写入|已修改|已保存|工具返回|搜索结果|截图已经|已经帮你)/u.test(raw)
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

function pickImageExtByMime(mimeType: string): string {
  const m = String(mimeType ?? '').trim().toLowerCase()
  if (m === 'image/jpeg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/gif') return '.gif'
  if (m === 'image/bmp') return '.bmp'
  return '.png'
}

const IMAGE_REF_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[?#][^\s"')\]]*)?$/i

function isLikelyImageRef(raw: string): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  if (/^data:image\//i.test(s)) return true
  if (/^blob:/i.test(s)) return true
  if (/^file:\/\//i.test(s)) return IMAGE_REF_RE.test(s)

  // 聊天窗口 ToolUse 图片预览只展示“本地/内联图片”：
  // - 避免把搜索结果 JSON 里的一堆远程缩略图 URL 误识别成“工具输出图片”
  // - 避免热链/防盗链导致的大量破图占位
  // 允许 localhost 的内部附件服务 URL（用于预览本地附件）。
  if (/^https?:\/\//i.test(s)) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(s)) return IMAGE_REF_RE.test(s)
    return false
  }

  // 过滤掉“无协议远程 URL”（例如 //host/path 或 host.tld/path），它们不是本地文件路径。
  if (/^\/\//.test(s)) return false
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(s)) return false

  // 绝对路径（Windows / UNC / POSIX）或相对路径（如 task-output/foo.png）
  return IMAGE_REF_RE.test(s)
}

function extractImageRefsFromToolText(text: string): string[] {
  const raw = String(text ?? '')
  if (!raw.trim()) return []

  const out = new Set<string>()
  const add = (value: unknown) => {
    const s = canonicalizeImageRef(value)
    if (!s) return
    if (!isLikelyImageRef(s)) return
    out.add(s)
  }

  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      add(v)
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (!v || typeof v !== 'object') return
    for (const x of Object.values(v as Record<string, unknown>)) walk(x)
  }

  const collectPreferredRefs = (v: unknown): string[] => {
    const preferred = new Set<string>()
    const addPreferred = (value: unknown) => {
      const s = canonicalizeImageRef(value)
      if (!s || !isLikelyImageRef(s)) return
      preferred.add(s)
    }
    const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    if (!obj) return []
    addPreferred(obj.path)
    if (Array.isArray(obj.paths)) {
      for (const p of obj.paths) addPreferred(p)
    }
    if (Array.isArray(obj.images)) {
      for (const item of obj.images) {
        const imageObj = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
        addPreferred(imageObj?.path)
      }
    }
    return Array.from(preferred).slice(0, 8)
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const preferred = collectPreferredRefs(parsed)
    if (preferred.length > 0) return preferred
    walk(parsed)
  } catch {
    // ignore
  }

  for (const m of raw.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) add(m[1])
  for (const m of raw.matchAll(/https?:\/\/[^\s<>()"'`]+/g)) add(m[0])
  for (const m of raw.matchAll(/(?:[a-zA-Z]:\\|\\\\|\/)[^\r\n"'`<>|?*]+?\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?[^\s"'`<>]*)?/g)) add(m[0])

  return Array.from(out).slice(0, 8)
}

// 工具输出常见“JSON 转义残留”路径（C:\\Users\\...）：与正常形态（C:\Users\...）指向同一文件，
// 必须折叠成同一字符串，否则字符串级去重会把同一张图当成两张（重复注入 vision、挤占数量上限）。
function canonicalizeImageRef(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\\{2,}/g, '\\')
  if (s.startsWith('\\\\')) return `\\${s.replace(/\\{2,}/g, '\\')}` // UNC：保留头部双反斜杠
  return s
}

function normalizeImagePathList(values: unknown[], limit = 8): string[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 8
  if (!Array.isArray(values) || max <= 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const s = canonicalizeImageRef(value)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

const VISION_RESULT_TOOL_NAMES = new Set(['image.generate', 'screen.capture', 'browser.screenshot'])

type TaskVisualContext = {
  artifacts: Map<string, VisualArtifactRef>
  initialVisionIds: string[]
}

function normalizeVisualArtifacts(values: unknown, limit = 24): VisualArtifactRef[] {
  if (!Array.isArray(values)) return []
  const out: VisualArtifactRef[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const value = raw as Record<string, unknown>
    const id = String(value.id ?? '').trim()
    const imagePath = canonicalizeImageRef(value.path)
    if (!id || !imagePath || seen.has(id)) continue
    const sourceRaw = String(value.source ?? '').trim()
    const source: VisualArtifactRef['source'] =
      sourceRaw === 'upload' ||
      sourceRaw === 'image.generate' ||
      sourceRaw === 'screen.capture' ||
      sourceRaw === 'browser.screenshot'
        ? sourceRaw
        : 'legacy'
    const optionalString = (key: string): string | undefined => {
      const text = String(value[key] ?? '').trim()
      return text || undefined
    }
    const optionalInt = (key: string): number | undefined => {
      const n = Number(value[key])
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined
    }
    seen.add(id)
    out.push({
      id,
      path: imagePath,
      source,
      groupId: optionalString('groupId'),
      messageId: optionalString('messageId'),
      taskId: optionalString('taskId'),
      runId: optionalString('runId'),
      index: optionalInt('index'),
      total: optionalInt('total'),
      createdAt: optionalInt('createdAt'),
    })
    if (out.length >= limit) break
  }
  return out
}

// agent.run 是“对话代理”的编排壳：真实工具调用由其内部 upsertToolRun 逐条记录。
// 壳 step 自身不能再记入 toolRuns，否则纯聊天也会在气泡/聊天里渲染一张 agent.run 工具卡。
function shouldRecordStepToolRun(tool: unknown): tool is string {
  const name = typeof tool === 'string' ? tool.trim() : ''
  return name.length > 0 && name !== 'agent.run'
}

function imageMimeFromPath(filePath: string): string {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}

async function localImagePathToDataUrl(filePath: string): Promise<string | null> {
  const raw = String(filePath ?? '').trim()
  if (!raw || /^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw || null
  if (!path.isAbsolute(raw)) return null
  try {
    const st = await fs.promises.stat(raw)
    if (!st.isFile() || st.size > 10 * 1024 * 1024) return null
    const buf = await fs.promises.readFile(raw)
    if (!buf.length) return null
    return `data:${imageMimeFromPath(raw)};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

async function imageUrlPartsFromLocalPaths(paths: string[], limit = 4): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = []
  for (const p of normalizeImagePathList(paths, limit)) {
    const url = await localImagePathToDataUrl(p)
    if (!url) continue
    parts.push({ type: 'image_url', image_url: { url } })
    if (parts.length >= limit) break
  }
  return parts
}

export class TaskService {
  private readonly taskStore: TaskStore
  private readonly runtime = new TaskRuntimeRegistry()
  private readonly scheduler: TaskScheduler
  private readonly visualContextByTask = new Map<string, TaskVisualContext>()
  private readonly visionCapabilityCache = new Map<string, 'supported' | 'unsupported'>()
  private readonly userDataDir: string
  private readonly mcpManager: McpManager | null
  private readonly skillManager: SkillManager

  constructor(opts: { onChanged: () => void; userDataDir: string; mcpManager?: McpManager | null }) {
    this.taskStore = new TaskStore({ onChanged: opts.onChanged })
    this.userDataDir = opts.userDataDir
    this.mcpManager = opts.mcpManager ?? null
    this.skillManager = new SkillManager({ workspaceDir: process.cwd() })
    this.scheduler = new TaskScheduler({
      readTasks: () => this.taskStore.readState().tasks,
      startTask: (id) => this.startTask(id),
    })

    this.taskStore.recoverInterruptedTasks()
  }

  listTasks(): TaskListResult {
    return this.taskStore.listTasks()
  }

  getTask(id: string): TaskRecord | null {
    return this.taskStore.getTask(id)
  }

  // 用户对 image.generate 结果“重新生成”后，把新图写回原任务的 toolRun，
  // 保持任务存档（工具卡显示、消息附件、AI 看图收集）与用户看到的图一致
  updateToolRunImages(taskId: string, runId: string, imagePaths: string[]): TaskRecord | null {
    const tid = (taskId ?? '').trim()
    const rid = (runId ?? '').trim()
    const paths = normalizeImagePathList(Array.isArray(imagePaths) ? imagePaths : [], 8)
    if (!tid || !rid || paths.length === 0) return this.getTask(tid)
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === tid)
      if (!it) return
      const runs = Array.isArray(it.toolRuns) ? it.toolRuns : []
      const idx = runs.findIndex((r) => r?.id === rid)
      if (idx < 0) return
      it.toolRuns = [...runs.slice(0, idx), { ...runs[idx], imagePaths: paths }, ...runs.slice(idx + 1)]
      it.updatedAt = now()
    })
    return this.getTask(tid)
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
            input: typeof s.input === 'string' ? clampText(s.input, MAX_TASK_STEP_INPUT_CHARS) : undefined,
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

    const visualArtifacts = normalizeVisualArtifacts(args.visualArtifacts, 24)
    if (visualArtifacts.length > 0) {
      const artifactMap = new Map(visualArtifacts.map((artifact) => [artifact.id, artifact]))
      const initialVisionIds = Array.isArray(args.initialVisionIds)
        ? args.initialVisionIds
            .map((value) => String(value ?? '').trim())
            .filter((value, index, list) => value.length > 0 && artifactMap.has(value) && list.indexOf(value) === index)
            .slice(0, 8)
        : []
      this.visualContextByTask.set(id, { artifacts: artifactMap, initialVisionIds })
    }

    this.writeState((draft) => {
      draft.tasks.unshift(record)
      draft.tasks = draft.tasks.slice(0, MAX_TASK_RECORDS)
    })

    this.scheduler.kick()
    return record
  }

  pauseTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status !== 'running') return t
    this.runtime.pause(t.id)
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
    this.runtime.resume(t.id)
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'running'
      it.updatedAt = now()
    })
    this.scheduler.kick()
    return this.getTask(t.id)
  }

  cancelTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') return t

    this.runtime.cancel(t.id)
    void cancelCliExecStreamSessionsForTask(t.id).catch(() => undefined)

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
    await this.runtime.waitIfPaused(id)
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
        refreshSkillRegistry: async () => {
          const skillManagedDirRaw =
            typeof settings.orchestrator?.skillManagedDir === 'string' ? settings.orchestrator.skillManagedDir.trim() : ''
          await this.skillManager.refresh({ managedDir: skillManagedDirRaw || undefined })
        },
      },
      { maxStepOutputChars: MAX_STEP_OUTPUT_CHARS },
    )
  }

  private async persistToolImages(taskId: string, images: Array<{ mimeType: string; data: string }>): Promise<string[]> {
    if (!Array.isArray(images) || images.length === 0) return []

    const baseDir = path.join(this.userDataDir, 'chat-attachments')
    await fs.promises.mkdir(baseDir, { recursive: true })

    const out: string[] = []
    const seenImageHashes = new Set<string>()
    const safeTaskId = String(taskId ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24) || 'task'
    for (const it of images.slice(0, 8)) {
      const rawData = typeof it?.data === 'string' ? it.data.trim() : ''
      if (!rawData) continue

      let mimeType = typeof it?.mimeType === 'string' && it.mimeType.trim() ? it.mimeType.trim() : 'image/png'
      let base64 = rawData
      const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,(.+)$/i)
      if (dataUrlMatch) {
        mimeType = dataUrlMatch[1] || mimeType
        base64 = dataUrlMatch[2] || ''
      }

      if (!base64) continue

      let buf: Buffer
      try {
        buf = Buffer.from(base64, 'base64')
      } catch {
        continue
      }
      if (!buf.length) continue
      const hash = createHash('sha1').update(buf).digest('hex')
      const imageKey = `${mimeType}:${hash}`
      if (seenImageHashes.has(imageKey)) continue
      seenImageHashes.add(imageKey)

      const ext = pickImageExtByMime(mimeType)
      const filename = `${safeTaskId}-${randomUUID()}${ext}`
      const filePath = path.join(baseDir, filename)
      await fs.promises.writeFile(filePath, buf)
      out.push(filePath)
    }

    return out
  }

  private async resolveToolImagePaths(
    taskId: string,
    toolText: string,
    images: Array<{ mimeType: string; data: string }>,
  ): Promise<string[]> {
    const persisted = await this.persistToolImages(taskId, images)
    if (persisted.length > 0) return normalizeImagePathList(persisted, 8)
    return normalizeImagePathList(extractImageRefsFromToolText(toolText), 8)
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

    if (toolName === 'workflow.mmvector_video_qa') {
      return this.runWorkflowMmvectorVideoQa(resolved, task, rt)
    }

    return this.executeToolByName(toolName, resolved, task, rt)
  }

  private async runWorkflowMmvectorVideoQa(resolved: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    if (!this.mcpManager) throw new Error('MCP manager not initialized')

    const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
    const searchQuery = typeof obj?.searchQuery === 'string' ? obj.searchQuery.trim() : typeof resolved === 'string' ? resolved.trim() : ''
    const question = typeof obj?.question === 'string' ? obj.question.trim() : ''
    if (!searchQuery) throw new Error('workflow.mmvector_video_qa 需要 searchQuery')
    if (!question) throw new Error('workflow.mmvector_video_qa 需要 question')

    const topK = typeof obj?.topK === 'number' ? Math.max(1, Math.min(20, Math.trunc(obj.topK))) : 3
    const minScore = typeof obj?.minScore === 'number' ? Math.max(0, Math.min(1, obj.minScore)) : undefined

    const segmentSeconds = typeof obj?.segmentSeconds === 'number' ? Math.max(5, Math.min(120, Math.trunc(obj.segmentSeconds))) : 20
    const framesPerSegment = typeof obj?.framesPerSegment === 'number' ? Math.max(1, Math.min(8, Math.trunc(obj.framesPerSegment))) : 3
    const maxSegments = typeof obj?.maxSegments === 'number' ? Math.max(1, Math.min(60, Math.trunc(obj.maxSegments))) : 8
    const startSeconds = typeof obj?.startSeconds === 'number' ? Math.max(0, Math.min(1e9, obj.startSeconds)) : 0

    const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(5000, Math.min(600000, Math.trunc(obj.timeoutMs))) : 180000
    const startedAt = now()
    const ensureTime = () => {
      if (now() - startedAt > timeoutMs) throw new Error('workflow.mmvector_video_qa timeout')
    }

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

    const exists = async (p: string): Promise<boolean> => {
      try {
        const st = await fs.promises.stat(p)
        return st.isFile()
      } catch {
        return false
      }
    }

    const downloadToFile = async (url: string, destPath: string): Promise<void> => {
      const ac = new AbortController()
      const remaining = Math.max(5000, timeoutMs - (now() - startedAt))
      const timer = setTimeout(() => ac.abort(new Error('download timeout')), remaining)
      rt.cancelCurrent = () => ac.abort(new Error('canceled'))

      try {
        const res = await fetch(url, { method: 'GET', signal: ac.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true })

        const file = fs.createWriteStream(destPath)
        await new Promise<void>((resolve, reject) => {
          file.once('error', reject)
          file.once('finish', () => resolve())
          const body = res.body
          if (!body) {
            file.end()
            reject(new Error('empty body'))
            return
          }
          const bodyStream = body as unknown as NodeJS.ReadableStream
          bodyStream.pipe(file)
        })
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
      }
    }

    ensureTime()
    await this.waitIfPaused(task.id)

    const searchText = await this.mcpManager.callTool('mcp.mmvector.search_by_text', {
      query: searchQuery,
      topK,
      filter: 'video',
      ...(typeof minScore === 'number' ? { minScore } : {}),
    })

    type MmvectorResult = { id?: number; type?: string; score?: number; filename?: string; videoUrl?: string; videoPath?: string }
    const parsed = parseJsonFromText(searchText)
    const resultsUnknown = parsed && parsed.ok === true && Array.isArray(parsed.results) ? (parsed.results as unknown[]) : []
    const results: MmvectorResult[] = resultsUnknown
      .map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as MmvectorResult) : null))
      .filter((r): r is MmvectorResult => Boolean(r))

    const picked =
      results.find((r) => typeof r.videoPath === 'string' && r.videoPath.trim()) ??
      results.find((r) => typeof r.videoUrl === 'string' && r.videoUrl.trim()) ??
      null
    if (!picked) {
      return clampText(
        JSON.stringify({ ok: false, error: 'mmvector 未命中任何视频', searchQuery, tool: 'mcp.mmvector.search_by_text', raw: searchText }),
        5000,
      )
    }

    ensureTime()
    await this.waitIfPaused(task.id)

    const rawVideoPath = typeof picked.videoPath === 'string' ? picked.videoPath.trim() : ''
    const rawVideoUrl = typeof picked.videoUrl === 'string' ? picked.videoUrl.trim() : ''

    const cacheDir = path.join(this.userDataDir, 'video-qa-cache')
    await fs.promises.mkdir(cacheDir, { recursive: true })
    let localVideoPath = ''
    if (rawVideoPath && (await exists(rawVideoPath))) {
      const sourceType = localMediaTypeFromPath(rawVideoPath)
      if (!sourceType || sourceType.kind !== 'video') throw new Error('mmvector videoPath 类型不受支持')
      const sourceStat = await fs.promises.stat(rawVideoPath)
      if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > 4 * 1024 * 1024 * 1024) {
        throw new Error('mmvector videoPath 文件大小不受支持')
      }
      const realSource = await fs.promises.realpath(rawVideoPath)
      const realCache = await fs.promises.realpath(cacheDir)
      const style = process.platform === 'win32' ? 'win32' : 'posix'
      if (isPathWithinRoot(realSource, realCache, style)) {
        localVideoPath = realSource
      } else {
        const safeBase = ((picked.filename ?? '').trim() || path.basename(realSource)).replace(/[<>:"/\\|?*]+/g, '_')
        const ext = path.extname(realSource).toLowerCase()
        const stem = path.basename(safeBase, path.extname(safeBase)).slice(0, 120) || 'mmvector'
        const dest = path.join(cacheDir, `${stem}-${randomUUID()}${ext}`)
        await fs.promises.copyFile(realSource, dest)
        localVideoPath = dest
      }
    } else {
      if (!rawVideoUrl) throw new Error(`mmvector 命中但无可用 videoPath/videoUrl：${JSON.stringify(picked)}`)
      const requestedName = (picked.filename ?? '').trim() || `mmvector_${task.id}_${now().toString(36)}.mp4`
      const safeName = localMediaTypeFromPath(requestedName)?.kind === 'video' ? requestedName : `${requestedName}.mp4`
      const dest = path.join(cacheDir, safeName.replace(/[<>:"/\\|?*]+/g, '_'))
      await downloadToFile(rawVideoUrl, dest)
      const downloadedStat = await fs.promises.stat(dest)
      if (!downloadedStat.isFile() || downloadedStat.size <= 0 || downloadedStat.size > 4 * 1024 * 1024 * 1024) {
        throw new Error('下载视频文件大小不受支持')
      }
      localVideoPath = dest
    }

    ensureTime()
    await this.waitIfPaused(task.id)

    const qaInput: Record<string, unknown> = {
      videoPath: localVideoPath,
      question,
      segmentSeconds,
      framesPerSegment,
      maxSegments,
      startSeconds,
      ...(typeof obj?.baseUrl === 'string' && obj.baseUrl.trim() ? { baseUrl: obj.baseUrl.trim() } : {}),
      ...(typeof obj?.apiKey === 'string' && obj.apiKey.trim() ? { apiKey: obj.apiKey.trim() } : {}),
      ...(typeof obj?.model === 'string' && obj.model.trim() ? { model: obj.model.trim() } : {}),
      ...(typeof obj?.temperature === 'number' ? { temperature: obj.temperature } : {}),
      ...(typeof obj?.maxTokensPerSegment === 'number' ? { maxTokensPerSegment: obj.maxTokensPerSegment } : {}),
      ...(typeof obj?.maxTokensFinal === 'number' ? { maxTokensFinal: obj.maxTokensFinal } : {}),
      ...(typeof obj?.timeoutMs === 'number' ? { timeoutMs: Math.max(5000, timeoutMs - (now() - startedAt)) } : {}),
    }

    const qaText = await this.executeToolByName('media.video_qa', qaInput, task, rt)

    const out = {
      ok: true,
      search: {
        query: searchQuery,
        picked: {
          id: picked.id,
          score: picked.score,
          filename: picked.filename,
          videoUrl: rawVideoUrl || undefined,
          videoPath: rawVideoPath || undefined,
          localVideoPath,
        },
      },
      qa: (() => {
        const raw = String(qaText ?? '').trim()
        const first = raw.indexOf('{')
        const last = raw.lastIndexOf('}')
        if (first >= 0 && last > first) {
          try {
            return JSON.parse(raw.slice(first, last + 1)) as unknown
          } catch {
            return raw
          }
        }
        return raw
      })(),
    }

    return clampText(JSON.stringify(out, null, 2), 5000) || '(空)'
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

    const modeRaw = normalizeMode(obj?.mode) ?? normalizeMode(orch?.toolCallingMode) ?? 'text'
    const mode: 'auto' | 'native' | 'text' = modeRaw

    // 桌宠“人设/语气”只允许来自 AI 设置里的 systemPrompt；agent.run 不允许覆盖 system（避免多处人设割裂）
    const system = typeof settings.ai.systemPrompt === 'string' ? settings.ai.systemPrompt.trim() : ''
    const extraContext = typeof obj?.context === 'string' ? obj.context.trim() : ''

    const maxVisionImages = clampInt(settings.ai.visionMaxImagesPerLook, 4, 1, 8)
    const visualContext = this.visualContextByTask.get(task.id) ?? { artifacts: new Map<string, VisualArtifactRef>(), initialVisionIds: [] }
    const legacyVisionImagePaths = normalizeImagePathList(
      Array.isArray(obj?.imagePaths) ? (obj.imagePaths as unknown[]) : [],
      maxVisionImages,
    )
    for (let index = 0; index < legacyVisionImagePaths.length; index += 1) {
      const id = `legacy_${task.id}_${index + 1}`
      if (!visualContext.artifacts.has(id)) {
        visualContext.artifacts.set(id, {
          id,
          path: legacyVisionImagePaths[index],
          source: 'legacy',
          groupId: `legacy:${task.id}`,
          index: index + 1,
          total: legacyVisionImagePaths.length,
          taskId: task.id,
          createdAt: task.createdAt,
        })
      }
      if (!visualContext.initialVisionIds.includes(id)) visualContext.initialVisionIds.push(id)
    }
    const listVisualArtifacts = (): VisualArtifactRef[] => Array.from(visualContext.artifacts.values()).slice(-24)
    const resolveVisualArtifacts = (ids: unknown): VisualArtifactRef[] => {
      if (!Array.isArray(ids)) return []
      const out: VisualArtifactRef[] = []
      const seen = new Set<string>()
      for (const raw of ids) {
        const id = String(raw ?? '').trim()
        const artifact = visualContext.artifacts.get(id)
        if (!artifact || seen.has(id)) continue
        seen.add(id)
        out.push(artifact)
        if (out.length >= maxVisionImages) break
      }
      return out
    }
    const initialVisionArtifacts = resolveVisualArtifacts(visualContext.initialVisionIds)
    const fallbackProfile = resolveVisionFallbackProfile(settings)
    const mainVisionCapabilityKey = [settings.ai.apiMode, settings.ai.baseUrl, settings.ai.model]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .join('|')
    const effectiveMainVisionCapability =
      settings.ai.visionCapability === 'auto'
        ? (this.visionCapabilityCache.get(mainVisionCapabilityKey) ?? 'auto')
        : settings.ai.visionCapability
    const rememberMainVisionCapability = (capability: 'supported' | 'unsupported') => {
      if (settings.ai.visionCapability === 'auto' && mainVisionCapabilityKey.replace(/\|/g, '').length > 0) {
        this.visionCapabilityCache.set(mainVisionCapabilityKey, capability)
      }
    }

    const builtinDefs = getDefaultAgentToolDefinitions().filter(
      (definition) => definition.name !== 'vision.look' || settings.ai.visionRoutingMode !== 'off',
    )
    const mcpDefs = this.mcpManager?.getToolDefinitions() ?? []
    const toolDefs = filterToolDefinitionsBySettings([...builtinDefs, ...mcpDefs], settings.tools)
    if (settings.ai.visionRoutingMode !== 'off' && !toolDefs.some((definition) => definition.name === 'vision.look')) {
      const visionLook = builtinDefs.find((definition) => definition.name === 'vision.look')
      if (visionLook) toolDefs.push(visionLook)
    }
    const tools: OpenAIFunctionToolSpec[] = toOpenAITools(toolDefs)
    const toolCatalog = new TaskAgentToolCatalog(toolDefs)

    const skillSystemMessages: Array<Record<string, unknown>> = []
    let effectiveAgentRequest = request
    const deferredSkillLogs: string[] = []
    const skillEnabled = settings.orchestrator?.skillEnabled !== false
    const skillAllowModelInvocation = settings.orchestrator?.skillAllowModelInvocation !== false
    const skillManagedDirRaw =
      typeof settings.orchestrator?.skillManagedDir === 'string' ? settings.orchestrator.skillManagedDir : ''
    const skillVerboseLogging = settings.orchestrator?.skillVerboseLogging === true
    const skillRuntimeOptions: SkillManagerRuntimeOptions = {
      enabled: skillEnabled,
      allowModelInvocation: skillAllowModelInvocation,
      managedDir: skillManagedDirRaw.trim() || undefined,
    }

    try {
      const skillDiagnostics = await this.skillManager.getDiagnostics(skillRuntimeOptions)
      if (skillVerboseLogging) {
        if (!skillDiagnostics.enabled) {
          deferredSkillLogs.push('[Skill] disabled by settings')
        } else {
          deferredSkillLogs.push(
            `[Skill] loaded: total=${skillDiagnostics.totalSkills}, visible=${skillDiagnostics.modelVisibleSkills}, commands=${skillDiagnostics.totalCommands}, source(managed/workspace)=${skillDiagnostics.sourceCounts.managed}/${skillDiagnostics.sourceCounts.workspace}`,
          )
          deferredSkillLogs.push(`[Skill] managedDir: ${skillDiagnostics.managedDir}`)
          if (!skillAllowModelInvocation) deferredSkillLogs.push('[Skill] model auto invocation disabled (skip available_skills prompt)')
          if (skillDiagnostics.conflicts.length > 0) {
            deferredSkillLogs.push(`[Skill] conflicts: ${skillDiagnostics.conflicts.length}`)
            for (const c of skillDiagnostics.conflicts.slice(0, 5)) {
              deferredSkillLogs.push(
                `[Skill] conflict/${c.type}: key=${c.key}, kept=${c.kept}${c.replaced ? `, replaced=${c.replaced}` : ''}${c.note ? `, note=${c.note}` : ''}`,
              )
            }
            if (skillDiagnostics.conflicts.length > 5) {
              deferredSkillLogs.push(`[Skill] conflicts truncated: +${skillDiagnostics.conflicts.length - 5}`)
            }
          }
        }
      }

      const skillsPrompt = await this.skillManager.buildSkillsPrompt(skillRuntimeOptions)
      if (skillsPrompt) {
        skillSystemMessages.push({
          role: 'system',
          content:
            '## Skills（技能）\n' +
            '在回答前先浏览 <available_skills> 的描述；如果某个技能与任务高度匹配，优先使用该技能。\n' +
            '可用辅助工具：skill.list（查看已加载技能）、skill.install（从 Git 仓库安装到托管目录）、skill.refresh（刷新缓存）。\n' +
            '若用户点名某个技能/搜索渠道（例如“用 grok 搜索”），必须先用 skill.read 读取对应技能并按技能步骤执行，不要先改用 browser.fetch/mcp.fetch.fetch 等通用网页抓取。\n' +
            '若需要技能详细步骤，优先使用 skill.read 按技能名读取（更稳、更省上下文）；示例：skill.read {name:"技能名"}。\n' +
            '运行本地命令一律优先使用 cli.exec_stream（start/poll/stop）；对会先输出提示/二维码路径再长时间等待的脚本，必须用流式方式，不要长时间阻塞等待。Windows 运行 .py 脚本必须写 python "脚本.py"，不要用 & "脚本.py" 直接执行。\n' +
            '一次最多先读取 1 个技能，避免无关技能占用上下文。\n' +
            skillsPrompt,
        })
      }

      const reqTrim = request.trim()
      if (reqTrim) {
        const matchResult = await this.skillManager.matchWithTrace(reqTrim, skillRuntimeOptions)
        const match = matchResult.match
        if (skillVerboseLogging && reqTrim.startsWith('/')) {
          const trace = matchResult.trace
          const selectedText = trace.selected
            ? `${trace.selected.skillName} (/${trace.selected.commandName}, score=${trace.selected.score})`
            : 'none'
          deferredSkillLogs.push(
            `[Skill] match trace: mode=${trace.mode}, reason=${trace.reason ?? 'n/a'}, query=${trace.query ?? '-'}, selected=${selectedText}`,
          )
          if (trace.candidates.length > 1) {
            const top = trace.candidates
              .slice(0, 3)
              .map((c) => `${c.skillName}/${c.commandName}@${c.score}`)
              .join(', ')
            deferredSkillLogs.push(`[Skill] match candidates: ${top}${trace.candidates.length > 3 ? ' ...' : ''}`)
          }
        }
        if (match) {
          const skillName = match.command.skillName
          deferredSkillLogs.push(`[Skill] matched: ${skillName} (/${match.command.name})`)

          const loaded = await this.skillManager.readSkillContent(skillName, skillRuntimeOptions)
          if (loaded) {
            const skillBody = clampText(loaded.content, 24000)
            skillSystemMessages.push({
              role: 'system',
              content:
                `本轮请求已显式指定技能：${loaded.skill.name}。\n` +
                `请严格优先遵循该技能步骤；若技能与系统安全/工具事实冲突，以系统规则与工具输出为准。`,
            })
            skillSystemMessages.push({
              role: 'system',
              content: `【SKILL: ${loaded.skill.name}】\n来源：${loaded.skill.filePath}\n\n${skillBody}`,
            })
          } else {
            deferredSkillLogs.push(`[Skill] read failed: ${skillName}`)
            skillSystemMessages.push({
              role: 'system',
              content:
                `本轮请求已显式指定技能：${skillName}，但系统读取技能文件失败。` +
                `请根据用户请求继续执行；如需要可尝试用 skill.read 读取技能文件。`,
            })
          }

          const argsText = (match.args ?? '').trim()
          effectiveAgentRequest = argsText || `请按已指定技能「${skillName}」完成本次请求。`
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deferredSkillLogs.push(`[Skill] setup skipped: ${clampText(msg, 160)}`)
    }

    const visionAttachLogs: string[] = []
    const readInspectAnswer = (raw: string): string => {
      const text = String(raw ?? '').trim()
      const first = text.indexOf('{')
      const last = text.lastIndexOf('}')
      if (first >= 0 && last > first) {
        try {
          const parsed = JSON.parse(text.slice(first, last + 1)) as { answer?: unknown }
          if (typeof parsed.answer === 'string' && parsed.answer.trim()) return parsed.answer.trim()
        } catch {
          // Fall through to the raw text. The fallback model output is still useful evidence.
        }
      }
      return text || '(外挂视觉未返回观察结果)'
    }
    const inspectArtifactsWithFallback = async (artifacts: VisualArtifactRef[], question: string): Promise<string> => {
      if (!fallbackProfile) throw new Error('未配置可用的外挂视觉 Profile')
      const observations: string[] = []
      for (const artifact of artifacts.slice(0, maxVisionImages)) {
        const raw = await this.executeToolByName(
          'image.inspect',
          {
            path: artifact.path,
            prompt:
              `${question.trim() || '客观描述图片中可见的主体、文字、构图和关键细节。'}\n` +
              '只输出可见事实；不扮演桌宠人设，不替用户或主助手下结论。',
            apiMode: fallbackProfile.apiMode,
            apiKey: fallbackProfile.apiKey,
            baseUrl: fallbackProfile.baseUrl,
            model: fallbackProfile.model,
            maxTokens: 800,
          },
          task,
          rt,
        )
        observations.push(`- ${artifact.id}：${readInspectAnswer(raw)}`)
      }
      return observations.join('\n')
    }
    const formatVisualCatalog = (): string => {
      const artifacts = listVisualArtifacts()
      if (artifacts.length === 0) return ''
      const lines = artifacts.map((artifact) => {
        const position = artifact.index && artifact.total ? `，组内 ${artifact.index}/${artifact.total}` : ''
        return `- ${artifact.id}（来源 ${artifact.source}${position}）`
      })
      return [
        '【近期视觉目录】以下只是可选图片的安全 ID 和来源，图片内容尚未注入，你现在看不到它们。',
        ...lines,
        '只有当回答确实需要图片内容时才调用 vision.look；用户只是称赞、闲聊、说“继续”或明确说不要看图时不要调用。',
        '需要查看第几张或比较多张时，只选择对应 artifactIds，并保持用户指定顺序。禁止猜测 ID、文件路径或图片内容。',
      ].join('\n')
    }

    const initialRoute =
      initialVisionArtifacts.length > 0
        ? decideVisionRoute({
            routingMode: settings.ai.visionRoutingMode,
            capability: effectiveMainVisionCapability,
            hasFallback: Boolean(fallbackProfile),
            mainAvailable: Boolean(String(settings.ai.baseUrl ?? '').trim() && String(settings.ai.model ?? '').trim()),
          })
        : 'off'
    let mainVisionArtifacts = initialRoute === 'main' ? initialVisionArtifacts : []
    let initialFallbackObservation = ''
    if (initialRoute === 'fallback') {
      try {
        initialFallbackObservation = await inspectArtifactsWithFallback(initialVisionArtifacts, effectiveAgentRequest)
        visionAttachLogs.push(`[Vision] 外挂 ${initialVisionArtifacts.length}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        visionAttachLogs.push(`[Vision] 外挂失败：${clampText(msg, 160)}`)
      }
    } else if (initialRoute === 'main') {
      visionAttachLogs.push(`[Vision] 主模型 ${initialVisionArtifacts.length}`)
    } else if (initialVisionArtifacts.length > 0) {
      visionAttachLogs.push('[Vision] 不支持或未配置可用视觉路由')
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
    const live2dParamAddon = buildLive2dParamSystemAddon(String(settings.live2dModelFile ?? ''))
    if (live2dParamAddon) messages.push({ role: 'system', content: live2dParamAddon })
    messages.push({
      role: 'system',
      content:
        '重要：工具输出是事实来源。严禁编造/猜测工具执行结果。若工具输出为空、乱码或无法解析，必须明确说明失败，并优先重试或改用更稳的命令（例如 PowerShell 加 -NoProfile）。browser.open 打开的是系统浏览器，不能后续自动化；凡是需要搜索、点击、打开结果、截图或提取页面状态的网页任务，必须使用可控浏览器工具链。若工具返回新活动页或 newTabs，说明页面已跳转/打开新标签，不要误判没反应；单页任务完成后可清理非活动旧标签。最终回复不要出现工具内部名（如 cli.exec/browser.open/mcp.*）；需要链接/日期等事实时，只能引用工具输出或用户提供。若用户请求截图、搜索、打开并操作、读写文件、运行命令、下载/安装/修改程序等实际行动，必须先调用工具，禁止只用自然语言声称已经完成。',
    })
    const visualCatalog = formatVisualCatalog()
    if (visualCatalog) messages.push({ role: 'system', content: visualCatalog })
    const visionImageParts =
      mainVisionArtifacts.length > 0
        ? await imageUrlPartsFromLocalPaths(
            mainVisionArtifacts.map((artifact) => artifact.path),
            maxVisionImages,
          )
        : []
    let visionSystemMsg: Record<string, unknown> | null = null
    if (visionImageParts.length > 0) {
      visionSystemMsg = {
        role: 'system',
        content:
          `本轮用户直接上传的图片已通过主模型视觉注入，对应 ID：${mainVisionArtifacts.map((artifact) => artifact.id).join('、')}。` +
          '可以直接依据这些图片回答，不要再对同一批图片调用 vision.look。其他目录图片仍未注入。',
      }
      messages.push(visionSystemMsg)
    } else if (mainVisionArtifacts.length > 0) {
      visionAttachLogs.push('[Vision] 图片失效或读取失败')
      mainVisionArtifacts = []
    }
    if (initialFallbackObservation) {
      messages.push({
        role: 'system',
        content:
          '用户本轮直接上传了图片。主助手当前没有直接读取原图；以下是外挂视觉模型返回的客观观察。' +
          '请由你继续按桌宠人设理解用户意图并组织最终回复，不要冒充外挂模型，也不要声称自己直接看到了未注入的原图。\n' +
          initialFallbackObservation,
      })
    }
    if (skillSystemMessages.length > 0) messages.push(...skillSystemMessages)

    // 注入历史对话（history），让 agent 能够理解对话上下文，避免答非所问
    const historyRaw = Array.isArray(obj?.history) ? obj.history : []
    for (const h of historyRaw) {
      if (typeof h !== 'object' || h === null) continue
      const hObj = h as Record<string, unknown>
      const role = typeof hObj.role === 'string' ? hObj.role.trim() : ''
      const content = typeof hObj.content === 'string' ? hObj.content.trim() : ''
      if ((role === 'user' || role === 'assistant') && content.length > 0) {
        messages.push({ role, content })
      }
    }
    const requestText = effectiveAgentRequest.trim()
    const lastHistoryMessage = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant')
    const lastHistoryUserText =
      lastHistoryMessage?.role === 'user' && typeof lastHistoryMessage.content === 'string'
        ? String(lastHistoryMessage.content).trim()
        : ''
    const hasSameTailUserRequest = Boolean(requestText) && lastHistoryUserText === requestText

    if (visionImageParts.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      if (effectiveAgentRequest.trim()) parts.push({ type: 'text', text: effectiveAgentRequest })
      parts.push(...visionImageParts)
      messages.push({ role: 'user', content: parts })
    } else {
      if (!hasSameTailUserRequest) messages.push({ role: 'user', content: effectiveAgentRequest })
    }

    let visionStripped = false
    const stripVisionFromUserMessage = (): boolean => {
      if (visionStripped) return false
      let changed = false
      for (const m of messages) {
        const rec = m as Record<string, unknown>
        if (rec.role !== 'user' || !Array.isArray(rec.content)) continue
        const text = rec.content
          .map((part) => {
            if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
            const value = (part as { text?: unknown }).text
            return typeof value === 'string' ? value : ''
          })
          .filter(Boolean)
          .join('\n')
          .trim()
        rec.content = text || '[image omitted: model rejected vision input]'
        changed = true
      }
      if (changed && visionSystemMsg) {
        // 同步撤销“已附带图片”的系统提示，否则剥离图片重试后模型仍会被诱导编造图片内容
        visionSystemMsg.content =
          '注意：本轮原图输入已被移除。除非下方另有外挂视觉观察，否则你现在看不到图片，禁止描述或编造图片内容。'
      }
      visionStripped = changed
      return changed
    }

    const logs: string[] = []
    let lastProgressAt = 0
    let draftReply = ''
    let live2dExpression: string | undefined
    let live2dMotion: string | undefined
    let toolRuns: TaskRecord['toolRuns'] = []
    // 累积 API 返回的 token 使用统计（多轮工具调用会累加）
    const cumulativeUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

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
      if (rt.canceled) return
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
    for (const line of deferredSkillLogs) pushLog(line, true)
    for (const line of visionAttachLogs) pushLog(line, true)

    let mainVisionFallbackApplied = false
    const recoverFromMainVisionError = async (err: unknown, status?: number): Promise<boolean> => {
      if (visionImageParts.length === 0 || visionStripped) return false
      const failureKind = classifyVisionError(err, status)
      const fallbackRoute = decideVisionRoute({
        routingMode: settings.ai.visionRoutingMode,
        capability: effectiveMainVisionCapability,
        hasFallback: Boolean(fallbackProfile),
        mainFailedKind: failureKind,
        fallbackOnTransient: settings.ai.visionFallbackOnTransient,
      })

      if (fallbackRoute === 'fallback' && !mainVisionFallbackApplied) {
        try {
          const observation = await inspectArtifactsWithFallback(mainVisionArtifacts, effectiveAgentRequest)
          if (!stripVisionFromUserMessage()) return false
          mainVisionFallbackApplied = true
          if (failureKind === 'unsupported') rememberMainVisionCapability('unsupported')
          if (visionSystemMsg) {
            visionSystemMsg.content =
              `主模型视觉请求失败，已改用外挂视觉（${failureKind === 'transient' ? '主网络失败→外挂' : '主模型不支持→外挂'}）。` +
              '以下是外挂模型的客观观察；请由你按桌宠人设组织回复，不要声称自己直接读取了原图。\n' +
              observation
          }
          pushLog(
            failureKind === 'transient'
              ? `[Vision] 主网络失败→外挂 ${mainVisionArtifacts.length}`
              : `[Vision] 主模型不支持→外挂 ${mainVisionArtifacts.length}`,
            true,
          )
          return true
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          pushLog(`[Vision] 外挂失败：${clampText(fallbackMsg, 160)}`, true)
        }
      }

      if (failureKind === 'unsupported' && stripVisionFromUserMessage()) {
        rememberMainVisionCapability('unsupported')
        pushLog('[Vision] 主模型明确不支持图片输入，已移除原图后重试', true)
        return true
      }
      return false
    }

    const toolPreview = (v: unknown, max: number) => clampText(typeof v === 'string' ? v : JSON.stringify(v ?? ''), max)
    const toolInputPreview = (toolName: string, v: unknown) => toolPreview(v, toolName === 'image.generate' ? 6000 : 500)

    const upsertToolRun = (patch: {
      id: string
      toolName: string
      status: 'running' | 'done' | 'error'
      inputPreview?: string
      outputPreview?: string
      imagePaths?: string[]
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
        imagePaths:
          Array.isArray(patch.imagePaths)
            ? normalizeImagePathList(patch.imagePaths, 8)
            : base?.imagePaths,
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
    const apiMode =
      readString(apiOverride, 'apiMode') === 'claude' || (baseAi as { apiMode?: unknown }).apiMode === 'claude'
        ? 'claude'
        : 'openai-compatible'

    const tempOverride = readNumber(apiOverride, 'temperature')
    const temperature = Math.max(0, Math.min(2, tempOverride ?? prefer.temperature))

    const maxTokensOverride = readNumber(apiOverride, 'maxTokens')
    const maxTokensCandidate = maxTokensOverride ?? prefer.maxTokens
    const maxTokensRaw =
      typeof maxTokensCandidate === 'number' && Number.isFinite(maxTokensCandidate) ? Math.trunc(maxTokensCandidate) : 900
    const thinkingEffortOverride = readString(apiOverride, 'thinkingEffort')
    const reasoningOptions = buildOpenAICompatReasoningOptions({
      model,
      maxTokens: maxTokensRaw,
      settings: {
        thinkingEffort: thinkingEffortOverride || (baseAi as { thinkingEffort?: unknown }).thinkingEffort,
        thinkingProvider:
          apiMode === 'claude'
            ? 'claude'
            : readString(apiOverride, 'thinkingProvider') || (baseAi as { thinkingProvider?: unknown }).thinkingProvider,
        openaiReasoningEffort:
          readString(apiOverride, 'openaiReasoningEffort') || (baseAi as { openaiReasoningEffort?: unknown }).openaiReasoningEffort,
        claudeThinkingEffort:
          readString(apiOverride, 'claudeThinkingEffort') || (baseAi as { claudeThinkingEffort?: unknown }).claudeThinkingEffort,
        geminiThinkingEffort:
          readString(apiOverride, 'geminiThinkingEffort') || (baseAi as { geminiThinkingEffort?: unknown }).geminiThinkingEffort,
      },
      claudeDisabledMinMaxTokens: 2048,
    })
    const maxTokens = reasoningOptions.maxTokens
    const timeoutMs =
      typeof obj?.timeoutMs === 'number'
        ? Math.max(2000, Math.min(180000, Math.trunc(obj.timeoutMs)))
        : Math.max(2000, Math.min(180000, Math.trunc(prefer.timeoutMs)))
    if (!baseUrl || !model) throw new Error('未配置工具 LLM baseUrl/model（设置 → AI 设置 → 工具/Agent 或 AI 设置）')

    const endpoint = buildAgentEndpoint(baseUrl, apiMode)
    const headers = buildAgentHeaders(apiMode, apiKey)
    const llmClient = new TaskAgentLlmClient({
      apiMode,
      endpoint,
      headers,
      model,
      temperature,
      maxTokens,
      reasoningExtra: reasoningOptions.extra,
      messages,
      tools,
      sessionId: task.id,
      timeoutMs,
      isCanceled: () => rt.canceled,
      setCancelCurrent: (cancel) => {
        rt.cancelCurrent = cancel
      },
      recoverFromVisionError: recoverFromMainVisionError,
      onRequestSucceeded: () => {
        if (mainVisionArtifacts.length > 0 && !visionStripped) rememberMainVisionCapability('supported')
      },
      onRetry: ({ delayMs, errorMessage, nextAttempt, totalAttempts }) => {
        pushLog(
          `[Agent] LLM 请求失败，${delayMs}ms 后重试 (${nextAttempt}/${totalAttempts})：${clampText(errorMessage, 120)}`,
          true,
        )
      },
    })

    type AgentToolExecution = {
      output: string
      modelOutput?: string
      images: Array<{ mimeType: string; data: string }>
      imagePaths: string[]
      visionParts?: Array<Record<string, unknown>>
    }

    const executeTextToolCall = async (
      toolNameRaw: string,
      input: ToolInput,
    ): Promise<AgentToolExecution> => {
      const resolvedTool = toolCatalog.resolveTextName(toolNameRaw)
      const def = resolvedTool.def
      if (!def) {
        const suggestions = toolCatalog.suggestNames(resolvedTool.cleanedName || toolNameRaw)
        const suffix = suggestions.length ? `；相近可用工具：${suggestions.join('、')}` : ''
        const cleaned = resolvedTool.cleanedName && resolvedTool.cleanedName !== toolNameRaw ? `（清洗后：${resolvedTool.cleanedName}）` : ''
        throw new Error(`未知工具：${toolNameRaw}${cleaned}${suffix}`)
      }

      if (resolvedTool.requestedName !== def.name || resolvedTool.aliasApplied) {
        const via = resolvedTool.aliasApplied ? ' alias' : ''
        pushLog(`[Tool] normalize${via}: ${resolvedTool.requestedName || toolNameRaw} -> ${def.name}`, true)
      }

      const key = makeToolCallKey(def.name, input)
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
        const imagePaths = await this.resolveToolImagePaths(task.id, out, res.images)
        const exec = { output: out, images: res.images, imagePaths }
        executedCalls.set(key, exec)
        return exec
      }

      const out = await this.executeToolByName(def.name, input, task, rt)
      const imagePaths = await this.resolveToolImagePaths(task.id, out, [])
      const exec = { output: out, images: [] as Array<{ mimeType: string; data: string }>, imagePaths }
      executedCalls.set(key, exec)
      return exec
    }

    pushLog(`[Agent] request: ${clampText(request, 120)}`, true)

    const executedCalls = new Map<string, AgentToolExecution>()
    const executedCallOrder: Array<{ toolName: string; input: ToolInput; output: string }> = []

    const buildEvidenceText = (): string => {
      const parts: string[] = []
      if (request.trim()) parts.push(request.trim())
      for (const r of executedCallOrder) {
        if (typeof r?.output === 'string' && r.output.trim()) parts.push(r.output)
      }
      return parts.join('\n\n')
    }

    const hasAnyFinishedToolRun = (): boolean => Array.isArray(toolRuns) && toolRuns.some((r) => r.status === 'done' || r.status === 'error')

    const registerToolVisualArtifacts = (toolName: string, runId: string, imagePaths: string[]): VisualArtifactRef[] => {
      if (!VISION_RESULT_TOOL_NAMES.has(toolName)) return []
      const paths = normalizeImagePathList(imagePaths, 8)
      const total = paths.length
      const groupId = `${task.id}:${runId}`
      return paths.map((imagePath, index) => {
        const artifact: VisualArtifactRef = {
          id: `vis_${task.id}_${runId}_${index + 1}`,
          path: imagePath,
          source: toolName as VisualArtifactRef['source'],
          groupId,
          index: index + 1,
          total,
          taskId: task.id,
          runId,
          createdAt: now(),
        }
        visualContext.artifacts.set(artifact.id, artifact)
        return artifact
      })
    }

    const sanitizeToolOutputForModel = (raw: string, artifacts: VisualArtifactRef[]): string => {
      if (artifacts.length === 0) return String(raw ?? '')
      return (
        `[工具执行成功；视觉产物已登记，但尚未查看图片内容]\n` +
        artifacts
          .map((artifact) => `- ${artifact.id}（${artifact.index ?? 1}/${artifact.total ?? artifacts.length}）`)
          .join('\n') +
        '\n只有确实需要图片内容时才调用 vision.look；不要根据生成提示词、文件名或路径猜测成图。'
      )
    }

    const executeVisionLook = async (input: ToolInput): Promise<AgentToolExecution> => {
      const value = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
      const artifacts = resolveVisualArtifacts(value?.artifactIds)
      if (artifacts.length === 0) throw new Error('vision.look 未收到当前会话中有效的 artifactIds')
      const requestedIds = Array.isArray(value?.artifactIds)
        ? value.artifactIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : []
      if (artifacts.length !== Math.min(requestedIds.length, maxVisionImages)) {
        throw new Error('vision.look 包含未知、重复或超出上限的 artifactId')
      }
      const question = typeof value?.question === 'string' ? value.question.trim() : ''
      const route = decideVisionRoute({
        routingMode: settings.ai.visionRoutingMode,
        capability: effectiveMainVisionCapability,
        hasFallback: Boolean(fallbackProfile),
        mainFailedKind: mainVisionFallbackApplied ? 'unsupported' : null,
        fallbackOnTransient: settings.ai.visionFallbackOnTransient,
      })

      if (route === 'main') {
        const visionParts = await imageUrlPartsFromLocalPaths(
          artifacts.map((artifact) => artifact.path),
          maxVisionImages,
        )
        if (visionParts.length === 0) throw new Error('所选图片不存在、过大或无法读取')
        mainVisionArtifacts = artifacts
        pushLog(`[Vision] 主模型 ${visionParts.length}`, true)
        return {
          output: JSON.stringify({ ok: true, route: 'main-native', artifactIds: artifacts.map((artifact) => artifact.id) }),
          modelOutput: `已按顺序附带 ${visionParts.length} 张所选图片；请直接依据图片回答问题：${question || '客观查看图片内容'}`,
          images: [],
          imagePaths: [],
          visionParts,
        }
      }

      if (route === 'fallback') {
        const observation = await inspectArtifactsWithFallback(artifacts, question)
        pushLog(`[Vision] 外挂 ${artifacts.length}`, true)
        return {
          output: JSON.stringify({
            ok: true,
            route: 'fallback-observation',
            artifactIds: artifacts.map((artifact) => artifact.id),
            observation,
          }),
          modelOutput:
            '以下内容来自外挂视觉模型的客观观察。请由你按桌宠人设组织最终回复，不要把外挂模型当成说话者，也不要声称主模型直接读取了原图。\n' +
            observation,
          images: [],
          imagePaths: [],
        }
      }

      if (route === 'off') throw new Error('视觉路由已关闭')
      throw new Error('当前没有可用的视觉提供方；请检查主模型能力或外挂视觉 Profile')
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
      return text.replace(/\b(?:mcp|cli|browser|file|llm|delay|vision|image)\.[A-Za-z0-9_:\-./]+/g, '').replace(/[ \t]{2,}/g, ' ')
    }

    const validateFinalText = (finalText: string): { ok: true } | { ok: false; reason: string } => {
      const text = (finalText ?? '').trim()
      if (!text) return { ok: true }

      const internalNameHit = /\b(?:mcp|cli|browser|file|llm|delay|vision|image)\.[A-Za-z0-9_:\-./]+/g.test(text)
      if (internalNameHit) return { ok: false, reason: '最终回复包含工具内部名（如 cli.exec/browser.open/mcp.*）' }

      if (!hasAnyFinishedToolRun() && finalTextClaimsToolAction(text)) {
        return { ok: false, reason: '最终回复声称已调用/执行工具，但本轮没有任何工具执行记录' }
      }

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
        // 保存累积的 usage 统计到任务（用于前端上下文悬浮球）
        if (cumulativeUsage.totalTokens > 0) {
          it.usage = { ...cumulativeUsage }
        }
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
        const draftBase = draftReply
        let turnRaw = ''
        const applyTurnDraft = (raw: string, force?: boolean) => {
          const extracted = extractLive2dTags(raw)
          if (extracted.expression) live2dExpression = extracted.expression
          if (extracted.motion) live2dMotion = extracted.motion
          const piece = extracted.cleanedText
          if (piece) {
            draftReply = draftBase ? `${draftBase}\n${piece}` : piece
            updateProgress(force)
            return
          }
          if (extracted.expression || extracted.motion) updateProgress(force)
        }

        const { contentText, toolCalls, assistantMsgRaw } = await llmClient.callNative({
          onDelta: (delta) => {
            if (rt.canceled) throw new Error('canceled')
            turnRaw += delta
            applyTurnDraft(turnRaw)
          },
        })
        messages.push(assistantMsgRaw)
        applyTurnDraft(contentText, true)

        if (!toolCalls.length) {
          if (hasToolRequestMarker(contentText)) {
            throw new Error('native response used text TOOL_REQUEST protocol without tool_calls')
          }
          pushLog('[Agent] done', true)
          const fin = tryFinalizeOrContinue(contentText, turn)
          if (fin.done) return fin.text
          continue
        }

        pushLog(`[Agent] tool_calls: ${toolCalls.map((c) => c.function.name).join(', ')}`)
        const pendingVisionMessages: Array<Record<string, unknown>> = []

        for (const call of toolCalls) {
          await this.waitIfPaused(task.id)
          if (rt.canceled) throw new Error('canceled')

          const def = toolCatalog.resolveCallName(call.function.name)
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
            inputPreview: toolInputPreview(def.name, toolInput),
            startedAt: now(),
          })

          let toolOut = ''
          let toolImagePaths: string[] = []
          let toolExec: AgentToolExecution | null = null
          try {
            const key = makeToolCallKey(def.name, toolInput)
            const cached = executedCalls.get(key)
            if (cached && typeof cached === 'object') {
              pushLog(`[Tool] ${def.name} skip duplicate`, true)
              toolExec = cached
              toolOut = cached.output
              toolImagePaths = Array.isArray(cached.imagePaths) ? cached.imagePaths : []
            } else {
              if (def.name === 'vision.look') {
                toolExec = await executeVisionLook(toolInput)
                toolOut = toolExec.output
                toolImagePaths = []
                executedCalls.set(key, toolExec)
              } else if (def.name.startsWith('mcp.') && this.mcpManager) {
                const res = await this.mcpManager.callToolDetailed(def.name, toolInput)
                toolOut = res.text
                toolImagePaths = await this.resolveToolImagePaths(task.id, toolOut, res.images)
                toolExec = { output: toolOut, images: res.images, imagePaths: toolImagePaths }
                executedCalls.set(key, toolExec)
              } else {
                toolOut = await this.executeToolByName(def.name, toolInput, task, rt)
                toolImagePaths = await this.resolveToolImagePaths(task.id, toolOut, [])
                toolExec = { output: toolOut, images: [], imagePaths: toolImagePaths }
                executedCalls.set(key, toolExec)
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toolOut = `[error] ${msg}`
            const key = makeToolCallKey(def.name, toolInput)
            if (!executedCalls.has(key)) {
              toolExec = { output: toolOut, images: [], imagePaths: [] }
              executedCalls.set(key, toolExec)
            }
            upsertToolRun({
              id: call.id,
              toolName: def.name,
              status: 'error',
              error: clampText(msg, 800),
              outputPreview: clampText(toolOut, 800),
              imagePaths: [],
              endedAt: now(),
            })
          }

          const artifacts = registerToolVisualArtifacts(def.name, call.id, toolImagePaths)
          const modelToolOutput =
            toolExec?.modelOutput ?? (artifacts.length > 0 ? sanitizeToolOutputForModel(toolOut, artifacts) : toolOut)
          if (!executedCallOrder.some((entry) => entry.toolName === def.name && stableStringify(entry.input) === stableStringify(toolInput))) {
            executedCallOrder.push({ toolName: def.name, input: toolInput, output: modelToolOutput })
          }
          const toolMsg = clampText(modelToolOutput, 4000) || '(空)'
          pushLog(`[Tool] ${def.name} done`)
          upsertToolRun({
            id: call.id,
            toolName: def.name,
            status: toolOut.startsWith('[error]') ? 'error' : 'done',
            outputPreview: clampText(toolOut, 800),
            imagePaths: toolImagePaths,
            endedAt: now(),
          })
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: toolMsg })
          const visionParts = toolExec?.visionParts ?? []
          if (visionParts.length > 0) {
            pendingVisionMessages.push({
              role: 'user',
              content: [{ type: 'text', text: toolMsg }, ...visionParts],
            })
          }
        }
        if (pendingVisionMessages.length > 0) messages.push(...pendingVisionMessages)
      }

      pushLog('[Agent] reach maxTurns, stop', true)
      return finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
    }

    const runText = async (): Promise<string> => {
      const guide = toolCatalog.buildTextModeGuide(settings.novelai?.promptRules)
      const userIdx = messages.findIndex((m) => m.role === 'user')
      if (userIdx > 0) messages.splice(userIdx, 0, { role: 'system', content: guide })
      else messages.push({ role: 'system', content: guide })

      for (let turn = 0; turn < maxTurns; turn += 1) {
        await this.waitIfPaused(task.id)
        if (rt.canceled) throw new Error('canceled')

        pushLog(`[Agent] turn ${turn + 1}/${maxTurns}`)
        const draftBase = draftReply
        let turnRaw = ''
        const applyTurnDraft = (raw: string, force?: boolean) => {
          const display = stripToolRequestBlocksForDisplay(raw)
          const extracted = extractLive2dTags(display)
          if (extracted.expression) live2dExpression = extracted.expression
          if (extracted.motion) live2dMotion = extracted.motion
          const piece = extracted.cleanedText
          if (piece) {
            draftReply = draftBase ? `${draftBase}\n${piece}` : piece
            updateProgress(force)
            return
          }
          if (extracted.expression || extracted.motion) updateProgress(force)
        }

        const { contentText, assistantMsgRaw, usage } = await llmClient.callText({
          stopOnToolRequest: true,
          onDelta: (delta) => {
            if (rt.canceled) throw new Error('canceled')
            turnRaw += delta
            applyTurnDraft(turnRaw)
          },
        })
        messages.push(assistantMsgRaw)

        // 累积本次 API 调用的 usage
        if (usage) {
          cumulativeUsage.promptTokens += usage.promptTokens
          cumulativeUsage.completionTokens += usage.completionTokens
          cumulativeUsage.totalTokens += usage.totalTokens
        }

        const { cleaned, calls } = toolCatalog.parseTextRequests(contentText)
        applyTurnDraft(cleaned, true)
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
            inputPreview: toolInputPreview(c.toolName, c.input ?? {}),
            startedAt: now(),
          })

          let toolOut = ''
          let toolImagePaths: string[] = []
          let toolExec: AgentToolExecution | null = null
          try {
            const key = makeToolCallKey(c.toolName, c.input ?? {})
            const cached = executedCalls.get(key)
            if (cached && typeof cached === 'object') {
              pushLog(`[Tool] ${c.toolName} skip duplicate`, true)
              toolExec = cached
              toolOut = cached.output
              toolImagePaths = Array.isArray(cached.imagePaths) ? cached.imagePaths : []
            } else {
              toolExec = c.toolName === 'vision.look' ? await executeVisionLook(c.input) : await executeTextToolCall(c.toolName, c.input)
              toolOut = toolExec.output
              toolImagePaths = Array.isArray(toolExec.imagePaths) ? toolExec.imagePaths : []
              executedCalls.set(key, toolExec)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toolOut = `[error] ${msg}`
            const key = makeToolCallKey(c.toolName, c.input ?? {})
            if (!executedCalls.has(key)) {
              toolExec = { output: toolOut, images: [], imagePaths: [] }
              executedCalls.set(key, toolExec)
            }
            upsertToolRun({
              id: runId,
              toolName: c.toolName,
              status: 'error',
              error: clampText(msg, 800),
              outputPreview: clampText(toolOut, 800),
              imagePaths: [],
              endedAt: now(),
            })
          }

          const artifacts = registerToolVisualArtifacts(c.toolName, runId, toolImagePaths)
          const modelToolOutput =
            toolExec?.modelOutput ?? (artifacts.length > 0 ? sanitizeToolOutputForModel(toolOut, artifacts) : toolOut)
          if (!executedCallOrder.some((entry) => entry.toolName === c.toolName && stableStringify(entry.input) === stableStringify(c.input ?? {}))) {
            executedCallOrder.push({ toolName: c.toolName, input: c.input ?? {}, output: modelToolOutput })
          }
          const toolMsg = clampText(modelToolOutput, 4000) || '(空)'
          pushLog(`[Tool] ${c.toolName} done`)
          upsertToolRun({
            id: runId,
            toolName: c.toolName,
            status: toolOut.startsWith('[error]') ? 'error' : 'done',
            outputPreview: clampText(toolOut, 800),
            imagePaths: toolImagePaths,
            endedAt: now(),
          })

          const toolResultBlock = buildToolResultBlock(c.toolName, toolMsg)

          const visionParts = toolExec?.visionParts ?? []
          if (visionParts.length > 0) {
            messages.push({
              role: 'user',
              content: [{ type: 'text', text: toolResultBlock }, ...visionParts],
            })
          } else {
            messages.push({ role: 'user', content: toolResultBlock })
          }
        }
      }

      pushLog('[Agent] reach maxTurns, stop', true)
      return finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
    }

    if (apiMode === 'claude') {
      if (mode !== 'text') pushLog('[Agent] Claude Messages API uses text tool protocol for compatibility', true)
      return runText()
    }
    if (mode === 'text') return runText()
    if (mode === 'native') return runNative()

    try {
      return await runNative()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (rt.canceled || isAbortLikeError(err) || /^cancell?ed$/i.test(msg.trim())) {
        throw err
      }
      // 自适应：auto 模式下若检测到 thought_signature/thoughtSignature 兼容错误，则本次回退到 text（不修改用户设置）
      if (modeRaw === 'auto' && /thought[_ ]?signature/i.test(msg)) {
        pushLog('[Agent] auto detected native tools incompatibility, fallback to text', true)
      }
      pushLog(`[Agent] native tools failed, fallback to text: ${clampText(msg, 240)}`, true)

      messages.splice(0, messages.length)
      messages.push({ role: 'system', content: system })
      if (extraContext) messages.push({ role: 'system', content: extraContext })

      // 回退到 text 协议时也要保留 Live2D 的系统注入，否则模型会丢失“参数语义/可用表情动作”上下文，容易乱调参数
      const live2dHints = readLive2dTagHintsFromModelFile(String(settings.live2dModelFile ?? ''))
      const live2dAddon = buildLive2dTagSystemAddon(live2dHints)
      if (live2dAddon) messages.push({ role: 'system', content: live2dAddon })
      const live2dParamAddon = buildLive2dParamSystemAddon(String(settings.live2dModelFile ?? ''))
      if (live2dParamAddon) messages.push({ role: 'system', content: live2dParamAddon })
      messages.push({
        role: 'system',
        content:
          '重要：工具输出是事实来源。严禁编造/猜测工具执行结果。若工具输出为空、乱码或无法解析，必须明确说明失败，并优先重试或改用更稳的命令（例如 PowerShell 加 -NoProfile）。browser.open 打开的是系统浏览器，不能后续自动化；凡是需要搜索、点击、打开结果、截图或提取页面状态的网页任务，必须使用可控浏览器工具链。若工具返回新活动页或 newTabs，说明页面已跳转/打开新标签，不要误判没反应；单页任务完成后可清理非活动旧标签。最终回复不要出现工具内部名（如 cli.exec/browser.open/mcp.*）；需要链接/日期等事实时，只能引用工具输出或用户提供。若用户请求截图、搜索、打开并操作、读写文件、运行命令、下载/安装/修改程序等实际行动，必须先调用工具，禁止只用自然语言声称已经完成。',
      })
      if (visualCatalog) messages.push({ role: 'system', content: visualCatalog })
      if (visionSystemMsg) messages.push({ ...visionSystemMsg })
      if (initialFallbackObservation && !mainVisionFallbackApplied) {
        messages.push({
          role: 'system',
          content:
            '以下是外挂视觉模型对用户本轮上传图片的客观观察；请由你按桌宠人设组织回复。\n' +
            initialFallbackObservation,
        })
      }
      if (skillSystemMessages.length > 0) messages.push(...skillSystemMessages)

      const fallbackVisionParts =
        !visionStripped && mainVisionArtifacts.length > 0
          ? await imageUrlPartsFromLocalPaths(
              mainVisionArtifacts.map((artifact) => artifact.path),
              maxVisionImages,
            )
          : []
      messages.push({
        role: 'user',
        content:
          fallbackVisionParts.length > 0
            ? [{ type: 'text', text: effectiveAgentRequest }, ...fallbackVisionParts]
            : effectiveAgentRequest,
      })

      if (executedCallOrder.length > 0) {
        messages.push({
          role: 'system',
          content: `注意：以下工具已执行完成（或已得到错误结果）。除非需要不同参数，否则不要重复调用同名同参工具；请基于 TOOL_RESULT 直接给出最终答复。`,
        })
        for (const r of executedCallOrder) {
          const toolMsg = clampText(r.output, 4000) || '(空)'
          messages.push({ role: 'user', content: buildToolResultBlock(r.toolName, toolMsg) })
        }
      }

      return runText()
    }
  }

  private async runTask(id: string): Promise<void> {
    const rt = this.runtime.ensure(id)
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
        const directRunId = `step-${step?.id || idx}`
        if (!step) {
          this.writeState((draft) => {
            const it = draft.tasks.find((x) => x.id === id)
            if (!it) return
            it.status = 'done'
            it.updatedAt = now()
            it.endedAt = now()
          })
          this.runtime.delete(id)
          this.scheduler.kick()
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
          if (shouldRecordStepToolRun(s.tool)) {
            const prev = Array.isArray(it.toolRuns) ? it.toolRuns.filter((r) => r.id !== directRunId) : []
            it.toolRuns = [
              ...prev,
              {
                id: directRunId,
                toolName: s.tool,
                status: 'running' as const,
                inputPreview: clampText(s.input || '{}', s.tool === 'image.generate' ? 6000 : 500),
                startedAt: s.startedAt ?? now(),
              },
            ].slice(0, 80)
          }
        })

        await this.waitIfPaused(id)
        if (rt.canceled) return

        const toolInput = parseToolInput(step.input)
        const output = await this.runTool(step.tool, toolInput, t, rt)
        const imagePaths = step.tool ? await this.resolveToolImagePaths(id, output, []) : []

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
          if (shouldRecordStepToolRun(s.tool)) {
            const prev = Array.isArray(it.toolRuns) ? it.toolRuns : []
            const base = prev.find((r) => r.id === directRunId)
            it.toolRuns = [
              ...prev.filter((r) => r.id !== directRunId),
              {
                id: directRunId,
                toolName: s.tool,
                status: 'done' as const,
                inputPreview: base?.inputPreview ?? clampText(s.input || '{}', s.tool === 'image.generate' ? 6000 : 500),
                outputPreview: clampText(output, 800),
                imagePaths: normalizeImagePathList(imagePaths, 8),
                startedAt: base?.startedAt ?? s.startedAt ?? now(),
                endedAt: now(),
              },
            ].slice(0, 80)
          }
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
          if (shouldRecordStepToolRun(s.tool)) {
            const runId = `step-${s.id || it.currentStepIndex}`
            const prev = Array.isArray(it.toolRuns) ? it.toolRuns : []
            const base = prev.find((r) => r.id === runId)
            it.toolRuns = [
              ...prev.filter((r) => r.id !== runId),
              {
                id: runId,
                toolName: s.tool,
                status: 'error' as const,
                inputPreview: base?.inputPreview ?? clampText(s.input || '{}', s.tool === 'image.generate' ? 6000 : 500),
                error: it.lastError,
                startedAt: base?.startedAt ?? s.startedAt ?? now(),
                endedAt: now(),
              },
            ].slice(0, 80)
          }
        }
      })
    } finally {
      rt.cancelCurrent = undefined
      this.runtime.delete(id)
      this.visualContextByTask.delete(id)
      this.scheduler.kick()
    }
  }

  private writeState(mutator: (draft: TaskStoreState) => void): void {
    this.taskStore.update(mutator)
  }
}
