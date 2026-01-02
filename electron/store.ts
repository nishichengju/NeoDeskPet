import Store from 'electron-store'
import type {
  AISettings,
  AppSettings,
  AsrSettings,
  BubbleSettings,
  OrchestratorSettings,
  TaskPanelSettings,
  ChatProfile,
  ChatUiSettings,
  MemoryConsoleSettings,
  TtsSettings,
} from './types'

const defaultAISettings: AISettings = {
  // OpenAI compatible API settings
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  // Common settings
  temperature: 0.7,
  maxTokens: 64000,
  maxContextTokens: 128000,
  systemPrompt: '你是一个可爱的桌面宠物助手，请用友好、活泼的语气回复用户。',
  enableVision: false,
  enableChatStreaming: false,
}

const defaultBubbleSettings: BubbleSettings = {
  style: 'cute',
  positionX: 75, // 75% from left (right side)
  positionY: 10, // 10% from top
  tailDirection: 'down', // tail points down toward pet
  showOnClick: true,
  showOnChat: true,
  autoHideDelay: 5000, // 5 seconds
  clickPhrases: [
    '主人好呀~',
    '有什么事吗？',
    '嗯？怎么了~',
    '今天也要加油哦！',
    '想我了吗？',
    '主人在干嘛呢？',
    '需要帮忙吗？',
    '摸摸~',
    '嘿嘿~',
    '主人最棒了！',
  ],
}

const defaultTaskPanelSettings: TaskPanelSettings = {
  positionX: 50, // 居中
  positionY: 78, // 靠近底部
}

const defaultOrchestratorSettings: OrchestratorSettings = {
  // 默认关闭：避免每条聊天都多一次 LLM 调用；需要时再打开
  plannerEnabled: false,
  plannerMode: 'auto',
}

const defaultChatProfile: ChatProfile = {
  userName: '用户',
  userAvatar: '',
  assistantName: '桌宠',
  assistantAvatar: '',
}

const defaultChatUi: ChatUiSettings = {
  background: 'rgba(20, 20, 24, 0.45)',
  userBubbleBackground: 'rgba(80, 140, 255, 0.22)',
  assistantBubbleBackground: 'rgba(0, 0, 0, 0.25)',
  bubbleRadius: 14,
  backgroundImage: '',
  backgroundImageOpacity: 0.6,
}

const defaultMemorySettings = {
  enabled: true,
  includeSharedOnRetrieve: true,
  autoExtractEnabled: false,
  autoExtractEveryEffectiveMessages: 20,
  autoExtractMaxEffectiveMessages: 60,
  autoExtractCooldownMs: 120000,
  autoExtractUseCustomAi: false,
  autoExtractAiApiKey: '',
  autoExtractAiBaseUrl: '',
  autoExtractAiModel: '',
  autoExtractAiTemperature: 0.2,
  autoExtractAiMaxTokens: 1600,
  tagEnabled: true,
  tagMaxExpand: 6,
  vectorEnabled: false,
  vectorEmbeddingModel: 'text-embedding-3-small',
  vectorMinScore: 0.35,
  vectorTopK: 20,
  vectorScanLimit: 2000,
  vectorUseCustomAi: false,
  vectorAiApiKey: '',
  vectorAiBaseUrl: '',
  kgEnabled: false,
  kgIncludeChatMessages: false,
  kgUseCustomAi: true,
  kgAiApiKey: '',
  kgAiBaseUrl: '',
  kgAiModel: 'gpt-4o-mini',
  kgAiTemperature: 0.2,
  kgAiMaxTokens: 1200,
}

const defaultMemoryConsoleSettings: MemoryConsoleSettings = {
  personaId: 'default',
  scope: 'persona',
  role: 'all',
  query: '',
  status: 'active',
  pinned: 'all',
  source: 'all',
  memoryType: 'all',
  orderBy: 'createdAt',
  orderDir: 'desc',
  limit: 50,
  autoRefresh: false,
  extractSessionId: null,
  extractMaxMessages: 30,
  extractWriteToSelectedPersona: false,
  extractSaveScope: 'model',
}

const defaultTtsSettings: TtsSettings = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:9880',
  gptWeightsPath: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
  sovitsWeightsPath: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth',
  speedFactor: 1.0,
  refAudioPath: '',
  promptText: '',
  streaming: true,
  segmented: false,
  pauseMs: 280,
}

