import type { OpenAIFunctionToolSpec } from '../toolRegistry'
import { findLastCompleteToolRequestEnd } from './taskAgentTools'
import {
  buildClaudeTextPayload,
  createHttpStatusError,
  isAbortLikeError,
  NativeAssistantStreamAccumulator,
  parseNativeAssistantMessage,
  parseTextStreamPayload,
  readErrorStatus,
  shouldRetryTransientError,
  SseDataBuffer,
  transientRetryDelayMs,
  type AssistantMessage,
  type LlmUsage,
  type NativeAssistantResult,
  type TaskAgentApiMode,
} from './taskAgentLlmProtocol'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type TaskAgentLlmRetryInfo = {
  delayMs: number
  errorMessage: string
  nextAttempt: number
  totalAttempts: number
}

export type TaskAgentLlmClientOptions = {
  apiMode: TaskAgentApiMode
  endpoint: string
  headers: Record<string, string>
  model: string
  temperature: number
  maxTokens: number
  reasoningExtra: Record<string, unknown>
  messages: Array<Record<string, unknown>>
  tools: OpenAIFunctionToolSpec[]
  sessionId: string
  timeoutMs: number
  retryLimit?: number
  retryBaseDelayMs?: number
  retryJitterMs?: number
  fetchImpl?: FetchLike
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  isCanceled: () => boolean
  setCancelCurrent: (cancel?: () => void) => void
  recoverFromVisionError?: (error: unknown, status?: number) => Promise<boolean>
  onRequestSucceeded?: () => void
  onRetry?: (info: TaskAgentLlmRetryInfo) => void
}

export type TaskAgentTextCallOptions = {
  onDelta?: (delta: string) => void
  stopOnToolRequest?: boolean
}

export type TaskAgentTextResult = {
  contentText: string
  assistantMsgRaw: AssistantMessage
  usage?: LlmUsage
}

export class TaskAgentLlmClient {
  private readonly apiMode: TaskAgentApiMode
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly model: string
  private readonly temperature: number
  private readonly maxTokens: number
  private readonly reasoningExtra: Record<string, unknown>
  private readonly messages: Array<Record<string, unknown>>
  private readonly tools: OpenAIFunctionToolSpec[]
  private readonly sessionId: string
  private readonly timeoutMs: number
  private readonly retryLimit: number
  private readonly retryBaseDelayMs: number
  private readonly retryJitterMs: number
  private readonly fetchImpl: FetchLike
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly isCanceled: () => boolean
  private readonly setCancelCurrent: (cancel?: () => void) => void
  private readonly recoverFromVisionError: (error: unknown, status?: number) => Promise<boolean>
  private readonly onRequestSucceeded: () => void
  private readonly onRetry: (info: TaskAgentLlmRetryInfo) => void

  constructor(options: TaskAgentLlmClientOptions) {
    this.apiMode = options.apiMode
    this.endpoint = options.endpoint
    this.headers = options.headers
    this.model = options.model
    this.temperature = options.temperature
    this.maxTokens = options.maxTokens
    this.reasoningExtra = options.reasoningExtra
    this.messages = options.messages
    this.tools = options.tools
    this.sessionId = options.sessionId
    this.timeoutMs = options.timeoutMs
    this.retryLimit = options.retryLimit ?? 2
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500
    this.retryJitterMs = options.retryJitterMs ?? 250
    this.fetchImpl = options.fetchImpl ?? fetch
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.isCanceled = options.isCanceled
    this.setCancelCurrent = options.setCancelCurrent
    this.recoverFromVisionError = options.recoverFromVisionError ?? (async () => false)
    this.onRequestSucceeded = options.onRequestSucceeded ?? (() => undefined)
    this.onRetry = options.onRetry ?? (() => undefined)
  }

  async callNative(options?: { onDelta?: (delta: string) => void }): Promise<NativeAssistantResult> {
    return this.callNativeWithVisionAttempt(0, options)
  }

  async callText(options?: TaskAgentTextCallOptions): Promise<TaskAgentTextResult> {
    return this.callTextWithVisionAttempt(0, options)
  }

