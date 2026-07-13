import type { AICredentialRef, AISettings } from '../../electron/types'
import { buildOpenAICompatReasoningOptions } from '../../electron/reasoningConfig'
import { getApi } from '../neoDeskPetApi'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | ChatContentPart[]
}

/** API 返回的真实 token 使用统计 */
export type ChatUsage = {
  promptTokens: number // 输入 token 数（prompt_tokens）
  completionTokens: number // 输出 token 数（completion_tokens）
  totalTokens: number // 总 token 数（total_tokens）
}

export type ChatResponse = {
  content: string
  error?: string
  expression?: string // Extracted expression tag
  motion?: string // Extracted motion tag
  usage?: ChatUsage // API 返回的真实 token 统计
}
export const ABORTED_ERROR = '__ABORTED__'

// Pattern to match expression/motion tags like [表情:星星眼] or [动作:Idle]
const EXPRESSION_TAG_PATTERN = /\[表情[：:]\s*([^\]]+)\]/g
const MOTION_TAG_PATTERN = /\[动作[：:]\s*([^\]]+)\]/g
const REQUEST_CONNECT_TIMEOUT_MS = 20_000
const TRANSIENT_RETRY_LIMIT = 2
const RETRY_BASE_DELAY_MS = 500
const RETRY_JITTER_MS = 250
const ANTHROPIC_VERSION = '2023-06-01'

type ApiMode = AISettings['apiMode']

function normalizeApiMode(value: unknown): ApiMode {
  return value === 'claude' ? 'claude' : 'openai-compatible'
}

