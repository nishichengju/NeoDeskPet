import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerTaskIpc, type TaskIpcService } from '../electron/ipc/registerTaskIpc'
import type { IpcHandle } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'
import type { TaskCreateArgs, TaskRecord } from '../electron/types'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function task(id = 'task-1'): TaskRecord {
  return {
    id,
    queue: 'chat',
    title: 'Task',
    why: '',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    currentStepIndex: 0,
    toolsUsed: [],
  }
}

function createHarness(service: TaskIpcService | null) {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => {
    handlers.set(channel, listener)
  }) as IpcHandle
  registerTaskIpc({ handle, getTaskService: () => service })

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({} as IpcMainInvokeEvent, ...args) as Result
  }
  return { handlers, invoke }
}

describe('task IPC registration', () => {
  it('registers every task channel', () => {
    const harness = createHarness(null)
    expect([...harness.handlers.keys()].sort()).toEqual([
      'task:cancel',
      'task:create',
      'task:dismiss',
      'task:get',
      'task:list',
      'task:pause',
      'task:resume',
      'task:updateToolRunImages',
    ])
  })

  it('preserves service-not-ready return values and create error', () => {
    const harness = createHarness(null)
    expect(harness.invoke('task:list')).toEqual({ items: [] })
    expect(harness.invoke('task:get', 'task-1')).toBeNull()
    expect(harness.invoke('task:updateToolRunImages', 'task-1', 'run-1', ['one.png'])).toBeNull()
    expect(harness.invoke('task:pause', 'task-1')).toBeNull()
    expect(harness.invoke('task:resume', 'task-1')).toBeNull()
    expect(harness.invoke('task:cancel', 'task-1')).toBeNull()
    expect(harness.invoke('task:dismiss', 'task-1')).toBeNull()
    expect(() => harness.invoke('task:create', { title: 'Task' })).toThrow('Task service not ready')
  })

  it('delegates task operations and arguments to TaskService', () => {
    const record = task()
    const createArgs: TaskCreateArgs = { title: 'Created task', steps: [] }
    const service = {
      listTasks: vi.fn(() => ({ items: [record] })),
      getTask: vi.fn(() => record),
      updateToolRunImages: vi.fn(() => record),
      createTask: vi.fn(() => record),
      pauseTask: vi.fn(() => record),
      resumeTask: vi.fn(() => record),
      cancelTask: vi.fn(() => record),
      dismissTask: vi.fn(() => ({ ok: true as const })),
    }
    const harness = createHarness(service)

    expect(harness.invoke('task:list')).toEqual({ items: [record] })
    expect(harness.invoke('task:get', 'task-1')).toBe(record)
    expect(harness.invoke('task:updateToolRunImages', 'task-1', 'run-1', ['one.png'])).toBe(record)
    expect(service.updateToolRunImages).toHaveBeenCalledWith('task-1', 'run-1', ['one.png'])
    expect(harness.invoke('task:create', createArgs)).toBe(record)
    expect(service.createTask).toHaveBeenCalledWith(createArgs)
    expect(harness.invoke('task:pause', 'task-1')).toBe(record)
    expect(harness.invoke('task:resume', 'task-1')).toBe(record)
    expect(harness.invoke('task:cancel', 'task-1')).toBe(record)
    expect(harness.invoke('task:dismiss', 'task-1')).toEqual({ ok: true })
  })
})