const defaultAsrSettings: AsrSettings = {
  enabled: false,
  wsUrl: 'ws://127.0.0.1:8766/ws',
  micDeviceId: '',
  language: 'auto',
  useItn: true,
  autoSend: false,
  // 默认 200ms：识别更稳；想降低 CPU 再调大
  vadChunkMs: 200,
  maxEndSilenceMs: 800,
  minSpeechMs: 600,
  maxSpeechMs: 15000,
  prerollMs: 120,
  postrollMs: 80,
  enableAgc: true,
  agcTargetRms: 0.05,
  agcMaxGain: 20,
  debug: false,
}

const defaultSettings: AppSettings = {
  alwaysOnTop: true,
  clickThrough: false,
  activePersonaId: 'default',
  memory: defaultMemorySettings,
  memoryConsole: defaultMemoryConsoleSettings,
  petWindowBounds: { width: 350, height: 450 },
  chatWindowBounds: { width: 420, height: 560 },
  settingsWindowBounds: { width: 420, height: 520 },
  memoryWindowBounds: { width: 560, height: 720 },
  // Live2D settings
  petScale: 1.0,
  petOpacity: 1.0,
  live2dModelId: 'haru',
  live2dModelFile: '/live2d/Haru/Haru.model3.json',
  // Speech bubble settings
  bubble: defaultBubbleSettings,
  // Pet task panel settings (M2)
  taskPanel: defaultTaskPanelSettings,
  // Orchestrator settings (M4)
  orchestrator: defaultOrchestratorSettings,
  // AI settings
  ai: defaultAISettings,
  // Chat profile
  chatProfile: defaultChatProfile,
  // Chat UI
  chatUi: defaultChatUi,
  // TTS
  tts: defaultTtsSettings,
  // ASR
  asr: defaultAsrSettings,
}

function normalizeSettings(value: Partial<AppSettings> | undefined): AppSettings {
  const merged: AppSettings = { ...defaultSettings, ...(value ?? {}) } as AppSettings

  merged.bubble = { ...defaultBubbleSettings, ...((value?.bubble ?? {}) as Partial<BubbleSettings>) }
  merged.taskPanel = { ...defaultTaskPanelSettings, ...((value?.taskPanel ?? {}) as Partial<TaskPanelSettings>) }
  merged.orchestrator = { ...defaultOrchestratorSettings, ...((value?.orchestrator ?? {}) as Partial<OrchestratorSettings>) }
  merged.ai = { ...defaultAISettings, ...((value?.ai ?? {}) as Partial<AISettings>) }
  merged.chatProfile = { ...defaultChatProfile, ...((value?.chatProfile ?? {}) as Partial<ChatProfile>) }
  merged.chatUi = { ...defaultChatUi, ...((value?.chatUi ?? {}) as Partial<ChatUiSettings>) }
  merged.memory = { ...defaultMemorySettings, ...((value?.memory ?? {}) as Partial<typeof defaultMemorySettings>) }
  merged.memoryConsole = {
    ...defaultMemoryConsoleSettings,
    ...((value?.memoryConsole ?? {}) as Partial<MemoryConsoleSettings>),
  }
  merged.tts = { ...defaultTtsSettings, ...((value?.tts ?? {}) as Partial<TtsSettings>) }
  merged.asr = { ...defaultAsrSettings, ...((value?.asr ?? {}) as Partial<AsrSettings>) }
  // 历史默认值 320ms 在部分场景会明显影响识别效果，这里自动回退到推荐 200ms
  if ((value?.asr as Partial<AsrSettings> | undefined)?.vadChunkMs === 320) {
    merged.asr.vadChunkMs = 200
  }

  return merged
}

