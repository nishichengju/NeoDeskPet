import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { WindowIpcService, type WindowIpcWindowManager } from '../electron/ipc/registerWindowIpc'
import type { IpcHandle, IpcOn } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type RegisteredListener = (event: IpcMainEvent, ...args: unknown[]) => void

function fakeWindow(id: number, bounds = { x: 10, y: 20, width: 100, height: 100 }) {
  let currentBounds = { ...bounds }
  const send = vi.fn()
  const setBounds = vi.fn((next: typeof bounds) => { currentBounds = { ...next } })
  const setPosition = vi.fn((x: number, y: number) => { currentBounds = { ...currentBounds, x, y } })
  const webContents = {
    id: id + 100,
    send,
    isLoadingMainFrame: vi.fn(() => false),
  } as unknown as WebContents
  const window = {
    id,
    webContents,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    getBounds: vi.fn(() => ({ ...currentBounds })),
    setBounds,
    setPosition,
    setIgnoreMouseEvents: vi.fn(),
  } as unknown as BrowserWindow
  return { window, webContents, send, setBounds, setPosition }
}

function createHarness() {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const listeners = new Map<IpcChannel, RegisteredListener>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => handlers.set(channel, listener)) as IpcHandle
  const onIpc = ((channel: IpcChannel, listener: RegisteredListener) => listeners.set(channel, listener)) as IpcOn
  let settings = createDefaultSettings()
  const pet = fakeWindow(1)
  const orb = fakeWindow(2, { x: 850, y: 50, width: 100, height: 100 })
  const chat = fakeWindow(3)
  const settingsWindow = fakeWindow(4)
  const memory = fakeWindow(5)
  const windowsBySender = new Map<number, BrowserWindow>([
    [pet.webContents.id, pet.window],
    [orb.webContents.id, orb.window],
    [chat.webContents.id, chat.window],
  ])
  const windowManager: WindowIpcWindowManager = {
    getAllWindows: vi.fn(() => [pet.window, orb.window, chat.window]),
    getPetWindow: vi.fn(() => pet.window),
    getOrbWindow: vi.fn(() => orb.window),
    getSettingsWindow: vi.fn(() => null),
    ensureChatWindow: vi.fn(() => chat.window),
    ensureSettingsWindow: vi.fn(() => settingsWindow.window),
    ensureMemoryWindow: vi.fn(() => memory.window),
    setDisplayMode: vi.fn(),
    hideAll: vi.fn(),
    setOrbUiState: vi.fn(),
    setOrbOverlayBounds: vi.fn(),
    clearOrbOverlayBounds: vi.fn(),
    showOrbContextMenu: vi.fn(),
    updateOrbBallBounds: vi.fn(),
    setPetDragging: vi.fn(),
    persistPetBoundsNow: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setPetOverlayHover: vi.fn(),
    setPetModelHover: vi.fn(),
  }
  let pendingTarget = ''
  let menuTemplate: MenuItemConstructorOptions[] = []
  const broadcastSettingsChanged = vi.fn()
  const syncManagedAsrApi = vi.fn(async () => {})
  const syncAsrHotkey = vi.fn()
  const quitApp = vi.fn()
  const service = new WindowIpcService({
    windowManager,
    getSettings: () => settings,
    setSettings: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    },
    settingsNavigationTargets: new Set(['aiConnection', 'persona']),
    setPendingSettingsNavigation: (target) => { pendingTarget = target },
    broadcastSettingsChanged,
    syncManagedAsrApi,
    syncAsrHotkey,
    fromWebContents: (sender) => windowsBySender.get(sender.id) ?? null,
    getCursorScreenPoint: () => ({ x: 900, y: 60 }),
    getDisplayWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    showPetContextMenu: (template) => { menuTemplate = template },
    quitApp,
  })
  service.register(handle, onIpc)

  const invoke = <Result = unknown>(channel: IpcChannel, sender = chat.webContents, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({ sender } as IpcMainInvokeEvent, ...args) as Result
  }
  const emit = (channel: IpcChannel, sender: WebContents, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`Missing listener: ${channel}`)
    listener({ sender } as IpcMainEvent, ...args)
  }
  return {
    handlers,
    listeners,
    service,
    windowManager,
    pet,
    orb,
    chat,
    settingsWindow,
    broadcastSettingsChanged,
    syncManagedAsrApi,
    syncAsrHotkey,
    quitApp,
    get pendingTarget() { return pendingTarget },
    get menuTemplate() { return menuTemplate },
    get settings() { return settings },
    invoke,
    emit,
  }
}

