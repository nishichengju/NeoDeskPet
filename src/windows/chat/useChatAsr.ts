import type { AppSettings, ChatMessageRecord } from '../../../electron/types'
import type { NeoDeskPetApi } from '../../neoDeskPetApi'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'

export type ChatAsrApi = Pick<
  NeoDeskPetApi,
  'syncAsrComposePreview' | 'notifyAsrTranscriptReady' | 'takeAsrTranscript' | 'onAsrTranscript'
>

export type AsrComposePreviewSync = (
  baseText: string,
  opts?: { clearFinals?: boolean; force?: boolean },
) => void

export type ChatAsrSend = (override: {
  text: string
  source: 'asr'
  baseMessages?: ChatMessageRecord[]
}) => Promise<void>

export function createAsrComposePreviewSynchronizer(api: ChatAsrApi | null): AsrComposePreviewSync {
  let lastSignature = ''

  return (baseText, opts) => {
    if (!api) return
    const normalizedBase = String(baseText ?? '')
    const clearFinals = opts?.clearFinals === true
    const signature = `${clearFinals ? '1' : '0'}\n${normalizedBase}`
    if (!opts?.force && lastSignature === signature) return
    lastSignature = signature
    try {
      api.syncAsrComposePreview({ baseText: normalizedBase, ...(clearFinals ? { clearFinals: true } : {}) })
    } catch {
      /* ignore preview transport failures */
    }
  }
}

export function useAsrComposePreview(api: ChatAsrApi | null): AsrComposePreviewSync {
  return useMemo(() => createAsrComposePreviewSynchronizer(api), [api])
}

export type ChatAsrControllerOptions = {
  api: ChatAsrApi | null
  getSettings: () => AppSettings | null
  getCurrentSessionId: () => string | null
  getInput: () => string
  getMessages: () => ChatMessageRecord[]
  setInput: (value: string) => void
  send: ChatAsrSend
  syncComposePreview: AsrComposePreviewSync
  scheduleComposeSync?: (callback: () => void) => void
}

export function createChatAsrController(options: ChatAsrControllerOptions) {
  const pendingAutoSend: string[] = []
  let flushPromise: Promise<void> | null = null
  let drainPromise: Promise<void> | null = null
  const scheduleComposeSync = options.scheduleComposeSync ?? queueMicrotask

  const canAutoSend = () => {
    const asr = options.getSettings()?.asr
    return Boolean(options.api && asr?.enabled && asr.autoSend && options.getCurrentSessionId())
  }

  const flushAutoSendQueue = (): Promise<void> => {
    if (flushPromise) return flushPromise
    if (!canAutoSend() || pendingAutoSend.length === 0) return Promise.resolve()

    const run = (async () => {
      while (canAutoSend() && pendingAutoSend.length > 0) {
        const text = pendingAutoSend.shift()
        if (!text) continue
        await options.send({ text, source: 'asr', baseMessages: options.getMessages() })
      }
    })()

    flushPromise = run.finally(() => {
      flushPromise = null
      if (canAutoSend() && pendingAutoSend.length > 0) void flushAutoSendQueue()
    })
    return flushPromise
  }

  const handleTranscript = (text: string) => {
    const cleaned = String(text ?? '').trim()
    if (!cleaned) return

    const asr = options.getSettings()?.asr
    if (!asr?.enabled) return

    if (asr.autoSend) {
      pendingAutoSend.push(cleaned)
      options.syncComposePreview('', { clearFinals: true })
      void flushAutoSendQueue()
      return
    }

    const previous = options.getInput()
    const next = previous.trim() ? `${previous} ${cleaned}` : cleaned
    options.setInput(next)
    scheduleComposeSync(() => options.syncComposePreview(next))
  }

  const notifyTranscriptReady = () => {
    try {
      options.api?.notifyAsrTranscriptReady()
    } catch {
      /* ignore readiness transport failures */
    }
  }

  const drainPendingTranscript = (acceptTranscript: () => boolean = () => true): Promise<void> => {
    if (drainPromise) return drainPromise

    drainPromise = (async () => {
      notifyTranscriptReady()
      if (!options.getSettings()?.asr?.enabled) return
      const cached = await options.api?.takeAsrTranscript().catch(() => '')
      if (!acceptTranscript()) return
      handleTranscript(cached ?? '')
    })().finally(() => {
      drainPromise = null
    })
    return drainPromise
  }

  const syncCurrentComposePreview = () => {
    const asr = options.getSettings()?.asr
    if (!asr?.enabled || asr.autoSend) {
      options.syncComposePreview('', { clearFinals: true })
      return
    }
    options.syncComposePreview(options.getInput())
  }

  const handleComposerInputChange = (next: string) => {
    options.setInput(next)
    const asr = options.getSettings()?.asr
    if (asr?.enabled && !asr.autoSend) options.syncComposePreview(next)
  }

  return {
    drainPendingTranscript,
    flushAutoSendQueue,
    getPendingAutoSendCount: () => pendingAutoSend.length,
    handleComposerInputChange,
    handleTranscript,
    notifyTranscriptReady,
    syncCurrentComposePreview,
  }
}

