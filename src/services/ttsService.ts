import type { TtsSettings } from '../../electron/types'
import { getApi } from '../neoDeskPetApi'

type LoadedWeights = {
  baseUrl: string
  gpt: string
  sovits: string
}

function getOriginLabel(rawUrl: string): string {
  const text = String(rawUrl ?? '').trim()
  if (!text) return ''
  try {
    return new URL(text).origin
  } catch {
    return text
  }
}

function formatTtsRequestError(baseUrl: string, message: string): string {
  const origin = getOriginLabel(baseUrl)
  const msg = String(message ?? '').trim()
  const lower = msg.toLowerCase()
  const isFetchFailed = lower === 'failed to fetch' || lower === 'fetch failed'
  if (!msg) return origin ? `TTS 请求失败（${origin}）` : 'TTS 请求失败'
  if (isFetchFailed) return origin ? `无法连接到 TTS 服务（${origin}）：${msg}` : `无法连接到 TTS 服务：${msg}`
  return origin ? `TTS 请求失败（${origin}）：${msg}` : `TTS 请求失败：${msg}`
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function concatUint8(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(a.length + b.length)
  next.set(a, 0)
  next.set(b, a.length)
  return next
}

function readU16LE(buf: Uint8Array<ArrayBufferLike>, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

function readU32LE(buf: Uint8Array<ArrayBufferLike>, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
}

function writeU32LE(buf: Uint8Array<ArrayBufferLike>, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

function isWavHeader(buf: Uint8Array<ArrayBufferLike>): boolean {
  if (buf.length < 12) return false
  const riff = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
  const wave = String.fromCharCode(buf[8], buf[9], buf[10], buf[11])
  return riff === 'RIFF' && wave === 'WAVE'
}

function createWavFromChunk(header44: Uint8Array<ArrayBufferLike>, chunk: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + chunk.length)
  out.set(header44, 0)
  out.set(chunk, 44)

  // RIFF chunk size = 36 + data size
  writeU32LE(out, 4, 36 + chunk.length)
  // data chunk size
  writeU32LE(out, 40, chunk.length)
  return out
}

function getWavByteRate(header44: Uint8Array<ArrayBufferLike>): number {
  // Standard WAV header: byteRate @ 28, sampleRate @ 24, channels @ 22, bitsPerSample @ 34
  const byteRate = readU32LE(header44, 28)
  if (byteRate > 0) return byteRate

  const sampleRate = readU32LE(header44, 24)
  const channels = readU16LE(header44, 22)
  const bitsPerSample = readU16LE(header44, 34)
  const fallback = Math.max(1, Math.floor((sampleRate * channels * bitsPerSample) / 8))
  return fallback
}

function toArrayBuffer(data: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  // 强制拷贝到 ArrayBuffer，避免 SharedArrayBuffer 导致 decodeAudioData 类型/兼容问题
  return data.slice().buffer
}

export class TtsPlayer {
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private nextPlayTime = 0
  private abortController: AbortController | null = null
  private activeSources: AudioBufferSourceNode[] = []
  private loadedWeights: LoadedWeights | null = null
  private streamDone = true
  private firstPlayFired = false
  private onFirstPlay: (() => void) | null = null
  private onChunkStart: ((payload: { offsetSec: number; durationSec: number }) => void) | null = null
  private onEnded: (() => void) | null = null
  private timeDomainBuffer: Uint8Array<ArrayBuffer> | null = null
  private playStartTime: number | null = null
  private chunkStartTimers: number[] = []
  private activeHttpStreamId: string | null = null
  private streamUnsubscribers: Array<() => void> = []

  stop(): void {
    // 先清掉定时器/IPC 监听，避免 stop() 后还有“分句推进”之类的回调冒出来
    for (const id of this.chunkStartTimers) {
      try {
        window.clearTimeout(id)
      } catch {
        // ignore
      }
    }
    this.chunkStartTimers = []

    for (const unsub of this.streamUnsubscribers) {
      try {
        unsub()
      } catch {
        // ignore
      }
    }
    this.streamUnsubscribers = []

    const api = getApi()
    if (this.activeHttpStreamId && api?.ttsHttpStreamCancel) {
      const sid = this.activeHttpStreamId
      this.activeHttpStreamId = null
      void api.ttsHttpStreamCancel(sid).catch(() => undefined)
    } else {
      this.activeHttpStreamId = null
    }

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.streamDone = true
    const onEnded = this.onEnded
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch {
        // ignore
      }
    }
    this.activeSources = []
    this.nextPlayTime = 0
    this.firstPlayFired = false
    this.playStartTime = null
    if (onEnded) onEnded()
    this.onFirstPlay = null
    this.onChunkStart = null
    this.onEnded = null
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)()
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.connect(this.audioContext.destination)
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
    return this.audioContext
  }

  private async httpGetJson(url: string): Promise<unknown> {
    const api = getApi()
    if (api?.ttsHttpGetJson) {
      const res = await api.ttsHttpGetJson(url)
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
      return res.json
    }

    const res = await fetch(url, { cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = (data as { message?: string })?.message
      throw new Error(msg || `HTTP ${res.status}`)
    }
    return data
  }

  private async ensureWeights(settings: TtsSettings): Promise<void> {
    const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
    const next: LoadedWeights = {
      baseUrl,
      gpt: settings.gptWeightsPath.trim(),
      sovits: settings.sovitsWeightsPath.trim(),
    }

    const prev = this.loadedWeights
    const baseChanged = !prev || prev.baseUrl !== next.baseUrl
    if (baseChanged) this.loadedWeights = { baseUrl: next.baseUrl, gpt: '', sovits: '' }

    if (next.gpt && (baseChanged || !prev || prev.gpt !== next.gpt)) {
      await this.httpGetJson(`${next.baseUrl}/set_gpt_weights?weights_path=${encodeURIComponent(next.gpt)}`)
      this.loadedWeights = { ...(this.loadedWeights as LoadedWeights), gpt: next.gpt }
    }
    if (next.sovits && (baseChanged || !prev || prev.sovits !== next.sovits)) {
      await this.httpGetJson(`${next.baseUrl}/set_sovits_weights?weights_path=${encodeURIComponent(next.sovits)}`)
      this.loadedWeights = { ...(this.loadedWeights as LoadedWeights), sovits: next.sovits }
    }
  }

  private playDecodedBuffer(audioBuffer: AudioBuffer): void {
    if (!this.audioContext) return
    const src = this.audioContext.createBufferSource()
    src.buffer = audioBuffer
    const analyser = this.analyser
    if (analyser) src.connect(analyser)
    else src.connect(this.audioContext.destination)

    const now = this.audioContext.currentTime
    if (this.nextPlayTime < now) this.nextPlayTime = now

    const startAt = this.nextPlayTime
    if (this.playStartTime === null) this.playStartTime = startAt
    src.start(startAt)

    // 分句同步：按“音频块开始播放”推进 UI（不做强对齐，只保证顺序和大致节奏）
    const onChunkStart = this.onChunkStart
    if (onChunkStart && this.playStartTime !== null) {
      const offsetSec = startAt - this.playStartTime
      const delayMs = Math.max(0, (startAt - now) * 1000)
      const timerId = window.setTimeout(() => {
        try {
          // stop() 后会把 onChunkStart 置空，这里二次检查避免“幽灵回调”
          if (!this.onChunkStart) return
          onChunkStart({ offsetSec, durationSec: audioBuffer.duration })
        } catch {
          // ignore
        }
      }, delayMs)
      this.chunkStartTimers.push(timerId)
    }

    if (!this.firstPlayFired) {
      this.firstPlayFired = true
      if (this.onFirstPlay) this.onFirstPlay()
    }

    this.nextPlayTime += audioBuffer.duration

    this.activeSources.push(src)
    src.onended = () => {
      // best-effort cleanup
      this.activeSources = this.activeSources.filter((s) => s !== src)
      if (this.activeSources.length === 0) {
        this.nextPlayTime = 0
        this.playStartTime = null
        if (this.streamDone && this.onEnded) {
          const onEnded = this.onEnded
          this.onEnded = null
          onEnded()
        }
      }
    }
  }

  getLevel(): number {
    const analyser = this.analyser
    const ctx = this.audioContext
    if (!analyser || !ctx) return 0
    if (!this.timeDomainBuffer || this.timeDomainBuffer.length !== analyser.fftSize) {
      this.timeDomainBuffer = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    }
    analyser.getByteTimeDomainData(this.timeDomainBuffer)
    let sum = 0
    for (let i = 0; i < this.timeDomainBuffer.length; i++) {
      const v = (this.timeDomainBuffer[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / this.timeDomainBuffer.length)
    return clampNumber(rms, 0, 1)
  }

  hasActiveAudio(): boolean {
    return this.activeSources.length > 0
  }

  async speak(
    text: string,
    settings: TtsSettings,
    callbacks?: {
      onFirstPlay?: () => void
      onChunkStart?: (payload: { offsetSec: number; durationSec: number }) => void
      onEnded?: () => void
    },
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!settings.enabled) return

    this.stop()
    this.streamDone = false
    this.firstPlayFired = false
    this.onFirstPlay = callbacks?.onFirstPlay ?? null
    this.onChunkStart = callbacks?.onChunkStart ?? null
    this.onEnded = callbacks?.onEnded ?? null

    const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
    if (!baseUrl) return
    if (!settings.refAudioPath.trim()) throw new Error('请先选择参考音频')
    if (!settings.promptText.trim()) throw new Error('请先填写参考音频文本')

    await this.ensureAudioContext()
    this.abortController = new AbortController()
    await this.ensureWeights(settings)

    const req = {
      text: trimmed,
      text_lang: 'zh',
      ref_audio_path: settings.refAudioPath.trim(),
      prompt_lang: 'zh',
      prompt_text: settings.promptText.trim(),
      text_split_method: 'cut5',
      speed_factor: clampNumber(settings.speedFactor, 0.5, 2.0),
      // GPT-SoVITS 的 fragment_interval 会在每个分段后追加静音（秒），用于实现“分句停顿”
      ...(settings.segmented
        ? { fragment_interval: Math.max(0.01, Math.min(60, clampNumber(settings.pauseMs, 0, 60000) / 1000)) }
        : {}),
      streaming_mode: settings.streaming,
      media_type: 'wav',
    }

    // 通过主进程代理请求本地 TTS 服务，避免 renderer 直接 fetch 引发 CORS/预检导致的 Failed to fetch
    const api = getApi()

    // streaming_mode=true 时，优先走主进程流式转发，才能做到“边生成边播放”
    if (
      settings.streaming &&
      api?.ttsHttpStreamStart &&
      api?.ttsHttpStreamCancel &&
      api?.onTtsHttpStreamChunk &&
      api?.onTtsHttpStreamDone &&
      api?.onTtsHttpStreamError
    ) {
      const ctx = await this.ensureAudioContext()

      const queue: Uint8Array[] = []
      let streamEnded = false
      let streamError: string | null = null
      let wake: (() => void) | null = null
      const notify = () => {
        if (!wake) return
        const w = wake
        wake = null
        w()
      }

      const { streamId } = await api.ttsHttpStreamStart({
        url: `${baseUrl}/tts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        timeoutMs: 180000,
      })
      this.activeHttpStreamId = streamId

      const unsubChunk = api.onTtsHttpStreamChunk((payload) => {
        if (payload.streamId !== streamId) return
        queue.push(payload.chunk)
        notify()
      })
      const unsubDone = api.onTtsHttpStreamDone((payload) => {
        if (payload.streamId !== streamId) return
        streamEnded = true
        notify()
      })
      const unsubError = api.onTtsHttpStreamError((payload) => {
        if (payload.streamId !== streamId) return
        const msg =
          payload.error ||
          (typeof payload.status === 'number'
            ? `HTTP ${payload.status}${payload.statusText ? `: ${payload.statusText}` : ''}`
            : '') ||
          'TTS stream error'
        streamError = msg
        streamEnded = true
        notify()
      })
      this.streamUnsubscribers.push(unsubChunk, unsubDone, unsubError)

      let headerReceived = false
      let wavHeader: Uint8Array<ArrayBufferLike> | null = null
      let audioDataBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
      let chunkSize = 32000

      try {
        for (;;) {
          if (this.abortController?.signal.aborted) break

          if (queue.length === 0) {
            if (streamEnded) break
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            continue
          }

          const value = queue.shift()
          if (!value) continue
          audioDataBuffer = concatUint8(audioDataBuffer, value)

          if (!headerReceived && audioDataBuffer.length >= 44) {
            const maybeHeader = audioDataBuffer.slice(0, 44)
            if (isWavHeader(maybeHeader)) {
              wavHeader = maybeHeader
              audioDataBuffer = audioDataBuffer.slice(44)
              headerReceived = true
              const byteRate = getWavByteRate(maybeHeader)
              chunkSize = Math.max(4096, Math.floor(byteRate * 0.5))
            }
          }

          while (headerReceived && wavHeader && audioDataBuffer.length >= chunkSize) {
            const chunk = audioDataBuffer.slice(0, chunkSize)
            audioDataBuffer = audioDataBuffer.slice(chunkSize)

            const wavData = createWavFromChunk(wavHeader, chunk)
            try {
              const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(wavData))
              this.playDecodedBuffer(audioBuffer)
            } catch {
              // ignore chunk decode failures
            }
          }
        }

        this.streamDone = true

        if (headerReceived && wavHeader && audioDataBuffer.length > 0) {
          const wavData = createWavFromChunk(wavHeader, audioDataBuffer)
          try {
            const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(wavData))
            this.playDecodedBuffer(audioBuffer)
          } catch {
            // ignore
          }
        } else if (!headerReceived && audioDataBuffer.length > 0) {
          // 兜底：如果没有识别到 wav header，就尝试把整包当成音频解码
          try {
            const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(audioDataBuffer))
            this.playDecodedBuffer(audioBuffer)
          } catch {
            // ignore
          }
        }

        if (!this.abortController?.signal.aborted && streamError) {
          throw new Error(formatTtsRequestError(baseUrl, streamError))
        }
        return
      } finally {
        if (this.activeHttpStreamId === streamId) this.activeHttpStreamId = null
        for (const unsub of this.streamUnsubscribers) {
          try {
            unsub()
          } catch {
            // ignore
          }
        }
        this.streamUnsubscribers = []
        void api.ttsHttpStreamCancel(streamId).catch(() => undefined)
      }
    }

    if (api?.ttsHttpRequestArrayBuffer) {
      const proxyRes = await api.ttsHttpRequestArrayBuffer({
        url: `${baseUrl}/tts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        timeoutMs: 180000,
      })

      if (!proxyRes.ok) {
        let msg = proxyRes.error || `HTTP ${proxyRes.status}`
        if ((proxyRes.contentType || '').includes('application/json') && proxyRes.arrayBuffer.byteLength > 0) {
          try {
            const text = new TextDecoder('utf-8').decode(new Uint8Array(proxyRes.arrayBuffer))
            const data = JSON.parse(text) as { message?: string }
            if (data?.message) msg = data.message
          } catch {
            // ignore
          }
        }
        throw new Error(formatTtsRequestError(baseUrl, msg))
      }

      const ctx = await this.ensureAudioContext()
      const raw = new Uint8Array(proxyRes.arrayBuffer)
      let decoded: AudioBuffer | null = null

      // streaming_mode=true 时，返回的 wav header 可能没有正确的 data size；这里重新封装一次以提高兼容性
      if (raw.length >= 44) {
        const header = raw.slice(0, 44)
        const body = raw.slice(44)
        if (isWavHeader(header)) {
          try {
            const wavData = createWavFromChunk(header, body)
            decoded = await ctx.decodeAudioData(toArrayBuffer(wavData))
          } catch {
            decoded = null
          }
        }
      }

      if (!decoded) {
        decoded = await ctx.decodeAudioData(proxyRes.arrayBuffer.slice(0))
      }

      this.playDecodedBuffer(decoded)
      this.streamDone = true
      return
    }

    if (!settings.streaming) {
      const res = await fetch(`${baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: this.abortController.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(formatTtsRequestError(baseUrl, (data as { message?: string })?.message || `HTTP ${res.status}`))
      }
      const ctx = await this.ensureAudioContext()
      const buf = await res.arrayBuffer()
      const audioBuffer = await ctx.decodeAudioData(buf.slice(0))
      this.playDecodedBuffer(audioBuffer)
      this.streamDone = true
      return
    }

    const res = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: this.abortController.signal,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(formatTtsRequestError(baseUrl, (data as { message?: string })?.message || `HTTP ${res.status}`))
    }
    if (!res.body) throw new Error(formatTtsRequestError(baseUrl, 'TTS 响应无数据流（response.body 不存在）'))

    const ctx = await this.ensureAudioContext()
    const reader = res.body.getReader()

    let headerReceived = false
    let wavHeader: Uint8Array<ArrayBufferLike> | null = null
    let audioDataBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    let chunkSize = 32000


    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      audioDataBuffer = concatUint8(audioDataBuffer, value)

      if (!headerReceived && audioDataBuffer.length >= 44) {
        const maybeHeader = audioDataBuffer.slice(0, 44)
        if (isWavHeader(maybeHeader)) {
          wavHeader = maybeHeader
          audioDataBuffer = audioDataBuffer.slice(44)
          headerReceived = true
          const byteRate = getWavByteRate(maybeHeader)
          chunkSize = Math.max(4096, Math.floor(byteRate * 0.5))
        }
      }

      while (headerReceived && wavHeader && audioDataBuffer.length >= chunkSize) {
        const chunk = audioDataBuffer.slice(0, chunkSize)
        audioDataBuffer = audioDataBuffer.slice(chunkSize)

        const wavData = createWavFromChunk(wavHeader, chunk)
        try {
          const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(wavData))
          this.playDecodedBuffer(audioBuffer)
        } catch {
          // ignore chunk decode failures
        }
      }
    }

    this.streamDone = true

    if (headerReceived && wavHeader && audioDataBuffer.length > 0) {
      const wavData = createWavFromChunk(wavHeader, audioDataBuffer)
      try {
        const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(wavData))
        this.playDecodedBuffer(audioBuffer)
      } catch {
        // ignore
      }
    }
  }
}
