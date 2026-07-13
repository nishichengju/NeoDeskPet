import type { ToolInput } from '../toolExecutor'
import type { VisualArtifactRef } from '../types'
import {
  classifyVisionError,
  decideVisionRoute,
  type VisionCapability,
  type VisionRoute,
  type VisionRoutingMode,
} from '../visionRouter'
import { isAbortLikeError } from './taskAgentLlmProtocol'
import type { TaskAgentToolExecution } from './taskAgentToolSession'

const VISION_RESULT_TOOL_NAMES = new Set(['image.generate', 'screen.capture', 'browser.screenshot'])
const MAX_CATALOG_ARTIFACTS = 24
const MAX_TOOL_ARTIFACTS = 8

export type TaskAgentVisualContext = {
  artifacts: Map<string, VisualArtifactRef>
  initialVisionIds: string[]
}

export type TaskAgentVisionMessage = Record<string, unknown>

export type TaskAgentVisionSessionOptions = {
  taskId: string
  taskCreatedAt: number
  visualContext: TaskAgentVisualContext
  legacyImagePaths?: unknown[]
  maxImages: number
  routingMode: VisionRoutingMode
  mainCapability: VisionCapability
  mainAvailable: boolean
  fallbackAvailable: boolean
  fallbackOnTransient: boolean
  loadImageParts: (paths: string[], limit: number) => Promise<Array<Record<string, unknown>>>
  inspectFallbackArtifact: (artifact: VisualArtifactRef, question: string) => Promise<string>
  rememberMainCapability: (capability: 'supported' | 'unsupported') => void
  pushLog: (line: string, force?: boolean) => void
  isCanceled?: () => boolean
  now?: () => number
}

export type TaskAgentInitialVisionState = {
  route: VisionRoute
  artifacts: VisualArtifactRef[]
  imageParts: Array<Record<string, unknown>>
}

export function canonicalizeImageRef(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^[a-zA-Z]:[\\/]/.test(text)) return text.replace(/\\{2,}/g, '\\')
  if (text.startsWith('\\\\')) return `\\${text.replace(/\\{2,}/g, '\\')}`
  return text
}

export function normalizeImagePathList(values: unknown[], limit = MAX_TOOL_ARTIFACTS): string[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_TOOL_ARTIFACTS
  if (!Array.isArray(values) || max <= 0) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const imagePath = canonicalizeImageRef(value)
    if (!imagePath || seen.has(imagePath)) continue
    seen.add(imagePath)
    paths.push(imagePath)
    if (paths.length >= max) break
  }
  return paths
}

export function normalizeVisualArtifacts(values: unknown, limit = MAX_CATALOG_ARTIFACTS): VisualArtifactRef[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_CATALOG_ARTIFACTS
  if (!Array.isArray(values) || max <= 0) return []
  const artifacts: VisualArtifactRef[] = []
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
      const number = Number(value[key])
      return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : undefined
    }
    seen.add(id)
    artifacts.push({
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
    if (artifacts.length >= max) break
  }
  return artifacts
}

export class TaskAgentVisionSession {
  private readonly taskId: string
  private readonly taskCreatedAt: number
  private readonly visualContext: TaskAgentVisualContext
  private readonly maxImages: number
  private readonly routingMode: VisionRoutingMode
  private mainCapability: VisionCapability
  private readonly mainAvailable: boolean
  private readonly fallbackAvailable: boolean
  private readonly fallbackOnTransient: boolean
  private readonly loadImageParts: TaskAgentVisionSessionOptions['loadImageParts']
  private readonly inspectFallbackArtifact: TaskAgentVisionSessionOptions['inspectFallbackArtifact']
  private readonly rememberCapability: TaskAgentVisionSessionOptions['rememberMainCapability']
  private readonly pushLog: TaskAgentVisionSessionOptions['pushLog']
  private readonly isCanceled: () => boolean
  private readonly now: () => number

