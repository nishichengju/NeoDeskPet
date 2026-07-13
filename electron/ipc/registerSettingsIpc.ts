import { randomUUID } from 'node:crypto'
import type {
  AIProfile,
  AIApiMode,
  AISettings,
  AppSettings,
  AsrSettings,
  BubbleSettings,
  ChatProfile,
  ChatUiSettings,
  McpSettings,
  MemoryConsoleSettings,
  MemorySettings,
  NovelAISettings,
  OrchestratorSettings,
  SettingsNavigationTarget,
  SettingsSecretTarget,
  TaskPanelSettings,
  ToolSettings,
  TtsSettings,
  WorldBookSettings,
} from '../types'
import type { WindowManager } from '../windowManager'
import type { IpcHandle } from './registration'

type SettingsWindowManager = Pick<
  WindowManager,
  'setAlwaysOnTop' | 'setClickThrough' | 'resizePetWindowForScale'
>

export type SettingsIpcDependencies = {
  handle: IpcHandle
  getSettings: () => AppSettings
  setSettings: (next: Partial<AppSettings>) => AppSettings
  consumeNavigationTarget: () => SettingsNavigationTarget | null
  broadcastSettingsChanged: () => void
  windowManager: SettingsWindowManager
  kickMemoryIndexMaintenance: () => void
  syncMcpSettings: (settings: McpSettings) => void
  syncManagedAsrApi: (reason: string) => Promise<void>
  syncAsrHotkey: () => void
  createProfileId?: () => string
}

function normalizeAiApiMode(value: unknown): AIApiMode {
  return value === 'claude' ? 'claude' : 'openai-compatible'
}

