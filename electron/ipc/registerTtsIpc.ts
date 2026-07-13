import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { listTtsOptions } from '../ttsOptions'
import type { TtsSettings } from '../types'
import type { IpcHandle, IpcOn } from './registration'

export type TtsHttpRequestPayload = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export type TtsFetch = (input: string, init?: RequestInit) => Promise<Response>

export type TtsIpcDependencies = {
  getSettings: () => { tts: TtsSettings }
  getPetWindow: () => BrowserWindow | null
  getChatWindow: () => BrowserWindow | null
  appRoot?: string
  listOptions?: typeof listTtsOptions
  fetchImpl?: TtsFetch
  createStreamId?: () => string
}

const TTS_ALLOWED_PATHS = new Set(['/tts', '/set_gpt_weights', '/set_sovits_weights'])

export function validateTtsUrl(rawUrl: string, rawBaseUrl: string): URL {
  const url = new URL(rawUrl)
  const ttsBase = rawBaseUrl.trim().replace(/\/+$/, '')
  if (!ttsBase) throw new Error('TTS baseUrl not configured')
  const base = new URL(ttsBase)
  if (url.origin !== base.origin) {
    throw new Error(`TTS request must be same-origin with tts.baseUrl: ${base.origin}`)
  }
  if (!TTS_ALLOWED_PATHS.has(url.pathname)) {
    throw new Error(`TTS 请求路径不允许: ${url.pathname}`)
  }
  return url
}

