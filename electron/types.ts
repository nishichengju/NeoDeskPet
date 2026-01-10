export type WindowType = 'pet' | 'chat' | 'settings' | 'memory'

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
  positionX: number // 0-100，从左侧起的百分比
  positionY: number // 0-100，从顶部起的百分比
  tailDirection: TailDirection // 气泡尾巴方向
  showOnClick: boolean // 点击桌宠时展示气泡
  showOnChat: boolean // AI 回复时展示气泡
  autoHideDelay: number // 自动隐藏延迟（ms，0 表示仅手动关闭）
  clickPhrases: string[] // 点击桌宠的随机话术

  // M3.5：上下文情况小球（可拖动，hover 查看占用）
  contextOrbEnabled: boolean
  contextOrbX: number // 0-100，从左侧起的百分比
  contextOrbY: number // 0-100，从顶部起的百分比
}

export type TaskPanelSettings = {
  positionX: number // 0-100，从左侧起的百分比
  positionY: number // 0-100，从顶部起的百分比
}

export type OrchestratorSettings = {
  plannerEnabled: boolean // 是否启用“对话→任务规划器（LLM Planner）”
  plannerMode: 'auto' | 'always' // auto=仅在检测到“想做事”时触发；always=每条消息都走 planner 再决定
  toolCallingEnabled: boolean // 是否启用“工具系统”（LLM 可创建并执行工具任务）
  toolCallingMode: 'auto' | 'native' | 'text' // auto=优先原生tools，失败降级文本协议；native=强制原生；text=强制文本协议

  toolUseCustomAi: boolean // 是否为“工具/Agent”使用单独的 LLM API
  toolAiApiKey: string
  toolAiBaseUrl: string
  toolAiModel: string
  toolAiTemperature: number // 0.0 - 2.0
  toolAiMaxTokens: number // 最大输出 token
  toolAiTimeoutMs: number // 超时毫秒

  toolAgentMaxTurns: number // agent.run 最大回合数（回合越多越慢/更耗工具调用）
}

export type ToolSettings = {
  // å…¨å±€å·¥å…·å¼€å…³ï¼šå…³é—­åŽï¼Œæ‰€æœ‰å·¥å…·éƒ½ä¼šè¢«æ‹’ç»æ‰§è¡Œï¼ˆåŒ…æ‹¬ä»»åŠ¡æ­¥éª¤/agent.run å·¥å…·è°ƒç”¨ï¼‰
  enabled: boolean
  // åˆ†ç»„å¼€å…³ï¼škey ä¸º toolName çš„å‰ç¼€ï¼ˆå¦‚ browser/cli/file/llm/delayï¼‰
  groups: Record<string, boolean>
  // å•å·¥å…·å¼€å…³ï¼škey ä¸º toolNameï¼ˆå¦‚ browser.openï¼‰
  tools: Record<string, boolean>
}

export type McpTransport = 'stdio'

