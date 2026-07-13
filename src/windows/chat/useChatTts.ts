import type {
  NeoDeskPetApi,
  TtsSegmentStartedPayload,
  TtsUtteranceEndedPayload,
  TtsUtteranceFailedPayload,
} from '../../neoDeskPetApi'
import { clampIntValue } from '../../utils/settingsHelpers'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export type ChatTtsApi = Pick<
  NeoDeskPetApi,
  'onTtsSegmentStarted' | 'onTtsUtteranceEnded' | 'onTtsUtteranceFailed'
>

export type ChatTtsUtteranceMeta = {
  utteranceId: string
  sessionId: string
  createdAt: number
  messageId: string
  displayedSegments?: number
  fallbackContent?: string
}

type StateSetter<T> = Dispatch<SetStateAction<T>>

export type ChatTtsControllerOptions = {
  setSegmentedMessageFlags: StateSetter<Record<string, true>>
  setRevealedSegments: StateSetter<Record<string, number>>
  setPendingUtteranceId: StateSetter<string | null>
  onError: (error: string) => void
  onUtteranceEnded: (sessionId: string) => void
}

function omitKeys<T>(source: Record<string, T>, keys: string[]): Record<string, T> {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

export function createChatTtsController(options: ChatTtsControllerOptions) {
  let utteranceMeta: Record<string, ChatTtsUtteranceMeta> = {}

  const beginUtterance = (utteranceId: string) => {
    const id = String(utteranceId ?? '').trim()
    if (!id) return
    options.setPendingUtteranceId(id)
    options.setRevealedSegments((prev) => ({ ...prev, [id]: 0 }))
  }

  const registerUtterance = (meta: ChatTtsUtteranceMeta) => {
    const utteranceId = String(meta.utteranceId ?? '').trim()
    const sessionId = String(meta.sessionId ?? '').trim()
    const messageId = String(meta.messageId ?? '').trim()
    if (!utteranceId || !sessionId || !messageId) return

    utteranceMeta[utteranceId] = {
      ...meta,
      utteranceId,
      sessionId,
      messageId,
      displayedSegments: clampIntValue(meta.displayedSegments, 0, 0, 1_000_000),
    }
    options.setSegmentedMessageFlags((prev) => ({ ...prev, [messageId]: true }))
  }

  const updateFallbackContent = (utteranceId: string, fallbackContent: string) => {
    const meta = utteranceMeta[utteranceId]
    if (meta) meta.fallbackContent = fallbackContent
  }

  const clearUtterance = (utteranceId: string, opts?: { removeSegmentedFlag?: boolean }) => {
    const id = String(utteranceId ?? '').trim()
    if (!id) return
    const meta = utteranceMeta[id]
    delete utteranceMeta[id]
    options.setPendingUtteranceId((prev) => (prev === id ? null : prev))
    options.setRevealedSegments((prev) => omitKeys(prev, [id, meta?.messageId ?? id]))
    if (opts?.removeSegmentedFlag && meta?.messageId) {
      options.setSegmentedMessageFlags((prev) => omitKeys(prev, [meta.messageId]) as Record<string, true>)
    }
  }

  const clearAllUtterances = () => {
    utteranceMeta = {}
    options.setPendingUtteranceId(null)
    options.setRevealedSegments({})
  }

  const handleSegmentStarted = (payload: TtsSegmentStartedPayload) => {
    const meta = utteranceMeta[payload.utteranceId]
    if (!meta) return

    const index = clampIntValue(payload.segmentIndex, -1, 0, 1_000_000)
    if (index < 0) return
    meta.displayedSegments = Math.max(meta.displayedSegments ?? 0, index + 1)

    if (index === 0) {
      options.setPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
    }
    options.setRevealedSegments((prev) => ({ ...prev, [meta.messageId]: meta.displayedSegments ?? 0 }))
  }

  const handleUtteranceFailed = (payload: TtsUtteranceFailedPayload) => {
    clearUtterance(payload.utteranceId)
    options.onError(payload.error)
  }

  const handleUtteranceEnded = (payload: TtsUtteranceEndedPayload) => {
    const sessionId = utteranceMeta[payload.utteranceId]?.sessionId
    clearUtterance(payload.utteranceId)
    if (sessionId) options.onUtteranceEnded(sessionId)
  }

  return {
    beginUtterance,
    clearAllUtterances,
    clearUtterance,
    getRegisteredUtteranceCount: () => Object.keys(utteranceMeta).length,
    handleSegmentStarted,
    handleUtteranceEnded,
    handleUtteranceFailed,
    registerUtterance,
    updateFallbackContent,
  }
}

export type ChatTtsController = ReturnType<typeof createChatTtsController>

export function subscribeChatTtsEvents(api: ChatTtsApi, controller: ChatTtsController): () => void {
  const offSegmentStarted = api.onTtsSegmentStarted(controller.handleSegmentStarted)
  const offUtteranceEnded = api.onTtsUtteranceEnded(controller.handleUtteranceEnded)
  const offUtteranceFailed = api.onTtsUtteranceFailed(controller.handleUtteranceFailed)
  return () => {
    offSegmentStarted()
    offUtteranceEnded()
    offUtteranceFailed()
  }
}

export type UseChatTtsOptions = {
  api: ChatTtsApi | null
  onError: (error: string) => void
  onUtteranceEnded: (sessionId: string) => void
}

export function useChatTts({ api, onError, onUtteranceEnded }: UseChatTtsOptions) {
  const [segmentedMessageFlags, setSegmentedMessageFlags] = useState<Record<string, true>>({})
  const [revealedSegments, setRevealedSegments] = useState<Record<string, number>>({})
  const [pendingUtteranceId, setPendingUtteranceId] = useState<string | null>(null)
  const onErrorRef = useRef(onError)
  const onUtteranceEndedRef = useRef(onUtteranceEnded)
  onErrorRef.current = onError
  onUtteranceEndedRef.current = onUtteranceEnded

  const controller = useMemo(
    () =>
      createChatTtsController({
        setSegmentedMessageFlags,
        setRevealedSegments,
        setPendingUtteranceId,
        onError: (error) => onErrorRef.current(error),
        onUtteranceEnded: (sessionId) => onUtteranceEndedRef.current(sessionId),
      }),
    [],
  )

  useEffect(() => {
    if (!api) return
    return subscribeChatTtsEvents(api, controller)
  }, [api, controller])

  return {
    beginTtsUtterance: controller.beginUtterance,
    clearAllTtsUtterances: controller.clearAllUtterances,
    clearTtsUtterance: controller.clearUtterance,
    hasActiveTts: pendingUtteranceId != null || Object.keys(revealedSegments).length > 0,
    registerTtsUtterance: controller.registerUtterance,
    ttsPendingUtteranceId: pendingUtteranceId,
    ttsRevealedSegments: revealedSegments,
    ttsSegmentedMessageFlags: segmentedMessageFlags,
    updateTtsUtteranceFallback: controller.updateFallbackContent,
  }
}
