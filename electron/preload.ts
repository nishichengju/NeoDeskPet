import { contextBridge, ipcRenderer } from 'electron'
import type {
  AISettings,
  AppSettings,
  BubbleSettings,
  ChatMessageRecord,
  ChatProfile,
  ChatUiSettings,
  ChatSession,
  ChatSessionSummary,
  ScannedModel,
  AsrSettings,
  TtsSettings,
  TaskCreateArgs,
  TaskListResult,
  TaskRecord,
  TaskPanelSettings,
  OrchestratorSettings,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemoryConsoleSettings,
  MemorySettings,
  MemoryListArgs,
  MemoryListResult,
  MemoryListVersionsArgs,
  MemoryRecord,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryUpsertManualArgs,
  MemoryUpdateArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryVersionRecord,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  Persona,
  PersonaSummary,
} from './types'
import type { TtsOptions } from './ttsOptions'

export type SettingsChangeListener = (settings: AppSettings) => void
export type Live2DExpressionListener = (expressionName: string) => void
export type Live2DMotionListener = (motionGroup: string, index: number) => void
export type BubbleMessageListener = (message: string) => void

export type TtsEnqueuePayload = { utteranceId: string; mode: 'replace' | 'append'; segments: string[] }
export type TtsSegmentStartedPayload = { utteranceId: string; segmentIndex: number; text: string }
export type TtsUtteranceEndedPayload = { utteranceId: string }
export type TtsUtteranceFailedPayload = { utteranceId: string; error: string }

export type TtsEnqueueListener = (payload: TtsEnqueuePayload) => void
export type TtsFinalizeListener = (utteranceId: string) => void
export type TtsSegmentStartedListener = (payload: TtsSegmentStartedPayload) => void
export type TtsUtteranceEndedListener = (payload: TtsUtteranceEndedPayload) => void
export type TtsUtteranceFailedListener = (payload: TtsUtteranceFailedPayload) => void
export type TtsStopAllListener = () => void
export type TasksChangedListener = (payload: TaskListResult) => void

