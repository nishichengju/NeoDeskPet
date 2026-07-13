import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { localMediaTypeFromPath } from '../localMediaRegistry'
import { isPathWithinRoot } from '../localMediaPolicy'
import type { ToolInput } from '../toolExecutor'
import type { TaskRecord } from '../types'

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
const MIN_CHILD_TIMEOUT_MS = 5_000

export type TaskMmvectorVideoQaExecution = {
  output: string
}

export type TaskMmvectorVideoQaContext = {
  task: TaskRecord
  waitIfPaused: () => Promise<void>
  isCanceled: () => boolean
  setCancelCurrent: (cancel: (() => void) | undefined) => void
  executeTool: (toolName: string, input: ToolInput) => Promise<TaskMmvectorVideoQaExecution>
}

export type TaskMmvectorVideoQaOptions = {
  userDataDir: string
  maxVideoBytes?: number
  now?: () => number
  createId?: () => string
  fetchImpl?: typeof fetch
}

type MmvectorResult = {
  id?: number
  type?: string
  score?: number
  filename?: string
  videoUrl?: string
  videoPath?: string
}

export class TaskMmvectorVideoQaWorkflow {
  private readonly userDataDir: string
  private readonly maxVideoBytes: number
  private readonly now: () => number
  private readonly createId: () => string
  private readonly fetchImpl: typeof fetch

