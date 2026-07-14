import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DisplayMode, OrbUiState, WindowBounds, WindowType } from './types'
import { isTrustedApplicationUrl } from './ipcPermissions'
import { getSettings, setSettings } from './store'
import {
  MANAGED_WINDOW_SIZE_POLICIES,
  normalizeManagedWindowBounds,
  type ManagedWindowType,
} from './windowBounds'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ICON_PATH = path.resolve(__dirname, '..', 'build', 'icon.png')

type CreateWindowDeps = {
  rendererDevUrl?: string
  rendererDistDir: string
  mainDistDir: string
}


// 悬浮球窗口的三种 UI 状态尺寸（与 renderer/src/orb/OrbApp.tsx 对齐）
const ORB_BALL_SIZE = 40
const ORB_BAR_WIDTH = 480
const ORB_BAR_HEIGHT = 80
const ORB_ANIMATION_FPS = 60
const ORB_ANIMATION_OPEN_MS = 380
const ORB_ANIMATION_MID_MS = 220
const ORB_ANIMATION_CLOSE_MS = 320

// 仅当 orb 窗口处于“面板态”时才持久化 orbWindowBounds，避免 ball/bar 把展开尺寸覆盖掉
const ORB_PANEL_PERSIST_MIN_H = 240

type ClampBoundsOptions = {
  overflowLeftPx?: number
  overflowRightPx?: number
  overflowBottomPx?: number
}

function clampBounds(bounds: WindowBounds, opts?: ClampBoundsOptions): WindowBounds {
  const hasPoint = typeof bounds.x === 'number' && Number.isFinite(bounds.x) && typeof bounds.y === 'number' && Number.isFinite(bounds.y)
  const display = hasPoint ? screen.getDisplayNearestPoint({ x: bounds.x!, y: bounds.y! }) : screen.getPrimaryDisplay()
  const workArea = display.workArea

  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
  const rawOverflowLeft =
    typeof opts?.overflowLeftPx === 'number' && Number.isFinite(opts.overflowLeftPx) ? opts.overflowLeftPx : 0
  const overflowLeftPx = Math.max(0, Math.min(rawOverflowLeft, Math.max(0, width - 80)))
  const rawOverflowRight =
    typeof opts?.overflowRightPx === 'number' && Number.isFinite(opts.overflowRightPx) ? opts.overflowRightPx : 0
  const overflowRightPx = Math.max(0, Math.min(rawOverflowRight, Math.max(0, width - 80)))
  const minX = workArea.x - overflowLeftPx
  const minY = workArea.y
  const maxX = workArea.x + workArea.width - width + overflowRightPx
  const rawOverflowBottom = typeof opts?.overflowBottomPx === 'number' && Number.isFinite(opts.overflowBottomPx) ? opts.overflowBottomPx : 0
  const overflowBottomPx = Math.max(0, Math.min(rawOverflowBottom, Math.max(0, height - 80)))
  const maxY = workArea.y + workArea.height - height + overflowBottomPx

  const defaultX = Math.round(workArea.x + (workArea.width - width) / 2)
  const defaultY = Math.round(workArea.y + (workArea.height - height) / 2)
  const x = clamp(typeof bounds.x === 'number' && Number.isFinite(bounds.x) ? bounds.x : defaultX, minX, Math.max(minX, maxX))
  const y = clamp(typeof bounds.y === 'number' && Number.isFinite(bounds.y) ? bounds.y : defaultY, minY, Math.max(minY, maxY))

  return { x, y, width, height }
}

function clampPetBounds(bounds: WindowBounds): WindowBounds {
  const w = typeof bounds.width === 'number' && Number.isFinite(bounds.width) ? Math.max(1, Math.trunc(bounds.width)) : 350
  const h = typeof bounds.height === 'number' && Number.isFinite(bounds.height) ? Math.max(1, Math.trunc(bounds.height)) : 450
  // 允许桌宠底部大量越过屏幕边界（例如把腿部完全放到屏幕外）。
  // 仅要求保留一小段可见区域，避免下次无法拖拽找回。
  const minVisibleWidth = Math.max(100, Math.min(180, Math.round(w * 0.22)))
  const minVisibleHeight = Math.max(100, Math.min(180, Math.round(h * 0.16)))
  const overflowSidePx = Math.max(0, w - minVisibleWidth)
  const overflowBottomPx = Math.max(0, h - minVisibleHeight)
  return clampBounds(bounds, { overflowLeftPx: overflowSidePx, overflowRightPx: overflowSidePx, overflowBottomPx })
}

function applyWindowAlwaysOnTop(win: BrowserWindow, value: boolean): void {
  try {
    // Electron's explicit "floating" level is not reliable on Windows. The
    // platform default keeps the window topmost without overriding the taskbar.
    win.setAlwaysOnTop(value)
  } catch {
    // ignore
  }
}

function getBounds(type: WindowType): WindowBounds {
  const settings = getSettings()
  if (type === 'pet') return clampPetBounds(settings.petWindowBounds)
  if (type === 'chat') return clampBounds(normalizeManagedWindowBounds('chat', settings.chatWindowBounds))
  if (type === 'settings') return clampBounds(normalizeManagedWindowBounds('settings', settings.settingsWindowBounds))
  if (type === 'orb') return clampBounds(settings.orbWindowBounds)
  return clampBounds(normalizeManagedWindowBounds('memory', settings.memoryWindowBounds))
}

