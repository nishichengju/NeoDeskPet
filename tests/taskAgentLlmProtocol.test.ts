import { describe, expect, it } from 'vitest'
import {
  buildAgentEndpoint,
  buildAgentHeaders,
  buildClaudeTextPayload,
  createHttpStatusError,
  isAbortLikeError,
  mergeLlmUsage,
  NativeAssistantStreamAccumulator,
  parseNativeAssistantMessage,
  parseTextStreamPayload,
  readErrorStatus,
  shouldRetryTransientError,
  SseDataBuffer,
  transientRetryDelayMs,
} from '../electron/task/taskAgentLlmProtocol'

describe('Task agent provider configuration', () => {
  it('builds provider endpoints and credential headers', () => {
    expect(buildAgentEndpoint('https://api.example.com/v1/', 'openai-compatible')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(buildAgentEndpoint('https://api.example.com/v1', 'claude')).toBe('https://api.example.com/v1/messages')
    expect(buildAgentHeaders('openai-compatible', 'openai-key')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer openai-key',
    })
    expect(buildAgentHeaders('claude', 'claude-key')).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'claude-key',
    })
  })

  it('classifies retryable failures without retrying cancellation or exhausted attempts', () => {
    const statusError = createHttpStatusError('busy', 503)

    expect(readErrorStatus(statusError)).toBe(503)
    expect(shouldRetryTransientError(0, 2, statusError, 503)).toBe(true)
    expect(shouldRetryTransientError(0, 2, new Error('socket hang up'), null)).toBe(true)
    expect(shouldRetryTransientError(2, 2, statusError, 503)).toBe(false)
    expect(shouldRetryTransientError(0, 2, new Error('canceled'), null)).toBe(false)
    expect(isAbortLikeError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(transientRetryDelayMs(2, 500, 250, () => 0.5)).toBe(2125)
  })
})

describe('Task agent Claude payloads and usage', () => {
  it('converts system, adjacent roles, text, base64 images, URLs, and thinking settings', () => {
    const payload = buildClaudeTextPayload({
      messages: [
        { role: 'system', content: 'system one' },
        { role: 'system', content: [{ type: 'text', text: 'system two' }] },
        { role: 'user', content: 'first' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'second' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
        { role: 'assistant', content: 'answer' },
      ],
      model: 'claude-smoke',
      maxTokens: 2048,
      temperature: 0.3,
      thinking: { type: 'enabled', budget_tokens: 512 },
      stream: true,
    })

    expect(payload.system).toBe('system one\n\nsystem two')
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 512 })
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])
  })

  it('merges partial provider usage without discarding earlier nonzero values', () => {
    expect(
      mergeLlmUsage(
        { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
        { promptTokens: 0, completionTokens: 4, totalTokens: 4 },
      ),
    ).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 })
  })
})

describe('Task agent native responses', () => {
  it('normalizes content arrays, missing IDs, alternate functionCall shapes, and object arguments', () => {
    const parsed = parseNativeAssistantMessage({
      content: [{ text: 'hello' }, { text: 'world' }],
      tool_calls: [
        { functionCall: { name: 'ndp_one', args: { value: 1 } } },
        { id: 'provided', name: 'ndp_two', arguments: { value: 2 } },
      ],
    })

    expect(parsed.contentText).toBe('hello\nworld')
    expect(parsed.toolCalls).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'ndp_one', arguments: '{"value":1}' } },
      { id: 'provided', type: 'function', function: { name: 'ndp_two', arguments: '{"value":2}' } },
    ])
    expect(parsed.assistantMsgRaw.role).toBe('assistant')
  })

  it('converts legacy function_call responses into normalized tool calls', () => {
    const parsed = parseNativeAssistantMessage({
      role: 'assistant',
      function_call: { name: 'legacy_tool', arguments: { ok: true } },
    })

    expect(parsed.toolCalls[0]).toEqual({
      id: 'call_legacy',
      type: 'function',
      function: { name: 'legacy_tool', arguments: '{"ok":true}' },
    })
    expect(parsed.assistantMsgRaw.tool_calls).toHaveLength(1)
  })

  it('accumulates fragmented content, native tool calls, and legacy calls', () => {
    const native = new NativeAssistantStreamAccumulator()
    expect(native.push({ choices: [{ delta: { role: 'assistant', content: 'hel' } }] })).toEqual({
      delta: 'hel',
      emitted: true,
    })
    native.push({
      choices: [
        {
          delta: {
            content: 'lo',
            tool_calls: [{ index: 0, id: 'call-a', function: { name: 'ndp_', arguments: '{"x":' } }],
          },
        },
      ],
    })
    native.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'tool', arguments: '1}' } }] } }],
    })

    expect(parseNativeAssistantMessage(native.toMessage())).toMatchObject({
      contentText: 'hello',
      toolCalls: [{ id: 'call-a', function: { name: 'ndp_tool', arguments: '{"x":1}' } }],
    })

    const legacy = new NativeAssistantStreamAccumulator()
    legacy.push({ choices: [{ delta: { function_call: { name: 'legacy_', arguments: '{"x":' } } }] })
    legacy.push({ choices: [{ delta: { function_call: { name: 'tool', arguments: '2}' } } }] })
    expect(parseNativeAssistantMessage(legacy.toMessage()).toolCalls[0]?.function).toEqual({
      name: 'legacy_tool',
      arguments: '{"x":2}',
    })
  })
})

describe('Task agent SSE payloads', () => {
  it('buffers fragmented SSE lines and ignores non-data fields', () => {
    const buffer = new SseDataBuffer()

    expect(buffer.push('event: message\ndata: {"a":')).toEqual([])
    expect(buffer.push('1}\n\ndata: [DONE]\n')).toEqual(['{"a":1}', '[DONE]'])
  })

  it('reads OpenAI and Claude deltas, usage, completion, and fatal errors', () => {
    expect(
      parseTextStreamPayload(
        {
          choices: [{ delta: { content: 'openai' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
        'openai-compatible',
      ),
    ).toEqual({
      delta: 'openai',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      done: false,
    })

    const claude = parseTextStreamPayload(
      { type: 'message_delta', delta: { text: 'claude' }, usage: { input_tokens: 4, output_tokens: 2 } },
      'claude',
    )
    expect(claude).toEqual({
      delta: 'claude',
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      done: false,
    })
    expect(parseTextStreamPayload({ type: 'message_stop' }, 'claude', claude.usage).done).toBe(true)
    expect(() => parseTextStreamPayload({ type: 'error', error: { message: 'provider failed' } }, 'claude')).toThrow(
      'provider failed',
    )
  })
})
