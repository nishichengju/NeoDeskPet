import type { Dispatch, SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  createChatTtsController,
  subscribeChatTtsEvents,
  type ChatTtsApi,
  type ChatTtsControllerOptions,
} from '../src/windows/chat/useChatTts'

function createState<T>(initial: T) {
  let value = initial
  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
  }
  return { get: () => value, set: setValue }
}

function createController(patch: Partial<ChatTtsControllerOptions> = {}) {
  const flags = createState<Record<string, true>>({})
  const revealed = createState<Record<string, number>>({})
  const pending = createState<string | null>(null)
  const onError = patch.onError ?? vi.fn()
  const onUtteranceEnded = patch.onUtteranceEnded ?? vi.fn()
  const controller = createChatTtsController({
    setSegmentedMessageFlags: flags.set,
    setRevealedSegments: revealed.set,
    setPendingUtteranceId: pending.set,
    onError,
    onUtteranceEnded,
    ...patch,
  })
  return { controller, flags, onError, onUtteranceEnded, pending, revealed }
}

describe('Chat TTS controller', () => {
  it('registers segmented utterances and reveals segments monotonically', () => {
    const harness = createController()
    harness.controller.beginUtterance('utterance-1')
    harness.controller.registerUtterance({
      utteranceId: 'utterance-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      createdAt: 1,
    })

    expect(harness.pending.get()).toBe('utterance-1')
    expect(harness.flags.get()).toEqual({ 'message-1': true })
    expect(harness.revealed.get()).toEqual({ 'utterance-1': 0 })

    harness.controller.handleSegmentStarted({ utteranceId: 'utterance-1', segmentIndex: 2, text: 'third' })
    harness.controller.handleSegmentStarted({ utteranceId: 'utterance-1', segmentIndex: 0, text: 'first' })
    expect(harness.pending.get()).toBeNull()
    expect(harness.revealed.get()['message-1']).toBe(3)
  })

  it('ignores unknown utterances and invalid segment indexes', () => {
    const harness = createController()
    harness.controller.registerUtterance({
      utteranceId: 'utterance-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      createdAt: 1,
    })

    harness.controller.handleSegmentStarted({ utteranceId: 'missing', segmentIndex: 0, text: 'ignored' })
    harness.controller.handleSegmentStarted({ utteranceId: 'utterance-1', segmentIndex: Number.NaN, text: 'ignored' })
    expect(harness.revealed.get()).toEqual({})
  })

  it('clears failed pending utterances even before metadata registration', () => {
    const harness = createController()
    harness.controller.beginUtterance('utterance-1')
    harness.controller.handleUtteranceFailed({ utteranceId: 'utterance-1', error: 'speaker offline' })

    expect(harness.pending.get()).toBeNull()
    expect(harness.revealed.get()).toEqual({})
    expect(harness.onError).toHaveBeenCalledWith('speaker offline')
  })

  it('cleans ended utterances and schedules extraction for their origin session', () => {
    const harness = createController()
    harness.controller.beginUtterance('utterance-1')
    harness.controller.registerUtterance({
      utteranceId: 'utterance-1',
      sessionId: 'session-origin',
      messageId: 'message-1',
      createdAt: 1,
    })
    harness.controller.handleUtteranceEnded({ utteranceId: 'utterance-1' })

    expect(harness.controller.getRegisteredUtteranceCount()).toBe(0)
    expect(harness.pending.get()).toBeNull()
    expect(harness.revealed.get()).toEqual({})
    expect(harness.onUtteranceEnded).toHaveBeenCalledWith('session-origin')
  })

  it('can remove segmented control for an aborted message and reset all active state', () => {
    const harness = createController()
    harness.controller.beginUtterance('utterance-1')
    harness.controller.registerUtterance({
      utteranceId: 'utterance-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      createdAt: 1,
    })
    harness.controller.clearUtterance('utterance-1', { removeSegmentedFlag: true })
    expect(harness.flags.get()).toEqual({})

    harness.controller.beginUtterance('utterance-2')
    harness.controller.clearAllUtterances()
    expect(harness.pending.get()).toBeNull()
    expect(harness.revealed.get()).toEqual({})
  })

  it('subscribes and unsubscribes all renderer TTS events', () => {
    const offSegment = vi.fn()
    const offEnded = vi.fn()
    const offFailed = vi.fn()
    const api: ChatTtsApi = {
      onTtsSegmentStarted: vi.fn(() => offSegment),
      onTtsUtteranceEnded: vi.fn(() => offEnded),
      onTtsUtteranceFailed: vi.fn(() => offFailed),
    }
    const harness = createController()
    const unsubscribe = subscribeChatTtsEvents(api, harness.controller)
    unsubscribe()

    expect(api.onTtsSegmentStarted).toHaveBeenCalledWith(harness.controller.handleSegmentStarted)
    expect(api.onTtsUtteranceEnded).toHaveBeenCalledWith(harness.controller.handleUtteranceEnded)
    expect(api.onTtsUtteranceFailed).toHaveBeenCalledWith(harness.controller.handleUtteranceFailed)
    expect(offSegment).toHaveBeenCalledOnce()
    expect(offEnded).toHaveBeenCalledOnce()
    expect(offFailed).toHaveBeenCalledOnce()
  })
})