export type McpServerConfig = {
  id: string // 唯一 ID（仅允许字母/数字/_/-）
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

export type AISettings = {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number // 0.0 - 2.0
  maxTokens: number // 最大输出 token
  maxContextTokens: number // 最大上下文 token
  systemPrompt: string
  enableVision: boolean // 是否启用识图能力（部分模型不支持）
  enableChatStreaming: boolean // 聊天流式生成（SSE）
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

  // M3.5：上下文情况小球（可拖动，hover 查看占用）
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
}

export type TtsSettings = {
  enabled: boolean
  baseUrl: string // GPT-SoVITS API host，例如 http://127.0.0.1:9880
  gptWeightsPath: string // 例如 GPT_SoVITS/pretrained_models/s1v3.ckpt
  sovitsWeightsPath: string // 例如 GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth
  speedFactor: number // 0.5 - 2.0
  refAudioPath: string // 参考音频路径（相对 GPT-SoVITS 根目录）
  promptText: string // 参考音频文本（prompt_text）
  streaming: boolean // 流式处理（边生成边播放）
  segmented: boolean // 分句同步：TTS 念一句显示一句
  pauseMs: number // 分句间停顿（ms）
}

export type AsrSettings = {
  enabled: boolean
  wsUrl: string // 例如 ws://127.0.0.1:8766/ws
  micDeviceId: string // 麦克风设备 ID（空字符串=系统默认）
  captureBackend?: 'auto' | 'script' | 'worklet' // 采集链路：auto=优先 worklet；script=强制 ScriptProcessor；worklet=强制 AudioWorklet
  language: 'auto' | 'zn' | 'en' | 'yue' | 'ja' | 'ko' | 'nospeech'
  useItn: boolean
  autoSend: boolean // 识别完直接发送给 LLM，否则只填入输入框
  mode: 'continuous' | 'hotkey' // 持续录音 / 按键录音（系统快捷键切换）
  hotkey: string // Electron accelerator，例如 F8 / CommandOrControl+Alt+V
  showSubtitle: boolean // 是否在桌宠窗口显示识别字幕（Live2D 左侧）
  vadChunkMs: number // 流式 VAD 输入分块（ms），越小越低延迟
  maxEndSilenceMs: number // 尾部静音判停（ms），过低易截断，过高停得慢
  minSpeechMs: number // 最短语音段（ms），过低易把噪声也识别
  maxSpeechMs: number // 最长语音段（ms），超长强制切分避免长句延迟
  prerollMs: number // 起点预留（ms），避免吞掉开头
  postrollMs: number // 终点补偿（ms），避免吞掉结尾
  enableAgc: boolean // 自动增益（音量太低时会放大）
  agcTargetRms: number // 目标 RMS（建议 0.03-0.08）
  agcMaxGain: number // 最大增益倍数（建议 10-30）
  debug: boolean
}

export type ChatRole = 'user' | 'assistant'

// 一个消息气泡（turn 容器）内部的分块：用于在同一条消息内插入 ToolUse 等 UI
export type ChatMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; taskId: string; runId?: string } // runId=可选：指向 task.toolRuns[i].id（用于一条消息里渲染多个工具卡片）
  | { type: 'status'; text: string }

export type ChatMessageRecord = {
  id: string
  role: ChatRole
  content: string
  image?: string // data URL (base64)
  taskId?: string // 关联任务：用于在聊天中渲染可折叠的 ToolUse 详情（不写入正文）
  blocks?: ChatMessageBlock[] // turn 容器：按顺序渲染 text/tool_use/status 等块（不写入 LLM 上下文时只取 text）
  createdAt: number
  updatedAt?: number
}

export type ChatSession = {
  id: string
  name: string
  nameMode?: 'auto' | 'manual'
  personaId: string
  // 自动提炼游标：用于判断“新增了多少有效消息”从而触发下一次自动提炼
  // 有效消息：合并连续 assistant（例如 TTS 分句导致的多条 assistant）后计算
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
  activePersonaId: string
  memory: MemorySettings
  memoryConsole: MemoryConsoleSettings
  petWindowBounds: WindowBounds
  chatWindowBounds: WindowBounds
  settingsWindowBounds: WindowBounds
  memoryWindowBounds: WindowBounds
  petScale: number // 0.5 - 5.0
  petOpacity: number // 0.3 - 1.0
  live2dModelId: string
  live2dModelFile: string
  bubble: BubbleSettings
  taskPanel: TaskPanelSettings
  orchestrator: OrchestratorSettings
  tools: ToolSettings
  mcp: McpSettings
  ai: AISettings
  chatProfile: ChatProfile
  chatUi: ChatUiSettings
  tts: TtsSettings
  asr: AsrSettings
}

