import type { WebContents } from 'electron'
import type {
  AIApiMode,
  AICredentialRef,
  AIHttpRequestPayload,
  AIHttpResponse,
  AIHttpStreamStartPayload,
  AIHttpStreamStartResult,
  AppSettings,
} from './types'

const ANTHROPIC_VERSION = '2023-06-01'
const MAX_AI_REQUEST_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

export type ResolvedAICredential = {
  apiMode: AIApiMode
  apiKey: string
  baseUrl: string
}

type ActiveStream = {
  senderId: number
  abortController: AbortController
}

function normalizeBaseUrl(raw: string): string {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!value) throw new Error('AI baseUrl is not configured')
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AI baseUrl must use http or https')
  }
  return url.toString().replace(/\/+$/, '')
}

function normalizeApiMode(value: unknown): AIApiMode {
  return value === 'claude' ? 'claude' : 'openai-compatible'
}

export function resolveAiCredential(settings: AppSettings, ref: AICredentialRef): ResolvedAICredential {
  if (ref.kind === 'profile') {
    const profileId = String(ref.profileId ?? '').trim()
    const profile = settings.aiProfiles.find((item) => item.id === profileId)
    if (!profile) throw new Error('AI profile was not found')
    const apiKey = String(profile.apiKey ?? '').trim()
    if (!apiKey) throw new Error('AI profile API Key is not configured')
    return {
      apiMode: normalizeApiMode(profile.apiMode),
      apiKey,
      baseUrl: normalizeBaseUrl(profile.baseUrl),
    }
  }

  if (ref.kind === 'memory-auto-extract') {
    const memory = settings.memory
    const customKey = String(memory.autoExtractAiApiKey ?? '').trim()
    const customBaseUrl = String(memory.autoExtractAiBaseUrl ?? '').trim()
    const apiKey = customKey || String(settings.ai.apiKey ?? '').trim()
    const baseUrl = customBaseUrl || settings.ai.baseUrl
    if (!apiKey) throw new Error('Memory extraction API Key is not configured')
    return {
      apiMode: normalizeApiMode(settings.ai.apiMode),
      apiKey,
      baseUrl: normalizeBaseUrl(baseUrl),
    }
  }

  const apiKey = String(settings.ai.apiKey ?? '').trim()
  if (!apiKey) throw new Error('AI API Key is not configured')
  return {
    apiMode: normalizeApiMode(settings.ai.apiMode),
    apiKey,
    baseUrl: normalizeBaseUrl(settings.ai.baseUrl),
  }
}

export function buildAiEndpoint(credential: ResolvedAICredential): URL {
  const pathname = credential.apiMode === 'claude' ? 'messages' : 'chat/completions'
  return new URL(`${credential.baseUrl.replace(/\/+$/, '')}/${pathname}`)
}

function buildAiHeaders(credential: ResolvedAICredential): Record<string, string> {
  if (credential.apiMode === 'claude') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': credential.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.apiKey}`,
  }
}

function normalizeTimeoutMs(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(10 * 60_000, value))
}

function serializeRequestBody(body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body ?? {})
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AI_REQUEST_BYTES) {
    throw new Error('AI request body is too large')
  }
  return serialized
}

async function readResponse(res: Response): Promise<AIHttpResponse> {
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    contentType: res.headers.get('content-type') ?? '',
    bodyText: await res.text(),
  }
}

export class AIHttpProxy {
  private readonly getSettings: () => AppSettings
  private readonly streams = new Map<string, ActiveStream>()

  constructor(getSettings: () => AppSettings) {
    this.getSettings = getSettings
  }

  async request(payload: AIHttpRequestPayload): Promise<AIHttpResponse> {
    const credential = resolveAiCredential(this.getSettings(), payload.credential)
    const endpoint = buildAiEndpoint(credential)
    const body = serializeRequestBody(payload.body)
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(new Error('AI HTTP timeout')), normalizeTimeoutMs(payload.timeoutMs))
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildAiHeaders(credential),
        body,
        signal: abortController.signal,
      })
      return await readResponse(response)
    } finally {
      clearTimeout(timer)
    }
  }

  async startStream(sender: WebContents, payload: AIHttpStreamStartPayload): Promise<AIHttpStreamStartResult> {
    const streamId = String(payload.streamId ?? '').trim()
    if (!/^[a-zA-Z0-9_-]{8,160}$/.test(streamId)) throw new Error('Invalid AI stream ID')
    if (this.streams.has(streamId)) throw new Error('AI stream ID is already active')

    const credential = resolveAiCredential(this.getSettings(), payload.credential)
    const endpoint = buildAiEndpoint(credential)
    const body = serializeRequestBody(payload.body)
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(new Error('AI HTTP timeout')), normalizeTimeoutMs(payload.timeoutMs))
    this.streams.set(streamId, { senderId: sender.id, abortController })

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: buildAiHeaders(credential),
        body,
        signal: abortController.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      this.streams.delete(streamId)
      throw error
    }

    const baseResult = {
      streamId,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') ?? '',
    }
    if (!response.ok || !response.body) {
      clearTimeout(timer)
      this.streams.delete(streamId)
      return {
        ...baseResult,
        bodyText: response.body ? await response.text() : '',
      }
    }

    const safeSend = (channel: string, data: unknown) => {
      if (sender.isDestroyed()) return
      try {
        sender.send(channel, data)
      } catch {
        // The renderer may close while a request is in flight.
      }
    }

    void (async () => {
      try {
        const reader = response.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) safeSend('ai:httpStreamChunk', { streamId, chunk: value })
        }
        safeSend('ai:httpStreamDone', { streamId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        safeSend('ai:httpStreamError', { streamId, error: message })
        safeSend('ai:httpStreamDone', { streamId })
      } finally {
        clearTimeout(timer)
        this.streams.delete(streamId)
      }
    })()

    return { ...baseResult, bodyText: '' }
  }

  cancelStream(senderId: number, streamIdRaw: string): { ok: true } {
    const streamId = String(streamIdRaw ?? '').trim()
    const active = this.streams.get(streamId)
    if (active && active.senderId === senderId) {
      active.abortController.abort(new Error('AI stream canceled'))
      this.streams.delete(streamId)
    }
    return { ok: true }
  }

  close(): void {
    for (const active of this.streams.values()) active.abortController.abort(new Error('AI proxy closed'))
    this.streams.clear()
  }
}
