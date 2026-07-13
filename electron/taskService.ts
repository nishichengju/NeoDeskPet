import { randomUUID } from 'node:crypto'
import { getSettings } from './store'
import { cancelCliExecStreamSessionsForTask, type ToolInput } from './toolExecutor'
import {
  filterToolDefinitionsBySettings,
  getDefaultAgentToolDefinitions,
  toOpenAITools,
  type OpenAIFunctionToolSpec,
} from './toolRegistry'
import { SkillManager } from './skillRegistry'
import type { McpManager } from './mcpManager'
import { TaskAgentToolCatalog } from './task/taskAgentTools'
import { TaskAgentConversation } from './task/taskAgentConversation'
import { TaskAgentLoopRunner } from './task/taskAgentLoopRunner'
import { TaskAgentLlmClient } from './task/taskAgentLlmClient'
import {
  buildTaskAgentLive2dSystemMessages,
  TaskAgentMessageSession,
} from './task/taskAgentMessageSession'
import { resolveTaskAgentRunConfig } from './task/taskAgentRunConfig'
import { prepareTaskAgentSkills } from './task/taskAgentSkillPreparation'
import { TaskAgentTaskState } from './task/taskAgentTaskState'
import {
  TaskAgentToolSession,
  type TaskAgentToolExecution,
  type TaskAgentToolExecutionContext,
} from './task/taskAgentToolSession'
import {
  TaskAgentVisionSession,
  normalizeImagePathList,
  normalizeVisualArtifacts,
  type TaskAgentVisualContext,
} from './task/taskAgentVisionSession'
import { TaskExecutionRunner } from './task/taskExecutionRunner'
import { TaskMmvectorVideoQaWorkflow } from './task/taskMmvectorVideoQa'
import {
  TaskToolExecutionAdapter,
  type TaskToolExecutionResult,
  type TaskToolExecutionRuntime,
} from './task/taskToolExecutionAdapter'
import { TaskToolMediaStore, imageUrlPartsFromPaths } from './task/taskToolMedia'
import { TaskRuntimeRegistry, TaskScheduler, type TaskRuntime } from './task/taskRuntime'
import { MAX_TASK_RECORDS, MAX_TASK_STEP_INPUT_CHARS, TaskStore, type TaskStoreState } from './task/taskStore'
import type { TaskCreateArgs, TaskListResult, TaskRecord, TaskStepRecord } from './types'
import { resolveVisionFallbackProfile } from './visionRouter'

function now(): number {
  return Date.now()
}

