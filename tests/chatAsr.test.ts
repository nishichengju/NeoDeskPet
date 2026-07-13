import type { AppSettings, ChatMessageRecord } from '../electron/types'
import { describe, expect, it, vi } from 'vitest'
import {
  createAsrComposePreviewSynchronizer,
  createChatAsrController,
  type ChatAsrApi,
  type ChatAsrControllerOptions,
} from '../src/windows/chat/useChatAsr'

function createApi(patch: Partial<ChatAsrApi> = {}): ChatAsrApi {
  return {
    syncAsrComposePreview: vi.fn(),
    notifyAsrTranscriptReady: vi.fn(),
    takeAsrTranscript: vi.fn(async () => ''),
    onAsrTranscript: vi.fn(() => () => undefined),
    ...patch,
  }
}

function createController(patch: Partial<ChatAsrControllerOptions> = {}) {
  const api = patch.api ?? createApi()
  let settings = {
    asr: { enabled: true, autoSend: false },
  } as AppSettings
  let currentSessionId: string | null = 'session-1'
  let input = ''
  let messages: ChatMessageRecord[] = []
  const send = patch.send ?? vi.fn(async () => undefined)
  const syncComposePreview = patch.syncComposePreview ?? vi.fn()
  const controller = createChatAsrController({
    api,
    getSettings: () => settings,
    getCurrentSessionId: () => currentSessionId,
    getInput: () => input,
    getMessages: () => messages,
    setInput: (next) => {
      input = next
    },
    send,
    syncComposePreview,
    scheduleComposeSync: (callback) => callback(),
    ...patch,
  })

  return {
    api,
    controller,
    getInput: () => input,
    send,
    setAsr: (enabled: boolean, autoSend: boolean) => {
      settings = { ...settings, asr: { ...settings.asr, enabled, autoSend } }
    },
    setCurrentSessionId: (next: string | null) => {
      currentSessionId = next
    },
    setMessages: (next: ChatMessageRecord[]) => {
      messages = next
    },
    syncComposePreview,
  }
}

describe('Chat ASR controller', () => {
  it('deduplicates compose previews while preserving clear and force semantics', () => {
    const api = createApi()
    const sync = createAsrComposePreviewSynchronizer(api)

    sync('draft')
    sync('draft')
    sync('', { clearFinals: true })
    sync('', { clearFinals: true, force: true })

    expect(api.syncAsrComposePreview).toHaveBeenCalledTimes(3)
    expect(api.syncAsrComposePreview).toHaveBeenNthCalledWith(1, { baseText: 'draft' })
    expect(api.syncAsrComposePreview).toHaveBeenNthCalledWith(2, { baseText: '', clearFinals: true })
    expect(api.syncAsrComposePreview).toHaveBeenNthCalledWith(3, { baseText: '', clearFinals: true })
  })

  it('appends manual transcripts to the composer and mirrors the new preview', () => {
    const harness = createController()
    harness.controller.handleComposerInputChange('existing')
    harness.controller.handleTranscript('  spoken words  ')

    expect(harness.getInput()).toBe('existing spoken words')
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.syncComposePreview).toHaveBeenLastCalledWith('existing spoken words')
  })

  it('queues auto-send transcripts until a session exists, then flushes them in order', async () => {
    const harness = createController()
    harness.setAsr(true, true)
    harness.setCurrentSessionId(null)
    harness.controller.handleTranscript('first')
    harness.controller.handleTranscript('second')

    expect(harness.controller.getPendingAutoSendCount()).toBe(2)
    expect(harness.send).not.toHaveBeenCalled()

    harness.setCurrentSessionId('session-2')
    await harness.controller.flushAutoSendQueue()

    expect(harness.send).toHaveBeenCalledTimes(2)
    expect(harness.send).toHaveBeenNthCalledWith(1, { text: 'first', source: 'asr', baseMessages: [] })
    expect(harness.send).toHaveBeenNthCalledWith(2, { text: 'second', source: 'asr', baseMessages: [] })
    expect(harness.controller.getPendingAutoSendCount()).toBe(0)
  })

  it('serializes auto-send work when transcripts arrive during an active send', async () => {
    let releaseFirst: (() => void) | undefined
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const send = vi.fn(async ({ text }: { text: string }) => {
      if (text === 'first') await firstPending
    })
    const harness = createController({ send })
    harness.setAsr(true, true)

    harness.controller.handleTranscript('first')
    harness.controller.handleTranscript('second')
    expect(send).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await harness.controller.flushAutoSendQueue()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'second'])
  })

  it('coalesces pending transcript drains and ignores disabled ASR input', async () => {
    let releaseTranscript: ((value: string) => void) | undefined
    const cachedTranscript = new Promise<string>((resolve) => {
      releaseTranscript = resolve
    })
    const api = createApi({ takeAsrTranscript: vi.fn(() => cachedTranscript) })
    const harness = createController({ api })

    const firstDrain = harness.controller.drainPendingTranscript()
    const secondDrain = harness.controller.drainPendingTranscript()
    expect(api.takeAsrTranscript).toHaveBeenCalledTimes(1)
    expect(firstDrain).toBe(secondDrain)

    releaseTranscript?.('cached words')
    await firstDrain
    expect(harness.getInput()).toBe('cached words')

    harness.setAsr(false, false)
    harness.controller.handleTranscript('ignored')
    expect(harness.getInput()).toBe('cached words')
  })
})
