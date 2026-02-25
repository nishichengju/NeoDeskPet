export type WindowType = 'pet' | 'chat' | 'settings' | 'memory' | 'orb' | 'orb-menu'

export type DisplayMode = 'live2d' | 'orb' | 'hidden'

export type OrbUiState = 'ball' | 'bar' | 'panel'

export type BubbleStyle = 'cute' | 'pixel' | 'minimal' | 'cloud'
export type TailDirection = 'up' | 'down' | 'left' | 'right'

export type ScannedModel = {
  id: string
  name: string
  path: string
  modelFile: string
}

export type BubbleSettings = {
  style: BubbleStyle
  positionX: number // 0-100
  positionY: number // 0-100
  tailDirection: TailDirection
  showOnClick: boolean
  showOnChat: boolean
  autoHideDelay: number
  clickPhrases: string[]

  // M3.5: context usage orb
  contextOrbEnabled: boolean
  contextOrbX: number // 0-100
  contextOrbY: number // 0-100
}

export type TaskPanelSettings = {
  enabled: boolean
  positionX: number // 0-100
  positionY: number // 0-100
}

export type OrchestratorSettings = {
  plannerEnabled: boolean // Enable conversation -> task planner (LLM Planner)
  plannerMode: 'auto' | 'always' // auto=trigger on task intent; always=run planner every turn
  toolCallingEnabled: boolean // Enable tool calling (LLM can start tool tasks)
  toolCallingMode: 'auto' | 'native' | 'text' // auto=prefer native tools; native=force native; text=force text protocol

  skillEnabled: boolean // Enable skill system (available_skills prompt + /skill commands)
  skillAllowModelInvocation: boolean // Inject available_skills for model self-selection
  skillManagedDir: string // Optional managed skill directory override; empty=default path
  skillVerboseLogging: boolean // Emit skill match/load/conflict logs into agent task log

  toolUseCustomAi: boolean // Use a dedicated LLM config for tool/agent execution
  toolAiApiKey: string
  toolAiBaseUrl: string
  toolAiModel: string
  toolAiTemperature: number // 0.0 - 2.0
  toolAiMaxTokens: number // Max output tokens
  toolAiTimeoutMs: number // Request timeout in milliseconds

  toolAgentMaxTurns: number // Max turns for agent.run to avoid infinite loops
}

export type ToolSettings = {
  // Global tool switch: when off, all tool execution is rejected (including agent.run)
  enabled: boolean
  // Group switches: key is toolName prefix (e.g. browser/cli/file/llm/delay)
  groups: Record<string, boolean>
  // Per-tool switches: key is full toolName (e.g. browser.open)
  tools: Record<string, boolean>
}

export type McpTransport = 'stdio'