function joinApiUrl(baseUrl: string, pathname: string): string {
  return `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const raw = String(dataUrl ?? '').trim()
  if (!raw.startsWith('data:')) return null
  const comma = raw.indexOf(',')
  if (comma < 0) return null
  const meta = raw.slice(5, comma)
  const data = raw.slice(comma + 1)
  const parts = meta.split(';').map((p) => p.trim())
  const mediaType = parts[0] || 'application/octet-stream'
  if (!parts.includes('base64') || !data) return null
  return { mediaType, data }
}

function buildApiHeaders(apiMode: ApiMode, apiKey: string): Record<string, string> {
  if (apiMode === 'claude') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }
  return { Authorization: `Bearer ${apiKey}` }
}

function extractApiErrorMessage(errorData: unknown, status: number, statusText: string): string {
  const fallback = `HTTP ${status}: ${statusText}`
  const raw =
    errorData &&
    typeof errorData === 'object' &&
    (errorData as { error?: { message?: unknown } }).error &&
    typeof (errorData as { error?: { message?: unknown } }).error?.message === 'string'
      ? ((errorData as { error?: { message?: string } }).error?.message ?? fallback)
      : fallback

  const text = String(raw ?? '').trim()
  if (!text.startsWith('{') || !text.includes('"error"')) return text || fallback
  try {
    const nested = JSON.parse(text) as { error?: { message?: unknown } }
    const nestedMsg = nested?.error?.message
    if (typeof nestedMsg === 'string' && nestedMsg.trim()) return nestedMsg.trim()
  } catch {
    // 保持原始文案
  }
  return text || fallback
}

function isThinkingBudgetError(errorMessage: string): boolean {
  const s = String(errorMessage ?? '')
  return /max_tokens/i.test(s) && /thinking\.budget_tokens/i.test(s)
}

function parseBudgetTokensFromError(errorMessage: string): number | null {
  const s = String(errorMessage ?? '')
  const m = s.match(/thinking\.budget_tokens[^0-9]*(\d+)/i) ?? s.match(/budget_tokens[^0-9]*(\d+)/i)
  if (!m?.[1]) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null
}

function buildRetryPayloadForThinkingBudget(payload: Record<string, unknown>, errorMessage: string): Record<string, unknown> | null {
  const modelId = String(payload.model ?? '').trim().toLowerCase()
  if (!modelId.includes('claude')) return null

  const currentMaxTokens = typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens) ? Math.trunc(payload.max_tokens) : null
  if (currentMaxTokens == null) return null

  const budgetFromPayload = (() => {
    const thinking = payload.thinking
    if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return null
    const v = (thinking as { budget_tokens?: unknown }).budget_tokens
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null
  })()

  const budgetFromError = parseBudgetTokensFromError(errorMessage)
  const minRequired = Math.max(
    currentMaxTokens + 1,
    budgetFromPayload != null ? budgetFromPayload + 1 : 0,
    budgetFromError != null ? budgetFromError + 1 : 0,
    16384,
  )
  if (minRequired <= currentMaxTokens) return null
  return { ...payload, max_tokens: minRequired }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

function isTransientErrorMessage(errorMessage: string): boolean {
  const s = String(errorMessage ?? '').toLowerCase()
  if (!s.trim()) return false
  return (
    s.includes('timeout') ||
    s.includes('timed out') ||
    s.includes('network error') ||
    s.includes('networkerror') ||
    s.includes('fetch failed') ||
    s.includes('failed to fetch') ||
    s.includes('socket hang up') ||
    s.includes('econnreset') ||
    s.includes('econnrefused') ||
    s.includes('etimedout') ||
    s.includes('connection reset') ||
    s.includes('connection refused') ||
    s.includes('service unavailable') ||
    s.includes('gateway timeout') ||
    s.includes('bad gateway') ||
    s.includes('temporarily unavailable') ||
    s.includes('rate limit') ||
    s.includes('too many requests') ||
    s.includes('连接超时') ||
    s.includes('网络') ||
    s.includes('连接失败') ||
    s.includes('连接重置')
  )
}

function shouldRetryTransientError(attempt: number, err: unknown): boolean {
  if (attempt >= TRANSIENT_RETRY_LIMIT) return false
  if (isAbortError(err)) return false
  const msg = err instanceof Error ? err.message : String(err)
  return isTransientErrorMessage(msg)
}

function shouldRetryTransientHttpFailure(attempt: number, status: number): boolean {
  if (attempt >= TRANSIENT_RETRY_LIMIT) return false
  return isTransientHttpStatus(status)
}

function retryDelayMs(attempt: number): number {
  const backoff = RETRY_BASE_DELAY_MS * Math.max(1, 2 ** attempt)
  const jitter = Math.floor(Math.random() * RETRY_JITTER_MS)
  return backoff + jitter
}

async function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return false
  if (signal?.aborted) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, ms)
    const onAbort = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readApiHttpError(response: Response): Promise<{ status: number; statusText: string; message: string }> {
  const errorData = await response.json().catch(() => ({}))
  return {
    status: response.status,
    statusText: response.statusText,
    message: extractApiErrorMessage(errorData, response.status, response.statusText),
  }
}

async function postChatCompletion(args: {
  endpoint: string
  apiKey: string
  credential: AICredentialRef
  body: Record<string, unknown>
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<Response> {
  const bridge = getApi()
  if (
    bridge?.aiHttpStreamStart &&
    bridge.aiHttpStreamCancel &&
    bridge.onAiHttpStreamChunk &&
    bridge.onAiHttpStreamDone &&
    bridge.onAiHttpStreamError
  ) {
    const streamId =
      globalThis.crypto?.randomUUID?.().replace(/-/g, '') ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController
      },
      cancel() {
        settled = true
        void bridge.aiHttpStreamCancel(streamId).catch(() => undefined)
      },
    })

    const cleanup = () => {
      offChunk()
      offDone()
      offError()
      args.signal?.removeEventListener('abort', onAbort)
    }
    const finishWithError = (error: Error) => {
      if (settled) return
      settled = true
      try {
        controller?.error(error)
      } catch {
        // The stream may already be closed by the consumer.
      }
      cleanup()
    }
    const offChunk = bridge.onAiHttpStreamChunk((payload) => {
      if (payload.streamId !== streamId || settled) return
      try {
        controller?.enqueue(payload.chunk)
      } catch (error) {
        finishWithError(error instanceof Error ? error : new Error(String(error)))
      }
    })
    const offDone = bridge.onAiHttpStreamDone((payload) => {
      if (payload.streamId !== streamId || settled) return
      settled = true
      try {
        controller?.close()
      } catch {
        // The stream may already be closed by the consumer.
      }
      cleanup()
    })
    const offError = bridge.onAiHttpStreamError((payload) => {
      if (payload.streamId !== streamId) return
      finishWithError(new Error(payload.error || 'AI stream failed'))
    })
    const onAbort = () => {
      void bridge.aiHttpStreamCancel(streamId).catch(() => undefined)
      finishWithError(new DOMException('Aborted', 'AbortError'))
    }

    if (args.signal?.aborted) {
      onAbort()
      throw new DOMException('Aborted', 'AbortError')
    }
    args.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await bridge.aiHttpStreamStart({
        streamId,
        credential: args.credential,
        body: args.body,
        timeoutMs: args.timeoutMs,
      })
      if (!result.ok) {
        settled = true
        cleanup()
        return new Response(result.bodyText, {
          status: result.status,
          statusText: result.statusText,
          headers: result.contentType ? { 'Content-Type': result.contentType } : undefined,
        })
      }
      return new Response(stream, {
        status: result.status,
        statusText: result.statusText,
        headers: result.contentType ? { 'Content-Type': result.contentType } : undefined,
      })
    } catch (error) {
      void bridge.aiHttpStreamCancel(streamId).catch(() => undefined)
      finishWithError(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  const ac = new AbortController()
  const timeoutMs = Math.max(1_000, Math.trunc(args.timeoutMs ?? REQUEST_CONNECT_TIMEOUT_MS))
  let timedOut = false
  const onOuterAbort = () => ac.abort()
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs)

  if (args.signal?.aborted) {
    ac.abort()
  } else {
    args.signal?.addEventListener('abort', onOuterAbort, { once: true })
  }

  try {
    if (args.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return await fetch(args.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.headers ?? buildApiHeaders('openai-compatible', args.apiKey)),
      },
      body: JSON.stringify(args.body),
      signal: ac.signal,
    })
  } catch (err) {
    if (timedOut) {
      throw new Error(`连接超时（>${timeoutMs}ms）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onOuterAbort)
  }
}

