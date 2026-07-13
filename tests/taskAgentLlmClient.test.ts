import { describe, expect, it, vi } from 'vitest'
import type { OpenAIFunctionToolSpec } from '../electron/toolRegistry'
import { TaskAgentLlmClient, type TaskAgentLlmClientOptions } from '../electron/task/taskAgentLlmClient'
import { TOOL_REQUEST_END, TOOL_REQUEST_START } from '../electron/task/taskAgentTools'

const encoder = new TextEncoder()
const tools: OpenAIFunctionToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'ndp_delay_sleep',
      description: 'sleep',
      parameters: { type: 'object', properties: { ms: { type: 'integer' } } },
    },
  },
]

function streamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sse(...payloads: unknown[]): string {
  return `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`
}

function createOptions(overrides: Partial<TaskAgentLlmClientOptions> = {}): TaskAgentLlmClientOptions {
  return {
    apiMode: 'openai-compatible',
    endpoint: 'https://example.com/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    model: 'agent-test',
    temperature: 0.2,
    maxTokens: 900,
    reasoningExtra: {},
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'request' }],
    tools,
    sessionId: 'task-1',
    timeoutMs: 1000,
    retryLimit: 2,
    retryBaseDelayMs: 10,
    retryJitterMs: 0,
    isCanceled: () => false,
    setCancelCurrent: () => undefined,
    ...overrides,
  }
}

describe('Task agent LLM client', () => {
  it('stops an OpenAI text stream at a complete tool request across chunks', async () => {
    const protocol = [
      'draft',
      TOOL_REQUEST_START,
      'tool_name:「始」delay.sleep「末」',
      'input_json:「始」{"ms":1}「末」',
      TOOL_REQUEST_END,
      'ignored tail',
    ].join('\n')
    const frame = sse({ choices: [{ delta: { content: protocol } }] })
    const onDelta = vi.fn()
    const client = new TaskAgentLlmClient(
      createOptions({ fetchImpl: vi.fn(async () => streamResponse([frame.slice(0, 23), frame.slice(23)])) }),
    )

    const result = await client.callText({ stopOnToolRequest: true, onDelta })

    expect(result.contentText).toContain(TOOL_REQUEST_END)
    expect(result.contentText).not.toContain('ignored tail')
    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).toBe(result.contentText)
  })

  it('retries an empty 503 response after cleanup and reports deterministic backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonError(503, 'busy'))
      .mockResolvedValueOnce(streamResponse([sse({ choices: [{ delta: { content: 'done' } }] })]))
    const sleep = vi.fn(async () => undefined)
    const onRetry = vi.fn()
    const client = new TaskAgentLlmClient(
      createOptions({ fetchImpl, sleep, onRetry, random: () => 0.75 }),
    )

    await expect(client.callText()).resolves.toMatchObject({ contentText: 'done' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
    expect(onRetry).toHaveBeenCalledWith({
      delayMs: 10,
      errorMessage: 'busy',
      nextAttempt: 2,
      totalAttempts: 3,
    })
  })

  it('maps an active abort callback to canceled and clears it afterward', async () => {
    let cancelCurrent: (() => void) | undefined
    const setCancelCurrent = vi.fn((cancel?: () => void) => {
      cancelCurrent = cancel
    })
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const client = new TaskAgentLlmClient(createOptions({ fetchImpl, setCancelCurrent }))

    const pending = client.callText()
    await Promise.resolve()
    expect(cancelCurrent).toBeTypeOf('function')
    cancelCurrent?.()

    await expect(pending).rejects.toThrow('canceled')
    expect(cancelCurrent).toBeUndefined()
    expect(setCancelCurrent).toHaveBeenLastCalledWith(undefined)
  })

  it('keeps the vision-recovery request cancellable after the failed request is cleaned up', async () => {
    let cancelCurrent: (() => void) | undefined
    const setCancelCurrent = (cancel?: () => void) => {
      cancelCurrent = cancel
    }
    const recoverFromVisionError = vi.fn(async () => true)
    let resolveRecoveryRequest: ((response: Response) => void) | undefined
    let markRecoveryRequestStarted: (() => void) | undefined
    const recoveryRequestStarted = new Promise<void>((resolve) => {
      markRecoveryRequestStarted = resolve
    })
    const fetchImpl = vi
      .fn(async () => jsonError(400, 'vision unsupported'))
      .mockImplementationOnce(async () => jsonError(400, 'vision unsupported'))
      .mockImplementationOnce(async () => {
        markRecoveryRequestStarted?.()
        return new Promise<Response>((resolve) => {
          resolveRecoveryRequest = resolve
        })
      })
    const client = new TaskAgentLlmClient(
      createOptions({ fetchImpl, setCancelCurrent, recoverFromVisionError }),
    )

    const pending = client.callText()
    await recoveryRequestStarted
    await Promise.resolve()

    expect(cancelCurrent).toBeTypeOf('function')
    resolveRecoveryRequest?.(streamResponse([sse({ choices: [{ delta: { content: 'recovered' } }] })]))
    await expect(pending).resolves.toMatchObject({ contentText: 'recovered' })
    expect(cancelCurrent).toBeUndefined()
    expect(recoverFromVisionError).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('merges native tool-call name and arguments before returning the assistant message', async () => {
    const frames = sse(
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call-1', function: { name: 'ndp_delay_', arguments: '{"ms":' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'sleep', arguments: '1}' } }] } }] },
    )
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tool_choice).toBe('auto')
      expect(body.tools).toEqual(tools)
      return streamResponse([frames.slice(0, 40), frames.slice(40)])
    })
    const client = new TaskAgentLlmClient(createOptions({ fetchImpl }))

    const result = await client.callNative()

    expect(result.toolCalls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'ndp_delay_sleep', arguments: '{"ms":1}' } },
    ])
  })

  it('builds Claude Messages requests and merges usage across stream events', async () => {
    const frames = [
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { text: 'claude' } },
      { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 4 } },
      { type: 'message_stop' },
    ]
      .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
      .join('')
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.system).toBe('system')
      expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'request' }] }])
      return streamResponse([frames.slice(0, 17), frames.slice(17)])
    })
    const client = new TaskAgentLlmClient(
      createOptions({
        apiMode: 'claude',
        endpoint: 'https://example.com/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
        fetchImpl,
      }),
    )

    await expect(client.callText()).resolves.toEqual({
      contentText: 'claude',
      assistantMsgRaw: { role: 'assistant', content: 'claude' },
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    })
  })
})
