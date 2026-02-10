import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DisplayMode, OrbUiState, WindowBounds, WindowType } from './types'
import { getSettings, setSettings } from './store'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type CreateWindowDeps = {
  rendererDevUrl?: string
  rendererDistDir: string
  mainDistDir: string
}

const PET_CLICK_THROUGH_POLL_MS = 8
// 命中区域与 Live2DView 内 model.position/scale 的近似保持一致（不是像素级命中，只做“可拖动/可点区域”）
const PET_MODEL_OFFSET_Y = 0.06
const PET_MODEL_RADIUS_X = 0.42
const PET_MODEL_RADIUS_Y = 0.48

// 悬浮球窗口的三种 UI 状态尺寸（与 renderer/src/orb/OrbApp.tsx 对齐）
const ORB_BALL_SIZE = 40
const ORB_BAR_WIDTH = 480
const ORB_BAR_HEIGHT = 80
const ORB_ANIMATION_FPS = 60
const ORB_ANIMATION_OPEN_MS = 460
const ORB_ANIMATION_MID_MS = 220
const ORB_ANIMATION_CLOSE_MS = 320

// 仅当 orb 窗口处于“面板态”时才持久化 orbWindowBounds，避免 ball/bar 把展开尺寸覆盖掉
const ORB_PANEL_PERSIST_MIN_H = 240

function clampBounds(bounds: WindowBounds): WindowBounds {
  const hasPoint = typeof bounds.x === 'number' && Number.isFinite(bounds.x) && typeof bounds.y === 'number' && Number.isFinite(bounds.y)
  const display = hasPoint ? screen.getDisplayNearestPoint({ x: bounds.x!, y: bounds.y! }) : screen.getPrimaryDisplay()
  const workArea = display.workArea

  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
  const minX = workArea.x
  const minY = workArea.y
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height

  const defaultX = Math.round(workArea.x + (workArea.width - width) / 2)
  const defaultY = Math.round(workArea.y + (workArea.height - height) / 2)
  const x = clamp(typeof bounds.x === 'number' && Number.isFinite(bounds.x) ? bounds.x : defaultX, minX, Math.max(minX, maxX))
  const y = clamp(typeof bounds.y === 'number' && Number.isFinite(bounds.y) ? bounds.y : defaultY, minY, Math.max(minY, maxY))

  return { x, y, width, height }
}

function getBounds(type: WindowType): WindowBounds {
  const settings = getSettings()
  if (type === 'pet') return clampBounds(settings.petWindowBounds)
  if (type === 'chat') return clampBounds(settings.chatWindowBounds)
  if (type === 'settings') return clampBounds(settings.settingsWindowBounds)
  if (type === 'orb') return clampBounds(settings.orbWindowBounds)
  return clampBounds(settings.memoryWindowBounds)
}

function persistBounds(type: WindowType, bounds: Electron.Rectangle): void {
  // orb：仅记录展开态（panel）；折叠态（ball/bar）由 WindowManager 常量控制
  if (type === 'orb' && bounds.height < ORB_PANEL_PERSIST_MIN_H) return

  const nextBounds: WindowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }

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

export class WindowManager {
  private readonly deps: CreateWindowDeps
  private petWindow: BrowserWindow | null = null
  private chatWindow: BrowserWindow | null = null
  private settingsWindow: BrowserWindow | null = null
  private memoryWindow: BrowserWindow | null = null
  private orbWindow: BrowserWindow | null = null
  private orbMenuWindow: BrowserWindow | null = null
  private appQuitting = false

  private petClickThroughTimer: NodeJS.Timeout | null = null
  private petDragging = false
  private petOverlayHover = false
  private petIgnoreMouseEvents: boolean | null = null

  private orbOverlayBaseBounds: Electron.Rectangle | null = null
  // 记住 ball 状态时的位置，以便从 bar/panel 返回时恢复到原位
  private orbBallBounds: Electron.Rectangle | null = null
  private orbUiState: OrbUiState = 'ball'
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

  getOrbWindow(): BrowserWindow | null {
    return this.orbWindow && !this.orbWindow.isDestroyed() ? this.orbWindow : null
  }

  getMemoryWindow(): BrowserWindow | null {
    return this.memoryWindow && !this.memoryWindow.isDestroyed() ? this.memoryWindow : null
  }

