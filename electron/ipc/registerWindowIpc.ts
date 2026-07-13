import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import type { AppSettings, DisplayMode, OrbUiState, SettingsNavigationTarget } from '../types'
import type { IpcHandle, IpcOn } from './registration'

type Point = { x: number; y: number }
type Rectangle = { x: number; y: number; width: number; height: number }

type WindowDragSession = {
  senderId: number
  window: BrowserWindow
  isPetWindow: boolean
  isOrbWindow: boolean
  lockedWidth: number
  lockedHeight: number
  startCursor: Point
  offsetX: number
  offsetY: number
  activated: boolean
  lastX: number
  lastY: number
}

export type WindowIpcWindowManager = {
  getAllWindows: () => BrowserWindow[]
  getPetWindow: () => BrowserWindow | null
  getOrbWindow: () => BrowserWindow | null
  getSettingsWindow: () => BrowserWindow | null
  ensureChatWindow: () => BrowserWindow
  ensureSettingsWindow: () => BrowserWindow
  ensureMemoryWindow: () => BrowserWindow
  setDisplayMode: (mode: DisplayMode) => void
  hideAll: () => void
  setOrbUiState: (state: OrbUiState, opts: { focus: boolean; animate: boolean }) => void
  setOrbOverlayBounds: (payload: { width: number; height: number; focus?: boolean }) => void
  clearOrbOverlayBounds: (payload?: { focus?: boolean }) => void
  showOrbContextMenu: (point: Point) => void
  updateOrbBallBounds: () => void
  setPetDragging: (dragging: boolean) => void
  persistPetBoundsNow: () => void
  setAlwaysOnTop: (value: boolean) => void
  setPetOverlayHover: (hovering: boolean) => void
  setPetModelHover: (hovering: boolean) => void
}

export type WindowIpcDependencies = {
  windowManager: WindowIpcWindowManager
  getSettings: () => AppSettings
  setSettings: (settings: Partial<AppSettings>) => AppSettings
  settingsNavigationTargets: ReadonlySet<SettingsNavigationTarget>
  setPendingSettingsNavigation: (target: SettingsNavigationTarget) => void
  broadcastSettingsChanged: () => void
  syncManagedAsrApi: (reason: string) => Promise<void>
  syncAsrHotkey: () => void
  fromWebContents: (webContents: WebContents) => BrowserWindow | null
  getCursorScreenPoint: () => Point
  getDisplayWorkArea: (point: Point) => Rectangle
  showPetContextMenu: (template: MenuItemConstructorOptions[], window: BrowserWindow) => void
  quitApp: () => void
}

