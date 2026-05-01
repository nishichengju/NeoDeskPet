import * as fs from 'node:fs'
import * as path from 'node:path'

type DebugLogEntry = {
  ts: number
  pid: number
  scope: string
  event: string
  data?: unknown
}

let enabled = false
let baseDir = ''
let logFilePath = ''
let initialized = false
const lastWriteAtByScope = new Map<string, number>()
const lastWriteAtByEvent = new Map<string, number>()
const pendingLines: string[] = []
let pendingBytes = 0
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

const DEBUG_LOG_FLUSH_INTERVAL_MS = 50
const DEBUG_LOG_MAX_QUEUE_LINES = 2000
const DEBUG_LOG_MAX_QUEUE_BYTES = 2 * 1024 * 1024
const DEBUG_LOG_FILE_MAX_BYTES = 20 * 1024 * 1024
const DEBUG_LOG_ROTATE_KEEP_FILES = 3

function now(): number {
  return Date.now()
}

function clampText(raw: string, max: number): string {
  const text = String(raw ?? '')
  if (text.length <= max) return text
  return text.slice(0, max) + `…(truncated ${text.length - max})`
}

function safeJsonStringify(data: unknown): string {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, value: unknown) => {
    if (typeof value === 'string') return clampText(value, 4000)
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
    if (Array.isArray(value)) {
      if (value.length <= 60) return value
      return [...value.slice(0, 60), `…(len=${value.length})`]
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (seen.has(obj)) return '[Circular]'
      seen.add(obj)
      return obj
    }
    return String(value)
  }

  try {
    return JSON.stringify(data, replacer)
  } catch (err) {
    return JSON.stringify({ error: 'stringify_failed', message: String((err as Error)?.message ?? err) })
  }
}

function ensureDir(dir: string): void {
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
}

function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  if (!enabled) return
  ensureDir(baseDir)
  void cleanupRotatedLogFiles()
}

export function initDebugLog(opts: { userDataDir: string; enabled?: boolean; filePathOverride?: string }): void {
  const userDataDir = String(opts.userDataDir ?? '').trim()
  if (!userDataDir) {
    enabled = false
    return
  }

  const envOverride = String(process.env.NDP_DEBUG_LOG_PATH ?? '').trim()
  baseDir = path.join(userDataDir, 'debug')
  logFilePath = opts.filePathOverride?.trim() || envOverride || path.join(baseDir, 'streaming-debug.ndjson')

  const envEnabled = String(process.env.NDP_DEBUG_LOG ?? '').trim() === '1'
  const enableByDefault = typeof opts.enabled === 'boolean' ? opts.enabled : false
  enabled = envEnabled || enableByDefault
  ensureInitialized()
}

export function isDebugLogEnabled(): boolean {
  return enabled
}

export function getDebugLogPath(): string {
  ensureInitialized()
  return logFilePath
}

export function clearDebugLog(): void {
  ensureInitialized()
  if (!enabled) return
  try {
    pendingLines.length = 0
    pendingBytes = 0
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    ensureDir(path.dirname(logFilePath))
    fs.writeFileSync(logFilePath, '', 'utf-8')
    clearRotatedLogFilesSync()
  } catch {
    // ignore
  }
}

function getRotatedLogPath(index: number): string {
  return `${logFilePath}.${index}`
}