  private prepared = false
  private initialRoute: VisionRoute = 'off'
  private initialVisionArtifacts: VisualArtifactRef[] = []
  private initialVisionParts: Array<Record<string, unknown>> = []
  private initialFallbackObservation = ''
  private mainVisionArtifacts: VisualArtifactRef[] = []
  private mainVisionQuestion = ''
  private visionSystemMessage: TaskAgentVisionMessage | null = null
  private visionStripped = false
  private mainVisionFallbackApplied = false

  constructor(options: TaskAgentVisionSessionOptions) {
    this.taskId = options.taskId
    this.taskCreatedAt = options.taskCreatedAt
    this.visualContext = options.visualContext
    this.maxImages = Math.max(1, Math.min(MAX_TOOL_ARTIFACTS, Math.trunc(options.maxImages) || 1))
    this.routingMode = options.routingMode
    this.mainCapability = options.mainCapability
    this.mainAvailable = options.mainAvailable
    this.fallbackAvailable = options.fallbackAvailable
    this.fallbackOnTransient = options.fallbackOnTransient
    this.loadImageParts = options.loadImageParts
    this.inspectFallbackArtifact = options.inspectFallbackArtifact
    this.rememberCapability = options.rememberMainCapability
    this.pushLog = options.pushLog
    this.isCanceled = options.isCanceled ?? (() => false)
    this.now = options.now ?? Date.now
    this.registerLegacyArtifacts(options.legacyImagePaths ?? [])
  }

  async prepareInitial(question: string): Promise<TaskAgentInitialVisionState> {
    if (this.prepared) return this.initialState()
    this.prepared = true
    this.initialVisionArtifacts = this.resolveArtifacts(this.visualContext.initialVisionIds)
    this.initialRoute =
      this.initialVisionArtifacts.length > 0
        ? this.decideRoute()
        : 'off'
    this.mainVisionQuestion = question.trim()

    if (this.initialRoute === 'fallback') {
      try {
        this.initialFallbackObservation = await this.inspectArtifactsWithFallback(
          this.initialVisionArtifacts,
          this.mainVisionQuestion,
        )
        this.pushLog(`[Vision] 外挂 ${this.initialVisionArtifacts.length}`)
      } catch (error) {
        if (this.shouldRethrowCancellation(error)) throw error
        this.pushLog(`[Vision] 外挂失败：${previewText(errorMessage(error), 160)}`)
      }
    } else if (this.initialRoute === 'main') {
      this.mainVisionArtifacts = this.initialVisionArtifacts
      this.pushLog(`[Vision] 主模型 ${this.initialVisionArtifacts.length}`)
      this.initialVisionParts = await this.loadImageParts(
        this.mainVisionArtifacts.map((artifact) => artifact.path),
        this.maxImages,
      )
      if (this.initialVisionParts.length > 0) {
        this.visionSystemMessage = {
          role: 'system',
          content:
            `本轮用户直接上传的图片已通过主模型视觉注入，对应 ID：${this.mainVisionArtifacts.map((artifact) => artifact.id).join('、')}。` +
            '可以直接依据这些图片回答，不要再对同一批图片调用 vision.look。其他目录图片仍未注入。',
        }
      } else {
        this.pushLog('[Vision] 图片失效或读取失败')
        this.mainVisionArtifacts = []
      }
    } else if (this.initialVisionArtifacts.length > 0) {
      this.pushLog('[Vision] 不支持或未配置可用视觉路由')
    }

    return this.initialState()
  }

  listArtifacts(): VisualArtifactRef[] {
    return Array.from(this.visualContext.artifacts.values()).slice(-MAX_CATALOG_ARTIFACTS)
  }

  resolveArtifacts(ids: unknown): VisualArtifactRef[] {
    if (!Array.isArray(ids)) return []
    const artifacts: VisualArtifactRef[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
      const id = String(raw ?? '').trim()
      const artifact = this.visualContext.artifacts.get(id)
      if (!artifact || seen.has(id)) continue
      seen.add(id)
      artifacts.push(artifact)
      if (artifacts.length >= this.maxImages) break
    }
    return artifacts
  }

