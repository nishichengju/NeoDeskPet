import { describe, expect, it } from 'vitest'
import { isAllowedLocalMediaPath, isPathWithinRoot } from '../electron/localMediaPolicy'

const windowsRoot = 'C:\\Users\\DeskPet\\AppData\\Roaming\\neodeskpet-electron\\chat-attachments'

describe('local media path policy', () => {
  it('accepts files inside an allowed Windows root case-insensitively', () => {
    expect(isPathWithinRoot(`${windowsRoot}\\images\\one.png`, windowsRoot)).toBe(true)
    expect(isPathWithinRoot('c:\\users\\deskpet\\appdata\\roaming\\neodeskpet-electron\\chat-attachments\\ONE.PNG', windowsRoot)).toBe(true)
  })

  it('rejects sibling prefixes and traversal outside the root', () => {
    expect(isPathWithinRoot(`${windowsRoot}-other\\one.png`, windowsRoot)).toBe(false)
    expect(isPathWithinRoot(`${windowsRoot}\\..\\settings.json`, windowsRoot)).toBe(false)
  })

  it('rejects UNC paths unless the policy explicitly allows them', () => {
    const candidate = '\\\\server\\share\\media\\one.png'
    const policy = { allowedRoots: ['\\\\server\\share\\media'] }
    expect(isAllowedLocalMediaPath(candidate, policy)).toBe(false)
    expect(isAllowedLocalMediaPath(candidate, { ...policy, allowUnc: true })).toBe(true)
  })

  it('supports POSIX roots for non-Windows builds', () => {
    expect(isAllowedLocalMediaPath('/home/user/media/one.png', { allowedRoots: ['/home/user/media'], pathStyle: 'posix' })).toBe(true)
    expect(isAllowedLocalMediaPath('/home/user/media-old/one.png', { allowedRoots: ['/home/user/media'], pathStyle: 'posix' })).toBe(false)
  })
})
