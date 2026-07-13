import { randomUUID } from 'node:crypto'
import type { TaskRecord } from '../types'
import type { TaskAgentConversation } from './taskAgentConversation'
import type { TaskAgentToolRunPatch } from './taskAgentToolSession'
import { normalizeImagePathList } from './taskAgentVisionSession'

const MAX_STEP_OUTPUT_CHARS = 5000
const MAX_LOG_LINES = 120
const MAX_TOOL_RUNS = 80

type TaskToolRun = NonNullable<TaskRecord['toolRuns']>[number]

export type TaskAgentTaskStateOptions = {
  taskId: string
  conversation: Pick<TaskAgentConversation, 'finalize' | 'snapshot'>
  updateTask: (mutator: (task: TaskRecord) => void) => void
  isCanceled: () => boolean
  now?: () => number
  progressIntervalMs?: number
  createId?: () => string
}

export class TaskAgentTaskState {
  private readonly taskId: string
  private readonly conversation: TaskAgentTaskStateOptions['conversation']
  private readonly updateTaskRecord: TaskAgentTaskStateOptions['updateTask']
  private readonly isCanceled: () => boolean
  private readonly now: () => number
  private readonly progressIntervalMs: number
  private readonly createId: () => string
  private readonly logs: string[] = []
  private toolRuns: TaskToolRun[] = []
  private lastProgressAt = 0

  constructor(options: TaskAgentTaskStateOptions) {
    this.taskId = options.taskId
    this.conversation = options.conversation
    this.updateTaskRecord = options.updateTask
    this.isCanceled = options.isCanceled
    this.now = options.now ?? Date.now
    this.progressIntervalMs = Math.max(0, Math.trunc(options.progressIntervalMs ?? 250))
    this.createId = options.createId ?? randomUUID
  }

  reset(): void {
    this.logs.splice(0)
    this.toolRuns = []
    this.lastProgressAt = 0
    this.updateTask((task) => {
      task.draftReply = ''
      task.finalReply = undefined
      task.live2dExpression = undefined
      task.live2dMotion = undefined
      task.toolRuns = []
      task.updatedAt = this.now()
    })
  }

  pushLog(line: string, force = false): void {
    this.logs.push(clampText(line, 800))
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    this.updateProgress(force)
  }

  updateProgress(force = false): void {
    if (this.isCanceled()) return
    const timestamp = this.now()
    if (!force && timestamp - this.lastProgressAt < this.progressIntervalMs) return
    this.lastProgressAt = timestamp
    const output = clampText(this.logs.join('\n') || '执行中…', MAX_STEP_OUTPUT_CHARS)
    const snapshot = this.conversation.snapshot()
    this.updateTask((task) => {
      const step = task.steps[task.currentStepIndex]
      if (!step) return
      step.output = output
      task.draftReply = snapshot.draftReply
      task.live2dExpression = snapshot.live2dExpression
      task.live2dMotion = snapshot.live2dMotion
      task.toolRuns = this.toolRuns
      task.updatedAt = this.now()
    })
  }

  upsertToolRun(patch: TaskAgentToolRunPatch): void {
    const id = patch.id.trim() || this.createId()
    const existingIndex = this.toolRuns.findIndex((run) => run.id === id)
    const base = existingIndex >= 0 ? this.toolRuns[existingIndex] : undefined
    const next: TaskToolRun = {
      id,
      toolName: patch.toolName,
      status: patch.status,
      inputPreview: patch.inputPreview ?? base?.inputPreview,
      outputPreview: patch.outputPreview ?? base?.outputPreview,
      imagePaths: Array.isArray(patch.imagePaths) ? normalizeImagePathList(patch.imagePaths, 8) : base?.imagePaths,
      error: patch.error ?? base?.error,
      startedAt: typeof patch.startedAt === 'number' ? patch.startedAt : base?.startedAt ?? this.now(),
      endedAt: typeof patch.endedAt === 'number' ? patch.endedAt : base?.endedAt,
    }
    if (existingIndex >= 0) {
      this.toolRuns = [
        ...this.toolRuns.slice(0, existingIndex),
        next,
        ...this.toolRuns.slice(existingIndex + 1),
      ]
    } else {
      this.toolRuns = [...this.toolRuns, next].slice(0, MAX_TOOL_RUNS)
    }
    this.updateProgress(true)
  }

  recordToolUsed(toolName: string): void {
    this.updateTask((task) => {
      if (!task.toolsUsed.includes(toolName)) task.toolsUsed = [...task.toolsUsed, toolName].slice(0, 80)
      task.updatedAt = this.now()
    })
  }

  hasFinishedToolRun(): boolean {
    return this.toolRuns.some((run) => run.status === 'done' || run.status === 'error')
  }

  finalize(finalText: string): string {
    const output = this.conversation.finalize(finalText)
    const snapshot = this.conversation.snapshot()
    this.updateTask((task) => {
      task.finalReply = output
      task.draftReply = output
      task.live2dExpression = snapshot.live2dExpression
      task.live2dMotion = snapshot.live2dMotion
      task.toolRuns = this.toolRuns
      if (snapshot.usage.totalTokens > 0) task.usage = { ...snapshot.usage }
      task.updatedAt = this.now()
    })
    return output
  }

  private updateTask(mutator: (task: TaskRecord) => void): void {
    this.updateTaskRecord((task) => {
      if (task.id === this.taskId) mutator(task)
    })
  }
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`
}