function clampText(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
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

export class TaskService {
  private readonly taskStore: TaskStore
  private readonly runtime = new TaskRuntimeRegistry()
  private readonly scheduler: TaskScheduler
  private readonly visualContextByTask = new Map<string, TaskAgentVisualContext>()
  private readonly visionCapabilityCache = new Map<string, 'supported' | 'unsupported'>()
  private readonly userDataDir: string
  private readonly mcpManager: McpManager | null
  private readonly skillManager: SkillManager
  private readonly toolMediaStore: TaskToolMediaStore
  private readonly toolExecutor: TaskToolExecutionAdapter

  constructor(opts: { onChanged: () => void; userDataDir: string; mcpManager?: McpManager | null }) {
    this.taskStore = new TaskStore({ onChanged: opts.onChanged })
    this.userDataDir = opts.userDataDir
    this.mcpManager = opts.mcpManager ?? null
    this.skillManager = new SkillManager({ workspaceDir: process.cwd() })
    this.toolMediaStore = new TaskToolMediaStore({ userDataDir: this.userDataDir })
    const mmvectorVideoQa = new TaskMmvectorVideoQaWorkflow({ userDataDir: this.userDataDir })
    this.toolExecutor = new TaskToolExecutionAdapter({
      userDataDir: this.userDataDir,
      mediaStore: this.toolMediaStore,
      mcpManager: this.mcpManager,
      refreshSkillRegistry: (managedDir) => this.skillManager.refresh({ managedDir }),
      runMmvectorVideoQa: (input, task, runtime, executeChildTool) =>
        mmvectorVideoQa.run(input, { task, ...runtime, executeTool: executeChildTool }),
    })
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

  private toolRuntime(taskId: string, rt: TaskRuntime): TaskToolExecutionRuntime {
    return {
      waitIfPaused: () => this.waitIfPaused(taskId),
      isCanceled: () => rt.canceled,
      setCancelCurrent: (cancel) => {
        rt.cancelCurrent = cancel
      },
    }
  }

  private async runTool(
    tool: string | undefined,
    input: ToolInput,
    task: TaskRecord,
    rt: TaskRuntime,
  ): Promise<TaskToolExecutionResult> {
    const toolName = typeof tool === 'string' ? tool.trim() : ''
    const resolved = resolveTemplates(input, task)

    if (!toolName) {
      // 没有工具：作为“备注/占位 step”，直接通过
      await sleep(60)
      return { output: '跳过（无 tool）', imagePaths: [] }
    }

    if (toolName === 'agent.run') {
      const output = await this.runAgentRunTool(resolved, task, rt)
      const imagePaths = await this.toolMediaStore.resolveImagePaths(task.id, output, [])
      return { output, imagePaths }
    }

    return this.toolExecutor.execute(toolName, resolved, task, this.toolRuntime(task.id, rt))
  }

  private async runAgentRunTool(resolved: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    const settings = getSettings()
    const config = resolveTaskAgentRunConfig(resolved, settings)
    const {
      request,
      maxTurns,
      mode,
      system,
      extraContext,
      maxVisionImages,
      legacyVisionImagePaths,
      historyMessages,
      skillRuntimeOptions,
      skillAllowModelInvocation,
      skillVerboseLogging,
      mainVisionCapabilityKey,
    } = config
    const visualContext: TaskAgentVisualContext = this.visualContextByTask.get(task.id) ?? {
      artifacts: new Map(),
      initialVisionIds: [],
    }
    const fallbackProfile = resolveVisionFallbackProfile(settings)
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

    const skillPreparation = await prepareTaskAgentSkills({
      manager: this.skillManager,
      request,
      runtimeOptions: skillRuntimeOptions,
      allowModelInvocation: skillAllowModelInvocation,
      verboseLogging: skillVerboseLogging,
    })
    const effectiveAgentRequest = skillPreparation.effectiveRequest
    const skillSystemMessages = skillPreparation.systemMessages
    const deferredSkillLogs = skillPreparation.logs

    const visionAttachLogs: string[] = []
    let visionLogSink: (line: string, force?: boolean) => void = (line) => {
      visionAttachLogs.push(line)
    }
    const visionSession = new TaskAgentVisionSession({
      taskId: task.id,
      taskCreatedAt: task.createdAt,
      visualContext,
      legacyImagePaths: legacyVisionImagePaths,
      maxImages: maxVisionImages,
      routingMode: settings.ai.visionRoutingMode,
      mainCapability: effectiveMainVisionCapability,
      mainAvailable: Boolean(String(settings.ai.baseUrl ?? '').trim() && String(settings.ai.model ?? '').trim()),
      fallbackAvailable: Boolean(fallbackProfile),
      fallbackOnTransient: settings.ai.visionFallbackOnTransient,
      loadImageParts: imageUrlPartsFromPaths,
      inspectFallbackArtifact: async (artifact, question) => {
        if (!fallbackProfile) throw new Error('未配置可用的外挂视觉 Profile')
        const execution = await this.toolExecutor.execute(
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
          this.toolRuntime(task.id, rt),
        )
        return execution.output
      },
      rememberMainCapability: rememberMainVisionCapability,
      pushLog: (line, force) => visionLogSink(line, force),
      isCanceled: () => rt.canceled,
    })
    await visionSession.prepareInitial(effectiveAgentRequest)

    const messageSession = new TaskAgentMessageSession({
      system,
      extraContext,
      effectiveRequest: effectiveAgentRequest,
      historyMessages,
      skillSystemMessages,
      visionSession,
      getLive2dSystemMessages: () =>
        buildTaskAgentLive2dSystemMessages(String(settings.live2dModelFile ?? '')),
    })
    const messages = messageSession.buildInitialMessages()

    const conversation = new TaskAgentConversation(maxTurns)
    const taskState = new TaskAgentTaskState({
      taskId: task.id,
      conversation,
      updateTask: (mutator) => {
        this.writeState((draft) => {
          const item = draft.tasks.find((candidate) => candidate.id === task.id)
          if (item) mutator(item)
        })
      },
      isCanceled: () => rt.canceled,
    })
    taskState.reset()

    const updateProgress = (force?: boolean) => taskState.updateProgress(force)
    const pushLog = (line: string, force?: boolean) => taskState.pushLog(line, force)
    visionLogSink = pushLog
    for (const line of deferredSkillLogs) pushLog(line, true)
    for (const line of visionAttachLogs) pushLog(line, true)

    const toolPreview = (v: unknown, max: number) => clampText(typeof v === 'string' ? v : JSON.stringify(v ?? ''), max)
    const toolInputPreview = (toolName: string, v: unknown) => toolPreview(v, toolName === 'image.generate' ? 6000 : 500)

    const { apiMode, endpoint, headers, model, temperature, maxTokens, reasoningExtra, timeoutMs } = config.llm
    const llmClient = new TaskAgentLlmClient({
      apiMode,
      endpoint,
      headers,
      model,
      temperature,
      maxTokens,
      reasoningExtra,
      messages,
      tools,
      sessionId: task.id,
      timeoutMs,
      isCanceled: () => rt.canceled,
      setCancelCurrent: (cancel) => {
        rt.cancelCurrent = cancel
      },
      recoverFromVisionError: (error, status) => visionSession.recoverFromMainVisionError(messages, error, status),
      onRequestSucceeded: () => visionSession.markMainRequestSucceeded(),
      onRetry: ({ delayMs, errorMessage, nextAttempt, totalAttempts }) => {
        pushLog(
          `[Agent] LLM 请求失败，${delayMs}ms 后重试 (${nextAttempt}/${totalAttempts})：${clampText(errorMessage, 120)}`,
          true,
        )
      },
    })

    pushLog(`[Agent] request: ${clampText(request, 120)}`, true)

    const executeAgentTool = async (
      toolName: string,
      input: ToolInput,
      context: TaskAgentToolExecutionContext,
    ): Promise<TaskAgentToolExecution> => {
      let execution: TaskAgentToolExecution
      if (toolName === 'vision.look') {
        execution = await visionSession.executeVisionLook(input)
      } else {
        execution = await this.toolExecutor.execute(toolName, input, task, this.toolRuntime(task.id, rt))
      }

      const artifacts = visionSession.registerToolVisualArtifacts(context.recordName, context.runId, execution.imagePaths)
      return {
        ...execution,
        modelOutput:
          execution.modelOutput ??
          (artifacts.length > 0 ? visionSession.sanitizeToolOutputForModel(execution.output, artifacts) : execution.output),
      }
    }

    const toolSession = new TaskAgentToolSession({
      catalog: toolCatalog,
      executeTool: executeAgentTool,
      recordToolUsed: (toolName) => taskState.recordToolUsed(toolName),
      upsertToolRun: (patch) => taskState.upsertToolRun(patch),
      pushLog,
      inputPreview: toolInputPreview,
    })

    const finalize = (finalText: string): string => taskState.finalize(finalText)

    const tryFinalizeOrContinue = (candidateText: string, turn: number): { done: boolean; text: string } => {
      const decision = conversation.decideFinal(candidateText, turn, {
        hasFinishedToolRun: taskState.hasFinishedToolRun(),
        evidenceText: toolSession.buildEvidenceText(request),
      })
      if (decision.kind === 'accept') return { done: true, text: finalize(decision.text) }
      if (decision.kind === 'retry') {
        pushLog(`[Agent] final reply rejected: ${decision.reason}`, true)
        messages.push({
          role: 'system',
          content: `校验失败：${decision.reason}。请基于工具输出重答；需要链接/事实请先调用工具获取，且最终回复不要输出工具内部名。`,
        })
        return { done: false, text: '' }
      }
      pushLog(`[Agent] final reply sanitized at maxTurns: ${decision.reason}`, true)
      return { done: true, text: finalize(decision.text) }
    }

    const prepareTextFallback = () =>
      messageSession.rebuildTextFallback(toolSession.listExecutedCallOrder())

    const loopRunner = new TaskAgentLoopRunner({
      apiMode,
      mode,
      maxTurns,
      messages,
      textGuide: toolCatalog.buildTextModeGuide(settings.novelai?.promptRules),
      llmClient,
      toolCatalog,
      toolSession,
      conversation,
      waitIfPaused: () => this.waitIfPaused(task.id),
      isCanceled: () => rt.canceled,
      pushLog,
      updateProgress,
      tryFinalize: tryFinalizeOrContinue,
      finalize,
      prepareTextFallback,
    })
    return loopRunner.run()
  }

  private async runTask(id: string): Promise<void> {
    const rt = this.runtime.ensure(id)
    const runner = new TaskExecutionRunner({
      taskId: id,
      readTask: () => this.getTask(id),
      updateTask: (mutator) => {
        let updated = false
        this.writeState((draft) => {
          const task = draft.tasks.find((item) => item.id === id)
          if (!task) return
          updated = mutator(task)
        })
        return updated
      },
      waitIfPaused: () => this.waitIfPaused(id),
      isCanceled: () => rt.canceled,
      executeStep: async (task, step) => {
        const toolInput = parseToolInput(step.input)
        return this.runTool(step.tool, toolInput, task, rt)
      },
      normalizeImagePaths: normalizeImagePathList,
      onFinished: () => {
        rt.cancelCurrent = undefined
        this.runtime.delete(id)
        this.visualContextByTask.delete(id)
        this.scheduler.kick()
      },
    })
    await runner.run()
  }

  private writeState(mutator: (draft: TaskStoreState) => void): void {
    this.taskStore.update(mutator)
  }
}
