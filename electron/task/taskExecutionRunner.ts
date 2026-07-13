import type { TaskRecord, TaskStepRecord } from '../types'

const MAX_STEP_OUTPUT_CHARS = 5000
const MAX_TOOL_RUNS = 80
const MAX_TOOL_IMAGE_PATHS = 8

export type TaskStepExecutionResult = {
  output: string
  imagePaths?: string[]
}

export type TaskExecutionRunnerOptions = {
  taskId: string
  readTask: () => TaskRecord | null
  updateTask: (mutator: (task: TaskRecord) => boolean) => boolean
  waitIfPaused: () => Promise<void>
  isCanceled: () => boolean
  executeStep: (task: TaskRecord, step: TaskStepRecord) => Promise<TaskStepExecutionResult>
  onFinished: () => void
  normalizeImagePaths?: (paths: string[], limit: number) => string[]
  now?: () => number
}

type ActiveStep = {
  index: number
  id: string
}

export class TaskExecutionRunner {
  private readonly taskId: string
  private readonly readTask: TaskExecutionRunnerOptions['readTask']
  private readonly updateTask: TaskExecutionRunnerOptions['updateTask']
  private readonly waitIfPaused: TaskExecutionRunnerOptions['waitIfPaused']
  private readonly isCanceled: TaskExecutionRunnerOptions['isCanceled']
  private readonly executeStep: TaskExecutionRunnerOptions['executeStep']
  private readonly onFinished: TaskExecutionRunnerOptions['onFinished']
  private readonly normalizeImagePaths: NonNullable<TaskExecutionRunnerOptions['normalizeImagePaths']>
  private readonly now: () => number

  constructor(options: TaskExecutionRunnerOptions) {
    this.taskId = options.taskId
    this.readTask = options.readTask
    this.updateTask = options.updateTask
    this.waitIfPaused = options.waitIfPaused
    this.isCanceled = options.isCanceled
    this.executeStep = options.executeStep
    this.onFinished = options.onFinished
    this.normalizeImagePaths = options.normalizeImagePaths ?? normalizeStringList
    this.now = options.now ?? Date.now
  }

  async run(): Promise<void> {
    let activeStep: ActiveStep | null = null
    try {
      while (!this.isCanceled()) {
        const task = this.readTask()
        if (!task) return
        if (task.status !== 'running' && task.status !== 'paused') return

        if (task.status === 'paused') {
          await this.waitIfPaused()
          continue
        }

        const stepIndex = task.currentStepIndex
        const step = task.steps[stepIndex]
        if (!step) {
          this.markTaskDone()
          return
        }

        if (!this.markStepRunning(stepIndex, step)) return
        activeStep = { index: stepIndex, id: step.id }

        await this.waitIfPaused()
        if (this.isCanceled()) return

        const executableTask = this.readTask()
        if (!executableTask) return
        if (executableTask.status === 'paused') continue
        if (executableTask.status !== 'running') return
        const executableStep = expectedStep(executableTask, activeStep.index, activeStep.id)
        if (!executableStep) continue
        const result = await this.executeStep(executableTask, executableStep)

        await this.waitIfPaused()
        if (this.isCanceled()) return

        if (!this.markStepDone(activeStep, step, result)) {
          const current = this.readTask()
          if (!current || (current.status !== 'running' && current.status !== 'paused')) return
        }
        activeStep = null
      }
    } catch (error) {
      if (!this.isCanceled()) this.markTaskFailed(error, activeStep)
    } finally {
      if (this.isCanceled()) this.markTaskCanceled(activeStep)
      this.onFinished()
    }
  }

  private markTaskDone(): boolean {
    const timestamp = this.now()
    return this.updateTask((task) => {
      if (task.id !== this.taskId) return false
      if (task.currentStepIndex < task.steps.length) return false
      task.status = 'done'
      task.updatedAt = timestamp
      task.endedAt = timestamp
      return true
    })
  }

  private markStepRunning(index: number, step: TaskStepRecord): boolean {
    const timestamp = this.now()
    return this.updateTask((task) => {
      if (task.id !== this.taskId || (task.status !== 'running' && task.status !== 'paused')) return false
      const current = expectedStep(task, index, step.id)
      if (!current) return false

      current.status = 'running'
      current.startedAt = current.startedAt ?? timestamp
      task.updatedAt = timestamp
      const toolName = normalizedToolName(current.tool)
      if (toolName && !task.toolsUsed.includes(toolName)) {
        task.toolsUsed = [...task.toolsUsed, toolName].slice(0, MAX_TOOL_RUNS)
      }
      if (shouldRecordStepToolRun(toolName)) {
        const runId = directRunId(current, index)
        const previous = Array.isArray(task.toolRuns) ? task.toolRuns.filter((run) => run.id !== runId) : []
        task.toolRuns = [
          ...previous,
          {
            id: runId,
            toolName,
            status: 'running' as const,
            inputPreview: inputPreview(current),
            startedAt: current.startedAt,
          },
        ].slice(0, MAX_TOOL_RUNS)
      }
      return true
    })
  }