function buildChatCompletionPayload(args: {
  model: string
  messages: Array<{ role: ChatMessage['role']; content: ChatMessage['content'] }>
  temperature: number
  maxTokens: number
  thinkingEffort: AISettings['thinkingEffort']
  thinkingProvider: AISettings['thinkingProvider']
  openaiReasoningEffort: AISettings['openaiReasoningEffort']
  claudeThinkingEffort: AISettings['claudeThinkingEffort']
  geminiThinkingEffort: AISettings['geminiThinkingEffort']
  stream?: boolean
}): Record<string, unknown> {
  const reasoning = buildOpenAICompatReasoningOptions({
    model: args.model,
    maxTokens: args.maxTokens,
    settings: {
      thinkingEffort: args.thinkingEffort,
      thinkingProvider: args.thinkingProvider,
      openaiReasoningEffort: args.openaiReasoningEffort,
      claudeThinkingEffort: args.claudeThinkingEffort,
      geminiThinkingEffort: args.geminiThinkingEffort,
    },
    claudeDisabledMinMaxTokens: 2048,
  })

  const basePayload: Record<string, unknown> = {
    model: args.model,
    messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: args.temperature,
    max_tokens: reasoning.maxTokens,
  }

  if (Object.keys(reasoning.extra).length > 0) {
    Object.assign(basePayload, reasoning.extra)
  }
  if (args.stream) {
    basePayload.stream = true
  }
  return basePayload
}

function textFromChatContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function toClaudeContentBlocks(content: ChatMessage['content']): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ type: 'text', text }] : []
  }

  const blocks: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim()) blocks.push({ type: 'text', text: part.text })
      continue
    }

    const url = String(part.image_url?.url ?? '').trim()
    if (!url) continue
    const dataUrl = parseDataUrl(url)
    if (dataUrl) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrl.mediaType,
          data: dataUrl.data,
        },
      })
      continue
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'url',
        url,
      },
    })
  }
  return blocks
}

function normalizeClaudeMessages(messages: ChatMessage[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>
} {
  const systemParts: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textFromChatContent(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = toClaudeContentBlocks(message.content)
    if (content.length === 0) continue

    const prev = out[out.length - 1]
    if (prev?.role === role) {
      prev.content.push(...content)
    } else {
      out.push({ role, content })
    }
  }

  return { system: systemParts.join('\n\n'), messages: out }
}

function buildClaudeMessagesPayload(args: {
  model: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  claudeThinkingEffort: AISettings['claudeThinkingEffort']
  stream?: boolean
}): Record<string, unknown> {
  const normalized = normalizeClaudeMessages(args.messages)
  const reasoning = buildOpenAICompatReasoningOptions({
    model: args.model,
    maxTokens: args.maxTokens,
    settings: {
      thinkingProvider: 'claude',
      claudeThinkingEffort: args.claudeThinkingEffort,
    },
    claudeDisabledMinMaxTokens: 0,
  })

  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: reasoning.maxTokens,
    temperature: args.temperature,
    messages: normalized.messages,
  }
  if (normalized.system) body.system = normalized.system
  if (args.stream) body.stream = true

  const thinking = reasoning.extra.thinking
  if (
    thinking &&
    typeof thinking === 'object' &&
    !Array.isArray(thinking) &&
    (thinking as { type?: unknown }).type === 'enabled'
  ) {
    body.thinking = thinking
  }
  return body
}

function extractClaudeText(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('')
}

function readClaudeUsage(payload: unknown): ChatUsage | undefined {
  const usage = (payload as { usage?: unknown })?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const inputTokens = (usage as { input_tokens?: unknown }).input_tokens
  const outputTokens = (usage as { output_tokens?: unknown }).output_tokens
  const promptTokens = typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : 0
  const completionTokens = typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function readOpenAIUsage(payload: unknown): ChatUsage | undefined {
  const usage = (payload as { usage?: unknown })?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const promptTokensRaw = (usage as { prompt_tokens?: unknown }).prompt_tokens
  const completionTokensRaw = (usage as { completion_tokens?: unknown }).completion_tokens
  const totalTokensRaw = (usage as { total_tokens?: unknown }).total_tokens
  const promptTokens = typeof promptTokensRaw === 'number' && Number.isFinite(promptTokensRaw) ? promptTokensRaw : 0
  const completionTokens = typeof completionTokensRaw === 'number' && Number.isFinite(completionTokensRaw) ? completionTokensRaw : 0
  const totalTokens =
    typeof totalTokensRaw === 'number' && Number.isFinite(totalTokensRaw) ? totalTokensRaw : promptTokens + completionTokens
  return { promptTokens, completionTokens, totalTokens }
}

function mergeUsage(prev: ChatUsage | undefined, next: ChatUsage | undefined): ChatUsage | undefined {
  if (!next) return prev
  const promptTokens = next.promptTokens || prev?.promptTokens || 0
  const completionTokens = next.completionTokens || prev?.completionTokens || 0
  const totalTokens = next.totalTokens || promptTokens + completionTokens
  return { promptTokens, completionTokens, totalTokens }
}

/**
 * Extract expression and motion tags from AI response text
 */
function extractTags(text: string): { cleanedText: string; expression?: string; motion?: string } {
  let expression: string | undefined
  let motion: string | undefined
  let cleanedText = text

  // Extract expression tag
  const expMatch = EXPRESSION_TAG_PATTERN.exec(text)
  if (expMatch) {
    expression = expMatch[1].trim()
    cleanedText = cleanedText.replace(EXPRESSION_TAG_PATTERN, '')
  }
  EXPRESSION_TAG_PATTERN.lastIndex = 0 // Reset regex state

  // Extract motion tag
  const motionMatch = MOTION_TAG_PATTERN.exec(cleanedText)
  if (motionMatch) {
    motion = motionMatch[1].trim()
    cleanedText = cleanedText.replace(MOTION_TAG_PATTERN, '')
  }
  MOTION_TAG_PATTERN.lastIndex = 0 // Reset regex state

  // 清理空白：保留换行结构，但避免过多空行/空格导致渲染“缝隙”
  cleanedText = cleanedText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleanedText, expression, motion }
}