  buildCatalogMessage(): TaskAgentVisionMessage | null {
    const artifacts = this.listArtifacts()
    if (artifacts.length === 0) return null
    const lines = artifacts.map((artifact) => {
      const position = artifact.index && artifact.total ? `，组内 ${artifact.index}/${artifact.total}` : ''
      return `- ${artifact.id}（来源 ${artifact.source}${position}）`
    })
    return {
      role: 'system',
      content: [
        '【近期视觉目录】以下只是可选图片的安全 ID 和来源，图片内容尚未注入，你现在看不到它们。',
        ...lines,
        '只有当回答确实需要图片内容时才调用 vision.look；用户只是称赞、闲聊、说“继续”或明确说不要看图时不要调用。',
        '需要查看第几张或比较多张时，只选择对应 artifactIds，并保持用户指定顺序。禁止猜测 ID、文件路径或图片内容。',
      ].join('\n'),
    }
  }

  appendInitialSystemMessages(messages: TaskAgentVisionMessage[]): void {
    if (this.visionSystemMessage) messages.push(this.visionSystemMessage)
    if (this.initialFallbackObservation) {
      messages.push({
        role: 'system',
        content:
          '用户本轮直接上传了图片。主助手当前没有直接读取原图；以下是外挂视觉模型返回的客观观察。' +
          '请由你继续按桌宠人设理解用户意图并组织最终回答，不要冒充外挂模型，也不要声称自己直接看到了未注入的原图。\n' +
          this.initialFallbackObservation,
      })
    }
  }

  hasInitialImageParts(): boolean {
    return this.initialVisionParts.length > 0
  }

  buildInitialUserContent(request: string): string | Array<Record<string, unknown>> {
    if (this.initialVisionParts.length === 0) return request
    const content: Array<Record<string, unknown>> = []
    if (request.trim()) content.push({ type: 'text', text: request })
    content.push(...this.initialVisionParts)
    return content
  }

  async recoverFromMainVisionError(
    messages: TaskAgentVisionMessage[],
    error: unknown,
    status?: number,
  ): Promise<boolean> {
    if (this.mainVisionArtifacts.length === 0 || this.visionStripped) return false
    const failureKind = classifyVisionError(error, status)
    const fallbackRoute = this.decideRoute(failureKind)

    if (fallbackRoute === 'fallback' && !this.mainVisionFallbackApplied) {
      try {
        const observation = await this.inspectArtifactsWithFallback(
          this.mainVisionArtifacts,
          this.mainVisionQuestion,
        )
        if (!this.stripVisionFromMessages(messages)) return false
        this.mainVisionFallbackApplied = true
        if (failureKind === 'unsupported') this.setMainCapability('unsupported')
        this.setVisionSystemContent(
          messages,
          `主模型视觉请求失败，已改用外挂视觉（${failureKind === 'transient' ? '主网络失败→外挂' : '主模型不支持→外挂'}）。` +
            '以下是外挂模型的客观观察；请由你按桌宠人设组织回复，不要声称自己直接读取了原图。\n' +
            observation,
        )
        this.pushLog(
          failureKind === 'transient'
            ? `[Vision] 主网络失败→外挂 ${this.mainVisionArtifacts.length}`
            : `[Vision] 主模型不支持→外挂 ${this.mainVisionArtifacts.length}`,
          true,
        )
        return true
      } catch (fallbackError) {
        if (this.shouldRethrowCancellation(fallbackError)) throw fallbackError
        this.pushLog(`[Vision] 外挂失败：${previewText(errorMessage(fallbackError), 160)}`, true)
      }
    }

    if (failureKind === 'unsupported' && this.stripVisionFromMessages(messages)) {
      this.setMainCapability('unsupported')
      this.pushLog('[Vision] 主模型明确不支持图片输入，已移除原图后重试', true)
      return true
    }
    return false
  }

  markMainRequestSucceeded(): void {
    if (this.mainVisionArtifacts.length > 0 && !this.visionStripped) this.setMainCapability('supported')
  }

