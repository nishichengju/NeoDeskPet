import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  PresentationIpcService,
  type Live2dCapabilitiesResult,
  type PresentationIpcWindowManager,
} from '../electron/ipc/registerPresentationIpc'
import type { IpcHandle, IpcOn } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type RegisteredListener = (event: IpcMainEvent, ...args: unknown[]) => void

function fakeWindow(id: number, loading = false) {
  const send = vi.fn()
  const webContents = { id, send, isLoading: vi.fn(() => loading) } as unknown as WebContents
  const window = { isDestroyed: vi.fn(() => false), webContents } as unknown as BrowserWindow
  return { window, webContents, send }
}

function createHarness() {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const listeners = new Map<IpcChannel, RegisteredListener>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => handlers.set(channel, listener)) as IpcHandle
  const onIpc = ((channel: IpcChannel, listener: RegisteredListener) => listeners.set(channel, listener)) as IpcOn
  const settings = createDefaultSettings()
  const pet = fakeWindow(1)
  let chat: ReturnType<typeof fakeWindow> | null = fakeWindow(2)
  const ensureChatWindow = vi.fn(() => {
    chat ??= fakeWindow(3)
    return chat.window
  })
  const windowManager: PresentationIpcWindowManager = {
    getPetWindow: () => pet.window,
    getChatWindow: () => chat?.window ?? null,
    ensureChatWindow,
  }
  const setLive2dCapabilities = vi.fn((): Live2dCapabilitiesResult => ({ ok: true, value: {} }))
  const warn = vi.fn()
  const service = new PresentationIpcService({
    handle,
    onIpc,
    windowManager,
    getSettings: () => settings,
    setLive2dCapabilities,
    warn,
  })
  service.register()

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({} as IpcMainInvokeEvent, ...args) as Result
  }
  const emit = (channel: IpcChannel, senderId = 99, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`Missing listener: ${channel}`)
    listener({ sender: { id: senderId } } as IpcMainEvent, ...args)
  }
  return {
    handlers,
    listeners,
    settings,
    pet,
    get chat() { return chat },
    setChat(value: ReturnType<typeof fakeWindow> | null) { chat = value },
    ensureChatWindow,
    setLive2dCapabilities,
    warn,
    invoke,
    emit,
  }
}

describe('presentation IPC registration', () => {
  it('registers all Live2D, bubble, and ASR channels', () => {
    const harness = createHarness()
    expect([...harness.handlers.keys()]).toEqual(['asr:takeTranscript'])
    expect([...harness.listeners.keys()].sort()).toEqual([
      'asr:composePreviewSync',
      'asr:reportTranscript',
      'asr:transcriptReady',
      'bubble:preview',
      'bubble:sendMessage',
      'live2d:capabilities',
      'live2d:triggerExpression',
      'live2d:triggerMotion',
    ])
  })

  it('forwards Live2D commands and validates capability reports', () => {
    const harness = createHarness()
    harness.emit('live2d:triggerExpression', 2, 'smile')
    harness.emit('live2d:triggerMotion', 2, 'idle', 3)
    harness.emit('live2d:capabilities', 1, { modelJsonUrl: 'model.json' })
    expect(harness.pet.send).toHaveBeenCalledWith('live2d:expression', 'smile')
    expect(harness.pet.send).toHaveBeenCalledWith('live2d:motion', 'idle', 3)
    expect(harness.setLive2dCapabilities).toHaveBeenCalledWith({ modelJsonUrl: 'model.json' })

    harness.setLive2dCapabilities.mockReturnValueOnce({ ok: false, error: 'invalid' })
    harness.emit('live2d:capabilities', 1, null)
    expect(harness.warn).toHaveBeenCalledWith('[Live2D] capabilities report rejected:', 'invalid')
  })

  it('normalizes bubble previews and ASR compose previews before forwarding', () => {
    const harness = createHarness()
    harness.emit('bubble:sendMessage', 2, 'hello')
    harness.emit('bubble:preview', 2, {
      text: 'draft',
      clear: true,
      placeholder: true,
      pinPrevious: true,
      autoHideDelay: 123.9,
      ignored: 'value',
    })
    harness.emit('asr:composePreviewSync', 2, { baseText: 'prefix', clearFinals: true, ignored: true })
    expect(harness.pet.send).toHaveBeenCalledWith('bubble:message', 'hello')
    expect(harness.pet.send).toHaveBeenCalledWith('bubble:preview', {
      text: 'draft',
      clear: true,
      placeholder: true,
      pinPrevious: true,
      autoHideDelay: 123,
    })
    expect(harness.pet.send).toHaveBeenCalledWith('asr:composePreviewSync', {
      baseText: 'prefix',
      clearFinals: true,
    })
  })

  it('queues ASR transcripts until Chat reports readiness, then sends immediately', () => {
    const harness = createHarness()
    harness.emit('asr:reportTranscript', 1, ' first ')
    harness.emit('asr:reportTranscript', 1, 'second')
    expect(harness.invoke('asr:takeTranscript')).toBe('first second')
    expect(harness.invoke('asr:takeTranscript')).toBe('')

    harness.emit('asr:transcriptReady', harness.chat?.webContents.id ?? 0)
    harness.emit('asr:reportTranscript', 1, ' ready ')
    expect(harness.chat?.send).toHaveBeenCalledWith('asr:transcript', 'ready')
  })

  it('creates a hidden Chat window for auto-send and rejects readiness from another sender', () => {
    const harness = createHarness()
    harness.settings.asr.enabled = true
    harness.settings.asr.autoSend = true
    harness.setChat(null)
    harness.emit('asr:reportTranscript', 1, 'queued')
    expect(harness.ensureChatWindow).toHaveBeenCalledWith({ show: false, focus: false })
    expect(harness.invoke('asr:takeTranscript')).toBe('queued')

    const chatId = harness.chat?.webContents.id ?? 0
    harness.emit('asr:transcriptReady', chatId + 1)
    harness.emit('asr:reportTranscript', 1, 'still queued')
    expect(harness.invoke('asr:takeTranscript')).toBe('still queued')
  })
})
