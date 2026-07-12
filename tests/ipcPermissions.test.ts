import { describe, expect, it } from 'vitest'
import { assertIpcWindowAllowed, isIpcWindowAllowed } from '../electron/ipcPermissions'

describe('IPC window permissions', () => {
  it('allows only declared window types', () => {
    expect(isIpcWindowAllowed('settings', ['settings'])).toBe(true)
    expect(isIpcWindowAllowed('chat', ['settings'])).toBe(false)
    expect(isIpcWindowAllowed(null, ['settings'])).toBe(false)
  })

  it('throws a diagnosable error for an unauthorized sender', () => {
    expect(() => assertIpcWindowAllowed('settings:setAISettings', 'orb', ['settings'])).toThrow(
      'channel=settings:setAISettings; sender=orb',
    )
  })
})
