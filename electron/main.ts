import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { getSettings, initializeSettingsStore, installSettingsSecretAdapter, setSettings } from './store'
import { createUserDataBackup, SettingsMigrationProtectionError } from './settingsMigrationSafety'
import {
  LocalMediaError,
  LocalMediaRegistry,
  localMediaTypeFromPath,
  type LocalMediaReference,
} from './localMediaRegistry'
import { LocalMediaServer } from './localMediaServer'
import { createTray } from './tray'
import { WindowManager } from './windowManager'
import { setWindowManagerInstance } from './runtimeRefs'
import { scanLive2dModels } from './modelScanner'
import { listTtsOptions } from './ttsOptions'
import { TaskService } from './taskService'
import { setLive2dCapabilitiesFromRenderer } from './live2dToolState'
import { closeAllBrowserControlServices } from './browserControlService'
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
  AIHttpRequestPayload,
  AIHttpStreamStartPayload,
  AICredentialRef,
  AsrSettings,
  DisplayMode,
  OrbUiState,
  McpStateSnapshot,
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
  SettingsNavigationTarget,
} from './types'
import { MemoryService } from './memoryService'
import { McpManager } from './mcpManager'
import { appendDebugLog, clearDebugLog, getDebugLogPath, initDebugLog, isDebugLogEnabled } from './debugLog'
import { AIHttpProxy, resolveAiCredential } from './aiHttpProxy'
import { createRendererSettings } from './rendererSettings'
import {
  hasManagedPlaintextSecrets,
  SettingsSecretStore,
  SettingsSecretStoreError,
} from './settingsSecretStore'
import {
  assertTrustedIpcSender,
  getIpcWindowPermission,
  IpcSecurityError,
  type IpcChannel,
} from './ipcPermissions'
import { registerSettingsIpc } from './ipc/registerSettingsIpc'
import { registerChatPersistenceIpc } from './ipc/registerChatPersistenceIpc'

const APP_ID = 'io.github.nishichengju.neodeskpet'
app.setName('NeoDeskPet')
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

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

function pickChatAttachmentExt(mimeType: string): string {
  const mime = (mimeType ?? '').trim().toLowerCase()
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/bmp') return '.bmp'
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/webm') return '.webm'
  if (mime === 'video/quicktime') return '.mov'
  if (mime === 'video/x-msvideo') return '.avi'
  if (mime === 'video/x-matroska') return '.mkv'
  return ''
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
} else {
  try {
    const settingsInitialization = initializeSettingsStore({
      userDataDir: app.getPath('userData'),
      targetVersion: app.getVersion(),
    })
    if (settingsInitialization.backupPath) {
      console.info(`[Store] user data backup created at ${settingsInitialization.backupPath}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const backupPath = error instanceof SettingsMigrationProtectionError ? error.backupPath : null
    const recovery = backupPath
      ? `\n\n原始数据已保留，完整备份位于：\n${backupPath}`
      : '\n\n程序未改写原始配置，请检查安装版本或配置文件。'
    dialog.showErrorBox('NeoDeskPet 配置升级失败', `${message}${recovery}`)
    app.exit(1)
    throw error
  }
}

const windowManager = new WindowManager({
  rendererDevUrl: VITE_DEV_SERVER_URL,
  rendererDistDir: RENDERER_DIST,
  mainDistDir: MAIN_DIST,
})

const SETTINGS_NAVIGATION_TARGETS = new Set<SettingsNavigationTarget>([
  'live2d',
  'bubble',
  'taskPanel',
  'aiConnection',
  'aiGeneration',
  'aiVision',
  'aiAgent',
  'tools',
  'novelai',
  'persona',
  'worldBook',
  'tts',
  'asr',
  'chat',
])
let pendingSettingsNavigationTarget: SettingsNavigationTarget | null = null
const aiHttpProxy = new AIHttpProxy(getSettings)
setWindowManagerInstance(windowManager)

type SettingsSecretInitializationResult = {
  aborted: boolean
  backupPath: string | null
  preservedUnreadablePath: string | null
}

async function initializeEncryptedSettingsSecrets(): Promise<SettingsSecretInitializationResult> {
  const userDataDir = app.getPath('userData')
  const current = getSettings()
  const needsPlaintextMigration = hasManagedPlaintextSecrets(current)
  const secretStore = new SettingsSecretStore(userDataDir, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  })
  let preservedUnreadablePath: string | null = null
  try {
    secretStore.initialize()
  } catch (error) {
    const recoverable =
      error instanceof SettingsSecretStoreError &&
      (error.code === 'invalid-file' || error.code === 'decrypt-failed')
    if (!recoverable) throw error

    const choice = await dialog.showMessageBox({
      type: 'error',
      title: 'NeoDeskPet 密钥无法解密',
      message: '当前系统账户无法读取已保存的 API 密钥。',
      detail:
        `${error.message}\n\n密钥文件：${error.filePath}\n\n` +
        '选择“重置密钥并启动”会保留故障文件，只清空不可用的密钥；聊天、记忆和其他设置不会被删除。启动后请在设置页重新输入 API Key。',
      buttons: ['退出程序', '重置密钥并启动'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice.response !== 1) {
      return { aborted: true, backupPath: null, preservedUnreadablePath: null }
    }
    preservedUnreadablePath = secretStore.preserveUnreadableFile()
    secretStore.initialize()
  }

  let backupPath: string | null = null
  if (needsPlaintextMigration) {
    const version = app.getVersion()
    backupPath = createUserDataBackup(userDataDir, {
      status: 'current',
      previousVersion: version,
      targetVersion: version,
    }).directory
  }

  installSettingsSecretAdapter(secretStore)
  return { aborted: false, backupPath, preservedUnreadablePath }
}

const LIVE2D_MOUSE_POLL_MS = 33
let live2dMouseTrackingTimer: NodeJS.Timeout | null = null
let browserControlServicesClosed = false
let browserControlServicesClosing: Promise<void> | null = null

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

let localMediaRegistry: LocalMediaRegistry | null = null
let localMediaServer: LocalMediaServer | null = null

function getLocalMediaRegistry(): LocalMediaRegistry {
  if (localMediaRegistry) return localMediaRegistry
  const userDataDir = app.getPath('userData')
  const managedDirectories = [
    'chat-attachments',
    'task-output',
    'screenshots',
    'browser-screenshots',
    'mcp-tool-images',
    'generated-images',
    'video-qa',
    'video-qa-cache',
  ]
  localMediaRegistry = new LocalMediaRegistry({
    allowedRoots: managedDirectories.map((directory) => path.join(userDataDir, directory)),
  })
  return localMediaRegistry
}

function getLocalMediaServer(): LocalMediaServer {
  if (!localMediaServer) localMediaServer = new LocalMediaServer(getLocalMediaRegistry())
  return localMediaServer
}

function parseLocalMediaReference(payload: unknown): LocalMediaReference {
  const normalizePathReference = (value: string): string => {
    const raw = value.trim()
    if (!raw || path.isAbsolute(raw) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw
    return path.resolve(app.getPath('userData'), raw)
  }
  if (typeof payload === 'string') return normalizePathReference(payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const value = payload as Record<string, unknown>
  return {
    resourceId: typeof value.resourceId === 'string' ? value.resourceId.trim() : '',
    path: typeof value.path === 'string' ? normalizePathReference(value.path) : '',
  }
}

function toPublicLocalMediaError(error: unknown): Error {
  if (!(error instanceof LocalMediaError)) return new Error('Local media request failed')
  if (error.code === 'forbidden_path') return new Error('Local media path is not allowed')
  if (error.code === 'file_too_large') return new Error('Local media file is too large')
  if (error.code === 'unsupported_type') return new Error('Local media type is not supported')
  return new Error('Local media resource is unavailable')
}

let registeredAsrHotkey: string | null = null
let pendingAsrTranscript: string[] = []
let asrTranscriptReadyWebContentsId: number | null = null
let lastContextUsage: ContextUsageSnapshot | null = null

const OPEN_TYPELESS_MANAGED_ASR_SCRIPT_DIR = path.join(process.env.APP_ROOT, 'OpenTypeless-main')
const OPEN_TYPELESS_MANAGED_ASR_SCRIPT_FILE = path.join(OPEN_TYPELESS_MANAGED_ASR_SCRIPT_DIR, 'doubao_asr_api.py')
const OPEN_TYPELESS_MANAGED_ASR_WS_PATH_RE = /^\/demo\/ws\/realtime\/?$/

type ManagedAsrEndpoint = {
  host: string
  port: number
  protocol: 'ws:' | 'wss:'
  healthUrl: string
  key: string
}

let managedAsrProcess: ChildProcess | null = null
let managedAsrProcessEndpointKey: string | null = null
let managedAsrStartPromise: Promise<void> | null = null
let managedAsrLastSuccessfulLauncher: string | null = null
const managedAsrFailedLaunchers = new Set<string>()

function parseManagedAsrEndpoint(asr: AsrSettings | undefined | null): ManagedAsrEndpoint | null {
  if (!asr) return null
  const rawWsUrl = String(asr.wsUrl ?? '').trim()
  if (!rawWsUrl) return null

  try {
    const u = new URL(rawWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    if (!OPEN_TYPELESS_MANAGED_ASR_WS_PATH_RE.test(u.pathname)) return null
    const host = String(u.hostname ?? '').trim().toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost') return null
    const portRaw = u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80
    if (!Number.isFinite(portRaw) || portRaw <= 0) return null
    const port = Math.trunc(portRaw)
    const httpProto = u.protocol === 'wss:' ? 'https:' : 'http:'
    return {
      host,
      port,
      protocol: u.protocol,
      healthUrl: `${httpProto}//${host}:${port}/health`,
      key: `${host}:${port}`,
    }
  } catch {
    return null
  }
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(ms))))
}

