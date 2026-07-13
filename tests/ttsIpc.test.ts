import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { TtsIpcService, validateTtsUrl, type TtsFetch } from '../electron/ipc/registerTtsIpc'
import type { IpcHandle, IpcOn } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type RegisteredListener = (event: IpcMainEvent, ...args: unknown[]) => void

function fakeWindow() {
  const send = vi.fn()
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { send },
  } as unknown as BrowserWindow
  return { window, send }
}

function createHarness(fetchImpl: TtsFetch = vi.fn()) {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const listeners = new Map<IpcChannel, RegisteredListener>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => handlers.set(channel, listener)) as IpcHandle
  const on = ((channel: IpcChannel, listener: RegisteredListener) => listeners.set(channel, listener)) as IpcOn
  const settings = createDefaultSettings()
  settings.tts.baseUrl = 'http://127.0.0.1:9880'
  const pet = fakeWindow()
  const chat = fakeWindow()
  const listOptions = vi.fn((ttsRoot: string) => ({ gptModels: [], sovitsModels: [], refAudios: [], ttsRoot }))
  const service = new TtsIpcService({
    getSettings: () => settings,
    getPetWindow: () => pet.window,
    getChatWindow: () => chat.window,
    appRoot: 'C:\\NeoDeskPet',
    listOptions,
    fetchImpl,
    createStreamId: () => 'stream-1',
  })
  service.register(handle, on)

  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() } as unknown as WebContents
  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({ sender } as IpcMainInvokeEvent, ...args) as Result
  }
  const emit = (channel: IpcChannel, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`Missing listener: ${channel}`)
    listener({} as IpcMainEvent, ...args)
  }
  return { handlers, listeners, settings, pet, chat, listOptions, service, sender, invoke, emit }
}

describe('TTS IPC registration', () => {
  it('registers all TTS channels and resolves configured or default option roots', () => {
    const harness = createHarness()
    expect([...harness.handlers.keys()].sort()).toEqual([
      'tts:httpGetJson',
      'tts:httpRequestArrayBuffer',
      'tts:httpStreamCancel',
      'tts:httpStreamStart',
      'tts:listOptions',
    ])
    expect([...harness.listeners.keys()].sort()).toEqual([
      'tts:enqueue',
      'tts:finalize',
      'tts:segmentStarted',
      'tts:stopAll',
      'tts:utteranceEnded',
      'tts:utteranceFailed',
    ])

    expect(harness.invoke<{ ttsRoot: string }>('tts:listOptions').ttsRoot).toContain('GPT-SoVITS-v2_ProPlus')
    harness.settings.tts.ttsRoot = ' D:\\GPT-SoVITS '
    expect(harness.invoke<{ ttsRoot: string }>('tts:listOptions').ttsRoot).toBe('D:\\GPT-SoVITS')
  })

  it('enforces the configured origin and TTS endpoint allowlist', () => {
    expect(validateTtsUrl('http://127.0.0.1:9880/tts?text=hello', 'http://127.0.0.1:9880/').pathname).toBe('/tts')
    expect(() => validateTtsUrl('http://localhost:9880/tts', 'http://127.0.0.1:9880')).toThrow('same-origin')
    expect(() => validateTtsUrl('http://127.0.0.1:9880/admin', 'http://127.0.0.1:9880')).toThrow('不允许')
    expect(() => validateTtsUrl('http://127.0.0.1:9880/tts', '')).toThrow('not configured')
  })

  it('proxies JSON and array-buffer requests with the existing response contract', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, statusText: 'OK' }))
      .mockResolvedValueOnce(new Response('bad', { status: 503, statusText: 'Offline', headers: { 'content-type': 'text/plain' } }))
    const harness = createHarness(fetchImpl)

    await expect(harness.invoke<Promise<unknown>>('tts:httpGetJson', 'http://127.0.0.1:9880/set_gpt_weights'))
      .resolves.toMatchObject({ ok: true, status: 200, json: { ok: true } })
    await expect(
      harness.invoke<Promise<unknown>>('tts:httpRequestArrayBuffer', {
        url: 'http://127.0.0.1:9880/tts',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        timeoutMs: 10,
      }),
    ).resolves.toMatchObject({ ok: false, status: 503, contentType: 'text/plain', error: 'HTTP 503: Offline' })
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('forwards stream chunks and completion to the invoking renderer', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    const harness = createHarness(
      vi.fn<[string, RequestInit?], Promise<Response>>().mockResolvedValue(new Response(body, { status: 200 })),
    )

    await expect(
      harness.invoke<Promise<unknown>>('tts:httpStreamStart', { url: 'http://127.0.0.1:9880/tts' }),
    ).resolves.toEqual({ streamId: 'stream-1' })
    await vi.waitFor(() => expect(harness.sender.send).toHaveBeenCalledWith('tts:httpStreamDone', { streamId: 'stream-1' }))
    expect(harness.sender.send).toHaveBeenCalledWith('tts:httpStreamChunk', {
      streamId: 'stream-1',
      chunk: new Uint8Array([1, 2, 3]),
    })
  })

  it('cancels active streams and relays TTS state between Chat and Pet', async () => {
    const fetchImpl = vi.fn<[string, RequestInit?], Promise<Response>>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    )
    const harness = createHarness(fetchImpl)
    await harness.invoke<Promise<unknown>>('tts:httpStreamStart', { url: 'http://127.0.0.1:9880/tts' })
    expect(harness.invoke('tts:httpStreamCancel', 'stream-1')).toEqual({ ok: true })
    await vi.waitFor(() => expect(harness.sender.send).toHaveBeenCalledWith('tts:httpStreamDone', { streamId: 'stream-1' }))

    harness.emit('tts:enqueue', { utteranceId: 'u1' })
    harness.emit('tts:finalize', 'u1')
    harness.emit('tts:stopAll')
    harness.emit('tts:segmentStarted', { utteranceId: 'u1', segmentIndex: 0 })
    harness.emit('tts:utteranceEnded', { utteranceId: 'u1' })
    harness.emit('tts:utteranceFailed', { utteranceId: 'u1', error: 'failed' })
    expect(harness.pet.send).toHaveBeenCalledWith('tts:enqueue', { utteranceId: 'u1' })
    expect(harness.pet.send).toHaveBeenCalledWith('tts:finalize', 'u1')
    expect(harness.pet.send).toHaveBeenCalledWith('tts:stopAll')
    expect(harness.chat.send).toHaveBeenCalledWith('tts:segmentStarted', { utteranceId: 'u1', segmentIndex: 0 })
    expect(harness.chat.send).toHaveBeenCalledWith('tts:utteranceEnded', { utteranceId: 'u1' })
    expect(harness.chat.send).toHaveBeenCalledWith('tts:utteranceFailed', { utteranceId: 'u1', error: 'failed' })
  })
})
