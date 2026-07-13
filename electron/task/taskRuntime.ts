import type { TaskRecord } from '../types'

export const MAX_CONCURRENT_TASKS = 3
export const TASK_SCHEDULER_DELAY_MS = 30

export type TaskRuntime = {
  paused: boolean
  canceled: boolean
  waiters: Array<() => void>
  cancelCurrent?: () => void
}

export class TaskRuntimeRegistry {
  private readonly runtimes = new Map<string, TaskRuntime>()

  ensure(id: string): TaskRuntime {
    const existing = this.runtimes.get(id)
    if (existing) return existing
    const runtime: TaskRuntime = { paused: false, canceled: false, waiters: [] }
    this.runtimes.set(id, runtime)
    return runtime
  }

  pause(id: string): TaskRuntime {
    const runtime = this.ensure(id)
    runtime.paused = true
    return runtime
  }

  resume(id: string): TaskRuntime {
    const runtime = this.ensure(id)
    runtime.paused = false
    for (const waiter of runtime.waiters.splice(0)) waiter()
    return runtime
  }

  cancel(id: string): TaskRuntime {
    const runtime = this.ensure(id)
    runtime.canceled = true
    runtime.paused = false
    try {
      runtime.cancelCurrent?.()
    } catch {
      // Cancellation is best-effort; waiters must still be released.
    }
    for (const waiter of runtime.waiters.splice(0)) waiter()
    return runtime
  }

  delete(id: string): void {
    this.runtimes.delete(id)
  }

  async waitIfPaused(id: string): Promise<void> {
    const runtime = this.ensure(id)
    if (!runtime.paused) return
    await new Promise<void>((resolve) => {
      runtime.waiters.push(resolve)
    })
  }
}

export function selectTaskIdsToStart(
  tasks: TaskRecord[],
  maxConcurrent = MAX_CONCURRENT_TASKS,
): string[] {
  const runningCount = tasks.filter((task) => task.status === 'running').length
  const capacity = Math.max(0, maxConcurrent - runningCount)
  if (capacity <= 0) return []
  return tasks
    .filter((task) => task.status === 'pending')
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, capacity)
    .map((task) => task.id)
}

type TaskSchedulerOptions = {
  delayMs?: number
  maxConcurrent?: number
  readTasks: () => TaskRecord[]
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  startTask: (id: string) => void
}

export class TaskScheduler {
  private readonly delayMs: number
  private readonly maxConcurrent: number
  private readonly readTasks: () => TaskRecord[]
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly startTask: (id: string) => void
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TaskSchedulerOptions) {
    this.delayMs = options.delayMs ?? TASK_SCHEDULER_DELAY_MS
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_TASKS
    this.readTasks = options.readTasks
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.startTask = options.startTask
  }

  kick(): void {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      for (const id of selectTaskIdsToStart(this.readTasks(), this.maxConcurrent)) {
        this.startTask(id)
      }
    }, this.delayMs)
  }
}