async function probeAsrHealth(
  endpoint: ManagedAsrEndpoint,
  opts?: { timeoutMs?: number; child?: ChildProcess | null },
): Promise<boolean> {
  const timeoutMs = Math.max(200, Math.trunc(opts?.timeoutMs ?? 1200))
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const child = opts?.child
    if (child && child.exitCode !== null) return false

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 800)
    try {
      const res = await fetch(endpoint.healthUrl, { method: 'GET', cache: 'no-store', signal: ac.signal })
      if (res.ok) return true
    } catch {
      // ignore
    } finally {
      clearTimeout(timer)
    }

    await delayMs(200)
  }

  return false
}

async function stopManagedAsrApi(reason: string): Promise<void> {
  const child = managedAsrProcess
  managedAsrProcess = null
  managedAsrProcessEndpointKey = null
  managedAsrStartPromise = null
  if (!child) return
  if (child.exitCode !== null) return

  console.info(`[ASR API] stopping (${reason}) pid=${child.pid ?? 'unknown'}`)
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      done()
    }, 2500)

    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })

    // Windows 下通过 shell 启动时，child 可能只是 cmd.exe；直接 child.kill() 可能留下 uv/python 子进程。
    // 使用 taskkill /T /F 结束整个进程树，避免 ASR 服务残留占用端口。
    const childPid = typeof child.pid === 'number' && Number.isFinite(child.pid) ? child.pid : 0
    if (process.platform === 'win32' && childPid > 0) {
      try {
        const killer = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.once('error', () => {
          try {
            child.kill()
          } catch {
            // ignore
          }
        })
      } catch {
        try {
          child.kill()
        } catch {
          clearTimeout(timer)
          done()
        }
      }
      return
    }

    try {
      child.kill()
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}

async function closeBrowserControlServicesOnce(): Promise<void> {
  if (browserControlServicesClosed) return
  if (!browserControlServicesClosing) {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 3_000)
    })
    browserControlServicesClosing = Promise.race([closeAllBrowserControlServices(), timeout])
      .catch((err) => {
        console.warn('[BrowserControl] close failed:', err)
      })
      .then(() => {
        browserControlServicesClosed = true
      })
  }
  await browserControlServicesClosing
}