  ensurePetWindow(): BrowserWindow {
    if (this.petWindow && !this.petWindow.isDestroyed()) return this.petWindow

    const settings = getSettings()
    const bounds = getBounds('pet')

    const win = new BrowserWindow({
      ...bounds,
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

    // 先启用鼠标事件；clickThrough 模式由主进程轮询动态切换 ignoreMouseEvents
    win.setIgnoreMouseEvents(false)

    this.attachPersistHandlers(win, 'pet')
    this.loadWindow(win, 'pet')
    this.petWindow = win

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
      if (this.petClickThroughTimer) {
        clearInterval(this.petClickThroughTimer)
        this.petClickThroughTimer = null
      }
      this.petDragging = false
      this.petOverlayHover = false
      this.petIgnoreMouseEvents = null
    })

    return win
  }

  ensureChatWindow(opts?: { show?: boolean; focus?: boolean }): BrowserWindow {
    const show = opts?.show ?? true
    const focus = opts?.focus ?? show

    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      if (show) this.chatWindow.show()
      if (focus) this.chatWindow.focus()
      return this.chatWindow
    }

    const bounds = getBounds('chat')
    const win = new BrowserWindow({
      ...bounds,
      title: 'NeoDeskPet - Chat',
      show,
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
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
    this.loadWindow(win, 'chat')
    this.chatWindow = win

    if (show && focus) win.focus()

    win.on('closed', () => {
      this.chatWindow = null
    })

    return win
  }

  ensureSettingsWindow(): BrowserWindow {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.show()
      this.settingsWindow.focus()
      return this.settingsWindow
    }

    const bounds = getBounds('settings')
    const win = new BrowserWindow({
      ...bounds,
      title: 'NeoDeskPet - Settings',
      show: true,
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    this.attachPersistHandlers(win, 'settings')
    this.loadWindow(win, 'settings')
    this.settingsWindow = win

    win.on('closed', () => {
      this.settingsWindow = null
    })

    return win
  }

  ensureMemoryWindow(): BrowserWindow {
    if (this.memoryWindow && !this.memoryWindow.isDestroyed()) {
      this.memoryWindow.show()
      this.memoryWindow.focus()
      return this.memoryWindow
    }

    const bounds = getBounds('memory')
    const win = new BrowserWindow({
      ...bounds,
      title: 'NeoDeskPet - Memory',
      show: true,
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    this.attachPersistHandlers(win, 'memory')
    this.loadWindow(win, 'memory')
    this.memoryWindow = win

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
      },
    })

    this.attachPersistHandlers(win, 'orb')
    this.loadWindow(win, 'orb')
    this.orbWindow = win
    // 记住初始 ball 位置，确保从 bar/panel 返回时能回到这个贴边位置
    this.orbBallBounds = { ...bounds }

    win.on('closed', () => {
      this.clearOrbAnimation()
      this.orbWindow = null
      this.orbOverlayBaseBounds = null
      this.orbUiState = 'ball'
    })

    return win
  }

  private ensureOrbMenuWindow(): BrowserWindow {
    if (this.orbMenuWindow && !this.orbMenuWindow.isDestroyed()) return this.orbMenuWindow

    const settings = getSettings()
    const win = new BrowserWindow({
      width: 280,
      height: 260,
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
        win.setBounds(
          {
            x: lerp(seg.from.x, seg.to.x, eased),
            y: lerp(seg.from.y, seg.to.y, eased),
            width: lerp(seg.from.width, seg.to.width, eased),
            height: lerp(seg.from.height, seg.to.height, eased),
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

  setOrbUiState(state: OrbUiState, opts?: { focus?: boolean }): void {
    const win = this.ensureOrbWindow()
    const prevState = this.orbUiState
    this.orbUiState = state
    this.orbOverlayBaseBounds = null

    const current = win.getBounds()
    const isBallSize = current.width <= ORB_BALL_SIZE + 4 && current.height <= ORB_BALL_SIZE + 4

    // 如果当前是 ball 状态且要切换到 bar/panel，保存 ball 位置以便返回时恢复
    if (isBallSize && state !== 'ball') {
      this.orbBallBounds = { ...current }
    }

    const target = this.computeOrbTarget(state, current)
    if (state === 'ball') this.persistOrbBallAnchor(target)
    const segments: Array<{ target: Electron.Rectangle; durationMs: number }> = []

    if (prevState === state) {
      segments.push({ target, durationMs: 0 })
    } else if (prevState === 'ball' && state === 'panel') {
      const barTarget = this.computeOrbTarget('bar', current)
      // If panel is narrower than bar, skip bar midpoint to avoid visual rebound
      // (expand left first, then shrink right) after users resize the panel.
      if (target.width < barTarget.width) {
        segments.push({ target, durationMs: ORB_ANIMATION_OPEN_MS })
      } else {
        const first = Math.max(0, Math.round(ORB_ANIMATION_OPEN_MS * 0.55))
        segments.push({ target: barTarget, durationMs: first })
        segments.push({ target, durationMs: Math.max(0, ORB_ANIMATION_OPEN_MS - first) })
      }
    } else if (prevState === 'panel' && state === 'ball') {
      segments.push({ target, durationMs: ORB_ANIMATION_CLOSE_MS })
    } else {
      segments.push({ target, durationMs: ORB_ANIMATION_MID_MS })
    }

    win.setResizable(state === 'panel')

    if (opts?.focus) {
      win.show()
      win.focus()
    } else {
      win.show()
    }
    this.animateOrbSegments(win, segments)
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
    const orb = this.getOrbWindow()
    const orbMenu = this.orbMenuWindow && !this.orbMenuWindow.isDestroyed() ? this.orbMenuWindow : null
    if (pet) pet.setAlwaysOnTop(value)
    if (orb) orb.setAlwaysOnTop(value)
    if (orbMenu) orbMenu.setAlwaysOnTop(value)
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

  private applyPetClickThrough(enabled: boolean): void {
    const pet = this.getPetWindow()
    if (!pet) return

    if (!enabled) {
      if (this.petClickThroughTimer) {
        clearInterval(this.petClickThroughTimer)
        this.petClickThroughTimer = null
      }
      this.petIgnoreMouseEvents = null
      pet.setIgnoreMouseEvents(false)
      return
    }

    if (!this.petClickThroughTimer) {
      // 先默认全窗穿透，避免“刚打开穿透的瞬间点击仍被挡住”
      if (this.petIgnoreMouseEvents !== true) {
        this.petIgnoreMouseEvents = true
        pet.setIgnoreMouseEvents(true, { forward: true })
      }
      this.petClickThroughTimer = setInterval(() => this.updatePetIgnoreMouseEvents(), PET_CLICK_THROUGH_POLL_MS)
    }
    this.updatePetIgnoreMouseEvents()
  }

  private updatePetIgnoreMouseEvents(): void {
    const settings = getSettings()
    const pet = this.getPetWindow()
    if (!pet) return

    if (!settings.clickThrough) {
      if (this.petIgnoreMouseEvents !== false) {
        this.petIgnoreMouseEvents = false
        pet.setIgnoreMouseEvents(false)
      }
      return
    }

    if (this.petOverlayHover) {
      if (this.petIgnoreMouseEvents !== false) {
        this.petIgnoreMouseEvents = false
        pet.setIgnoreMouseEvents(false)
      }
      return
    }

    if (this.petDragging) {
      if (this.petIgnoreMouseEvents !== false) {
        this.petIgnoreMouseEvents = false
        pet.setIgnoreMouseEvents(false)
      }
      return
    }

    const mousePos = screen.getCursorScreenPoint()
    const bounds = pet.getBounds()

    const insideWindow =
      mousePos.x >= bounds.x &&
      mousePos.x <= bounds.x + bounds.width &&
      mousePos.y >= bounds.y &&
      mousePos.y <= bounds.y + bounds.height

    let isInsideModel = false
    if (insideWindow) {
      const x = mousePos.x - bounds.x
      const y = mousePos.y - bounds.y

      const centerX = bounds.width / 2
      const centerY = bounds.height / 2 + bounds.height * PET_MODEL_OFFSET_Y
      const radiusX = bounds.width * PET_MODEL_RADIUS_X
      const radiusY = bounds.height * PET_MODEL_RADIUS_Y

      const normalizedX = (x - centerX) / radiusX
      const normalizedY = (y - centerY) / radiusY
      isInsideModel = normalizedX * normalizedX + normalizedY * normalizedY <= 1
    }

    const nextIgnore = !insideWindow || !isInsideModel
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

    win.on('move', schedulePersist)
    win.on('resize', schedulePersist)
    win.on('closed', persist)
  }

  private loadWindow(win: BrowserWindow, type: WindowType): void {
    if (this.deps.rendererDevUrl) {
      win.loadURL(devUrlWithHash(this.deps.rendererDevUrl, type))
      return
    }

    win.loadFile(path.join(this.deps.rendererDistDir, 'index.html'), { hash: `/${type}` })
  }
}
