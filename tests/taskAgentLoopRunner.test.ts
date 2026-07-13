import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../electron/toolRegistry'
import { TaskAgentConversation } from '../electron/task/taskAgentConversation'
import {
  TaskAgentLoopRunner,
  type TaskAgentLoopRunnerOptions,
} from '../electron/task/taskAgentLoopRunner'
import type { TaskAgentTextResult } from '../electron/task/taskAgentLlmClient'
import type { NativeAssistantResult } from '../electron/task/taskAgentLlmProtocol'
import { TaskAgentToolCatalog, TOOL_REQUEST_END, TOOL_REQUEST_START } from '../electron/task/taskAgentTools'
import type { TaskAgentToolCallResult } from '../electron/task/taskAgentToolSession'

function tool(name: string, callName: string): ToolDefinition {
  return {
    name,
    callName,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
    examples: [],
    risk: 'low',
    cost: 'low',
    tags: [],
    version: '1',
  }
}

function toolResult(overrides: Partial<TaskAgentToolCallResult> = {}): TaskAgentToolCallResult {
  return {
    runId: 'call-1',
    requestedName: 'ndp_delay_sleep',
    toolName: 'delay.sleep',
    input: { ms: 1 },
    output: 'sleep 1ms',
    modelOutput: 'sleep 1ms',
    toolMessage: 'sleep 1ms',
    imagePaths: [],
    visionParts: [],
    unknown: false,
    ...overrides,
  }
}

function createHarness(overrides: Partial<TaskAgentLoopRunnerOptions> = {}) {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'request' },
  ]
  const conversation = new TaskAgentConversation(3)
  const callNative = vi.fn(
    async (
      _options?: Parameters<TaskAgentLoopRunnerOptions['llmClient']['callNative']>[0],
    ): Promise<NativeAssistantResult> => {
      void _options
      return {
        contentText: 'native final',
        toolCalls: [],
        rawToolCalls: [],
        assistantMsgRaw: { role: 'assistant', content: 'native final' },
      }
    },
  )
  const callText = vi.fn(
    async (
      _options?: Parameters<TaskAgentLoopRunnerOptions['llmClient']['callText']>[0],
    ): Promise<TaskAgentTextResult> => {
      void _options
      return {
        contentText: 'text final',
        assistantMsgRaw: { role: 'assistant', content: 'text final' },
      }
    },
  )
  const executeNative = vi.fn(async () => toolResult())
  const executeText = vi.fn(async () => toolResult())
  const pushLog = vi.fn()
  const updateProgress = vi.fn()
  const prepareTextFallback = vi.fn(async () => undefined)
  const options: TaskAgentLoopRunnerOptions = {
    apiMode: 'openai-compatible',
    mode: 'native',
    maxTurns: 3,
    messages,
    textGuide: 'text guide',
    llmClient: { callNative, callText } as unknown as TaskAgentLoopRunnerOptions['llmClient'],
    toolCatalog: new TaskAgentToolCatalog([tool('delay.sleep', 'ndp_delay_sleep')]),
    toolSession: { executeNative, executeText } as unknown as TaskAgentLoopRunnerOptions['toolSession'],
    conversation,
    waitIfPaused: async () => undefined,
    isCanceled: () => false,
    pushLog,
    updateProgress,
    tryFinalize: (candidate) => ({ done: true, text: conversation.finalize(candidate) }),
    finalize: (text) => conversation.finalize(text),
    prepareTextFallback,
    ...overrides,
  }
  return {
    runner: new TaskAgentLoopRunner(options),
    messages: options.messages,
    conversation: options.conversation,
    callNative,
    callText,
    executeNative,
    executeText,
    pushLog,
    updateProgress,
    prepareTextFallback,
  }
}