/**
 * Build system prompt with expression instructions
 */
function buildSystemPrompt(basePrompt: string, expressions: string[], motions: string[]): string {
  if (expressions.length === 0 && motions.length === 0) {
    return basePrompt
  }

  let instruction = basePrompt

 if (expressions.length > 0) {
    const expList = expressions.slice(0, 20).join('、')
    instruction += `

【表情系统】
你可以使用以下表情来表达情感：${expList}

在回复时，请在句末用标签标注想要展示的表情，格式为 [表情:表情名称]
例如：
- "…… [表情:星星眼]"
- "…… [表情:哭]"

注意：每条回复最多使用1个表情标签；为降低界面延迟，尽量在回复开头/第一句末尾（前 20 个字内）给出；如果不方便，再放在末尾。`
  }

  if (motions.length > 0) {
    const motionList = motions.slice(0, 10).join('、')
    instruction += `

【动作系统】
可用的动作组：${motionList}
如需触发动作，可使用 [动作:动作组名称] 标签
注意：动作标签同样尽量前置（前 20 个字内或第一句末尾），便于界面低延迟触发。`
  }

  return instruction
}

/**
 * AI Service - handles API calls to OpenAI compatible endpoints
 */
export class AIService {
  private settings: AISettings
  private credential: AICredentialRef
  private expressions: string[] = []
  private motions: string[] = []

  constructor(settings: AISettings, credential: AICredentialRef = { kind: 'main' }) {
    this.settings = settings
    this.credential = credential
  }

  updateSettings(settings: AISettings) {
    this.settings = settings
  }

  setModelInfo(expressions: string[], motions: string[]) {
    this.expressions = expressions
    this.motions = motions
  }

