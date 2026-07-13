export type TaskAgentApiMode = 'claude' | 'openai-compatible'

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type RawToolCall = Record<string, unknown>

export type AssistantMessage = Record<string, unknown> & {
  role?: string
  content?: unknown
  tool_calls?: unknown
  function_call?: unknown
}

export type LlmUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type NativeAssistantResult = {
  contentText: string
  toolCalls: ToolCall[]
  rawToolCalls: RawToolCall[]
  assistantMsgRaw: AssistantMessage
}

type RetryableLlmError = Error & { status?: number }

export function createHttpStatusError(message: string, status: number): RetryableLlmError {
  const error = new Error(message) as RetryableLlmError
  error.status = status
  return error
}

export function readErrorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

export function isAbortLikeError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase()
  return message === 'canceled' || message === 'cancelled'
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

export function isTransientErrorMessage(message: string): boolean {
  const normalized = String(message ?? '').toLowerCase()
  return (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('network error') ||
    normalized.includes('networkerror') ||
    normalized.includes('fetch failed') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('socket hang up') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('etimedout') ||
    normalized.includes('connection reset') ||
    normalized.includes('connection refused') ||
    normalized.includes('service unavailable') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('bad gateway') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('连接超时') ||
    normalized.includes('网络') ||
    normalized.includes('连接失败') ||
    normalized.includes('连接重置')
  )
}

export function shouldRetryTransientError(
  attempt: number,
  retryLimit: number,
  error: unknown,
  status: number | null,
): boolean {
  if (attempt >= retryLimit) return false
  if (isAbortLikeError(error)) return false
  if (status != null && isTransientHttpStatus(status)) return true
  const message = error instanceof Error ? error.message : String(error)
  return isTransientErrorMessage(message)
}

export function transientRetryDelayMs(
  attempt: number,
  baseDelayMs = 500,
  jitterMs = 250,
  random: () => number = Math.random,
): number {
  const backoff = baseDelayMs * Math.max(1, 2 ** attempt)
  const jitter = Math.floor(random() * jitterMs)
  return backoff + jitter
}

export function buildAgentEndpoint(baseUrl: string, apiMode: TaskAgentApiMode): string {
  const path = apiMode === 'claude' ? 'messages' : 'chat/completions'
  return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

export function buildAgentHeaders(apiMode: TaskAgentApiMode, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiMode === 'claude') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseClaudeDataUrl(url: string): { mediaType: string; data: string } | null {
  const raw = String(url ?? '').trim()
  if (!raw.startsWith('data:')) return null
  const comma = raw.indexOf(',')
  if (comma < 0) return null
  const meta = raw.slice(5, comma)
  const data = raw.slice(comma + 1)
  const parts = meta.split(';').map((part) => part.trim())
  const mediaType = parts[0] || 'application/octet-stream'
  if (!parts.includes('base64') || !data) return null
  return { mediaType, data }
}

function toClaudeContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    if (record.type === 'text') {
      const text = typeof record.text === 'string' ? record.text : ''
      if (text.trim()) blocks.push({ type: 'text', text })
      continue
    }
    if (record.type === 'image_url') {
      const image = record.image_url && typeof record.image_url === 'object' ? (record.image_url as Record<string, unknown>) : null
      const url = typeof image?.url === 'string' ? image.url.trim() : ''
      if (!url) continue
      const dataUrl = parseClaudeDataUrl(url)
      blocks.push(
        dataUrl
          ? { type: 'image', source: { type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data } }
          : { type: 'image', source: { type: 'url', url } },
      )
    }
  }
  return blocks
}