export function registerSettingsIpc(deps: SettingsIpcDependencies): void {
  const {
    handle,
    getSettings,
    setSettings,
    consumeNavigationTarget,
    broadcastSettingsChanged,
    windowManager,
    kickMemoryIndexMaintenance,
    syncMcpSettings,
    syncManagedAsrApi,
    syncAsrHotkey,
  } = deps
  const createProfileId = deps.createProfileId ?? (() => randomUUID().slice(0, 8))

  handle('settings:get', () => getSettings())
  handle('settings:consumeNavigation', () => consumeNavigationTarget())

  handle('settings:setSecret', (_event, target: SettingsSecretTarget, valueRaw: string) => {
    const value = String(valueRaw ?? '').trim()
    const current = getSettings()
    if (target === 'ai-main') setSettings({ ai: { ...current.ai, apiKey: value } })
    else if (target === 'novelai') setSettings({ novelai: { ...current.novelai, apiKey: value } })
    else if (target === 'tool-ai') {
      setSettings({ orchestrator: { ...current.orchestrator, toolAiApiKey: value } })
    } else if (target === 'memory-auto-extract') {
      setSettings({ memory: { ...current.memory, autoExtractAiApiKey: value } })
    } else if (target === 'memory-vector') {
      setSettings({ memory: { ...current.memory, vectorAiApiKey: value } })
    } else if (target === 'memory-mm-vector') {
      setSettings({ memory: { ...current.memory, mmVectorAiApiKey: value } })
    } else if (target === 'memory-kg') {
      setSettings({ memory: { ...current.memory, kgAiApiKey: value } })
    } else {
      throw new Error('Unknown settings secret target')
    }
    broadcastSettingsChanged()
    return { ok: true as const, hasValue: Boolean(value) }
  })

  handle('settings:setAlwaysOnTop', (_event, value: boolean) => {
    windowManager.setAlwaysOnTop(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setClickThrough', (_event, value: boolean) => {
    windowManager.setClickThrough(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setActivePersonaId', (_event, personaId: string) => {
    setSettings({ activePersonaId: personaId })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setMemorySettings', (_event, memory: Partial<MemorySettings>) => {
    const secretKeys: Array<keyof MemorySettings> = [
      'autoExtractAiApiKey',
      'vectorAiApiKey',
      'mmVectorAiApiKey',
      'kgAiApiKey',
    ]
    if (secretKeys.some((key) => Object.prototype.hasOwnProperty.call(memory, key))) {
      throw new Error('Memory API keys must be updated through settings:setSecret')
    }
    const current = getSettings()
    setSettings({ memory: { ...current.memory, ...memory } })
    broadcastSettingsChanged()
    kickMemoryIndexMaintenance()
    return getSettings()
  })

  handle('settings:setMemoryConsoleSettings', (_event, patch: Partial<MemoryConsoleSettings>) => {
    const current = getSettings()
    setSettings({ memoryConsole: { ...current.memoryConsole, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setPetScale', (_event, value: number) => {
    setSettings({ petScale: value })
    windowManager.resizePetWindowForScale(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setPetOpacity', (_event, value: number) => {
    setSettings({ petOpacity: value })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setLive2dModel', (_event, modelId: string, modelFile: string) => {
    setSettings({ live2dModelId: modelId, live2dModelFile: modelFile })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setLive2dMouseTrackingEnabled', (_event, enabled: boolean) => {
    setSettings({ live2dMouseTrackingEnabled: enabled !== false })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setLive2dIdleSwayEnabled', (_event, enabled: boolean) => {
    setSettings({ live2dIdleSwayEnabled: enabled !== false })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setAISettings', (_event, aiSettings: Partial<AISettings>) => {
    if (Object.prototype.hasOwnProperty.call(aiSettings, 'apiKey')) {
      throw new Error('AI API Key must be updated through settings:setSecret')
    }
    const current = getSettings()
    setSettings({ ai: { ...current.ai, ...aiSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setNovelAISettings', (_event, patch: Partial<NovelAISettings>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      throw new Error('NovelAI API Key must be updated through settings:setSecret')
    }
    const current = getSettings()
    setSettings({ novelai: { ...current.novelai, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle(
    'settings:saveAIProfile',
    (
      _event,
      payload: { id?: string; name: string; apiMode?: AIApiMode; apiKey?: string; baseUrl: string; model: string } | null | undefined,
    ) => {
      const current = getSettings()
      const now = Date.now()
      const idRaw = String(payload?.id ?? '').trim()
      const id = idRaw || `api_${createProfileId()}`
      const name = String(payload?.name ?? '').trim() || id
      const list = Array.isArray(current.aiProfiles) ? current.aiProfiles : []
      const nextProfile: AIProfile = {
        id,
        name,
        apiMode: normalizeAiApiMode(payload?.apiMode),
        apiKey: current.ai.apiKey,
        baseUrl: String(payload?.baseUrl ?? '').trim(),
        model: String(payload?.model ?? '').trim(),
        createdAt: now,
        updatedAt: now,
      }

      const index = list.findIndex((profile) => profile.id === id)
      if (index >= 0) nextProfile.createdAt = list[index]?.createdAt ?? now
      const nextProfiles = index >= 0
        ? [...list.slice(0, index), nextProfile, ...list.slice(index + 1)]
        : [nextProfile, ...list].slice(0, 20)

      setSettings({
        ai: {
          ...current.ai,
          apiMode: nextProfile.apiMode,
          apiKey: nextProfile.apiKey,
          baseUrl: nextProfile.baseUrl,
          model: nextProfile.model,
        },
        aiProfiles: nextProfiles,
        activeAiProfileId: id,
      })
      broadcastSettingsChanged()
      return getSettings()
    },
  )

  handle('settings:deleteAIProfile', (_event, idRaw: string) => {
    const current = getSettings()
    const id = String(idRaw ?? '').trim()
    if (!id) return current
    const list = Array.isArray(current.aiProfiles) ? current.aiProfiles : []
    const nextProfiles = list.filter((profile) => profile.id !== id)
    const deletingActive = current.activeAiProfileId === id
    const nextActive = deletingActive ? nextProfiles[0]?.id ?? '' : current.activeAiProfileId ?? ''
    const nextActiveProfile = nextProfiles.find((profile) => profile.id === nextActive)

    setSettings({
      aiProfiles: nextProfiles,
      activeAiProfileId: nextActive,
      ...(deletingActive && nextActiveProfile
        ? {
            ai: {
              ...current.ai,
              apiMode: nextActiveProfile.apiMode,
              apiKey: nextActiveProfile.apiKey,
              baseUrl: nextActiveProfile.baseUrl,
              model: nextActiveProfile.model,
            },
          }
        : {}),
    })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:applyAIProfile', (_event, idRaw: string) => {
    const current = getSettings()
    const id = String(idRaw ?? '').trim()
    if (!id) return current
    const profile = (Array.isArray(current.aiProfiles) ? current.aiProfiles : []).find((item) => item.id === id)
    if (!profile) return current
    setSettings({
      ai: { ...current.ai, apiMode: profile.apiMode, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model },
      activeAiProfileId: id,
    })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setBubbleSettings', (_event, bubbleSettings: Partial<BubbleSettings>) => {
    const current = getSettings()
    setSettings({ bubble: { ...current.bubble, ...bubbleSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setTaskPanelSettings', (_event, patch: Partial<TaskPanelSettings>) => {
    const current = getSettings()
    setSettings({ taskPanel: { ...current.taskPanel, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setOrchestratorSettings', (_event, patch: Partial<OrchestratorSettings>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'toolAiApiKey')) {
      throw new Error('Tool API Key must be updated through settings:setSecret')
    }
    const current = getSettings()
    setSettings({ orchestrator: { ...current.orchestrator, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setToolSettings', (_event, patch: Partial<ToolSettings>) => {
    const current = getSettings()
    const currentTools = current.tools
    const next: ToolSettings = {
      ...currentTools,
      ...patch,
      groups: typeof patch.groups === 'object' && patch.groups ? patch.groups as Record<string, boolean> : currentTools.groups,
      tools: typeof patch.tools === 'object' && patch.tools ? patch.tools as Record<string, boolean> : currentTools.tools,
    }
    setSettings({ tools: next })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setMcpSettings', (_event, patch: Partial<McpSettings>) => {
    const current = getSettings()
    const currentMcp = current.mcp
    const next: McpSettings = {
      ...currentMcp,
      ...patch,
      servers: Array.isArray(patch.servers) ? patch.servers : currentMcp.servers,
    }
    setSettings({ mcp: next })
    broadcastSettingsChanged()
    syncMcpSettings(getSettings().mcp)
    return getSettings()
  })

  handle('settings:setChatProfile', (_event, chatProfile: Partial<ChatProfile>) => {
    const current = getSettings()
    setSettings({ chatProfile: { ...current.chatProfile, ...chatProfile } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setChatUiSettings', (_event, chatUi: Partial<ChatUiSettings>) => {
    const current = getSettings()
    setSettings({ chatUi: { ...current.chatUi, ...chatUi } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setWorldBookSettings', (_event, worldBook: Partial<WorldBookSettings>) => {
    const current = getSettings()
    setSettings({ worldBook: { ...current.worldBook, ...worldBook } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setTtsSettings', (_event, tts: Partial<TtsSettings>) => {
    const current = getSettings()
    setSettings({ tts: { ...current.tts, ...tts } })
    broadcastSettingsChanged()
    return getSettings()
  })

  handle('settings:setAsrSettings', async (_event, asr: Partial<AsrSettings>) => {
    const current = getSettings()
    setSettings({ asr: { ...current.asr, ...asr } })
    await syncManagedAsrApi('ipc:settings:setAsrSettings')
    broadcastSettingsChanged()
    syncAsrHotkey()
    return getSettings()
  })
}