async function launchManagedAsrProcess(endpoint: ManagedAsrEndpoint): Promise<void> {
  // opuslib 在 Windows 上用 ctypes.util.find_library('opus')，只查 PATH 里的 opus.dll。
  // 把放了 opus.dll 的脚本目录加到 PATH 最前面，子进程才能找到。
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const basePath = process.env.PATH ?? process.env.Path ?? ''
  const augmentedPath = `${OPEN_TYPELESS_MANAGED_ASR_SCRIPT_DIR}${pathSep}${basePath}`

  const env = {
    ...process.env,
    PATH: augmentedPath,
    DOUBAO_ASR_HOST: endpoint.host,
    DOUBAO_ASR_PORT: String(endpoint.port),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    UV_NO_PROGRESS: '1',
    NO_COLOR: '1',
  }

  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [
    {
      cmd: 'C:\\Users\\Administrator\\scoop\\shims\\uv.exe',
      args: [
        'run',
        '--python',
        'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
        'doubao_asr_api.py',
      ],
      label: 'uv run --python Python311 doubao_asr_api.py',
    },
    {
      cmd: 'uv',
      args: [
        'run',
        '--python',
        'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
        'doubao_asr_api.py',
      ],
      label: 'uv (PATH) run --python Python311 doubao_asr_api.py',
    },
    ...(process.platform === 'win32' ? [{ cmd: 'py', args: ['-3', 'doubao_asr_api.py'], label: 'py -3 doubao_asr_api.py' }] : []),
    { cmd: 'python', args: ['doubao_asr_api.py'], label: 'python doubao_asr_api.py' },
  ].sort((a, b) => {
    const score = (x: { label: string }) => {
      if (managedAsrLastSuccessfulLauncher && x.label === managedAsrLastSuccessfulLauncher) return 0
      if (managedAsrFailedLaunchers.has(x.label)) return 2
      return 1
    }
    return score(a) - score(b)
  })

  let lastError: Error | null = null

  for (const candidate of candidates) {
    let child: ChildProcess | null = null
    try {
      child = await new Promise<ChildProcess>((resolve, reject) => {
        const launched = spawn(candidate.cmd, candidate.args, {
          cwd: OPEN_TYPELESS_MANAGED_ASR_SCRIPT_DIR,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Windows 下必须开 shell 让 cmd 帮忙查找 .exe/.cmd/.shim 后缀，否则 spawn('uv') 找不到 scoop/py launcher 这类 shim
          shell: process.platform === 'win32',
        })

        launched.once('error', reject)
        launched.once('spawn', () => resolve(launched))
      })
    } catch (err) {
      managedAsrFailedLaunchers.add(candidate.label)
      lastError = err instanceof Error ? err : new Error(String(err))
      continue
    }

    const onStdout = (chunk: unknown) => {
      const text = String(chunk ?? '').trim()
      if (!text) return
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (s) console.info(`[ASR API] ${s}`)
      }
    }
    const onStderr = (chunk: unknown) => {
      // Windows 下 cmd/uv 的错误消息可能是 GBK 编码，按 UTF-8 解码会变成 ???。
      // 用 latin1 保留原始字节，至少英文/ASCII 错误码可读；Python 程序自身用 PYTHONIOENCODING=utf-8 不受影响。
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      const textUtf8 = buf.toString('utf-8').trim()
      const textLatin1 = buf.toString('latin1').trim()
      const text = textUtf8.includes('\uFFFD') || /\?{3,}/.test(textUtf8) ? textLatin1 : textUtf8
      if (!text) return
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (s) console.warn(`[ASR API] ${s}`)
      }
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('exit', (code, signal) => {
      if (managedAsrProcess === child) {
        managedAsrProcess = null
        managedAsrProcessEndpointKey = null
      }
      console.info(
        `[ASR API] exited (${candidate.label}) pid=${child?.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      )
    })

    managedAsrProcess = child
    managedAsrProcessEndpointKey = endpoint.key
    console.info(`[ASR API] starting (${candidate.label}) on ${endpoint.key}`)

    const ok = await probeAsrHealth(endpoint, { timeoutMs: 15_000, child })
    if (ok) {
      managedAsrLastSuccessfulLauncher = candidate.label
      managedAsrFailedLaunchers.delete(candidate.label)
      return
    }

    managedAsrFailedLaunchers.add(candidate.label)
    lastError = new Error(`ASR API failed health check after start: ${candidate.label}`)
    await stopManagedAsrApi(`health-check-failed:${candidate.label}`)
  }

  throw lastError ?? new Error('No available command could start OpenTypeless ASR API')
}

async function ensureManagedAsrApiRunning(reason: string): Promise<void> {
  const settings = getSettings()
  const endpoint = parseManagedAsrEndpoint(settings.asr)
  if (!settings.asr?.enabled || !endpoint) {
    await stopManagedAsrApi(`${reason}:disabled-or-external`)
    return
  }

  if (managedAsrProcess && managedAsrProcess.exitCode !== null) {
    managedAsrProcess = null
    managedAsrProcessEndpointKey = null
  }

  if (managedAsrProcess && managedAsrProcessEndpointKey && managedAsrProcessEndpointKey !== endpoint.key) {
    await stopManagedAsrApi(`${reason}:endpoint-changed`)
  }

  if (managedAsrProcess && managedAsrProcessEndpointKey === endpoint.key) {
    const ok = await probeAsrHealth(endpoint, { timeoutMs: 1200, child: managedAsrProcess })
    if (ok) return
    await stopManagedAsrApi(`${reason}:unhealthy`)
  }

  const externalReady = await probeAsrHealth(endpoint, { timeoutMs: 500 })
  if (externalReady) {
    console.info(`[ASR API] detected existing OpenTypeless service on ${endpoint.key}; skip managed startup`)
    return
  }

  if (managedAsrStartPromise) {
    await managedAsrStartPromise
    return
  }

  managedAsrStartPromise = (async () => {
    try {
      await fs.access(OPEN_TYPELESS_MANAGED_ASR_SCRIPT_FILE)
      await launchManagedAsrProcess(endpoint)
    } finally {
      managedAsrStartPromise = null
    }
  })()

  await managedAsrStartPromise
}

async function syncManagedAsrApi(reason: string): Promise<void> {
  try {
    await ensureManagedAsrApiRunning(reason)
  } catch (err) {
    console.error('[ASR API] sync failed:', err)
  }
}

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
// 索引维护调度入口（whenReady 内赋值），供设置变更等处触发一次补扫
let kickMemoryIndexMaintenance: (() => void) | null = null
let taskService: TaskService | null = null
let mcpManager: McpManager | null = null

function broadcastSettingsChanged() {
  const settings = createRendererSettings(getSettings())
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

function isAppSettingsResult(value: unknown): value is ReturnType<typeof getSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.ai != null && candidate.memory != null && candidate.orchestrator != null && candidate.chatProfile != null
}

function protectIpcResult(channel: IpcChannel, value: unknown): unknown {
  if (!channel.startsWith('settings:') || !isAppSettingsResult(value)) return value
  return createRendererSettings(value)
}

type TrustedIpcEvent = IpcMainInvokeEvent | IpcMainEvent

function assertIpcEventTrusted(channel: IpcChannel, event: TrustedIpcEvent): void {
  const senderWindowType = windowManager.getWindowTypeByWebContentsId(event.sender.id)
  const senderFrame = event.senderFrame
  const frameUrl = senderFrame?.url ?? ''
  const webContentsUrl = event.sender.getURL()

  try {
    assertTrustedIpcSender({
      channel,
      senderWindowType,
      allowed: getIpcWindowPermission(channel),
      isMainFrame: senderFrame != null && senderFrame === event.sender.mainFrame,
      isFrameUrlTrusted: senderWindowType != null && windowManager.isTrustedWindowUrl(frameUrl, senderWindowType),
      isWebContentsUrlTrusted:
        senderWindowType != null && windowManager.isTrustedWindowUrl(webContentsUrl, senderWindowType),
    })
  } catch (error) {
    const securityError =
      error instanceof IpcSecurityError
        ? error
        : new IpcSecurityError(channel, senderWindowType, 'unknown-sender')
    const details = {
      channel,
      reason: securityError.reason,
      senderWindowType: senderWindowType ?? 'unknown',
      webContentsId: event.sender.id,
      frameUrl,
      webContentsUrl,
    }
    try {
      appendDebugLog('security', 'ipc.denied', details)
    } catch {
      // Security rejection must not depend on debug logging.
    }
    console.warn('[IPC Security] Request denied:', details)
    throw securityError
  }
}

function handleIpc<Args extends unknown[], Result>(
  channel: IpcChannel,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertIpcEventTrusted(channel, event)
    const result = listener(event, ...(args as Args))
    if (result instanceof Promise) {
      return result.then((value) => protectIpcResult(channel, value))
    }
    return protectIpcResult(channel, result)
  })
}

function onIpc<Args extends unknown[]>(
  channel: IpcChannel,
  listener: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertIpcEventTrusted(channel, event)
    } catch {
      return
    }
    listener(event, ...(args as Args))
  })
}

function registerIpc() {
  // Debug log：导出调试日志路径并支持清空
  handleIpc('debug:getPath', () => getDebugLogPath())
  handleIpc('debug:clear', () => {
    clearDebugLog()
    return { ok: true, path: getDebugLogPath() }
  })
  onIpc('debug:append', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const event = typeof p.event === 'string' ? p.event : 'unknown'
    appendDebugLog('renderer', event, p.data)
  })

  registerSettingsIpc({
    handle: handleIpc,
    getSettings,
    setSettings,
    consumeNavigationTarget: () => {
      const target = pendingSettingsNavigationTarget
      pendingSettingsNavigationTarget = null
      return target
    },
    broadcastSettingsChanged,
    windowManager,
    kickMemoryIndexMaintenance: () => kickMemoryIndexMaintenance?.(),
    syncMcpSettings: (settings) => {
      void mcpManager?.sync(settings)
    },
    syncManagedAsrApi,
    syncAsrHotkey,
  })

  handleIpc('ai:listModels', async (_event, payload: { credential?: AICredentialRef } | null | undefined) => {
    const credential = resolveAiCredential(getSettings(), payload?.credential ?? { kind: 'main' })
    const apiMode = credential.apiMode
    const baseUrl = normalizeOpenAiBaseUrl(credential.baseUrl)
    const apiKey = credential.apiKey
    if (!baseUrl) return { ok: false, models: [] as string[], error: 'baseUrl 不能为空' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiMode === 'claude') {
        headers['anthropic-version'] = '2023-06-01'
        if (apiKey) headers['x-api-key'] = apiKey
      } else if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
      }
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

  handleIpc('mcp:getState', () => {
    return mcpManager?.getSnapshot() ?? { enabled: false, servers: [], updatedAt: Date.now() }
  })

  // Context usage snapshot (chat -> main -> pet/chat)
  onIpc('contextUsage:set', (_event, snapshot: ContextUsageSnapshot | null) => {
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

  handleIpc('contextUsage:get', () => lastContextUsage)

  // Model scanner - scan live2d directory for available models
  handleIpc('models:scan', () => {
    return scanLive2dModels()
  })

  handleIpc('ai:httpRequest', (_event, payload: AIHttpRequestPayload) => aiHttpProxy.request(payload))
  handleIpc('ai:httpStreamStart', (event, payload: AIHttpStreamStartPayload) =>
    aiHttpProxy.startStream(event.sender, payload),
  )
  handleIpc('ai:httpStreamCancel', (event, streamId: string) => aiHttpProxy.cancelStream(event.sender.id, streamId))

  registerChatPersistenceIpc({
    handle: handleIpc,
    chatStore: {
      listChatSessions,
      getChatSession,
      createChatSession,
      setCurrentChatSession,
      renameChatSession,
      deleteChatSession,
      clearChatSession,
      setChatMessages,
      addChatMessage,
      updateChatMessage,
      updateChatMessageRecord,
      deleteChatMessage,
      setChatSessionAutoExtractCursor,
      setChatSessionAutoExtractMeta,
    },
    getSettings,
    getMemoryService: () => memoryService,
  })

  // Chat attachments: persist dropped/pasted media into userData for stable paths.
  handleIpc('chat:saveAttachment', async (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const kind = p.kind === 'image' || p.kind === 'video' ? (p.kind as 'image' | 'video') : ''
    if (!kind) throw new Error('invalid kind')

    const sourcePath = typeof p.sourcePath === 'string' ? p.sourcePath.trim() : ''
    const dataUrl = typeof p.dataUrl === 'string' ? p.dataUrl.trim() : ''
    const filename = typeof p.filename === 'string' ? p.filename.trim() : ''

    if (!sourcePath && !dataUrl) throw new Error('missing sourcePath/dataUrl')

    const baseDir = path.join(app.getPath('userData'), 'chat-attachments')
    await fs.mkdir(baseDir, { recursive: true })

    let ext = ''
    let detectedMime = ''
    let contentBytes = 0
    if (sourcePath) {
      if (process.platform === 'win32' && /^\\\\/.test(sourcePath)) throw new Error('UNC attachments are not supported')
      const sourceType = localMediaTypeFromPath(sourcePath)
      if (!sourceType || sourceType.kind !== kind) throw new Error('unsupported attachment type')
      const sourceStat = await fs.stat(sourcePath)
      if (!sourceStat.isFile()) throw new Error('attachment source is not a file')
      contentBytes = sourceStat.size
      detectedMime = sourceType.mimeType
      ext = path.extname(sourcePath).toLowerCase()
    } else {
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) throw new Error('invalid dataUrl')
      detectedMime = parsed.mimeType
      ext = pickChatAttachmentExt(detectedMime)
      const expectedKind = detectedMime.startsWith('image/') ? 'image' : detectedMime.startsWith('video/') ? 'video' : ''
      if (!ext || expectedKind !== kind) throw new Error('unsupported attachment type')
      contentBytes = Buffer.byteLength(parsed.base64, 'base64')
    }

    const maxBytes = kind === 'image' ? 32 * 1024 * 1024 : 4 * 1024 * 1024 * 1024
    if (contentBytes <= 0 || contentBytes > maxBytes) throw new Error('attachment file is too large')

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

    const resource = await getLocalMediaRegistry().registerFile(storedPath)

    return {
      ok: true as const,
      kind,
      path: storedPath,
      resourceId: resource.id,
      filename: filename || storedName,
      ...(detectedMime ? { mimeType: detectedMime } : {}),
    }
  })

  // Chat attachments: resolve managed images through the main-process media registry.
  handleIpc('chat:readAttachmentDataUrl', async (_event, payload: unknown) => {
    try {
      const result = await getLocalMediaServer().readDataUrl(parseLocalMediaReference(payload))
      return { ok: true as const, ...result }
    } catch (error) {
      throw toPublicLocalMediaError(error)
    }
  })

  handleIpc('chat:getAttachmentUrl', async (_event, payload: unknown) => {
    try {
      const result = await getLocalMediaServer().getUrl(parseLocalMediaReference(payload))
      return { ok: true as const, ...result }
    } catch (error) {
      throw toPublicLocalMediaError(error)
    }
  })

  // Tasks / Orchestrator (M1)
  handleIpc('task:list', (): TaskListResult => taskService?.listTasks() ?? { items: [] })
  handleIpc('task:get', (_event, id: string): TaskRecord | null => taskService?.getTask(id) ?? null)
  handleIpc(
    'task:updateToolRunImages',
    (_event, taskId: string, runId: string, imagePaths: string[]): TaskRecord | null =>
      taskService?.updateToolRunImages(taskId, runId, imagePaths) ?? null,
  )
  handleIpc('task:create', (_event, args: TaskCreateArgs): TaskRecord => {
    if (!taskService) throw new Error('Task service not ready')
    return taskService.createTask(args)
  })
  handleIpc('task:pause', (_event, id: string): TaskRecord | null => taskService?.pauseTask(id) ?? null)
  handleIpc('task:resume', (_event, id: string): TaskRecord | null => taskService?.resumeTask(id) ?? null)
  handleIpc('task:cancel', (_event, id: string): TaskRecord | null => taskService?.cancelTask(id) ?? null)
  handleIpc('task:dismiss', (_event, id: string): { ok: true } | null => taskService?.dismissTask(id) ?? null)

  // Long-term memory / personas
  handleIpc('memory:listPersonas', (): PersonaSummary[] => memoryService?.listPersonas() ?? [])
  handleIpc('memory:getPersona', (_event, personaId: string): Persona | null => memoryService?.getPersona(personaId) ?? null)
  handleIpc('memory:createPersona', (_event, name: string): Persona => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.createPersona(name)
  })
  handleIpc(
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
  handleIpc('memory:deletePersona', (_event, personaId: string): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    memoryService.deletePersona(personaId)
    return { ok: true }
  })
  handleIpc('memory:retrieve', async (_event, args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => {
    if (!memoryService) return { addon: '' }
    const settings = getSettings()
    if (!settings.memory.enabled) return { addon: '' }
    return memoryService.retrieveContext(args, settings.memory, settings.ai)
  })
  handleIpc('memory:list', (_event, args: MemoryListArgs): MemoryListResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemory(args)
  })
  handleIpc('memory:upsertManual', async (_event, args: MemoryUpsertManualArgs): Promise<MemoryRecord> => {
    if (!memoryService) throw new Error('Memory service not ready')
    const settings = getSettings()
    return memoryService.upsertManualMemory(args, settings.memory, settings.ai)
  })
  handleIpc('memory:update', (_event, args: MemoryUpdateArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemory(args)
  })
  handleIpc('memory:updateMeta', (_event, args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryMeta(args)
  })
  handleIpc('memory:updateManyMeta', (_event, args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateManyMemoryMeta(args)
  })
  handleIpc('memory:updateByFilterMeta', (_event, args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryByFilterMeta(args)
  })
  handleIpc('memory:listVersions', (_event, args: MemoryListVersionsArgs): MemoryVersionRecord[] => {
    if (!memoryService) return []
    return memoryService.listMemoryVersions(args)
  })
  handleIpc('memory:rollbackVersion', (_event, args: MemoryRollbackVersionArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.rollbackMemoryVersion(args)
  })
  handleIpc('memory:listConflicts', (_event, args: MemoryListConflictsArgs): MemoryListConflictsResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemoryConflicts(args)
  })
  handleIpc('memory:resolveConflict', (_event, args: MemoryResolveConflictArgs): MemoryResolveConflictResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.resolveMemoryConflict(args)
  })
  handleIpc('memory:delete', (_event, args: MemoryDeleteArgs): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemory(args)
  })
  handleIpc('memory:deleteMany', (_event, args: MemoryDeleteManyArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteManyMemory(args)
  })
  handleIpc('memory:deleteByFilter', (_event, args: MemoryDeleteByFilterArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemoryByFilter(args)
  })

  // TTS options (scan local GPT-SoVITS directory)
  handleIpc('tts:listOptions', () => {
    const settings = getSettings()
    const configured = (settings.tts?.ttsRoot ?? '').trim()
    const ttsRoot = configured || path.join(process.env.APP_ROOT ?? process.cwd(), 'GPT-SoVITS-v2_ProPlus')
    return listTtsOptions(ttsRoot)
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

  handleIpc('tts:httpGetJson', async (_event, rawUrl: string) => {
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

  handleIpc(
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

  handleIpc(
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

  handleIpc('tts:httpStreamCancel', (_event, streamId: string) => {
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
  onIpc('live2d:triggerExpression', (_event, expressionName: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:expression', expressionName)
    }
  })

  onIpc('live2d:triggerMotion', (_event, motionGroup: string, index: number) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:motion', motionGroup, index)
    }
  })

  // Live2D capabilities - report from pet window (for tools/agent)
  onIpc('live2d:capabilities', (_event, payload: unknown) => {
    const res = setLive2dCapabilitiesFromRenderer(payload)
    if (!res.ok) {
      console.warn('[Live2D] capabilities report rejected:', res.error)
    }
  })

  // Bubble message - forward from chat window to pet window
  onIpc('bubble:sendMessage', (_event, message: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('bubble:message', message)
    }
  })

  // Bubble preview (chat -> pet): 仅用于实时可视化占位/流式文本，不触发 TTS。
  onIpc('bubble:preview', (_event, payload: unknown) => {
    const petWin = windowManager.getPetWindow()
    if (!petWin || petWin.isDestroyed()) return

    const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const text = typeof obj.text === 'string' ? obj.text : ''
    const clear = obj.clear === true
    const placeholder = obj.placeholder === true
    const pinPrevious = obj.pinPrevious === true
    const autoHideDelay =
      typeof obj.autoHideDelay === 'number' && Number.isFinite(obj.autoHideDelay) ? Math.trunc(obj.autoHideDelay) : undefined

    petWin.webContents.send('bubble:preview', {
      ...(text ? { text } : {}),
      ...(clear ? { clear: true } : {}),
      ...(placeholder ? { placeholder: true } : {}),
      ...(pinPrevious ? { pinPrevious: true } : {}),
      ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
    })
  })

  // ASR 文本转发：从桌宠窗口发往聊天窗口（手动模式也会使用）。
  onIpc('asr:reportTranscript', (_event, text: string) => {
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

  handleIpc('asr:takeTranscript', () => {
    const text = pendingAsrTranscript.join(' ').trim()
    pendingAsrTranscript = []
    return text
  })

  onIpc('asr:transcriptReady', (event) => {
    const chatWin = windowManager.getChatWindow()
    if (!chatWin || chatWin.isDestroyed()) return
    if (event.sender.id !== chatWin.webContents.id) return
    asrTranscriptReadyWebContentsId = event.sender.id
  })

  // Chat -> Pet: sync current ASR compose baseline (used to keep subtitle accumulation aligned with chat input edits)
  onIpc('asr:composePreviewSync', (_event, payload: unknown) => {
    const petWin = windowManager.getPetWindow()
    if (!petWin || petWin.isDestroyed()) return

    const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const baseText = typeof obj.baseText === 'string' ? obj.baseText : ''
    const clearFinals = obj.clearFinals === true
    petWin.webContents.send('asr:composePreviewSync', { baseText, clearFinals })
  })

  // TTS segmented sync: forward utterance segments to pet window
  onIpc('tts:enqueue', (_event, payload: unknown) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:enqueue', payload)
    }
  })

  onIpc('tts:finalize', (_event, utteranceId: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:finalize', utteranceId)
    }
  })

  onIpc('tts:stopAll', () => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:stopAll')
    }
  })

  // Pet -> Chat: segment started / ended / failed
  onIpc('tts:segmentStarted', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:segmentStarted', payload)
    }
  })

  onIpc('tts:utteranceEnded', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceEnded', payload)
    }
  })

  onIpc('tts:utteranceFailed', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceFailed', payload)
    }
  })

  handleIpc('window:openChat', () => {
    windowManager.ensureChatWindow()
  })
  handleIpc('window:openSettings', (_event, targetRaw?: unknown) => {
    const target = typeof targetRaw === 'string' && SETTINGS_NAVIGATION_TARGETS.has(targetRaw as SettingsNavigationTarget)
      ? (targetRaw as SettingsNavigationTarget)
      : null
    if (target) pendingSettingsNavigationTarget = target
    const existing = windowManager.getSettingsWindow()
    const win = windowManager.ensureSettingsWindow()
    if (!target) return
    if (existing && !win.webContents.isLoadingMainFrame()) win.webContents.send('settings:navigate', target)
  })
  handleIpc('window:openMemory', () => {
    windowManager.ensureMemoryWindow()
  })

  // 显示模式切换入口：支持 live2d / orb / hidden。
  handleIpc('window:setDisplayMode', (_event, modeRaw: unknown) => {
    const mode = typeof modeRaw === 'string' ? (modeRaw.trim() as DisplayMode) : ''
    if (mode !== 'live2d' && mode !== 'orb' && mode !== 'hidden') return
    windowManager.setDisplayMode(mode)
    if (mode === 'orb') {
      // 切换到 orb 时同步 Orb UI 状态，避免窗口状态不一致。
      broadcastOrbStateChanged(orbUiState)
      windowManager.setOrbUiState(orbUiState, { focus: true, animate: false })
    }
    broadcastSettingsChanged()
  })
  handleIpc('window:hideAll', () => {
    windowManager.hideAll()
  })

  // Close current window (not all windows)
  handleIpc('window:closeCurrent', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })

  handleIpc('app:quit', () => {
    app.quit()
  })

  // =====================
  // Orb（球/条/面板）IPC
  // =====================

  handleIpc('orb:getUiState', () => {
    return { state: orbUiState }
  })

  handleIpc('orb:setUiState', (_event, stateRaw: unknown, optsRaw: unknown) => {
    const state = typeof stateRaw === 'string' ? (stateRaw.trim() as OrbUiState) : ''
    if (state !== 'ball' && state !== 'bar' && state !== 'panel') return { state: orbUiState }

    const opts = optsRaw && typeof optsRaw === 'object' && !Array.isArray(optsRaw)
      ? (optsRaw as { focus?: unknown; animate?: unknown })
      : null
    const focus = opts ? Boolean(opts.focus) : false
    const animate = opts ? Boolean(opts.animate) : false

    orbUiState = state
    windowManager.setOrbUiState(state, { focus, animate })
    broadcastOrbStateChanged(state)
    return { state }
  })

  handleIpc('orb:toggleUiState', () => {
    const next: OrbUiState = orbUiState === 'ball' ? 'bar' : orbUiState === 'bar' ? 'panel' : 'ball'
    orbUiState = next
    windowManager.setOrbUiState(next, { focus: true, animate: false })
    broadcastOrbStateChanged(next)
    return { state: next }
  })

  handleIpc('orb:setOverlayBounds', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
    const width = typeof p?.width === 'number' ? p.width : Number.NaN
    const height = typeof p?.height === 'number' ? p.height : Number.NaN
    const focus = Boolean(p?.focus)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: true }
    windowManager.setOrbOverlayBounds({ width, height, focus })
    return { ok: true }
  })

  handleIpc('orb:clearOverlayBounds', (_event, payload: unknown) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
    const focus = Boolean(p?.focus)
    windowManager.clearOrbOverlayBounds({ focus })
    return { ok: true }
  })

  handleIpc('orb:showContextMenu', (_event, point: unknown) => {
    const p = point && typeof point === 'object' && !Array.isArray(point) ? (point as Record<string, unknown>) : null
    const x = typeof p?.x === 'number' ? p.x : Number.NaN
    const y = typeof p?.y === 'number' ? p.y : Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: true }
    windowManager.showOrbContextMenu({ x, y })
    return { ok: true }
  })

  // Window drag support (event-driven): renderer sends start/move/stop with screen coords.
  onIpc('window:startDrag', (event, payload: unknown) => {
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

  onIpc('window:dragMove', (event, payload: unknown) => {
    const session = windowDragSessions.get(event.sender.id)
    if (!session) return
    const cursor = parseDragPoint(payload) ?? screen.getCursorScreenPoint()
    applyWindowDragMove(session, cursor)
  })

  onIpc('window:stopDrag', (event, payload: unknown) => {
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

    if (session.isPetWindow) {
      try {
        windowManager.persistPetBoundsNow()
      } catch {
        // ignore
      }
    }

    cleanupWindowDragSession(session, { snapOrb: true })
  })
  // Pet window context menu
  onIpc('pet:showContextMenu', (event) => {
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
          void syncManagedAsrApi('menu:toggle-asr')
          syncAsrHotkey()
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
  onIpc('pet:setOverlayHover', (event, hovering: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const petWin = windowManager.getPetWindow()
    if (!win || !petWin) return
    if (win.id !== petWin.id) return
    windowManager.setPetOverlayHover(Boolean(hovering))
  })

  // Pet model hover: 渲染进程对 Live2D 画布做像素级命中检测后上报，
  // 主进程据此在点击穿透模式下切换 ignoreMouseEvents（事件驱动，无轮询）。
  onIpc('pet:setModelHover', (event, hovering: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const petWin = windowManager.getPetWindow()
    if (!win || !petWin) return
    if (win.id !== petWin.id) return
    windowManager.setPetModelHover(Boolean(hovering))
  })

  // Dynamic mouse events ignore for transparent click-through
  onIpc('window:setIgnoreMouseEvents', (event, ignore: boolean, forward: boolean) => {
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

app.on('before-quit', (event) => {
  try {
    windowManager.setAppQuitting(true)
  } catch (_) {
    /* ignore */
  }

  if (!browserControlServicesClosed) {
    event.preventDefault()
    void closeBrowserControlServicesOnce().finally(() => {
      app.quit()
    })
    return
  }

  void stopManagedAsrApi('app:before-quit')
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  aiHttpProxy.close()
  void localMediaServer?.close()
  localMediaServer = null
  localMediaRegistry = null
  if (live2dMouseTrackingTimer) {
    clearInterval(live2dMouseTrackingTimer)
    live2dMouseTrackingTimer = null
  }
  void stopManagedAsrApi('app:will-quit')
  void mcpManager?.sync({ enabled: false, servers: [] })
})

app.whenReady().then(async () => {
  try {
    const secretInitialization = await initializeEncryptedSettingsSecrets()
    if (secretInitialization.aborted) {
      app.exit(1)
      return
    }
    if (secretInitialization.backupPath) {
      console.info(`[Secrets] plaintext settings backup created at ${secretInitialization.backupPath}`)
    }
    if (secretInitialization.preservedUnreadablePath) {
      console.warn(`[Secrets] unreadable encrypted secret file preserved at ${secretInitialization.preservedUnreadablePath}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Secrets] initialization failed:', error)
    dialog.showErrorBox(
      'NeoDeskPet 密钥存储初始化失败',
      `${message}\n\n程序未清除原始配置。请确认当前系统账户可以使用系统凭据加密后重试。`,
    )
    app.exit(1)
    return
  }

  initDebugLog({
    userDataDir: app.getPath('userData'),
    enabled: !app.isPackaged,
  })
  if (isDebugLogEnabled()) {
    console.info(`[DebugLog] enabled, path=${getDebugLogPath()}`)
  }

  process.on('uncaughtException', (err) => {
    try {
      appendDebugLog('main', 'process.uncaughtException', {
        message: err?.message ?? String(err),
        stack: err?.stack ?? '',
      })
    } catch {
      // ignore
    }
    console.error('[Main] uncaughtException:', err)
  })

  process.on('unhandledRejection', (reason) => {
    try {
      const err = reason instanceof Error ? reason : new Error(String(reason))
      appendDebugLog('main', 'process.unhandledRejection', {
        message: err.message,
        stack: err.stack ?? '',
      })
    } catch {
      // ignore
    }
    console.error('[Main] unhandledRejection:', reason)
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    try {
      appendDebugLog('main', 'app.render-process-gone', {
        wcId: webContents.id,
        url: webContents.getURL(),
        reason: details.reason,
        exitCode: details.exitCode,
      })
    } catch {
      // ignore
    }
    console.error('[Main] render-process-gone:', {
      wcId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL(),
    })
  })

  app.on('child-process-gone', (_event, details) => {
    try {
      appendDebugLog('main', 'app.child-process-gone', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name,
        serviceName: details.serviceName,
      })
    } catch {
      // ignore
    }
    console.error('[Main] child-process-gone:', details)
  })

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

  // M5：Tag / Vector / KG 索引维护任务（事件驱动）。
  // 有新记忆入队（enqueue*Index）或记忆设置变更时带 debounce 触发；
  // 批次跑满说明仍有积压则短延时续跑；另有低频兜底扫描收漏网（如失败重试、
  // 中途开启 vector/kg 后的历史数据补索引）。
  const TAG_BATCH = 80
  const VEC_BATCH = 8
  const KG_BATCH = 2

  let tagMaintRunning = false
  const runTagMaintenance = (): boolean => {
    try {
      if (!memoryService) return false
      const settings = getSettings()
      if (!settings.memory.enabled) return false
      if ((settings.memory.tagEnabled ?? true) === false) return false
      if (tagMaintRunning) return false
      tagMaintRunning = true
      const res = memoryService.runTagMaintenance(settings.memory, { batchSize: TAG_BATCH })
      if (res.updated > 0) {
        console.info(`[Memory] TagIndex: scanned=${res.scanned} updated=${res.updated}`)
      }
      return res.scanned >= TAG_BATCH
    } catch (err) {
      console.error('[Memory] TagIndex failed:', err)
      return false
    } finally {
      tagMaintRunning = false
    }
  }

  let vectorMaintRunning = false
  const runVectorMaintenance = async (): Promise<boolean> => {
    try {
      if (!memoryService) return false
      const settings = getSettings()
      if (!settings.memory.enabled) return false
      if (!(settings.memory.vectorEnabled ?? false)) return false
      if (vectorMaintRunning) return false
      vectorMaintRunning = true
      const res = await memoryService.runVectorEmbeddingMaintenance(settings.memory, settings.ai, { batchSize: VEC_BATCH })
      if (res.embedded > 0 || res.skipped > 0 || res.error) {
        console.info(
          `[Memory] VectorIndex: scanned=${res.scanned} embedded=${res.embedded} skipped=${res.skipped}${
            res.error ? ` error=${res.error}` : ''
          }`,
        )
      }
      return !res.error && res.scanned >= VEC_BATCH
    } catch (err) {
      console.error('[Memory] VectorIndex failed:', err)
      return false
    } finally {
      vectorMaintRunning = false
    }
  }

  let kgMaintRunning = false
  const runKgMaintenance = async (): Promise<boolean> => {
    try {
      if (!memoryService) return false
      const settings = getSettings()
      if (!settings.memory.enabled) return false
      if (!(settings.memory.kgEnabled ?? false)) return false
      if (kgMaintRunning) return false
      kgMaintRunning = true
      const res = await memoryService.runKgMaintenance(settings.memory, settings.ai, { batchSize: KG_BATCH })
      if (res.extracted > 0 || res.error) {
        console.info(
          `[Memory] KGIndex: scanned=${res.scanned} extracted=${res.extracted} skipped=${res.skipped}${res.error ? ` error=${res.error}` : ''}`,
        )
      }
      return !res.error && res.scanned >= KG_BATCH
    } catch (err) {
      console.error('[Memory] KGIndex failed:', err)
      return false
    } finally {
      kgMaintRunning = false
    }
  }

  const MEMORY_INDEX_DEBOUNCE_MS = 1_500
  const MEMORY_INDEX_DRAIN_MS = 2_000
  const MEMORY_INDEX_SWEEP_MS = 10 * 60_000

  let memoryIndexTimer: NodeJS.Timeout | null = null
  let memoryIndexRunning = false

  const scheduleMemoryIndexMaintenance = (delayMs = MEMORY_INDEX_DEBOUNCE_MS) => {
    if (memoryIndexTimer) return
    memoryIndexTimer = setTimeout(() => {
      memoryIndexTimer = null
      void runMemoryIndexMaintenance()
    }, delayMs)
    ;(memoryIndexTimer as unknown as { unref?: () => void }).unref?.()
  }

  const runMemoryIndexMaintenance = async () => {
    if (memoryIndexRunning) {
      scheduleMemoryIndexMaintenance(MEMORY_INDEX_DRAIN_MS)
      return
    }
    memoryIndexRunning = true
    let more = false
    try {
      more = runTagMaintenance() || more
      more = (await runVectorMaintenance()) || more
      more = (await runKgMaintenance()) || more
    } finally {
      memoryIndexRunning = false
    }
    if (more) scheduleMemoryIndexMaintenance(MEMORY_INDEX_DRAIN_MS)
  }

  kickMemoryIndexMaintenance = () => scheduleMemoryIndexMaintenance()
  memoryService?.setMaintenanceKick(kickMemoryIndexMaintenance)
  // 启动后清一遍历史积压
  scheduleMemoryIndexMaintenance(3_000)
  const memoryIndexSweep = setInterval(() => scheduleMemoryIndexMaintenance(0), MEMORY_INDEX_SWEEP_MS)
  ;(memoryIndexSweep as unknown as { unref?: () => void }).unref?.()

  registerIpc()

  // 预热聊天存储：触发 SQLite 打开与旧 JSON 数据的一次性迁移，
  // 把迁移成本放在启动阶段而不是用户第一次打开聊天窗口时。
  try {
    listChatSessions()
  } catch (err) {
    console.error('[ChatStore] warmup failed:', err)
  }

  let displayRecoveryTimer: NodeJS.Timeout | null = null
  const scheduleWindowRecovery = () => {
    if (displayRecoveryTimer) clearTimeout(displayRecoveryTimer)
    displayRecoveryTimer = setTimeout(() => {
      displayRecoveryTimer = null
      windowManager.recoverWindowsToVisibleArea()
    }, 150)
    ;(displayRecoveryTimer as unknown as { unref?: () => void }).unref?.()
  }
  screen.on('display-added', scheduleWindowRecovery)
  screen.on('display-removed', scheduleWindowRecovery)
  screen.on('display-metrics-changed', scheduleWindowRecovery)

  // 启动后按 displayMode 恢复窗口形态，并在 orb 模式恢复 Orb UI 状态。
  windowManager.applyDisplayMode()
  if (getSettings().displayMode === 'orb') {
    broadcastOrbStateChanged(orbUiState)
    windowManager.setOrbUiState(orbUiState, { focus: false, animate: false })
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
  void syncManagedAsrApi('app:ready')
  broadcastSettingsChanged()
})