  registerToolVisualArtifacts(toolName: string, runId: string, imagePaths: string[]): VisualArtifactRef[] {
    if (!VISION_RESULT_TOOL_NAMES.has(toolName)) return []
    const paths = normalizeImagePathList(imagePaths, MAX_TOOL_ARTIFACTS)
    const total = paths.length
    const groupId = `${this.taskId}:${runId}`
    return paths.map((imagePath, index) => {
      const artifact: VisualArtifactRef = {
        id: `vis_${this.taskId}_${runId}_${index + 1}`,
        path: imagePath,
        source: toolName as VisualArtifactRef['source'],
        groupId,
        index: index + 1,
        total,
        taskId: this.taskId,
        runId,
        createdAt: this.now(),
      }
      this.visualContext.artifacts.set(artifact.id, artifact)
      return artifact
    })
  }

  sanitizeToolOutputForModel(raw: string, artifacts: VisualArtifactRef[]): string {
    if (artifacts.length === 0) return String(raw ?? '')
    return (
      '[工具执行成功；视觉产物已登记，但尚未查看图片内容]\n' +
      artifacts
        .map((artifact) => `- ${artifact.id}（${artifact.index ?? 1}/${artifact.total ?? artifacts.length}）`)
        .join('\n') +
      '\n只有确实需要图片内容时才调用 vision.look；不要根据生成提示词、文件名或路径猜测成图。'
    )
  }

  async executeVisionLook(input: ToolInput): Promise<TaskAgentToolExecution> {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const requestedIds = Array.isArray(value?.artifactIds)
      ? value.artifactIds.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    const uniqueIds = new Set(requestedIds)
    const artifacts = requestedIds.map((id) => this.visualContext.artifacts.get(id)).filter(Boolean) as VisualArtifactRef[]
    if (
      requestedIds.length === 0 ||
      requestedIds.length > this.maxImages ||
      uniqueIds.size !== requestedIds.length ||
      artifacts.length !== requestedIds.length
    ) {
      throw new Error(
        requestedIds.length === 0
          ? 'vision.look 未收到当前会话中有效的 artifactIds'
          : 'vision.look 包含未知、重复或超出上限的 artifactId',
      )
    }

    const question = typeof value?.question === 'string' ? value.question.trim() : ''
    const route = this.decideRoute(this.mainVisionFallbackApplied ? 'unsupported' : null)
    if (route === 'main') {
      const visionParts = await this.loadImageParts(
        artifacts.map((artifact) => artifact.path),
        this.maxImages,
      )
      if (visionParts.length === 0) throw new Error('所选图片不存在、过大或无法读取')
      this.mainVisionArtifacts = artifacts
      this.mainVisionQuestion = question || '客观查看图片内容'
      this.pushLog(`[Vision] 主模型 ${visionParts.length}`, true)
      return {
        output: JSON.stringify({ ok: true, route: 'main-native', artifactIds: artifacts.map((artifact) => artifact.id) }),
        modelOutput: `已按顺序附带 ${visionParts.length} 张所选图片；请直接依据图片回答问题：${this.mainVisionQuestion}`,
        imagePaths: [],
        visionParts,
      }
    }

    if (route === 'fallback') {
      const observation = await this.inspectArtifactsWithFallback(artifacts, question)
      this.pushLog(`[Vision] 外挂 ${artifacts.length}`, true)
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
        imagePaths: [],
      }
    }