describe('window IPC registration', () => {
  it('registers all Window, Orb, drag, and Pet channels', () => {
    const harness = createHarness()
    expect([...harness.handlers.keys()].sort()).toEqual([
      'app:quit',
      'orb:clearOverlayBounds',
      'orb:getUiState',
      'orb:setOverlayBounds',
      'orb:setUiState',
      'orb:showContextMenu',
      'orb:toggleUiState',
      'window:closeCurrent',
      'window:hideAll',
      'window:openChat',
      'window:openMemory',
      'window:openSettings',
      'window:setDisplayMode',
    ])
    expect([...harness.listeners.keys()].sort()).toEqual([
      'pet:setModelHover',
      'pet:setOverlayHover',
      'pet:showContextMenu',
      'window:dragMove',
      'window:setIgnoreMouseEvents',
      'window:startDrag',
      'window:stopDrag',
    ])
  })

  it('opens windows, validates settings navigation, and synchronizes Orb display state', () => {
    const harness = createHarness()
    harness.invoke('window:openChat')
    harness.invoke('window:openMemory')
    harness.invoke('window:openSettings', harness.chat.webContents, 'persona')
    expect(harness.windowManager.ensureChatWindow).toHaveBeenCalled()
    expect(harness.windowManager.ensureMemoryWindow).toHaveBeenCalled()
    expect(harness.pendingTarget).toBe('persona')

    harness.invoke('window:setDisplayMode', harness.pet.webContents, ' orb ')
    expect(harness.windowManager.setDisplayMode).toHaveBeenCalledWith('orb')
    expect(harness.windowManager.setOrbUiState).toHaveBeenCalledWith('ball', { focus: true, animate: false })
    expect(harness.pet.send).toHaveBeenCalledWith('orb:stateChanged', { state: 'ball' })
    expect(harness.broadcastSettingsChanged).toHaveBeenCalled()
  })

  it('normalizes Orb state, overlay bounds, context points, close, and quit actions', () => {
    const harness = createHarness()
    expect(harness.invoke('orb:setUiState', harness.orb.webContents, 'panel', { focus: 1, animate: true })).toEqual({ state: 'panel' })
    expect(harness.invoke('orb:toggleUiState', harness.orb.webContents)).toEqual({ state: 'ball' })
    expect(harness.invoke('orb:setOverlayBounds', harness.orb.webContents, { width: 420, height: 320, focus: true })).toEqual({ ok: true })
    expect(harness.windowManager.setOrbOverlayBounds).toHaveBeenCalledWith({ width: 420, height: 320, focus: true })
    harness.invoke('orb:setOverlayBounds', harness.orb.webContents, { width: 'bad', height: 1 })
    expect(harness.windowManager.setOrbOverlayBounds).toHaveBeenCalledTimes(1)
    harness.invoke('orb:showContextMenu', harness.orb.webContents, { x: 12, y: 34 })
    expect(harness.windowManager.showOrbContextMenu).toHaveBeenCalledWith({ x: 12, y: 34 })

    harness.invoke('window:closeCurrent', harness.chat.webContents)
    expect(harness.chat.window.close).toHaveBeenCalled()
    harness.invoke('app:quit', harness.pet.webContents)
    expect(harness.quitApp).toHaveBeenCalled()
  })

  it('applies the drag threshold, locks size, persists Pet bounds, and snaps Orb windows', () => {
    const harness = createHarness()
    harness.emit('window:startDrag', harness.pet.webContents, { x: 20, y: 30 })
    harness.pet.window.setBounds({ x: 10, y: 20, width: 180, height: 160 }, false)
    harness.pet.setBounds.mockClear()
    harness.emit('window:dragMove', harness.pet.webContents, { x: 25, y: 35 })
    expect(harness.pet.setPosition).not.toHaveBeenCalled()
    expect(harness.pet.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 100, height: 100 }, false)
    harness.emit('window:dragMove', harness.pet.webContents, { x: 40, y: 50 })
    expect(harness.pet.setPosition).toHaveBeenCalledWith(30, 40, false)
    harness.emit('window:stopDrag', harness.pet.webContents, { x: 45, y: 55 })
    expect(harness.windowManager.persistPetBoundsNow).toHaveBeenCalled()
    expect(harness.windowManager.setPetDragging).toHaveBeenLastCalledWith(false)

    harness.emit('window:startDrag', harness.orb.webContents, { x: 900, y: 60 })
    harness.emit('window:dragMove', harness.orb.webContents, { x: 920, y: 80 })
    harness.emit('window:stopDrag', harness.orb.webContents)
    expect(harness.orb.setBounds).toHaveBeenLastCalledWith({ x: 892, y: 70, width: 100, height: 100 })
    expect(harness.windowManager.updateOrbBallBounds).toHaveBeenCalled()
  })

  it('builds the Pet menu and validates hover and ignore-mouse senders', () => {
    const harness = createHarness()
    harness.emit('pet:showContextMenu', harness.pet.webContents)
    const ttsItem = harness.menuTemplate.find((item) => item.label === 'TTS \u8bed\u97f3\u64ad\u62a5')
    const asrItem = harness.menuTemplate.find((item) => item.label === '\u8bed\u97f3\u8bc6\u522b\uff08ASR\uff09')
    ;(ttsItem?.click as (() => void) | undefined)?.()
    ;(asrItem?.click as (() => void) | undefined)?.()
    expect(harness.settings.tts.enabled).toBe(true)
    expect(harness.settings.asr.enabled).toBe(true)
    expect(harness.syncManagedAsrApi).toHaveBeenCalledWith('menu:toggle-asr')
    expect(harness.syncAsrHotkey).toHaveBeenCalled()

    harness.emit('pet:setOverlayHover', harness.chat.webContents, true)
    expect(harness.windowManager.setPetOverlayHover).not.toHaveBeenCalled()
    harness.emit('pet:setOverlayHover', harness.pet.webContents, true)
    harness.emit('pet:setModelHover', harness.pet.webContents, true)
    expect(harness.windowManager.setPetOverlayHover).toHaveBeenCalledWith(true)
    expect(harness.windowManager.setPetModelHover).toHaveBeenCalledWith(true)
    harness.emit('window:setIgnoreMouseEvents', harness.pet.webContents, true, true)
    expect(harness.pet.window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })
})