function clearRotatedLogFilesSync(): void {
  if (!logFilePath) return
  try {
    const dir = path.dirname(logFilePath)
    const baseName = path.basename(logFilePath)
    const files = fs.readdirSync(dir)
    for (const file of files) {
      if (!file.startsWith(`${baseName}.`)) continue
      const suffix = file.slice(baseName.length + 1)
      if (!/^\d+$/.test(suffix)) continue
      try {
        fs.unlinkSync(path.join(dir, file))
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function cleanupRotatedLogFiles(): Promise<void> {
  if (!logFilePath) return
  try {
    const dir = path.dirname(logFilePath)
    const baseName = path.basename(logFilePath)
    const files = await fs.promises.readdir(dir)
    const extras = files
      .filter((file) => file.startsWith(`${baseName}.`))
      .map((file) => {
        const suffix = file.slice(baseName.length + 1)
        return /^\d+$/.test(suffix) ? { file, index: Number(suffix) } : null
      })
      .filter((item): item is { file: string; index: number } => !!item)
      .filter((item) => item.index > DEBUG_LOG_ROTATE_KEEP_FILES)

    for (const item of extras) {
      try {
        await fs.promises.unlink(path.join(dir, item.file))
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function rotateLogFileIfNeeded(incomingBytes: number): Promise<void> {
  if (!logFilePath || incomingBytes <= 0) return
  if (DEBUG_LOG_FILE_MAX_BYTES <= 0 || DEBUG_LOG_ROTATE_KEEP_FILES <= 0) return

  let currentSize = 0
  try {
    currentSize = (await fs.promises.stat(logFilePath)).size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return
    return
  }

  if (currentSize + incomingBytes <= DEBUG_LOG_FILE_MAX_BYTES) return

  try {
    await fs.promises.unlink(getRotatedLogPath(DEBUG_LOG_ROTATE_KEEP_FILES))
  } catch {
    // ignore
  }

  for (let index = DEBUG_LOG_ROTATE_KEEP_FILES - 1; index >= 1; index -= 1) {
    try {
      await fs.promises.rename(getRotatedLogPath(index), getRotatedLogPath(index + 1))
    } catch {
      // ignore
    }
  }

  try {
    await fs.promises.rename(logFilePath, getRotatedLogPath(1))
  } catch {
    // ignore
  }

  await cleanupRotatedLogFiles()
}

function getEventThrottleMs(scope: string, event: string, data?: unknown): number {
  const scopeKey = String(scope ?? '').trim()
  const eventKey = String(event ?? '').trim()

  if (scopeKey === 'renderer' && eventKey === 'chat:task.blocks') {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
    const isFinal = obj?.isFinal === true
    return isFinal ? 0 : 250
  }

  return 0
}

function scheduleFlush(): void {
  if (flushTimer || flushing || !enabled || pendingLines.length === 0 || !logFilePath) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingLines()
  }, DEBUG_LOG_FLUSH_INTERVAL_MS)
  ;(flushTimer as unknown as { unref?: () => void }).unref?.()
}

async function flushPendingLines(): Promise<void> {
  if (flushing || !enabled || !logFilePath || pendingLines.length === 0) return
  flushing = true

  const chunk = pendingLines.join('')
  pendingLines.length = 0
  pendingBytes = 0

  try {
    ensureDir(path.dirname(logFilePath))
    await rotateLogFileIfNeeded(Buffer.byteLength(chunk, 'utf8'))
    await fs.promises.appendFile(logFilePath, chunk, 'utf-8')
  } catch {
    // ignore
  } finally {
    flushing = false
    if (pendingLines.length > 0) scheduleFlush()
  }
}

export function appendDebugLog(scope: string, event: string, data?: unknown): void {
  if (!enabled) return
  ensureInitialized()
  if (!logFilePath) return

  const scopeKey = String(scope ?? '').trim() || 'unknown'

  // 节流：避免极端情况下写入过密导致卡顿（默认 >= 10ms 才写一次；chatStore 不节流）
  const ts = now()
  if (scopeKey !== 'chatStore') {
    const last = lastWriteAtByScope.get(scopeKey) ?? 0
    if (ts - last < 10) return
    lastWriteAtByScope.set(scopeKey, ts)
  }

  const eventThrottleMs = getEventThrottleMs(scopeKey, event, data)
  if (eventThrottleMs > 0) {
    const eventThrottleKey = `${scopeKey}:${String(event ?? '').trim()}`
    const last = lastWriteAtByEvent.get(eventThrottleKey) ?? 0
    if (ts - last < eventThrottleMs) return
    lastWriteAtByEvent.set(eventThrottleKey, ts)
  }

  const entry: DebugLogEntry = {
    ts,
    pid: process.pid,
    scope: scopeKey,
    event: String(event ?? '').trim() || 'unknown',
    data,
  }

  try {
    const line = safeJsonStringify(entry) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')

    if (pendingLines.length >= DEBUG_LOG_MAX_QUEUE_LINES || pendingBytes + lineBytes > DEBUG_LOG_MAX_QUEUE_BYTES) {
      // 队列满时优先丢弃最旧日志，避免调试日志反过来拖垮主进程。
      while (pendingLines.length > 0 && (pendingLines.length >= DEBUG_LOG_MAX_QUEUE_LINES || pendingBytes + lineBytes > DEBUG_LOG_MAX_QUEUE_BYTES)) {
        const dropped = pendingLines.shift()
        if (typeof dropped === 'string') pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(dropped, 'utf8'))
      }
    }

    pendingLines.push(line)
    pendingBytes += lineBytes
    scheduleFlush()
  } catch {
    // ignore
  }
}