  private async callNativeWithVisionAttempt(
    visionAttempt: number,
    options?: { onDelta?: (delta: string) => void },
  ): Promise<NativeAssistantResult> {
    return this.runWithLifecycle<NativeAssistantResult>(
      visionAttempt,
      async (signal, markOutput) => {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          signal,
          headers: { ...this.headers, Accept: 'text/event-stream' },
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            ...this.reasoningExtra,
            messages: this.messages,
            tools: this.tools,
            tool_choice: 'auto',
            sessionId: this.sessionId,
            stream: true,
          }),
        })
        if (!response.ok) throw await responseError(response)

        let message: AssistantMessage = { role: 'assistant' }
        const contentType = String(response.headers.get('content-type') ?? '')
        if (contentType.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader()
          const decoder = new TextDecoder('utf-8')
          const sseBuffer = new SseDataBuffer()
          const accumulator = new NativeAssistantStreamAccumulator()
          let streamDone = false
          while (!streamDone) {
            this.throwIfCanceled()
            const { value, done } = await reader.read()
            this.throwIfCanceled()
            if (done) break
            for (const dataString of sseBuffer.push(decoder.decode(value, { stream: true }))) {
              this.throwIfCanceled()
              if (!dataString) continue
              if (dataString === '[DONE]') {
                streamDone = true
                break
              }
              let payload: unknown
              try {
                payload = JSON.parse(dataString)
              } catch {
                continue
              }
              const update = accumulator.push(payload)
              if (update.emitted) markOutput()
              if (update.delta) {
                this.throwIfCanceled()
                options?.onDelta?.(update.delta)
              }
            }
          }
          message = accumulator.toMessage()
        } else {
          const data = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: AssistantMessage }> }
          message = (data.choices?.[0]?.message ?? {}) as AssistantMessage
        }

        const parsed = parseNativeAssistantMessage(message)
        if (parsed.contentText.trim() || parsed.toolCalls.length > 0 || parsed.rawToolCalls.length > 0) markOutput()
        this.onRequestSucceeded()
        return parsed
      },
      (nextVisionAttempt) => this.callNativeWithVisionAttempt(nextVisionAttempt, options),
    )
  }

  private async callTextWithVisionAttempt(
    visionAttempt: number,
    options?: TaskAgentTextCallOptions,
  ): Promise<TaskAgentTextResult> {
    return this.runWithLifecycle<TaskAgentTextResult>(
      visionAttempt,
      async (signal, markOutput) => {
        const requestBody =
          this.apiMode === 'claude'
            ? buildClaudeTextPayload({
                messages: this.messages,
                model: this.model,
                maxTokens: this.maxTokens,
                temperature: this.temperature,
                thinking: this.reasoningExtra.thinking,
                stream: true,
              })
            : {
                model: this.model,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                ...this.reasoningExtra,
                messages: this.messages,
                sessionId: this.sessionId,
                stream: true,
              }
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          signal,
          headers: this.headers,
          body: JSON.stringify(requestBody),
        })
        if (!response.ok) throw await responseError(response)
        if (!response.body) throw new Error('Stream response body is null')

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        const sseBuffer = new SseDataBuffer()
        let contentText = ''
        let usage: LlmUsage | undefined
        let stoppedEarly = false
        let streamDone = false
        while (!streamDone && !stoppedEarly) {
          this.throwIfCanceled()
          const { value, done } = await reader.read()
          this.throwIfCanceled()
          streamDone = done
          if (done) break
          for (const dataString of sseBuffer.push(decoder.decode(value, { stream: true }))) {
            if (stoppedEarly) break
            this.throwIfCanceled()
            if (!dataString || dataString === '[DONE]') continue
            try {
              const event = parseTextStreamPayload(JSON.parse(dataString), this.apiMode, usage)
              usage = event.usage
              if (event.done) streamDone = true
              if (event.delta) {
                this.throwIfCanceled()
                markOutput()
                const previousLength = contentText.length
                contentText += event.delta
                if (options?.stopOnToolRequest) {
                  const lastEnd = findLastCompleteToolRequestEnd(contentText)
                  if (lastEnd >= 0) {
                    const keptDelta = contentText.slice(previousLength, Math.min(lastEnd, contentText.length))
                    if (keptDelta) options.onDelta?.(keptDelta)
                    contentText = contentText.slice(0, lastEnd)
                    stoppedEarly = true
                    break
                  }
                }
                options?.onDelta?.(event.delta)
              }
              if (event.done) break
            } catch (error) {
              if ((error as { streamFatal?: unknown })?.streamFatal === true) throw error
            }
          }
        }

        if (stoppedEarly) {
          try {
            await reader.cancel()
          } catch {
            // Cancellation is best-effort after a complete tool request.
          }
        }

        this.onRequestSucceeded()
        return {
          contentText,
          assistantMsgRaw: { role: 'assistant', content: contentText },
          usage,
        }
      },
      (nextVisionAttempt) => this.callTextWithVisionAttempt(nextVisionAttempt, options),
    )
  }

  private async runWithLifecycle<T>(
    visionAttempt: number,
    execute: (signal: AbortSignal, markOutput: () => void) => Promise<T>,
    rerunAfterVisionRecovery: (nextVisionAttempt: number) => Promise<T>,
  ): Promise<T> {
    for (let retryAttempt = 0; retryAttempt <= this.retryLimit; retryAttempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('llm timeout')), this.timeoutMs)
      this.setCancelCurrent(() => controller.abort(new Error('canceled')))
      let emittedOutput = false
      let visionRecovered = false
      let retryInfo: TaskAgentLlmRetryInfo | null = null

      try {
        return await execute(controller.signal, () => {
          emittedOutput = true
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.isCanceled() || isAbortLikeError(error) || /^cancell?ed$/i.test(message.trim())) {
          throw new Error('canceled')
        }
        const status = readErrorStatus(error)
        if (visionAttempt === 0 && (await this.recoverFromVisionError(error, status ?? undefined))) {
          visionRecovered = true
        } else if (!emittedOutput && shouldRetryTransientError(retryAttempt, this.retryLimit, error, status)) {
          retryInfo = {
            delayMs: transientRetryDelayMs(
              retryAttempt,
              this.retryBaseDelayMs,
              this.retryJitterMs,
              this.random,
            ),
            errorMessage: message,
            nextAttempt: retryAttempt + 2,
            totalAttempts: this.retryLimit + 1,
          }
        } else {
          throw error
        }
      } finally {
        clearTimeout(timer)
        this.setCancelCurrent(undefined)
      }

      if (visionRecovered) return rerunAfterVisionRecovery(1)
      if (retryInfo) {
        this.onRetry(retryInfo)
        this.throwIfCanceled()
        await this.sleep(retryInfo.delayMs)
        this.throwIfCanceled()
        continue
      }
    }
    throw new Error('llm request retry exhausted')
  }

  private throwIfCanceled(): void {
    if (this.isCanceled()) throw new Error('canceled')
  }
}

async function responseError(response: Response): Promise<Error> {
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  return createHttpStatusError(data.error?.message || `HTTP ${response.status}`, response.status)
}
