import type { ChatMessageRecord } from '../electron/types'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChatAiRequestController,
  runChatAiResponse,
  type ChatAiApi,
  type RunChatAiResponseOptions,
} from '../src/windows/chat/useChatAi'

function createState<T>(initial: T) {
  let value = initial
  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
  }
  return { get: () => value, set: setValue }
}

function createApi() {
  const addChatMessage = vi.fn(async () => ({}))
  const updateChatMessage = vi.fn(async () => ({}))
  const sendBubbleMessage = vi.fn()
  const stopTtsAll = vi.fn()
  const triggerExpression = vi.fn()
  const triggerMotion = vi.fn()
  const api = {
    addChatMessage,
    updateChatMessage,
    sendBubbleMessage,
    stopTtsAll,
    triggerExpression,
    triggerMotion,
  } as unknown as ChatAiApi
  return {
    addChatMessage,
    api,
    sendBubbleMessage,
    stopTtsAll,
    triggerExpression,
    triggerMotion,
    updateChatMessage,
  }
}

function createRequestController() {
  return createChatAiRequestController({
    clearPreview: vi.fn(),
    setLoading: vi.fn(),
    stopTts: vi.fn(),
  })
}

function createResponseHarness(
  aiService: RunChatAiResponseOptions['aiService'],
  streaming: boolean,
  api = createApi(),
) {
  const messages = createState<ChatMessageRecord[]>([])
  const controller = createRequestController()
  const onAlert = vi.fn()
  const onComplete = vi.fn()
  const onError = vi.fn()
  const onUsage = vi.fn()
  const sendBubblePreview = vi.fn()
  const request = controller.beginRequest()

  const run = () =>
    runChatAiResponse({
      aiService,
      api: api.api,
      chatHistory: [{ role: 'user', content: 'hello' }],
      createdAt: 10,
      messageId: 'assistant-1',
      onAlert,
      onComplete,
      onError,
      onUsage,
      request,
      sendBubblePreview,
      sessionId: 'session-1',
      setMessages: messages.set,
      streaming,
      systemAddon: 'persona',
    })

  return { api, controller, messages, onAlert, onComplete, onError, onUsage, request, run, sendBubblePreview }
}

describe('Chat AI request controller', () => {
  it('does not let an older request clear a newer request loading state', () => {
    const setLoading = vi.fn()
    const controller = createChatAiRequestController({
      clearPreview: vi.fn(),
      setLoading,
      stopTts: vi.fn(),
    })
    const first = controller.beginRequest()
    const second = controller.beginRequest()

    controller.finishRequest(first)
    expect(setLoading).toHaveBeenLastCalledWith(true)

    controller.finishRequest(second)
    expect(setLoading).toHaveBeenLastCalledWith(false)
  })

  it('interrupts tracked and background requests together', () => {
    const clearPreview = vi.fn()
    const setLoading = vi.fn()
    const stopTts = vi.fn()
    const controller = createChatAiRequestController({ clearPreview, setLoading, stopTts })
    const tracked = controller.beginRequest()
    const background = controller.beginRequest({ trackLoading: false })

    controller.interrupt()

    expect(tracked.abortController.signal.aborted).toBe(true)
    expect(background.abortController.signal.aborted).toBe(true)
    expect(tracked.isStopped()).toBe(true)
    expect(background.isStopped()).toBe(true)
    expect(controller.getActiveRequestCount()).toBe(0)
    expect(stopTts).toHaveBeenCalledOnce()
    expect(clearPreview).toHaveBeenCalledOnce()
    expect(setLoading).toHaveBeenLastCalledWith(false)
  })
})

