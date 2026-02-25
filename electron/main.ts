import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { getSettings, setSettings } from './store'
import { createTray } from './tray'
import { WindowManager } from './windowManager'
import { setWindowManagerInstance } from './runtimeRefs'
import { scanLive2dModels } from './modelScanner'
import { listTtsOptions } from './ttsOptions'
import { TaskService } from './taskService'
import { setLive2dCapabilitiesFromRenderer } from './live2dToolState'
import {
  addChatMessage,
  clearChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  renameChatSession,
  setChatSessionAutoExtractCursor,
  setChatSessionAutoExtractMeta,
  setChatMessages,
  setCurrentChatSession,
  updateChatMessage,
  updateChatMessageRecord,
} from './chatStore'
import type {
  AISettings,
  AIProfile,
  AsrSettings,
  BubbleSettings,
  DisplayMode,
  OrchestratorSettings,
  OrbUiState,
  TaskPanelSettings,
  ToolSettings,
  McpSettings,
  McpStateSnapshot,
  ChatMessageRecord,
  ChatProfile,
  ChatUiSettings,
  ContextUsageSnapshot,
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  MemoryListArgs,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryListResult,
  MemoryListVersionsArgs,
  MemoryRecord,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemoryConsoleSettings,
  MemorySettings,
  MemoryUpdateArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryUpsertManualArgs,
  MemoryVersionRecord,
  Persona,
  PersonaSummary,
  TaskCreateArgs,
  TaskListResult,
  TaskRecord,
  TtsSettings,
} from './types'
import { MemoryService } from './memoryService'
import { McpManager } from './mcpManager'
import { appendDebugLog, clearDebugLog, getDebugLogPath, initDebugLog, isDebugLogEnabled } from './debugLog'

