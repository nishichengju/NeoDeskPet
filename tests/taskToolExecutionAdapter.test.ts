import { describe, expect, it, vi } from 'vitest'
import type { getSettings } from '../electron/store'
import type { ToolExecutionContext, ToolInput } from '../electron/toolExecutor'
import {
  TaskToolExecutionAdapter,
  type TaskToolExecutionRuntime,
} from '../electron/task/taskToolExecutionAdapter'
import type { TaskRecord } from '../electron/types'

const task = { id: 'task-1' } as TaskRecord

function runtime(): TaskToolExecutionRuntime {
  return {
    waitIfPaused: vi.fn(async () => undefined),
    isCanceled: vi.fn(() => false),
    setCancelCurrent: vi.fn(),
  }
}

function settings(): ReturnType<typeof getSettings> {
  return {
    tools: { enabled: true, groups: {}, tools: {} },
    orchestrator: { skillManagedDir: ' C:\\managed-skills ' },
  } as ReturnType<typeof getSettings>
}

describe('Task tool execution adapter', () => {
  it('executes MCP tools through the detailed result path and preserves structured images', async () => {
    const images = [{ mimeType: 'image/png', data: 'AQID' }]
    const callToolDetailed = vi.fn(async () => ({ text: 'mcp output', images }))
    const resolveImagePaths = vi.fn(async () => ['persisted.png'])
    const adapter = new TaskToolExecutionAdapter({
      userDataDir: 'C:\\user-data',
      mediaStore: { resolveImagePaths },
      mcpManager: { callToolDetailed },
      readSettings: settings,
      toolEnabled: vi.fn(() => true),
    })

    const result = await adapter.execute('mcp.demo.capture', { value: 1 }, task, runtime())

    expect(callToolDetailed).toHaveBeenCalledWith('mcp.demo.capture', { value: 1 })
    expect(resolveImagePaths).toHaveBeenCalledWith(task.id, 'mcp output', images)
    expect(result).toEqual({ output: 'mcp output', imagePaths: ['persisted.png'] })
  })

  it('passes runtime and managed skill refresh dependencies to builtin tools', async () => {
    let receivedContext: ToolExecutionContext | null = null
    const refreshSkillRegistry = vi.fn(async () => undefined)
    const executeBuiltin = vi.fn(
      async (_toolName: string, _input: ToolInput, context: ToolExecutionContext) => {
        receivedContext = context
        await context.refreshSkillRegistry?.()
        return '{"path":"C:\\\\captures\\\\frame.png"}'
      },
    )
    const resolveImagePaths = vi.fn(async () => ['C:\\captures\\frame.png'])
    const toolRuntime = runtime()
    const adapter = new TaskToolExecutionAdapter({
      userDataDir: 'C:\\user-data',
      mediaStore: { resolveImagePaths },
      refreshSkillRegistry,
      readSettings: settings,
      toolEnabled: vi.fn(() => true),
      executeBuiltin,
    })

    const result = await adapter.execute('file.read', { path: 'manifest.txt' }, task, toolRuntime)

    expect(receivedContext).toMatchObject({
      task,
      userDataDir: 'C:\\user-data',
      waitIfPaused: toolRuntime.waitIfPaused,
      isCanceled: toolRuntime.isCanceled,
      setCancelCurrent: toolRuntime.setCancelCurrent,
    })
    expect(refreshSkillRegistry).toHaveBeenCalledWith('C:\\managed-skills')
    expect(resolveImagePaths).toHaveBeenCalledWith(task.id, '{"path":"C:\\\\captures\\\\frame.png"}', [])
    expect(result.imagePaths).toEqual(['C:\\captures\\frame.png'])
  })

  it('dispatches the mmvector workflow and lets it execute checked child tools', async () => {
    const callToolDetailed = vi.fn(async () => ({ text: 'search output', images: [] }))
    const resolveImagePaths = vi.fn(async (_taskId: string, output: string) =>
      output.includes('workflow.png') ? ['C:\\workflow.png'] : [],
    )
    const runMmvectorVideoQa = vi.fn(async (_input, _task, _runtime, executeChildTool) => {
      const child = await executeChildTool('mcp.mmvector.search_by_text', { query: 'demo' })
      expect(child.output).toBe('search output')
      return '{"path":"C:\\\\workflow.png"}'
    })
    const toolEnabled = vi.fn((name: string) => name.length > 0)
    const adapter = new TaskToolExecutionAdapter({
      userDataDir: 'C:\\user-data',
      mediaStore: { resolveImagePaths },
      mcpManager: { callToolDetailed },
      runMmvectorVideoQa,
      readSettings: settings,
      toolEnabled,
    })

    const result = await adapter.execute(
      'workflow.mmvector_video_qa',
      { searchQuery: 'demo', question: 'what happens?' },
      task,
      runtime(),
    )

    expect(runMmvectorVideoQa).toHaveBeenCalledTimes(1)
    expect(toolEnabled.mock.calls.map(([name]) => name)).toEqual([
      'workflow.mmvector_video_qa',
      'mcp.mmvector.search_by_text',
    ])
    expect(result).toEqual({ output: '{"path":"C:\\\\workflow.png"}', imagePaths: ['C:\\workflow.png'] })
  })

  it('rejects disabled workflows before running them', async () => {
    const runMmvectorVideoQa = vi.fn(async () => 'unexpected')
    const adapter = new TaskToolExecutionAdapter({
      userDataDir: 'C:\\user-data',
      mediaStore: { resolveImagePaths: vi.fn(async () => []) },
      runMmvectorVideoQa,
      readSettings: settings,
      toolEnabled: vi.fn(() => false),
    })

    await expect(
      adapter.execute('workflow.mmvector_video_qa', { searchQuery: 'demo', question: 'question' }, task, runtime()),
    ).rejects.toThrow('tool disabled: workflow.mmvector_video_qa')
    expect(runMmvectorVideoQa).not.toHaveBeenCalled()
  })

  it('reports a missing MCP manager without falling through to builtin execution', async () => {
    const executeBuiltin = vi.fn(async () => 'unexpected')
    const adapter = new TaskToolExecutionAdapter({
      userDataDir: 'C:\\user-data',
      mediaStore: { resolveImagePaths: vi.fn(async () => []) },
      readSettings: settings,
      toolEnabled: vi.fn(() => true),
      executeBuiltin,
    })

    await expect(adapter.execute('mcp.demo.search', {}, task, runtime())).rejects.toThrow('MCP manager not initialized')
    expect(executeBuiltin).not.toHaveBeenCalled()
  })
})