contextBridge.exposeInMainWorld('neoDeskPet', {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setAlwaysOnTop: (value: boolean): Promise<AppSettings> => ipcRenderer.invoke('settings:setAlwaysOnTop', value),
  setClickThrough: (value: boolean): Promise<AppSettings> => ipcRenderer.invoke('settings:setClickThrough', value),
  setActivePersonaId: (personaId: string): Promise<AppSettings> => ipcRenderer.invoke('settings:setActivePersonaId', personaId),
  setMemorySettings: (memory: Partial<MemorySettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setMemorySettings', memory),
  setMemoryConsoleSettings: (patch: Partial<MemoryConsoleSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setMemoryConsoleSettings', patch),
  setPetScale: (value: number): Promise<AppSettings> => ipcRenderer.invoke('settings:setPetScale', value),
  setPetOpacity: (value: number): Promise<AppSettings> => ipcRenderer.invoke('settings:setPetOpacity', value),
  setLive2dModel: (modelId: string, modelFile: string): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setLive2dModel', modelId, modelFile),

  // AI settings
  setAISettings: (aiSettings: Partial<AISettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setAISettings', aiSettings),

  // Bubble settings
  setBubbleSettings: (bubbleSettings: Partial<BubbleSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setBubbleSettings', bubbleSettings),

  // Task panel settings (M2)
  setTaskPanelSettings: (patch: Partial<TaskPanelSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setTaskPanelSettings', patch),

  // Orchestrator settings (M4)
  setOrchestratorSettings: (patch: Partial<OrchestratorSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setOrchestratorSettings', patch),

  // Chat profile
  setChatProfile: (chatProfile: Partial<ChatProfile>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setChatProfile', chatProfile),

  // Chat UI appearance
  setChatUiSettings: (chatUi: Partial<ChatUiSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setChatUiSettings', chatUi),

  // TTS settings
  setTtsSettings: (tts: Partial<TtsSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:setTtsSettings', tts),
  listTtsOptions: (): Promise<TtsOptions> => ipcRenderer.invoke('tts:listOptions'),

  // ASR settings
  setAsrSettings: (asr: Partial<AsrSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:setAsrSettings', asr),

  // Model scanner - scan live2d directory for available models
  scanModels: (): Promise<ScannedModel[]> => ipcRenderer.invoke('models:scan'),

  // Chat storage
  listChatSessions: (): Promise<{ sessions: ChatSessionSummary[]; currentSessionId: string }> => ipcRenderer.invoke('chat:list'),
  getChatSession: (sessionId?: string): Promise<ChatSession> => ipcRenderer.invoke('chat:get', sessionId),
  createChatSession: (name?: string, personaId?: string): Promise<ChatSession> => ipcRenderer.invoke('chat:create', name, personaId),
  setCurrentChatSession: (sessionId: string): Promise<{ currentSessionId: string }> =>
    ipcRenderer.invoke('chat:setCurrent', sessionId),
  renameChatSession: (sessionId: string, name: string): Promise<ChatSessionSummary> =>
    ipcRenderer.invoke('chat:rename', sessionId, name),
  deleteChatSession: (sessionId: string): Promise<{ sessions: ChatSessionSummary[]; currentSessionId: string }> =>
    ipcRenderer.invoke('chat:delete', sessionId),
  clearChatSession: (sessionId: string): Promise<ChatSession> => ipcRenderer.invoke('chat:clear', sessionId),
  setChatMessages: (sessionId: string, messages: ChatMessageRecord[]): Promise<ChatSession> =>
    ipcRenderer.invoke('chat:setMessages', sessionId, messages),
  addChatMessage: (sessionId: string, message: ChatMessageRecord): Promise<ChatSession> =>
    ipcRenderer.invoke('chat:addMessage', sessionId, message),
  updateChatMessage: (sessionId: string, messageId: string, content: string): Promise<ChatSession> =>
    ipcRenderer.invoke('chat:updateMessage', sessionId, messageId, content),
  deleteChatMessage: (sessionId: string, messageId: string): Promise<ChatSession> =>
    ipcRenderer.invoke('chat:deleteMessage', sessionId, messageId),
  setChatAutoExtractCursor: (sessionId: string, cursor: number): Promise<ChatSession> =>
    ipcRenderer.invoke('chat:setAutoExtractCursor', sessionId, cursor),
  setChatAutoExtractMeta: (
    sessionId: string,
    patch: Partial<
      Pick<
        ChatSession,
        'autoExtractCursor' | 'autoExtractLastRunAt' | 'autoExtractLastWriteCount' | 'autoExtractLastError'
      >
    >,
  ): Promise<ChatSession> => ipcRenderer.invoke('chat:setAutoExtractMeta', sessionId, patch),

  // Tasks / Orchestrator (M1)
  listTasks: (): Promise<TaskListResult> => ipcRenderer.invoke('task:list'),
  getTask: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke('task:get', id),
  createTask: (args: TaskCreateArgs): Promise<TaskRecord> => ipcRenderer.invoke('task:create', args),
  pauseTask: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke('task:resume', id),
  cancelTask: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke('task:cancel', id),
  onTasksChanged: (listener: TasksChangedListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskListResult) => listener(payload)
    ipcRenderer.on('task:changed', handler)
    return () => ipcRenderer.off('task:changed', handler)
  },

  // Long-term memory / personas
  listPersonas: (): Promise<PersonaSummary[]> => ipcRenderer.invoke('memory:listPersonas'),
  getPersona: (personaId: string): Promise<Persona | null> => ipcRenderer.invoke('memory:getPersona', personaId),
  createPersona: (name: string): Promise<Persona> => ipcRenderer.invoke('memory:createPersona', name),
  updatePersona: (
    personaId: string,
    patch: {
      name?: string
      prompt?: string
      captureEnabled?: boolean
      captureUser?: boolean
      captureAssistant?: boolean
      retrieveEnabled?: boolean
    },
  ): Promise<Persona> =>
    ipcRenderer.invoke('memory:updatePersona', personaId, patch),
  deletePersona: (personaId: string): Promise<{ ok: true }> => ipcRenderer.invoke('memory:deletePersona', personaId),
  retrieveMemory: (args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => ipcRenderer.invoke('memory:retrieve', args),
  listMemory: (args: MemoryListArgs): Promise<MemoryListResult> => ipcRenderer.invoke('memory:list', args),
  upsertManualMemory: (args: MemoryUpsertManualArgs): Promise<MemoryRecord> => ipcRenderer.invoke('memory:upsertManual', args),
  updateMemory: (args: MemoryUpdateArgs): Promise<MemoryRecord> => ipcRenderer.invoke('memory:update', args),
  updateMemoryMeta: (args: MemoryUpdateMetaArgs): Promise<MemoryUpdateMetaResult> => ipcRenderer.invoke('memory:updateMeta', args),
  updateManyMemoryMeta: (args: MemoryUpdateManyMetaArgs): Promise<MemoryUpdateMetaResult> =>
    ipcRenderer.invoke('memory:updateManyMeta', args),
  updateMemoryByFilterMeta: (args: MemoryUpdateByFilterMetaArgs): Promise<MemoryUpdateMetaResult> =>
    ipcRenderer.invoke('memory:updateByFilterMeta', args),
  listMemoryVersions: (args: MemoryListVersionsArgs): Promise<MemoryVersionRecord[]> =>
    ipcRenderer.invoke('memory:listVersions', args),
  rollbackMemoryVersion: (args: MemoryRollbackVersionArgs): Promise<MemoryRecord> =>
    ipcRenderer.invoke('memory:rollbackVersion', args),
  listMemoryConflicts: (args: MemoryListConflictsArgs): Promise<MemoryListConflictsResult> =>
    ipcRenderer.invoke('memory:listConflicts', args),
  resolveMemoryConflict: (args: MemoryResolveConflictArgs): Promise<MemoryResolveConflictResult> =>
    ipcRenderer.invoke('memory:resolveConflict', args),
  deleteMemory: (args: MemoryDeleteArgs): Promise<{ ok: true }> => ipcRenderer.invoke('memory:delete', args),
  deleteManyMemory: (args: MemoryDeleteManyArgs): Promise<{ deleted: number }> => ipcRenderer.invoke('memory:deleteMany', args),
  deleteMemoryByFilter: (args: MemoryDeleteByFilterArgs): Promise<{ deleted: number }> =>
    ipcRenderer.invoke('memory:deleteByFilter', args),

  // Live2D expression/motion triggers (from settings window)
  triggerExpression: (expressionName: string): void => ipcRenderer.send('live2d:triggerExpression', expressionName),
  triggerMotion: (motionGroup: string, index: number = 0): void =>
    ipcRenderer.send('live2d:triggerMotion', motionGroup, index),

  // Live2D expression/motion listeners (for pet window)
  onLive2dExpression: (listener: Live2DExpressionListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, expressionName: string) => listener(expressionName)
    ipcRenderer.on('live2d:expression', handler)
    return () => ipcRenderer.off('live2d:expression', handler)
  },
  onLive2dMotion: (listener: Live2DMotionListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, motionGroup: string, index: number) =>
      listener(motionGroup, index)
    ipcRenderer.on('live2d:motion', handler)
    return () => ipcRenderer.off('live2d:motion', handler)
  },

  openChat: (): Promise<void> => ipcRenderer.invoke('window:openChat'),
  openSettings: (): Promise<void> => ipcRenderer.invoke('window:openSettings'),
  openMemory: (): Promise<void> => ipcRenderer.invoke('window:openMemory'),
  hideAll: (): Promise<void> => ipcRenderer.invoke('window:hideAll'),
  closeCurrent: (): Promise<void> => ipcRenderer.invoke('window:closeCurrent'),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  // Window drag support
  startDrag: (): void => ipcRenderer.send('window:startDrag'),
  stopDrag: (): void => ipcRenderer.send('window:stopDrag'),

  // Context menu
  showContextMenu: (): void => ipcRenderer.send('pet:showContextMenu'),
  setPetOverlayHover: (hovering: boolean): void => ipcRenderer.send('pet:setOverlayHover', hovering),

  // Mouse forward for transparent click-through
  setIgnoreMouseEvents: (ignore: boolean, forward: boolean): void =>
    ipcRenderer.send('window:setIgnoreMouseEvents', ignore, forward),

  onSettingsChanged: (listener: SettingsChangeListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings) => listener(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.off('settings:changed', handler)
  },

  // Bubble message listener (for pet window to receive AI responses)
  onBubbleMessage: (listener: BubbleMessageListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message)
    ipcRenderer.on('bubble:message', handler)
    return () => ipcRenderer.off('bubble:message', handler)
  },

  // Send bubble message (from chat window to pet window)
  sendBubbleMessage: (message: string): void => ipcRenderer.send('bubble:sendMessage', message),

  // TTS segmented sync (chat -> pet)
  enqueueTtsUtterance: (payload: TtsEnqueuePayload): void => ipcRenderer.send('tts:enqueue', payload),
  finalizeTtsUtterance: (utteranceId: string): void => ipcRenderer.send('tts:finalize', utteranceId),
  stopTtsAll: (): void => ipcRenderer.send('tts:stopAll'),

  // TTS segmented sync (pet -> chat report to main)
  reportTtsSegmentStarted: (payload: TtsSegmentStartedPayload): void => ipcRenderer.send('tts:segmentStarted', payload),
  reportTtsUtteranceEnded: (payload: TtsUtteranceEndedPayload): void => ipcRenderer.send('tts:utteranceEnded', payload),
  reportTtsUtteranceFailed: (payload: TtsUtteranceFailedPayload): void => ipcRenderer.send('tts:utteranceFailed', payload),

  // TTS segmented sync listeners
  onTtsEnqueue: (listener: TtsEnqueueListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TtsEnqueuePayload) => listener(payload)
    ipcRenderer.on('tts:enqueue', handler)
    return () => ipcRenderer.off('tts:enqueue', handler)
  },
  onTtsFinalize: (listener: TtsFinalizeListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, utteranceId: string) => listener(utteranceId)
    ipcRenderer.on('tts:finalize', handler)
    return () => ipcRenderer.off('tts:finalize', handler)
  },
  onTtsSegmentStarted: (listener: TtsSegmentStartedListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TtsSegmentStartedPayload) => listener(payload)
    ipcRenderer.on('tts:segmentStarted', handler)
    return () => ipcRenderer.off('tts:segmentStarted', handler)
  },
  onTtsUtteranceEnded: (listener: TtsUtteranceEndedListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TtsUtteranceEndedPayload) => listener(payload)
    ipcRenderer.on('tts:utteranceEnded', handler)
    return () => ipcRenderer.off('tts:utteranceEnded', handler)
  },
  onTtsUtteranceFailed: (listener: TtsUtteranceFailedListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TtsUtteranceFailedPayload) => listener(payload)
    ipcRenderer.on('tts:utteranceFailed', handler)
    return () => ipcRenderer.off('tts:utteranceFailed', handler)
  },
  onTtsStopAll: (listener: TtsStopAllListener): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on('tts:stopAll', handler)
    return () => ipcRenderer.off('tts:stopAll', handler)
  },
})

// 单独暴露“记忆 API”，方便未来做模块化/插件化（只包含记忆相关能力）
contextBridge.exposeInMainWorld('neoDeskPetMemory', {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setMemorySettings: (memory: Partial<MemorySettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:setMemorySettings', memory),
  onSettingsChanged: (listener: SettingsChangeListener): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings) => listener(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.off('settings:changed', handler)
  },

  listPersonas: (): Promise<PersonaSummary[]> => ipcRenderer.invoke('memory:listPersonas'),
  getPersona: (personaId: string): Promise<Persona | null> => ipcRenderer.invoke('memory:getPersona', personaId),
  createPersona: (name: string): Promise<Persona> => ipcRenderer.invoke('memory:createPersona', name),
  updatePersona: (
    personaId: string,
    patch: {
      name?: string
      prompt?: string
      captureEnabled?: boolean
      captureUser?: boolean
      captureAssistant?: boolean
      retrieveEnabled?: boolean
    },
  ): Promise<Persona> =>
    ipcRenderer.invoke('memory:updatePersona', personaId, patch),
  deletePersona: (personaId: string): Promise<{ ok: true }> => ipcRenderer.invoke('memory:deletePersona', personaId),
  retrieveMemory: (args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => ipcRenderer.invoke('memory:retrieve', args),
  listMemory: (args: MemoryListArgs): Promise<MemoryListResult> => ipcRenderer.invoke('memory:list', args),
  upsertManualMemory: (args: MemoryUpsertManualArgs): Promise<MemoryRecord> => ipcRenderer.invoke('memory:upsertManual', args),
  updateMemory: (args: MemoryUpdateArgs): Promise<MemoryRecord> => ipcRenderer.invoke('memory:update', args),
  updateMemoryMeta: (args: MemoryUpdateMetaArgs): Promise<MemoryUpdateMetaResult> => ipcRenderer.invoke('memory:updateMeta', args),
  updateManyMemoryMeta: (args: MemoryUpdateManyMetaArgs): Promise<MemoryUpdateMetaResult> =>
    ipcRenderer.invoke('memory:updateManyMeta', args),
  updateMemoryByFilterMeta: (args: MemoryUpdateByFilterMetaArgs): Promise<MemoryUpdateMetaResult> =>
    ipcRenderer.invoke('memory:updateByFilterMeta', args),
  listMemoryVersions: (args: MemoryListVersionsArgs): Promise<MemoryVersionRecord[]> =>
    ipcRenderer.invoke('memory:listVersions', args),
  rollbackMemoryVersion: (args: MemoryRollbackVersionArgs): Promise<MemoryRecord> =>
    ipcRenderer.invoke('memory:rollbackVersion', args),
  listMemoryConflicts: (args: MemoryListConflictsArgs): Promise<MemoryListConflictsResult> =>
    ipcRenderer.invoke('memory:listConflicts', args),
  resolveMemoryConflict: (args: MemoryResolveConflictArgs): Promise<MemoryResolveConflictResult> =>
    ipcRenderer.invoke('memory:resolveConflict', args),
  deleteMemory: (args: MemoryDeleteArgs): Promise<{ ok: true }> => ipcRenderer.invoke('memory:delete', args),
  deleteManyMemory: (args: MemoryDeleteManyArgs): Promise<{ deleted: number }> => ipcRenderer.invoke('memory:deleteMany', args),
  deleteMemoryByFilter: (args: MemoryDeleteByFilterArgs): Promise<{ deleted: number }> =>
    ipcRenderer.invoke('memory:deleteByFilter', args),
})