function parsePoint(payload: unknown): Point | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const object = payload as Record<string, unknown>
  const x = typeof object.x === 'number' ? object.x : Number.NaN
  const y = typeof object.y === 'number' ? object.y : Number.NaN
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export class WindowIpcService {
  private orbUiState: OrbUiState = 'ball'
  private readonly dragSessions = new Map<number, WindowDragSession>()

  constructor(private readonly deps: WindowIpcDependencies) {}

  register(handle: IpcHandle, onIpc: IpcOn): void {
    handle('window:openChat', () => {
      this.deps.windowManager.ensureChatWindow()
    })
    handle('window:openSettings', (_event, targetRaw?: unknown) => this.openSettings(targetRaw))
    handle('window:openMemory', () => {
      this.deps.windowManager.ensureMemoryWindow()
    })
    handle('window:setDisplayMode', (_event, modeRaw: unknown) => this.setDisplayMode(modeRaw))
    handle('window:hideAll', () => {
      this.deps.windowManager.hideAll()
    })
    handle('window:closeCurrent', (event) => {
      const window = this.deps.fromWebContents(event.sender)
      if (window && !window.isDestroyed()) window.close()
    })
    handle('app:quit', () => this.deps.quitApp())

    handle('orb:getUiState', () => ({ state: this.orbUiState }))
    handle('orb:setUiState', (_event, stateRaw: unknown, optsRaw: unknown) => this.setOrbUiState(stateRaw, optsRaw))
    handle('orb:toggleUiState', () => this.toggleOrbUiState())
    handle('orb:setOverlayBounds', (_event, payload: unknown) => this.setOrbOverlayBounds(payload))
    handle('orb:clearOverlayBounds', (_event, payload: unknown) => this.clearOrbOverlayBounds(payload))
    handle('orb:showContextMenu', (_event, point: unknown) => this.showOrbContextMenu(point))

    onIpc('window:startDrag', (event, payload: unknown) => this.startDrag(event.sender, payload))
    onIpc('window:dragMove', (event, payload: unknown) => this.dragMove(event.sender, payload))
    onIpc('window:stopDrag', (event, payload: unknown) => this.stopDrag(event.sender, payload))
    onIpc('pet:showContextMenu', (event) => this.showPetContextMenu(event.sender))
    onIpc('pet:setOverlayHover', (event, hovering: boolean) => this.setPetHover(event.sender, hovering, 'overlay'))
    onIpc('pet:setModelHover', (event, hovering: boolean) => this.setPetHover(event.sender, hovering, 'model'))
    onIpc('window:setIgnoreMouseEvents', (event, ignore: boolean, forward: boolean) => {
      const window = this.deps.fromWebContents(event.sender)
      if (!window || window.isDestroyed()) return
      window.setIgnoreMouseEvents(ignore, { forward })
    })
  }

  syncOrbWindow(opts: { focus: boolean; animate: boolean }): void {
    this.broadcastOrbStateChanged()
    this.deps.windowManager.setOrbUiState(this.orbUiState, opts)
  }

  close(): void {
    for (const session of [...this.dragSessions.values()]) this.cleanupDragSession(session)
  }

  private openSettings(targetRaw: unknown): void {
    const target = typeof targetRaw === 'string' && this.deps.settingsNavigationTargets.has(targetRaw as SettingsNavigationTarget)
      ? (targetRaw as SettingsNavigationTarget)
      : null
    if (target) this.deps.setPendingSettingsNavigation(target)
    const existing = this.deps.windowManager.getSettingsWindow()
    const window = this.deps.windowManager.ensureSettingsWindow()
    if (target && existing && !window.webContents.isLoadingMainFrame()) {
      window.webContents.send('settings:navigate', target)
    }
  }

  private setDisplayMode(modeRaw: unknown): void {
    const mode = typeof modeRaw === 'string' ? (modeRaw.trim() as DisplayMode) : ''
    if (mode !== 'live2d' && mode !== 'orb' && mode !== 'hidden') return
    this.deps.windowManager.setDisplayMode(mode)
    if (mode === 'orb') this.syncOrbWindow({ focus: true, animate: false })
    this.deps.broadcastSettingsChanged()
  }

  private setOrbUiState(stateRaw: unknown, optsRaw: unknown): { state: OrbUiState } {
    const state = typeof stateRaw === 'string' ? (stateRaw.trim() as OrbUiState) : ''
    if (state !== 'ball' && state !== 'bar' && state !== 'panel') return { state: this.orbUiState }
    const options = optsRaw && typeof optsRaw === 'object' && !Array.isArray(optsRaw)
      ? (optsRaw as Record<string, unknown>)
      : null
    this.orbUiState = state
    this.deps.windowManager.setOrbUiState(state, {
      focus: options ? Boolean(options.focus) : false,
      animate: options ? Boolean(options.animate) : false,
    })
    this.broadcastOrbStateChanged()
    return { state }
  }

  private toggleOrbUiState(): { state: OrbUiState } {
    this.orbUiState = this.orbUiState === 'ball' ? 'bar' : this.orbUiState === 'bar' ? 'panel' : 'ball'
    this.deps.windowManager.setOrbUiState(this.orbUiState, { focus: true, animate: false })
    this.broadcastOrbStateChanged()
    return { state: this.orbUiState }
  }

  private setOrbOverlayBounds(payload: unknown): { ok: true } {
    const object = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
    const width = typeof object?.width === 'number' ? object.width : Number.NaN
    const height = typeof object?.height === 'number' ? object.height : Number.NaN
    if (Number.isFinite(width) && Number.isFinite(height)) {
      this.deps.windowManager.setOrbOverlayBounds({ width, height, focus: Boolean(object?.focus) })
    }
    return { ok: true }
  }

  private clearOrbOverlayBounds(payload: unknown): { ok: true } {
    const object = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
    this.deps.windowManager.clearOrbOverlayBounds({ focus: Boolean(object?.focus) })
    return { ok: true }
  }

  private showOrbContextMenu(point: unknown): { ok: true } {
    const parsed = parsePoint(point)
    if (parsed) this.deps.windowManager.showOrbContextMenu(parsed)
    return { ok: true }
  }

  private startDrag(sender: WebContents, payload: unknown): void {
    const window = this.deps.fromWebContents(sender)
    if (!window || window.isDestroyed()) return
    const oldSession = this.dragSessions.get(sender.id)
    if (oldSession) this.cleanupDragSession(oldSession)

    const bounds = window.getBounds()
    const petWindow = this.deps.windowManager.getPetWindow()
    const orbWindow = this.deps.windowManager.getOrbWindow()
    const cursor = parsePoint(payload) ?? this.deps.getCursorScreenPoint()
    const isPetWindow = Boolean(petWindow && petWindow.id === window.id)
    if (isPetWindow) this.deps.windowManager.setPetDragging(true)
    this.dragSessions.set(sender.id, {
      senderId: sender.id,
      window,
      isPetWindow,
      isOrbWindow: Boolean(orbWindow && orbWindow.id === window.id),
      lockedWidth: bounds.width,
      lockedHeight: bounds.height,
      startCursor: cursor,
      offsetX: cursor.x - bounds.x,
      offsetY: cursor.y - bounds.y,
      activated: false,
      lastX: bounds.x,
      lastY: bounds.y,
    })
  }

  private dragMove(sender: WebContents, payload: unknown): void {
    const session = this.dragSessions.get(sender.id)
    if (!session) return
    this.applyDragMove(session, parsePoint(payload) ?? this.deps.getCursorScreenPoint())
  }

  private stopDrag(sender: WebContents, payload: unknown): void {
    const session = this.dragSessions.get(sender.id)
    if (!session) {
      const window = this.deps.fromWebContents(sender)
      const petWindow = this.deps.windowManager.getPetWindow()
      if (window && petWindow && window.id === petWindow.id) this.deps.windowManager.setPetDragging(false)
      return
    }
    const cursor = parsePoint(payload)
    if (cursor) this.applyDragMove(session, cursor)
    if (session.isPetWindow) {
      try {
        this.deps.windowManager.persistPetBoundsNow()
      } catch {
        // Persistence failures should not leave a drag session active.
      }
    }
    this.cleanupDragSession(session, { snapOrb: true })
  }

  private applyDragMove(session: WindowDragSession, cursor: Point): void {
    if (session.window.isDestroyed()) {
      this.cleanupDragSession(session)
      return
    }
    const bounds = session.window.getBounds()
    if (bounds.width !== session.lockedWidth || bounds.height !== session.lockedHeight) {
      session.window.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: session.lockedWidth,
        height: session.lockedHeight,
      }, false)
    }
    if (!session.activated) {
      const dx = cursor.x - session.startCursor.x
      const dy = cursor.y - session.startCursor.y
      if (dx * dx + dy * dy < 100) return
      session.activated = true
    }
    const x = Math.round(cursor.x - session.offsetX)
    const y = Math.round(cursor.y - session.offsetY)
    if (x === session.lastX && y === session.lastY) return
    session.window.setPosition(x, y, false)
    session.lastX = x
    session.lastY = y
  }

  private cleanupDragSession(session: WindowDragSession, opts?: { snapOrb?: boolean }): void {
    this.dragSessions.delete(session.senderId)
    if (session.isPetWindow) this.deps.windowManager.setPetDragging(false)
    if (opts?.snapOrb && session.isOrbWindow && session.activated && !session.window.isDestroyed()) {
      try {
        this.snapOrbToSide(session.window)
      } catch {
        // Ignore display changes that race with drag completion.
      }
    }
  }

  private snapOrbToSide(window: BrowserWindow): void {
    const workArea = this.deps.getDisplayWorkArea(this.deps.getCursorScreenPoint())
    const bounds = window.getBounds()
    const dockLeft = bounds.x + bounds.width / 2 < workArea.x + workArea.width / 2
    const margin = 8
    const x = dockLeft ? workArea.x + margin : workArea.x + workArea.width - bounds.width - margin
    const y = Math.max(workArea.y + margin, Math.min(bounds.y, workArea.y + workArea.height - bounds.height - margin))
    window.setBounds({ x, y, width: bounds.width, height: bounds.height })
    this.deps.windowManager.updateOrbBallBounds()
  }

  private showPetContextMenu(sender: WebContents): void {
    const window = this.deps.fromWebContents(sender)
    if (!window || window.isDestroyed()) return
    const settings = this.deps.getSettings()
    const template: MenuItemConstructorOptions[] = [
      { label: '\u6253\u5f00\u804a\u5929', click: () => { this.deps.windowManager.ensureChatWindow() } },
      { label: '\u8bbe\u7f6e', click: () => { this.deps.windowManager.ensureSettingsWindow() } },
      {
        label: '\u5207\u6362\u5230\u60ac\u6d6e\u7403',
        click: () => {
          this.deps.windowManager.setDisplayMode('orb')
          this.deps.broadcastSettingsChanged()
        },
      },
      {
        label: '\u4ec5\u6258\u76d8\u9690\u85cf',
        click: () => {
          this.deps.windowManager.setDisplayMode('hidden')
          this.deps.broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      {
        label: '\u7f6e\u9876\u663e\u793a',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: () => {
          this.deps.windowManager.setAlwaysOnTop(!settings.alwaysOnTop)
          this.deps.broadcastSettingsChanged()
        },
      },
      {
        label: 'TTS \u8bed\u97f3\u64ad\u62a5',
        type: 'checkbox',
        checked: settings.tts?.enabled ?? false,
        click: () => {
          const current = this.deps.getSettings()
          this.deps.setSettings({ tts: { ...current.tts, enabled: !current.tts.enabled } })
          this.deps.broadcastSettingsChanged()
        },
      },
      {
        label: '\u8bed\u97f3\u8bc6\u522b\uff08ASR\uff09',
        type: 'checkbox',
        checked: settings.asr?.enabled ?? false,
        click: () => {
          const current = this.deps.getSettings()
          this.deps.setSettings({ asr: { ...current.asr, enabled: !current.asr.enabled } })
          void this.deps.syncManagedAsrApi('menu:toggle-asr')
          this.deps.syncAsrHotkey()
          this.deps.broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      { label: '\u9690\u85cf\u5ba0\u7269', click: () => { this.deps.windowManager.hideAll() } },
      { label: '\u9000\u51fa', click: () => { this.deps.quitApp() } },
    ]
    this.deps.showPetContextMenu(template, window)
  }

  private setPetHover(sender: WebContents, hovering: boolean, kind: 'overlay' | 'model'): void {
    const window = this.deps.fromWebContents(sender)
    const petWindow = this.deps.windowManager.getPetWindow()
    if (!window || !petWindow || window.id !== petWindow.id) return
    if (kind === 'overlay') this.deps.windowManager.setPetOverlayHover(Boolean(hovering))
    else this.deps.windowManager.setPetModelHover(Boolean(hovering))
  }

  private broadcastOrbStateChanged(): void {
    for (const window of this.deps.windowManager.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('orb:stateChanged', { state: this.orbUiState })
    }
  }
}
