import { describe, expect, it } from 'vitest'
import { getDialogFocusWrapTarget } from '../src/hooks/useDialogFocus'

describe('dialog focus wrapping', () => {
  it('enters and wraps the focusable range in both directions', () => {
    expect(getDialogFocusWrapTarget(-1, 3, false)).toBe(0)
    expect(getDialogFocusWrapTarget(-1, 3, true)).toBe(2)
    expect(getDialogFocusWrapTarget(0, 3, true)).toBe(2)
    expect(getDialogFocusWrapTarget(2, 3, false)).toBe(0)
    expect(getDialogFocusWrapTarget(1, 3, false)).toBeNull()
    expect(getDialogFocusWrapTarget(0, 0, false)).toBeNull()
  })
})