function normalizeMethod(method: TtsHttpRequestPayload['method']): 'GET' | 'POST' {
  return (method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
}

function normalizeTimeout(timeoutMs: number | undefined, fallback: number): number {
  return Math.max(1000, Math.min(180000, timeoutMs ?? fallback))
}

export class TtsIpcService {
  private readonly streams = new Map<string, AbortController>()
  private readonly appRoot: string
  private readonly listOptions: typeof listTtsOptions
  private readonly fetchImpl: TtsFetch
  private readonly createStreamId: () => string

  constructor(private readonly deps: TtsIpcDependencies) {
    this.appRoot = deps.appRoot ?? process.env.APP_ROOT ?? process.cwd()
    this.listOptions = deps.listOptions ?? listTtsOptions
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.createStreamId = deps.createStreamId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  }

  register(handle: IpcHandle, onIpc: IpcOn): void {
    handle('tts:listOptions', () => {
      const configured = (this.deps.getSettings().tts.ttsRoot ?? '').trim()
      const ttsRoot = configured || path.join(this.appRoot, 'GPT-SoVITS-v2_ProPlus')
      return this.listOptions(ttsRoot)
    })

    handle('tts:httpGetJson', async (_event, rawUrl: string) => {
      const url = this.validateUrl(rawUrl)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), 60000)
      try {
        const res = await this.fetchImpl(url.toString(), { cache: 'no-store', signal: ac.signal })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = (data as { message?: string })?.message
          return {
            ok: false,
            status: res.status,
            statusText: res.statusText,
            json: data,
            error: message || `HTTP ${res.status}`,
          }
        }
        return { ok: true, status: res.status, statusText: res.statusText, json: data }
      } finally {
        clearTimeout(timer)
      }
    })

    handle('tts:httpRequestArrayBuffer', async (_event, payload: TtsHttpRequestPayload) => {
      const url = this.validateUrl(payload.url)
      const method = normalizeMethod(payload.method)
      const timeoutMs = normalizeTimeout(payload.timeoutMs, 120000)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), timeoutMs)
      try {
        const res = await this.fetchImpl(url.toString(), {
          method,
          headers: payload.headers ?? undefined,
          body: method === 'POST' ? payload.body ?? '' : undefined,
          signal: ac.signal,
        })
        const arrayBuffer = await res.arrayBuffer()
        const contentType = res.headers.get('content-type') ?? ''
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            statusText: res.statusText,
            contentType,
            arrayBuffer,
            error: `HTTP ${res.status}: ${res.statusText}`,
          }
        }
        return { ok: true, status: res.status, statusText: res.statusText, contentType, arrayBuffer }
      } finally {
        clearTimeout(timer)
      }
    })

    handle('tts:httpStreamStart', async (event, payload: TtsHttpRequestPayload) => {
      const url = this.validateUrl(payload.url)
      const method = normalizeMethod(payload.method)
      const timeoutMs = normalizeTimeout(payload.timeoutMs, 120000)
      const streamId = this.createStreamId()
      const ac = new AbortController()
      this.streams.set(streamId, ac)

      const sender = event.sender
      const safeSend = (channel: string, data: unknown) => {
        try {
          if (!sender || sender.isDestroyed()) return
          sender.send(channel, data)
        } catch {
          // The renderer may close while a stream is completing.
        }
      }

      void (async () => {
        const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), timeoutMs)
        try {
          const res = await this.fetchImpl(url.toString(), {
            method,
            headers: payload.headers ?? undefined,
            body: method === 'POST' ? payload.body ?? '' : undefined,
            signal: ac.signal,
          })

          if (!res.ok) {
            const arrayBuffer = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
            safeSend('tts:httpStreamError', {
              streamId,
              status: res.status,
              statusText: res.statusText,
              contentType: res.headers.get('content-type') ?? '',
              arrayBuffer,
              error: `HTTP ${res.status}: ${res.statusText}`,
            })
            safeSend('tts:httpStreamDone', { streamId })
            return
          }

          if (!res.body) {
            safeSend('tts:httpStreamError', { streamId, error: 'TTS response body is empty' })
            safeSend('tts:httpStreamDone', { streamId })
            return
          }

          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) safeSend('tts:httpStreamChunk', { streamId, chunk: value })
          }
          safeSend('tts:httpStreamDone', { streamId })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          safeSend('tts:httpStreamError', { streamId, error: message })
          safeSend('tts:httpStreamDone', { streamId })
        } finally {
          clearTimeout(timer)
          this.streams.delete(streamId)
        }
      })()

      return { streamId }
    })

    handle('tts:httpStreamCancel', (_event, streamId: string) => {
      this.abortStream(streamId, 'TTS stream canceled')
      return { ok: true as const }
    })

    onIpc('tts:enqueue', (_event, payload: unknown) => this.sendToWindow(this.deps.getPetWindow(), 'tts:enqueue', payload))
    onIpc('tts:finalize', (_event, utteranceId: string) =>
      this.sendToWindow(this.deps.getPetWindow(), 'tts:finalize', utteranceId),
    )
    onIpc('tts:stopAll', () => this.sendToWindow(this.deps.getPetWindow(), 'tts:stopAll'))
    onIpc('tts:segmentStarted', (_event, payload: unknown) =>
      this.sendToWindow(this.deps.getChatWindow(), 'tts:segmentStarted', payload),
    )
    onIpc('tts:utteranceEnded', (_event, payload: unknown) =>
      this.sendToWindow(this.deps.getChatWindow(), 'tts:utteranceEnded', payload),
    )
    onIpc('tts:utteranceFailed', (_event, payload: unknown) =>
      this.sendToWindow(this.deps.getChatWindow(), 'tts:utteranceFailed', payload),
    )
  }

  close(): void {
    for (const streamId of this.streams.keys()) this.abortStream(streamId, 'TTS service closed')
  }

  private validateUrl(rawUrl: string): URL {
    return validateTtsUrl(rawUrl, this.deps.getSettings().tts.baseUrl ?? '')
  }

  private abortStream(streamId: string, reason: string): void {
    const ac = this.streams.get(streamId)
    if (!ac) return
    try {
      ac.abort(new Error(reason))
    } catch {
      // AbortController implementations may throw after completion.
    }
    this.streams.delete(streamId)
  }

  private sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): void {
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, ...args)
  }
}