  /**
   * Send a chat message and get a response
   */
  async chat(messages: ChatMessage[], options?: { signal?: AbortSignal; systemAddon?: string }): Promise<ChatResponse> {
    const {
      apiMode,
      apiKey,
      baseUrl,
      model,
      temperature,
      maxTokens,
      thinkingEffort,
      thinkingProvider,
      openaiReasoningEffort,
      claudeThinkingEffort,
      geminiThinkingEffort,
      systemPrompt,
    } = this.settings

    if (!(this.settings.hasApiKey ?? Boolean(apiKey))) {
      return { content: '', error: '请先配置 API Key' }
    }

    // Build system prompt with expression instructions
    let fullSystemPrompt = buildSystemPrompt(systemPrompt, this.expressions, this.motions)
    if (options?.systemAddon?.trim()) {
      fullSystemPrompt += `\n\n${options.systemAddon.trim()}`
    }

    // Add system prompt if not already present
    const messagesWithSystem = this.ensureSystemPrompt(messages, fullSystemPrompt)
    const mode = normalizeApiMode(apiMode)
    const requestBody =
      mode === 'claude'
        ? buildClaudeMessagesPayload({
            model,
            messages: messagesWithSystem,
            temperature,
            maxTokens,
            claudeThinkingEffort,
          })
        : buildChatCompletionPayload({
            model,
            messages: messagesWithSystem,
            temperature,
            maxTokens,
            thinkingEffort,
            thinkingProvider,
            openaiReasoningEffort,
            claudeThinkingEffort,
            geminiThinkingEffort,
          })

    const endpoint = joinApiUrl(baseUrl, mode === 'claude' ? 'messages' : 'chat/completions')
    const headers = buildApiHeaders(mode, apiKey)
    let bodyForAttempt = requestBody
    let didThinkingBudgetRetry = false
    const totalAttempts = TRANSIENT_RETRY_LIMIT + 1

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      try {
        const response = await postChatCompletion({
          endpoint,
          apiKey,
          credential: this.credential,
          body: bodyForAttempt,
          headers,
          signal: options?.signal,
        })

        if (options?.signal?.aborted) return { content: '', error: ABORTED_ERROR }
        if (!response.ok) {
          const apiErr = await readApiHttpError(response)
          if (!didThinkingBudgetRetry && isThinkingBudgetError(apiErr.message)) {
            const retryBody = buildRetryPayloadForThinkingBudget(bodyForAttempt, apiErr.message)
            if (retryBody) {
              didThinkingBudgetRetry = true
              bodyForAttempt = retryBody
              continue
            }
          }

          if (shouldRetryTransientHttpFailure(attempt, apiErr.status)) {
            const delayMs = retryDelayMs(attempt)
            console.warn(
              `[AIService] Chat transient API failure, retry ${attempt + 2}/${totalAttempts} in ${delayMs}ms: ${apiErr.status} ${apiErr.message}`,
            )
            if (await waitForRetryDelay(delayMs, options?.signal)) {
              return { content: '', error: ABORTED_ERROR }
            }
            continue
          }
          return { content: '', error: `API 错误: ${apiErr.message}` }
        }

        const data = await response.json()
        if (options?.signal?.aborted) return { content: '', error: ABORTED_ERROR }
        const rawContent = mode === 'claude' ? extractClaudeText(data) : data.choices?.[0]?.message?.content || ''

        // Extract expression/motion tags
        const { cleanedText, expression, motion } = extractTags(rawContent)

        // 读取 API 返回的真实 token 统计
        const usage = mode === 'claude' ? readClaudeUsage(data) : readOpenAIUsage(data)

        return { content: cleanedText, expression, motion, usage }
      } catch (err) {
        if (isAbortError(err) || isSignalAborted(options?.signal)) {
          return { content: '', error: ABORTED_ERROR }
        }
        const errorMessage = err instanceof Error ? err.message : String(err)
        if (shouldRetryTransientError(attempt, err)) {
          const delayMs = retryDelayMs(attempt)
          console.warn(`[AIService] Chat transient error, retry ${attempt + 2}/${totalAttempts} in ${delayMs}ms: ${errorMessage}`)
          if (await waitForRetryDelay(delayMs, options?.signal)) {
            return { content: '', error: ABORTED_ERROR }
          }
          continue
        }
        console.error('[AIService] Chat error:', errorMessage)
        return { content: '', error: errorMessage }
      }
    }

