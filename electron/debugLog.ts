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
    ensureDir(path.dirname(logFilePath))
    fs.writeFileSync(logFilePath, '', 'utf-8')
  } catch {
    // ignore
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

  const entry: DebugLogEntry = {
    ts,
    pid: process.pid,
    scope: scopeKey,
    event: String(event ?? '').trim() || 'unknown',
    data,
  }

  try {
    ensureDir(path.dirname(logFilePath))
    fs.appendFileSync(logFilePath, safeJsonStringify(entry) + '\n', 'utf-8')
  } catch {
    // ignore
  }
}
