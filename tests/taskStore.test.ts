import type { TaskRecord } from '../electron/types'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TASK_RECORDS,
  normalizeTaskRecord,
  normalizeTaskState,
  TaskStore,
  type TaskStoreBackend,
} from '../electron/task/taskStore'

function task(id: string, status: TaskRecord['status'] = 'done', updatedAt = 1): TaskRecord {
  return {
    id,
    queue: 'other',
    title: `Task ${id}`,
    why: '',
    status,
    createdAt: 1,
    updatedAt,
    steps: [],
    currentStepIndex: 0,
    toolsUsed: [],
  }
}

function createBackend(tasks: unknown[]): TaskStoreBackend {
  return {
    store: { version: 1, tasks: tasks as TaskRecord[] },
  }
}

describe('Task record normalization', () => {
  it('rejects invalid tasks and sanitizes persisted steps, tool runs, and usage', () => {
    expect(normalizeTaskRecord(null)).toBeNull()
    expect(normalizeTaskRecord({ id: '', title: 'Missing id', status: 'done' })).toBeNull()
    expect(normalizeTaskRecord({ id: 'bad', title: 'Bad status', status: 'unknown' })).toBeNull()

    const record = normalizeTaskRecord(
      {
        id: 'task-1',
        title: '  Restored task  ',
        status: 'running',
        steps: [
          {
            title: '  First step  ',
            status: 'done',
            input: '  input  ',
          },
          { title: 42 },
        ],
        toolsUsed: ['web.search', 42],
        toolRuns: [
          {
            toolName: ' image.generate ',
            status: 'unexpected',
            imagePaths: [' one.png ', '', 42, 'two.png'],
          },
          { toolName: '' },
        ],
        usage: { promptTokens: 4, completionTokens: 'bad', totalTokens: 9 },
      },
      { createId: () => 'generated-step', now: () => 123 },
    )

    expect(record).toMatchObject({
      id: 'task-1',
      title: 'Restored task',
      status: 'running',
      createdAt: 123,
      updatedAt: 123,
      toolsUsed: ['web.search'],
      usage: { promptTokens: 4, completionTokens: 0, totalTokens: 9 },
    })
    expect(record?.steps).toEqual([
      expect.objectContaining({ id: 'generated-step', title: 'First step', status: 'done', input: 'input' }),
    ])
    expect(record?.toolRuns).toEqual([
      expect.objectContaining({
        id: 'run_0',
        toolName: 'image.generate',
        status: 'done',
        imagePaths: ['one.png', 'two.png'],
        startedAt: 123,
      }),
    ])
  })

  it('drops malformed entries and caps persisted history at the repository limit', () => {
    const tasks = [
      { id: '', title: 'invalid', status: 'done' },
      ...Array.from({ length: MAX_TASK_RECORDS + 5 }, (_, index) => task(`task-${index}`)),
    ]
    const state = normalizeTaskState({ version: 1, tasks: tasks as TaskRecord[] })

    expect(state.version).toBe(1)
    expect(state.tasks).toHaveLength(MAX_TASK_RECORDS)
    expect(state.tasks[0].id).toBe('task-0')
    expect(state.tasks.at(-1)?.id).toBe(`task-${MAX_TASK_RECORDS - 1}`)
  })
})

describe('Task store', () => {
  it('lists by latest update and resolves trimmed task ids', () => {
    const store = new TaskStore({
      backend: createBackend([task('older', 'done', 10), task('newer', 'done', 30), task('middle', 'done', 20)]),
      onChanged: vi.fn(),
    })

    expect(store.listTasks().items.map((item) => item.id)).toEqual(['newer', 'middle', 'older'])
    expect(store.getTask('  middle  ')?.id).toBe('middle')
    expect(store.getTask('')).toBeNull()
    expect(store.getTask('missing')).toBeNull()
  })

  it('normalizes existing state before writes and emits one change notification', () => {
    const backend = createBackend([task('valid'), { id: '', title: 'invalid', status: 'done' }])
    const onChanged = vi.fn()
    const store = new TaskStore({ backend, onChanged })

    store.update((draft) => {
      draft.tasks[0].title = 'Updated title'
    })

    expect(backend.store.tasks).toHaveLength(1)
    expect(backend.store.tasks[0].title).toBe('Updated title')
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('marks interrupted tasks as failed while preserving completed state and existing errors', () => {
    const pending = task('pending', 'pending', 10)
    const running = task('running', 'running', 11)
    const paused = { ...task('paused', 'paused', 12), lastError: 'Existing failure detail' }
    const done = task('done', 'done', 13)
    const backend = createBackend([pending, running, paused, done])
    const onChanged = vi.fn()
    const store = new TaskStore({ backend, now: () => 500, onChanged })

    store.recoverInterruptedTasks()

    const recovered = new Map(backend.store.tasks.map((item) => [item.id, item]))
    expect(recovered.get('pending')).toMatchObject({
      status: 'failed',
      updatedAt: 500,
      endedAt: 500,
      lastError: '任务在上次运行时尚未开始（应用被重启/崩溃）',
    })
    expect(recovered.get('running')).toMatchObject({
      status: 'failed',
      updatedAt: 500,
      endedAt: 500,
      lastError: '任务在上次运行时中断（应用被重启/崩溃）',
    })
    expect(recovered.get('paused')).toMatchObject({
      status: 'failed',
      updatedAt: 500,
      endedAt: 500,
      lastError: 'Existing failure detail',
    })
    expect(recovered.get('done')).toEqual(done)
    expect(onChanged).toHaveBeenCalledOnce()
  })
})
