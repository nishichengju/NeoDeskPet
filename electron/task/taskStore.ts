import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import type { TaskListResult, TaskRecord, TaskStatus, TaskStepRecord } from '../types'

export const MAX_TASK_RECORDS = 200
export const MAX_TASK_STEP_INPUT_CHARS = 8000

export type TaskStoreState = {
  version: 1
  tasks: TaskRecord[]
}

export type TaskStoreBackend = {
  store: TaskStoreState
}

export type TaskNormalizationOptions = {
  createId?: () => string
  now?: () => number
}

export type TaskStoreOptions = TaskNormalizationOptions & {
  backend?: TaskStoreBackend
  onChanged: () => void
}

function clampText(text: unknown, max: number): string {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

export function normalizeTaskRecord(value: unknown, options: TaskNormalizationOptions = {}): TaskRecord | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<TaskRecord>
  if (typeof source.id !== 'string' || !source.id.trim()) return null
  if (typeof source.title !== 'string' || !source.title.trim()) return null

  const allowedStatuses: TaskStatus[] = ['pending', 'running', 'paused', 'failed', 'done', 'canceled']
  if (!allowedStatuses.includes(source.status as TaskStatus)) return null

  const createId = options.createId ?? randomUUID
  const getNow = options.now ?? Date.now
  const steps = Array.isArray(source.steps) ? (source.steps as TaskStepRecord[]) : []
  const safeSteps = steps
    .filter((step) => step && typeof step === 'object' && typeof (step as TaskStepRecord).title === 'string')
    .slice(0, 120)
    .map((step) => ({
      id: typeof step.id === 'string' && step.id.trim() ? step.id : createId(),
      title: clampText(step.title, 80),
      status: (step.status ?? 'pending') as TaskStepRecord['status'],
      tool: typeof step.tool === 'string' ? clampText(step.tool, 80) : undefined,
      input: typeof step.input === 'string' ? clampText(step.input, MAX_TASK_STEP_INPUT_CHARS) : undefined,
      output: typeof step.output === 'string' ? clampText(step.output, 1200) : undefined,
      error: typeof step.error === 'string' ? clampText(step.error, 1200) : undefined,
      startedAt: typeof step.startedAt === 'number' ? step.startedAt : undefined,
      endedAt: typeof step.endedAt === 'number' ? step.endedAt : undefined,
    }))

  const toolsUsed = Array.isArray(source.toolsUsed) ? source.toolsUsed.filter((item) => typeof item === 'string').slice(0, 80) : []
  const finalReply = typeof source.finalReply === 'string' ? clampText(source.finalReply, 12000) : undefined
  const draftReply = typeof source.draftReply === 'string' ? clampText(source.draftReply, 12000) : undefined
  const live2dExpression = typeof source.live2dExpression === 'string' ? clampText(source.live2dExpression, 80) : undefined
  const live2dMotion = typeof source.live2dMotion === 'string' ? clampText(source.live2dMotion, 80) : undefined
  const toolRuns = Array.isArray(source.toolRuns)
    ? (source.toolRuns as Array<Record<string, unknown>>)
        .filter((run) => run && typeof run === 'object')
        .slice(0, 80)
        .map((run, index) => ({
          id: typeof run.id === 'string' && run.id.trim() ? run.id.trim() : `run_${index}`,
          toolName: typeof run.toolName === 'string' ? clampText(run.toolName, 80) : '',
          status: (run.status === 'running' || run.status === 'done' || run.status === 'error' ? run.status : 'done') as
            | 'running'
            | 'done'
            | 'error',
          inputPreview: typeof run.inputPreview === 'string' ? clampText(run.inputPreview, 6000) : undefined,
          outputPreview: typeof run.outputPreview === 'string' ? clampText(run.outputPreview, 800) : undefined,
          imagePaths: Array.isArray(run.imagePaths)
            ? (run.imagePaths as unknown[])
                .filter((item) => typeof item === 'string')
                .map((item) => String(item).trim())
                .filter(Boolean)
                .slice(0, 8)
            : undefined,
          error: typeof run.error === 'string' ? clampText(run.error, 800) : undefined,
          startedAt: typeof run.startedAt === 'number' ? run.startedAt : getNow(),
          endedAt: typeof run.endedAt === 'number' ? run.endedAt : undefined,
        }))
        .filter((run) => run.toolName.trim().length > 0)
    : undefined

  return {
    id: source.id,
    queue: (source.queue ?? 'other') as TaskRecord['queue'],
    title: clampText(source.title, 120),
    why: typeof source.why === 'string' ? clampText(source.why, 240) : '',
    status: source.status as TaskStatus,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : getNow(),
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : getNow(),
    startedAt: typeof source.startedAt === 'number' ? source.startedAt : undefined,
    endedAt: typeof source.endedAt === 'number' ? source.endedAt : undefined,
    steps: safeSteps,
    currentStepIndex: typeof source.currentStepIndex === 'number' ? Math.max(0, Math.trunc(source.currentStepIndex)) : 0,
    toolsUsed,
    finalReply,
    draftReply,
    live2dExpression,
    live2dMotion,
    toolRuns,
    lastError: typeof source.lastError === 'string' ? clampText(source.lastError, 1600) : undefined,
    usage:
      source.usage && typeof source.usage === 'object'
        ? {
            promptTokens: typeof source.usage.promptTokens === 'number' ? source.usage.promptTokens : 0,
            completionTokens: typeof source.usage.completionTokens === 'number' ? source.usage.completionTokens : 0,
            totalTokens: typeof source.usage.totalTokens === 'number' ? source.usage.totalTokens : 0,
          }
        : undefined,
  }
}

