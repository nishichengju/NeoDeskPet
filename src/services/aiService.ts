import type { AISettings } from '../../electron/types'
import { buildOpenAICompatReasoningOptions } from '../../electron/reasoningConfig'

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
  private expressions: string[] = []
  private motions: string[] = []

  constructor(settings: AISettings) {
    this.settings = settings
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

    if (!apiKey) {
      return { content: '', error: '请先配置 API Key' }
    }

    // Build system prompt with expression instructions
    let fullSystemPrompt = buildSystemPrompt(systemPrompt, this.expressions, this.motions)
    if (options?.systemAddon?.trim()) {
      fullSystemPrompt += `\n\n${options.systemAddon.trim()}`
    }

    // Add system prompt if not already present
    const messagesWithSystem = this.ensureSystemPrompt(messages, fullSystemPrompt)
    const requestBody = buildChatCompletionPayload({
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

    try {
      let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMessage = extractApiErrorMessage(errorData, response.status, response.statusText)
        const retryBody = isThinkingBudgetError(errorMessage)
          ? buildRetryPayloadForThinkingBudget(requestBody, errorMessage)
          : null
        if (retryBody) {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(retryBody),
            signal: options?.signal,
          })
        }
        if (!response.ok) {
          const retryErrorData = await response.json().catch(() => ({}))
          const retryErrorMessage = extractApiErrorMessage(retryErrorData, response.status, response.statusText)
          return { content: '', error: `API 错误: ${retryErrorMessage}` }
        }
      }

      const data = await response.json()
      const rawContent = data.choices?.[0]?.message?.content || ''

      // Extract expression/motion tags
      const { cleanedText, expression, motion } = extractTags(rawContent)

      // 读取 API 返回的真实 token 统计
      const usageData = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
      const usage: ChatUsage | undefined = usageData
        ? {
            promptTokens: usageData.prompt_tokens ?? 0,
            completionTokens: usageData.completion_tokens ?? 0,
            totalTokens: usageData.total_tokens ?? 0,
          }
        : undefined

      return { content: cleanedText, expression, motion, usage }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { content: '', error: ABORTED_ERROR }
      }
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[AIService] Chat error:', errorMessage)
      return { content: '', error: errorMessage }
    }
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

    if (!apiKey) {
      return { content: '', error: '请先配置 API Key' }
    }

    let fullSystemPrompt = buildSystemPrompt(systemPrompt, this.expressions, this.motions)
    if (options?.systemAddon?.trim()) {
      fullSystemPrompt += `\n\n${options.systemAddon.trim()}`
    }
    const messagesWithSystem = this.ensureSystemPrompt(messages, fullSystemPrompt)
    const requestBody = buildChatCompletionPayload({
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

    try {
      let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMessage = extractApiErrorMessage(errorData, response.status, response.statusText)
        const retryBody = isThinkingBudgetError(errorMessage)
          ? buildRetryPayloadForThinkingBudget(requestBody, errorMessage)
          : null
        if (retryBody) {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(retryBody),
            signal: options?.signal,
          })
        }
        if (!response.ok) {
          const retryErrorData = await response.json().catch(() => ({}))
          const retryErrorMessage = extractApiErrorMessage(retryErrorData, response.status, response.statusText)
          return { content: '', error: `API 错误: ${retryErrorMessage}` }
        }
      }

      if (!response.body) {
        return { content: '', error: '流式响应为空（response.body 不存在）' }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')

      let buffer = ''
      let rawContent = ''
      let streamEnded = false
      let usage: ChatUsage | undefined // 用于存储流式响应中的 usage

      while (!streamEnded) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE as line stream: each "data: ..." is terminated by \n
        let hasMoreLines = true
        while (hasMoreLines) {
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

          rawContent += piece
          options?.onDelta?.(piece)
        }
      }

      const { cleanedText, expression, motion } = extractTags(rawContent)
      return { content: cleanedText, expression, motion, usage }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { content: '', error: ABORTED_ERROR }
      }
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[AIService] Chat stream error:', errorMessage)
      return { content: '', error: errorMessage }
    }
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