describe('Task agent loop runner', () => {
  it('runs native tool calls and appends role=tool results before the next turn', async () => {
    const harness = createHarness()
    harness.callNative
      .mockImplementationOnce(async (options) => {
        options?.onDelta?.('working')
        return {
          contentText: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'ndp_delay_sleep', arguments: '{"ms":1}' },
            },
          ],
          rawToolCalls: [],
          assistantMsgRaw: { role: 'assistant', tool_calls: [] },
        }
      })
      .mockResolvedValueOnce({
        contentText: 'native complete',
        toolCalls: [],
        rawToolCalls: [],
        assistantMsgRaw: { role: 'assistant', content: 'native complete' },
      })

    await expect(harness.runner.run()).resolves.toBe('native complete')
    expect(harness.executeNative).toHaveBeenCalledOnce()
    expect(harness.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(harness.messages[3]).toMatchObject({ tool_call_id: 'call-1', content: 'sleep 1ms' })
    expect(harness.updateProgress).toHaveBeenCalled()
  })

  it('runs text tool requests, inserts the guide, carries vision parts, and accumulates usage', async () => {
    const protocol = [
      TOOL_REQUEST_START,
      'tool_name:「始」delay.sleep「末」',
      'input_json:「始」{"ms":1}「末」',
      TOOL_REQUEST_END,
    ].join('\n')
    const visionParts = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
    const harness = createHarness({ mode: 'text' })
    harness.executeText.mockResolvedValueOnce(toolResult({ visionParts }))
    harness.callText
      .mockResolvedValueOnce({
        contentText: protocol,
        assistantMsgRaw: { role: 'assistant', content: protocol },
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      })
      .mockResolvedValueOnce({
        contentText: 'text complete',
        assistantMsgRaw: { role: 'assistant', content: 'text complete' },
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      })

    await expect(harness.runner.run()).resolves.toBe('text complete')
    expect(harness.messages[1]).toEqual({ role: 'system', content: 'text guide' })
    expect(harness.executeText).toHaveBeenCalledWith('delay.sleep', { ms: 1 })
    expect(harness.messages.some((message) => Array.isArray(message.content))).toBe(true)
    expect(harness.conversation.snapshot().usage).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 })
  })

  it('forces Claude requests through the text protocol', async () => {
    const harness = createHarness({ apiMode: 'claude', mode: 'native' })

    await expect(harness.runner.run()).resolves.toBe('text final')
    expect(harness.callNative).not.toHaveBeenCalled()
    expect(harness.callText).toHaveBeenCalledOnce()
    expect(harness.pushLog).toHaveBeenCalledWith(
      '[Agent] Claude Messages API uses text tool protocol for compatibility',
      true,
    )
  })

  it('prepares text fallback after an auto native failure before issuing the text request', async () => {
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'request' }]
    let fallbackPrepared = false
    const harness = createHarness({
      mode: 'auto',
      messages,
      prepareTextFallback: async () => {
        fallbackPrepared = true
        messages.push({ role: 'user', content: 'replayed tool result' })
      },
    })
    harness.callNative.mockRejectedValueOnce(new Error('thought_signature is required'))
    harness.callText.mockImplementationOnce(async () => {
      expect(fallbackPrepared).toBe(true)
      expect(messages.some((message) => message.content === 'replayed tool result')).toBe(true)
      return {
        contentText: 'fallback complete',
        assistantMsgRaw: { role: 'assistant', content: 'fallback complete' },
      }
    })

    await expect(harness.runner.run()).resolves.toBe('fallback complete')
    expect(harness.pushLog.mock.calls.map(([line]) => line)).toContain(
      '[Agent] auto detected native tools incompatibility, fallback to text',
    )
  })

  it('does not fallback or call the model when the task is already canceled', async () => {
    const prepareTextFallback = vi.fn(async () => undefined)
    const harness = createHarness({ mode: 'auto', isCanceled: () => true, prepareTextFallback })

    await expect(harness.runner.run()).rejects.toThrow('canceled')
    expect(harness.callNative).not.toHaveBeenCalled()
    expect(harness.callText).not.toHaveBeenCalled()
    expect(prepareTextFallback).not.toHaveBeenCalled()
  })
})