export type MemorySettings = {
  enabled: boolean // 全局记忆开关：关闭后不写入，也不参与召回
  includeSharedOnRetrieve: boolean // 检索时是否默认包含共享记忆（persona_id 为 NULL）

  // 记忆写入去重：只使用向量相似度（cosine）
  vectorDedupeThreshold?: number // 去重阈值（0~1，越高越保守）

  autoExtractEnabled?: boolean // 是否启用“对话超过阈值自动提炼为长期记忆”
  autoExtractEveryEffectiveMessages?: number // 每新增多少条“有效消息”触发一次
  autoExtractMaxEffectiveMessages?: number // 每次提炼时最多取最近多少条“有效消息”
  autoExtractCooldownMs?: number // 自动提炼最小间隔（避免过于频繁）
  autoExtractUseCustomAi?: boolean // 自动提炼是否使用单独的 LLM 配置（不影响聊天主模型）
  autoExtractAiApiKey?: string
  autoExtractAiBaseUrl?: string
  autoExtractAiModel?: string
  autoExtractAiTemperature?: number
  autoExtractAiMaxTokens?: number

  // M5：Tag 网络（模糊问法扩展，本地低延迟）
  tagEnabled?: boolean // 是否启用 Tag 网络召回（不依赖 LLM）
  tagMaxExpand?: number // query 命中 tag 后，最多扩展的相关 tag 数（0=不扩展）

  // M5：向量召回（更强，需 embeddings API）
  vectorEnabled?: boolean // 是否启用向量相似召回
  vectorEmbeddingModel?: string // embeddings 模型名（OpenAI-compatible）
  vectorMinScore?: number // 最低相似度门槛（cosine，0~1）
  vectorTopK?: number // 向量检索 topK（用于混合排序）
  vectorScanLimit?: number // 每次向量扫描最大条数（降低延迟）
  vectorUseCustomAi?: boolean // 向量是否使用单独的 API Key/BaseUrl（不影响聊天）
  vectorAiApiKey?: string
  vectorAiBaseUrl?: string

  // M6：实体/事件/关系层（内置 SQLite 图层，可选）
  kgEnabled?: boolean // 是否启用图谱层召回（KG）
  kgIncludeChatMessages?: boolean // 是否对 chat_message 进行抽取（更全但更噪）
  kgUseCustomAi?: boolean // KG 抽取是否使用单独的 LLM 配置（不影响聊天）
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
  prompt: string // 人设补充提示词（会拼接到全局 systemPrompt 后）
  captureEnabled: boolean // 是否允许写入该角色的长期记忆
  captureUser: boolean // 是否记录用户消息
  captureAssistant: boolean // 是否记录 AI 消息
  retrieveEnabled: boolean // 是否允许该角色参与召回
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
  importance: number // 0~1，重要程度（越高越不容易被遗忘/越靠前）
  strength: number // 0~1，牢固程度（被召回/被编辑会提升）
  accessCount: number // 被召回命中次数
  lastAccessedAt: number | null // 上次命中时间戳（ms）
  retention: number // 0~1，遗忘曲线计算得出的“保留度”
  status: 'active' | 'archived' | 'deleted'
  memoryType: string // profile/preference/semantic/episodic/task/other...
  source: string | null // auto_extract/manual/user_msg/assistant_msg...
  pinned: number // 0/1，置顶（后续控制台会提供入口）
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
  reason?: string // 用于版本记录（如 manual_edit/rollback/conflict_accept 等）
  source?: string // 触发来源（如 memory_console/auto_extract 等）
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
  reinforce?: boolean // 是否将本次召回计入 hit/accessCount（默认 true；用于输入框预览等场景可传 false）
}

export type MemoryRetrieveResult = {
  addon: string // 直接拼接到 system prompt 的附加内容（人设+相关记忆）
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
  // Agent 在“对话正文”里应该展示的最终回复（不包含执行日志）
  finalReply?: string
  // Agent 运行中的逐步累积回复（用于“工具执行中”的实时显示）
  draftReply?: string
  // Live2D：由 LLM 输出的 [表情:...] / [动作:...] 标签提取出的动作指令（正文不显示该标签）
  live2dExpression?: string
  live2dMotion?: string
  // 工具调用过程（用于聊天里可折叠展示）
  toolRuns?: Array<{
    id: string
    toolName: string
    status: 'running' | 'done' | 'error'
    inputPreview?: string
    outputPreview?: string
    error?: string
    startedAt: number
    endedAt?: number
  }>
  lastError?: string
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