  constructor(options: TaskMmvectorVideoQaOptions) {
    this.userDataDir = options.userDataDir
    this.maxVideoBytes = positiveInt(options.maxVideoBytes, DEFAULT_MAX_VIDEO_BYTES)
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async run(input: ToolInput, context: TaskMmvectorVideoQaContext): Promise<string> {
    const options = normalizeWorkflowInput(input)
    const startedAt = this.now()
    const deadline = startedAt + options.timeoutMs
    const ensureActive = () => {
      if (context.isCanceled()) throw new Error('任务已取消')
      if (this.now() >= deadline) throw new Error('workflow.mmvector_video_qa timeout')
    }
    const checkpoint = async () => {
      ensureActive()
      await context.waitIfPaused()
      ensureActive()
    }
    const remainingMs = (minimum = 1) => {
      ensureActive()
      const remaining = Math.trunc(deadline - this.now())
      if (remaining < minimum) throw new Error('workflow.mmvector_video_qa timeout')
      return remaining
    }

    await checkpoint()
    const search = await context.executeTool('mcp.mmvector.search_by_text', {
      query: options.searchQuery,
      topK: options.topK,
      filter: 'video',
      ...(typeof options.minScore === 'number' ? { minScore: options.minScore } : {}),
    })
    ensureActive()

    const parsed = parseJsonFromText(search.output)
    const resultsUnknown = parsed && parsed.ok === true && Array.isArray(parsed.results) ? (parsed.results as unknown[]) : []
    const results = resultsUnknown
      .map((result) => (result && typeof result === 'object' && !Array.isArray(result) ? (result as MmvectorResult) : null))
      .filter((result): result is MmvectorResult => Boolean(result))
    const picked =
      results.find((result) => typeof result.videoPath === 'string' && result.videoPath.trim()) ??
      results.find((result) => typeof result.videoUrl === 'string' && result.videoUrl.trim()) ??
      null
    if (!picked) {
      return clampText(
        JSON.stringify({
          ok: false,
          error: 'mmvector 未命中任何视频',
          searchQuery: options.searchQuery,
          tool: 'mcp.mmvector.search_by_text',
          raw: search.output,
        }),
        5000,
      )
    }

    await checkpoint()
    const cacheDir = path.join(this.userDataDir, 'video-qa-cache')
    await fs.promises.mkdir(cacheDir, { recursive: true })
    const localVideoPath = await this.materializeVideo(picked, cacheDir, remainingMs(), context)

    await checkpoint()
    const childTimeoutMs = Math.min(600_000, remainingMs(MIN_CHILD_TIMEOUT_MS))
    const qa = await context.executeTool('media.video_qa', {
      videoPath: localVideoPath,
      question: options.question,
      segmentSeconds: options.segmentSeconds,
      framesPerSegment: options.framesPerSegment,
      maxSegments: options.maxSegments,
      startSeconds: options.startSeconds,
      timeoutMs: childTimeoutMs,
      ...options.providerOverrides,
    })
    ensureActive()

    const rawVideoPath = typeof picked.videoPath === 'string' ? picked.videoPath.trim() : ''
    const rawVideoUrl = typeof picked.videoUrl === 'string' ? picked.videoUrl.trim() : ''
    const output = {
      ok: true,
      search: {
        query: options.searchQuery,
        picked: {
          id: picked.id,
          score: picked.score,
          filename: picked.filename,
          videoUrl: rawVideoUrl || undefined,
          videoPath: rawVideoPath || undefined,
          localVideoPath,
        },
      },
      qa: parseJsonFromText(qa.output) ?? String(qa.output ?? '').trim(),
    }
    return clampText(JSON.stringify(output, null, 2), 5000) || '(空)'
  }

  private async materializeVideo(
    picked: MmvectorResult,
    cacheDir: string,
    timeoutMs: number,
    context: TaskMmvectorVideoQaContext,
  ): Promise<string> {
    const rawVideoPath = typeof picked.videoPath === 'string' ? picked.videoPath.trim() : ''
    const rawVideoUrl = typeof picked.videoUrl === 'string' ? picked.videoUrl.trim() : ''
    if (rawVideoPath) {
      const sourcePath = path.resolve(rawVideoPath)
      const sourceStat = await fs.promises.stat(sourcePath).catch(() => null)
      if (sourceStat?.isFile()) {
        if (sourceStat.size <= 0 || sourceStat.size > this.maxVideoBytes) {
          throw new Error('mmvector videoPath 文件大小不受支持')
        }
        const realSource = await fs.promises.realpath(sourcePath)
        const sourceType = localMediaTypeFromPath(realSource)
        if (!sourceType || sourceType.kind !== 'video') throw new Error('mmvector videoPath 类型不受支持')

        const realCache = await fs.promises.realpath(cacheDir)
        const style = process.platform === 'win32' ? 'win32' : 'posix'
        if (isPathWithinRoot(realSource, realCache, style)) return realSource

        const destination = this.cacheDestination(cacheDir, picked.filename || path.basename(realSource), path.extname(realSource))
        try {
          await fs.promises.copyFile(realSource, destination, fs.constants.COPYFILE_EXCL)
          const copiedStat = await fs.promises.stat(destination)
          if (!copiedStat.isFile() || copiedStat.size <= 0 || copiedStat.size > this.maxVideoBytes) {
            throw new Error('mmvector videoPath 文件大小不受支持')
          }
          this.assertContextActive(context)
          return destination
        } catch (error) {
          await removeFailedDestination(destination, error)
          throw error
        }
      }
    }

    if (!rawVideoUrl) throw new Error(`mmvector 命中但无可用 videoPath/videoUrl：${JSON.stringify(picked)}`)
    const url = parseHttpUrl(rawVideoUrl)
    const requestedName = picked.filename?.trim() || `mmvector_${context.task.id}.mp4`
    const typedName = localMediaTypeFromPath(requestedName)?.kind === 'video' ? requestedName : `${requestedName}.mp4`
    const destination = this.cacheDestination(cacheDir, typedName, '.mp4')
    await this.downloadVideo(url, destination, timeoutMs, context)
    return destination
  }

  private cacheDestination(cacheDir: string, requestedName: string, fallbackExtension: string): string {
    const basename = path.basename(String(requestedName ?? '').trim()).replace(/[<>:"/\\|?*]+/g, '_') || 'mmvector'
    const requestedExtension = path.extname(basename).toLowerCase()
    const extension = localMediaTypeFromPath(`video${requestedExtension}`)?.kind === 'video' ? requestedExtension : fallbackExtension
    const stem = path.basename(basename, requestedExtension).slice(0, 120) || 'mmvector'
    const safeId = String(this.createId()).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || randomUUID()
    return path.join(cacheDir, `${stem}-${safeId}${extension}`)
  }

  private async downloadVideo(
    url: URL,
    destination: string,
    timeoutMs: number,
    context: TaskMmvectorVideoQaContext,
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('download timeout')), Math.max(1, timeoutMs))
    context.setCancelCurrent(() => controller.abort(new Error('canceled')))

    try {
      const response = await this.fetchImpl(url, { method: 'GET', signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('empty body')

      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > this.maxVideoBytes) {
        throw new Error('下载视频文件大小不受支持')
      }

      let receivedBytes = 0
      const maxVideoBytes = this.maxVideoBytes
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      const limitBytes = async function* (chunks: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
        for await (const chunk of chunks) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
          receivedBytes += buffer.length
          if (receivedBytes > maxVideoBytes) throw new Error('下载视频文件大小不受支持')
          yield buffer
        }
      }
      await pipeline(
        source,
        limitBytes,
        fs.createWriteStream(destination, { flags: 'wx' }),
      )
      if (receivedBytes <= 0) throw new Error('empty body')
      this.assertContextActive(context)
    } catch (error) {
      await removeFailedDestination(destination, error)
      throw error
    } finally {
      clearTimeout(timer)
      context.setCancelCurrent(undefined)
    }
  }

  private assertContextActive(context: TaskMmvectorVideoQaContext): void {
    if (context.isCanceled()) throw new Error('任务已取消')
  }
}

function normalizeWorkflowInput(input: ToolInput): {
  searchQuery: string
  question: string
  topK: number
  minScore?: number
  segmentSeconds: number
  framesPerSegment: number
  maxSegments: number
  startSeconds: number
  timeoutMs: number
  providerOverrides: Record<string, unknown>
} {
  const object = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  const searchQuery = typeof object?.searchQuery === 'string' ? object.searchQuery.trim() : typeof input === 'string' ? input.trim() : ''
  const question = typeof object?.question === 'string' ? object.question.trim() : ''
  if (!searchQuery) throw new Error('workflow.mmvector_video_qa 需要 searchQuery')
  if (!question) throw new Error('workflow.mmvector_video_qa 需要 question')

  return {
    searchQuery,
    question,
    topK: clampInt(object?.topK, 3, 1, 20),
    minScore: typeof object?.minScore === 'number' ? clampNumber(object.minScore, 0, 1) : undefined,
    segmentSeconds: clampInt(object?.segmentSeconds, 20, 5, 120),
    framesPerSegment: clampInt(object?.framesPerSegment, 3, 1, 8),
    maxSegments: clampInt(object?.maxSegments, 8, 1, 60),
    startSeconds: typeof object?.startSeconds === 'number' ? clampNumber(object.startSeconds, 0, 1e9) : 0,
    timeoutMs: clampInt(object?.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_CHILD_TIMEOUT_MS, 600_000),
    providerOverrides: {
      ...(typeof object?.baseUrl === 'string' && object.baseUrl.trim() ? { baseUrl: object.baseUrl.trim() } : {}),
      ...(typeof object?.apiKey === 'string' && object.apiKey.trim() ? { apiKey: object.apiKey.trim() } : {}),
      ...(typeof object?.model === 'string' && object.model.trim() ? { model: object.model.trim() } : {}),
      ...(typeof object?.temperature === 'number' ? { temperature: object.temperature } : {}),
      ...(typeof object?.maxTokensPerSegment === 'number' ? { maxTokensPerSegment: object.maxTokensPerSegment } : {}),
      ...(typeof object?.maxTokensFinal === 'number' ? { maxTokensFinal: object.maxTokensFinal } : {}),
    },
  }
}

function parseJsonFromText(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('mmvector videoUrl 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('mmvector videoUrl 仅支持 HTTP(S)')
  return url
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(1, number)
}

async function removeFailedDestination(destination: string, error: unknown): Promise<void> {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return
  await fs.promises.rm(destination, { force: true }).catch(() => undefined)
}
