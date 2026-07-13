import type { ChatMessageRecord } from '../../../electron/types'
import type { NeoDeskPetApi } from '../../neoDeskPetApi'
import {
  ABORTED_ERROR,
  type AIService,
  type ChatMessage,
  type ChatUsage,
} from '../../services/aiService'
import {
  buildInterruptedStreamContent,
  normalizeAssistantDisplayText,
} from '../../utils/chatMessages'
import { createStreamFlushThrottle, extractTailLive2DTags } from '../../utils/live2dStream'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

type StateSetter<T> = Dispatch<SetStateAction<T>>

export type ChatAiApi = Pick<
  NeoDeskPetApi,
  | 'addChatMessage'
  | 'sendBubbleMessage'
  | 'stopTtsAll'
  | 'triggerExpression'
  | 'triggerMotion'
  | 'updateChatMessage'
>

export type ChatBubblePreviewSender = (
  payload: { text?: string; clear?: boolean; placeholder?: boolean; autoHideDelay?: number; pinPrevious?: boolean },
  opts?: { force?: boolean },
) => void

export type ChatAiRequestHandle = {
  abortController: AbortController
  isStopped: () => boolean
}

export type ChatAiRequestControllerOptions = {
  clearPreview: () => void
  setLoading: (loading: boolean) => void
  stopTts: () => void
}

export function createChatAiRequestController(options: ChatAiRequestControllerOptions) {
  let stopSequence = 0
  const requests = new Set<ChatAiRequestHandle>()
  const trackedRequests = new Set<ChatAiRequestHandle>()

  const beginRequest = (opts?: { trackLoading?: boolean }): ChatAiRequestHandle => {
    const abortController = new AbortController()
    const requestStopSequence = stopSequence
    const handle: ChatAiRequestHandle = {
      abortController,
      isStopped: () => abortController.signal.aborted || requestStopSequence !== stopSequence,
    }
    requests.add(handle)

    if (opts?.trackLoading !== false) {
      trackedRequests.add(handle)
      options.setLoading(true)
    }
    return handle
  }

  const finishRequest = (handle: ChatAiRequestHandle) => {
    requests.delete(handle)
    if (!trackedRequests.delete(handle)) return
    options.setLoading(trackedRequests.size > 0)
  }

  const abortRequests = () => {
    stopSequence += 1
    for (const request of requests) {
      try {
        request.abortController.abort()
      } catch {
        /* ignore */
      }
    }
    requests.clear()
    trackedRequests.clear()
  }

  const interrupt = (opts?: { stopTts?: boolean }) => {
    abortRequests()
    if (opts?.stopTts !== false) options.stopTts()
    options.clearPreview()
    options.setLoading(false)
  }

  return {
    beginRequest,
    dispose: abortRequests,
    finishRequest,
    getActiveRequestCount: () => requests.size,
    interrupt,
  }
}

export type ChatAiRequestController = ReturnType<typeof createChatAiRequestController>

