import { describe, expect, it } from 'vitest'
import {
  MANAGED_WINDOW_SIZE_POLICIES,
  createDefaultManagedWindowBounds,
  normalizeManagedWindowBounds,
} from '../electron/windowBounds'

describe('managed window bounds', () => {
  it('uses the P1-1 default sizes for fresh settings', () => {
    expect(createDefaultManagedWindowBounds('chat')).toEqual({ width: 720, height: 620 })
    expect(createDefaultManagedWindowBounds('settings')).toEqual({ width: 860, height: 680 })
    expect(createDefaultManagedWindowBounds('memory')).toEqual({ width: 900, height: 720 })
  })

  it('raises legacy small sizes to the minimum while preserving position', () => {
    expect(normalizeManagedWindowBounds('chat', { x: -1200, y: 80, width: 420, height: 360 })).toEqual({
      x: -1200,
      y: 80,
      width: MANAGED_WINDOW_SIZE_POLICIES.chat.minWidth,
      height: MANAGED_WINDOW_SIZE_POLICIES.chat.minHeight,
    })
    expect(normalizeManagedWindowBounds('settings', { x: 20, y: 30, width: 420, height: 520 })).toEqual({
      x: 20,
      y: 30,
      width: MANAGED_WINDOW_SIZE_POLICIES.settings.minWidth,
      height: 520,
    })
  })

  it('keeps user sizes that already satisfy the minimum', () => {
    expect(normalizeManagedWindowBounds('memory', { x: 10, y: 20, width: 1200, height: 840 })).toEqual({
      x: 10,
      y: 20,
      width: 1200,
      height: 840,
    })
  })
})
