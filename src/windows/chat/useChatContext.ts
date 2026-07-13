import { getBuiltinToolDefinitions } from '../../../electron/toolRegistry'
import type {
  AICredentialRef,
  AISettings,
  AppSettings,
  ChatMessageRecord,
  ContextUsageSnapshot,
  McpStateSnapshot,
} from '../../../electron/types'
import type { NeoDeskPetApi } from '../../neoDeskPetApi'
import {
  ABORTED_ERROR,
  AIService,
  type ChatMessage,
  type ChatUsage,
} from '../../services/aiService'
import { buildContextCompressionSummaryPrompt, normalizeAssistantDisplayText } from '../../utils/chatMessages'
import { buildWorldBookAddon } from '../../utils/promptAddons'
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { PendingChatAttachment } from './ChatComposer'

export type ChatContextApi = Pick<NeoDeskPetApi, 'getMcpState' | 'onMcpChanged' | 'retrieveMemory' | 'setContextUsage'>

export type ChatContextDebugLog = (event: string, data?: unknown) => void

export type ChatHistoryBudgetResult = {
  history: ChatMessage[]
  trimmedCount: number
}

export type ChatHistoryPreparationResult = ChatHistoryBudgetResult & {
  compressed: boolean
}

type ChatCompactor = Pick<AIService, 'chat'>

function normalizeContextLimits(ai?: AISettings | null) {
  const maxContextTokensRaw = ai?.maxContextTokens ?? 128000
  const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))
  const maxTokensRaw = ai?.maxTokens ?? 2048
  const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))
  return { maxContextTokens, outputReserve }
}

export function estimateTokensFromText(text: string): number {
  const cleaned = String(text ?? '').trim()
  if (!cleaned) return 0
  return Math.max(1, Math.ceil(cleaned.length / 4))
}

export function estimateTokensForChatMessage(message: ChatMessage): number {
  if (!message) return 0
  if (typeof message.content === 'string') return estimateTokensFromText(message.content)

  let total = 0
  for (const part of message.content) {
    if (part.type === 'text') total += estimateTokensFromText(part.text)
    else total += 800
  }
  return total
}

export function trimChatHistoryToMaxContext(
  history: ChatMessage[],
  systemAddon: string,
  ai?: AISettings | null,
): ChatHistoryBudgetResult {
  const { maxContextTokens, outputReserve } = normalizeContextLimits(ai)
  const systemPromptTokens = estimateTokensFromText(ai?.systemPrompt ?? '')
  const addonTokens = estimateTokensFromText(systemAddon)

  let budget = maxContextTokens - outputReserve - systemPromptTokens - addonTokens
  if (!Number.isFinite(budget) || budget < 256) budget = 256

  const kept: ChatMessage[] = []
  let total = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokensForChatMessage(history[index])
    if (kept.length > 0 && total + cost > budget) break
    kept.push(history[index])
    total += cost
  }
  kept.reverse()
  return { history: kept, trimmedCount: Math.max(0, history.length - kept.length) }
}

