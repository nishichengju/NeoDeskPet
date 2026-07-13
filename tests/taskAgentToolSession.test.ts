import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../electron/toolRegistry'
import { TaskAgentToolCatalog } from '../electron/task/taskAgentTools'
import {
  TaskAgentToolSession,
  type TaskAgentToolExecution,
  type TaskAgentToolSessionOptions,
} from '../electron/task/taskAgentToolSession'

function tool(name: string, callName: string): ToolDefinition {
  return {
    name,
    callName,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    examples: [],
    risk: 'low',
    cost: 'low',
    tags: [],
    version: '1',
  }
}

function createHarness(overrides: Partial<TaskAgentToolSessionOptions> = {}) {
  const catalog = new TaskAgentToolCatalog([
    tool('browser.fetch', 'ndp_browser_fetch'),
    tool('image.generate', 'ndp_image_generate'),
  ])
  const executeTool = vi.fn(async (): Promise<TaskAgentToolExecution> => ({ output: 'tool output', imagePaths: [] }))
  const recordToolUsed = vi.fn()
  const upsertToolRun = vi.fn()
  const pushLog = vi.fn()
  let nextId = 0
  const session = new TaskAgentToolSession({
    catalog,
    executeTool,
    recordToolUsed,
    upsertToolRun,
    pushLog,
    inputPreview: (_toolName, input) => JSON.stringify(input),
    now: () => 100,
    createId: () => `run-${++nextId}`,
    ...overrides,
  })
  return { session, executeTool, recordToolUsed, upsertToolRun, pushLog }
}

describe('Task agent tool session', () => {
  it('executes a native call with parsed arguments and records its lifecycle', async () => {
    const harness = createHarness()

    const result = await harness.session.executeNative({
      id: 'call-1',
      type: 'function',
      function: { name: 'ndp_browser_fetch', arguments: '{"url":"https://example.com"}' },
    })

    expect(harness.executeTool).toHaveBeenCalledWith(
      'browser.fetch',
      { url: 'https://example.com' },
      {
        runId: 'call-1',
        requestedName: 'ndp_browser_fetch',
        recordName: 'browser.fetch',
        source: 'native',
      },
    )
    expect(harness.recordToolUsed).toHaveBeenCalledOnce()
    expect(harness.upsertToolRun.mock.calls.map(([patch]) => patch.status)).toEqual(['running', 'done'])
    expect(result).toMatchObject({
      runId: 'call-1',
      toolName: 'browser.fetch',
      input: { url: 'https://example.com' },
      toolMessage: 'tool output',
      unknown: false,
    })
    expect(harness.session.buildEvidenceText('request')).toBe('request\n\ntool output')
  })

  it('returns an unknown native call as a tool message without executing or recording a run', async () => {
    const harness = createHarness()

    const result = await harness.session.executeNative({
      id: 'missing-call',
      type: 'function',
      function: { name: 'ndp_missing_tool', arguments: '{}' },
    })

    expect(result).toMatchObject({
      runId: 'missing-call',
      toolName: null,
      toolMessage: '未知工具：ndp_missing_tool',
      unknown: true,
    })
    expect(harness.executeTool).not.toHaveBeenCalled()
    expect(harness.recordToolUsed).not.toHaveBeenCalled()
    expect(harness.upsertToolRun).not.toHaveBeenCalled()
  })

  it('normalizes a text alias and skips an identical repeated call', async () => {
    const harness = createHarness()
    const input = { url: 'https://example.com' }

    await harness.session.executeText('mcp.fetch.fetch', input)
    await harness.session.executeText('mcp.fetch.fetch', input)

    expect(harness.executeTool).toHaveBeenCalledOnce()
    expect(harness.recordToolUsed).toHaveBeenCalledOnce()
    expect(harness.pushLog.mock.calls.map(([line]) => line)).toContain(
      '[Tool] normalize alias: mcp.fetch.fetch -> browser.fetch',
    )
    expect(harness.pushLog.mock.calls.map(([line]) => line)).toContain('[Tool] browser.fetch skip duplicate')
    expect(harness.session.listExecutedCallOrder()).toEqual([
      { toolName: 'mcp.fetch.fetch', input, output: 'tool output' },
    ])
  })

  it('turns an unknown text tool into a recorded error with suggestions', async () => {
    const harness = createHarness()

    const result = await harness.session.executeText('browser.fetc', { value: 'x' })

    expect(harness.executeTool).not.toHaveBeenCalled()
    expect(harness.recordToolUsed).not.toHaveBeenCalled()
    expect(result.unknown).toBe(true)
    expect(result.output).toContain('[error] 未知工具：browser.fetc')
    expect(result.output).toContain('browser.fetch')
    expect(harness.upsertToolRun.mock.calls.map(([patch]) => patch.status)).toEqual(['running', 'error', 'error'])
  })

  it('caches native execution errors and does not repeat the same failing call', async () => {
    const executeTool = vi.fn(async () => {
      throw new Error('network failed')
    })
    const harness = createHarness({ executeTool })
    const call = {
      type: 'function' as const,
      function: { name: 'ndp_browser_fetch', arguments: '{"value":"same"}' },
    }

    const first = await harness.session.executeNative({ id: 'call-1', ...call })
    const second = await harness.session.executeNative({ id: 'call-2', ...call })

    expect(executeTool).toHaveBeenCalledOnce()
    expect(first.output).toBe('[error] network failed')
    expect(second.output).toBe('[error] network failed')
    expect(harness.session.listExecutedCallOrder()).toHaveLength(1)
  })

  it('uses model-safe output and carries visual parts into the next model turn', async () => {
    const visionParts = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
    const executeTool = vi.fn(async (): Promise<TaskAgentToolExecution> => ({
      output: '{"path":"C:\\image.png"}',
      modelOutput: 'visual artifact vis_1 is ready',
      imagePaths: ['C:\\image.png'],
      visionParts,
    }))
    const harness = createHarness({ executeTool })

    const result = await harness.session.executeText('image.generate', { prompt: 'test' })

    expect(result.toolMessage).toBe('visual artifact vis_1 is ready')
    expect(result.imagePaths).toEqual(['C:\\image.png'])
    expect(result.visionParts).toEqual(visionParts)
    expect(harness.session.buildEvidenceText('')).toBe('visual artifact vis_1 is ready')
  })
})