export function buildClaudeTextPayload(options: {
  messages: Array<Record<string, unknown>>
  model: string
  maxTokens: number
  temperature: number
  thinking?: unknown
  stream: boolean
}): Record<string, unknown> {
  const systemParts: string[] = []
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = []
  for (const message of options.messages) {
    const roleRaw = typeof message.role === 'string' ? message.role : 'user'
    if (roleRaw === 'system') {
      const text = textFromMessageContent(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    const role = roleRaw === 'assistant' ? 'assistant' : 'user'
    const content = toClaudeContentBlocks(message.content)
    if (!content.length) continue
    const previous = messages[messages.length - 1]
    if (previous?.role === role) previous.content.push(...content)
    else messages.push({ role, content })
  }

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    messages,
    stream: options.stream,
  }
  if (systemParts.length) body.system = systemParts.join('\n\n')
  if (
    options.thinking &&
    typeof options.thinking === 'object' &&
    !Array.isArray(options.thinking) &&
    (options.thinking as { type?: unknown }).type === 'enabled'
  ) {
    body.thinking = options.thinking
  }
  return body
}

export function readClaudeUsage(payload: unknown): LlmUsage | undefined {
  const usage = (payload as { usage?: unknown })?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const input = (usage as { input_tokens?: unknown }).input_tokens
  const output = (usage as { output_tokens?: unknown }).output_tokens
  const promptTokens = typeof input === 'number' && Number.isFinite(input) ? input : 0
  const completionTokens = typeof output === 'number' && Number.isFinite(output) ? output : 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

export function mergeLlmUsage(previous: LlmUsage | undefined, next: LlmUsage | undefined): LlmUsage | undefined {
  if (!next) return previous
  const promptTokens = next.promptTokens || previous?.promptTokens || 0
  const completionTokens = next.completionTokens || previous?.completionTokens || 0
  const totalTokens = Math.max(next.totalTokens, previous?.totalTokens ?? 0, promptTokens + completionTokens)
  return { promptTokens, completionTokens, totalTokens }
}

function ensureToolCallId(raw: RawToolCall, index: number): RawToolCall {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `call_${index}`
  if (raw.id === id) return raw
  return { ...raw, id }
}

function parseToolCall(rawInput: RawToolCall, index: number): ToolCall | null {
  const raw = ensureToolCallId(rawInput, index)
  const id = typeof raw.id === 'string' ? raw.id : `call_${index}`
  const fn = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? (raw.function as Record<string, unknown>) : null
  const functionCall =
    raw.functionCall && typeof raw.functionCall === 'object' && !Array.isArray(raw.functionCall)
      ? (raw.functionCall as Record<string, unknown>)
      : null
  const name =
    (typeof fn?.name === 'string' ? fn.name : '') ||
    (typeof functionCall?.name === 'string' ? functionCall.name : '') ||
    (typeof raw.name === 'string' ? raw.name : '')
  const argumentValue = fn?.arguments ?? functionCall?.args ?? raw.arguments
  const argumentsString =
    typeof argumentValue === 'string'
      ? argumentValue
      : argumentValue != null
        ? (() => {
            try {
              return JSON.stringify(argumentValue)
            } catch {
              return ''
            }
          })()
        : ''
  if (!name.trim()) return null
  return { id, type: 'function', function: { name, arguments: argumentsString } }
}

export function parseNativeAssistantMessage(message: AssistantMessage): NativeAssistantResult {
  const contentText =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part) => {
              if (part && typeof part === 'object') {
                const text = (part as Record<string, unknown>).text
                if (typeof text === 'string') return text
              }
              return ''
            })
            .filter(Boolean)
            .join('\n')
        : ''

  const toolCallsRaw = Array.isArray(message.tool_calls)
    ? (message.tool_calls as unknown[])
        .map((call) => (call && typeof call === 'object' && !Array.isArray(call) ? (call as RawToolCall) : null))
        .filter((call): call is RawToolCall => Boolean(call))
    : []
  const legacyToolCalls: RawToolCall[] = (() => {
    const functionCall = message.function_call
    if (!functionCall || typeof functionCall !== 'object' || Array.isArray(functionCall)) return []
    const record = functionCall as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const args = typeof record.arguments === 'string' ? record.arguments : record.arguments != null ? JSON.stringify(record.arguments) : ''
    if (!name.trim()) return []
    return [{ id: 'call_legacy', type: 'function', function: { name, arguments: args } }]
  })()
  const rawToolCalls = toolCallsRaw.length ? toolCallsRaw : legacyToolCalls
  const normalizedRawToolCalls = rawToolCalls.map((call, index) => ensureToolCallId(call, index))
  const toolCalls = rawToolCalls.map((call, index) => parseToolCall(call, index)).filter((call): call is ToolCall => Boolean(call))
  const assistantMsgRaw: AssistantMessage = {
    ...message,
    role: typeof message.role === 'string' ? message.role : 'assistant',
  }
  if (normalizedRawToolCalls.length) assistantMsgRaw.tool_calls = normalizedRawToolCalls
  return { contentText, toolCalls, rawToolCalls: normalizedRawToolCalls, assistantMsgRaw }
}

export function mergeStreamString(previous: string, next: string): string {
  const current = previous ?? ''
  const incoming = next ?? ''
  if (!incoming) return current
  if (!current) return incoming
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current
  return current + incoming
}

export class SseDataBuffer {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const values: string[] = []
    let lineEnd = this.buffer.indexOf('\n')
    while (lineEnd !== -1) {
      const line = this.buffer.slice(0, lineEnd).trim()
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (line.startsWith('data:')) values.push(line.slice('data:'.length).trim())
      lineEnd = this.buffer.indexOf('\n')
    }
    return values
  }
}