const store = new Store<AppSettings>({
  name: 'neodeskpet-settings',
  defaults: defaultSettings,
  // Migration: handle old AI settings format
  migrations: {
    '0.2.0': (store) => {
      // Migrate from old multi-provider format to new unified format
      const oldAi = store.get('ai') as Record<string, unknown> | undefined
      if (oldAi && 'provider' in oldAi) {
        // Old format detected, migrate to new format
        const newAi: AISettings = {
          apiKey: (oldAi.openaiApiKey as string) || '',
          baseUrl: (oldAi.openaiBaseUrl as string) || 'https://api.openai.com/v1',
          model: (oldAi.openaiModel as string) || 'gpt-4o-mini',
          temperature: (oldAi.temperature as number) || 0.7,
          maxTokens: 64000,
          maxContextTokens: 128000,
          systemPrompt: (oldAi.systemPrompt as string) || defaultAISettings.systemPrompt,
          enableVision: false,
          enableChatStreaming: false,
        }
        store.set('ai', newAi)
      }
      // Ensure petScale is valid (range 0.5-5 for high-res models)
      const petScale = store.get('petScale') as number | undefined
      if (typeof petScale !== 'number' || petScale < 0.5 || petScale > 5) {
        store.set('petScale', 1.0)
      }
    },
    '0.3.0': (store) => {
      // Add bubble settings if missing
      const bubble = store.get('bubble') as BubbleSettings | undefined
      if (!bubble) {
        store.set('bubble', defaultBubbleSettings)
      }
    },
    '0.4.0': (store) => {
      // Add new bubble fields if missing
      const bubble = store.get('bubble') as Partial<BubbleSettings> | undefined
      if (bubble) {
        if (!bubble.clickPhrases || bubble.clickPhrases.length === 0) {
          store.set('bubble.clickPhrases', defaultBubbleSettings.clickPhrases)
        }
      }
    },
    '0.5.0': (store) => {
      // Migrate from position to positionX/positionY and tailDirection
      const bubble = store.get('bubble') as Record<string, unknown> | undefined
      if (bubble) {
        // Check if old position format exists
        if ('position' in bubble && typeof bubble.position === 'string') {
          const pos = bubble.position as string
          // Convert old position to new X/Y format
          let positionX = 75
          let positionY = 10
          let tailDirection = 'down'

          if (pos === 'top-right') {
            positionX = 75
            positionY = 10
            tailDirection = 'down'
          } else if (pos === 'top-left') {
            positionX = 5
            positionY = 10
            tailDirection = 'down'
          } else if (pos === 'bottom-right') {
            positionX = 75
            positionY = 70
            tailDirection = 'up'
          } else if (pos === 'bottom-left') {
            positionX = 5
            positionY = 70
            tailDirection = 'up'
          }

          store.set('bubble.positionX', positionX)
          store.set('bubble.positionY', positionY)
          store.set('bubble.tailDirection', tailDirection)
          // Remove old position field
          const newBubble = { ...bubble }
          delete newBubble.position
          store.set('bubble', newBubble)
        }

        // Ensure new fields exist
        if (typeof bubble.positionX !== 'number') {
          store.set('bubble.positionX', 75)
        }
        if (typeof bubble.positionY !== 'number') {
          store.set('bubble.positionY', 10)
        }
        if (!bubble.tailDirection) {
          store.set('bubble.tailDirection', 'down')
        }
      }
    },
    '0.6.0': (store) => {
      // Add live2dModelFile if missing
      const modelFile = store.get('live2dModelFile') as string | undefined
      if (!modelFile) {
        const modelId = store.get('live2dModelId') as string || 'haru'
        // Generate default path based on ID
        const capitalizedId = modelId.charAt(0).toUpperCase() + modelId.slice(1)
        store.set('live2dModelFile', `/live2d/${capitalizedId}/${capitalizedId}.model3.json`)
      }
    },
    '0.7.0': (store) => {
      const chatProfile = store.get('chatProfile') as Partial<ChatProfile> | undefined
      if (!chatProfile) {
        store.set('chatProfile', defaultChatProfile)
        return
      }
      if (!chatProfile.userName) store.set('chatProfile.userName', defaultChatProfile.userName)
      if (typeof chatProfile.userAvatar !== 'string') store.set('chatProfile.userAvatar', defaultChatProfile.userAvatar)
      if (!chatProfile.assistantName) store.set('chatProfile.assistantName', defaultChatProfile.assistantName)
      if (typeof chatProfile.assistantAvatar !== 'string') {
        store.set('chatProfile.assistantAvatar', defaultChatProfile.assistantAvatar)
      }
    },
    '0.8.0': (store) => {
      const chatUi = store.get('chatUi') as Partial<ChatUiSettings> | undefined
      if (!chatUi) {
        store.set('chatUi', defaultChatUi)
        return
      }
      if (typeof chatUi.background !== 'string') store.set('chatUi.background', defaultChatUi.background)
      if (typeof chatUi.userBubbleBackground !== 'string') {
        store.set('chatUi.userBubbleBackground', defaultChatUi.userBubbleBackground)
      }
      if (typeof chatUi.assistantBubbleBackground !== 'string') {
        store.set('chatUi.assistantBubbleBackground', defaultChatUi.assistantBubbleBackground)
      }
      if (typeof chatUi.bubbleRadius !== 'number') store.set('chatUi.bubbleRadius', defaultChatUi.bubbleRadius)
      if (typeof chatUi.backgroundImage !== 'string') store.set('chatUi.backgroundImage', defaultChatUi.backgroundImage)
      if (typeof chatUi.backgroundImageOpacity !== 'number') {
        store.set('chatUi.backgroundImageOpacity', defaultChatUi.backgroundImageOpacity)
      }
    },
    '0.9.0': (store) => {
      const ai = store.get('ai') as Partial<AISettings> | undefined
      if (!ai) {
        store.set('ai', defaultAISettings)
        return
      }
      if (typeof ai.enableVision !== 'boolean') store.set('ai.enableVision', defaultAISettings.enableVision)
      if (typeof ai.enableChatStreaming !== 'boolean') {
        store.set('ai.enableChatStreaming', defaultAISettings.enableChatStreaming)
      }
    },
    '0.10.0': (store) => {
      const tts = store.get('tts') as Partial<TtsSettings> | undefined
      if (!tts) {
        store.set('tts', defaultTtsSettings)
        return
      }
      store.set('tts', { ...defaultTtsSettings, ...tts })
    },
    '0.11.0': (store) => {
      const ai = store.get('ai') as Partial<AISettings> | undefined
      if (!ai) store.set('ai', defaultAISettings)
      else if (typeof ai.enableChatStreaming !== 'boolean') {
        store.set('ai.enableChatStreaming', defaultAISettings.enableChatStreaming)
      }

      const tts = store.get('tts') as Partial<TtsSettings> | undefined
      if (!tts) store.set('tts', defaultTtsSettings)
      else {
        if (typeof tts.segmented !== 'boolean') store.set('tts.segmented', defaultTtsSettings.segmented)
        if (typeof tts.pauseMs !== 'number') store.set('tts.pauseMs', defaultTtsSettings.pauseMs)
      }
    },
    '0.12.0': (store) => {
      const asr = store.get('asr') as Partial<AsrSettings> | undefined
      if (!asr) {
        store.set('asr', defaultAsrSettings)
        return
      }
      store.set('asr', { ...defaultAsrSettings, ...asr })
    },
    '0.13.0': (store) => {
      const pid = store.get('activePersonaId') as unknown
      if (typeof pid !== 'string' || pid.trim().length === 0) {
        store.set('activePersonaId', 'default')
      }
    },
    '0.14.0': (store) => {
      const mem = store.get('memory') as Partial<typeof defaultMemorySettings> | undefined
      if (!mem) {
        store.set('memory', defaultMemorySettings)
        return
      }
      if (typeof mem.enabled !== 'boolean') store.set('memory.enabled', defaultMemorySettings.enabled)
      if (typeof mem.includeSharedOnRetrieve !== 'boolean') {
        store.set('memory.includeSharedOnRetrieve', defaultMemorySettings.includeSharedOnRetrieve)
      }
    },
    '0.15.0': (store) => {
      const bounds = store.get('memoryWindowBounds') as unknown
      if (!bounds || typeof bounds !== 'object') {
        store.set('memoryWindowBounds', defaultSettings.memoryWindowBounds)
      }
    },
    '0.16.0': (store) => {
      const mem = store.get('memory') as Partial<typeof defaultMemorySettings> | undefined
      if (!mem) {
        store.set('memory', defaultMemorySettings)
        return
      }
      if (typeof mem.autoExtractEnabled !== 'boolean') store.set('memory.autoExtractEnabled', defaultMemorySettings.autoExtractEnabled)
      if (typeof mem.autoExtractEveryEffectiveMessages !== 'number') {
        store.set('memory.autoExtractEveryEffectiveMessages', defaultMemorySettings.autoExtractEveryEffectiveMessages)
      }
      if (typeof mem.autoExtractMaxEffectiveMessages !== 'number') {
        store.set('memory.autoExtractMaxEffectiveMessages', defaultMemorySettings.autoExtractMaxEffectiveMessages)
      }
      if (typeof mem.autoExtractCooldownMs !== 'number') {
        store.set('memory.autoExtractCooldownMs', defaultMemorySettings.autoExtractCooldownMs)
      }
    },
    '0.17.0': (store) => {
      const mem = store.get('memory') as Partial<typeof defaultMemorySettings> | undefined
      if (!mem) {
        store.set('memory', defaultMemorySettings)
        return
      }
      if (typeof mem.autoExtractUseCustomAi !== 'boolean') {
        store.set('memory.autoExtractUseCustomAi', defaultMemorySettings.autoExtractUseCustomAi)
      }
      if (typeof mem.autoExtractAiApiKey !== 'string') store.set('memory.autoExtractAiApiKey', defaultMemorySettings.autoExtractAiApiKey)
      if (typeof mem.autoExtractAiBaseUrl !== 'string') store.set('memory.autoExtractAiBaseUrl', defaultMemorySettings.autoExtractAiBaseUrl)
      if (typeof mem.autoExtractAiModel !== 'string') store.set('memory.autoExtractAiModel', defaultMemorySettings.autoExtractAiModel)
      if (typeof mem.autoExtractAiTemperature !== 'number') {
        store.set('memory.autoExtractAiTemperature', defaultMemorySettings.autoExtractAiTemperature)
      }
      if (typeof mem.autoExtractAiMaxTokens !== 'number') {
        store.set('memory.autoExtractAiMaxTokens', defaultMemorySettings.autoExtractAiMaxTokens)
      }
    },
    '0.18.0': (store) => {
      const mem = store.get('memory') as Partial<typeof defaultMemorySettings> | undefined
      if (!mem) {
        store.set('memory', defaultMemorySettings)
        return
      }
      if (typeof mem.tagEnabled !== 'boolean') store.set('memory.tagEnabled', defaultMemorySettings.tagEnabled)
      if (typeof mem.tagMaxExpand !== 'number') store.set('memory.tagMaxExpand', defaultMemorySettings.tagMaxExpand)
      if (typeof mem.vectorEnabled !== 'boolean') store.set('memory.vectorEnabled', defaultMemorySettings.vectorEnabled)
      if (typeof mem.vectorEmbeddingModel !== 'string') {
        store.set('memory.vectorEmbeddingModel', defaultMemorySettings.vectorEmbeddingModel)
      }
      if (typeof mem.vectorMinScore !== 'number') store.set('memory.vectorMinScore', defaultMemorySettings.vectorMinScore)
      if (typeof mem.vectorTopK !== 'number') store.set('memory.vectorTopK', defaultMemorySettings.vectorTopK)
      if (typeof mem.vectorScanLimit !== 'number') store.set('memory.vectorScanLimit', defaultMemorySettings.vectorScanLimit)
      if (typeof mem.vectorUseCustomAi !== 'boolean') {
        store.set('memory.vectorUseCustomAi', defaultMemorySettings.vectorUseCustomAi)
      }
      if (typeof mem.vectorAiApiKey !== 'string') store.set('memory.vectorAiApiKey', defaultMemorySettings.vectorAiApiKey)
      if (typeof mem.vectorAiBaseUrl !== 'string') store.set('memory.vectorAiBaseUrl', defaultMemorySettings.vectorAiBaseUrl)
    },
    '0.19.0': (store) => {
      const mem = store.get('memory') as Partial<typeof defaultMemorySettings> | undefined
      if (!mem) {
        store.set('memory', defaultMemorySettings)
        return
      }
      if (typeof mem.kgEnabled !== 'boolean') store.set('memory.kgEnabled', defaultMemorySettings.kgEnabled)
      if (typeof mem.kgIncludeChatMessages !== 'boolean') {
        store.set('memory.kgIncludeChatMessages', defaultMemorySettings.kgIncludeChatMessages)
      }
      if (typeof mem.kgUseCustomAi !== 'boolean') store.set('memory.kgUseCustomAi', defaultMemorySettings.kgUseCustomAi)
      if (typeof mem.kgAiApiKey !== 'string') store.set('memory.kgAiApiKey', defaultMemorySettings.kgAiApiKey)
      if (typeof mem.kgAiBaseUrl !== 'string') store.set('memory.kgAiBaseUrl', defaultMemorySettings.kgAiBaseUrl)
      if (typeof mem.kgAiModel !== 'string') store.set('memory.kgAiModel', defaultMemorySettings.kgAiModel)
      if (typeof mem.kgAiTemperature !== 'number') store.set('memory.kgAiTemperature', defaultMemorySettings.kgAiTemperature)
      if (typeof mem.kgAiMaxTokens !== 'number') store.set('memory.kgAiMaxTokens', defaultMemorySettings.kgAiMaxTokens)
    },
  },
})

export function getSettings(): AppSettings {
  return normalizeSettings(store.store)
}

export function setSettings(next: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const merged: AppSettings = normalizeSettings({ ...current, ...next })
  store.store = merged
  return normalizeSettings(store.store)
}