export type UseChatAsrOptions = {
  api: ChatAsrApi | null
  currentSessionId: string | null
  input: string
  asrEnabled: boolean
  asrAutoSend: boolean
  settingsRef: MutableRefObject<AppSettings | null>
  inputRef: MutableRefObject<string>
  messagesRef: MutableRefObject<ChatMessageRecord[]>
  setInput: Dispatch<SetStateAction<string>>
  send: ChatAsrSend
  syncComposePreview: AsrComposePreviewSync
}

export function useChatAsr(options: UseChatAsrOptions) {
  const {
    api,
    currentSessionId,
    input,
    asrEnabled,
    asrAutoSend,
    settingsRef,
    inputRef,
    messagesRef,
    setInput,
    send,
    syncComposePreview,
  } = options
  const currentSessionIdRef = useRef(currentSessionId)
  const sendRef = useRef(send)
  currentSessionIdRef.current = currentSessionId
  sendRef.current = send

  const controller = useMemo(
    () =>
      createChatAsrController({
        api,
        getSettings: () => settingsRef.current,
        getCurrentSessionId: () => currentSessionIdRef.current,
        getInput: () => inputRef.current,
        getMessages: () => messagesRef.current,
        setInput: (next) => {
          inputRef.current = next
          setInput(next)
        },
        send: (override) => sendRef.current(override),
        syncComposePreview,
      }),
    [api, inputRef, messagesRef, setInput, settingsRef, syncComposePreview],
  )

  useEffect(() => {
    if (!api) return
    let active = true
    const off = api.onAsrTranscript(controller.handleTranscript)
    void controller.drainPendingTranscript(() => active)

    const onWindowVisible = () => {
      controller.notifyTranscriptReady()
      if (document.visibilityState !== 'visible') return
      void controller.drainPendingTranscript(() => active)
    }
    window.addEventListener('focus', onWindowVisible)
    document.addEventListener('visibilitychange', onWindowVisible)
    return () => {
      active = false
      window.removeEventListener('focus', onWindowVisible)
      document.removeEventListener('visibilitychange', onWindowVisible)
      off()
    }
  }, [api, controller])

  useEffect(() => {
    void controller.flushAutoSendQueue()
  }, [asrAutoSend, asrEnabled, controller, currentSessionId])

  useEffect(() => {
    controller.syncCurrentComposePreview()
  }, [asrAutoSend, asrEnabled, controller, currentSessionId, input])

  const handleComposerInputChange = useCallback(
    (next: string) => controller.handleComposerInputChange(next),
    [controller],
  )

  return { handleComposerInputChange, syncAsrComposePreview: syncComposePreview }
}