  private markStepDone(
    activeStep: ActiveStep,
    step: TaskStepRecord,
    result: TaskStepExecutionResult,
  ): boolean {
    const timestamp = this.now()
    return this.updateTask((task) => {
      if (task.id !== this.taskId || (task.status !== 'running' && task.status !== 'paused')) return false
      const current = expectedStep(task, activeStep.index, activeStep.id)
      if (!current) return false

      const output = String(result.output ?? '')
      current.status = 'done'
      current.endedAt = timestamp
      current.output = clampText(output || '完成', MAX_STEP_OUTPUT_CHARS)
      task.currentStepIndex += 1
      const toolName = normalizedToolName(current.tool)
      if (shouldRecordStepToolRun(toolName)) {
        const runId = directRunId(current, activeStep.index)
        const previous = Array.isArray(task.toolRuns) ? task.toolRuns : []
        const base = previous.find((run) => run.id === runId)
        task.toolRuns = [
          ...previous.filter((run) => run.id !== runId),
          {
            id: runId,
            toolName,
            status: 'done' as const,
            inputPreview: base?.inputPreview ?? inputPreview(step),
            outputPreview: clampText(output, 800),
            imagePaths: this.normalizeImagePaths(result.imagePaths ?? [], MAX_TOOL_IMAGE_PATHS),
            startedAt: base?.startedAt ?? current.startedAt ?? timestamp,
            endedAt: timestamp,
          },
        ].slice(0, MAX_TOOL_RUNS)
      }
      task.updatedAt = timestamp
      return true
    })
  }

  private markTaskFailed(error: unknown, activeStep: ActiveStep | null): boolean {
    const timestamp = this.now()
    const message = clampText(error instanceof Error ? error.message : String(error ?? ''), 1600) || '任务失败'
    return this.updateTask((task) => {
      if (task.id !== this.taskId) return false
      task.status = 'failed'
      task.lastError = message
      task.updatedAt = timestamp
      task.endedAt = timestamp

      const index = activeStep?.index ?? task.currentStepIndex
      const step = activeStep ? expectedStep(task, activeStep.index, activeStep.id) : task.steps[index]
      if (!step || step.status !== 'running') return true

      step.status = 'failed'
      step.error = message
      step.endedAt = timestamp
      const toolName = normalizedToolName(step.tool)
      if (shouldRecordStepToolRun(toolName)) {
        const runId = directRunId(step, index)
        const previous = Array.isArray(task.toolRuns) ? task.toolRuns : []
        const base = previous.find((run) => run.id === runId)
        task.toolRuns = [
          ...previous.filter((run) => run.id !== runId),
          {
            id: runId,
            toolName,
            status: 'error' as const,
            inputPreview: base?.inputPreview ?? inputPreview(step),
            error: message,
            startedAt: base?.startedAt ?? step.startedAt ?? timestamp,
            endedAt: timestamp,
          },
        ].slice(0, MAX_TOOL_RUNS)
      }
      return true
    })
  }

  private markTaskCanceled(activeStep: ActiveStep | null): boolean {
    if (!activeStep) return false
    const timestamp = this.now()
    return this.updateTask((task) => {
      if (task.id !== this.taskId || task.status !== 'canceled') return false
      const step = expectedStep(task, activeStep.index, activeStep.id)
      if (!step || step.status !== 'running') return false

      step.status = 'skipped'
      step.error = '任务已取消'
      step.endedAt = timestamp
      task.updatedAt = timestamp
      const toolName = normalizedToolName(step.tool)
      if (shouldRecordStepToolRun(toolName)) {
        const runId = directRunId(step, activeStep.index)
        const previous = Array.isArray(task.toolRuns) ? task.toolRuns : []
        const base = previous.find((run) => run.id === runId)
        task.toolRuns = [
          ...previous.filter((run) => run.id !== runId),
          {
            id: runId,
            toolName,
            status: 'error' as const,
            inputPreview: base?.inputPreview ?? inputPreview(step),
            error: '任务已取消',
            startedAt: base?.startedAt ?? step.startedAt ?? timestamp,
            endedAt: timestamp,
          },
        ].slice(0, MAX_TOOL_RUNS)
      }
      return true
    })
  }
}

function expectedStep(task: TaskRecord, index: number, id: string): TaskStepRecord | null {
  if (task.currentStepIndex !== index) return null
  const step = task.steps[index]
  return step?.id === id ? step : null
}

function normalizedToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function shouldRecordStepToolRun(toolName: string): boolean {
  return toolName.length > 0 && toolName !== 'agent.run'
}

function directRunId(step: TaskStepRecord, index: number): string {
  return `step-${step.id || index}`
}

function inputPreview(step: TaskStepRecord): string {
  return clampText(step.input || '{}', normalizedToolName(step.tool) === 'image.generate' ? 6000 : 500)
}

function normalizeStringList(values: string[], limit: number): string[] {
  const max = Math.max(0, Math.trunc(limit))
  if (!Array.isArray(values) || max <= 0) return []
  const output: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    output.push(text)
    if (output.length >= max) break
  }
  return output
}

function clampText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}
