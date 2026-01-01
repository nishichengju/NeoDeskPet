import type {
  AISettings,
  AppSettings,
  BubbleSettings,
  ChatMessageRecord,
  ChatProfile,
  ChatUiSettings,
  ChatSession,
  ChatSessionSummary,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemorySettings,
  MemoryConsoleSettings,
  MemoryListArgs,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
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
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  Persona,
  PersonaSummary,
  ScannedModel,
  TtsSettings,
  AsrSettings,
} from '../electron/types'
import type { TtsOptions } from '../electron/ttsOptions'

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

export type NeoDeskPetApi = {
  getSettings(): Promise<AppSettings>
  setAlwaysOnTop(value: boolean): Promise<AppSettings>
  setClickThrough(value: boolean): Promise<AppSettings>
  setActivePersonaId(personaId: string): Promise<AppSettings>
  setMemorySettings(memory: Partial<MemorySettings>): Promise<AppSettings>
  setMemoryConsoleSettings(patch: Partial<MemoryConsoleSettings>): Promise<AppSettings>
  setPetScale(value: number): Promise<AppSettings>
  setPetOpacity(value: number): Promise<AppSettings>
  setLive2dModel(modelId: string, modelFile: string): Promise<AppSettings>
  // AI settings
  setAISettings(aiSettings: Partial<AISettings>): Promise<AppSettings>
  // Bubble settings
  setBubbleSettings(bubbleSettings: Partial<BubbleSettings>): Promise<AppSettings>
  // Chat profile
  setChatProfile(chatProfile: Partial<ChatProfile>): Promise<AppSettings>
  // Chat UI appearance
  setChatUiSettings(chatUi: Partial<ChatUiSettings>): Promise<AppSettings>
  // TTS settings
  setTtsSettings(tts: Partial<TtsSettings>): Promise<AppSettings>
  listTtsOptions(): Promise<TtsOptions>
  // ASR settings
  setAsrSettings(asr: Partial<AsrSettings>): Promise<AppSettings>
  // Model scanner
  scanModels(): Promise<ScannedModel[]>
  // Chat sessions/messages
  listChatSessions(): Promise<{ sessions: ChatSessionSummary[]; currentSessionId: string }>
  getChatSession(sessionId?: string): Promise<ChatSession>
  createChatSession(name?: string, personaId?: string): Promise<ChatSession>
  setCurrentChatSession(sessionId: string): Promise<{ currentSessionId: string }>
  renameChatSession(sessionId: string, name: string): Promise<ChatSessionSummary>
  deleteChatSession(sessionId: string): Promise<{ sessions: ChatSessionSummary[]; currentSessionId: string }>
  clearChatSession(sessionId: string): Promise<ChatSession>
  setChatMessages(sessionId: string, messages: ChatMessageRecord[]): Promise<ChatSession>
  addChatMessage(sessionId: string, message: ChatMessageRecord): Promise<ChatSession>
  updateChatMessage(sessionId: string, messageId: string, content: string): Promise<ChatSession>
  deleteChatMessage(sessionId: string, messageId: string): Promise<ChatSession>
  setChatAutoExtractCursor(sessionId: string, cursor: number): Promise<ChatSession>
  setChatAutoExtractMeta(
    sessionId: string,
    patch: Partial<
      Pick<
        ChatSession,
        'autoExtractCursor' | 'autoExtractLastRunAt' | 'autoExtractLastWriteCount' | 'autoExtractLastError'
      >
    >,
  ): Promise<ChatSession>

  // Long-term memory / personas
  listPersonas(): Promise<PersonaSummary[]>
  getPersona(personaId: string): Promise<Persona | null>
  createPersona(name: string): Promise<Persona>
  updatePersona(
    personaId: string,
    patch: {
      name?: string
      prompt?: string
      captureEnabled?: boolean
      captureUser?: boolean
      captureAssistant?: boolean
      retrieveEnabled?: boolean
    },
  ): Promise<Persona>
  deletePersona(personaId: string): Promise<{ ok: true }>
  retrieveMemory(args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult>
  listMemory(args: MemoryListArgs): Promise<MemoryListResult>
  upsertManualMemory(args: MemoryUpsertManualArgs): Promise<MemoryRecord>
  updateMemory(args: MemoryUpdateArgs): Promise<MemoryRecord>
  updateMemoryMeta(args: MemoryUpdateMetaArgs): Promise<MemoryUpdateMetaResult>
  updateManyMemoryMeta(args: MemoryUpdateManyMetaArgs): Promise<MemoryUpdateMetaResult>
  updateMemoryByFilterMeta(args: MemoryUpdateByFilterMetaArgs): Promise<MemoryUpdateMetaResult>
  listMemoryVersions(args: MemoryListVersionsArgs): Promise<MemoryVersionRecord[]>
  rollbackMemoryVersion(args: MemoryRollbackVersionArgs): Promise<MemoryRecord>
  listMemoryConflicts(args: MemoryListConflictsArgs): Promise<MemoryListConflictsResult>
  resolveMemoryConflict(args: MemoryResolveConflictArgs): Promise<MemoryResolveConflictResult>
  deleteMemory(args: MemoryDeleteArgs): Promise<{ ok: true }>
  deleteManyMemory(args: MemoryDeleteManyArgs): Promise<{ deleted: number }>
  deleteMemoryByFilter(args: MemoryDeleteByFilterArgs): Promise<{ deleted: number }>
  // Live2D expression/motion triggers
  triggerExpression(expressionName: string): void
  triggerMotion(motionGroup: string, index?: number): void
  // Live2D expression/motion listeners
  onLive2dExpression(listener: Live2DExpressionListener): () => void
  onLive2dMotion(listener: Live2DMotionListener): () => void
  // Window operations
  openChat(): Promise<void>
  openSettings(): Promise<void>
  openMemory(): Promise<void>
  hideAll(): Promise<void>
  closeCurrent(): Promise<void>
  quit(): Promise<void>
  startDrag(): void
  stopDrag(): void
  showContextMenu(): void
  setIgnoreMouseEvents(ignore: boolean, forward: boolean): void
  onSettingsChanged(listener: SettingsChangeListener): () => void
  // Bubble message
  onBubbleMessage(listener: BubbleMessageListener): () => void
  sendBubbleMessage(message: string): void

  // TTS segmented sync (chat -> pet)
  enqueueTtsUtterance(payload: TtsEnqueuePayload): void
  finalizeTtsUtterance(utteranceId: string): void
  stopTtsAll(): void

  // TTS segmented sync (pet -> chat)
  reportTtsSegmentStarted(payload: TtsSegmentStartedPayload): void
  reportTtsUtteranceEnded(payload: TtsUtteranceEndedPayload): void
  reportTtsUtteranceFailed(payload: TtsUtteranceFailedPayload): void

  // TTS segmented sync listeners
  onTtsEnqueue(listener: TtsEnqueueListener): () => void
  onTtsFinalize(listener: TtsFinalizeListener): () => void
  onTtsSegmentStarted(listener: TtsSegmentStartedListener): () => void
  onTtsUtteranceEnded(listener: TtsUtteranceEndedListener): () => void
  onTtsUtteranceFailed(listener: TtsUtteranceFailedListener): () => void
  onTtsStopAll(listener: TtsStopAllListener): () => void
}

export type NeoDeskPetMemoryApi = Pick<
  NeoDeskPetApi,
  | 'getSettings'
  | 'setMemorySettings'
  | 'onSettingsChanged'
  | 'listPersonas'
  | 'getPersona'
  | 'createPersona'
  | 'updatePersona'
  | 'deletePersona'
  | 'retrieveMemory'
  | 'listMemory'
  | 'upsertManualMemory'
  | 'updateMemory'
  | 'updateMemoryMeta'
  | 'updateManyMemoryMeta'
  | 'updateMemoryByFilterMeta'
  | 'listMemoryVersions'
  | 'rollbackMemoryVersion'
  | 'listMemoryConflicts'
  | 'resolveMemoryConflict'
  | 'deleteMemory'
  | 'deleteManyMemory'
  | 'deleteMemoryByFilter'
>

export function getApi(): NeoDeskPetApi | null {
  const api = (window as unknown as { neoDeskPet?: NeoDeskPetApi }).neoDeskPet
  return api ?? null
}

export function getMemoryApi(): NeoDeskPetMemoryApi | null {
  const api = (window as unknown as { neoDeskPetMemory?: NeoDeskPetMemoryApi }).neoDeskPetMemory
  return api ?? null
}