export function buildChatToolDirectoryAddon(options: {
  mcpSnapshot: McpStateSnapshot | null
  plannerEnabled: boolean
  plannerMode: string
  toolCallingEnabled: boolean
  toolCallingMode: string
}): string {
  const lines = getBuiltinToolDefinitions().map((definition) => `- ${definition.name}：${definition.description}`)
  const servers = Array.isArray(options.mcpSnapshot?.servers) ? options.mcpSnapshot.servers : []

  for (const server of servers) {
    const tools = Array.isArray(server.tools) ? server.tools : []
    for (const tool of tools) {
      const toolName = typeof tool?.toolName === 'string' ? tool.toolName : ''
      if (!toolName) continue
      const description =
        (typeof tool?.description === 'string' && tool.description.trim()) ||
        (typeof tool?.title === 'string' && tool.title.trim()) ||
        (typeof tool?.name === 'string' && tool.name.trim()) ||
        'MCP tool'
      lines.push(`- ${toolName}：${description}`)
    }
  }

  const maxToolLines = 80
  const toolLines =
    lines.length > maxToolLines ? [...lines.slice(0, maxToolLines), `- ...（${lines.length - maxToolLines} 项已省略）`] : lines
  const toolSwitch = options.toolCallingEnabled ? `已启用（mode=${options.toolCallingMode}）` : '已关闭'
  const plannerSwitch = options.plannerEnabled ? `已启用（mode=${options.plannerMode}）` : '已关闭'

  return [
    '【可用工具（权威，本地注册表）】',
    toolLines.join('\n'),
    '',
    `当前开关：任务规划器${plannerSwitch}；工具执行${toolSwitch}`,
    '规则：只有当用户在问“你能做什么/有哪些工具/能力说明”时，才解释并列出工具；否则不要主动输出工具清单。',
    '注意：当“工具执行”为关闭时，不要承诺你会真的去执行这些工具；只能聊天/解释用法。',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildUsageHistory(options: {
  canUseVision: boolean
  input: string
  messages: ChatMessageRecord[]
  pendingAttachments: Pick<PendingChatAttachment, 'kind'>[]
}): ChatMessage[] {
  const history: ChatMessage[] = options.messages.map((message) => {
    if (message.role !== 'user') return { role: 'assistant', content: message.content }

    const attachmentImageCount = Array.isArray(message.attachments)
      ? message.attachments.filter(
          (attachment) => attachment && typeof attachment === 'object' && (attachment as { kind?: unknown }).kind === 'image',
        ).length
      : 0

    if ((message.image || attachmentImageCount > 0) && options.canUseVision) {
      const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
      const text = message.content === '[图片]' ? '' : message.content
      if (text.trim()) parts.push({ type: 'text', text })
      if (message.image) {
        parts.push({ type: 'image_url', image_url: { url: message.image } })
      } else {
        const count = Math.max(0, Math.min(4, attachmentImageCount))
        for (let index = 0; index < count; index += 1) {
          parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
        }
      }
      return { role: 'user', content: parts }
    }

    return { role: 'user', content: message.content.trim() || '[消息]' }
  })

  const inputText = options.input.trim()
  const pendingImageCount = options.pendingAttachments.filter((attachment) => attachment.kind === 'image').length
  if (!inputText && pendingImageCount === 0) return history

  if (pendingImageCount > 0 && options.canUseVision) {
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
    if (inputText) parts.push({ type: 'text', text: inputText })
    const count = Math.max(0, Math.min(4, pendingImageCount))
    for (let index = 0; index < count; index += 1) {
      parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
    }
    history.push({ role: 'user', content: parts })
  } else {
    history.push({ role: 'user', content: inputText || '[消息]' })
  }
  return history
}

export function computeChatContextUsage(options: {
  ai: AISettings | null | undefined
  canUseVision: boolean
  input: string
  lastApiUsage: ChatUsage | null
  messages: ChatMessageRecord[]
  now?: () => number
  pendingAttachments: Pick<PendingChatAttachment, 'kind'>[]
  systemAddon: string
}): ContextUsageSnapshot | null {
  const ai = options.ai
  if (!ai) return null
  const { maxContextTokens, outputReserve } = normalizeContextLimits(ai)
  const updatedAt = (options.now ?? Date.now)()

  if (options.lastApiUsage && options.lastApiUsage.promptTokens > 0) {
    return {
      usedTokens: options.lastApiUsage.promptTokens + options.lastApiUsage.completionTokens,
      maxContextTokens,
      outputReserveTokens: outputReserve,
      systemPromptTokens: 0,
      addonTokens: 0,
      historyTokens: options.lastApiUsage.promptTokens,
      trimmedCount: 0,
      updatedAt,
      isRealUsage: true,
    }
  }

  const systemPromptTokens = estimateTokensFromText(ai.systemPrompt)
  const addonTokens = estimateTokensFromText(options.systemAddon)
  const withPending = buildUsageHistory(options)
  const trimmed = trimChatHistoryToMaxContext(withPending, options.systemAddon, ai)
  const historyTokens = trimmed.history.reduce((sum, message) => sum + estimateTokensForChatMessage(message), 0)

  return {
    usedTokens: systemPromptTokens + addonTokens + historyTokens + outputReserve,
    maxContextTokens,
    outputReserveTokens: outputReserve,
    systemPromptTokens,
    addonTokens,
    historyTokens,
    trimmedCount: trimmed.trimmedCount,
    updatedAt,
  }
}

export type PrepareChatHistoryOptions = {
  createCompactor?: (settings: AISettings, credential: AICredentialRef) => ChatCompactor
  debugLog?: ChatContextDebugLog
  history: ChatMessage[]
  notify?: boolean
  onNotice?: (message: string) => void
  reason?: string
  settings: AppSettings | null
  signal?: AbortSignal
  systemAddon: string
}

export async function prepareChatHistoryToMaxContext(
  options: PrepareChatHistoryOptions,
): Promise<ChatHistoryPreparationResult> {
  const applyTrimOnly = (): ChatHistoryPreparationResult => {
    const trimmed = trimChatHistoryToMaxContext(options.history, options.systemAddon, options.settings?.ai)
    if (options.notify && trimmed.trimmedCount > 0) {
      options.onNotice?.(
        `提示：对话上下文过长，已自动截断为最近 ${trimmed.history.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`,
      )
    }
    return { ...trimmed, compressed: false }
  }

  const ai = options.settings?.ai
  if (!ai || !(ai.autoContextCompressionEnabled ?? true) || options.history.length < 8) return applyTrimOnly()

  const { maxContextTokens, outputReserve } = normalizeContextLimits(ai)
  const systemPromptTokens = estimateTokensFromText(ai.systemPrompt)
  const addonTokens = estimateTokensFromText(options.systemAddon)
  const historyTokens = options.history.reduce((sum, message) => sum + estimateTokensForChatMessage(message), 0)
  const estimatedUsed = systemPromptTokens + addonTokens + historyTokens + outputReserve

  const thresholdPctRaw = ai.autoContextCompressionThresholdPct ?? 85
  const targetPctRaw = ai.autoContextCompressionTargetPct ?? 65
  const thresholdPct = Math.max(50, Math.min(99, Math.trunc(Number.isFinite(thresholdPctRaw) ? thresholdPctRaw : 85)))
  const targetPct = Math.max(35, Math.min(thresholdPct - 5, Math.trunc(Number.isFinite(targetPctRaw) ? targetPctRaw : 65)))
  if (estimatedUsed <= Math.floor((maxContextTokens * thresholdPct) / 100)) return applyTrimOnly()

  const targetUsedTokens = Math.floor((maxContextTokens * targetPct) / 100)
  let allowedHistoryTokensAfter = targetUsedTokens - outputReserve - systemPromptTokens - addonTokens
  if (!Number.isFinite(allowedHistoryTokensAfter) || allowedHistoryTokensAfter < 512) allowedHistoryTokensAfter = 512

  let keepRecentCount = Math.max(6, Math.min(12, options.history.length))
  while (keepRecentCount > 4) {
    const recent = options.history.slice(options.history.length - keepRecentCount)
    const recentTokens = recent.reduce((sum, message) => sum + estimateTokensForChatMessage(message), 0)
    if (recentTokens <= Math.max(256, allowedHistoryTokensAfter - 256)) break
    keepRecentCount -= 2
  }

  const oldMessages = options.history.slice(0, Math.max(0, options.history.length - keepRecentCount))
  const recentMessages = options.history.slice(Math.max(0, options.history.length - keepRecentCount))
  if (oldMessages.length < 4 || recentMessages.length === 0) return applyTrimOnly()

  const compressionInput = buildContextCompressionSummaryPrompt(oldMessages).trim()
  if (!compressionInput) return applyTrimOnly()
  if (options.notify) options.onNotice?.('提示：上下文接近阈值，正在自动压缩上下文…')

  const compressionApiSource = ai.autoContextCompressionApiSource === 'profile' ? 'profile' : 'main'
  const compressionProfileId = String(ai.autoContextCompressionProfileId ?? '').trim()
  const compressionProfile =
    compressionApiSource === 'profile' && Array.isArray(options.settings?.aiProfiles)
      ? options.settings.aiProfiles.find((profile) => profile.id === compressionProfileId) ?? null
      : null
  const compressionModel = String(ai.autoContextCompressionModel ?? '').trim()

  options.debugLog?.('chat:context.compress.start', {
    reason: options.reason ?? 'chat',
    totalMessages: options.history.length,
    oldMessages: oldMessages.length,
    keepRecentMessages: recentMessages.length,
    compressionApiSource,
    compressionProfileId: compressionProfile?.id ?? '',
    compressionModel: compressionModel || ai.model,
    estimatedUsed,
    maxContextTokens,
    thresholdPct,
    targetPct,
  })

  try {
    const compressionMaxTokens = Math.max(512, Math.min(2200, Math.trunc(ai.maxTokens / 2)))
    const compressionAiSettings: AISettings = {
      ...ai,
      apiMode: compressionProfile?.apiMode ?? ai.apiMode,
      apiKey: compressionProfile?.apiKey?.trim() || ai.apiKey,
      hasApiKey: compressionProfile?.hasApiKey ?? ai.hasApiKey,
      baseUrl: compressionProfile?.baseUrl?.trim() || ai.baseUrl,
      model: compressionModel || compressionProfile?.model?.trim() || ai.model,
      maxTokens: compressionMaxTokens,
      thinkingEffort: 'disabled',
      openaiReasoningEffort: 'disabled',
      claudeThinkingEffort: 'disabled',
      geminiThinkingEffort: 'disabled',
      enableVision: false,
      enableChatStreaming: false,
    }
    const credential: AICredentialRef = compressionProfile ? { kind: 'profile', profileId: compressionProfile.id } : { kind: 'main' }
    const compactor = (options.createCompactor ?? ((settings, ref) => new AIService(settings, ref)))(compressionAiSettings, credential)
    const summaryTargetChars = Math.max(600, Math.min(12000, allowedHistoryTokensAfter * 4))
    const compressionPrompt =
      compressionInput.length > 20000 ? `${compressionInput.slice(0, 20000)}\n\n（已截断过长历史）` : compressionInput
    const response = await compactor.chat(
      [
        {
          role: 'system',
          content:
            '你是“对话上下文压缩器”。请把更早对话压缩成可供后续回答继续使用的摘要。\n' +
            '要求：1) 只保留事实、偏好、约束、目标、已完成事项、未完成事项、关键结论；2) 不要编造；3) 用简体中文；4) 输出纯文本，不要 Markdown 标题/代码块；5) 尽量精简。',
        },
        {
          role: 'user',
          content: `请压缩以下较早对话（目标尽量简洁，约 ${summaryTargetChars} 字以内，不必严格）：\n\n${compressionPrompt}`,
        },
      ],
      { signal: options.signal },
    )

    if (response.error) {
      if (response.error === ABORTED_ERROR) throw new DOMException('Aborted', 'AbortError')
      throw new Error(response.error)
    }

    let summaryText = normalizeAssistantDisplayText(response.content, { trim: true })
    if (!summaryText) throw new Error('压缩结果为空')
    if (summaryText.length > summaryTargetChars) {
      summaryText = `${summaryText.slice(0, summaryTargetChars).trim()}\n（摘要已截断）`
    }

    const compressedHistory: ChatMessage[] = [
      { role: 'assistant', content: `【自动压缩上下文摘要（系统生成）】\n${summaryText}` },
      ...recentMessages,
    ]
    const trimmed = trimChatHistoryToMaxContext(compressedHistory, options.systemAddon, ai)
    options.debugLog?.('chat:context.compress.done', {
      reason: options.reason ?? 'chat',
      compressed: true,
      compressionApiSource,
      compressionProfileId: compressionProfile?.id ?? '',
      compressionModel: compressionAiSettings.model,
      oldMessages: oldMessages.length,
      keepRecentMessages: recentMessages.length,
      finalMessages: trimmed.history.length,
      trimmedCount: trimmed.trimmedCount,
    })
    if (options.notify) {
      const extraTrim = trimmed.trimmedCount > 0 ? `；另外又截断 ${trimmed.trimmedCount} 条` : ''
      options.onNotice?.(`提示：已自动压缩上下文（压缩 ${oldMessages.length} 条，保留最近 ${recentMessages.length} 条原文${extraTrim}）。`)
    }
    return { ...trimmed, compressed: true }
  } catch (error) {
    if ((error as { name?: unknown })?.name !== 'AbortError') {
      console.warn('[ContextCompression] failed:', error)
      options.debugLog?.('chat:context.compress.fail', {
        reason: options.reason ?? 'chat',
        error: error instanceof Error ? error.message : String(error),
      })
      if (options.notify) options.onNotice?.('提示：自动压缩上下文失败，已回退为普通截断。')
    }
    return applyTrimOnly()
  }
}

export function createContextUsagePublisher(
  send: (snapshot: ContextUsageSnapshot) => void,
  options?: {
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
    intervalMs?: number
    now?: () => number
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  },
) {
  const intervalMs = Math.max(0, options?.intervalMs ?? 250)
  const now = options?.now ?? Date.now
  const setTimer = options?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options?.clearTimer ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
  let lastSentAt = 0
  let pending: ContextUsageSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (!pending) return
    const snapshot = pending
    pending = null
    lastSentAt = now()
    send(snapshot)
  }

  const publish = (snapshot: ContextUsageSnapshot) => {
    pending = snapshot
    const waitMs = intervalMs - (now() - lastSentAt)
    if (waitMs <= 0) {
      if (timer != null) {
        clearTimer(timer)
        timer = null
      }
      flush()
      return
    }
    if (timer != null) return
    timer = setTimer(() => {
      timer = null
      flush()
    }, waitMs)
  }

  const dispose = () => {
    if (timer != null) clearTimer(timer)
    timer = null
    pending = null
  }

  return { dispose, flush, publish }
}

export type UseChatContextOptions = {
  api: ChatContextApi | null
  canUseVision: boolean
  debugLog: ChatContextDebugLog
  getActivePersonaId: () => string
  input: string
  lastApiUsage: ChatUsage | null
  messages: ChatMessageRecord[]
  pendingAttachments: Pick<PendingChatAttachment, 'kind'>[]
  personaSystemAddon: string
  removeDuplicatedPersonaFromMemoryAddon: (addon: string) => string
  retrieveEnabled: boolean
  settings: AppSettings | null
  settingsRef: MutableRefObject<AppSettings | null>
  setNotice: (message: string) => void
}

export function useChatContext(options: UseChatContextOptions) {
  const [mcpSnapshot, setMcpSnapshot] = useState<McpStateSnapshot | null>(null)
  const [contextRetrieveAddon, setContextRetrieveAddon] = useState('')
  const retrieveRequestIdRef = useRef(0)
  const api = options.api
  const getActivePersonaId = options.getActivePersonaId
  const input = options.input
  const memoryEnabled = options.settings?.memory?.enabled ?? true
  const removeDuplicatedPersonaFromMemoryAddon = options.removeDuplicatedPersonaFromMemoryAddon
  const retrieveEnabled = options.retrieveEnabled
  const settingsRef = options.settingsRef

  useEffect(() => {
    if (!api) return
    let disposed = false
    api
      .getMcpState()
      .then((snapshot) => {
        if (!disposed) setMcpSnapshot(snapshot)
      })
      .catch(() => undefined)
    const off = api.onMcpChanged((snapshot) => {
      if (!disposed) setMcpSnapshot(snapshot)
    })
    return () => {
      disposed = true
      off()
    }
  }, [api])

  useEffect(() => {
    const requestId = (retrieveRequestIdRef.current += 1)
    if (!api || !memoryEnabled || !retrieveEnabled) {
      setContextRetrieveAddon('')
      return
    }

    const query = input.trim()
    if (!query) {
      setContextRetrieveAddon('')
      return
    }

    const includeShared = settingsRef.current?.memory?.includeSharedOnRetrieve ?? true
    const personaId = getActivePersonaId()
    const timer = window.setTimeout(() => {
      void api
        .retrieveMemory({
          personaId,
          query,
          limit: 12,
          maxChars: 3200,
          includeShared,
          reinforce: false,
        })
        .then((result) => {
          if (retrieveRequestIdRef.current !== requestId) return
          setContextRetrieveAddon(removeDuplicatedPersonaFromMemoryAddon(result.addon?.trim() ?? ''))
        })
        .catch(() => {
          if (retrieveRequestIdRef.current === requestId) setContextRetrieveAddon('')
        })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [
    api,
    getActivePersonaId,
    input,
    memoryEnabled,
    removeDuplicatedPersonaFromMemoryAddon,
    retrieveEnabled,
    settingsRef,
  ])

  const toolDirectoryAddon = useMemo(
    () =>
      buildChatToolDirectoryAddon({
        mcpSnapshot,
        plannerEnabled: options.settings?.orchestrator?.plannerEnabled ?? false,
        plannerMode: options.settings?.orchestrator?.plannerMode ?? 'auto',
        toolCallingEnabled: options.settings?.orchestrator?.toolCallingEnabled ?? false,
        toolCallingMode: options.settings?.orchestrator?.toolCallingMode ?? 'auto',
      }),
    [
      mcpSnapshot,
      options.settings?.orchestrator?.plannerEnabled,
      options.settings?.orchestrator?.plannerMode,
      options.settings?.orchestrator?.toolCallingEnabled,
      options.settings?.orchestrator?.toolCallingMode,
    ],
  )

  const worldBookAddon = useMemo(() => {
    const activePersonaId = options.settings?.activePersonaId?.trim() || 'default'
    return buildWorldBookAddon(options.settings, activePersonaId)
  }, [options.settings])

  const systemAddonForUsage = useMemo(
    () =>
      [options.personaSystemAddon.trim(), contextRetrieveAddon.trim(), worldBookAddon.trim(), toolDirectoryAddon.trim()]
        .filter(Boolean)
        .join('\n\n'),
    [contextRetrieveAddon, options.personaSystemAddon, toolDirectoryAddon, worldBookAddon],
  )

  const maybeCompressChatHistoryToMaxContext = useCallback(
    (
      history: ChatMessage[],
      systemAddon: string,
      compressionOptions?: { signal?: AbortSignal; notify?: boolean; reason?: string },
    ) =>
      prepareChatHistoryToMaxContext({
        settings: options.settingsRef.current,
        history,
        systemAddon,
        signal: compressionOptions?.signal,
        notify: compressionOptions?.notify,
        reason: compressionOptions?.reason,
        debugLog: options.debugLog,
        onNotice: options.setNotice,
      }),
    [options.debugLog, options.setNotice, options.settingsRef],
  )

  const chatContextUsage = useMemo(
    () =>
      computeChatContextUsage({
        ai: options.settings?.ai,
        canUseVision: options.canUseVision,
        input: options.input,
        lastApiUsage: options.lastApiUsage,
        messages: options.messages,
        pendingAttachments: options.pendingAttachments,
        systemAddon: systemAddonForUsage,
      }),
    [
      options.canUseVision,
      options.input,
      options.lastApiUsage,
      options.messages,
      options.pendingAttachments,
      options.settings?.ai,
      systemAddonForUsage,
    ],
  )

  const usagePublisher = useMemo(() => {
    if (!options.api) return null
    return createContextUsagePublisher((snapshot) => {
      try {
        options.api?.setContextUsage(snapshot)
      } catch {
        /* ignore */
      }
    })
  }, [options.api])

  useEffect(() => {
    if (chatContextUsage) usagePublisher?.publish(chatContextUsage)
  }, [chatContextUsage, usagePublisher])

  useEffect(() => () => usagePublisher?.dispose(), [usagePublisher])

  return {
    chatContextUsage,
    maybeCompressChatHistoryToMaxContext,
  }
}