export type McpServerConfig = {
  id: string // Unique ID (letters/numbers/_/- only)
  enabled: boolean
  label?: string
  transport: McpTransport
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

export type McpSettings = {
  enabled: boolean
  servers: McpServerConfig[]
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpToolSummary = {
  serverId: string
  toolName: string // mcp.<serverId>.<toolName>
  callName: string
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export type McpServerState = {
  id: string
  enabled: boolean
  label?: string
  transport: McpTransport
  command: string
  args: string[]
  cwd?: string
  status: McpServerStatus
  pid?: number | null
  lastError?: string
  stderrTail?: string[]
  tools: McpToolSummary[]
  updatedAt: number
}

export type McpStateSnapshot = {
  enabled: boolean
  servers: McpServerState[]
  updatedAt: number
}

export type WindowBounds = {
  x?: number
  y?: number
  width: number
  height: number
}

export type AIThinkingEffort = 'disabled' | 'low' | 'medium' | 'high'
export type AIReasoningProvider = 'auto' | 'openai' | 'claude' | 'gemini'
export type OpenAIReasoningEffort = 'disabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ClaudeThinkingEffort = 'disabled' | 'low' | 'medium' | 'high'
export type GeminiThinkingEffort = 'disabled' | 'low' | 'medium' | 'high'

export type AISettings = {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number // 0.0 - 2.0
  maxTokens: number // Max output tokens
  maxContextTokens: number // Max context tokens
  thinkingEffort: AIThinkingEffort // 兼容旧配置的统一思考强度（建议使用下方 provider 专属配置）
  thinkingProvider: AIReasoningProvider // auto=按模型推断；也可手动指定 openai/claude/gemini
  openaiReasoningEffort: OpenAIReasoningEffort // OpenAI 兼容 reasoning_effort（含 GPT-5 的 minimal/xhigh）
  claudeThinkingEffort: ClaudeThinkingEffort // Claude（兼容网关）映射为 thinking.budget_tokens
  geminiThinkingEffort: GeminiThinkingEffort // Gemini（OpenAI 兼容）映射为 reasoning_effort
  systemPrompt: string
  enableVision: boolean // Enable image/vision capability (model-dependent)
  enableChatStreaming: boolean // Enable streaming chat output (SSE)
}
export type AIProfile = {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  model: string
  createdAt: number
  updatedAt: number
}

export type ChatProfile = {
  userName: string
  userAvatar: string // data URL (base64) or empty string
  assistantName: string
  assistantAvatar: string // data URL (base64) or empty string
}

export type ChatUiSettings = {
  background: string
  userBubbleBackground: string
  assistantBubbleBackground: string
  bubbleRadius: number
  backgroundImage: string // data URL (base64) or empty string
  backgroundImageOpacity: number // 0.0 - 1.0

  // M3.5: context usage orb (draggable; hover to inspect usage)
  contextOrbEnabled: boolean
  contextOrbX: number // 0-100
  contextOrbY: number // 0-100
}

export type ContextUsageSnapshot = {
  usedTokens: number
  maxContextTokens: number
  outputReserveTokens?: number
  systemPromptTokens?: number
  addonTokens?: number
  historyTokens?: number
  trimmedCount?: number
  updatedAt?: number
  isRealUsage?: boolean // true=real API usage; false/undefined=estimated
}

export type TtsSettings = {
  enabled: boolean
  baseUrl: string // GPT-SoVITS API URL, e.g. http://127.0.0.1:9880
  gptWeightsPath: string // e.g. GPT_SoVITS/pretrained_models/s1v3.ckpt
  sovitsWeightsPath: string // e.g. GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth
  speedFactor: number // 0.5 - 2.0
  refAudioPath: string // Reference audio path (relative to GPT-SoVITS root)
  promptText: string // Reference text (prompt_text)
  streaming: boolean // Stream TTS chunks while generating
  segmented: boolean // Segment-synced mode: speak one sentence at a time
  pauseMs: number // Pause between segmented sentences (ms)
}

export type AsrSettings = {
  enabled: boolean
  wsUrl: string // e.g. ws://127.0.0.1:8766/ws
  micDeviceId: string // Microphone device ID (empty string = system default)
  captureBackend?: 'auto' | 'script' | 'worklet' // auto=prefer worklet; script=force ScriptProcessor; worklet=force AudioWorklet
  language: 'auto' | 'zn' | 'en' | 'yue' | 'ja' | 'ko' | 'nospeech'
  useItn: boolean
  autoSend: boolean // Auto-send recognized text to LLM (otherwise fill input only)
  mode: 'continuous' | 'hotkey' // Continuous recording / hotkey recording
  hotkey: string // Electron accelerator, e.g. F8 / CommandOrControl+Alt+V
  showSubtitle: boolean // Show ASR subtitles in pet window (Live2D side)
  vadChunkMs: number // VAD input chunk size (ms); smaller means lower latency
  maxEndSilenceMs: number // End-silence threshold (ms)
  minSpeechMs: number // Minimum speech segment length (ms)
  maxSpeechMs: number // Maximum speech segment length (ms)
  prerollMs: number // Pre-roll (ms), avoid clipping the beginning
  postrollMs: number // Post-roll (ms), avoid clipping the ending
  enableAgc: boolean // Enable automatic gain control
  agcTargetRms: number // Target RMS (recommended 0.03-0.08)
  agcMaxGain: number // Max gain multiplier (recommended 10-30)
  debug: boolean
}

export type ChatRole = 'user' | 'assistant'

// Blocks inside one chat turn, used to embed ToolUse/status UI in a single message
export type ChatMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; taskId: string; runId?: string } // runId maps to task.toolRuns[i].id for precise rendering
  | { type: 'status'; text: string }

export type ChatAttachment = {
  kind: 'image' | 'video'
  path: string // Absolute local path or accessible URL (typically from MCP tool output)
  filename?: string
}

export type ChatMessageRecord = {
  id: string
  role: ChatRole
  content: string
  attachments?: ChatAttachment[] // Attachment list for UI; can be converted to image_url/dataUrl for LLM
  image?: string // Legacy field: data URL (base64)
  imagePath?: string // Local image path (typically from MCP tool output)
  videoPath?: string // Local video path (typically from MCP tool output)
  taskId?: string // Related task ID for collapsible ToolUse details in chat
  blocks?: ChatMessageBlock[] // Turn blocks: text/tool_use/status (LLM context usually uses text only)
  createdAt: number
  updatedAt?: number
}

export type ChatSession = {
  id: string
  name: string
  nameMode?: 'auto' | 'manual'
  personaId: string
  // Auto-extract cursor: used to detect newly added effective messages
  // Effective messages merge consecutive assistant chunks (e.g. TTS sentence splits)
  autoExtractCursor?: number
  autoExtractLastRunAt?: number
  autoExtractLastWriteCount?: number
  autoExtractLastError?: string
  createdAt: number
  updatedAt: number
  messages: ChatMessageRecord[]
}

export type ChatSessionSummary = {
  id: string
  name: string
  personaId: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessagePreview?: string
  autoExtractCursor?: number
  autoExtractLastRunAt?: number
  autoExtractLastWriteCount?: number
  autoExtractLastError?: string
}

export type AppSettings = {
  alwaysOnTop: boolean
  clickThrough: boolean
  displayMode: DisplayMode
  activePersonaId: string
  memory: MemorySettings
  memoryConsole: MemoryConsoleSettings
  petWindowBounds: WindowBounds
  chatWindowBounds: WindowBounds
  settingsWindowBounds: WindowBounds
  memoryWindowBounds: WindowBounds
  // Orb window bounds for expanded state
  orbWindowBounds: WindowBounds
  petScale: number // 0.5 - 5.0
  petOpacity: number // 0.3 - 1.0
  live2dModelId: string
  live2dModelFile: string
  // Live2D mouse tracking toggle
  live2dMouseTrackingEnabled?: boolean
  // Live2D idle sway toggle
  live2dIdleSwayEnabled?: boolean
  bubble: BubbleSettings
  taskPanel: TaskPanelSettings
  orchestrator: OrchestratorSettings
  tools: ToolSettings
  mcp: McpSettings
  ai: AISettings
  aiProfiles: AIProfile[]
  activeAiProfileId?: string
  chatProfile: ChatProfile
  chatUi: ChatUiSettings
  tts: TtsSettings
  asr: AsrSettings
}

export type MemorySettings = {
  enabled: boolean // Global memory switch: disable writes and retrieval when false
  includeSharedOnRetrieve: boolean // Include shared memory (persona_id = NULL) in retrieval

  // Vector dedupe threshold used during auto extraction (cosine similarity)
  vectorDedupeThreshold?: number // Range 0~1, higher is stricter

  autoExtractEnabled?: boolean // Enable auto extraction into long-term memory
  autoExtractEveryEffectiveMessages?: number // Trigger extraction every N effective messages
  autoExtractMaxEffectiveMessages?: number // Max effective messages read per extraction
  autoExtractCooldownMs?: number // Minimum interval between auto extractions
  autoExtractUseCustomAi?: boolean // Use dedicated LLM config for auto extraction
  autoExtractAiApiKey?: string
  autoExtractAiBaseUrl?: string
  autoExtractAiModel?: string
  autoExtractAiTemperature?: number
  autoExtractAiMaxTokens?: number

  // M5: Tag graph retrieval (local and low latency)
  tagEnabled?: boolean // Enable tag retrieval (without LLM dependency)
  tagMaxExpand?: number // Max related tags to expand after tag hit (0=no expansion)

  // M5: Vector retrieval (stronger relevance; needs embeddings API)
  vectorEnabled?: boolean // Enable vector similarity retrieval
  vectorEmbeddingModel?: string // Embedding model name (OpenAI-compatible)
  vectorMinScore?: number // Minimum cosine similarity threshold (0~1)
  vectorTopK?: number // Candidate topK for vector retrieval
  vectorScanLimit?: number // Max scanned records per retrieval
  vectorUseCustomAi?: boolean // Use dedicated API config for vector retrieval
  vectorAiApiKey?: string
  vectorAiBaseUrl?: string

  // M5.5: Multimodal vector retrieval (image/video)
  mmVectorEnabled?: boolean // Enable multimodal vector retrieval
  mmVectorEmbeddingModel?: string // Multimodal embedding model (OpenAI-compatible)
  mmVectorUseCustomAi?: boolean // Use dedicated API config for multimodal retrieval
  mmVectorAiApiKey?: string
  mmVectorAiBaseUrl?: string

  // M6: Knowledge graph (KG) retrieval and maintenance
  kgEnabled?: boolean // Enable KG retrieval
  kgIncludeChatMessages?: boolean // Include chat_message records in KG construction
  kgUseCustomAi?: boolean // Use dedicated LLM config for KG operations
  kgAiApiKey?: string
  kgAiBaseUrl?: string
  kgAiModel?: string
  kgAiTemperature?: number
  kgAiMaxTokens?: number
}

export type MemoryStatus = 'active' | 'archived' | 'deleted'

export type MemoryOrderBy =
  | 'createdAt'
  | 'updatedAt'
  | 'retention'
  | 'importance'
  | 'strength'
  | 'accessCount'
  | 'lastAccessedAt'

export type MemoryConsoleSettings = {
  personaId: string
  scope: 'persona' | 'shared' | 'all'
  role: 'user' | 'assistant' | 'note' | 'all'
  query: string
  status: MemoryStatus | 'all'
  pinned: 'all' | 'pinned' | 'unpinned'
  source: string | 'all'
  memoryType: string | 'all'
  orderBy: MemoryOrderBy
  orderDir: 'asc' | 'desc'
  limit: number
  autoRefresh: boolean
  extractSessionId: string | null
  extractMaxMessages: number
  extractWriteToSelectedPersona: boolean
  extractSaveScope: 'model' | 'persona' | 'shared'
}

export type Persona = {
  id: string
  name: string
  prompt: string // 人设系统提示词，会注入到会话 systemPrompt
  captureEnabled: boolean // 是否启用该 persona 的记忆采集
  captureUser: boolean // 是否采集用户消息
  captureAssistant: boolean // 是否采集助手消息
  retrieveEnabled: boolean // 是否启用该 persona 的记忆召回
  createdAt: number
  updatedAt: number
}

export type PersonaSummary = {
  id: string
  name: string
  updatedAt: number
}

export type MemoryRecord = {
  rowid: number
  personaId: string | null
  scope: 'persona' | 'shared'
  kind: string
  role: string | null
  content: string
  createdAt: number
  updatedAt: number
  importance: number // 0~1 importance score
  strength: number // 0~1 memory strength
  accessCount: number // Access count
  lastAccessedAt: number | null // Last access timestamp in ms
  retention: number // 0~1 retention coefficient
  status: 'active' | 'archived' | 'deleted'
  memoryType: string // profile/preference/semantic/episodic/task/other...
  source: string | null // auto_extract/manual/user_msg/assistant_msg...
  pinned: number // 0/1 pinned state
}

export type MemoryFilterArgs = {
  personaId: string
  scope?: 'persona' | 'shared' | 'all'
  role?: 'user' | 'assistant' | 'note' | 'all'
  query?: string
  status?: MemoryStatus | 'all'
  pinned?: 'all' | 'pinned' | 'unpinned'
  source?: string | 'all'
  memoryType?: string | 'all'
}

export type MemoryListArgs = MemoryFilterArgs & {
  orderBy?: MemoryOrderBy
  orderDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type MemoryListResult = {
  total: number
  items: MemoryRecord[]
}

export type MemoryUpsertManualArgs = {
  personaId: string
  scope: 'persona' | 'shared'
  content: string
  source?: string
  memoryType?: string
  importance?: number
  strength?: number
}

export type MemoryUpdateArgs = {
  rowid: number
  content: string
  reason?: string // Edit reason (manual_edit/rollback/conflict_accept)
  source?: string // Edit source (memory_console/auto_extract)
}

export type MemoryVersionRecord = {
  id: string
  memoryRowid: number
  oldContent: string
  newContent: string
  reason: string
  source: string | null
  createdAt: number
}

export type MemoryListVersionsArgs = {
  rowid: number
  limit?: number
}

export type MemoryRollbackVersionArgs = {
  versionId: string
}

export type MemoryConflictType = 'update' | 'merge' | 'conflict'
export type MemoryConflictStatus = 'open' | 'resolved' | 'ignored'

export type MemoryConflictRecord = {
  id: string
  memoryRowid: number
  basePersonaId: string | null
  baseScope: 'persona' | 'shared'
  baseContent: string
  baseMemoryType: string
  conflictType: MemoryConflictType
  candidateContent: string
  candidateSource: string | null
  candidateImportance: number | null
  candidateStrength: number | null
  candidateMemoryType: string | null
  status: MemoryConflictStatus
  createdAt: number
  resolvedAt: number | null
  resolution: string | null
}

export type MemoryListConflictsArgs = {
  personaId: string
  scope?: 'persona' | 'shared' | 'all'
  status?: MemoryConflictStatus | 'all'
  limit?: number
  offset?: number
}

export type MemoryListConflictsResult = {
  total: number
  items: MemoryConflictRecord[]
}

export type MemoryResolveConflictArgs = {
  id: string
  action: 'accept' | 'keepBoth' | 'merge' | 'ignore'
  mergedContent?: string
}

export type MemoryResolveConflictResult = {
  ok: true
  updatedRowid?: number
  createdRowid?: number
}

export type MemoryDeleteArgs = {
  rowid: number
}

export type MemoryDeleteManyArgs = {
  rowids: number[]
}

export type MemoryDeleteByFilterArgs = {
  personaId: string
  scope?: 'persona' | 'shared' | 'all'
  role?: 'user' | 'assistant' | 'note' | 'all'
  query?: string
  status?: MemoryStatus | 'all'
  pinned?: 'all' | 'pinned' | 'unpinned'
  source?: string | 'all'
  memoryType?: string | 'all'
}

export type MemoryMetaPatch = {
  status?: MemoryStatus
  pinned?: number
  importance?: number
  strength?: number
  retention?: number
  memoryType?: string
  source?: string | null
}

export type MemoryUpdateMetaArgs = {
  rowid: number
  patch: MemoryMetaPatch
}

export type MemoryUpdateManyMetaArgs = {
  rowids: number[]
  patch: MemoryMetaPatch
}

export type MemoryUpdateByFilterMetaArgs = MemoryDeleteByFilterArgs & {
  patch: MemoryMetaPatch
}

export type MemoryUpdateMetaResult = {
  updated: number
}

export type MemoryRetrieveArgs = {
  personaId: string
  query: string
  limit?: number
  maxChars?: number
  includeShared?: boolean
  reinforce?: boolean // Reinforce hits by increasing hit/accessCount
}

export type MemoryRetrieveResult = {
  addon: string // Memory addon text appended to system prompt
  debug?: {
    tookMs: number
    layers: Array<'none' | 'timeRange' | 'fts' | 'like' | 'tag' | 'vector' | 'kg'>
    counts: {
      timeRange: number
      fts: number
      like: number
      tag: number
      vector: number
      kg: number
    }
    tag?: {
      queryTags: number
      matchedTags: number
      expandedTags: number
    }
    vector?: {
      enabled: boolean
      attempted: boolean
      reason?: string
      error?: string
    }
  }
}

// =========================
// Task / Orchestrator (M1)
// =========================

export type TaskQueue = 'browser' | 'file' | 'cli' | 'chat' | 'learning' | 'play' | 'other'
export type TaskStatus = 'pending' | 'running' | 'paused' | 'failed' | 'done' | 'canceled'

export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type TaskStepRecord = {
  id: string
  title: string
  status: TaskStepStatus
  tool?: string
  input?: string
  output?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

export type TaskRecord = {
  id: string
  queue: TaskQueue
  title: string
  why: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  steps: TaskStepRecord[]
  currentStepIndex: number
  toolsUsed: string[]
  // Agent final reply returned after task/tool flow completes
  finalReply?: string
  // Agent draft reply (intermediate streaming state)
  draftReply?: string
  // Live2D tag parse result extracted from LLM output ([expression]/[motion])
  live2dExpression?: string
  live2dMotion?: string
  // Tool execution details for task step UI rendering
  toolRuns?: Array<{
    id: string
    toolName: string
    status: 'running' | 'done' | 'error'
    inputPreview?: string
    outputPreview?: string
    imagePaths?: string[]
    error?: string
    startedAt: number
    endedAt?: number
  }>
  lastError?: string
  // API token usage summary for context usage and debugging
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export type TaskListResult = {
  items: TaskRecord[]
}

export type TaskCreateArgs = {
  queue?: TaskQueue
  title: string
  why?: string
  steps?: Array<Pick<TaskStepRecord, 'title' | 'tool' | 'input'>>
}
