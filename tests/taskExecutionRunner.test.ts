import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord, TaskStepRecord } from '../electron/types'
import {
  TaskExecutionRunner,
  type TaskExecutionRunnerOptions,
  type TaskStepExecutionResult,
} from '../electron/task/taskExecutionRunner'

function step(id: string, tool?: string, input?: string): TaskStepRecord {
  return { id, title: id, status: 'pending', tool, input }
}

function task(steps: TaskStepRecord[], status: TaskRecord['status'] = 'running'): TaskRecord {
  return {
    id: 'task-1',
    queue: 'other',
    title: 'runner task',
    why: '',
    status,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    steps,
    currentStepIndex: 0,
    toolsUsed: [],
  }
}

function cloneTask(value: TaskRecord): TaskRecord {
  return JSON.parse(JSON.stringify(value)) as TaskRecord
}

function createHarness(initialTask: TaskRecord, overrides: Partial<TaskExecutionRunnerOptions> = {}) {
  let current: TaskRecord | null = cloneTask(initialTask)
  let canceled = false
  let clock = 100
  const readTask = vi.fn(() => (current ? cloneTask(current) : null))
  const updateTask = vi.fn((mutator: (draft: TaskRecord) => boolean) => {
    if (!current) return false
    const draft = cloneTask(current)
    const changed = mutator(draft)
    if (changed) current = draft
    return changed
  })
  const waitIfPaused = vi.fn(async () => undefined)
  const executeStep = vi.fn(async (_task: TaskRecord, currentStep: TaskStepRecord): Promise<TaskStepExecutionResult> => ({
    output: `done ${currentStep.id}`,
    imagePaths: [],
  }))
  const onFinished = vi.fn()
  const options: TaskExecutionRunnerOptions = {
    taskId: initialTask.id,
    readTask,
    updateTask,
    waitIfPaused,
    isCanceled: () => canceled,
    executeStep,
    onFinished,
    now: () => ++clock,
    ...overrides,
  }
  const runner = new TaskExecutionRunner(options)
  return {
    runner,
    readTask,
    updateTask,
    waitIfPaused,
    executeStep,
    onFinished,
    get current() {
      return current ? cloneTask(current) : null
    },
    setStatus(status: TaskRecord['status']) {
      if (current) current.status = status
    },
    removeTask() {
      current = null
    },
    cancel() {
      canceled = true
      if (current) {
        current.status = 'canceled'
        current.endedAt = ++clock
      }
    },
  }
}

describe('Task execution runner', () => {
  it('executes steps in order, records direct tools, and completes the task', async () => {
    const harness = createHarness(task([
      step('direct', 'delay.sleep', '{"ms":1}'),
      step('agent', 'agent.run', '{"request":"finish"}'),
    ]))
    harness.executeStep
      .mockResolvedValueOnce({ output: 'slept', imagePaths: ['C:\\one.png', 'C:\\one.png', 'C:\\two.png'] })
      .mockResolvedValueOnce({ output: 'agent complete', imagePaths: [] })

    await harness.runner.run()

    expect(harness.executeStep.mock.calls.map(([, currentStep]) => currentStep.id)).toEqual(['direct', 'agent'])
    expect(harness.current).toMatchObject({ status: 'done', currentStepIndex: 2, toolsUsed: ['delay.sleep', 'agent.run'] })
    expect(harness.current?.steps.map((item) => ({ status: item.status, output: item.output }))).toEqual([
      { status: 'done', output: 'slept' },
      { status: 'done', output: 'agent complete' },
    ])
    expect(harness.current?.toolRuns).toEqual([
      expect.objectContaining({
        id: 'step-direct',
        toolName: 'delay.sleep',
        status: 'done',
        outputPreview: 'slept',
        imagePaths: ['C:\\one.png', 'C:\\two.png'],
      }),
    ])
    expect(harness.onFinished).toHaveBeenCalledOnce()
  })

  it('finishes an empty task and invokes cleanup only once', async () => {
    const harness = createHarness(task([]))

    await harness.runner.run()

    expect(harness.current?.status).toBe('done')
    expect(harness.executeStep).not.toHaveBeenCalled()
    expect(harness.onFinished).toHaveBeenCalledOnce()
  })

  it('waits for a paused task to resume before executing its current step', async () => {
    const harness = createHarness(task([step('paused-step')], 'paused'))
    harness.waitIfPaused.mockImplementationOnce(async () => {
      harness.setStatus('running')
    })

    await harness.runner.run()

    expect(harness.waitIfPaused).toHaveBeenCalledTimes(3)
    expect(harness.executeStep).toHaveBeenCalledOnce()
    expect(harness.current?.status).toBe('done')
  })

  it('finalizes the active step and direct tool run when cancellation wins', async () => {
    const harness = createHarness(task([step('cancel-me', 'delay.sleep', '{"ms":5000}')]))
    harness.executeStep.mockImplementationOnce(async () => {
      harness.cancel()
      return { output: 'late result', imagePaths: [] }
    })

    await harness.runner.run()

    expect(harness.current).toMatchObject({ status: 'canceled', currentStepIndex: 0 })
    expect(harness.current?.steps[0]).toMatchObject({ status: 'skipped', error: '任务已取消' })
    expect(harness.current?.toolRuns?.[0]).toMatchObject({ status: 'error', error: '任务已取消' })
    expect(harness.current?.lastError).toBeUndefined()
    expect(harness.onFinished).toHaveBeenCalledOnce()
  })

  it('marks the task, active step, and direct tool run failed when execution throws', async () => {
    const harness = createHarness(task([step('fail-me', 'missing.tool', '{"value":1}')]))
    harness.executeStep.mockRejectedValueOnce(new Error('tool failed'))

    await harness.runner.run()

    expect(harness.current).toMatchObject({ status: 'failed', currentStepIndex: 0, lastError: 'tool failed' })
    expect(harness.current?.steps[0]).toMatchObject({ status: 'failed', error: 'tool failed' })
    expect(harness.current?.toolRuns?.[0]).toMatchObject({ status: 'error', error: 'tool failed' })
    expect(harness.onFinished).toHaveBeenCalledOnce()
  })

  it('does not execute a step after the task disappears at the pause gate', async () => {
    const harness = createHarness(task([step('removed', 'delay.sleep')]))
    harness.waitIfPaused.mockImplementationOnce(async () => {
      harness.removeTask()
    })

    await harness.runner.run()

    expect(harness.executeStep).not.toHaveBeenCalled()
    expect(harness.current).toBeNull()
    expect(harness.onFinished).toHaveBeenCalledOnce()
  })
})
