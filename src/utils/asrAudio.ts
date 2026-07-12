// ASR 音频采集与文本本地规则处理（自 App.tsx 拆出，纯函数）

import type {
  AppSettings,
} from '../../electron/types'

export function clampPcmFloat(v: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0))
}

export function floatToPcm16(v: number): number {
  const s = clampPcmFloat(v)
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

export function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length <= 0) return b
  if (b.length <= 0) return a
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function createOpenTypelessPcmSender(ws: WebSocket, inputSampleRate: number): (pcm: Float32Array) => void {
  const targetSampleRate = 16000
  let carry = new Float32Array(0)

  const sendInt16 = (source: Float32Array) => {
    if (!source.length) return
    const out = new Int16Array(source.length)
    for (let i = 0; i < source.length; i++) out[i] = floatToPcm16(source[i])
    ws.send(out.buffer)
  }

  return (pcm: Float32Array) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (!(pcm instanceof Float32Array) || pcm.length <= 0) return

    const merged = carry.length ? concatFloat32(carry, pcm) : pcm

    // OpenTypeless demo ws 默认按 16kHz / int16 PCM 读取；优先用 16k AudioContext，必要时在前端降采样兜底。
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || Math.abs(inputSampleRate - targetSampleRate) < 1) {
      carry = new Float32Array(0)
      sendInt16(merged)
      return
    }

    if (inputSampleRate < targetSampleRate) {
      carry = new Float32Array(0)
      sendInt16(merged)
      return
    }

    const ratio = inputSampleRate / targetSampleRate
    const outLen = Math.floor(merged.length / ratio)
    if (outLen <= 0) {
      carry = merged.slice()
      return
    }

    const out = new Int16Array(outLen)
    let sourceIndex = 0
    for (let i = 0; i < outLen; i++) {
      const nextSourceIndex = Math.min(merged.length, Math.max(sourceIndex + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      let count = 0
      while (sourceIndex < nextSourceIndex) {
        sum += merged[sourceIndex]
        sourceIndex += 1
        count += 1
      }
      out[i] = floatToPcm16(count > 0 ? sum / count : 0)
    }
    carry = sourceIndex < merged.length ? merged.slice(sourceIndex) : new Float32Array(0)
    ws.send(out.buffer)
  }
}

export function escapeRegExp(input: string): string {
  return String(input ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseAsrReplacementRules(raw: string): Array<[string, string]> {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*(?:=>|->|=)\s*(.*?)$/)
      if (!m) return null
      const from = String(m[1] ?? '').trim()
      const to = String(m[2] ?? '').trim()
      if (!from || !to) return null
      return [from, to] as [string, string]
    })
    .filter((x): x is [string, string] => Boolean(x))
    .sort((a, b) => b[0].length - a[0].length)
}

export function parseAsrWordList(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw ?? '')
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length)
}

export function normalizeAsrDisplayText(text: string): string {
  return String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([，。！？；：、,.!?;:])\s*/g, '$1')
    .replace(/([，。！？；：、,.!?;:]){2,}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function applyAsrLocalRules(
  text: string,
  asr: AppSettings['asr'] | undefined,
  opts?: { forInterim?: boolean },
): string {
  const raw = String(text ?? '')
  if (!raw) return ''
  if (!asr) return normalizeAsrDisplayText(raw)

  const replacements = parseAsrReplacementRules(asr.replaceRules ?? '')
  const fillerWords = parseAsrWordList(asr.fillerWords ?? '')
  const stripFillers = asr.stripFillers ?? true
  const ignoreCaseReplace = asr.ignoreCaseReplace ?? true
  const processInterim = asr.processInterim ?? false
  const forInterim = opts?.forInterim === true

  let out = raw
  for (const [from, to] of replacements) {
    const flags = ignoreCaseReplace ? 'gi' : 'g'
    out = out.replace(new RegExp(escapeRegExp(from), flags), to)
  }

  if (stripFillers && (!forInterim || processInterim)) {
    for (const word of fillerWords) {
      out = out.replace(new RegExp(escapeRegExp(word), 'g'), '')
    }
  }

  return normalizeAsrDisplayText(out)
}

export function getOpenTypelessHealthUrlFromWs(rawUrl: string): string | null {
  try {
    const u = new URL(String(rawUrl ?? '').trim())
    if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !/^\/demo\/ws\/realtime\/?$/.test(u.pathname)) return null
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/health'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

export async function waitForOpenTypelessAsrReady(rawWsUrl: string, opts?: { timeoutMs?: number }): Promise<boolean> {
  const healthUrl = getOpenTypelessHealthUrlFromWs(rawWsUrl)
  if (!healthUrl) return true

  const timeoutMs = Math.max(500, Math.trunc(opts?.timeoutMs ?? 25_000))
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const ac = new AbortController()
    const timer = window.setTimeout(() => ac.abort(), 1200)
    try {
      const res = await fetch(healthUrl, { method: 'GET', cache: 'no-store', signal: ac.signal })
      if (res.ok) return true
    } catch {
      /* ignore */
    } finally {
      window.clearTimeout(timer)
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  }

  return false
}
