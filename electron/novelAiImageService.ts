import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { NovelAISettings } from './types'

const DEFAULT_ENDPOINT = 'https://image.novelai.net/ai/generate-image'
const DEFAULT_CLOUD_QUEUE_URL = 'https://st-chatu-novelai-queue.hf.space'
const MAX_PROMPT_CHARS = 12000
const MAX_NEGATIVE_PROMPT_CHARS = 8000

type JsonRecord = Record<string, unknown>

type NovelAIResponseImage = {
  image?: unknown
  index?: unknown
  seed?: unknown
}

type NovelAICloudQueueTicket = {
  enabled: true
  baseUrl: string
  keyHash: string
  userId: string
  taskId: string
  lockToken: string
  waitMs: number
  queueSize: number
  position: number
}

type NovelAICloudQueueSummary = {
  enabled: boolean
  baseUrl?: string
  waitMs?: number
  queueSize?: number
  position?: number
}

export type NovelAIGenerateImageArgs = {
  settings: NovelAISettings
  userDataDir: string
  taskId: string
  prompt: string
  overrides?: JsonRecord | null
  signal?: AbortSignal
}

export type NovelAIGeneratedImage = {
  path: string
  mimeType: string
  bytes: number
  index: number
  seed?: number
}

export type NovelAIGenerateImageResult = {
  ok: true
  createdAt: string
  endpoint: string
  model: string
  prompt: string
  negativePrompt: string
  promptUsage: {
    positiveCurrent: number
    positiveFixed: number
    positiveTotal: number
    negativeCurrent: number
    negativeFixed: number
    negativeTotal: number
    maxPromptChars: number
    overLimit: boolean
  }
  parameters: {
    width: number
    height: number
    steps: number
    sampler: string
    scale: number
    cfgRescale: number
    nSamples: number
    seed: number | null
    noiseSchedule: string
    qualityToggle: boolean
  }
  count: number
  cloudQueue?: NovelAICloudQueueSummary
  paths: string[]
  images: NovelAIGeneratedImage[]
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(clampNumber(value, fallback, min, max))
}

function clampText(value: unknown, fallback: string, maxChars: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  const text = raw.trim()
  return (text || fallback).slice(0, maxChars)
}

function joinPromptParts(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(', ')
}

function countPromptChars(value: string): number {
  const text = value.trim()
  if (!text) return 0
  let asciiChars = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) asciiChars += 1
  }
  const nonAsciiChars = text.length - asciiChars
  return Math.ceil(asciiChars / 3.31 + nonAsciiChars)
}

function normalizeDimension(value: unknown, fallback: number): number {
  const raw = clampInt(value, fallback, 64, 4096)
  return Math.max(64, Math.min(4096, Math.round(raw / 64) * 64))
}

function isSubPathOf(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath)
  if (!rel) return true
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  return true
}

function resolveOutputDir(rawValue: unknown, userDataDir: string): string {
  const userDataRoot = path.resolve(userDataDir)
  const raw = clampText(rawValue, 'generated-images', 240).replace(/^[/\\]+/, '')
  const target = path.resolve(path.join(userDataRoot, raw || 'generated-images'))
  if (!isSubPathOf(userDataRoot, target)) {
    throw new Error('NovelAI outputDir must stay inside app userData')
  }
  return target
}

