import type { TaskRecord } from '../electron/types'
import { describe, expect, it, vi } from 'vitest'
import {
  selectTaskIdsToStart,
  TaskRuntimeRegistry,
  TaskScheduler,
} from '../electron/task/taskRuntime'

function task(id: string, status: TaskRecord['status'], createdAt: number): TaskRecord {
  return {
    id,
    queue: 'other',
    title: id,
    why: '',
    status,
    createdAt,
    updatedAt: createdAt,
    steps: [],
    currentStepIndex: 0,
    toolsUsed: [],
  }
}

describe('Task runtime registry', () => {
  it('reuses one mutable runtime per task and recreates it after deletion', () => {
    const registry = new TaskRuntimeRegistry()
    const first = registry.ensure('task-1')
    const same = registry.ensure('task-1')
    expect(same).toBe(first)

    registry.delete('task-1')
    const replacement = registry.ensure('task-1')
    expect(replacement).not.toBe(first)
    expect(replacement).toEqual({ paused: false, canceled: false, waiters: [] })
  })

  it('holds paused work until resume and releases all queued waiters', async () => {
    const registry = new TaskRuntimeRegistry()
    const runtime = registry.pause('task-1')
    let released = 0
    const first = registry.waitIfPaused('task-1').then(() => {
      released += 1
    })
    const second = registry.waitIfPaused('task-1').then(() => {
      released += 1
    })
    await Promise.resolve()

    expect(released).toBe(0)
    expect(runtime.waiters).toHaveLength(2)
    expect(registry.resume('task-1')).toBe(runtime)
    await Promise.all([first, second])
    expect(released).toBe(2)
    expect(runtime.paused).toBe(false)
    expect(runtime.waiters).toEqual([])
  })

  it('cancels current work and releases paused waiters even if the cancel callback throws', async () => {
    const registry = new TaskRuntimeRegistry()
    const runtime = registry.pause('task-1')
    const cancelCurrent = vi.fn(() => {
      throw new Error('already closed')
    })
    runtime.cancelCurrent = cancelCurrent
    const waiting = registry.waitIfPaused('task-1')

    expect(() => registry.cancel('task-1')).not.toThrow()
    await waiting
    expect(cancelCurrent).toHaveBeenCalledOnce()
    expect(runtime).toMatchObject({ canceled: true, paused: false })
    expect(runtime.waiters).toEqual([])
  })
})

describe('Task scheduler', () => {
  it('fills only available running slots with the oldest pending tasks', () => {
    const tasks = [
      task('newer', 'pending', 30),
      task('running', 'running', 5),
      task('oldest', 'pending', 10),
      task('middle', 'pending', 20),
      task('paused', 'paused', 1),
    ]

    expect(selectTaskIdsToStart(tasks)).toEqual(['oldest', 'middle'])
    expect(selectTaskIdsToStart([...tasks, task('running-2', 'running', 6), task('running-3', 'running', 7)])).toEqual([])
  })

  it('coalesces kicks and starts the selected tasks when its timer fires', () => {
    const tasks = [task('later', 'pending', 20), task('first', 'pending', 10)]
    const callbacks: Array<() => void> = []
    const setTimer = vi.fn((callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(30)
      callbacks.push(callback)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    const startTask = vi.fn()
    const scheduler = new TaskScheduler({ readTasks: () => tasks, setTimer, startTask })

    scheduler.kick()
    scheduler.kick()
    expect(setTimer).toHaveBeenCalledOnce()
    expect(startTask).not.toHaveBeenCalled()

    callbacks[0]()
    expect(startTask.mock.calls.map(([id]) => id)).toEqual(['first', 'later'])

    scheduler.kick()
    expect(setTimer).toHaveBeenCalledTimes(2)
  })
})