    if (route === 'off') throw new Error('视觉路由已关闭')
    throw new Error('当前没有可用的视觉提供方；请检查主模型能力或外挂视觉 Profile')
  }

  appendTextFallbackSystemMessages(messages: TaskAgentVisionMessage[]): void {
    const catalogMessage = this.buildCatalogMessage()
    if (catalogMessage) messages.push(catalogMessage)
    if (this.visionSystemMessage) messages.push({ ...this.visionSystemMessage })
    if (this.initialFallbackObservation && !this.mainVisionFallbackApplied) {
      messages.push({
        role: 'system',
        content:
          '以下是外挂视觉模型对用户本轮上传图片的客观观察；请由你按桌宠人设组织回复。\n' +
          this.initialFallbackObservation,
      })
    }
  }

  async buildTextFallbackUserContent(request: string): Promise<string | Array<Record<string, unknown>>> {
    const visionParts =
      !this.visionStripped && this.mainVisionArtifacts.length > 0
        ? await this.loadImageParts(
            this.mainVisionArtifacts.map((artifact) => artifact.path),
            this.maxImages,
          )
        : []
    return visionParts.length > 0 ? [{ type: 'text', text: request }, ...visionParts] : request
  }

  private registerLegacyArtifacts(values: unknown[]): void {
    const paths = normalizeImagePathList(values, this.maxImages)
    for (let index = 0; index < paths.length; index += 1) {
      const id = `legacy_${this.taskId}_${index + 1}`
      if (!this.visualContext.artifacts.has(id)) {
        this.visualContext.artifacts.set(id, {
          id,
          path: paths[index],
          source: 'legacy',
          groupId: `legacy:${this.taskId}`,
          index: index + 1,
          total: paths.length,
          taskId: this.taskId,
          createdAt: this.taskCreatedAt,
        })
      }
      if (!this.visualContext.initialVisionIds.includes(id)) this.visualContext.initialVisionIds.push(id)
    }
  }

  private initialState(): TaskAgentInitialVisionState {
    return {
      route: this.initialRoute,
      artifacts: [...this.initialVisionArtifacts],
      imageParts: [...this.initialVisionParts],
    }
  }

  private decideRoute(mainFailedKind: 'unsupported' | 'transient' | 'other' | null = null): VisionRoute {
    return decideVisionRoute({
      routingMode: this.routingMode,
      capability: this.mainCapability,
      hasFallback: this.fallbackAvailable,
      mainFailedKind,
      mainAvailable: this.mainAvailable,
      fallbackOnTransient: this.fallbackOnTransient,
    })
  }

  private async inspectArtifactsWithFallback(artifacts: VisualArtifactRef[], question: string): Promise<string> {
    if (!this.fallbackAvailable) throw new Error('未配置可用的外挂视觉 Profile')
    const observations: string[] = []
    for (const artifact of artifacts.slice(0, this.maxImages)) {
      if (this.isCanceled()) throw new Error('canceled')
      const raw = await this.inspectFallbackArtifact(artifact, question)
      observations.push(`- ${artifact.id}：${readInspectAnswer(raw)}`)
    }
    return observations.join('\n')
  }

  private stripVisionFromMessages(messages: TaskAgentVisionMessage[]): boolean {
    if (this.visionStripped) return false
    let changed = false
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
          const value = (part as { text?: unknown }).text
          return typeof value === 'string' ? value : ''
        })
        .filter(Boolean)
        .join('\n')
        .trim()
      message.content = text || '[image omitted: model rejected vision input]'
      changed = true
    }
    if (changed) {
      this.setVisionSystemContent(
        messages,
        '注意：本轮原图输入已被移除。除非下方另有外挂视觉观察，否则你现在看不到图片，禁止描述或编造图片内容。',
      )
    }
    this.visionStripped = changed
    return changed
  }

  private setVisionSystemContent(messages: TaskAgentVisionMessage[], content: string): void {
    if (!this.visionSystemMessage) {
      this.visionSystemMessage = { role: 'system', content }
      messages.push(this.visionSystemMessage)
      return
    }
    this.visionSystemMessage.content = content
  }

  private setMainCapability(capability: 'supported' | 'unsupported'): void {
    this.mainCapability = capability
    this.rememberCapability(capability)
  }

  private shouldRethrowCancellation(error: unknown): boolean {
    if (this.isCanceled() || isAbortLikeError(error)) return true
    return /(?:^|\b)cancell?ed(?:\b|$)|任务已取消|已取消任务/i.test(errorMessage(error))
  }
}

function readInspectAnswer(raw: string): string {
  const text = String(raw ?? '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1)) as { answer?: unknown }
      if (typeof parsed.answer === 'string' && parsed.answer.trim()) return parsed.answer.trim()
    } catch {
      // Raw fallback output remains useful evidence when the provider did not return valid JSON.
    }
  }
  return text || '(外挂视觉未返回观察结果)'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function previewText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}