describe('Chat AI response runner', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams one assistant message, updates usage, and deduplicates Live2D tags', async () => {
    const chatStream = vi.fn(async (_messages, options) => {
      options?.onDelta?.('Hello [表情:smile]')
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
      options?.onDelta?.(' world [表情:smile]')
      return {
        content: 'Hello [表情:smile] world [表情:smile]',
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      }
    })
    const harness = createResponseHarness(
      { chat: vi.fn(), chatStream } as unknown as RunChatAiResponseOptions['aiService'],
      true,
    )

    const result = await harness.run()

    expect(result.status).toBe('completed')
    expect(harness.messages.get()).toHaveLength(1)
    expect(harness.messages.get()[0].content).not.toContain('[表情')
    expect(harness.api.addChatMessage).toHaveBeenCalledTimes(1)
    expect(harness.api.updateChatMessage).toHaveBeenCalledWith('session-1', 'assistant-1', harness.messages.get()[0].content)
    expect(harness.api.triggerExpression).toHaveBeenCalledTimes(1)
    expect(harness.api.triggerExpression).toHaveBeenCalledWith('smile')
    expect(harness.onUsage).toHaveBeenCalledWith({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(harness.onComplete).toHaveBeenCalledWith('session-1')
    expect(harness.api.sendBubbleMessage).toHaveBeenCalledWith(harness.messages.get()[0].content)
  })

  it('persists streamed partial text when the provider fails', async () => {
    const chatStream = vi.fn(async (_messages, options) => {
      options?.onDelta?.('partial answer')
      return { content: '', error: 'network down' }
    })
    const harness = createResponseHarness(
      { chat: vi.fn(), chatStream } as unknown as RunChatAiResponseOptions['aiService'],
      true,
    )

    const result = await harness.run()

    expect(result.status).toBe('failed')
    expect(harness.messages.get()[0].content).toContain('partial answer')
    expect(harness.messages.get()[0].content).toContain('network down')
    expect(harness.api.updateChatMessage).toHaveBeenCalledOnce()
    expect(harness.onError).toHaveBeenCalledWith('network down')
    expect(harness.onComplete).not.toHaveBeenCalled()
  })

  it('waits for the streamed placeholder insert before persisting final content', async () => {
    let releaseInsert: ((value: object) => void) | undefined
    const insertPending = new Promise<object>((resolve) => {
      releaseInsert = resolve
    })
    const api = createApi()
    api.addChatMessage.mockImplementation(() => insertPending)
    const chatStream = vi.fn(async (_messages, options) => {
      options?.onDelta?.('final answer')
      return { content: 'final answer' }
    })
    const harness = createResponseHarness(
      { chat: vi.fn(), chatStream } as unknown as RunChatAiResponseOptions['aiService'],
      true,
      api,
    )

    const runPending = harness.run()
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    expect(api.addChatMessage).toHaveBeenCalledOnce()
    expect(api.updateChatMessage).not.toHaveBeenCalled()

    releaseInsert?.({})
    await runPending
    expect(api.updateChatMessage).toHaveBeenCalledWith('session-1', 'assistant-1', 'final answer')
  })

  it('ignores deltas and completion that arrive after interruption', async () => {
    const holder: { harness?: ReturnType<typeof createResponseHarness> } = {}
    const chatStream = vi.fn(async (_messages, options) => {
      options?.onDelta?.('late text')
      holder.harness?.controller.interrupt()
      return { content: 'late text' }
    })
    const harness = createResponseHarness(
      { chat: vi.fn(), chatStream } as unknown as RunChatAiResponseOptions['aiService'],
      true,
    )
    holder.harness = harness

    const result = await harness.run()

    expect(result.status).toBe('aborted')
    expect(harness.messages.get()).toEqual([])
    expect(harness.api.addChatMessage).not.toHaveBeenCalled()
    expect(harness.api.updateChatMessage).not.toHaveBeenCalled()
    expect(harness.onComplete).not.toHaveBeenCalled()
  })

  it('persists a non-stream response and dispatches its metadata', async () => {
    const chat = vi.fn(async () => ({
      content: 'plain response',
      expression: 'happy',
      motion: 'wave',
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    }))
    const harness = createResponseHarness(
      { chat, chatStream: vi.fn() } as unknown as RunChatAiResponseOptions['aiService'],
      false,
    )

    const result = await harness.run()

    expect(result.status).toBe('completed')
    expect(harness.messages.get()[0].content).toBe('plain response')
    expect(harness.api.triggerExpression).toHaveBeenCalledWith('happy')
    expect(harness.api.triggerMotion).toHaveBeenCalledWith('wave', 0)
    expect(harness.onUsage).toHaveBeenCalledWith({ promptTokens: 2, completionTokens: 3, totalTokens: 5 })
    expect(harness.onComplete).toHaveBeenCalledWith('session-1')
  })

  it('formats context errors, alerts, and stores the raw provider failure', async () => {
    const chat = vi.fn(async () => ({ content: '', error: 'maximum context length exceeded' }))
    const harness = createResponseHarness(
      { chat, chatStream: vi.fn() } as unknown as RunChatAiResponseOptions['aiService'],
      false,
    )

    const result = await harness.run()

    expect(result.status).toBe('failed')
    expect(harness.onError.mock.calls[0][0]).toContain('上下文过长')
    expect(harness.onAlert).toHaveBeenCalledOnce()
    expect(harness.messages.get()[0].content).toBe('[错误] maximum context length exceeded')
    expect(harness.onComplete).not.toHaveBeenCalled()
  })
})
