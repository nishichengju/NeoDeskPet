import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { type IpcHandle } from '../electron/ipc/registration'
import { registerSettingsIpc, type SettingsIpcDependencies } from '../electron/ipc/registerSettingsIpc'
import { IPC_CHANNEL_PERMISSIONS, type IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'
import type { AppSettings } from '../electron/types'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createHarness() {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  let settings = createDefaultSettings()
  const broadcastSettingsChanged = vi.fn()
  const kickMemoryIndexMaintenance = vi.fn()
  const syncMcpSettings = vi.fn()
  const syncManagedAsrApi = vi.fn(async () => {})
  const syncAsrHotkey = vi.fn()

  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => {
    handlers.set(channel, listener)
  }) as IpcHandle
  const setSettings = (next: Partial<AppSettings>) => {
    settings = { ...settings, ...next }
    return settings
  }
  const dependencies: SettingsIpcDependencies = {
    handle,
    getSettings: () => settings,
    setSettings,
    consumeNavigationTarget: () => 'aiConnection',
    broadcastSettingsChanged,
    windowManager: {
      setAlwaysOnTop: (value) => {
        setSettings({ alwaysOnTop: value })
      },
      setClickThrough: (value) => {
        setSettings({ clickThrough: value })
      },
      resizePetWindowForScale: vi.fn(),
    },
    kickMemoryIndexMaintenance,
    syncMcpSettings,
    syncManagedAsrApi,
    syncAsrHotkey,
    createProfileId: () => 'fixed123',
  }
  registerSettingsIpc(dependencies)

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args) as Result
  }

  return {
    handlers,
    invoke,
    getSettings: () => settings,
    broadcastSettingsChanged,
    kickMemoryIndexMaintenance,
    syncMcpSettings,
    syncManagedAsrApi,
    syncAsrHotkey,
  }
}

describe('settings IPC registration', () => {
  it('registers every declared settings channel exactly once', () => {
    const harness = createHarness()
    const expected = Object.keys(IPC_CHANNEL_PERMISSIONS).filter((channel) => channel.startsWith('settings:')).sort()
    const registered = [...harness.handlers.keys()].sort()
    expect(registered).toEqual(expected)
  })

  it('keeps API keys on the dedicated secret channel', () => {
    const harness = createHarness()
    expect(() => harness.invoke('settings:setAISettings', { apiKey: 'leak' })).toThrow(
      'AI API Key must be updated through settings:setSecret',
    )

    expect(harness.invoke('settings:setSecret', 'ai-main', '  secret-value  ')).toEqual({
      ok: true,
      hasValue: true,
    })
    expect(harness.getSettings().ai.apiKey).toBe('secret-value')
    expect(harness.broadcastSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('persists the selected Live2D model file and broadcasts it', () => {
    const harness = createHarness()
    const result = harness.invoke<AppSettings>(
      'settings:setLive2dModel',
      '灵小狗',
      '/live2d/灵小狗/XIAOPmaiddress.model3.json',
    )

    expect(result).toMatchObject({
      live2dModelId: '灵小狗',
      live2dModelFile: '/live2d/灵小狗/XIAOPmaiddress.model3.json',
    })
    expect(harness.getSettings()).toMatchObject(result)
    expect(harness.broadcastSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('preserves memory, MCP, ASR, and AI profile side effects', async () => {
    const harness = createHarness()
    harness.invoke('settings:setSecret', 'ai-main', 'profile-secret')

    harness.invoke('settings:setMemorySettings', { vectorEnabled: true })
    expect(harness.kickMemoryIndexMaintenance).toHaveBeenCalledTimes(1)

    harness.invoke('settings:setMcpSettings', { enabled: true })
    expect(harness.syncMcpSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))

    await harness.invoke<Promise<AppSettings>>('settings:setAsrSettings', { enabled: true })
    expect(harness.syncManagedAsrApi).toHaveBeenCalledWith('ipc:settings:setAsrSettings')
    expect(harness.syncAsrHotkey).toHaveBeenCalledTimes(1)

    harness.invoke('settings:saveAIProfile', {
      name: 'Claude',
      apiMode: 'claude',
      apiKey: 'ignored',
      baseUrl: 'https://example.test/v1',
      model: 'claude-test',
    })
    expect(harness.getSettings().activeAiProfileId).toBe('api_fixed123')
    expect(harness.getSettings().aiProfiles[0]).toMatchObject({
      id: 'api_fixed123',
      apiMode: 'claude',
      apiKey: 'profile-secret',
      model: 'claude-test',
    })
  })
})