export function normalizeTaskState(
  state: TaskStoreState | undefined,
  options: TaskNormalizationOptions = {},
): TaskStoreState {
  const source = state ?? ({ version: 1, tasks: [] } as TaskStoreState)
  const rawTasks = Array.isArray(source.tasks) ? source.tasks : []
  const tasks = rawTasks
    .map((task) => normalizeTaskRecord(task, options))
    .filter((task): task is TaskRecord => Boolean(task))
  return { version: 1, tasks: tasks.slice(0, MAX_TASK_RECORDS) }
}

export class TaskStore {
  private readonly backend: TaskStoreBackend
  private readonly createId: () => string
  private readonly getNow: () => number
  private readonly onChanged: () => void

  constructor(options: TaskStoreOptions) {
    this.backend =
      options.backend ??
      new Store<TaskStoreState>({
        name: 'neodeskpet-tasks',
        defaults: { version: 1, tasks: [] },
      })
    this.createId = options.createId ?? randomUUID
    this.getNow = options.now ?? Date.now
    this.onChanged = options.onChanged
  }

  readState(): TaskStoreState {
    return normalizeTaskState(this.backend.store, { createId: this.createId, now: this.getNow })
  }

  listTasks(): TaskListResult {
    const items = [...this.readState().tasks].sort((left, right) => right.updatedAt - left.updatedAt)
    return { items }
  }

  getTask(id: string): TaskRecord | null {
    const taskId = (id ?? '').trim()
    if (!taskId) return null
    return this.readState().tasks.find((task) => task.id === taskId) ?? null
  }

  update(mutator: (draft: TaskStoreState) => void): void {
    const draft = this.readState()
    mutator(draft)
    this.backend.store = draft
    this.onChanged()
  }

  recoverInterruptedTasks(): void {
    this.update((draft) => {
      const timestamp = this.getNow()
      for (const task of draft.tasks) {
        const previousStatus = task.status
        if (previousStatus !== 'pending' && previousStatus !== 'running' && previousStatus !== 'paused') continue
        task.status = 'failed'
        task.updatedAt = timestamp
        task.endedAt = timestamp
        task.lastError =
          task.lastError ||
          (previousStatus === 'pending'
            ? '任务在上次运行时尚未开始（应用被重启/崩溃）'
            : '任务在上次运行时中断（应用被重启/崩溃）')
      }
    })
  }
}