function getEffectiveMinimumSize(type: ManagedWindowType, bounds: WindowBounds): { width: number; height: number } {
  const policy = MANAGED_WINDOW_SIZE_POLICIES[type]
  return {
    width: Math.min(policy.minWidth, bounds.width),
    height: Math.min(policy.minHeight, bounds.height),
  }
}

function applyManagedWindowMinimumSize(win: BrowserWindow, type: ManagedWindowType, bounds: WindowBounds): void {
  const minimum = getEffectiveMinimumSize(type, bounds)
  win.setMinimumSize(minimum.width, minimum.height)
}

function persistBounds(type: WindowType, bounds: Electron.Rectangle): void {
  // orb：仅记录展开态（panel）；折叠态（ball/bar）由 WindowManager 常量控制
  if (type === 'orb' && bounds.height < ORB_PANEL_PERSIST_MIN_H) return

  const rawBounds: WindowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
  const nextBounds =
    type === 'pet'
      ? clampPetBounds(rawBounds)
      : type === 'chat' || type === 'settings' || type === 'memory'
        ? clampBounds(normalizeManagedWindowBounds(type, rawBounds))
        : clampBounds(rawBounds)

  if (type === 'pet') setSettings({ petWindowBounds: nextBounds })
  else if (type === 'chat') setSettings({ chatWindowBounds: nextBounds })
  else if (type === 'settings') setSettings({ settingsWindowBounds: nextBounds })
  else if (type === 'orb') setSettings({ orbWindowBounds: nextBounds })
  else setSettings({ memoryWindowBounds: nextBounds })
}

function devUrlWithHash(devUrl: string, windowType: WindowType): string {
  const normalized = devUrl.endsWith('/') ? devUrl : `${devUrl}/`
  return `${normalized}#/${windowType}`
}

function windowTypeArgument(windowType: WindowType): string {
  return `--neodeskpet-window-type=${windowType}`
}

export class WindowManager {
  private readonly deps: CreateWindowDeps
  private petWindow: BrowserWindow | null = null
  private chatWindow: BrowserWindow | null = null
  private settingsWindow: BrowserWindow | null = null
  private memoryWindow: BrowserWindow | null = null
  private orbWindow: BrowserWindow | null = null
  private orbMenuWindow: BrowserWindow | null = null
  private readonly trustedWebContents = new Map<number, WindowType>()
  private appQuitting = false

  private petDragging = false
  private petOverlayHover = false
  // 渲染进程像素级命中检测的上报结果：光标位于模型不透明像素或交互浮层上
  private petModelHover = false
  private petIgnoreMouseEvents: boolean | null = null
  // 低频安全看门狗：forward 鼠标钩子在 Windows 上会因特权窗口聚焦、页面刷新等
  // 静默失效（Electron #15376/#33281/#30808），靠它兜底清理残留状态并重新武装钩子。
  private petClickThroughWatchdog: NodeJS.Timeout | null = null

  private orbOverlayBaseBounds: Electron.Rectangle | null = null
  // 记住 ball 状态时的位置，以便从 bar/panel 返回时恢复到原位
  private orbBallBounds: Electron.Rectangle | null = null
  private orbUiState: OrbUiState = 'ball'
  private orbSurfacePrewarmed = false
  private orbFirstVisibleExpandDone = false
  private orbRevealTimer: NodeJS.Timeout | null = null
  private orbAnimating = false
  private orbAnimationTimer: NodeJS.Timeout | null = null
  private orbAnimationToken = 0

  constructor(deps: CreateWindowDeps) {
    this.deps = deps
  }

  setAppQuitting(quitting: boolean): void {
    this.appQuitting = quitting
  }

  getAllWindows(): BrowserWindow[] {
    return [this.petWindow, this.chatWindow, this.settingsWindow, this.memoryWindow, this.orbWindow, this.orbMenuWindow].filter(Boolean) as BrowserWindow[]
  }

  getPetWindow(): BrowserWindow | null {
    return this.petWindow && !this.petWindow.isDestroyed() ? this.petWindow : null
  }

  getChatWindow(): BrowserWindow | null {
    return this.chatWindow && !this.chatWindow.isDestroyed() ? this.chatWindow : null
  }

  getSettingsWindow(): BrowserWindow | null {
    return this.settingsWindow && !this.settingsWindow.isDestroyed() ? this.settingsWindow : null
  }

  getOrbWindow(): BrowserWindow | null {
    return this.orbWindow && !this.orbWindow.isDestroyed() ? this.orbWindow : null
  }

  getMemoryWindow(): BrowserWindow | null {
    return this.memoryWindow && !this.memoryWindow.isDestroyed() ? this.memoryWindow : null
  }

  getWindowTypeByWebContentsId(webContentsId: number): WindowType | null {
    return this.trustedWebContents.get(webContentsId) ?? null
  }

  getExpectedWindowUrl(type: WindowType): string {
    if (this.deps.rendererDevUrl) return devUrlWithHash(this.deps.rendererDevUrl, type)
    const rendererEntry = pathToFileURL(path.join(this.deps.rendererDistDir, 'index.html')).toString()
    return `${rendererEntry}#/${type}`
  }