// Keep renderer active when windows are occluded to avoid audio/link throttling.
// These switches must be applied before app is ready.
try {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch (_) {
  /* ignore */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

function pickChatAttachmentExt(mimeType: string, fallback: string): string {
  const mime = (mimeType ?? '').trim().toLowerCase()
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/webm') return '.webm'
  if (mime === 'video/quicktime') return '.mov'
  if (mime === 'video/x-msvideo') return '.avi'
  if (mime === 'video/x-matroska') return '.mkv'
  return fallback
}

function pickChatAttachmentMimeByExt(filePath: string): string {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.avi') return 'video/x-msvideo'
  if (ext === '.mkv') return 'video/x-matroska'
  return 'application/octet-stream'
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const raw = (dataUrl ?? '').trim()
  if (!raw.startsWith('data:')) return null
  const idx = raw.indexOf(',')
  if (idx < 0) return null
  const meta = raw.slice(5, idx) // after "data:"
  const payload = raw.slice(idx + 1)
  const parts = meta.split(';').map((s) => s.trim())
  const mimeType = parts[0] ?? ''
  const isBase64 = parts.includes('base64')
  if (!isBase64) return null
  if (!mimeType) return null
  if (!payload) return null
  return { mimeType, base64: payload }
}

function normalizeOpenAiBaseUrl(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  return value.replace(/\/+$/, '')
}

function extractModelIdsFromResponse(payload: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    const id = String(value ?? '').trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }

  const root = payload as Record<string, unknown> | null
  const data = Array.isArray(root?.data) ? root?.data : []
  for (const item of data) {
    if (typeof item === 'string') {
      add(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    add((item as Record<string, unknown>).id)
    add((item as Record<string, unknown>).model)
    add((item as Record<string, unknown>).name)
  }

  const models = Array.isArray(root?.models) ? root?.models : []
  for (const item of models) {
    if (typeof item === 'string') {
      add(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    add((item as Record<string, unknown>).id)
    add((item as Record<string, unknown>).model)
    add((item as Record<string, unknown>).name)
  }

  return out.slice(0, 200)
}
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const windowManager = new WindowManager({
  rendererDevUrl: VITE_DEV_SERVER_URL,
  rendererDistDir: RENDERER_DIST,
  mainDistDir: MAIN_DIST,
})
setWindowManagerInstance(windowManager)

const LIVE2D_MOUSE_POLL_MS = 33
let live2dMouseTrackingTimer: NodeJS.Timeout | null = null

let orbUiState: OrbUiState = 'ball'

type DragPoint = { x: number; y: number }

type WindowDragSession = {
  senderId: number
  win: BrowserWindow
  isPetWindow: boolean
  isOrbWindow: boolean
  lockedWidth: number
  lockedHeight: number
  startCursor: DragPoint
  offsetX: number
  offsetY: number
  activated: boolean
  lastX: number
  lastY: number
}

const windowDragSessions = new Map<number, WindowDragSession>()

function parseDragPoint(payload: unknown): DragPoint | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const x = typeof p.x === 'number' ? p.x : Number.NaN
  const y = typeof p.y === 'number' ? p.y : Number.NaN
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function snapOrbToSide(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const b = win.getBounds()
  const centerX = b.x + b.width / 2
  const dockLeft = centerX < wa.x + wa.width / 2
  const margin = 8
  const x = dockLeft ? wa.x + margin : wa.x + wa.width - b.width - margin
  const y = Math.max(wa.y + margin, Math.min(b.y, wa.y + wa.height - b.height - margin))
  win.setBounds({ x, y, width: b.width, height: b.height })
  windowManager.updateOrbBallBounds()
}

function cleanupWindowDragSession(session: WindowDragSession, opts?: { snapOrb?: boolean }): void {
  windowDragSessions.delete(session.senderId)

  if (session.isPetWindow) {
    windowManager.setPetDragging(false)
  }

  if (opts?.snapOrb && session.isOrbWindow && session.activated && !session.win.isDestroyed()) {
    try {
      snapOrbToSide(session.win)
    } catch {
      // ignore
    }
  }
}

function applyWindowDragMove(session: WindowDragSession, cursor: DragPoint): void {
  if (session.win.isDestroyed()) {
    cleanupWindowDragSession(session)
    return
  }

  // 拖动期间强制锁定窗口尺寸，避免异常 resize 造成“模型越拖越大”。
  const boundsNow = session.win.getBounds()
  if (boundsNow.width !== session.lockedWidth || boundsNow.height !== session.lockedHeight) {
    session.win.setBounds(
      {
        x: boundsNow.x,
        y: boundsNow.y,
        width: session.lockedWidth,
        height: session.lockedHeight,
      },
      false,
    )
  }

  if (!session.activated) {
    const dx = cursor.x - session.startCursor.x
    const dy = cursor.y - session.startCursor.y
    if (dx * dx + dy * dy < 10 * 10) return
    session.activated = true
  }

  const nextX = Math.round(cursor.x - session.offsetX)
  const nextY = Math.round(cursor.y - session.offsetY)
  if (nextX === session.lastX && nextY === session.lastY) return
  // 拖动阶段仅更新位置，避免 setBounds 带来的重排与闪烁。
  session.win.setPosition(nextX, nextY, false)
  session.lastX = nextX
  session.lastY = nextY
}

function broadcastOrbStateChanged(state: OrbUiState): void {
  for (const win of windowManager.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('orb:stateChanged', { state })
  }
}

function startLive2dMouseTrackingPump(): void {
  if (live2dMouseTrackingTimer) return

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
  let lastCursor: { x: number; y: number } | null = null
  let lastMovedAt = 0

  live2dMouseTrackingTimer = setInterval(() => {
    try {
      const settings = getSettings()
      if (settings.live2dMouseTrackingEnabled === false) return

      const petWin = windowManager.getPetWindow()
      if (!petWin || petWin.isDestroyed()) return

      const cursor = screen.getCursorScreenPoint()
      const bounds =
        typeof (petWin as unknown as { getContentBounds?: () => { x: number; y: number; width: number; height: number } }).getContentBounds ===
        'function'
          ? (petWin as unknown as { getContentBounds: () => { x: number; y: number; width: number; height: number } }).getContentBounds()
          : petWin.getBounds()

      const w = Math.max(1, Math.trunc(bounds.width))
      const h = Math.max(1, Math.trunc(bounds.height))
      const cx = bounds.x + w / 2
      const cy = bounds.y + h / 2

      // Only track cursor when it is inside Live2D window bounds.
      const inside = cursor.x >= bounds.x && cursor.x <= bounds.x + w && cursor.y >= bounds.y && cursor.y <= bounds.y + h

      // Follow cursor only when there is recent mouse movement.
      const now = Date.now()
      if (lastCursor && (lastCursor.x !== cursor.x || lastCursor.y !== cursor.y)) lastMovedAt = now
      lastCursor = cursor
      const movedRecently = now - lastMovedAt < 240

      const active = inside && movedRecently
      const nx = active ? clamp((cursor.x - cx) / (w / 2), -1, 1) : 0
      const ny = active ? clamp((cursor.y - cy) / (h / 2), -1, 1) : 0

      petWin.webContents.send('live2d:mouseTarget', { x: nx, y: ny, t: Date.now() })
    } catch {
      // ignore
    }
  }, LIVE2D_MOUSE_POLL_MS)

  ;(live2dMouseTrackingTimer as unknown as { unref?: () => void }).unref?.()
}

let chatAttachmentServer: http.Server | null = null
let chatAttachmentServerPort: number | null = null

function pickHttpContentTypeByExt(filePath: string): string {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.avi') return 'video/x-msvideo'
  if (ext === '.mkv') return 'video/x-matroska'
  return 'application/octet-stream'
}

async function ensureChatAttachmentServer(): Promise<number> {
  if (chatAttachmentServer && typeof chatAttachmentServerPort === 'number') return chatAttachmentServerPort

  chatAttachmentServer = http.createServer(async (req, res) => {
    try {
      const method = String(req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/file') {
        res.statusCode = 404
        res.end('not found')
        return
      }

      const b64 = url.searchParams.get('path') ?? ''
      if (!b64) {
        res.statusCode = 400
        res.end('missing path')
        return
      }

      const filePath = Buffer.from(b64, 'base64').toString('utf8').trim()
      if (!filePath || !path.isAbsolute(filePath)) {
        res.statusCode = 400
        res.end('invalid path')
        return
      }

      const st = await fs.stat(filePath)
      if (!st.isFile()) {
        res.statusCode = 404
        res.end('not a file')
        return
      }

      const contentType = pickHttpContentTypeByExt(filePath)
      res.setHeader('Content-Type', contentType)
      res.setHeader('Accept-Ranges', 'bytes')

      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405
        res.end('method not allowed')
        return
      }

      const range = typeof req.headers.range === 'string' ? req.headers.range : ''
      if (range && /^bytes=/.test(range)) {
        const m = range.match(/^bytes=(\d+)-(\d*)$/)
        if (!m) {
          res.statusCode = 416
          res.end('invalid range')
          return
        }
        const start = Math.max(0, Math.trunc(Number(m[1])))
        const end = m[2] ? Math.max(start, Math.trunc(Number(m[2]))) : st.size - 1
        const safeEnd = Math.min(end, st.size - 1)
        if (start >= st.size) {
          res.statusCode = 416
          res.end('range not satisfiable')
          return
        }
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${st.size}`)
        res.setHeader('Content-Length', String(safeEnd - start + 1))
        if (method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(filePath, { start, end: safeEnd }).pipe(res)
        return
      }

      res.setHeader('Content-Length', String(st.size))
      if (method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath).pipe(res)
    } catch (err) {
      res.statusCode = 500
      res.end(err instanceof Error ? err.message : 'error')
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    chatAttachmentServer!.listen(0, '127.0.0.1', () => {
      const addr = chatAttachmentServer!.address()
      if (addr && typeof addr === 'object' && typeof addr.port === 'number') resolve(addr.port)
      else reject(new Error('failed to bind chatAttachmentServer'))
    })
    chatAttachmentServer!.on('error', reject)
  })

  chatAttachmentServerPort = port
  return port
}

let registeredAsrHotkey: string | null = null
let pendingAsrTranscript: string[] = []
let asrTranscriptReadyWebContentsId: number | null = null
let lastContextUsage: ContextUsageSnapshot | null = null

function syncAsrHotkey() {
  if (!app.isReady()) return

  const unregister = () => {
    if (!registeredAsrHotkey) return
    try {
      globalShortcut.unregister(registeredAsrHotkey)
    } catch {
      /* ignore */
    }
    registeredAsrHotkey = null
  }

  unregister()

  const settings = getSettings()
  const asr = settings.asr
  if (!asr?.enabled) return
  if (asr.mode !== 'hotkey') return

  const hotkey = typeof asr.hotkey === 'string' ? asr.hotkey.trim() : ''
  if (!hotkey) return

  try {
    const ok = globalShortcut.register(hotkey, () => {
      const petWin = windowManager.getPetWindow()
      if (petWin && !petWin.isDestroyed()) {
        petWin.webContents.send('asr:hotkeyToggle')
      }
    })
    if (!ok) {
      console.warn(`[ASR] Failed to register hotkey: ${hotkey}`)
      return
    }
    registeredAsrHotkey = hotkey
  } catch (err) {
    console.warn(`[ASR] Failed to register hotkey: ${hotkey}`, err)
  }
}

let memoryService: MemoryService | null = null
let taskService: TaskService | null = null
let mcpManager: McpManager | null = null

function broadcastSettingsChanged() {
  const settings = getSettings()
  for (const win of windowManager.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('settings:changed', settings)
  }
}

function broadcastTasksChanged() {
  const payload: TaskListResult = taskService?.listTasks() ?? { items: [] }
  for (const win of windowManager.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('task:changed', payload)
  }
}

function broadcastMcpChanged(payload?: McpStateSnapshot) {
  const snap = payload ?? mcpManager?.getSnapshot() ?? { enabled: false, servers: [], updatedAt: Date.now() }
  for (const win of windowManager.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('mcp:changed', snap)
  }
}

function registerIpc() {
  // Debug log：导出调试日志路径并支持清空
  ipcMain.handle('debug:getPath', () => getDebugLogPath())
  ipcMain.handle('debug:clear', () => {
    clearDebugLog()
    return { ok: true, path: getDebugLogPath() }
  })
  ipcMain.on('debug:append', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const event = typeof p.event === 'string' ? p.event : 'unknown'
    appendDebugLog('renderer', event, p.data)
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:setAlwaysOnTop', (_event, value: boolean) => {
    windowManager.setAlwaysOnTop(value)
    broadcastSettingsChanged()
    return getSettings()
  })
  ipcMain.handle('settings:setClickThrough', (_event, value: boolean) => {
    windowManager.setClickThrough(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setActivePersonaId', (_event, personaId: string) => {
    setSettings({ activePersonaId: personaId })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setMemorySettings', (_event, memory: Partial<MemorySettings>) => {
    const current = getSettings()
    setSettings({ memory: { ...current.memory, ...memory } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setMemoryConsoleSettings', (_event, patch: Partial<MemoryConsoleSettings>) => {
    const current = getSettings()
    setSettings({ memoryConsole: { ...current.memoryConsole, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setPetScale', (_event, value: number) => {
    setSettings({ petScale: value })
    windowManager.resizePetWindowForScale(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setPetOpacity', (_event, value: number) => {
    setSettings({ petOpacity: value })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setLive2dModel', (_event, modelId: string, modelFile: string) => {
    setSettings({ live2dModelId: modelId, live2dModelFile: modelFile })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setLive2dMouseTrackingEnabled', (_event, enabled: boolean) => {
    setSettings({ live2dMouseTrackingEnabled: enabled !== false })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setLive2dIdleSwayEnabled', (_event, enabled: boolean) => {
    setSettings({ live2dIdleSwayEnabled: enabled !== false })
    broadcastSettingsChanged()
    return getSettings()
  })

  // AI settings handlers
  ipcMain.handle('settings:setAISettings', (_event, aiSettings: Partial<AISettings>) => {
    const current = getSettings()
    setSettings({ ai: { ...current.ai, ...aiSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle(
    'settings:saveAIProfile',
    (
      _event,
      payload: { id?: string; name: string; apiKey: string; baseUrl: string; model: string } | null | undefined,
    ) => {
      const current = getSettings()
      const now = Date.now()
      const idRaw = String(payload?.id ?? '').trim()
      const id = idRaw || `api_${randomUUID().slice(0, 8)}`
      const name = String(payload?.name ?? '').trim() || id
      const nextProfile: AIProfile = {
        id,
        name,
        apiKey: String(payload?.apiKey ?? '').trim(),
        baseUrl: String(payload?.baseUrl ?? '').trim(),
        model: String(payload?.model ?? '').trim(),
        createdAt: now,
        updatedAt: now,
      }

      const list = Array.isArray(current.aiProfiles) ? current.aiProfiles : []
      const idx = list.findIndex((p) => p.id === id)
      if (idx >= 0) {
        nextProfile.createdAt = list[idx]?.createdAt ?? now
      }
      const nextProfiles =
        idx >= 0
          ? [...list.slice(0, idx), nextProfile, ...list.slice(idx + 1)]
          : [nextProfile, ...list].slice(0, 20)

      setSettings({
        ai: { ...current.ai, apiKey: nextProfile.apiKey, baseUrl: nextProfile.baseUrl, model: nextProfile.model },
        aiProfiles: nextProfiles,
        activeAiProfileId: id,
      })
      broadcastSettingsChanged()
      return getSettings()
    },
  )

  ipcMain.handle('settings:deleteAIProfile', (_event, idRaw: string) => {
    const current = getSettings()
    const id = String(idRaw ?? '').trim()
    if (!id) return current
    const list = Array.isArray(current.aiProfiles) ? current.aiProfiles : []
    const nextProfiles = list.filter((p) => p.id !== id)
    const deletingActive = current.activeAiProfileId === id
    const nextActive = deletingActive ? nextProfiles[0]?.id ?? '' : current.activeAiProfileId ?? ''
    const nextActiveProfile = nextProfiles.find((p) => p.id === nextActive)

    setSettings({
      aiProfiles: nextProfiles,
      activeAiProfileId: nextActive,
      ...(deletingActive && nextActiveProfile
        ? {
            ai: {
              ...current.ai,
              apiKey: nextActiveProfile.apiKey,
              baseUrl: nextActiveProfile.baseUrl,
              model: nextActiveProfile.model,
            },
          }
        : {}),
    })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:applyAIProfile', (_event, idRaw: string) => {
    const current = getSettings()
    const id = String(idRaw ?? '').trim()
    if (!id) return current
    const profile = (Array.isArray(current.aiProfiles) ? current.aiProfiles : []).find((p) => p.id === id)
    if (!profile) return current
    setSettings({
      ai: { ...current.ai, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model },
      activeAiProfileId: id,
    })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('ai:listModels', async (_event, payload: { apiKey?: string; baseUrl?: string } | null | undefined) => {
    const current = getSettings().ai
    const baseUrl = normalizeOpenAiBaseUrl(String(payload?.baseUrl ?? '').trim() || current.baseUrl)
    const apiKey = String(payload?.apiKey ?? '').trim() || String(current.apiKey ?? '').trim()
    if (!baseUrl) return { ok: false, models: [] as string[], error: 'baseUrl 不能为空' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers, signal: ac.signal })
      if (!res.ok) {
        return { ok: false, models: [] as string[], error: `HTTP ${res.status} ${res.statusText}` }
      }
      const json = (await res.json().catch(() => null)) as unknown
      const models = extractModelIdsFromResponse(json)
      if (models.length === 0) {
        return { ok: false, models: [] as string[], error: '未获取到模型列表' }
      }
      return { ok: true, models }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, models: [] as string[], error: msg }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('settings:setBubbleSettings', (_event, bubbleSettings: Partial<BubbleSettings>) => {
    const current = getSettings()
    setSettings({ bubble: { ...current.bubble, ...bubbleSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setTaskPanelSettings', (_event, patch: Partial<TaskPanelSettings>) => {
    const current = getSettings()
    setSettings({ taskPanel: { ...current.taskPanel, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setOrchestratorSettings', (_event, patch: Partial<OrchestratorSettings>) => {
    const current = getSettings()
    setSettings({ orchestrator: { ...current.orchestrator, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  // Tool settings (M3.5) - global/group/single tool toggles
  ipcMain.handle('settings:setToolSettings', (_event, patch: Partial<ToolSettings>) => {
    const current = getSettings()
    const currTools = current.tools

    const next: ToolSettings = {
      ...currTools,
      ...patch,
      groups: typeof patch.groups === 'object' && patch.groups ? (patch.groups as Record<string, boolean>) : currTools.groups,
      tools: typeof patch.tools === 'object' && patch.tools ? (patch.tools as Record<string, boolean>) : currTools.tools,
    }

    setSettings({ tools: next })
    broadcastSettingsChanged()
    return getSettings()
  })

  // MCP settings (M3.5 Step2)
  ipcMain.handle('settings:setMcpSettings', (_event, patch: Partial<McpSettings>) => {
    const current = getSettings()
    const curr = current.mcp

    const next: McpSettings = {
      ...curr,
      ...patch,
      servers: Array.isArray(patch.servers) ? patch.servers : curr.servers,
    }

    setSettings({ mcp: next })
    broadcastSettingsChanged()
    void mcpManager?.sync(getSettings().mcp)
    return getSettings()
  })

  ipcMain.handle('mcp:getState', () => {
    return mcpManager?.getSnapshot() ?? { enabled: false, servers: [], updatedAt: Date.now() }
  })

  ipcMain.handle('settings:setChatProfile', (_event, chatProfile: Partial<ChatProfile>) => {
    const current = getSettings()
    setSettings({ chatProfile: { ...current.chatProfile, ...chatProfile } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setChatUiSettings', (_event, chatUi: Partial<ChatUiSettings>) => {
    const current = getSettings()
    setSettings({ chatUi: { ...current.chatUi, ...chatUi } })
    broadcastSettingsChanged()
    return getSettings()
  })

  // Context usage snapshot (chat -> main -> pet/chat)
  ipcMain.on('contextUsage:set', (_event, snapshot: ContextUsageSnapshot | null) => {
    lastContextUsage = snapshot && typeof snapshot === 'object' ? snapshot : null
    const payload = lastContextUsage
    for (const win of windowManager.getAllWindows()) {
      try {
        win.webContents.send('contextUsage:changed', payload)
      } catch {
        /* ignore */
      }
    }
  })

  ipcMain.handle('contextUsage:get', () => lastContextUsage)

  ipcMain.handle('settings:setTtsSettings', (_event, tts: Partial<TtsSettings>) => {
    const current = getSettings()
    setSettings({ tts: { ...current.tts, ...tts } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setAsrSettings', (_event, asr: Partial<AsrSettings>) => {
    const current = getSettings()
    setSettings({ asr: { ...current.asr, ...asr } })
    broadcastSettingsChanged()
    syncAsrHotkey()
    return getSettings()
  })

  // Model scanner - scan live2d directory for available models
  ipcMain.handle('models:scan', () => {
    return scanLive2dModels()
  })

  // Chat persistence
  ipcMain.handle('chat:list', () => listChatSessions())
  ipcMain.handle('chat:get', (_event, sessionId?: string) => getChatSession(sessionId))
  ipcMain.handle('chat:create', (_event, name?: string, personaId?: string) => createChatSession(name, personaId))
  ipcMain.handle('chat:setCurrent', (_event, sessionId: string) => setCurrentChatSession(sessionId))
  ipcMain.handle('chat:rename', (_event, sessionId: string, name: string) => renameChatSession(sessionId, name))
  ipcMain.handle('chat:delete', (_event, sessionId: string) => deleteChatSession(sessionId))
  ipcMain.handle('chat:clear', (_event, sessionId: string) => clearChatSession(sessionId))
  ipcMain.handle('chat:setMessages', (_event, sessionId: string, messages: ChatMessageRecord[]) =>
    setChatMessages(sessionId, messages),
  )
  ipcMain.handle('chat:addMessage', (_event, sessionId: string, message: ChatMessageRecord) => {
    const session = addChatMessage(sessionId, message)
    try {
      const memEnabled = getSettings().memory.enabled
      if (!memEnabled) return session
      if (message.role !== 'assistant') return session
      const personaId = session.personaId || 'default'

      let includeUser = true
      try {
        const persona = memoryService?.getPersona(personaId)
        if (persona) includeUser = persona.captureUser
      } catch {
        includeUser = true
      }

      let userContent = ''
      let userMessageId = ''
      if (includeUser) {
        const idx = session.messages.findIndex((m) => m.id === message.id)
        for (let i = (idx >= 0 ? idx : session.messages.length) - 1; i >= 0; i--) {
          const m = session.messages[i]
          if (m.role === 'user') {
            userContent = m.content
            userMessageId = m.id
            break
          }
        }
      }

      const parts: string[] = []
      if (userContent.trim()) parts.push(`用户：${userContent}`)
      if (message.content.trim()) parts.push(`助手：${message.content}`)
      const turnContent = parts.join('\n').trim()
      if (!turnContent) return session

      const ingestMessageId = userMessageId ? `turn:${userMessageId}` : message.id
      const settings = getSettings()
      void (memoryService?.ingestChatMessage(
        {
          personaId,
          sessionId,
          messageId: ingestMessageId,
          role: message.role,
          content: turnContent,
          createdAt: message.createdAt,
        },
        settings.memory,
        settings.ai,
      ) ?? Promise.resolve()).catch(() => {})
    } catch (_) {
      /* ignore */
    }
    return session
  })
  ipcMain.handle('chat:updateMessage', (_event, sessionId: string, messageId: string, content: string) => {
    const session = updateChatMessage(sessionId, messageId, content)
    try {
      const memEnabled = getSettings().memory.enabled
      if (!memEnabled) return session
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg) return session
      if (msg.role !== 'assistant') return session
      const personaId = session.personaId || 'default'

      let includeUser = true
      try {
        const persona = memoryService?.getPersona(personaId)
        if (persona) includeUser = persona.captureUser
      } catch {
        includeUser = true
      }

      let userContent = ''
      let userMessageId = ''
      if (includeUser) {
        const idx = session.messages.findIndex((m) => m.id === msg.id)
        for (let i = (idx >= 0 ? idx : session.messages.length) - 1; i >= 0; i--) {
          const m = session.messages[i]
          if (m.role === 'user') {
            userContent = m.content
            userMessageId = m.id
            break
          }
        }
      }

      const parts: string[] = []
      if (userContent.trim()) parts.push(`用户：${userContent}`)
      if (msg.content.trim()) parts.push(`助手：${msg.content}`)
      const turnContent = parts.join('\n').trim()
      if (!turnContent) return session

      const ingestMessageId = userMessageId ? `turn:${userMessageId}` : msg.id
      const settings = getSettings()
      void (memoryService?.ingestChatMessage(
        {
          personaId,
          sessionId,
          messageId: ingestMessageId,
          role: msg.role,
          content: turnContent,
          createdAt: msg.createdAt,
        },
        settings.memory,
        settings.ai,
      ) ?? Promise.resolve()).catch(() => {})
    } catch (_) {
      /* ignore */
    }
    return session
  })
  ipcMain.handle('chat:updateMessageRecord', (_event, sessionId: string, messageId: string, patch: unknown) => {
    const session = updateChatMessageRecord(sessionId, messageId, patch)
    try {
      const memEnabled = getSettings().memory.enabled
      if (!memEnabled) return session
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg) return session
      if (msg.role !== 'assistant') return session
      const personaId = session.personaId || 'default'

      let includeUser = true
      try {
        const persona = memoryService?.getPersona(personaId)
        if (persona) includeUser = persona.captureUser
      } catch {
        includeUser = true
      }

      let userContent = ''
      let userMessageId = ''
      if (includeUser) {
        const idx = session.messages.findIndex((m) => m.id === msg.id)
        for (let i = (idx >= 0 ? idx : session.messages.length) - 1; i >= 0; i--) {
          const m = session.messages[i]
          if (m.role === 'user') {
            userContent = m.content
            userMessageId = m.id
            break
          }
        }
      }

      const parts: string[] = []
      if (userContent.trim()) parts.push(`用户：${userContent}`)
      if (msg.content.trim()) parts.push(`助手：${msg.content}`)
      const turnContent = parts.join('\n').trim()
      if (!turnContent) return session

      const ingestMessageId = userMessageId ? `turn:${userMessageId}` : msg.id
      const settings = getSettings()
      void (memoryService?.ingestChatMessage(
        {
          personaId,
          sessionId,
          messageId: ingestMessageId,
          role: msg.role,
          content: turnContent,
          createdAt: msg.createdAt,
        },
        settings.memory,
        settings.ai,
      ) ?? Promise.resolve()).catch(() => {})
    } catch (_) {
      /* ignore */
    }
    return session
  })
  ipcMain.handle('chat:deleteMessage', (_event, sessionId: string, messageId: string) => deleteChatMessage(sessionId, messageId))
  ipcMain.handle('chat:setAutoExtractCursor', (_event, sessionId: string, cursor: number) =>
    setChatSessionAutoExtractCursor(sessionId, cursor),
  )
  ipcMain.handle('chat:setAutoExtractMeta', (_event, sessionId: string, patch: unknown) =>
    setChatSessionAutoExtractMeta(sessionId, patch),
  )

  // Chat attachments: persist dropped/pasted media into userData for stable paths.
  ipcMain.handle('chat:saveAttachment', async (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const kind = p.kind === 'image' || p.kind === 'video' ? (p.kind as 'image' | 'video') : ''
    if (!kind) throw new Error('invalid kind')

    const sourcePath = typeof p.sourcePath === 'string' ? p.sourcePath.trim() : ''
    const dataUrl = typeof p.dataUrl === 'string' ? p.dataUrl.trim() : ''
    const filename = typeof p.filename === 'string' ? p.filename.trim() : ''

    if (!sourcePath && !dataUrl) throw new Error('missing sourcePath/dataUrl')

    const baseDir = path.join(app.getPath('userData'), 'chat-attachments')
    await fs.mkdir(baseDir, { recursive: true })

    let ext = filename ? path.extname(filename) : ''
    let detectedMime = ''
    if (!ext && dataUrl) {
      const parsed = parseDataUrl(dataUrl)
      detectedMime = parsed?.mimeType ?? ''
      ext = pickChatAttachmentExt(detectedMime, kind === 'image' ? '.png' : '.mp4')
    }
    if (!ext) ext = kind === 'image' ? '.png' : '.mp4'

    const storedName = `${randomUUID()}${ext}`
    const storedPath = path.join(baseDir, storedName)

    if (sourcePath) {
      await fs.copyFile(sourcePath, storedPath)
    } else {
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) throw new Error('invalid dataUrl')
      const buf = Buffer.from(parsed.base64, 'base64')
      await fs.writeFile(storedPath, buf)
      detectedMime = parsed.mimeType
    }

    return {
      ok: true as const,
      kind,
      path: storedPath,
      filename: filename || storedName,
      ...(detectedMime ? { mimeType: detectedMime } : {}),
    }
  })

  // Chat attachments: read local file into dataUrl for UI preview (useful when renderer cannot load file:// directly).
  ipcMain.handle('chat:readAttachmentDataUrl', async (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const filePath = typeof p.path === 'string' ? p.path.trim() : ''
    if (!filePath) throw new Error('missing path')

    const st = await fs.stat(filePath)
    if (!st.isFile()) throw new Error('not a file')
    if (st.size > 8 * 1024 * 1024) throw new Error('file too large')

    const buf = await fs.readFile(filePath)
    const mimeType = pickChatAttachmentMimeByExt(filePath)
    const b64 = buf.toString('base64')
    const dataUrl = `data:${mimeType};base64,${b64}`
    return { ok: true as const, mimeType, dataUrl }
  })

  ipcMain.handle('chat:getAttachmentUrl', async (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const filePath = typeof p.path === 'string' ? p.path.trim() : ''
    if (!filePath) throw new Error('missing path')
    const port = await ensureChatAttachmentServer()
    const b64 = Buffer.from(filePath, 'utf8').toString('base64')
    return { ok: true as const, url: `http://127.0.0.1:${port}/file?path=${encodeURIComponent(b64)}` }
  })

  // Tasks / Orchestrator (M1)
  ipcMain.handle('task:list', (): TaskListResult => taskService?.listTasks() ?? { items: [] })
  ipcMain.handle('task:get', (_event, id: string): TaskRecord | null => taskService?.getTask(id) ?? null)
  ipcMain.handle('task:create', (_event, args: TaskCreateArgs): TaskRecord => {
    if (!taskService) throw new Error('Task service not ready')
    return taskService.createTask(args)
  })
  ipcMain.handle('task:pause', (_event, id: string): TaskRecord | null => taskService?.pauseTask(id) ?? null)
  ipcMain.handle('task:resume', (_event, id: string): TaskRecord | null => taskService?.resumeTask(id) ?? null)
  ipcMain.handle('task:cancel', (_event, id: string): TaskRecord | null => taskService?.cancelTask(id) ?? null)
  ipcMain.handle('task:dismiss', (_event, id: string): { ok: true } | null => taskService?.dismissTask(id) ?? null)

  // Long-term memory / personas
  ipcMain.handle('memory:listPersonas', (): PersonaSummary[] => memoryService?.listPersonas() ?? [])
  ipcMain.handle('memory:getPersona', (_event, personaId: string): Persona | null => memoryService?.getPersona(personaId) ?? null)
  ipcMain.handle('memory:createPersona', (_event, name: string): Persona => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.createPersona(name)
  })
  ipcMain.handle(
    'memory:updatePersona',
    (
      _event,
      personaId: string,
      patch: {
        name?: string
        prompt?: string
        captureEnabled?: boolean
        captureUser?: boolean
        captureAssistant?: boolean
        retrieveEnabled?: boolean
      },
    ): Persona => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updatePersona(personaId, patch)
    },
  )
  ipcMain.handle('memory:deletePersona', (_event, personaId: string): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    memoryService.deletePersona(personaId)
    return { ok: true }
  })
  ipcMain.handle('memory:retrieve', async (_event, args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => {
    if (!memoryService) return { addon: '' }
    const settings = getSettings()
    if (!settings.memory.enabled) return { addon: '' }
    return memoryService.retrieveContext(args, settings.memory, settings.ai)
  })
  ipcMain.handle('memory:list', (_event, args: MemoryListArgs): MemoryListResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemory(args)
  })
  ipcMain.handle('memory:upsertManual', async (_event, args: MemoryUpsertManualArgs): Promise<MemoryRecord> => {
    if (!memoryService) throw new Error('Memory service not ready')
    const settings = getSettings()
    return memoryService.upsertManualMemory(args, settings.memory, settings.ai)
  })
  ipcMain.handle('memory:update', (_event, args: MemoryUpdateArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemory(args)
  })
  ipcMain.handle('memory:updateMeta', (_event, args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryMeta(args)
  })
  ipcMain.handle('memory:updateManyMeta', (_event, args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateManyMemoryMeta(args)
  })
  ipcMain.handle('memory:updateByFilterMeta', (_event, args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryByFilterMeta(args)
  })
  ipcMain.handle('memory:listVersions', (_event, args: MemoryListVersionsArgs): MemoryVersionRecord[] => {
    if (!memoryService) return []
    return memoryService.listMemoryVersions(args)
  })
  ipcMain.handle('memory:rollbackVersion', (_event, args: MemoryRollbackVersionArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.rollbackMemoryVersion(args)
  })
  ipcMain.handle('memory:listConflicts', (_event, args: MemoryListConflictsArgs): MemoryListConflictsResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemoryConflicts(args)
  })
  ipcMain.handle('memory:resolveConflict', (_event, args: MemoryResolveConflictArgs): MemoryResolveConflictResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.resolveMemoryConflict(args)
  })
  ipcMain.handle('memory:delete', (_event, args: MemoryDeleteArgs): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemory(args)
  })
  ipcMain.handle('memory:deleteMany', (_event, args: MemoryDeleteManyArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteManyMemory(args)
  })
  ipcMain.handle('memory:deleteByFilter', (_event, args: MemoryDeleteByFilterArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemoryByFilter(args)
  })

  // TTS options (scan local GPT-SoVITS directory)
  ipcMain.handle('tts:listOptions', () => {
    return listTtsOptions(process.env.APP_ROOT ?? process.cwd())
  })

  // TTS HTTP proxy (avoid renderer CORS/preflight issues)
  const validateTtsUrl = (rawUrl: string): URL => {
    const url = new URL(rawUrl)
    const ttsBase = (getSettings().tts?.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!ttsBase) throw new Error('TTS baseUrl not configured')
    const base = new URL(ttsBase)
    if (url.origin !== base.origin) {
      throw new Error(`TTS request must be same-origin with tts.baseUrl: ${base.origin}`)
    }
    const allowPaths = new Set(['/tts', '/set_gpt_weights', '/set_sovits_weights'])
    if (!allowPaths.has(url.pathname)) {
      throw new Error(`TTS 请求路径不允许: ${url.pathname}`)
    }
    return url
  }

  ipcMain.handle('tts:httpGetJson', async (_event, rawUrl: string) => {
    const url = validateTtsUrl(rawUrl)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), 60000)
    try {
      const res = await fetch(url.toString(), { cache: 'no-store', signal: ac.signal })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = (data as { message?: string })?.message
        return { ok: false, status: res.status, statusText: res.statusText, json: data, error: msg || `HTTP ${res.status}` }
      }
      return { ok: true, status: res.status, statusText: res.statusText, json: data }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle(
    'tts:httpRequestArrayBuffer',
    async (_event, payload: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => {
      const url = validateTtsUrl(payload.url)
      const method = (payload.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
      const timeoutMs = Math.max(1000, Math.min(180000, payload.timeoutMs ?? 120000))
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), timeoutMs)
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: payload.headers ?? undefined,
          body: method === 'POST' ? payload.body ?? '' : undefined,
          signal: ac.signal,
        })
        const buf = await res.arrayBuffer()
        const contentType = res.headers.get('content-type') ?? ''
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            statusText: res.statusText,
            contentType,
            arrayBuffer: buf,
            error: `HTTP ${res.status}: ${res.statusText}`,
          }
        }
        return { ok: true, status: res.status, statusText: res.statusText, contentType, arrayBuffer: buf }
      } finally {
        clearTimeout(timer)
      }
    },
  )

  // TTS HTTP 流式代理：将响应分块通过 IPC 转发给 renderer。
  const ttsHttpStreams = new Map<string, AbortController>()
  const makeStreamId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  ipcMain.handle(
    'tts:httpStreamStart',
    async (
      event,
      payload: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number },
    ) => {
      const url = validateTtsUrl(payload.url)
      const method = (payload.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
      const timeoutMs = Math.max(1000, Math.min(180000, payload.timeoutMs ?? 120000))

      const streamId = makeStreamId()
      const ac = new AbortController()
      ttsHttpStreams.set(streamId, ac)

      const sender = event.sender
      const safeSend = (channel: string, data: unknown) => {
        try {
          if (!sender || sender.isDestroyed()) return
          sender.send(channel, data)
        } catch (_) {
          /* ignore */
        }
      }

      void (async () => {
        const timer = setTimeout(() => ac.abort(new Error('TTS HTTP timeout')), timeoutMs)
        try {
          const res = await fetch(url.toString(), {
            method,
            headers: payload.headers ?? undefined,
            body: method === 'POST' ? payload.body ?? '' : undefined,
            signal: ac.signal,
          })

          if (!res.ok) {
            const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
            safeSend('tts:httpStreamError', {
              streamId,
              status: res.status,
              statusText: res.statusText,
              contentType: res.headers.get('content-type') ?? '',
              arrayBuffer: buf,
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
            if (!value) continue
            // Electron IPC 可直接传 Uint8Array/Buffer，renderer 侧按二进制拼接。
            safeSend('tts:httpStreamChunk', { streamId, chunk: value })
          }

          safeSend('tts:httpStreamDone', { streamId })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          safeSend('tts:httpStreamError', { streamId, error: msg })
          safeSend('tts:httpStreamDone', { streamId })
        } finally {
          clearTimeout(timer)
          ttsHttpStreams.delete(streamId)
        }
      })()

      return { streamId }
    },
  )

  ipcMain.handle('tts:httpStreamCancel', (_event, streamId: string) => {
    const ac = ttsHttpStreams.get(streamId)
    if (ac) {
      try {
        ac.abort(new Error('TTS stream canceled'))
      } catch (_) {
        /* ignore */
      }
      ttsHttpStreams.delete(streamId)
    }
    return { ok: true }
  })

  // Live2D expression/motion triggers - broadcast to pet window
  ipcMain.on('live2d:triggerExpression', (_event, expressionName: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:expression', expressionName)
    }
  })

  ipcMain.on('live2d:triggerMotion', (_event, motionGroup: string, index: number) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:motion', motionGroup, index)
    }
  })

  // Live2D capabilities - report from pet window (for tools/agent)
  ipcMain.on('live2d:capabilities', (_event, payload: unknown) => {
    const res = setLive2dCapabilitiesFromRenderer(payload)
    if (!res.ok) {
      console.warn('[Live2D] capabilities report rejected:', res.error)
    }
  })

  // Bubble message - forward from chat window to pet window
  ipcMain.on('bubble:sendMessage', (_event, message: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('bubble:message', message)
    }
  })

  // ASR 文本转发：从桌宠窗口发往聊天窗口（手动模式也会使用）。
  ipcMain.on('asr:reportTranscript', (_event, text: string) => {
    const cleaned = String(text ?? '').trim()
    if (!cleaned) return

    const settings = getSettings()
    const asr = settings.asr
    const autoSend = Boolean(asr?.enabled && asr?.autoSend)

    let chatWin = windowManager.getChatWindow()
    if (autoSend && !chatWin) {
      chatWin = windowManager.ensureChatWindow({ show: false, focus: false })
    }

    const chatWc = chatWin && !chatWin.isDestroyed() ? chatWin.webContents : null
    if (chatWc?.isLoading()) {
      asrTranscriptReadyWebContentsId = null
    }

    const canSendNow = Boolean(
      chatWin &&
        !chatWin.isDestroyed() &&
        chatWc &&
        !chatWc.isLoading() &&
        asrTranscriptReadyWebContentsId === chatWc.id,
    )
    if (canSendNow) {
      chatWin?.webContents.send('asr:transcript', cleaned)
      return
    }

    pendingAsrTranscript.push(cleaned)
  })

  ipcMain.handle('asr:takeTranscript', () => {
    const text = pendingAsrTranscript.join(' ').trim()
    pendingAsrTranscript = []
    return text
  })

  ipcMain.on('asr:transcriptReady', (event) => {
    const chatWin = windowManager.getChatWindow()
    if (!chatWin || chatWin.isDestroyed()) return
    if (event.sender.id !== chatWin.webContents.id) return
    asrTranscriptReadyWebContentsId = event.sender.id
  })

  // TTS segmented sync: forward utterance segments to pet window
  ipcMain.on('tts:enqueue', (_event, payload: unknown) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:enqueue', payload)
    }
  })

  ipcMain.on('tts:finalize', (_event, utteranceId: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:finalize', utteranceId)
    }
  })

  ipcMain.on('tts:stopAll', () => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:stopAll')
    }
  })

  // Pet -> Chat: segment started / ended / failed
  ipcMain.on('tts:segmentStarted', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:segmentStarted', payload)
    }
  })

  ipcMain.on('tts:utteranceEnded', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceEnded', payload)
    }
  })

  ipcMain.on('tts:utteranceFailed', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceFailed', payload)
    }
  })

  ipcMain.handle('window:openChat', () => {
    windowManager.ensureChatWindow()
  })
  ipcMain.handle('window:openSettings', () => {
    windowManager.ensureSettingsWindow()
  })
  ipcMain.handle('window:openMemory', () => {
    windowManager.ensureMemoryWindow()
  })

  // 显示模式切换入口：支持 live2d / orb / hidden。
  ipcMain.handle('window:setDisplayMode', (_event, modeRaw: unknown) => {
    const mode = typeof modeRaw === 'string' ? (modeRaw.trim() as DisplayMode) : ''
    if (mode !== 'live2d' && mode !== 'orb' && mode !== 'hidden') return
    windowManager.setDisplayMode(mode)
    if (mode === 'orb') {
      // 切换到 orb 时同步 Orb UI 状态，避免窗口状态不一致。
      broadcastOrbStateChanged(orbUiState)
      windowManager.setOrbUiState(orbUiState, { focus: true })
    }
    broadcastSettingsChanged()
  })
  ipcMain.handle('window:hideAll', () => {
    windowManager.hideAll()
  })

  // Close current window (not all windows)
  ipcMain.handle('window:closeCurrent', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })

  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  // =====================
  // Orb（球/条/面板）IPC
  // =====================

  ipcMain.handle('orb:getUiState', () => {
    return { state: orbUiState }
  })

  ipcMain.handle('orb:setUiState', (_event, stateRaw: unknown, optsRaw: unknown) => {
    const state = typeof stateRaw === 'string' ? (stateRaw.trim() as OrbUiState) : ''
    if (state !== 'ball' && state !== 'bar' && state !== 'panel') return { state: orbUiState }

    const opts = optsRaw && typeof optsRaw === 'object' && !Array.isArray(optsRaw) ? (optsRaw as { focus?: unknown }) : null
    const focus = opts ? Boolean(opts.focus) : false

    orbUiState = state
    broadcastOrbStateChanged(state)
    windowManager.setOrbUiState(state, { focus })
    return { state }
  })

  ipcMain.handle('orb:toggleUiState', () => {
    const next: OrbUiState = orbUiState === 'ball' ? 'bar' : orbUiState === 'bar' ? 'panel' : 'ball'
    orbUiState = next
    broadcastOrbStateChanged(next)
    windowManager.setOrbUiState(next, { focus: true })
    return { state: next }
  })

  ipcMain.handle('orb:setOverlayBounds', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
    const width = typeof p?.width === 'number' ? p.width : Number.NaN
    const height = typeof p?.height === 'number' ? p.height : Number.NaN
    const focus = Boolean(p?.focus)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: true }
    windowManager.setOrbOverlayBounds({ width, height, focus })
    return { ok: true }
  })

  ipcMain.handle('orb:clearOverlayBounds', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
    const focus = Boolean(p?.focus)
    windowManager.clearOrbOverlayBounds({ focus })
    return { ok: true }
  })

  ipcMain.handle('orb:showContextMenu', (_event, point: unknown) => {
    const p = point && typeof point === 'object' && !Array.isArray(point) ? (point as Record<string, unknown>) : null
    const x = typeof p?.x === 'number' ? p.x : Number.NaN
    const y = typeof p?.y === 'number' ? p.y : Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: true }
    windowManager.showOrbContextMenu({ x, y })
    return { ok: true }
  })

  // Window drag support (event-driven): renderer sends start/move/stop with screen coords.
  ipcMain.on('window:startDrag', (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return

    const senderId = event.sender.id
    const oldSession = windowDragSessions.get(senderId)
    if (oldSession) cleanupWindowDragSession(oldSession)

    const parsedCursor = parseDragPoint(payload)
    const winBounds = win.getBounds()
    const petWin = windowManager.getPetWindow()
    const orbWin = windowManager.getOrbWindow()
    const isPetWindow = Boolean(petWin && petWin.id === win.id)
    const isOrbWindow = Boolean(orbWin && orbWin.id === win.id)
    const cursor = parsedCursor ?? screen.getCursorScreenPoint()
    const lockedWidth = winBounds.width
    const lockedHeight = winBounds.height

    if (isPetWindow) {
      windowManager.setPetDragging(true)
    }

    windowDragSessions.set(senderId, {
      senderId,
      win,
      isPetWindow,
      isOrbWindow,
      lockedWidth,
      lockedHeight,
      startCursor: { x: cursor.x, y: cursor.y },
      offsetX: cursor.x - winBounds.x,
      offsetY: cursor.y - winBounds.y,
      activated: false,
      lastX: winBounds.x,
      lastY: winBounds.y,
    })
  })

  ipcMain.on('window:dragMove', (event, payload: unknown) => {
    const session = windowDragSessions.get(event.sender.id)
    if (!session) return
    const cursor = parseDragPoint(payload) ?? screen.getCursorScreenPoint()
    applyWindowDragMove(session, cursor)
  })

  ipcMain.on('window:stopDrag', (event, payload: unknown) => {
    const session = windowDragSessions.get(event.sender.id)
    if (!session) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const petWin = windowManager.getPetWindow()
      if (win && petWin && win.id === petWin.id) {
        windowManager.setPetDragging(false)
      }
      return
    }

    const cursor = parseDragPoint(payload)
    if (cursor) {
      applyWindowDragMove(session, cursor)
    }

    cleanupWindowDragSession(session, { snapOrb: true })
  })
  // Pet window context menu
  ipcMain.on('pet:showContextMenu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return

    const settings = getSettings()
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: '\u6253\u5f00\u804a\u5929',
        click: () => windowManager.ensureChatWindow(),
      },
      {
        label: '\u8bbe\u7f6e',
        click: () => windowManager.ensureSettingsWindow(),
      },
      {
        label: '\u5207\u6362\u5230\u60ac\u6d6e\u7403',
        click: () => {
          windowManager.setDisplayMode('orb')
          broadcastSettingsChanged()
        },
      },
      {
        label: '\u4ec5\u6258\u76d8\u9690\u85cf',
        click: () => {
          windowManager.setDisplayMode('hidden')
          broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      {
        label: '\u7f6e\u9876\u663e\u793a',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: () => {
          windowManager.setAlwaysOnTop(!settings.alwaysOnTop)
          broadcastSettingsChanged()
        },
      },
      {
        label: 'TTS \u8bed\u97f3\u64ad\u62a5',
        type: 'checkbox',
        checked: settings.tts?.enabled ?? false,
        click: () => {
          const current = getSettings()
          setSettings({ tts: { ...current.tts, enabled: !current.tts.enabled } })
          broadcastSettingsChanged()
        },
      },
      {
        label: '\u8bed\u97f3\u8bc6\u522b\uff08ASR\uff09',
        type: 'checkbox',
        checked: settings.asr?.enabled ?? false,
        click: () => {
          const current = getSettings()
          setSettings({ asr: { ...current.asr, enabled: !current.asr.enabled } })
          broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      {
        label: '\u9690\u85cf\u5ba0\u7269',
        click: () => windowManager.hideAll(),
      },
      {
        label: '\u9000\u51fa',
        click: () => app.quit(),
      },
    ]

    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win })
  })

  // Pet overlay hover: when a UI overlay (e.g. task panel) needs mouse interaction in click-through mode
  ipcMain.on('pet:setOverlayHover', (event, hovering: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const petWin = windowManager.getPetWindow()
    if (!win || !petWin) return
    if (win.id !== petWin.id) return
    windowManager.setPetOverlayHover(Boolean(hovering))
  })

  ipcMain.on(
    'pet:setOverlayRects',
    (
      event,
      rects:
        | {
            taskPanel?:
              | { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }
              | null
          }
        | null
        | undefined,
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const petWin = windowManager.getPetWindow()
      if (!win || !petWin) return
      if (win.id !== petWin.id) return
      windowManager.setPetOverlayRects(rects)
    },
  )

  // Dynamic mouse events ignore for transparent click-through
  ipcMain.on('window:setIgnoreMouseEvents', (event, ignore: boolean, forward: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(ignore, { forward })
  })
}