function normalizeAuthorizationHeader(apiKey: string): string {
  const token = apiKey.trim()
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`
}

function sanitizeCorrelationId(): string {
  return randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'NDP001'
}

function sanitizeTaskId(taskId: string): string {
  return String(taskId ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'task'
}

function isJsonSafeValue(value: unknown, depth = 0): boolean {
  if (depth > 6) return false
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(value)) return value.length <= 200 && value.every((x) => isJsonSafeValue(x, depth + 1))
  if (t === 'object') {
    const obj = value as JsonRecord
    const entries = Object.entries(obj)
    return entries.length <= 200 && entries.every(([k, v]) => k.length <= 120 && isJsonSafeValue(v, depth + 1))
  }
  return false
}

function sanitizeExtraParams(value: unknown): JsonRecord {
  const obj = asRecord(value)
  if (!obj) return {}
  const out: JsonRecord = {}
  for (const [key, val] of Object.entries(obj)) {
    const cleanedKey = key.trim()
    if (!/^[a-zA-Z0-9_]+$/.test(cleanedKey)) continue
    if (!isJsonSafeValue(val)) continue
    out[cleanedKey] = val
  }
  return out
}

function buildV4Condition(prompt: string, negative = false): JsonRecord {
  return {
    caption: {
      base_caption: prompt,
      char_captions: [],
    },
    ...(negative ? { legacy_uc: false } : {}),
    use_coords: false,
    use_order: true,
  }
}

function inferMimeAndExt(buf: Buffer): { mimeType: string; ext: string } {
  if (buf.length >= 12 && buf.subarray(0, 4).toString('hex') === '89504e47') {
    return { mimeType: 'image/png', ext: '.png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: '.jpg' }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', ext: '.webp' }
  }
  return { mimeType: 'image/png', ext: '.png' }
}

function decodeBase64Image(value: unknown): Buffer {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new Error('NovelAI response image is empty')
  const base64 = raw.replace(/^data:image\/[^;,]+;base64,/i, '').replace(/\s+/g, '')
  const buf = Buffer.from(base64, 'base64')
  if (!buf.length) throw new Error('NovelAI response image decode failed')
  return buf
}

function extractResponseImages(json: unknown): NovelAIResponseImage[] {
  if (Array.isArray(json)) return json.filter((x): x is NovelAIResponseImage => Boolean(asRecord(x)))
  const obj = asRecord(json)
  const images = obj?.images
  if (Array.isArray(images)) return images.filter((x): x is NovelAIResponseImage => Boolean(asRecord(x)))
  return []
}

function extractApiError(json: unknown, fallback: string): string {
  const obj = asRecord(json)
  if (!obj) return fallback
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim()
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error.trim()
  const err = asRecord(obj.error)
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim()
  return fallback
}

function parseJsonOrNull(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeCloudQueueUrl(value: unknown): string {
  const raw = clampText(value, DEFAULT_CLOUD_QUEUE_URL, 2048).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(raw)) throw new Error('NovelAI cloud queue URL must be an http(s) URL')
  return raw
}

function deriveCloudQueueUserId(settings: NovelAISettings, userDataDir: string): string {
  const configured = String(settings.cloudQueueUserId ?? '').trim()
  if (configured) return configured.slice(0, 120)
  return `ndp_${sha256Hex(path.resolve(userDataDir)).slice(0, 16)}`
}

function createCloudQueueTaskId(taskId: string): string {
  return `${sanitizeTaskId(taskId)}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  if (delay <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      done = true
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    const onAbort = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readQueueJson(res: Response, fallback: string): Promise<JsonRecord> {
  const text = await res.text().catch(() => '')
  const json = parseJsonOrNull(text)
  if (!res.ok) {
    throw new Error(extractApiError(json, `${fallback} HTTP ${res.status}`))
  }
  return asRecord(json) ?? {}
}

async function queuePost(baseUrl: string, pathname: string, body: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readQueueJson(res, `NovelAI cloud queue ${pathname}`)
}

async function queueGet(baseUrl: string, pathname: string, params: Record<string, string>, signal?: AbortSignal): Promise<JsonRecord> {
  const url = new URL(`${baseUrl}${pathname}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const res = await fetch(url, { method: 'GET', signal, headers: { Accept: 'application/json' } })
  return readQueueJson(res, `NovelAI cloud queue ${pathname}`)
}

async function releaseCloudQueue(ticket: NovelAICloudQueueTicket, mode: 'complete' | 'leave'): Promise<void> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    await queuePost(
      ticket.baseUrl,
      mode === 'complete' ? '/complete' : '/leave-queue',
      {
        key_hash: ticket.keyHash,
        user_id: ticket.userId,
        task_id: ticket.taskId,
        lock_token: ticket.lockToken,
      },
      ac.signal,
    ).catch(() => undefined)
  } finally {
    clearTimeout(timer)
  }
}

async function acquireCloudQueueTicket(args: {
  settings: NovelAISettings
  overrides: JsonRecord
  apiKey: string
  userDataDir: string
  taskId: string
  signal?: AbortSignal
}): Promise<NovelAICloudQueueTicket | null> {
  const enabled =
    typeof args.overrides.cloudQueueEnabled === 'boolean'
      ? args.overrides.cloudQueueEnabled
      : args.settings.cloudQueueEnabled === true
  if (!enabled) return null

  const baseUrl = normalizeCloudQueueUrl(args.overrides.cloudQueueUrl ?? args.settings.cloudQueueUrl)
  const keyHash = sha256Hex(args.apiKey.trim())
  const userId = clampText(args.overrides.cloudQueueUserId, deriveCloudQueueUserId(args.settings, args.userDataDir), 120)
  const taskId = createCloudQueueTaskId(args.taskId)
  const greeting = clampText(args.overrides.cloudQueueGreeting, args.settings.cloudQueueGreeting ?? '', 15)
  const pollIntervalMs = clampInt(args.overrides.cloudQueuePollIntervalMs, args.settings.cloudQueuePollIntervalMs, 500, 10000)
  const timeoutMs = clampInt(args.overrides.cloudQueueTimeoutMs, args.settings.cloudQueueTimeoutMs, 15000, 1800000)
  const startedAt = Date.now()
  let lockToken = ''
  let queueSize = 0
  let position = 0

  const releaseBeforeThrow = async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      await queuePost(
        baseUrl,
        '/leave-queue',
        { key_hash: keyHash, user_id: userId, task_id: taskId, ...(lockToken ? { lock_token: lockToken } : {}) },
        ac.signal,
      ).catch(() => undefined)
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const joined = await queuePost(
      baseUrl,
      '/join-queue',
      { key_hash: keyHash, user_id: userId, task_id: taskId, ...(greeting ? { greeting } : {}) },
      args.signal,
    )
    lockToken = typeof joined.lock_token === 'string' ? joined.lock_token : ''
    queueSize = Math.trunc(readNumber(joined.queue_size, 0))
    position = Math.trunc(readNumber(joined.position, 0))

    while (!lockToken) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('NovelAI cloud queue timeout')
      await sleepWithAbort(pollIntervalMs, args.signal)
      const turn = await queueGet(baseUrl, '/my-turn', { key_hash: keyHash, user_id: userId, task_id: taskId }, args.signal)
      queueSize = Math.trunc(readNumber(turn.queue_size, queueSize))
      position = Math.trunc(readNumber(turn.position, position))
      if (turn.is_my_turn === true && typeof turn.lock_token === 'string' && turn.lock_token) {
        lockToken = turn.lock_token
      }
    }

    return {
      enabled: true,
      baseUrl,
      keyHash,
      userId,
      taskId,
      lockToken,
      waitMs: Date.now() - startedAt,
      queueSize,
      position,
    }
  } catch (err) {
    await releaseBeforeThrow()
    throw err
  }
}

function isConcurrentGenerationLocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /concurrent generation/i.test(msg) || /generation is locked/i.test(msg)
}

export async function generateNovelAIImages(args: NovelAIGenerateImageArgs): Promise<NovelAIGenerateImageResult> {
  const settings = args.settings
  const overrides = args.overrides ?? {}
  if (settings.enabled !== true) throw new Error('NovelAI image generation is not enabled in settings')

  const apiKey = clampText(overrides.apiKey, settings.apiKey, 4096)
  if (!apiKey) throw new Error('NovelAI API key is not configured')

  const endpoint = clampText(overrides.endpoint, settings.endpoint || DEFAULT_ENDPOINT, 2048)
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('NovelAI endpoint must be an http(s) URL')

  const currentPrompt = clampText(args.prompt, '', MAX_PROMPT_CHARS)
  if (!currentPrompt) throw new Error('image.generate requires prompt')

  const requestedPresetId = typeof overrides.promptPresetId === 'string' ? overrides.promptPresetId.trim() : ''
  const promptPreset = requestedPresetId ? settings.promptPresets.find((preset) => preset.id === requestedPresetId) : undefined
  const presetFixedPositive = promptPreset?.fixedPositivePrompt ?? settings.fixedPositivePrompt
  const presetFixedNegative = promptPreset?.fixedNegativePrompt ?? settings.fixedNegativePrompt
  const fixedPositivePrompt = clampText(overrides.fixedPositivePrompt, presetFixedPositive ?? '', 6000)
  const fixedNegativePrompt = clampText(overrides.fixedNegativePrompt, presetFixedNegative ?? '', 6000)
  const currentNegativePrompt = clampText(overrides.negativePrompt, settings.negativePrompt, MAX_NEGATIVE_PROMPT_CHARS)
  const prompt = clampText(joinPromptParts(fixedPositivePrompt, currentPrompt), '', MAX_PROMPT_CHARS)
  const negativePrompt = clampText(joinPromptParts(fixedNegativePrompt, currentNegativePrompt), '', MAX_NEGATIVE_PROMPT_CHARS)
  const maxPromptChars = clampInt(overrides.maxPromptChars, promptPreset?.maxPromptChars ?? settings.maxPromptChars, 128, 12000)
  const promptUsage = {
    positiveCurrent: countPromptChars(currentPrompt),
    positiveFixed: countPromptChars(fixedPositivePrompt),
    positiveTotal: countPromptChars(prompt),
    negativeCurrent: countPromptChars(currentNegativePrompt),
    negativeFixed: countPromptChars(fixedNegativePrompt),
    negativeTotal: countPromptChars(negativePrompt),
    maxPromptChars,
    overLimit: countPromptChars(prompt) > maxPromptChars || countPromptChars(negativePrompt) > maxPromptChars,
  }
  const model = clampText(overrides.model, settings.model, 160)
  const sampler = clampText(overrides.sampler, settings.sampler, 120)
  const noiseSchedule = clampText(overrides.noiseSchedule, settings.noiseSchedule, 80)
  const width = normalizeDimension(overrides.width, settings.width)
  const height = normalizeDimension(overrides.height, settings.height)
  const steps = clampInt(overrides.steps, settings.steps, 1, 80)
  const scale = clampNumber(overrides.scale, settings.scale, 0, 30)
  const cfgRescale = clampNumber(overrides.cfgRescale, settings.cfgRescale, 0, 1)
  const nSamples = clampInt(overrides.nSamples, settings.nSamples, 1, 8)
  const seed = clampInt(overrides.seed, settings.seed, -1, 4294967295)
  const qualityToggle =
    typeof overrides.qualityToggle === 'boolean' ? overrides.qualityToggle : settings.qualityToggle !== false
  const outputDir = resolveOutputDir(overrides.outputDir, args.userDataDir)

  const parameters: JsonRecord = {
    width,
    height,
    scale,
    sampler,
    steps,
    n_samples: nSamples,
    ucPreset: 0,
    qualityToggle,
    cfg_rescale: cfgRescale,
    noise_schedule: noiseSchedule,
    image_format: 'png',
    prompt,
    negative_prompt: negativePrompt,
  }
  if (seed >= 0) parameters.seed = seed
  if (/nai-diffusion-(?:4|4-5)/i.test(model)) {
    parameters.v4_prompt = buildV4Condition(prompt)
    parameters.v4_negative_prompt = buildV4Condition(negativePrompt, true)
  }
  Object.assign(parameters, sanitizeExtraParams(overrides.extraParams))

  const body = {
    action: 'generate',
    input: prompt,
    model,
    parameters,
  }

  const requestNovelAI = async (): Promise<NovelAIResponseImage[]> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: args.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: normalizeAuthorizationHeader(apiKey),
        'x-correlation-id': sanitizeCorrelationId(),
      },
      body: JSON.stringify(body),
    })

    const text = await res.text()
    const json = parseJsonOrNull(text)
    if (!res.ok) {
      throw new Error(extractApiError(json, `NovelAI image API HTTP ${res.status}`))
    }

    const images = extractResponseImages(json)
    if (images.length === 0) {
      const type = res.headers.get('content-type') || 'unknown'
      throw new Error(`NovelAI returned no JSON images (content-type: ${type})`)
    }
    return images
  }

  let responseImages: NovelAIResponseImage[] = []
  let cloudQueue: NovelAICloudQueueSummary | undefined
  const queueEnabled =
    typeof overrides.cloudQueueEnabled === 'boolean' ? overrides.cloudQueueEnabled : settings.cloudQueueEnabled === true
  const maxAttempts = queueEnabled ? 2 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ticket = await acquireCloudQueueTicket({
      settings,
      overrides,
      apiKey,
      userDataDir: args.userDataDir,
      taskId: args.taskId,
      signal: args.signal,
    })
    if (ticket) {
      cloudQueue = {
        enabled: true,
        baseUrl: ticket.baseUrl,
        waitMs: ticket.waitMs,
        queueSize: ticket.queueSize,
        position: ticket.position,
      }
    } else if (queueEnabled) {
      cloudQueue = { enabled: false }
    }

    let releaseMode: 'complete' | 'leave' = 'leave'
    let completed = false
    let retryAfterConcurrentLock = false
    try {
      responseImages = await requestNovelAI()
      releaseMode = 'complete'
      completed = true
    } catch (err) {
      if (!isConcurrentGenerationLocked(err)) releaseMode = 'complete'
      if (ticket && attempt + 1 < maxAttempts && isConcurrentGenerationLocked(err)) {
        retryAfterConcurrentLock = true
      } else {
        throw err
      }
    } finally {
      if (ticket) await releaseCloudQueue(ticket, releaseMode)
    }

    if (completed) break
    if (retryAfterConcurrentLock) {
      await sleepWithAbort(15000, args.signal)
      continue
    }
  }

  await fs.mkdir(outputDir, { recursive: true })
  const safeTaskId = sanitizeTaskId(args.taskId)
  const images: NovelAIGeneratedImage[] = []
  for (const [pos, image] of responseImages.entries()) {
    const buf = decodeBase64Image(image.image)
    const { mimeType, ext } = inferMimeAndExt(buf)
    const index = typeof image.index === 'number' && Number.isFinite(image.index) ? Math.trunc(image.index) : pos
    const seedValue = typeof image.seed === 'number' && Number.isFinite(image.seed) ? Math.trunc(image.seed) : undefined
    const filePath = path.join(outputDir, `novelai-${safeTaskId}-${Date.now()}-${index}-${randomUUID().slice(0, 8)}${ext}`)
    await fs.writeFile(filePath, buf)
    images.push({
      path: filePath,
      mimeType,
      bytes: buf.length,
      index,
      ...(seedValue !== undefined ? { seed: seedValue } : {}),
    })
  }

  return {
    ok: true,
    createdAt: new Date().toISOString(),
    endpoint,
    model,
    prompt,
    negativePrompt,
    promptUsage,
    parameters: {
      width,
      height,
      steps,
      sampler,
      scale,
      cfgRescale,
      nSamples,
      seed: seed >= 0 ? seed : null,
      noiseSchedule,
      qualityToggle,
    },
    count: images.length,
    ...(cloudQueue ? { cloudQueue } : {}),
    paths: images.map((it) => it.path),
    images,
  }
}