  recoverWindowsToVisibleArea(): void {
    const recover = (win: BrowserWindow | null, type: WindowType) => {
      if (!win || win.isDestroyed()) return
      const current = win.getBounds()
      const next =
        type === 'pet'
          ? clampPetBounds(current)
          : type === 'chat' || type === 'settings' || type === 'memory'
            ? clampBounds(normalizeManagedWindowBounds(type, current))
            : clampBounds(current)
      if (type === 'chat' || type === 'settings' || type === 'memory') {
        applyManagedWindowMinimumSize(win, type, next)
      }
      if (
        current.x !== next.x ||
        current.y !== next.y ||
        current.width !== next.width ||
        current.height !== next.height
      ) {
        win.setBounds({ x: next.x ?? current.x, y: next.y ?? current.y, width: next.width, height: next.height })
      }
    }

    recover(this.petWindow, 'pet')
    recover(this.chatWindow, 'chat')
    recover(this.settingsWindow, 'settings')
    recover(this.memoryWindow, 'memory')
    recover(this.orbWindow, 'orb')
  }

  isTrustedWindowUrl(rawUrl: string, type: WindowType): boolean {
    return isTrustedApplicationUrl(rawUrl, this.getExpectedWindowUrl(type))
  }

  ensurePetWindow(): BrowserWindow {
    if (this.petWindow && !this.petWindow.isDestroyed()) return this.petWindow

    const settings = getSettings()
    const bounds = getBounds('pet')

    const win = new BrowserWindow({
      ...bounds,
      icon: APP_ICON_PATH,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: settings.alwaysOnTop,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('pet')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })

    // Pet 窗口在“只剩桌宠悬浮窗”时仍需要持续处理音频/IPC（例如 AudioWorklet -> renderer 主线程消息）。
    // 关闭后台节流可避免窗口不可聚焦/无任务栏时被 Chromium 过度降频，导致实时链路中断。
    try {
      win.webContents.setBackgroundThrottling(false)
    } catch (_) {
      /* ignore */
    }

    // 先启用鼠标事件；clickThrough 模式由渲染进程像素命中上报驱动切换 ignoreMouseEvents
    win.setIgnoreMouseEvents(false)

    // Electron #15376：forward 鼠标钩子在页面加载/刷新后会静默失效，
    // 每次加载完成后必须重新应用 ignoreMouseEvents 才能恢复 mousemove 转发。
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      this.petModelHover = false
      this.petOverlayHover = false
      this.applyPetClickThrough(getSettings().clickThrough)
    })

    this.attachPersistHandlers(win, 'pet')
    this.loadWindow(win, 'pet')
    this.petWindow = win
    applyWindowAlwaysOnTop(win, settings.alwaysOnTop)
    setTimeout(() => {
      if (!win.isDestroyed()) applyWindowAlwaysOnTop(win, getSettings().alwaysOnTop)
    }, 400)

    // 启动时确保窗口尺寸与 petScale 一致，避免“重新构建/重启后模型看起来变大”
    // 以 petScale 作为权威来源（base=350x450）
    const expectedW = Math.round(350 * (settings.petScale || 1))
    const expectedH = Math.round(450 * (settings.petScale || 1))
    const currentBounds = win.getBounds()
    if (Math.abs(currentBounds.width - expectedW) > 2 || Math.abs(currentBounds.height - expectedH) > 2) {
      this.resizePetWindowForScale(settings.petScale || 1)
    }

    this.applyPetClickThrough(settings.clickThrough)

    win.on('closed', () => {
      this.petWindow = null
      this.petDragging = false
      this.petOverlayHover = false
      this.petModelHover = false
      this.petIgnoreMouseEvents = null
      if (this.petClickThroughWatchdog) {
        clearInterval(this.petClickThroughWatchdog)
        this.petClickThroughWatchdog = null
      }
    })

    return win
  }

  ensureChatWindow(opts?: { show?: boolean; focus?: boolean }): BrowserWindow {
    const show = opts?.show ?? true
    const focus = opts?.focus ?? show

    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      if (show) this.presentManagedWindow(this.chatWindow, focus)
      return this.chatWindow
    }

    const settings = getSettings()
    const bounds = getBounds('chat')
    const minimum = getEffectiveMinimumSize('chat', bounds)
    const win = new BrowserWindow({
      ...bounds,
      minWidth: minimum.width,
      minHeight: minimum.height,
      title: 'NeoDeskPet - Chat',
      icon: APP_ICON_PATH,
      show,
      frame: false,
      alwaysOnTop: settings.alwaysOnTop,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('chat')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })

    try {
      win.webContents.setBackgroundThrottling(false)
    } catch (_) {
      /* ignore */
    }

    // 关键：ChatWindow 常被当作“聊天 UI 面板”关闭，但 ASR autoSend / agent.run 等能力可能仍依赖它的 renderer 逻辑。
    // 将“关闭”语义改为隐藏（不销毁），避免只剩透明桌宠窗口时被 Chromium 过度节流，导致热键录音/发送链路断掉。
    win.on('close', (e) => {
      if (this.appQuitting) return
      try {
        e.preventDefault()
      } catch (_) {
        /* ignore */
      }
      try {
        win.hide()
      } catch (_) {
        /* ignore */
      }
    })

    this.attachPersistHandlers(win, 'chat')
    this.attachManagedWindowInputHandlers(win)
    this.loadWindow(win, 'chat')
    this.chatWindow = win
    applyWindowAlwaysOnTop(win, settings.alwaysOnTop)

    if (show) this.presentManagedWindow(win, focus)

    win.on('closed', () => {
      this.chatWindow = null
    })

    return win
  }

  ensureSettingsWindow(): BrowserWindow {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.presentManagedWindow(this.settingsWindow, true)
      return this.settingsWindow
    }

    const settings = getSettings()
    const bounds = getBounds('settings')
    const minimum = getEffectiveMinimumSize('settings', bounds)
    const win = new BrowserWindow({
      ...bounds,
      minWidth: minimum.width,
      minHeight: minimum.height,
      title: 'NeoDeskPet - Settings',
      icon: APP_ICON_PATH,
      show: true,
      frame: false,
      alwaysOnTop: settings.alwaysOnTop,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('settings')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.attachPersistHandlers(win, 'settings')
    this.attachManagedWindowInputHandlers(win)
    this.loadWindow(win, 'settings')
    this.settingsWindow = win
    applyWindowAlwaysOnTop(win, settings.alwaysOnTop)
    this.presentManagedWindow(win, true)

    win.on('closed', () => {
      this.settingsWindow = null
    })

    return win
  }

  ensureMemoryWindow(): BrowserWindow {
    if (this.memoryWindow && !this.memoryWindow.isDestroyed()) {
      this.presentManagedWindow(this.memoryWindow, true)
      return this.memoryWindow
    }

    const settings = getSettings()
    const bounds = getBounds('memory')
    const minimum = getEffectiveMinimumSize('memory', bounds)
    const win = new BrowserWindow({
      ...bounds,
      minWidth: minimum.width,
      minHeight: minimum.height,
      title: 'NeoDeskPet - Memory',
      icon: APP_ICON_PATH,
      show: true,
      frame: false,
      alwaysOnTop: settings.alwaysOnTop,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('memory')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.attachPersistHandlers(win, 'memory')
    this.attachManagedWindowInputHandlers(win)
    this.loadWindow(win, 'memory')
    this.memoryWindow = win
    applyWindowAlwaysOnTop(win, settings.alwaysOnTop)
    this.presentManagedWindow(win, true)

    win.on('closed', () => {
      this.memoryWindow = null
    })

    return win
  }

  ensureOrbWindow(): BrowserWindow {
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      this.orbWindow.show()
      this.orbWindow.focus()
      return this.orbWindow
    }

    const settings = getSettings()
    // 初次创建直接用 ball 尺寸，避免首次切换到悬浮球时短暂出现“超大面板”。
    // 展开态（panel）的尺寸/位置仍由 orbWindowBounds 持久化并在 setOrbUiState('panel') 时生效。
    const persistedPanelBounds = getBounds('orb')
    const seededBall = clampBounds({
      x: persistedPanelBounds.x,
      y: persistedPanelBounds.y,
      width: ORB_BALL_SIZE,
      height: ORB_BALL_SIZE,
    })
    const display = screen.getDisplayNearestPoint({ x: seededBall.x ?? 0, y: seededBall.y ?? 0 })
    const wa = display.workArea
    const margin = 8
    const centerX = (seededBall.x ?? 0) + Math.round(seededBall.width / 2)
    const dockLeft = centerX < wa.x + wa.width / 2
    const snappedX = dockLeft ? wa.x + margin : wa.x + wa.width - seededBall.width - margin
    const snappedY = Math.max(wa.y + margin, Math.min(seededBall.y ?? wa.y + margin, wa.y + wa.height - seededBall.height - margin))
    const ballBounds = clampBounds({ x: snappedX, y: snappedY, width: ORB_BALL_SIZE, height: ORB_BALL_SIZE })
    const bounds: Electron.Rectangle = { x: ballBounds.x ?? 0, y: ballBounds.y ?? 0, width: ballBounds.width, height: ballBounds.height }
    const win = new BrowserWindow({
      ...bounds,
      title: 'NeoDeskPet - Orb',
      icon: APP_ICON_PATH,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: settings.alwaysOnTop,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('orb')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Orb 不承载音频/ASR 链路（实时逻辑在 chat/pet renderer），隐藏时允许默认后台节流
      },
    })

    this.attachPersistHandlers(win, 'orb')
    this.loadWindow(win, 'orb')
    this.orbWindow = win
    // 记住初始 ball 位置，确保从 bar/panel 返回时能回到这个贴边位置
    this.orbBallBounds = { ...bounds }
    this.orbSurfacePrewarmed = false
    this.orbFirstVisibleExpandDone = false

    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      if (this.orbSurfacePrewarmed) return
      this.orbSurfacePrewarmed = true
      try {
        const currentBounds = win.getBounds()
        const warmTarget = this.computeOrbTarget('panel', currentBounds)
        win.setBounds(warmTarget, false)
        win.setBounds(currentBounds, false)
      } catch {
        // ignore
      }
    })

    win.on('closed', () => {
      this.clearOrbAnimation()
      if (this.orbRevealTimer) {
        clearTimeout(this.orbRevealTimer)
        this.orbRevealTimer = null
      }
      this.orbWindow = null
      this.orbOverlayBaseBounds = null
      this.orbUiState = 'ball'
      this.orbSurfacePrewarmed = false
      this.orbFirstVisibleExpandDone = false
    })

    return win
  }

  private ensureOrbMenuWindow(): BrowserWindow {
    if (this.orbMenuWindow && !this.orbMenuWindow.isDestroyed()) return this.orbMenuWindow

    const settings = getSettings()
    const win = new BrowserWindow({
      width: 280,
      height: 260,
      icon: APP_ICON_PATH,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: settings.alwaysOnTop,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [windowTypeArgument('orb-menu')],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // orb-menu 不做持久化（弹出即用）
    this.loadWindow(win, 'orb-menu')
    this.orbMenuWindow = win

    win.on('blur', () => {
      // 失焦自动关闭，避免挡住屏幕
      try {
        win.close()
      } catch {
        // ignore
      }
    })

    win.on('closed', () => {
      this.orbMenuWindow = null
    })

    return win
  }

  hideAll(): void {
    for (const win of this.getAllWindows()) win.hide()
  }

  showPet(): void {
    const win = this.ensurePetWindow()
    win.show()
    win.focus()
  }

  showOrb(): void {
    const win = this.ensureOrbWindow()
    win.show()
    win.focus()
  }

  setDisplayMode(mode: DisplayMode): void {
    setSettings({ displayMode: mode })
    this.applyDisplayMode()
  }

  applyDisplayMode(): void {
    const mode = getSettings().displayMode
    if (mode === 'orb') {
      // 互斥：只显示 orb
      const pet = this.getPetWindow()
      if (pet) pet.hide()
      this.showOrb()
      this.closeOrbMenu()
      return
    }

    if (mode === 'hidden') {
      // 仅托盘：隐藏所有窗口
      this.closeOrbMenu()
      this.hideAll()
      return
    }

    // 默认：live2d
    const orb = this.getOrbWindow()
    if (orb) orb.hide()
    this.closeOrbMenu()
    this.showPet()
  }

  closeOrbMenu(): void {
    const win = this.orbMenuWindow
    if (!win || win.isDestroyed()) return
    try {
      win.close()
    } catch {
      // ignore
    }
  }

  private persistOrbBallAnchor(bounds: Electron.Rectangle): void {
    try {
      const current = getSettings().orbWindowBounds
      setSettings({
        orbWindowBounds: {
          x: bounds.x,
          y: bounds.y,
          width: current.width,
          height: current.height,
        },
      })
    } catch {
      // ignore
    }
  }

  private clearOrbAnimation(): void {
    this.orbAnimationToken += 1
    if (this.orbAnimationTimer) {
      clearInterval(this.orbAnimationTimer)
      this.orbAnimationTimer = null
    }
    this.orbAnimating = false
  }

  private easeInOutCubic(t: number): number {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  private toOrbRect(bounds: WindowBounds): Electron.Rectangle {
    return {
      x: bounds.x ?? 0,
      y: bounds.y ?? 0,
      width: bounds.width,
      height: bounds.height,
    }
  }

  private animateOrbSegments(
    win: BrowserWindow,
    segments: Array<{
      target: Electron.Rectangle
      durationMs: number
    }>,
  ): void {
    this.clearOrbAnimation()

    if (segments.length === 0) return

    const from = win.getBounds()
    const sameBounds = (a: Electron.Rectangle, b: Electron.Rectangle) =>
      a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
    const lerp = (a: number, b: number, p: number) => Math.round(a + (b - a) * p)
    const edgeDistance = (a: number, b: number) => Math.abs(a - b)

    const normalizedSegments: Array<{
      from: Electron.Rectangle
      to: Electron.Rectangle
      durationMs: number
    }> = []

    let cursor: Electron.Rectangle = { ...from }
    for (const seg of segments) {
      const target = this.toOrbRect(clampBounds({ x: seg.target.x, y: seg.target.y, width: seg.target.width, height: seg.target.height }))
      if (sameBounds(cursor, target)) continue
      normalizedSegments.push({
        from: { ...cursor },
        to: { ...target },
        durationMs: Math.max(0, Math.trunc(seg.durationMs)),
      })
      cursor = target
    }

    if (normalizedSegments.length === 0) {
      const last = segments[segments.length - 1]
      const target = this.toOrbRect(clampBounds({ x: last.target.x, y: last.target.y, width: last.target.width, height: last.target.height }))
      win.setBounds(target)
      return
    }

    const finalTarget = normalizedSegments[normalizedSegments.length - 1].to
    if (normalizedSegments.every((seg) => seg.durationMs <= 0)) {
      win.setBounds(finalTarget)
      return
    }

    const token = ++this.orbAnimationToken
    this.orbAnimating = true
    const intervalMs = Math.max(8, Math.round(1000 / ORB_ANIMATION_FPS))
    let segIndex = 0
    let segStartedAt = Date.now()

    this.orbAnimationTimer = setInterval(() => {
      if (win.isDestroyed()) {
        this.clearOrbAnimation()
        return
      }
      if (token !== this.orbAnimationToken) return

      const now = Date.now()

      while (segIndex < normalizedSegments.length) {
        const seg = normalizedSegments[segIndex]
        if (seg.durationMs <= 0) {
          win.setBounds(seg.to, false)
          segIndex += 1
          segStartedAt = now
          continue
        }

        const progress = Math.min(1, (now - segStartedAt) / seg.durationMs)
        const eased = this.easeInOutCubic(progress)
        const width = lerp(seg.from.width, seg.to.width, eased)
        const height = lerp(seg.from.height, seg.to.height, eased)
        const fromRight = seg.from.x + seg.from.width
        const toRight = seg.to.x + seg.to.width
        const fromBottom = seg.from.y + seg.from.height
        const toBottom = seg.to.y + seg.to.height

        const x =
          edgeDistance(seg.from.x, seg.to.x) <= 1
            ? seg.from.x
            : edgeDistance(fromRight, toRight) <= 1
              ? fromRight - width
              : lerp(seg.from.x, seg.to.x, eased)

        const y =
          edgeDistance(seg.from.y, seg.to.y) <= 1
            ? seg.from.y
            : edgeDistance(fromBottom, toBottom) <= 1
              ? fromBottom - height
              : lerp(seg.from.y, seg.to.y, eased)

        win.setBounds(
          {
            x,
            y,
            width,
            height,
          },
          false,
        )

        if (progress < 1) break
        win.setBounds(seg.to, false)
        segIndex += 1
        segStartedAt = now
      }

      if (segIndex >= normalizedSegments.length) {
        win.setBounds(finalTarget, false)
        this.clearOrbAnimation()
      }
    }, intervalMs)
  }

  private computeOrbTarget(state: OrbUiState, current: Electron.Rectangle): Electron.Rectangle {
    const settings = getSettings()
    const panel = clampBounds(settings.orbWindowBounds)
    const size =
      state === 'panel'
        ? { width: panel.width, height: panel.height }
        : state === 'bar'
          ? { width: ORB_BAR_WIDTH, height: ORB_BAR_HEIGHT }
          : { width: ORB_BALL_SIZE, height: ORB_BALL_SIZE }

    let nextX: number
    let nextY: number

    if (state === 'ball') {
      if (this.orbBallBounds) {
        nextX = this.orbBallBounds.x
        nextY = this.orbBallBounds.y
      } else {
        const centerX = current.x + Math.round(current.width / 2)
        const centerY = current.y + Math.round(current.height / 2)
        try {
          const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
          const wa = display.workArea
          const dockLeft = centerX < wa.x + wa.width / 2
          const margin = 8
          nextX = dockLeft ? wa.x + margin : wa.x + wa.width - size.width - margin
          nextY = Math.max(
            wa.y + margin,
            Math.min(Math.round(centerY - size.height / 2), wa.y + wa.height - size.height - margin),
          )
        } catch {
          nextX = Math.round(current.x + current.width / 2 - size.width / 2)
          nextY = Math.round(current.y + current.height / 2 - size.height / 2)
        }
      }
    } else {
      const refBounds = this.orbBallBounds ?? current
      const anchorW = this.orbBallBounds ? ORB_BALL_SIZE : refBounds.width
      const anchorH = this.orbBallBounds ? ORB_BALL_SIZE : refBounds.height
      const anchorX = refBounds.x + Math.round(anchorW / 2)
      const anchorY = refBounds.y + Math.round(anchorH / 2)

      const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
      const wa = display.workArea
      const margin = 8
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

      const dockLeft = anchorX < wa.x + wa.width / 2
      nextX = dockLeft ? wa.x + margin : wa.x + wa.width - size.width - margin

      const minY = wa.y + margin
      const maxY = wa.y + wa.height - size.height - margin
      const anchorTopY = this.orbBallBounds ? this.orbBallBounds.y : current.y
      nextY = clamp(anchorTopY, minY, Math.max(minY, maxY))
    }

    return this.toOrbRect(clampBounds({ x: nextX, y: nextY, width: size.width, height: size.height }))
  }

  setOrbUiState(state: OrbUiState, opts?: { focus?: boolean; animate?: boolean }): void {
    const win = this.ensureOrbWindow()
    const prevState = this.orbUiState
    this.orbUiState = state
    this.orbOverlayBaseBounds = null

    if (this.orbRevealTimer) {
      clearTimeout(this.orbRevealTimer)
      this.orbRevealTimer = null
    }

    if (state === 'ball') {
      try {
        win.setOpacity(1)
      } catch {
        // ignore
      }
    }

    const current = win.getBounds()
    const isBallSize = current.width <= ORB_BALL_SIZE + 4 && current.height <= ORB_BALL_SIZE + 4

    // 如果当前是 ball 状态且要切换到 bar/panel，保存 ball 位置以便返回时恢复
    if (isBallSize && state !== 'ball') {
      this.orbBallBounds = { ...current }
    }

    const target = this.computeOrbTarget(state, current)
    if (state === 'ball') this.persistOrbBallAnchor(target)
    const segments: Array<{ target: Electron.Rectangle; durationMs: number }> = []

    if (prevState === state || opts?.animate === false) {
      segments.push({ target, durationMs: 0 })
    } else if (prevState === 'ball' && state === 'panel') {
      segments.push({ target, durationMs: ORB_ANIMATION_OPEN_MS })
    } else if (prevState === 'panel' && state === 'ball') {
      segments.push({ target, durationMs: ORB_ANIMATION_CLOSE_MS })
    } else {
      segments.push({ target, durationMs: ORB_ANIMATION_MID_MS })
    }

    win.setResizable(state === 'panel')

    const maskFirstVisibleExpand = prevState === 'ball' && state !== 'ball' && !this.orbFirstVisibleExpandDone
    if (maskFirstVisibleExpand) {
      try {
        win.setOpacity(0)
      } catch {
        // ignore
      }
    }

    if (opts?.focus) {
      win.show()
      win.focus()
    } else {
      win.show()
    }
    this.animateOrbSegments(win, segments)

    if (maskFirstVisibleExpand) {
      this.orbFirstVisibleExpandDone = true
      this.orbRevealTimer = setTimeout(() => {
        this.orbRevealTimer = null
        if (win.isDestroyed()) return
        if (this.orbUiState === 'ball') return
        try {
          win.setOpacity(1)
        } catch {
          // ignore
        }
      }, 90)
    }
  }

  // 更新保存的 ball 位置（用于拖动后同步）
  updateOrbBallBounds(): void {
    const win = this.getOrbWindow()
    if (!win) return
    const bounds = win.getBounds()
    // 仅在当前是 ball 尺寸时更新
    if (bounds.width <= ORB_BALL_SIZE + 4 && bounds.height <= ORB_BALL_SIZE + 4) {
      this.orbBallBounds = { ...bounds }
      this.persistOrbBallAnchor(bounds)
    }
  }

  setOrbOverlayBounds(payload: { width: number; height: number; focus?: boolean }): void {
    const win = this.getOrbWindow()
    if (!win) return
    this.clearOrbAnimation()

    if (!this.orbOverlayBaseBounds) this.orbOverlayBaseBounds = win.getBounds()

    const width = Math.max(1, Math.trunc(payload.width))
    const height = Math.max(1, Math.trunc(payload.height))
    const cur = win.getBounds()
    win.setBounds(clampBounds({ x: cur.x, y: cur.y, width, height }))
    if (payload.focus) {
      win.show()
      win.focus()
    }
  }

  clearOrbOverlayBounds(payload?: { focus?: boolean }): void {
    const win = this.getOrbWindow()
    if (!win) return
    if (!this.orbOverlayBaseBounds) return
    this.clearOrbAnimation()

    const base = this.orbOverlayBaseBounds
    this.orbOverlayBaseBounds = null
    try {
      win.setBounds(clampBounds({ x: base.x, y: base.y, width: base.width, height: base.height }))
    } catch {
      // ignore
    }
    if (payload?.focus) {
      win.show()
      win.focus()
    }
  }

  showOrbContextMenu(point: { x: number; y: number }): void {
    const win = this.ensureOrbMenuWindow()
    const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y })
    const workArea = display.workArea

    const w = 280
    const h = 260
    const x = Math.max(workArea.x, Math.min(point.x - Math.round(w / 2), workArea.x + workArea.width - w))
    const y = Math.max(workArea.y, Math.min(point.y - 10, workArea.y + workArea.height - h))

    win.setBounds({ x, y, width: w, height: h })
    win.show()
    win.focus()
  }

  setAlwaysOnTop(value: boolean): void {
    setSettings({ alwaysOnTop: value })
    const pet = this.getPetWindow()
    const chat = this.getChatWindow()
    const settings = this.getSettingsWindow()
    const memory = this.getMemoryWindow()
    const orb = this.getOrbWindow()
    const orbMenu = this.orbMenuWindow && !this.orbMenuWindow.isDestroyed() ? this.orbMenuWindow : null
    if (pet) applyWindowAlwaysOnTop(pet, value)
    if (orb) applyWindowAlwaysOnTop(orb, value)
    if (orbMenu) applyWindowAlwaysOnTop(orbMenu, value)
    if (chat) applyWindowAlwaysOnTop(chat, value)
    if (settings) applyWindowAlwaysOnTop(settings, value)
    if (memory) applyWindowAlwaysOnTop(memory, value)

    const focused = BrowserWindow.getFocusedWindow()
    if (focused && (focused === chat || focused === settings || focused === memory)) {
      try {
        focused.moveTop()
      } catch {
        // ignore
      }
    }
  }

  setClickThrough(value: boolean): void {
    setSettings({ clickThrough: value })
    this.ensurePetWindow()
    this.applyPetClickThrough(value)
  }

  setPetDragging(dragging: boolean): void {
    this.petDragging = dragging
    this.updatePetIgnoreMouseEvents()
  }

  setPetOverlayHover(hovering: boolean): void {
    this.petOverlayHover = hovering
    this.updatePetIgnoreMouseEvents()
  }

  setPetModelHover(hovering: boolean): void {
    if (this.petModelHover === hovering) return
    this.petModelHover = hovering
    this.updatePetIgnoreMouseEvents()
  }

  persistPetBoundsNow(): void {
    const pet = this.getPetWindow()
    if (!pet || pet.isDestroyed()) return
    try {
      persistBounds('pet', pet.getBounds())
    } catch {
      // ignore
    }
  }

  private applyPetClickThrough(enabled: boolean): void {
    const pet = this.getPetWindow()
    if (!pet) return

    if (this.hasFocusedManagedWindow()) {
      this.petIgnoreMouseEvents = true
      pet.setIgnoreMouseEvents(true, { forward: true })
      return
    }

    if (!enabled) {
      if (this.petClickThroughWatchdog) {
        clearInterval(this.petClickThroughWatchdog)
        this.petClickThroughWatchdog = null
      }
      this.petIgnoreMouseEvents = false
      pet.setIgnoreMouseEvents(false)
      return
    }

    // 开启时先整窗穿透（forward 保持向渲染进程转发 mousemove），
    // 渲染进程像素命中上报到来后由 updatePetIgnoreMouseEvents 恢复交互。
    this.petIgnoreMouseEvents = true
    pet.setIgnoreMouseEvents(true, { forward: true })
    this.updatePetIgnoreMouseEvents()

    if (!this.petClickThroughWatchdog) {
      this.petClickThroughWatchdog = setInterval(() => this.petClickThroughPumpTick(), 80)
      ;(this.petClickThroughWatchdog as unknown as { unref?: () => void }).unref?.()
    }
  }

  // 探针泵：forward 鼠标转发在 Windows 上不可靠（Electron #15376/#33281 等，
  // 特权窗口聚焦/页面刷新都会让钩子静默失效），因此穿透模式下由主进程低频推送
  // 光标客户区坐标给渲染进程做像素命中检测。光标在窗口外时仅做廉价的边界检查。
  private petClickThroughPumpTick(): void {
    const settings = getSettings()
    if (!settings.clickThrough) return
    const pet = this.getPetWindow()
    if (!pet || pet.isDestroyed()) return
    if (this.petDragging) return

    const pos = screen.getCursorScreenPoint()
    const b = pet.getContentBounds()
    const inside = pos.x >= b.x && pos.x <= b.x + b.width && pos.y >= b.y && pos.y <= b.y + b.height
    if (!inside) {
      // 清掉可能因 mouseleave 丢失而残留的 hover 状态
      this.petModelHover = false
      this.petOverlayHover = false
      if (this.petIgnoreMouseEvents !== true) {
        this.petIgnoreMouseEvents = true
        pet.setIgnoreMouseEvents(true, { forward: true })
      }
      return
    }

    pet.webContents.send('pet:cursorProbe', { x: pos.x - b.x, y: pos.y - b.y })
  }

  // 事件驱动：由渲染进程的像素命中上报（setPetModelHover）、浮层 hover、拖拽状态触发，
  // 不再依赖主进程定时轮询光标位置。
  private updatePetIgnoreMouseEvents(): void {
    const pet = this.getPetWindow()
    if (!pet) return

    const settings = getSettings()
    const nextIgnore =
      this.hasFocusedManagedWindow()
      || (Boolean(settings.clickThrough) && !this.petModelHover && !this.petOverlayHover && !this.petDragging)
    if (nextIgnore === this.petIgnoreMouseEvents) return
    this.petIgnoreMouseEvents = nextIgnore
    pet.setIgnoreMouseEvents(nextIgnore, { forward: true })
  }

  resizePetWindowForScale(scale: number): void {
    const pet = this.getPetWindow()
    if (!pet) return

    // Base size
    const baseWidth = 350
    const baseHeight = 450

    const newWidth = Math.round(baseWidth * scale)
    const newHeight = Math.round(baseHeight * scale)

    // Get current bounds
    const bounds = pet.getBounds()

    // Keep bottom center fixed (model feet stay in place)
    const bottomCenterX = bounds.x + bounds.width / 2
    const bottomY = bounds.y + bounds.height

    const newX = Math.round(bottomCenterX - newWidth / 2)
    const newY = Math.round(bottomY - newHeight)

    pet.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
  }

  private presentManagedWindow(win: BrowserWindow, focus: boolean): void {
    if (win.isDestroyed()) return
    applyWindowAlwaysOnTop(win, getSettings().alwaysOnTop)
    win.show()
    if (!focus) return
    win.focus()
    try {
      win.moveTop()
    } catch {
      // ignore
    }
    this.applyPetClickThrough(getSettings().clickThrough)
  }

  private hasFocusedManagedWindow(): boolean {
    return [this.chatWindow, this.settingsWindow, this.memoryWindow].some(
      (window) => window && !window.isDestroyed() && window.isFocused(),
    )
  }

  private attachManagedWindowInputHandlers(win: BrowserWindow): void {
    const syncPetMouseCapture = () => {
      setTimeout(() => this.applyPetClickThrough(getSettings().clickThrough), 0)
    }
    win.on('focus', () => this.applyPetClickThrough(getSettings().clickThrough))
    win.on('blur', syncPetMouseCapture)
    win.on('hide', syncPetMouseCapture)
    win.on('closed', syncPetMouseCapture)
  }

  private attachPersistHandlers(win: BrowserWindow, type: WindowType): void {
    const persist = () => {
      if (win.isDestroyed()) return
      if (type === 'orb') {
        if (this.orbUiState !== 'panel') return
        if (this.orbOverlayBaseBounds) return
        if (this.orbAnimating) return
        const b = win.getBounds()
        if (b.height < ORB_PANEL_PERSIST_MIN_H) return
      }
      persistBounds(type, win.getBounds())
    }

    let timer: NodeJS.Timeout | null = null
    const schedulePersist = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(persist, 200)
    }
    const flushPersist = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (win.isDestroyed()) return
      persist()
    }

    win.on('move', schedulePersist)
    win.on('resize', schedulePersist)
    // `closed` 阶段窗口通常已销毁，取不到最后 bounds；改为 `close` 前落盘，避免“拖完马上退出”丢位置。
    win.on('close', flushPersist)
    win.on('closed', () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    })
  }

  private loadWindow(win: BrowserWindow, type: WindowType): void {
    this.registerTrustedWindow(win, type)
    void win.loadURL(this.getExpectedWindowUrl(type))
  }

  private registerTrustedWindow(win: BrowserWindow, type: WindowType): void {
    const webContentsId = win.webContents.id
    this.trustedWebContents.set(webContentsId, type)

    const openExternal = (rawUrl: string) => {
      try {
        const url = new URL(rawUrl)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return
        void shell.openExternal(url.toString()).catch((error) => {
          console.warn('[WindowSecurity] Failed to open external URL:', error)
        })
      } catch {
        // Invalid URLs are denied below.
      }
    }

    const guardNavigation = (event: Electron.Event, targetUrl: string) => {
      if (this.isTrustedWindowUrl(targetUrl, type)) return
      event.preventDefault()
      openExternal(targetUrl)
      console.warn(`[WindowSecurity] Blocked navigation: type=${type}; url=${targetUrl}`)
    }

    win.webContents.on('will-navigate', guardNavigation)
    win.webContents.on('will-redirect', guardNavigation)
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      console.warn(`[WindowSecurity] Blocked child window: type=${type}; url=${url}`)
      return { action: 'deny' }
    })

    win.webContents.once('destroyed', () => {
      this.trustedWebContents.delete(webContentsId)
    })
  }
}