app.on('second-instance', () => {
  windowManager.showPet()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  try {
    windowManager.setAppQuitting(true)
  } catch (_) {
    /* ignore */
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (live2dMouseTrackingTimer) {
    clearInterval(live2dMouseTrackingTimer)
    live2dMouseTrackingTimer = null
  }
  void mcpManager?.sync({ enabled: false, servers: [] })
})

app.whenReady().then(() => {
  initDebugLog({
    userDataDir: app.getPath('userData'),
    enabled: !app.isPackaged,
  })
  if (isDebugLogEnabled()) {
    console.info(`[DebugLog] enabled, path=${getDebugLogPath()}`)
  }

  try {
    memoryService = new MemoryService(app.getPath('userData'))
  } catch (err) {
    console.error('[Memory] Failed to initialize memory service:', err)
    memoryService = null
  }

  try {
    mcpManager = new McpManager()
    mcpManager.onChanged((snap) => broadcastMcpChanged(snap))
    void mcpManager.sync(getSettings().mcp)
  } catch (err) {
    console.error('[MCP] Failed to initialize MCP manager:', err)
    mcpManager = null
  }

  try {
    taskService = new TaskService({
      onChanged: broadcastTasksChanged,
      userDataDir: app.getPath('userData'),
      mcpManager,
    })
  } catch (err) {
    console.error('[Task] Failed to initialize task service:', err)
    taskService = null
  }

  const runMemoryMaintenance = () => {
    try {
      if (!memoryService) return
      if (!getSettings().memory.enabled) return
      const res = memoryService.runRetentionMaintenance()
      if (res.updated > 0 || res.archived > 0) {
        console.info(`[Memory] Maintenance: scanned=${res.scanned} updated=${res.updated} archived=${res.archived}`)
      }
    } catch (err) {
      console.error('[Memory] Maintenance failed:', err)
    }
  }

  runMemoryMaintenance()
  const maintenanceTimer = setInterval(runMemoryMaintenance, 6 * 60 * 60_000)
  ;(maintenanceTimer as unknown as { unref?: () => void }).unref?.()

  // M5：Tag / Vector / KG 索引维护任务。
  let tagMaintRunning = false
  const runTagMaintenance = () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if ((settings.memory.tagEnabled ?? true) === false) return
      if (tagMaintRunning) return
      tagMaintRunning = true
      const res = memoryService.runTagMaintenance(settings.memory, { batchSize: 80 })
      if (res.updated > 0) {
        console.info(`[Memory] TagIndex: scanned=${res.scanned} updated=${res.updated}`)
      }
    } catch (err) {
      console.error('[Memory] TagIndex failed:', err)
    } finally {
      tagMaintRunning = false
    }
  }

  let vectorMaintRunning = false
  const runVectorMaintenance = async () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if (!(settings.memory.vectorEnabled ?? false)) return
      if (vectorMaintRunning) return
      vectorMaintRunning = true
      const res = await memoryService.runVectorEmbeddingMaintenance(settings.memory, settings.ai, { batchSize: 8 })
      if (res.embedded > 0 || res.skipped > 0 || res.error) {
        console.info(
          `[Memory] VectorIndex: scanned=${res.scanned} embedded=${res.embedded} skipped=${res.skipped}${
            res.error ? ` error=${res.error}` : ''
          }`,
        )
      }
    } catch (err) {
      console.error('[Memory] VectorIndex failed:', err)
    } finally {
      vectorMaintRunning = false
    }
  }

  runTagMaintenance()
  void runVectorMaintenance()
  const tagTimer = setInterval(runTagMaintenance, 5_000)
  const vecTimer = setInterval(() => void runVectorMaintenance(), 5_000)
  ;(tagTimer as unknown as { unref?: () => void }).unref?.()
  ;(vecTimer as unknown as { unref?: () => void }).unref?.()

  let kgMaintRunning = false
  const runKgMaintenance = async () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if (!(settings.memory.kgEnabled ?? false)) return
      if (kgMaintRunning) return
      kgMaintRunning = true
      const res = await memoryService.runKgMaintenance(settings.memory, settings.ai, { batchSize: 2 })
      if (res.extracted > 0 || res.error) {
        console.info(
          `[Memory] KGIndex: scanned=${res.scanned} extracted=${res.extracted} skipped=${res.skipped}${res.error ? ` error=${res.error}` : ''}`,
        )
      }
    } catch (err) {
      console.error('[Memory] KGIndex failed:', err)
    } finally {
      kgMaintRunning = false
    }
  }

  void runKgMaintenance()
  const kgTimer = setInterval(() => void runKgMaintenance(), 7_000)
  ;(kgTimer as unknown as { unref?: () => void }).unref?.()

  registerIpc()

  // 启动后按 displayMode 恢复窗口形态，并在 orb 模式恢复 Orb UI 状态。
  windowManager.applyDisplayMode()
  if (getSettings().displayMode === 'orb') {
    broadcastOrbStateChanged(orbUiState)
    windowManager.setOrbUiState(orbUiState, { focus: false })
  }
  startLive2dMouseTrackingPump()
  createTray(windowManager)

  globalShortcut.register('CommandOrControl+Alt+C', () => {
    windowManager.ensureChatWindow()
  })

  globalShortcut.register('CommandOrControl+Alt+P', () => {
    const { clickThrough } = getSettings()
    windowManager.setClickThrough(!clickThrough)
    broadcastSettingsChanged()
  })

  syncAsrHotkey()
  broadcastSettingsChanged()
})

