import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WindowBounds, WindowType } from './types'
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

function clampBounds(bounds: WindowBounds): WindowBounds {
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea

  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  const x = bounds.x ?? Math.round(workArea.x + (workArea.width - width) / 2)
  const y = bounds.y ?? Math.round(workArea.y + (workArea.height - height) / 2)

  return { x, y, width, height }
}

function getBounds(type: WindowType): WindowBounds {
  const settings = getSettings()
  if (type === 'pet') return clampBounds(settings.petWindowBounds)
  if (type === 'chat') return clampBounds(settings.chatWindowBounds)
  if (type === 'settings') return clampBounds(settings.settingsWindowBounds)
  return clampBounds(settings.memoryWindowBounds)
}

function persistBounds(type: WindowType, bounds: Electron.Rectangle): void {
  const nextBounds: WindowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }

  if (type === 'pet') setSettings({ petWindowBounds: nextBounds })
  else if (type === 'chat') setSettings({ chatWindowBounds: nextBounds })
  else if (type === 'settings') setSettings({ settingsWindowBounds: nextBounds })
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

  private petClickThroughTimer: NodeJS.Timeout | null = null
  private petDragging = false
  private petOverlayHover = false
  private petIgnoreMouseEvents: boolean | null = null

  constructor(deps: CreateWindowDeps) {
    this.deps = deps
  }

  getAllWindows(): BrowserWindow[] {
    return [this.petWindow, this.chatWindow, this.settingsWindow, this.memoryWindow].filter(Boolean) as BrowserWindow[]
  }

  getPetWindow(): BrowserWindow | null {
    return this.petWindow && !this.petWindow.isDestroyed() ? this.petWindow : null
  }

  getChatWindow(): BrowserWindow | null {
    return this.chatWindow && !this.chatWindow.isDestroyed() ? this.chatWindow : null
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
      resizable: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    })

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
      },
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

  hideAll(): void {
    for (const win of this.getAllWindows()) win.hide()
  }

  showPet(): void {
    const win = this.ensurePetWindow()
    win.show()
    win.focus()
  }

  setAlwaysOnTop(value: boolean): void {
    setSettings({ alwaysOnTop: value })
    const pet = this.ensurePetWindow()
    pet.setAlwaysOnTop(value)
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
