import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../electron/types'

vi.mock('electron-store', () => ({
  default: class FakeStore {
    store: Record<string, unknown>

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = structuredClone(options.defaults ?? {})
    }
  },
}))

let normalizeSettings: (value: Partial<AppSettings> | undefined) => AppSettings

beforeAll(async () => {
  const storeModule = await import('../electron/store')
  normalizeSettings = storeModule.normalizeSettings
})

describe('settings normalization', () => {
  it('fills defaults and repairs representative legacy values without user data', () => {
    const normalized = normalizeSettings({
      petScale: 99,
      petWindowBounds: { x: 12, y: 34, width: 1, height: 1 },
      chatWindowBounds: { x: 40, y: 50, width: 420, height: 360 },
      settingsWindowBounds: { x: 60, y: 70, width: 420, height: 520 },
      memoryWindowBounds: { x: 80, y: 90, width: 560, height: 480 },
      asr: { wsUrl: 'ws://localhost:8766/ws', vadChunkMs: 320 },
      tts: { playbackTextMode: 'invalid', playbackRegexFlags: 'gzzim' },
      ai: { systemPrompt: 'You are a helpful desktop pet assistant.' },
    } as unknown as Partial<AppSettings>)

    expect(normalized.petScale).toBe(5)
    expect(normalized.petWindowBounds).toEqual({ x: 12, y: 34, width: 1750, height: 2250 })
    expect(normalized.chatWindowBounds).toEqual({ x: 40, y: 50, width: 520, height: 500 })
    expect(normalized.settingsWindowBounds).toEqual({ x: 60, y: 70, width: 640, height: 520 })
    expect(normalized.memoryWindowBounds).toEqual({ x: 80, y: 90, width: 640, height: 500 })
    expect(normalized.asr.wsUrl).toBe('ws://127.0.0.1:8000/demo/ws/realtime')
    expect(normalized.asr.vadChunkMs).toBe(200)
    expect(normalized.tts.playbackTextMode).toBe('full')
    expect(normalized.tts.playbackRegexFlags).toBe('gim')
    expect(normalized.ai.systemPrompt).toBe('')
    expect(normalized.mcp.servers).toEqual([])
  })
})
