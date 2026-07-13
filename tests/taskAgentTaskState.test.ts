import { describe, expect, it, vi } from 'vitest'
import { TaskAgentTaskState } from '../electron/task/taskAgentTaskState'
import type { TaskAgentConversationSnapshot } from '../electron/task/taskAgentConversation'
import type { TaskRecord } from '../electron/types'

function task(): TaskRecord {
  return {
    id: 'task-state',
    queue: 'chat',
    title: 'Agent state',
    why: '',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    steps: [{ id: 'step-1', title: 'Run agent', status: 'running' }],
    currentStepIndex: 0,
    toolsUsed: [],
  }
}

function harness(options: { canceled?: boolean } = {}) {
  const record = task()
  let clock = 1_000
  let snapshot: TaskAgentConversationSnapshot = {
    draftReply: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }
  const finalize = vi.fn((text: string) => text.trim())
  const state = new TaskAgentTaskState({
    taskId: record.id,
    conversation: { finalize, snapshot: () => ({ ...snapshot, usage: { ...snapshot.usage } }) },
    updateTask: (mutator) => mutator(record),
    isCanceled: () => options.canceled === true,
    now: () => clock,
    createId: () => 'generated-run',
  })
  return {
    record,
    state,
    finalize,
    setClock: (value: number) => {
      clock = value
    },
    setSnapshot: (value: TaskAgentConversationSnapshot) => {
      snapshot = value
    },
  }
}

describe('Task agent task state', () => {
  it('resets stale presentation and tool state before a new run', () => {
    const h = harness()
    h.record.draftReply = 'old draft'
    h.record.finalReply = 'old final'
    h.record.live2dExpression = 'old-expression'
    h.record.live2dMotion = 'old-motion'
    h.record.toolRuns = [
      { id: 'old', toolName: 'delay.sleep', status: 'done', startedAt: 1, endedAt: 2 },
    ]

    h.state.reset()

    expect(h.record).toMatchObject({
      draftReply: '',
      finalReply: undefined,
      live2dExpression: undefined,
      live2dMotion: undefined,
      toolRuns: [],
      updatedAt: 1_000,
    })
  })

  it('throttles progress writes while retaining logs and conversation presentation', () => {
    const h = harness()
    h.state.reset()
    h.setSnapshot({
      draftReply: 'draft one',
      live2dExpression: 'smile',
      usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    })
    h.state.pushLog(' first log ')
    expect(h.record.steps[0].output).toBe('first log')
    expect(h.record.draftReply).toBe('draft one')

    h.setClock(1_100)
    h.setSnapshot({
      draftReply: 'draft two',
      live2dMotion: 'wave',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    h.state.pushLog('second log')
    expect(h.record.steps[0].output).toBe('first log')

    h.setClock(1_300)
    h.state.updateProgress()
    expect(h.record.steps[0].output).toBe('first log\nsecond log')
    expect(h.record).toMatchObject({ draftReply: 'draft two', live2dMotion: 'wave' })
  })

  it('upserts tool runs, preserves prior fields, and normalizes image paths', () => {
    const h = harness()
    h.state.reset()
    h.state.upsertToolRun({
      id: '',
      toolName: 'image.generate',
      status: 'running',
      inputPreview: 'prompt',
      imagePaths: ['C:\\\\images\\\\one.png', 'C:\\images\\one.png'],
      startedAt: 10,
    })
    h.state.upsertToolRun({
      id: 'generated-run',
      toolName: 'image.generate',
      status: 'done',
      outputPreview: 'done',
      endedAt: 20,
    })

    expect(h.record.toolRuns).toEqual([
      {
        id: 'generated-run',
        toolName: 'image.generate',
        status: 'done',
        inputPreview: 'prompt',
        outputPreview: 'done',
        imagePaths: ['C:\\images\\one.png'],
        error: undefined,
        startedAt: 10,
        endedAt: 20,
      },
    ])
    expect(h.state.hasFinishedToolRun()).toBe(true)
  })

  it('records tools once and skips progress writes after cancellation', () => {
    const active = harness()
    active.state.recordToolUsed('delay.sleep')
    active.state.recordToolUsed('delay.sleep')
    expect(active.record.toolsUsed).toEqual(['delay.sleep'])

    const canceled = harness({ canceled: true })
    canceled.state.reset()
    canceled.state.pushLog('should stay internal', true)
    expect(canceled.record.steps[0].output).toBeUndefined()
  })

  it('finalizes reply, presentation, tool runs, and non-zero usage', () => {
    const h = harness()
    h.state.reset()
    h.state.upsertToolRun({ id: 'run-1', toolName: 'delay.sleep', status: 'done', startedAt: 5, endedAt: 6 })
    h.setSnapshot({
      draftReply: 'final answer',
      live2dExpression: 'happy',
      live2dMotion: 'nod',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    })

    const output = h.state.finalize(' final answer ')

    expect(output).toBe('final answer')
    expect(h.finalize).toHaveBeenCalledWith(' final answer ')
    expect(h.record).toMatchObject({
      finalReply: 'final answer',
      draftReply: 'final answer',
      live2dExpression: 'happy',
      live2dMotion: 'nod',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    })
    expect(h.record.toolRuns?.[0]?.id).toBe('run-1')
  })
})
