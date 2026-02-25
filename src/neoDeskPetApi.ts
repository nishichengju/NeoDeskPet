import type {
  AISettings,
  AppSettings,
  BubbleSettings,
  ChatMessageRecord,
  ChatProfile,
  ChatUiSettings,
  ChatSession,
  ChatSessionSummary,
  TaskCreateArgs,
  TaskListResult,
  TaskRecord,
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
  TaskPanelSettings,
  OrchestratorSettings,
  ToolSettings,
  McpSettings,
  McpStateSnapshot,
  ContextUsageSnapshot,
  DisplayMode,
  OrbUiState,
} from '../electron/types'
import type { TtsOptions } from '../electron/ttsOptions'

export type SettingsChangeListener = (settings: AppSettings) => void
export type Live2DExpressionListener = (expressionName: string) => void
export type Live2DMotionListener = (motionGroup: string, index: number) => void
export type Live2DParamScriptListener = (payload: unknown) => void
export type Live2DMouseTargetListener = (payload: { x: number; y: number; t?: number }) => void
export type BubbleMessageListener = (message: string) => void

export type TtsEnqueuePayload = { utteranceId: string; mode: 'replace' | 'append'; segments: string[]; fullText?: string }
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
export type McpChangedListener = (snapshot: McpStateSnapshot) => void

