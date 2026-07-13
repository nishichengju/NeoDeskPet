import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IPC_CHANNEL_PERMISSIONS,
  IpcSecurityError,
  assertIpcWindowAllowed,
  authorizeIpcSender,
  isIpcWindowAllowed,
  isTrustedApplicationUrl,
} from '../electron/ipcPermissions'

function listTypeScriptSources(directory: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptSources(fullPath))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath)
  }
  return files
}

const trustedRequest = {
  channel: 'settings:get',
  senderWindowType: 'settings' as const,
  allowed: ['settings'] as const,
  isMainFrame: true,
  isFrameUrlTrusted: true,
  isWebContentsUrlTrusted: true,
}

describe('IPC window permissions', () => {
  it('allows only declared window types', () => {
    expect(isIpcWindowAllowed('settings', ['settings'])).toBe(true)
    expect(isIpcWindowAllowed('chat', ['settings'])).toBe(false)
    expect(isIpcWindowAllowed(null, ['settings'])).toBe(false)
  })

  it('returns a uniform security error for an unauthorized sender', () => {
    expect(() => assertIpcWindowAllowed('settings:setAISettings', 'orb', ['settings'])).toThrow(IpcSecurityError)
    expect(() => assertIpcWindowAllowed('settings:setAISettings', 'orb', ['settings'])).toThrow(
      'channel=settings:setAISettings; sender=orb; reason=window-not-allowed',
    )
  })

  it('rejects unknown senders, subframes, untrusted URLs, and disallowed windows', () => {
    expect(authorizeIpcSender({ ...trustedRequest, senderWindowType: null })).toEqual({
      allowed: false,
      reason: 'unknown-sender',
    })
    expect(authorizeIpcSender({ ...trustedRequest, isMainFrame: false })).toEqual({
      allowed: false,
      reason: 'subframe',
    })
    expect(authorizeIpcSender({ ...trustedRequest, isFrameUrlTrusted: false })).toEqual({
      allowed: false,
      reason: 'untrusted-frame-url',
    })
    expect(authorizeIpcSender({ ...trustedRequest, isWebContentsUrlTrusted: false })).toEqual({
      allowed: false,
      reason: 'untrusted-webcontents-url',
    })
    expect(authorizeIpcSender({ ...trustedRequest, senderWindowType: 'chat' })).toEqual({
      allowed: false,
      reason: 'window-not-allowed',
    })
  })

  it('matches trusted application URLs exactly, including the window route', () => {
    expect(isTrustedApplicationUrl('http://127.0.0.1:5173/#/chat', 'http://127.0.0.1:5173/#/chat')).toBe(true)
    expect(isTrustedApplicationUrl('http://127.0.0.1:5173/#/settings', 'http://127.0.0.1:5173/#/chat')).toBe(false)
    expect(isTrustedApplicationUrl('https://example.com/#/chat', 'http://127.0.0.1:5173/#/chat')).toBe(false)
    expect(isTrustedApplicationUrl('file:///C:/NeoDeskPet/dist/index.html#/pet', 'file:///C:/NeoDeskPet/dist/index.html#/pet')).toBe(true)
    expect(isTrustedApplicationUrl('file:///C:/NeoDeskPet/other.html#/pet', 'file:///C:/NeoDeskPet/dist/index.html#/pet')).toBe(false)
  })

  it('declares a permission rule for every registered IPC channel', () => {
    const ipcSources = listTypeScriptSources(path.resolve('electron'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n')
    const registered = Array.from(ipcSources.matchAll(/\b(?:handleIpc|onIpc|handle)\(\s*'([^']+)'/g), (match) => match[1])
    const declared = Object.keys(IPC_CHANNEL_PERMISSIONS)

    expect(new Set(registered).size).toBe(registered.length)
    expect([...registered].sort()).toEqual([...declared].sort())
    const directIpcRegistration = /\bipcMain\.(?:handle|on)\(\s*['"]/
    expect(ipcSources).not.toMatch(directIpcRegistration)
  })

  it('keeps high-risk channels on narrow window allowlists', () => {
    expect(IPC_CHANNEL_PERMISSIONS['app:quit']).toEqual(['pet', 'orb', 'orb-menu'])
    expect(IPC_CHANNEL_PERMISSIONS['settings:setAISettings']).toEqual(['settings'])
    expect(IPC_CHANNEL_PERMISSIONS['chat:getAttachmentUrl']).toEqual(['chat', 'orb'])
    expect(IPC_CHANNEL_PERMISSIONS['memory:deleteMany']).toEqual(['memory'])
    expect(IPC_CHANNEL_PERMISSIONS['live2d:capabilities']).toEqual(['pet'])
  })
})