export class NativeAssistantStreamAccumulator {
  private role: string | undefined
  private contentText = ''
  private legacyFunctionName = ''
  private legacyFunctionArguments = ''
  private readonly toolCalls: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }> = []

  push(payload: unknown): { delta: string; emitted: boolean } {
    const payloadObject = payload as {
      choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown> }>
    }
    const choice = payloadObject.choices?.[0]
    const deltaObject = choice?.delta ?? null
    const messageObject = choice?.message ?? null
    let emitted = false

    if (deltaObject && typeof deltaObject === 'object') {
      const role = deltaObject.role
      if (!this.role && typeof role === 'string' && role.trim()) this.role = role.trim()
    }

    const deltaContent = deltaObject && typeof deltaObject === 'object' ? deltaObject.content : undefined
    const messageContent = messageObject && typeof messageObject === 'object' ? messageObject.content : undefined
    const piece = (() => {
      if (typeof deltaContent === 'string' && deltaContent) return deltaContent
      if (typeof messageContent !== 'string' || !messageContent) return ''
      return messageContent.startsWith(this.contentText) ? messageContent.slice(this.contentText.length) : messageContent
    })()
    if (piece) {
      emitted = true
      this.contentText += piece
    }

    const toolCallsDelta = deltaObject && typeof deltaObject === 'object' ? deltaObject.tool_calls : undefined
    if (Array.isArray(toolCallsDelta) && toolCallsDelta.length > 0) {
      emitted = true
      for (let index = 0; index < toolCallsDelta.length; index += 1) {
        const raw = toolCallsDelta[index]
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const record = raw as Record<string, unknown>
        const targetIndex = typeof record.index === 'number' ? record.index : index
        const accumulator = this.ensureToolCall(Math.max(0, targetIndex))
        const id = typeof record.id === 'string' ? record.id : ''
        if (id.trim()) accumulator.id = id.trim()
        const type = typeof record.type === 'string' ? record.type : ''
        if (type.trim()) accumulator.type = type.trim()
        const functionRaw = record.function
        if (functionRaw && typeof functionRaw === 'object' && !Array.isArray(functionRaw)) {
          const fn = functionRaw as Record<string, unknown>
          const name = typeof fn.name === 'string' ? fn.name : ''
          if (name) accumulator.function!.name = mergeStreamString(accumulator.function!.name ?? '', name)
          const args = stringifyStreamValue(fn.arguments)
          if (args) accumulator.function!.arguments = mergeStreamString(accumulator.function!.arguments ?? '', args)
        }
      }
    }

    const legacyFunction = deltaObject && typeof deltaObject === 'object' ? deltaObject.function_call : undefined
    if (legacyFunction && typeof legacyFunction === 'object' && !Array.isArray(legacyFunction)) {
      emitted = true
      const record = legacyFunction as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (name) this.legacyFunctionName = mergeStreamString(this.legacyFunctionName, name)
      const args = stringifyStreamValue(record.arguments)
      if (args) this.legacyFunctionArguments = mergeStreamString(this.legacyFunctionArguments, args)
    }

    return { delta: piece, emitted }
  }

  toMessage(): AssistantMessage {
    const rawToolCalls = this.toolCalls
      .map((call, index) => {
        if (!call) return null
        const fn = call.function ?? {}
        const name = typeof fn.name === 'string' ? fn.name : ''
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        if (!name.trim()) return null
        return {
          id: typeof call.id === 'string' && call.id.trim() ? call.id : `call_${index}`,
          type: 'function',
          function: { name, arguments: args },
        }
      })
      .filter((call): call is { id: string; type: string; function: { name: string; arguments: string } } => Boolean(call))
    const message: AssistantMessage = { role: this.role || 'assistant', content: this.contentText }
    if (rawToolCalls.length) message.tool_calls = rawToolCalls
    else if (this.legacyFunctionName.trim()) {
      message.function_call = { name: this.legacyFunctionName, arguments: this.legacyFunctionArguments }
    }
    return message
  }

  private ensureToolCall(index: number) {
    if (!this.toolCalls[index]) this.toolCalls[index] = { type: 'function', function: { name: '', arguments: '' } }
    const call = this.toolCalls[index]!
    if (!call.function) call.function = { name: '', arguments: '' }
    if (typeof call.type !== 'string' || !call.type) call.type = 'function'
    return call
  }
}

function stringifyStreamValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export function parseTextStreamPayload(
  payload: unknown,
  apiMode: TaskAgentApiMode,
  previousUsage?: LlmUsage,
): { delta: string; usage?: LlmUsage; done: boolean } {
  const record = payload as {
    type?: string
    error?: { message?: string }
    message?: unknown
    delta?: { text?: unknown }
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  if (apiMode === 'claude') {
    if (record.type === 'error') {
      const error = new Error(record.error?.message || 'Claude stream error') as Error & { streamFatal?: boolean }
      error.streamFatal = true
      throw error
    }
    return {
      delta: typeof record.delta?.text === 'string' ? record.delta.text : '',
      usage: mergeLlmUsage(previousUsage, readClaudeUsage(record.message ?? record)),
      done: record.type === 'message_stop',
    }
  }

  const usage = record.usage
    ? {
        promptTokens: record.usage.prompt_tokens ?? 0,
        completionTokens: record.usage.completion_tokens ?? 0,
        totalTokens: record.usage.total_tokens ?? 0,
      }
    : previousUsage
  const choice = record.choices?.[0]
  return {
    delta: choice?.delta?.content ?? choice?.message?.content ?? '',
    usage,
    done: false,
  }
}