export type NeoDeskPetApi = {
  // Debug log：用于复现后回放定位“消息回退/工具卡堆叠”等问题
  getDebugLogPath(): Promise<string>
  clearDebugLog(): Promise<{ ok: true; path: string }>
  appendDebugLog(event: string, data?: unknown): void

  getSettings(): Promise<AppSettings>
  setAlwaysOnTop(value: boolean): Promise<AppSettings>
  setClickThrough(value: boolean): Promise<AppSettings>
  setActivePersonaId(personaId: string): Promise<AppSettings>
  setMemorySettings(memory: Partial<MemorySettings>): Promise<AppSettings>
  setMemoryConsoleSettings(patch: Partial<MemoryConsoleSettings>): Promise<AppSettings>
  setPetScale(value: number): Promise<AppSettings>
  setPetOpacity(value: number): Promise<AppSettings>
  setLive2dModel(modelId: string, modelFile: string): Promise<AppSettings>
  setLive2dMouseTrackingEnabled(enabled: boolean): Promise<AppSettings>
  setLive2dIdleSwayEnabled(enabled: boolean): Promise<AppSettings>
  // AI settings
  setAISettings(aiSettings: Partial<AISettings>): Promise<AppSettings>
  saveAIProfile(payload: { id?: string; name: string; apiKey: string; baseUrl: string; model: string }): Promise<AppSettings>
  deleteAIProfile(id: string): Promise<AppSettings>
  applyAIProfile(id: string): Promise<AppSettings>
  listAIModels(payload?: { apiKey?: string; baseUrl?: string }): Promise<{ ok: boolean; models: string[]; error?: string }>
  // Bubble settings
  setBubbleSettings(bubbleSettings: Partial<BubbleSettings>): Promise<AppSettings>
  // Task panel settings (M2)
  setTaskPanelSettings(patch: Partial<TaskPanelSettings>): Promise<AppSettings>
  // Orchestrator settings (M4)
  setOrchestratorSettings(patch: Partial<OrchestratorSettings>): Promise<AppSettings>
  // Tool center / toggles (M3.5)
  setToolSettings(patch: Partial<ToolSettings>): Promise<AppSettings>
  // MCP settings/state (M3.5 Step2)
  setMcpSettings(patch: Partial<McpSettings>): Promise<AppSettings>
  getMcpState(): Promise<McpStateSnapshot>
  onMcpChanged(listener: McpChangedListener): () => void
  // Context usage snapshot (chat -> main -> pet/chat)
  setContextUsage(snapshot: ContextUsageSnapshot | null): void
  getContextUsage(): Promise<ContextUsageSnapshot | null>
  onContextUsageChanged(listener: (snapshot: ContextUsageSnapshot | null) => void): () => void
  // Chat profile
  setChatProfile(chatProfile: Partial<ChatProfile>): Promise<AppSettings>
  // Chat UI appearance
  setChatUiSettings(chatUi: Partial<ChatUiSettings>): Promise<AppSettings>
  // TTS settings
  setTtsSettings(tts: Partial<TtsSettings>): Promise<AppSettings>
  listTtsOptions(): Promise<TtsOptions>
  // TTS HTTP proxy（避免 renderer 直接请求本地 TTS 服务时的 CORS/预检问题）
  ttsHttpGetJson(url: string): Promise<{ ok: boolean; status: number; statusText: string; json: unknown; error?: string }>
  ttsHttpRequestArrayBuffer(payload: {
    url: string
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; status: number; statusText: string; contentType: string; arrayBuffer: ArrayBuffer; error?: string }>
  ttsHttpStreamStart(payload: {
    url: string
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<{ streamId: string }>
  ttsHttpStreamCancel(streamId: string): Promise<{ ok: true }>
  // ASR settings
  setAsrSettings(asr: Partial<AsrSettings>): Promise<AppSettings>
  // ASR hotkey / transcript (pet <-> main <-> chat)
  onAsrHotkeyToggle(listener: () => void): () => void
  reportAsrTranscript(text: string): void
  notifyAsrTranscriptReady(): void
  takeAsrTranscript(): Promise<string>
  onAsrTranscript(listener: (text: string) => void): () => void
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
  saveChatAttachment(payload: {
    kind: 'image' | 'video'
    sourcePath?: string
    dataUrl?: string
    filename?: string
  }): Promise<{ ok: true; kind: 'image' | 'video'; path: string; filename: string; mimeType?: string }>
  readChatAttachmentDataUrl(path: string): Promise<{ ok: true; mimeType: string; dataUrl: string }>
  getChatAttachmentUrl(path: string): Promise<{ ok: true; url: string }>
  updateChatMessage(sessionId: string, messageId: string, content: string): Promise<ChatSession>
  updateChatMessageRecord(sessionId: string, messageId: string, patch: Partial<ChatMessageRecord>): Promise<ChatSession>
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

  // Tasks / Orchestrator (M1)
  listTasks(): Promise<TaskListResult>
  getTask(id: string): Promise<TaskRecord | null>
  createTask(args: TaskCreateArgs): Promise<TaskRecord>
  pauseTask(id: string): Promise<TaskRecord | null>
  resumeTask(id: string): Promise<TaskRecord | null>
  cancelTask(id: string): Promise<TaskRecord | null>
  dismissTask(id: string): Promise<{ ok: true } | null>
  onTasksChanged(listener: TasksChangedListener): () => void

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
  onLive2dParamScript(listener: Live2DParamScriptListener): () => void
  onLive2dMouseTarget(listener: Live2DMouseTargetListener): () => void
  // Live2D capabilities report (pet window -> main, for tool/agent usage)
  reportLive2dCapabilities(payload: unknown): void
  // Window operations
  openChat(): Promise<void>
  openSettings(): Promise<void>
  openMemory(): Promise<void>
  setDisplayMode(mode: DisplayMode): Promise<void>
  hideAll(): Promise<void>
  closeCurrent(): Promise<void>
  quit(): Promise<void>

  // Orb window state
  getOrbUiState(): Promise<{ state: OrbUiState }>
  setOrbUiState(state: OrbUiState, opts?: { focus?: boolean }): Promise<{ state: OrbUiState }>
  toggleOrbUiState(): Promise<{ state: OrbUiState }>
  setOrbOverlayBounds(payload: { width: number; height: number; focus?: boolean }): Promise<{ ok: true }>
  clearOrbOverlayBounds(payload?: { focus?: boolean }): Promise<{ ok: true }>
  onOrbStateChanged(listener: (payload: { state: OrbUiState }) => void): () => void
  showOrbContextMenu(point: { x: number; y: number }): Promise<{ ok: true }>
  startDrag(point?: { x: number; y: number }): void
  dragMove(point: { x: number; y: number }): void
  stopDrag(point?: { x: number; y: number }): void
  showContextMenu(): void
  setPetOverlayHover(hovering: boolean): void
  setPetOverlayRects(
    rects:
      | {
          taskPanel?:
            | { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }
            | null
        }
      | null,
  ): void
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

  // TTS HTTP streaming proxy events (main -> renderer)
  onTtsHttpStreamChunk(listener: (payload: { streamId: string; chunk: Uint8Array }) => void): () => void
  onTtsHttpStreamDone(listener: (payload: { streamId: string }) => void): () => void
  onTtsHttpStreamError(
    listener: (payload: { streamId: string; error?: string; status?: number; statusText?: string; contentType?: string; arrayBuffer?: ArrayBuffer }) => void,
  ): () => void
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