    return { content: '', error: '请求失败：重试后仍未成功' }
  }

  /**
   * Stream chat response (SSE) and emit deltas.
   * - 兼容 OpenAI / OpenAI-compatible `chat/completions` SSE 输出
   */
  async chatStream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal; onDelta?: (delta: string) => void; systemAddon?: string },
  ): Promise<ChatResponse> {
    const {
      apiMode,
      apiKey,
      baseUrl,
      model,
      temperature,
      maxTokens,
      thinkingEffort,
      thinkingProvider,
      openaiReasoningEffort,
      claudeThinkingEffort,
      geminiThinkingEffort,
      systemPrompt,
    } = this.settings

    if (!(this.settings.hasApiKey ?? Boolean(apiKey))) {
      return { content: '', error: '请先配置 API Key' }
    }

    let fullSystemPrompt = buildSystemPrompt(systemPrompt, this.expressions, this.motions)
    if (options?.systemAddon?.trim()) {
      fullSystemPrompt += `\n\n${options.systemAddon.trim()}`
    }
    const messagesWithSystem = this.ensureSystemPrompt(messages, fullSystemPrompt)
    const mode = normalizeApiMode(apiMode)
    const requestBody =
      mode === 'claude'
        ? buildClaudeMessagesPayload({
            model,
            messages: messagesWithSystem,
            temperature,
            maxTokens,
            claudeThinkingEffort,
            stream: true,
          })
        : buildChatCompletionPayload({
            model,
            messages: messagesWithSystem,
            temperature,
            maxTokens,
            thinkingEffort,
            thinkingProvider,
            openaiReasoningEffort,
            claudeThinkingEffort,
            geminiThinkingEffort,
            stream: true,
          })

    const endpoint = joinApiUrl(baseUrl, mode === 'claude' ? 'messages' : 'chat/completions')
    const headers = buildApiHeaders(mode, apiKey)
    let bodyForAttempt = requestBody
    let didThinkingBudgetRetry = false
    const totalAttempts = TRANSIENT_RETRY_LIMIT + 1

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      let rawContent = ''
      let usage: ChatUsage | undefined
      try {
        const response = await postChatCompletion({
          endpoint,
          apiKey,
          credential: this.credential,
          body: bodyForAttempt,
          headers,
          signal: options?.signal,
        })

        if (!response.ok) {
          const apiErr = await readApiHttpError(response)
          if (!didThinkingBudgetRetry && isThinkingBudgetError(apiErr.message)) {
            const retryBody = buildRetryPayloadForThinkingBudget(bodyForAttempt, apiErr.message)
            if (retryBody) {
              didThinkingBudgetRetry = true
              bodyForAttempt = retryBody
              continue
            }
          }

          if (shouldRetryTransientHttpFailure(attempt, apiErr.status)) {
            const delayMs = retryDelayMs(attempt)
            console.warn(
              `[AIService] Chat stream transient API failure, retry ${attempt + 2}/${totalAttempts} in ${delayMs}ms: ${apiErr.status} ${apiErr.message}`,
            )
            if (await waitForRetryDelay(delayMs, options?.signal)) {
              return { content: '', error: ABORTED_ERROR }
            }
            continue
          }
          return { content: '', error: `API 错误: ${apiErr.message}` }
        }

        if (!response.body) {
          throw new Error('流式响应为空（response.body 不存在）')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        const onAbort = () => {
          void reader.cancel().catch(() => undefined)
        }
        if (options?.signal?.aborted) {
          await reader.cancel().catch(() => undefined)
          return { content: '', error: ABORTED_ERROR }
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })

        let buffer = ''
        let streamEnded = false

        try {
          while (!streamEnded) {
            if (options?.signal?.aborted) {
              await reader.cancel().catch(() => undefined)
              return { content: '', error: ABORTED_ERROR }
            }
            const { value, done } = await reader.read()
            if (options?.signal?.aborted) {
              await reader.cancel().catch(() => undefined)
              return { content: '', error: ABORTED_ERROR }
            }
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Parse SSE as line stream: each "data: ..." is terminated by \n
            let hasMoreLines = true
            while (hasMoreLines) {
              if (options?.signal?.aborted) {
                await reader.cancel().catch(() => undefined)
                return { content: '', error: ABORTED_ERROR }
              }
              const lineEnd = buffer.indexOf('\n')
              if (lineEnd === -1) break

              const line = buffer.slice(0, lineEnd).trim()
              buffer = buffer.slice(lineEnd + 1)
              if (!line.startsWith('data:')) continue

              const dataStr = line.slice('data:'.length).trim()
              if (!dataStr) continue
              if (dataStr === '[DONE]') {
                buffer = ''
                streamEnded = true
                hasMoreLines = false
                break
              }

              let payload: unknown
              try {
                payload = JSON.parse(dataStr)
              } catch {
                continue
              }

              if (mode === 'claude') {
                const payloadObj = payload as {
                  type?: string
                  error?: { message?: string }
                  message?: unknown
                  usage?: unknown
                  delta?: { text?: unknown }
                }

                if (payloadObj.type === 'error') {
                  throw new Error(payloadObj.error?.message || 'Claude stream error')
                }

                usage = mergeUsage(usage, readClaudeUsage(payloadObj.message ?? payloadObj))

                const piece = typeof payloadObj.delta?.text === 'string' ? payloadObj.delta.text : ''
                if (piece) {
                  if (options?.signal?.aborted) {
                    await reader.cancel().catch(() => undefined)
                    return { content: '', error: ABORTED_ERROR }
                  }
                  rawContent += piece
                  options?.onDelta?.(piece)
                }

                if (payloadObj.type === 'message_stop') {
                  streamEnded = true
                  hasMoreLines = false
                }
                continue
              }

              // 尝试读取 usage（某些 API 在流式最后一条消息或每条消息中包含 usage）
              const payloadObj = payload as {
                choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
              }
              if (payloadObj.usage) {
                usage = {
                  promptTokens: payloadObj.usage.prompt_tokens ?? 0,
                  completionTokens: payloadObj.usage.completion_tokens ?? 0,
                  totalTokens: payloadObj.usage.total_tokens ?? 0,
                }
              }

              const choice = payloadObj.choices?.[0]
              const delta = choice?.delta?.content ?? ''
              const msg = choice?.message?.content ?? ''
              const piece = delta || msg
              if (!piece) continue

              if (options?.signal?.aborted) {
                await reader.cancel().catch(() => undefined)
                return { content: '', error: ABORTED_ERROR }
              }
              rawContent += piece
              options?.onDelta?.(piece)
            }
          }
        } finally {
          options?.signal?.removeEventListener('abort', onAbort)
        }

        const { cleanedText, expression, motion } = extractTags(rawContent)
        return { content: cleanedText, expression, motion, usage }
      } catch (err) {
        if (isAbortError(err) || isSignalAborted(options?.signal)) {
          return { content: '', error: ABORTED_ERROR }
        }

        const errorMessage = err instanceof Error ? err.message : String(err)
        if (rawContent.trim()) {
          // 已经有有效输出时不自动重试，避免重复内容；把错误透传给上层用于提示“中断”
          const { cleanedText, expression, motion } = extractTags(rawContent)
          return { content: cleanedText, expression, motion, usage, error: errorMessage }
        }

        if (shouldRetryTransientError(attempt, err)) {
          const delayMs = retryDelayMs(attempt)
          console.warn(`[AIService] Chat stream transient error, retry ${attempt + 2}/${totalAttempts} in ${delayMs}ms: ${errorMessage}`)
          if (await waitForRetryDelay(delayMs, options?.signal)) {
            return { content: '', error: ABORTED_ERROR }
          }
          continue
        }
        console.error('[AIService] Chat stream error:', errorMessage)
        return { content: '', error: errorMessage }
      }
    }

    return { content: '', error: '请求失败：重试后仍未成功' }
  }

  private ensureSystemPrompt(messages: ChatMessage[], systemPrompt: string): ChatMessage[] {
    if (!systemPrompt || messages.some((m) => m.role === 'system')) {
      return messages
    }
    return [{ role: 'system', content: systemPrompt }, ...messages]
  }
}

// Singleton instance
let aiServiceInstance: AIService | null = null

export function getAIService(settings?: AISettings): AIService | null {
  if (settings) {
    if (aiServiceInstance) {
      aiServiceInstance.updateSettings(settings)
    } else {
      aiServiceInstance = new AIService(settings)
    }
  }
  return aiServiceInstance
}

export function setModelInfoToAIService(expressions: string[], motions: string[]) {
  if (aiServiceInstance) {
    aiServiceInstance.setModelInfo(expressions, motions)
  }
}