export function formatChatAiErrorForUser(raw: string): { message: string; shouldAlert: boolean } {
  const text = String(raw ?? '').trim()
  const lower = text.toLowerCase()
  const isContextTooLong =
    lower.includes('context_length') ||
    lower.includes('maximum context') ||
    (lower.includes('context') && lower.includes('length')) ||
    (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum'))) ||
    text.includes('上下文') ||
    text.includes('长度超出') ||
    text.includes('超出上下文')

  if (!isContextTooLong) return { message: text || '未知错误', shouldAlert: false }

  return {
    message: `上下文过长导致请求失败，可右键“一键总结”或清空对话后重试。（原始错误：${text || 'unknown'}）`,
    shouldAlert: true,
  }
}

export type ChatAiResponseResult = {
  messageId: string
  status: 'aborted' | 'completed' | 'failed'
}

export type RunChatAiResponseOptions = {
  aiService: Pick<AIService, 'chat' | 'chatStream'>
  api: ChatAiApi
  chatHistory: ChatMessage[]
  createdAt?: number
  formatError?: (raw: string) => { message: string; shouldAlert: boolean }
  messageId: string
  onAlert?: (message: string) => void
  onComplete: (sessionId: string) => void
  onError: (message: string) => void
  onUsage: (usage: ChatUsage) => void
  request: ChatAiRequestHandle
  sendBubblePreview: ChatBubblePreviewSender
  sessionId: string
  setMessages: StateSetter<ChatMessageRecord[]>
  streaming: boolean
  systemAddon: string
}

export async function runChatAiResponse(options: RunChatAiResponseOptions): Promise<ChatAiResponseResult> {
  const createdAt = options.createdAt ?? Date.now()
  const formatError = options.formatError ?? formatChatAiErrorForUser
  const aborted = (): ChatAiResponseResult => ({ messageId: options.messageId, status: 'aborted' })
  const failed = (): ChatAiResponseResult => ({ messageId: options.messageId, status: 'failed' })
  const completed = (): ChatAiResponseResult => ({ messageId: options.messageId, status: 'completed' })

  const reportError = (raw: string) => {
    const error = formatError(raw)
    options.onError(error.message)
    if (error.shouldAlert) options.onAlert?.(error.message)
  }

  if (options.streaming) {
    let created = false
    let messageCreatePromise: Promise<unknown> | null = null
    let acc = ''
    let pending = ''
    let lastExpression: string | undefined
    let lastMotion: string | undefined

    const ensureMessageCreated = () => {
      if (created || options.request.isStopped()) return
      created = true
      const assistantMessage: ChatMessageRecord = {
        id: options.messageId,
        role: 'assistant',
        content: '',
        createdAt,
      }
      options.setMessages((prev) => [...prev, assistantMessage])
      messageCreatePromise = options.api.addChatMessage(options.sessionId, assistantMessage).catch(() => undefined)
    }

    const flush = () => {
      if (options.request.isStopped()) {
        pending = ''
        return
      }
      if (!pending) return
      const appended = pending
      acc += pending
      pending = ''
      ensureMessageCreated()
      if (!created) return

      const display = normalizeAssistantDisplayText(acc)
      if (display.trim()) options.sendBubblePreview({ text: display, autoHideDelay: 0 })
      options.setMessages((prev) => prev.map((message) => (message.id === options.messageId ? { ...message, content: display } : message)))

      const tags = extractTailLive2DTags(acc, appended.length)
      if (tags.expression && tags.expression !== lastExpression) {
        lastExpression = tags.expression
        options.api.triggerExpression(tags.expression)
      }
      if (tags.motion && tags.motion !== lastMotion) {
        lastMotion = tags.motion
        options.api.triggerMotion(tags.motion, 0)
      }
    }
    const flushThrottle = createStreamFlushThrottle(flush)

    const response = await options.aiService
      .chatStream(options.chatHistory, {
        signal: options.request.abortController.signal,
        systemAddon: options.systemAddon,
        onDelta: (delta) => {
          if (options.request.isStopped()) return
          pending += delta
          flushThrottle.schedule()
        },
      })
      .finally(() => flushThrottle.finalize())

    if (options.request.isStopped() || response.error === ABORTED_ERROR) {
      options.sendBubblePreview({ clear: true }, { force: true })
      return aborted()
    }

    if (response.error) {
      const partialForUi = normalizeAssistantDisplayText(response.content || acc, { trim: true })
      if (partialForUi) options.sendBubblePreview({ text: partialForUi, autoHideDelay: 0 })
      else options.sendBubblePreview({ clear: true }, { force: true })
      reportError(response.error)

      const nextContent = buildInterruptedStreamContent(partialForUi, response.error)
      if (created) {
        await messageCreatePromise
        options.setMessages((prev) =>
          prev.map((message) => (message.id === options.messageId ? { ...message, content: nextContent } : message)),
        )
        await options.api.updateChatMessage(options.sessionId, options.messageId, nextContent).catch(() => undefined)
      } else {
        const assistantMessage: ChatMessageRecord = {
          id: options.messageId,
          role: 'assistant',
          content: nextContent,
          createdAt,
        }
        options.setMessages((prev) => [...prev, assistantMessage])
        await options.api.addChatMessage(options.sessionId, assistantMessage).catch(() => undefined)
      }
      return failed()
    }

    const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
    if (response.usage) options.onUsage(response.usage)
    if (created) {
      await messageCreatePromise
      options.setMessages((prev) =>
        prev.map((message) => (message.id === options.messageId ? { ...message, content: finalContent } : message)),
      )
      await options.api.updateChatMessage(options.sessionId, options.messageId, finalContent).catch(() => undefined)
    } else {
      const assistantMessage: ChatMessageRecord = {
        id: options.messageId,
        role: 'assistant',
        content: finalContent,
        createdAt,
      }
      options.setMessages((prev) => [...prev, assistantMessage])
      await options.api.addChatMessage(options.sessionId, assistantMessage).catch(() => undefined)
    }
    if (finalContent.trim()) options.sendBubblePreview({ text: finalContent, autoHideDelay: 0 })
    if (finalContent) options.api.sendBubbleMessage(finalContent)
    options.onComplete(options.sessionId)
    return completed()
  }

  const response = await options.aiService.chat(options.chatHistory, {
    signal: options.request.abortController.signal,
    systemAddon: options.systemAddon,
  })

  if (options.request.isStopped() || response.error === ABORTED_ERROR) {
    options.sendBubblePreview({ clear: true }, { force: true })
    return aborted()
  }

  if (response.error) {
    options.sendBubblePreview({ clear: true }, { force: true })
    reportError(response.error)
    const assistantMessage: ChatMessageRecord = {
      id: options.messageId,
      role: 'assistant',
      content: `[错误] ${response.error}`,
      createdAt,
    }
    options.setMessages((prev) => [...prev, assistantMessage])
    await options.api.addChatMessage(options.sessionId, assistantMessage).catch(() => undefined)
    return failed()
  }

  const assistantMessage: ChatMessageRecord = {
    id: options.messageId,
    role: 'assistant',
    content: response.content,
    createdAt,
  }
  if (response.usage) options.onUsage(response.usage)
  options.setMessages((prev) => [...prev, assistantMessage])
  await options.api.addChatMessage(options.sessionId, assistantMessage)

  if (response.expression) options.api.triggerExpression(response.expression)
  if (response.motion) options.api.triggerMotion(response.motion, 0)
  if (response.content?.trim()) options.sendBubblePreview({ text: response.content, autoHideDelay: 0 })
  if (response.content) options.api.sendBubbleMessage(response.content)
  options.onComplete(options.sessionId)
  return completed()
}

export type UseChatAiOptions = {
  api: ChatAiApi | null
  createMessageId: () => string
  onAlert?: (message: string) => void
  onResponseComplete: (sessionId: string) => void
  sendBubblePreview: ChatBubblePreviewSender
  setError: (message: string) => void
  setLastApiUsage: (usage: ChatUsage) => void
  setMessages: StateSetter<ChatMessageRecord[]>
}

export type RunStandardChatAiResponseArgs = {
  aiService: Pick<AIService, 'chat' | 'chatStream'>
  chatHistory: ChatMessage[]
  request: ChatAiRequestHandle
  sessionId: string
  streaming: boolean
  systemAddon: string
}

export function useChatAi(options: UseChatAiOptions) {
  const [isLoading, setIsLoading] = useState(false)
  const isLoadingRef = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const controller = useMemo(
    () =>
      createChatAiRequestController({
        clearPreview: () => optionsRef.current.sendBubblePreview({ clear: true }, { force: true }),
        setLoading: (loading) => {
          isLoadingRef.current = loading
          setIsLoading(loading)
        },
        stopTts: () => {
          try {
            optionsRef.current.api?.stopTtsAll()
          } catch {
            /* ignore */
          }
        },
      }),
    [],
  )

  useEffect(() => () => controller.dispose(), [controller])

  const runStandardAiResponse = useCallback(async (args: RunStandardChatAiResponseArgs) => {
    const current = optionsRef.current
    if (!current.api) throw new Error('Chat API unavailable')
    return runChatAiResponse({
      ...args,
      api: current.api,
      messageId: current.createMessageId(),
      onAlert: current.onAlert,
      onComplete: current.onResponseComplete,
      onError: current.setError,
      onUsage: current.setLastApiUsage,
      sendBubblePreview: current.sendBubblePreview,
      setMessages: current.setMessages,
    })
  }, [])

  return {
    beginAiRequest: controller.beginRequest,
    finishAiRequest: controller.finishRequest,
    interruptAiRequests: controller.interrupt,
    isLoading,
    isLoadingRef,
    runStandardAiResponse,
  }
}
