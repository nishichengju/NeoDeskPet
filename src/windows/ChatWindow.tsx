// 聊天窗口：会话管理、流式对话、TTS/规划器与消息渲染（自 App.tsx 拆出）

import { getBuiltinToolDefinitions, isToolEnabled } from '../../electron/toolRegistry'
import type { AppSettings, ChatAttachment, ChatMessageBlock, ChatMessageRecord, ChatSessionSummary, ContextUsageSnapshot, McpStateSnapshot, MemoryRetrieveResult, Persona, TaskCreateArgs, TaskRecord, TaskStepRecord, VisualArtifactRef } from '../../electron/types'
import { ContextUsageOrb } from '../components/ContextUsageOrb'
import { MarkdownMessage } from '../components/MarkdownMessage'
import { LocalVideo, MmvectorImagePreview } from '../components/MediaPreviews'
import { ImageViewer, type ImageViewerItem } from './chat/ImageViewer'
import { ChatMessageAttachments } from './chat/ChatMessageAttachments'
import { parseModelMetadata } from '../live2d/live2dModels'
import { getApi } from '../neoDeskPetApi'
import { ABORTED_ERROR, AIService, getAIService, setModelInfoToAIService, type ChatContentPart, type ChatMessage, type ChatUsage } from '../services/aiService'
import { splitTextIntoTtsSegments } from '../services/textSegmentation'
import { BUBBLE_PREVIEW_FALLBACK_PREFIX, buildContextCompressionSummaryPrompt, buildInterruptedStreamContent, canonicalizeLocalImagePath, collapseAssistantRuns, computeAppendDelta, filterVisibleToolRuns, isAgentShellToolName, joinTextBlocks, mergeLeadingPunctuationAcrossToolBoundary, normalizeAssistantDisplayText, normalizeInterleavedTextSegment, normalizeMessageBlocks, pickRicherToolBlocks, sliceTail, toLocalMediaSrc } from '../utils/chatMessages'
import { createStreamFlushThrottle, extractLastLive2DTags, extractLive2DTags, extractTailLive2DTags } from '../utils/live2dStream'
import { buildPlannerSystemPrompt, parsePlannerDecision, requestLikelyNeedsToolAction } from '../utils/planner'
import { buildToolResultSystemAddon, buildWorldBookAddon } from '../utils/promptAddons'
import { clampIntValue } from '../utils/settingsHelpers'
import { countStableTtsSegments, trimTrailingCommaForSegment } from '../utils/ttsText'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

const TASK_TOOL_VISION_NAMES = new Set(['image.generate', 'screen.capture', 'browser.screenshot'])

function collectTaskVisionImagePaths(task: TaskRecord, limit = 4): string[] {
  const runs = Array.isArray(task.toolRuns) ? task.toolRuns : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    const toolName = String(run?.toolName ?? '').trim()
    if (!TASK_TOOL_VISION_NAMES.has(toolName)) continue
    const paths = Array.isArray(run?.imagePaths) ? run.imagePaths : []
    for (const raw of paths) {
      const p = canonicalizeLocalImagePath(raw)
      if (!p || seen.has(p)) continue
      seen.add(p)
      out.push(p)
      if (out.length >= limit) return out
    }
  }
  return out
}

function taskImagePatch(task: TaskRecord): Pick<ChatMessageRecord, 'attachments' | 'imagePath'> {
  const attachments: ChatAttachment[] = collectTaskVisionImagePaths(task, 8).map((path) => ({ kind: 'image' as const, path }))
  return attachments.length > 0 ? { attachments, imagePath: attachments[0].path } : {}
}

function collectMessageImagePaths(message: ChatMessageRecord): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    const p = String(value ?? '').trim()
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }

  if (Array.isArray(message.attachments)) {
    for (const att of message.attachments) {
      if (!att || typeof att !== 'object') continue
      if ((att as { kind?: unknown }).kind !== 'image') continue
      add((att as { path?: unknown }).path)
    }
  }
  add(message.imagePath)
  return out
}

export function ChatWindow(props: { api: ReturnType<typeof getApi> }) {
  const { api } = props
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [lastRetrieveDebug, setLastRetrieveDebug] = useState<MemoryRetrieveResult['debug'] | null>(null)
  // 最近一轮 agent.run 的图片注入结果（来自任务日志 [Vision] 行），用于区分“真的看到图”与文本幻觉
  const [lastVisionDebug, setLastVisionDebug] = useState<string | null>(null)
  const [mcpSnapshotForContext, setMcpSnapshotForContext] = useState<McpStateSnapshot | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const inputRef = useRef('')
  const messagesRef = useRef<ChatMessageRecord[]>([])
  const toolAnimRef = useRef<{ motionGroups: string[]; expressions: string[] }>({ motionGroups: [], expressions: [] })
  const isLoadingRef = useRef(false)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [showStatusDetails, setShowStatusDetails] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionName, setEditingSessionName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null)
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = useState('')
  type PendingAttachment = {
    id: string
    kind: 'image' | 'video'
    path: string
    resourceId?: string
    filename: string
    previewDataUrl?: string
  }
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  // 存储最近一次 API 返回的真实 token usage（用于精确上下文统计）
  const [lastApiUsage, setLastApiUsage] = useState<ChatUsage | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const userAvatarInputRef = useRef<HTMLInputElement>(null)
  const assistantAvatarInputRef = useRef<HTMLInputElement>(null)
  const editingTextareaRef = useRef<HTMLTextAreaElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const composerComposingRef = useRef(false)
  const confirmClearButtonRef = useRef<HTMLButtonElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [ttsSegmentedMessageFlags, setTtsSegmentedMessageFlags] = useState<Record<string, true>>({})
  const [ttsRevealedSegments, setTtsRevealedSegments] = useState<Record<string, number>>({})
  const [ttsPendingUtteranceId, setTtsPendingUtteranceId] = useState<string | null>(null)
  const ttsUtteranceMetaRef = useRef<
    Record<
      string,
      {
        sessionId: string
        createdAt: number
        messageId: string
        displayedSegments: number
        fallbackContent?: string
      }
    >
  >({})
  const aiAbortRef = useRef<AbortController | null>(null)
  const chatStopSeqRef = useRef(0)
  const plannerPendingRef = useRef(false)
  const pendingAsrAutoSendRef = useRef<string[]>([])
  const asrAutoSendFlushingRef = useRef(false)
  const asrComposePreviewLastSigRef = useRef<string>('')
  const bubblePreviewLastSigRef = useRef<string>('')
  const bubblePreviewSendDebugAtRef = useRef(0)
  const tasksRef = useRef<TaskRecord[]>([])
  const taskOriginSessionRef = useRef<Map<string, string>>(new Map())
  const taskOriginMessageRef = useRef<Map<string, string>>(new Map())
  const taskOriginBlocksRef = useRef<Map<string, ChatMessageBlock[]>>(new Map())
  const taskToolUseSplitRef = useRef<Map<string, { runIds: string[]; segments: string[]; lastDisplay: string }>>(new Map())
  const taskUiDebugSigRef = useRef<Map<string, string>>(new Map())
  const taskBubbleTtsProgressRef = useRef<Map<string, { spokenFrozen: number; spokeFinal: boolean }>>(new Map())
  const taskBubblePreviewProgressRef = useRef<Map<string, { shownFrozen: number; lastShownAt: number; lastTailText: string }>>(new Map())
  const taskFinalizeContextRef = useRef<
    Map<
      string,
      {
        sessionId: string
        messageId: string
        chatHistory: ChatMessage[]
        systemAddon: string
        userText: string
      }
    >
  >(new Map())
  const taskFinalizingRef = useRef<Set<string>>(new Set())

  const toolFactsSeenRef = useRef<Set<string>>(new Set())
  const sessionToolFactsRef = useRef<Map<string, Array<{ at: number; lines: string[] }>>>(new Map())

  const addSessionToolFacts = useCallback((sessionId: string, lines: string[], at?: number) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return
    const cleaned = (lines ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)
    if (cleaned.length === 0) return
    const ts = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
    const prev = sessionToolFactsRef.current.get(sid) ?? []
    const next = [...prev, { at: ts, lines: cleaned }]
    // 仅保留最近 30 条“事实块”
    const sliced = next.length > 30 ? next.slice(next.length - 30) : next
    sessionToolFactsRef.current.set(sid, sliced)
  }, [])

  const buildSessionToolFactsAddon = useCallback((sessionId: string): string => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return ''
    const items = sessionToolFactsRef.current.get(sid) ?? []
    if (items.length === 0) return ''
    const nowTs = Date.now()
    const fresh = items.filter((x) => nowTs - x.at < 15 * 60 * 1000)
    if (fresh.length === 0) return ''
    const flat = fresh.flatMap((x) => x.lines).filter(Boolean)
    if (flat.length === 0) return ''
    const MAX_LINES = 24
    const lines = flat.length > MAX_LINES ? [...flat.slice(0, MAX_LINES), `- ...（已省略 ${flat.length - MAX_LINES} 行）`] : flat
    return [
      '【最近工具事实（用于减少你让我重复；仅供后续工具调用）】',
      ...lines,
      '',
      '规则：1) 工具调用必须优先复用这些事实里的 path/url；2) 严禁编造路径；3) 最终回复不要暴露本地路径。',
    ].join('\n')
  }, [])
  const buildVisionPartsFromImagePaths = useCallback(
    async (paths: string[], limit = 4): Promise<ChatContentPart[]> => {
      const out: ChatContentPart[] = []
      if (!api) return out
      const seen = new Set<string>()
      for (const raw of paths) {
        const p = String(raw ?? '').trim()
        if (!p || seen.has(p)) continue
        seen.add(p)
        if (/^data:image\//i.test(p) || /^https?:\/\//i.test(p)) {
          out.push({ type: 'image_url', image_url: { url: p } })
        } else {
          try {
            const res = await api.readChatAttachmentDataUrl(p)
            if (res?.ok && typeof res.dataUrl === 'string' && res.dataUrl.trim()) {
              out.push({ type: 'image_url', image_url: { url: res.dataUrl } })
            }
          } catch {
            // The textual tool output still contains the path/result if the file is unreadable.
          }
        }
        if (out.length >= limit) break
      }
      return out
    },
    [api],
  )

  const collectRecentVisualArtifacts = useCallback((sourceMessages: ChatMessageRecord[], limit = 12): VisualArtifactRef[] => {
    const out: VisualArtifactRef[] = []
    const seenIds = new Set<string>()
    const seenPaths = new Set<string>()
    const add = (artifact: VisualArtifactRef) => {
      const imagePath = canonicalizeLocalImagePath(artifact.path)
      if (!artifact.id || !imagePath || seenIds.has(artifact.id) || seenPaths.has(imagePath)) return
      seenIds.add(artifact.id)
      seenPaths.add(imagePath)
      out.push({ ...artifact, path: imagePath })
    }

    for (const message of sourceMessages) {
      const taskId = String(message.taskId ?? '').trim()
      const task = taskId ? tasksRef.current.find((item) => item.id === taskId) : null
      let addedTaskArtifact = false
      if (task) {
        for (const run of Array.isArray(task.toolRuns) ? task.toolRuns : []) {
          const toolName = String(run?.toolName ?? '').trim()
          if (!TASK_TOOL_VISION_NAMES.has(toolName)) continue
          const paths = Array.isArray(run?.imagePaths) ? run.imagePaths.map(canonicalizeLocalImagePath).filter(Boolean) : []
          for (let index = 0; index < paths.length; index += 1) {
            add({
              id: `vis_${task.id}_${run.id}_${index + 1}`,
              path: paths[index],
              source: toolName as VisualArtifactRef['source'],
              groupId: `${task.id}:${run.id}`,
              index: index + 1,
              total: paths.length,
              messageId: message.id,
              taskId: task.id,
              runId: run.id,
              createdAt: run.endedAt ?? run.startedAt ?? message.createdAt,
            })
            addedTaskArtifact = true
          }
        }
      }

      if (message.role === 'user') {
        const imageAttachments = (Array.isArray(message.attachments) ? message.attachments : []).filter(
          (attachment) => attachment?.kind === 'image' && canonicalizeLocalImagePath(attachment.path),
        )
        for (let index = 0; index < imageAttachments.length; index += 1) {
          add({
            id: `upload_${message.id}_${index + 1}`,
            path: imageAttachments[index].path,
            source: 'upload',
            groupId: `message:${message.id}`,
            index: index + 1,
            total: imageAttachments.length,
            messageId: message.id,
            createdAt: message.createdAt,
          })
        }
        if (imageAttachments.length === 0) {
          const legacyPaths = collectMessageImagePaths(message)
          for (let index = 0; index < legacyPaths.length; index += 1) {
            add({
              id: `legacy_${message.id}_${index + 1}`,
              path: legacyPaths[index],
              source: 'legacy',
              groupId: `message:${message.id}`,
              index: index + 1,
              total: legacyPaths.length,
              messageId: message.id,
              createdAt: message.createdAt,
            })
          }
        }
      } else if (!addedTaskArtifact) {
        const legacyPaths = collectMessageImagePaths(message)
        for (let index = 0; index < legacyPaths.length; index += 1) {
          add({
            id: `legacy_${message.id}_${index + 1}`,
            path: legacyPaths[index],
            source: 'legacy',
            groupId: `message:${message.id}`,
            index: index + 1,
            total: legacyPaths.length,
            messageId: message.id,
            createdAt: message.createdAt,
          })
        }
      }
    }
    return out.slice(-Math.max(1, Math.trunc(limit)))
  }, [])
  const contextUsageLastSentAtRef = useRef(0)
  const contextUsagePendingRef = useRef<ContextUsageSnapshot | null>(null)
  const contextUsageSendTimerRef = useRef<number | null>(null)
  const debugLogLastSentAtRef = useRef<Map<string, number>>(new Map())
  const [contextRetrieveAddon, setContextRetrieveAddon] = useState<string>('')
  const contextRetrieveAddonReqIdRef = useRef(0)

  const debugLog = useCallback(
    (event: string, data?: unknown) => {
      try {
        const key = String(event ?? '').trim()
        if (key === 'chat:task.blocks') {
          const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
          const isFinal = obj?.isFinal === true
          if (!isFinal) {
            const nowTs = Date.now()
            const last = debugLogLastSentAtRef.current.get(key) ?? 0
            if (nowTs - last < 250) return
            debugLogLastSentAtRef.current.set(key, nowTs)
          }
        }
        api?.appendDebugLog(event, data)
      } catch {
        // ignore
      }
    },
    [api],
  )

  const getActivePersonaId = useCallback((): string => {
    const pid = settingsRef.current?.activePersonaId
    return typeof pid === 'string' && pid.trim().length > 0 ? pid : 'default'
  }, [])

  const filterSessionsForPersona = useCallback(
    (all: ChatSessionSummary[]): ChatSessionSummary[] => all.filter((s) => s.personaId === getActivePersonaId()),
    [getActivePersonaId],
  )

  const autoExtractRunningRef = useRef<Record<string, boolean>>({})

  const runAutoExtractIfNeeded = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const settings = settingsRef.current
      const mem = settings?.memory
      if (!mem?.enabled) return
      if (!mem.autoExtractEnabled) return

      const updateSummary = (patch: Partial<ChatSessionSummary>) => {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)))
      }

      const formatAutoExtractError = (raw: string): { message: string; shouldAlert: boolean } => {
        const text = String(raw ?? '').trim()
        const lower = text.toLowerCase()
        const isContextTooLong =
          lower.includes('context_length') ||
          lower.includes('maximum context') ||
          (lower.includes('context') && lower.includes('length')) ||
          (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum')))

        if (!isContextTooLong) return { message: text || '自动提炼失败', shouldAlert: false }

        return {
          message: `上下文过长导致请求失败，可降低“提炼窗口”或右键“一键总结”。（原始错误：${text || 'unknown'}）`,
          shouldAlert: true,
        }
      }

      const every = clampIntValue(mem.autoExtractEveryEffectiveMessages, 20, 2, 2000)
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )
      const cooldownMs = clampIntValue(mem.autoExtractCooldownMs, 120000, 0, 3600000)

      if (autoExtractRunningRef.current[sessionId]) return
      autoExtractRunningRef.current[sessionId] = true

      let attemptAt = 0
      let effectiveCount = 0
      try {
        if (!settings?.ai) return

        const useCustomAi = !!mem.autoExtractUseCustomAi
        const base = settings.ai
        const extractAiSettings = useCustomAi
          ? {
              ...base,
              apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
              hasApiKey: mem.hasAutoExtractAiApiKey || base.hasApiKey,
              baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
              model: mem.autoExtractAiModel?.trim() || base.model,
              temperature:
                typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                  ? mem.autoExtractAiTemperature
                  : base.temperature,
              maxTokens:
                typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                  ? mem.autoExtractAiMaxTokens
                  : base.maxTokens,
            }
          : base

        const ai = new AIService(
          extractAiSettings,
          useCustomAi ? { kind: 'memory-auto-extract' } : { kind: 'main' },
        )

        const session = await api.getChatSession(sessionId)
        attemptAt = Date.now()
        const lastRunAt = clampIntValue(session.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
        if (cooldownMs > 0 && attemptAt - lastRunAt < cooldownMs) return
        const effective = collapseAssistantRuns(session.messages)
        effectiveCount = effective.length
        const cursor = clampIntValue(session.autoExtractCursor ?? 0, 0, 0, 1_000_000)
        const delta = effectiveCount - cursor
        if (delta < every) return
        if (effectiveCount < 4) return

        const tail = sliceTail(effective, maxEffective)
        const conversation = tail
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
          .join('\n\n')
          .trim()
        if (!conversation) return

        const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。

规则：
1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。
2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。
3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。
4) 如果没有值得记的内容，返回空数组 []。
5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。

输出格式：
[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]

说明：
- scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

        const res = await ai.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
        ])
        if (res.error) {
          const errUi = formatAutoExtractError(res.error)
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          if (errUi.shouldAlert) window.alert(errUi.message)
          return
        }

        const parseJsonArray = (text: string): unknown[] | null => {
          const cleaned = (text ?? '').trim()
          if (!cleaned) return null
          try {
            const parsed = JSON.parse(cleaned)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            const start = cleaned.indexOf('[')
            const end = cleaned.lastIndexOf(']')
            if (start < 0 || end < 0 || end <= start) return null
            const slice = cleaned.slice(start, end + 1)
            try {
              const parsed = JSON.parse(slice)
              return Array.isArray(parsed) ? parsed : null
            } catch {
              return null
            }
          }
        }

        const arr = parseJsonArray(res.content)
        if (!arr) {
          const lastError = '自动提炼失败：无法解析模型输出（不是 JSON 数组）'
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          return
        }

        const uniq = new Set<string>()
        const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue
          const obj = it as Record<string, unknown>
          const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
          const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
          const content = typeof obj.content === 'string' ? obj.content.trim() : ''
          if (!content) continue
          const normalized = content.replace(/\s+/g, ' ').trim()
          if (!normalized) continue
          if (normalized.length > 140) continue
          if (uniq.has(normalized)) continue
          uniq.add(normalized)
          items.push({ scope, content: normalized })
        }

        // 即使返回空数组，也推进游标，避免同一段对话被重复“空提炼”
        for (const it of items) {
          const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
            ? (consoleSettings.personaId || session.personaId || 'default')
            : (session.personaId || 'default')
          const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'
          const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
          await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
        }
        await api.setChatAutoExtractMeta(sessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
        updateSummary({
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[AutoExtract] Failed:', err)
        const errUi = formatAutoExtractError(msg)
        try {
          const nextLastRunAt = attemptAt || Date.now()
          await api.setChatAutoExtractMeta(sessionId, {
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
        } catch (_) {
          /* ignore */
        }
        if (errUi.shouldAlert) window.alert(errUi.message)
      } finally {
        autoExtractRunningRef.current[sessionId] = false
      }
    },
    [api],
  )

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const syncAsrComposePreview = useCallback(
    (baseText: string, opts?: { clearFinals?: boolean; force?: boolean }) => {
      if (!api) return
      const normalizedBase = String(baseText ?? '')
      const clearFinals = opts?.clearFinals === true
      const sig = `${clearFinals ? '1' : '0'}\n${normalizedBase}`
      if (!opts?.force && asrComposePreviewLastSigRef.current === sig) return
      asrComposePreviewLastSigRef.current = sig
      try {
        api.syncAsrComposePreview({ baseText: normalizedBase, ...(clearFinals ? { clearFinals: true } : {}) })
      } catch {
        /* ignore */
      }
    },
    [api],
  )

  const sendBubblePreview = useCallback(
    (
      payload: { text?: string; clear?: boolean; placeholder?: boolean; autoHideDelay?: number; pinPrevious?: boolean },
      opts?: { force?: boolean },
    ) => {
      if (!api) return
      const text = typeof payload.text === 'string' ? payload.text : ''
      const clear = payload.clear === true
      const placeholder = payload.placeholder === true
      const pinPrevious = payload.pinPrevious === true
      const autoHideDelay =
        typeof payload.autoHideDelay === 'number' && Number.isFinite(payload.autoHideDelay) ? Math.trunc(payload.autoHideDelay) : undefined
      const normalizedPayload = {
        ...(text ? { text } : {}),
        ...(clear ? { clear: true as const } : {}),
        ...(placeholder ? { placeholder: true as const } : {}),
        ...(pinPrevious ? { pinPrevious: true as const } : {}),
        ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
      }
      const sig = `${clear ? '1' : '0'}|${placeholder ? '1' : '0'}|${pinPrevious ? '1' : '0'}|${typeof autoHideDelay === 'number' ? autoHideDelay : ''}|${text}`
      if (!opts?.force && bubblePreviewLastSigRef.current === sig) return
      bubblePreviewLastSigRef.current = sig
      {
        const nowTs = Date.now()
        if (nowTs - bubblePreviewSendDebugAtRef.current >= 180) {
          bubblePreviewSendDebugAtRef.current = nowTs
          debugLog('chat:bubble.preview.send', {
            clear,
            placeholder,
            pinPrevious,
            len: text.length,
            head: text.slice(0, 32),
            tail: text.slice(-24),
          })
        }
      }
      try {
        api.sendBubblePreview(normalizedPayload)
      } catch {
        /* ignore */
      }
      // 兼容回退：即使主进程/预加载的 preview 通道未生效，也通过既有 bubble:message 通道发送预览事件。
      try {
        api.sendBubbleMessage(`${BUBBLE_PREVIEW_FALLBACK_PREFIX}${JSON.stringify(normalizedPayload)}`)
      } catch {
        /* ignore */
      }
    },
    [api, debugLog],
  )

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    if (!api) return

    const unsubSegmentStarted = api.onTtsSegmentStarted((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (!meta) return

      const idx = clampIntValue(payload.segmentIndex, -1, 0, 1_000_000)
      if (idx < 0) return

      meta.displayedSegments = Math.max(meta.displayedSegments, idx + 1)

      if (idx === 0) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
      }

      setTtsRevealedSegments((prev) => ({ ...prev, [meta.messageId]: meta.displayedSegments }))
    })

    const unsubUtteranceFailed = api.onTtsUtteranceFailed((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
        setTtsRevealedSegments((prev) => {
          const next = { ...prev }
          delete next[meta.messageId]
          return next
        })
        delete ttsUtteranceMetaRef.current[payload.utteranceId]
      }
      setError(payload.error)
    })

    const unsubUtteranceEnded = api.onTtsUtteranceEnded((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      delete ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        setTtsPendingUtteranceId((prev) => (prev === payload.utteranceId ? null : prev))
        setTtsRevealedSegments((prev) => {
          const next = { ...prev }
          delete next[meta.messageId]
          return next
        })
      }
      const sessionId = meta?.sessionId
      if (sessionId) {
        void runAutoExtractIfNeeded(sessionId)
      }
    })

    return () => {
      unsubSegmentStarted()
      unsubUtteranceFailed()
      unsubUtteranceEnded()
    }
  }, [api, currentSessionId, debugLog, runAutoExtractIfNeeded])

  // Load settings
  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  useEffect(() => {
    if (!api) return
    const pid = settings?.activePersonaId?.trim() || 'default'
    api
      .getPersona(pid)
      .then((p) => setCurrentPersona(p))
      .catch(() => setCurrentPersona(null))
  }, [api, settings?.activePersonaId])

  // Load sessions and current messages
  useEffect(() => {
    if (!api) return

    let cancelled = false
    ;(async () => {
      const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
      if (cancelled) return

      const filtered = filterSessionsForPersona(allSessions)
      setSessions(filtered)

      // 当前会话可能属于其它人设：自动切到本人人设的最新会话（或创建一个）
      let nextSessionId =
        filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null)

      if (!nextSessionId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextSessionId = created.id
      } else if (nextSessionId !== currentSessionId) {
        await api.setCurrentChatSession(nextSessionId)
      }

      const session = await api.getChatSession(nextSessionId ?? undefined)
      if (cancelled) return
      // 同步设置会话 id 与消息，避免“id 已切换但消息尚未加载”导致首条发送上下文缺失。
      setCurrentSessionId(nextSessionId)
      setMessages(session.messages)
    })().catch((err) => console.error(err))

    return () => {
      cancelled = true
    }
  }, [api, filterSessionsForPersona, getActivePersonaId, settings?.activePersonaId])

  // Initialize AI service and set model info when settings change
  useEffect(() => {
    if (!settings?.ai) return
    getAIService(settings.ai)

    // Load model metadata and set to AI service
    const modelFile = settings.live2dModelFile
    if (modelFile) {
      parseModelMetadata(modelFile).then((metadata) => {
        const expressions = metadata.expressions?.map((e) => e.name) || []
        const motions = metadata.motionGroups?.map((g) => g.name) || []
        toolAnimRef.current = { motionGroups: motions, expressions }
        setModelInfoToAIService(expressions, motions)
      })
    } else {
      toolAnimRef.current = { motionGroups: [], expressions: [] }
    }
  }, [settings?.ai, settings?.live2dModelFile])

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, ttsRevealedSegments])

  const reloadCurrentSessionMessages = useCallback(async () => {
    if (!api || !currentSessionId) return
    if (isLoadingRef.current) return

    // 有进行中的任务（尤其是 agent.run 流式）时，避免用持久化 session 覆盖 UI，防止“点一下文本就没了只剩工具标签”。
    const hasActiveTask = (() => {
      const ids: string[] = []
      for (const [tid, sid] of taskOriginSessionRef.current.entries()) {
        if (sid === currentSessionId) ids.push(tid)
      }
      if (ids.length === 0) return false
      const list = tasksRef.current
      return ids.some((tid) => {
        const t = list.find((x) => x.id === tid) ?? null
        const st = String(t?.status ?? '').trim()
        return st === 'pending' || st === 'running' || st === 'paused'
      })
    })()
    if (hasActiveTask) return

    const session = await api.getChatSession(currentSessionId).catch(() => null)
    if (!session) return
    setMessages(session.messages)
  }, [api, currentSessionId])

  // 隐藏窗口后台 autoSend 后，首次打开聊天窗可能出现 UI state 未刷新（只看到 assistant、缺 user）的情况。
  // 这里在窗口变为可见/获得焦点时，主动从持久化 session 拉一次消息，保证 UI 与存储一致。
  useEffect(() => {
    let inflight = false
    const onShow = () => {
      if (document.visibilityState !== 'visible') return
      if (inflight) return
      inflight = true
      void reloadCurrentSessionMessages().finally(() => {
        inflight = false
      })
    }
    window.addEventListener('focus', onShow)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      window.removeEventListener('focus', onShow)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [reloadCurrentSessionMessages])

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )

  // 消息列表渲染热点：把 tasks 做成 id 索引，O(n×m) 扫描降为 O(1) 查表
  const tasksById = useMemo(
    () => new Map<string, TaskRecord>(tasks.map((t) => [t.id, t])),
    [tasks],
  )

  const currentActiveChatTaskIds = useMemo(() => {
    if (!currentSessionId) return []

    const isActive = (t: TaskRecord | undefined): boolean =>
      !t || t.status === 'pending' || t.status === 'running' || t.status === 'paused'
    const ids = new Set<string>()
    for (const m of messages) {
      const taskId = typeof m.taskId === 'string' ? m.taskId.trim() : ''
      if (taskId && tasksById.has(taskId) && isActive(tasksById.get(taskId))) ids.add(taskId)
    }
    for (const [taskId, sessionId] of taskOriginSessionRef.current.entries()) {
      if (sessionId === currentSessionId && isActive(tasksById.get(taskId))) ids.add(taskId)
    }
    return [...ids]
  }, [currentSessionId, messages, tasksById])

  // messages.map 外层预计算的稳定值，避免每条消息每次 render 都重复走 optional chain
  const chatProfile = settings?.chatProfile
  const userAvatar = chatProfile?.userAvatar
  const assistantAvatar = chatProfile?.assistantAvatar
  const ttsSegmentedUi = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)

  useEffect(() => {
    plannerPendingRef.current = false
  }, [currentSessionId])

  const memEnabled = settings?.memory?.enabled ?? true
  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const captureEnabled = currentPersona?.captureEnabled ?? true
  const retrieveEnabled = currentPersona?.retrieveEnabled ?? true
  const activePersonaIdForPrompt = settings?.activePersonaId?.trim() || 'default'
  const currentPersonaMatchesActive = String(currentPersona?.id ?? '').trim() === activePersonaIdForPrompt
  const currentPersonaPrompt = currentPersonaMatchesActive ? String(currentPersona?.prompt ?? '').trim() : ''
  const personaSystemAddon = useMemo(() => {
    if (!currentPersonaPrompt) return ''
    const personaName = String(currentPersona?.name ?? '').trim() || '当前角色'
    return [
      `【当前 Persona：${personaName}】`,
      currentPersonaPrompt,
      '始终以这个当前 Persona 的身份、关系和语气回复；若全局提示里残留旧角色名称或冲突设定，以当前 Persona 为准。视觉模型只提供客观观察，不得取代当前 Persona。',
    ].join('\n')
  }, [currentPersona?.name, currentPersonaPrompt])
  const removeDuplicatedPersonaFromMemoryAddon = useCallback(
    (addon: string): string => {
      const text = String(addon ?? '').trim()
      if (!text || !currentPersonaPrompt) return text
      const legacyBlock = `【当前人设】\n${currentPersonaPrompt}`
      return text.replace(legacyBlock, '').replace(/^\s+|\s+$/g, '')
    },
    [currentPersonaPrompt],
  )
  const plannerEnabled = settings?.orchestrator?.plannerEnabled ?? false
  const plannerMode = settings?.orchestrator?.plannerMode ?? 'auto'
  const toolCallingEnabled = settings?.orchestrator?.toolCallingEnabled ?? false
  const toolCallingMode = settings?.orchestrator?.toolCallingMode ?? 'auto'

  const effectiveCountUi = useMemo(() => collapseAssistantRuns(messages).length, [messages])
  const cursorUi = clampIntValue(currentSession?.autoExtractCursor ?? 0, 0, 0, 1_000_000)
  const everyUi = clampIntValue(settings?.memory?.autoExtractEveryEffectiveMessages, 20, 2, 2000)
  const deltaUi = Math.max(0, effectiveCountUi - cursorUi)
  const remainingUi = memEnabled && autoExtractEnabled ? Math.max(0, everyUi - deltaUi) : 0

  const lastRunAtUi = clampIntValue(currentSession?.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
  const lastWriteCountUi = clampIntValue(currentSession?.autoExtractLastWriteCount ?? 0, 0, 0, 1_000_000)
  const lastErrorUi = (currentSession?.autoExtractLastError ?? '').trim()
  const lastErrorPreviewUi = lastErrorUi.length > 120 ? `${lastErrorUi.slice(0, 120)}…` : lastErrorUi

  const retrieveUi = useMemo(() => {
    if (!memEnabled || !retrieveEnabled) return { text: '-', title: '召回已关闭' }
    if (!lastRetrieveDebug) return { text: '-', title: '尚无召回记录（请先发送一条消息触发检索）' }

    const mapLayer = (l: NonNullable<MemoryRetrieveResult['debug']>['layers'][number]) => {
      if (l === 'timeRange') return 'TIME'
      if (l === 'fts') return 'FTS'
      if (l === 'like') return 'LIKE'
      if (l === 'tag') return 'TAG'
      if (l === 'kg') return 'KG'
      if (l === 'vector') return 'VEC'
      return 'NONE'
    }

    const layers = (lastRetrieveDebug.layers ?? []).map(mapLayer).join('+') || '-'
    const c = lastRetrieveDebug.counts
    const titleParts: string[] = []
    titleParts.push(`层级：${layers}`)
    titleParts.push(
      `命中：TIME=${c?.timeRange ?? 0} FTS=${c?.fts ?? 0} LIKE=${c?.like ?? 0} TAG=${c?.tag ?? 0} KG=${c?.kg ?? 0} VEC=${c?.vector ?? 0}`,
    )
    if (lastRetrieveDebug.tag) {
      titleParts.push(
        `Tag：query=${lastRetrieveDebug.tag.queryTags} matched=${lastRetrieveDebug.tag.matchedTags} expanded=${lastRetrieveDebug.tag.expandedTags}`,
      )
    }
    if (lastRetrieveDebug.vector) {
      const v = lastRetrieveDebug.vector
      const extra = [
        `enabled=${v.enabled ? '1' : '0'}`,
        `attempted=${v.attempted ? '1' : '0'}`,
        v.reason ? `reason=${v.reason}` : '',
        v.error ? `error=${v.error}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      titleParts.push(`向量：${extra}`)
    }
    titleParts.push(`耗时：${lastRetrieveDebug.tookMs}ms`)
    return { text: layers, title: titleParts.join('\n') }
  }, [lastRetrieveDebug, memEnabled, retrieveEnabled])

  const visionUi = useMemo(() => {
    const line = (lastVisionDebug ?? '').trim()
    if (!line) return { text: '-', title: '本轮没有调用视觉；近期图片只登记为目录，不会自动发送给模型。' }
    const count = line.match(/(\d+)\s*$/)?.[1]
    if (line.includes('主网络失败→外挂')) return { text: `外挂${count ? ` ${count}` : ''}`, title: line }
    if (line.includes('主模型不支持→外挂')) return { text: `外挂${count ? ` ${count}` : ''}`, title: line }
    if (line.includes('外挂失败')) return { text: '失败', title: line }
    if (line.includes('外挂')) return { text: `外挂${count ? ` ${count}` : ''}`, title: line }
    if (line.includes('主模型明确不支持') || line.includes('不支持或未配置')) return { text: '不支持', title: line }
    if (line.includes('图片失效') || line.includes('读取失败')) return { text: '失效', title: line }
    if (line.includes('主模型')) return { text: `主${count ? ` ${count}` : ''}`, title: line }
    return { text: '有', title: line }
  }, [lastVisionDebug])

  const toggleCaptureEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { captureEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleRetrieveEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { retrieveEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleAutoExtractEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setMemorySettings({ autoExtractEnabled: enabled })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleTaskPlannerEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        // "工具"总开关：关闭时强制同时关闭 ToolAgent，避免 UI 关闭后仍在后台走 agent.run
        await api.setOrchestratorSettings(enabled ? { plannerEnabled: true } : { plannerEnabled: false, toolCallingEnabled: false })
        if (!enabled) plannerPendingRef.current = false
        // 切换工具开关时清空 lastApiUsage，让 token 统计立即反映新的上下文
        setLastApiUsage(null)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const setTaskPlannerMode = useCallback(
    async (mode: 'auto' | 'always') => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ plannerMode: mode })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleToolCallingEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ toolCallingEnabled: enabled })
        // 切换工具开关时清空 lastApiUsage，让 token 统计立即反映新的上下文（有/无工具定义）
        setLastApiUsage(null)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const setToolCallingMode = useCallback(
    async (mode: 'auto' | 'native' | 'text') => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ toolCallingMode: mode })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const newMessageId = useCallback(() => {
    if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  // 将任务的“人话回复”同步回对应会话（仅对 planner 创建的任务生效）
  useEffect(() => {
    if (!api) return

    api
      .listTasks()
      .then((res) => setTasks(res.items ?? []))
      .catch(() => undefined)

    const off = api.onTasksChanged((payload) => {
      const items = payload.items ?? []
      setTasks(items)
      for (const t of items) {
        const sessionId = taskOriginSessionRef.current.get(t.id)
        const messageId = taskOriginMessageRef.current.get(t.id)
        if (!sessionId || !messageId) continue

        // 从 agent.run 运行日志（step.output）里提取图片注入结果，作为“真的看到图/没看到图”的可观测证据。
        // 注意任务完成时 step.output 会被最终回复覆盖，因此在运行期间捕获一次并保留。
        {
          const steps = Array.isArray(t.steps) ? t.steps : []
          for (const s of steps) {
            const out = String((s as { output?: unknown })?.output ?? '')
            if (!out) continue
            const visionHits = out.match(/^\[Vision\][^\n]*/gm) ?? []
            const line = visionHits[visionHits.length - 1]
            if (line) {
              setLastVisionDebug(line)
              break
            }
          }
        }

        // 将关键工具输出“摘要化”后注入到下次对话上下文，避免模型看不见 tool 卡片导致乱填参数。
        // 注意：这里只记录可复用的事实（路径/URL/ID/统计），不记录长文本与隐私内容。
        const toolRuns = Array.isArray(t.toolRuns) ? t.toolRuns : []
        for (const r of toolRuns) {
          const runId = typeof r?.id === 'string' ? r.id : ''
          if (!runId) continue
          const status = (r as { status?: unknown }).status
          if (status !== 'done' && status !== 'error') continue
          const sig = `${t.id}:${runId}:${String(status)}:${String((r as { endedAt?: unknown }).endedAt ?? '')}`
          if (toolFactsSeenRef.current.has(sig)) continue
          toolFactsSeenRef.current.add(sig)

          const toolName = typeof (r as { toolName?: unknown }).toolName === 'string' ? String((r as { toolName: string }).toolName) : ''
          const rawOut = typeof (r as { outputPreview?: unknown }).outputPreview === 'string' ? String((r as { outputPreview: string }).outputPreview) : ''
          const rawErr = typeof (r as { error?: unknown }).error === 'string' ? String((r as { error: string }).error) : ''
          const endedAt = typeof (r as { endedAt?: unknown }).endedAt === 'number' ? ((r as { endedAt: number }).endedAt as number) : Date.now()

          const parseJsonFromText = (raw: string): Record<string, unknown> | null => {
            const text = String(raw ?? '').trim()
            if (!text) return null
            const first = text.indexOf('{')
            const last = text.lastIndexOf('}')
            if (first < 0 || last <= first) return null
            try {
              return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
            } catch {
              return null
            }
          }

          const lines: string[] = []

          if (TASK_TOOL_VISION_NAMES.has(toolName)) {
            const imageCount = Array.isArray((r as { imagePaths?: unknown }).imagePaths)
              ? (r as { imagePaths: unknown[] }).imagePaths.length
              : 0
            for (let index = 0; index < imageCount; index += 1) {
              lines.push(`- ${toolName}: artifactId=vis_${t.id}_${runId}_${index + 1}`)
            }
          }

          if (toolName.startsWith('mcp.mmvector.') && rawOut) {
            const parsed = parseJsonFromText(rawOut)
            const results = parsed && parsed.ok === true && Array.isArray(parsed.results) ? (parsed.results as unknown[]) : []
            const media = results
              .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null))
              .filter(Boolean)
              .map((x) => ({
                type: typeof x!.type === 'string' ? String(x!.type).trim() : '',
                score: typeof x!.score === 'number' && Number.isFinite(x!.score) ? (x!.score as number) : null,
                filename: typeof x!.filename === 'string' ? String(x!.filename).trim() : '',
                imagePath: typeof x!.imagePath === 'string' ? String(x!.imagePath).trim() : '',
                videoPath: typeof x!.videoPath === 'string' ? String(x!.videoPath).trim() : '',
                videoUrl: typeof x!.videoUrl === 'string' ? String(x!.videoUrl).trim() : '',
              }))
              .filter((x) => x.imagePath || x.videoPath || x.videoUrl)

            for (const it of media.slice(0, 6)) {
              const scoreText = it.score != null ? ` score=${it.score.toFixed(4)}` : ''
              if (it.type === 'video') {
                const parts = [
                  `mmvector.video:${scoreText}`,
                  it.filename ? ` filename=${it.filename}` : '',
                  it.videoPath ? ` videoPath=${it.videoPath}` : '',
                  it.videoUrl ? ` videoUrl=${it.videoUrl}` : '',
                ].filter(Boolean)
                lines.push(`- ${parts.join('')}`)
              } else {
                const parts = [
                  `mmvector.image:${scoreText}`,
                  it.filename ? ` filename=${it.filename}` : '',
                  it.imagePath ? ` imagePath=${it.imagePath}` : '',
                ].filter(Boolean)
                lines.push(`- ${parts.join('')}`)
              }
            }
          }

          if (toolName === 'media.video_qa' && rawOut) {
            const parsed = parseJsonFromText(rawOut)
            const ok = parsed?.ok === true
            const videoPath = ok && typeof parsed?.videoPath === 'string' ? String(parsed.videoPath).trim() : ''
            const q = ok && typeof parsed?.question === 'string' ? String(parsed.question).trim() : ''
            if (videoPath) lines.push(`- video_qa: videoPath=${videoPath}${q ? ` question=${q}` : ''}`)
          }

          if (lines.length === 0 && rawErr && toolName) {
            // 兜底：把关键错误也记录一条，便于模型后续避免重复踩坑
            lines.push(`- ${toolName}: error=${rawErr.slice(0, 180)}`)
          }

          if (lines.length > 0) addSessionToolFacts(sessionId, lines, endedAt)
        }

        const isFinal = t.status === 'done' || t.status === 'failed' || t.status === 'canceled'

        const finalizeCtx = taskFinalizeContextRef.current.get(t.id) ?? null
        if (finalizeCtx) {
          if (!isFinal) continue
          if (t.status === 'canceled') {
            taskFinalizeContextRef.current.delete(t.id)
            taskFinalizingRef.current.delete(t.id)
            taskOriginSessionRef.current.delete(t.id)
            taskOriginMessageRef.current.delete(t.id)
            taskOriginBlocksRef.current.delete(t.id)
            taskToolUseSplitRef.current.delete(t.id)
            taskBubblePreviewProgressRef.current.delete(t.id)
            sendBubblePreview({ clear: true }, { force: true })
            continue
          }
          if (taskFinalizingRef.current.has(t.id)) continue
          taskFinalizingRef.current.add(t.id)

          let finalizeAbort: AbortController | null = null
          let finalizeAbortExposed = false

          void (async () => {
            const loadFinalizeBaseBlocks = async (): Promise<ChatMessageBlock[]> => {
              const fromRef = normalizeMessageBlocks({ blocks: taskOriginBlocksRef.current.get(t.id) ?? [] } as ChatMessageRecord)
              try {
                const session = await api.getChatSession(sessionId)
                const msg = (session.messages ?? []).find((m) => m.id === messageId) ?? null
                if (!msg) return fromRef
                const fromStore = normalizeMessageBlocks(msg)
                return pickRicherToolBlocks(fromRef, fromStore)
              } catch {
                return fromRef
              }
            }

            const baseBlocks = await loadFinalizeBaseBlocks()
            const imagePatch = taskImagePatch(t)
            debugLog('chat:finalize.start', {
              taskId: t.id,
              sessionId,
              messageId,
              status: t.status,
              baseBlocks: baseBlocks.map((b) =>
                b.type === 'tool_use' ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId } : { type: b.type },
              ),
            })
            const aiService = getAIService()
            if (!aiService) {
              const errText = '[错误] AI 服务未初始化'
              const nextBlocks = baseBlocks.map((b) => ({ ...b }))
              const lastTextIdx = (() => {
                for (let i = nextBlocks.length - 1; i >= 0; i -= 1) {
                  if (nextBlocks[i].type === 'text') return i
                }
                return -1
              })()
              if (lastTextIdx >= 0) nextBlocks[lastTextIdx] = { type: 'text', text: errText }
              else nextBlocks.push({ type: 'text', text: errText })
              const nextContent = joinTextBlocks(nextBlocks)

              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: nextContent, blocks: nextBlocks } : m)),
                )
              }
              await api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: nextContent, blocks: nextBlocks }).catch(() => undefined)
              return
            }

            const buildBlocksWithFinal = (finalText: string): ChatMessageBlock[] => {
              const copied = Array.isArray(baseBlocks) ? baseBlocks.map((b) => ({ ...b })) : []
              const lastTextIdx = (() => {
                for (let i = copied.length - 1; i >= 0; i -= 1) {
                  if (copied[i].type === 'text') return i
                }
                return -1
              })()
              if (lastTextIdx >= 0) copied[lastTextIdx] = { type: 'text', text: finalText }
              else copied.push({ type: 'text', text: finalText })
              return copied
            }

            const toolAddon = buildToolResultSystemAddon(t)
            const mergedAddon = [finalizeCtx.systemAddon, toolAddon].filter(Boolean).join('\n\n')
            const finalInstruction =
              '工具已经执行完毕。请基于工具执行结果继续完成刚才的请求：只输出最终自然语言回复，不要重复前置话术。'

            const prompt: ChatMessage[] = [
              ...finalizeCtx.chatHistory,
              {
                role: 'user',
                content: finalInstruction,
              },
            ]

            finalizeAbort = new AbortController()
            finalizeAbortExposed = sessionId === currentSessionId
            const finalizeStopSeq = chatStopSeqRef.current
            const isFinalizeStopped = () => finalizeAbort?.signal.aborted === true || chatStopSeqRef.current !== finalizeStopSeq
            if (finalizeAbortExposed) {
              aiAbortRef.current = finalizeAbort
              isLoadingRef.current = true
              setIsLoading(true)
            }

            const previewProg = taskBubblePreviewProgressRef.current.get(t.id)
            const elapsedSincePreface = previewProg?.lastShownAt ? Date.now() - previewProg.lastShownAt : Number.POSITIVE_INFINITY
            const prefaceMinVisibleMs = 220
            if (elapsedSincePreface < prefaceMinVisibleMs) {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, prefaceMinVisibleMs - elapsedSincePreface)
              })
            }
            if (isFinalizeStopped()) return

            // 任务完成后的“二段回复”需要开启一个全新的气泡（前置话术气泡先结束，再显示新的思考/流式气泡）。
            sendBubblePreview({ clear: true }, { force: true })
            sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })

            const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false

            if (enableChatStreaming) {
              const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)
              const ttsUtteranceId = ttsSegmented ? `taskfinal-${messageId}-${Date.now().toString(36)}` : null
              let ttsSentSegments = 0

              let acc = ''
              let pending = ''
              let lastExpression: string | undefined
              let lastMotion: string | undefined

              const enqueueStableTts = (displayFinal: string, forceAll: boolean) => {
                if (!ttsUtteranceId) return
                const segs = splitTextIntoTtsSegments(displayFinal, { lang: 'zh', textSplitMethod: 'cut5' })
                const stableCount = countStableTtsSegments(displayFinal, segs, forceAll)
                if (stableCount <= ttsSentSegments) return
                const nextSegs = segs.slice(ttsSentSegments, stableCount)
                if (nextSegs.length === 0) return
                api.enqueueTtsUtterance({
                  utteranceId: ttsUtteranceId,
                  mode: ttsSentSegments === 0 ? 'replace' : 'append',
                  segments: nextSegs,
                  fullText: undefined,
                })
                ttsSentSegments = stableCount
              }

              const flush = () => {
                if (isFinalizeStopped()) {
                  pending = ''
                  return
                }
                if (!pending) return
                const appended = pending
                acc += pending
                pending = ''

                const displayFinal = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc))
                if (displayFinal.trim()) sendBubblePreview({ text: displayFinal, autoHideDelay: 0 })
                const nextBlocks = buildBlocksWithFinal(displayFinal)
                const nextContent = joinTextBlocks(nextBlocks)

                if (sessionId === currentSessionId) {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: nextContent, blocks: nextBlocks } : m)),
                  )
                }

                enqueueStableTts(displayFinal, false)

                const tags = extractTailLive2DTags(acc, appended.length)
                if (tags.expression && tags.expression !== lastExpression) {
                  lastExpression = tags.expression
                  api.triggerExpression(tags.expression)
                }
                if (tags.motion && tags.motion !== lastMotion) {
                  lastMotion = tags.motion
                  api.triggerMotion(tags.motion, 0)
                }
              }

              const flushThrottle = createStreamFlushThrottle(flush)

              const response = await aiService.chatStream(prompt, {
                systemAddon: mergedAddon,
                signal: finalizeAbort.signal,
                onDelta: (delta) => {
                  if (isFinalizeStopped()) return
                  pending += delta
                  flushThrottle.schedule()
                },
              })

              flushThrottle.finalize()
              if (isFinalizeStopped()) {
                sendBubblePreview({ clear: true }, { force: true })
                return
              }

              if (response.error) {
                sendBubblePreview({ clear: true }, { force: true })
                const nextText =
                  response.error === ABORTED_ERROR
                    ? normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc, { trim: true }))
                    : `[错误] ${response.error}`
                const nextBlocks = buildBlocksWithFinal(nextText)
                const nextContent = joinTextBlocks(nextBlocks)
                if (sessionId === currentSessionId) {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: nextContent, blocks: nextBlocks } : m)),
                  )
                }
                await api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: nextContent, blocks: nextBlocks }).catch(() => undefined)
                return
              }

              const finalText = normalizeInterleavedTextSegment(normalizeAssistantDisplayText(acc, { trim: true }))
              if (finalText.trim()) sendBubblePreview({ text: finalText, autoHideDelay: 0 })
              enqueueStableTts(finalText, true)
              if (ttsUtteranceId) {
                api.finalizeTtsUtterance(ttsUtteranceId)
              }
              const finalBlocks = buildBlocksWithFinal(finalText)
              const finalContent = joinTextBlocks(finalBlocks)
              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: finalContent, blocks: finalBlocks } : m)),
                )
                if (finalText && !ttsUtteranceId) api.sendBubbleMessage(finalText)
              }

              debugLog('chat:finalize.done', {
                taskId: t.id,
                sessionId,
                messageId,
                finalLen: finalText.length,
                finalBlocks: finalBlocks.map((b) =>
                  b.type === 'tool_use' ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId } : { type: b.type },
                ),
              })
              await api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: finalContent, blocks: finalBlocks }).catch(() => undefined)
              void runAutoExtractIfNeeded(sessionId)
              return
            }

            const response = await aiService.chat(prompt, { systemAddon: mergedAddon, signal: finalizeAbort.signal })
            if (isFinalizeStopped()) {
              sendBubblePreview({ clear: true }, { force: true })
              return
            }
            if (response.error) {
              sendBubblePreview({ clear: true }, { force: true })
              const nextText = response.error === ABORTED_ERROR ? '' : `[错误] ${response.error}`
              const nextBlocks = buildBlocksWithFinal(nextText)
              const nextContent = joinTextBlocks(nextBlocks)
              if (sessionId === currentSessionId) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: nextContent, blocks: nextBlocks } : m)),
                )
              }
              await api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: nextContent, blocks: nextBlocks }).catch(() => undefined)
              return
            }

            const { displayText, expression, motion } = extractLive2DTags(response.content)
            if (displayText.trim()) sendBubblePreview({ text: displayText, autoHideDelay: 0 })
            const finalBlocks = buildBlocksWithFinal(displayText)
            const finalContent = joinTextBlocks(finalBlocks)

            if (sessionId === currentSessionId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: finalContent, blocks: finalBlocks } : m)),
              )
              if (displayText) api.sendBubbleMessage(displayText)
              if (expression) api.triggerExpression(expression)
              if (motion) api.triggerMotion(motion, 0)
            }

            await api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: finalContent, blocks: finalBlocks }).catch(() => undefined)
            void runAutoExtractIfNeeded(sessionId)
          })()
            .catch((err) => console.error('[TaskFinalize] failed:', err))
            .finally(() => {
              taskFinalizingRef.current.delete(t.id)
              taskFinalizeContextRef.current.delete(t.id)
              taskOriginSessionRef.current.delete(t.id)
              taskOriginMessageRef.current.delete(t.id)
              taskOriginBlocksRef.current.delete(t.id)
              taskToolUseSplitRef.current.delete(t.id)
              taskBubblePreviewProgressRef.current.delete(t.id)
              if (finalizeAbortExposed && aiAbortRef.current === finalizeAbort) {
                aiAbortRef.current = null
                isLoadingRef.current = false
                setIsLoading(false)
              }
            })

          continue
        }

        // 兼容旧链路（agent.run 等）：直接使用任务 finalReply/draftReply 回填
        const rawText = (() => {
          const fallback = String((isFinal ? (t.finalReply ?? t.draftReply ?? t.lastError) : (t.draftReply ?? t.lastError ?? t.finalReply)) ?? '')
          if (t.status !== 'failed') return fallback

          const baseText = String((isFinal ? (t.finalReply ?? t.draftReply) : (t.draftReply ?? t.finalReply)) ?? '').trim()
          const lastError = String(t.lastError ?? '').trim()
          if (!lastError) return baseText || fallback
          if (!baseText) return `[错误] ${lastError}`
          return baseText.includes(lastError) ? baseText : `${baseText}\n\n[错误] ${lastError}`
        })()
        const { displayText: displayTextRaw, expression, motion } = extractLive2DTags(rawText)
        const displayText = normalizeInterleavedTextSegment(displayTextRaw)

        // agent.run 壳 run 只是任务外壳，不是用户可感知的工具调用（兜旧存档/旧主进程写入的脏数据）
        const runs = filterVisibleToolRuns(Array.isArray(t.toolRuns) ? t.toolRuns : [])
        const runIdsNow = runs.map((r) => String(r.id ?? '').trim()).filter(Boolean)

        let split = taskToolUseSplitRef.current.get(t.id) ?? { runIds: [], segments: [''], lastDisplay: '' }

        const knownIdsNow = new Set(runIdsNow)
        const hasOrphan = split.runIds.some((id) => !knownIdsNow.has(id)) || split.segments.length !== split.runIds.length + 1
        if (hasOrphan) {
          split = { runIds: [], segments: [''], lastDisplay: '' }
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        } else {
          split = { runIds: [...split.runIds], segments: [...split.segments], lastDisplay: String(split.lastDisplay ?? '') }
        }

        // 工具卡片不延迟：一旦发现新 toolRun，就立即插入到 turn 的 blocks 里（否则会出现“最后一刻工具卡才冒出来”的割裂感）。
        const prevRunIds = split.runIds
        const isPrefix = prevRunIds.every((id, i) => runIdsNow[i] === id)
        if (!isPrefix) {
          // 极少数情况：runId 顺序变化或被重置（例如任务重跑/存档异常），此时重置分块边界。
          split = {
            runIds: [...runIdsNow],
            segments: new Array(runIdsNow.length + 1).fill(''),
            lastDisplay: split.lastDisplay,
          }
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        } else if (runIdsNow.length > prevRunIds.length) {
          for (let i = prevRunIds.length; i < runIdsNow.length; i += 1) {
            split.runIds.push(runIdsNow[i])
            // 冻结当前文本段，新增一个“工具后的新段落”
            if (split.segments.length < split.runIds.length) split.segments.push('')
            split.segments.push('')
          }
        }

        {
          const frozenPrefix = split.segments.slice(0, Math.max(0, split.segments.length - 1)).join('')
          const tail = frozenPrefix && displayText.startsWith(frozenPrefix) ? displayText.slice(frozenPrefix.length) : displayText
          const lastIdx = Math.max(0, split.segments.length - 1)
          const prevTail = String(split.segments[lastIdx] ?? '')
          if (tail.startsWith(prevTail)) split.segments[lastIdx] = tail
          else if (!prevTail || computeAppendDelta(prevTail, tail)) split.segments[lastIdx] = tail
          else split.segments[lastIdx] = tail
        }
        split.lastDisplay = displayText

        const hasAnyText = displayText.trim().length > 0
        const segsForBlocks = mergeLeadingPunctuationAcrossToolBoundary(split.segments, split.runIds)
        const nextBlocks: ChatMessageBlock[] = (() => {
          const blocks: ChatMessageBlock[] = []

          if (!hasAnyText && split.runIds.length > 0 && !isFinal) {
            blocks.push({ type: 'status', text: '正在调用工具…' })
          }

          for (let i = 0; i < split.runIds.length + 1; i += 1) {
            const seg = String(segsForBlocks[i] ?? '')
            const normalizedSeg = normalizeInterleavedTextSegment(seg)
            if (normalizedSeg.trim().length > 0) blocks.push({ type: 'text', text: normalizedSeg })
            if (i < split.runIds.length) blocks.push({ type: 'tool_use', taskId: t.id, runId: split.runIds[i] })
          }
          if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
          return blocks
        })()

        const nextContent = joinTextBlocks(nextBlocks)
        const imagePatch = taskImagePatch(t)
        taskOriginBlocksRef.current.set(t.id, nextBlocks)
        taskToolUseSplitRef.current.set(t.id, split)

        {
          const segLens = split.segments.map((s) => String(s ?? '').length).join(',')
          const sig = `${isFinal ? '1' : '0'}|${t.status}|${split.runIds.join(',')}|${segLens}|${displayText.length}|${nextBlocks
            .map((b) => (b.type === 'tool_use' ? `u:${String((b as { runId?: string }).runId ?? '')}` : b.type))
            .join(',')}`
          const prevSig = taskUiDebugSigRef.current.get(t.id) ?? ''
          if (sig !== prevSig) {
            taskUiDebugSigRef.current.set(t.id, sig)
            debugLog('chat:task.blocks', {
              taskId: t.id,
              status: t.status,
              isFinal,
              draftLen: displayText.length,
              runIds: split.runIds,
              segmentsLen: split.segments.map((s) => String(s ?? '').length),
              blocks: nextBlocks.slice(0, 40).map((b) =>
                b.type === 'tool_use'
                  ? { type: 'tool_use', taskId: b.taskId, runId: (b as { runId?: string }).runId }
                  : { type: b.type },
              ),
            })
          }
        }

        if (sessionId === currentSessionId) {
          setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...imagePatch, content: nextContent, blocks: nextBlocks } : m)))

          const frozenCount = split.runIds.length
          const previewPrev = taskBubblePreviewProgressRef.current.get(t.id) ?? { shownFrozen: 0, lastShownAt: 0, lastTailText: '' }
          const previewNext = { ...previewPrev }
          for (let i = previewNext.shownFrozen; i < frozenCount; i += 1) {
            const seg = normalizeInterleavedTextSegment(String(segsForBlocks[i] ?? ''))
            if (!seg.trim()) continue
            sendBubblePreview({ text: seg, autoHideDelay: 0 })
            previewNext.lastShownAt = Date.now()
          }
          previewNext.shownFrozen = Math.max(previewNext.shownFrozen, frozenCount)

          // agent.run 任务流（尤其“无工具卡”的场景）会持续通过 task.blocks 更新文本；
          // 这里把当前尾段实时同步到桌宠预览气泡，避免只停留在“思考中…”直到最终完成。
          if (!isFinal) {
            const tailIdx = Math.max(0, Math.min(segsForBlocks.length - 1, frozenCount))
            const tailText = normalizeInterleavedTextSegment(String(segsForBlocks[tailIdx] ?? ''))
            if (tailText.trim()) {
              if (tailText !== previewNext.lastTailText) {
                sendBubblePreview({ text: tailText, autoHideDelay: 0 })
                previewNext.lastShownAt = Date.now()
                previewNext.lastTailText = tailText
              }
            } else {
              previewNext.lastTailText = ''
            }
          } else {
            previewNext.lastTailText = ''
          }

          const previewHadVisibleText = previewNext.shownFrozen > 0 || previewPrev.lastTailText.trim().length > 0
          taskBubblePreviewProgressRef.current.set(t.id, previewNext)

          const tts = settingsRef.current?.tts
          const bubbleTtsEnabled = Boolean(tts?.enabled) && !(tts?.segmented ?? false)
          if (bubbleTtsEnabled) {
            const prev = taskBubbleTtsProgressRef.current.get(t.id) ?? { spokenFrozen: 0, spokeFinal: false }
            const nextProg = { ...prev }

            // 1) runId 增加时，前一段文本会被冻结；此时立刻播报该段（前置话术/工具间话术）
            const frozenCount = split.runIds.length
            for (let i = nextProg.spokenFrozen; i < frozenCount; i += 1) {
              const seg = normalizeInterleavedTextSegment(String(segsForBlocks[i] ?? ''))
              if (seg.trim()) api.sendBubbleMessage(seg)
            }
            nextProg.spokenFrozen = Math.max(nextProg.spokenFrozen, frozenCount)

            // 2) 任务结束时，只播报“最后一段”（工具后的最终回复），避免把前置话术重复念一遍
            if (isFinal && !nextProg.spokeFinal) {
              const lastSeg = normalizeInterleavedTextSegment(String(segsForBlocks[frozenCount] ?? ''))
              if (lastSeg.trim()) api.sendBubbleMessage(lastSeg)
              nextProg.spokeFinal = true
            }

            taskBubbleTtsProgressRef.current.set(t.id, nextProg)
          } else if (isFinal) {
            // 未开启普通 TTS（或启用分句模式）时：
            // - 若已经用预览流式展示过正文，则收尾时沿用“气泡自动隐藏”设置，不再重复打一遍完整气泡；
            // - 否则回退到旧行为（直接显示最终气泡）。
            const ttsEnabled = Boolean(tts?.enabled)
            if (!ttsEnabled && previewHadVisibleText) {
              const tailIdx = Math.max(0, Math.min(segsForBlocks.length - 1, frozenCount))
              const finalPreviewText = normalizeInterleavedTextSegment(String(segsForBlocks[tailIdx] ?? '')) || displayText
              const finalAutoHideDelay = Math.max(0, Math.min(60000, Math.floor(settingsRef.current?.bubble?.autoHideDelay ?? 5000)))
              if (finalPreviewText.trim()) {
                sendBubblePreview({ text: finalPreviewText, autoHideDelay: finalAutoHideDelay }, { force: true })
              } else {
                sendBubblePreview({ clear: true }, { force: true })
              }
            } else if (displayText) {
              api.sendBubbleMessage(displayText)
            }
          }

          if (isFinal) {
            if (expression) api.triggerExpression(expression)
            if (motion) api.triggerMotion(motion, 0)

            // 任务完成时，更新真实的 API usage 统计（用于上下文悬浮球）
            if (t.usage && t.usage.totalTokens > 0) {
              setLastApiUsage({
                promptTokens: t.usage.promptTokens,
                completionTokens: t.usage.completionTokens,
                totalTokens: t.usage.totalTokens,
              })
            }
          }
        }

        // 只在任务结束时落盘，避免频繁写入导致记忆/索引重复摄入
        if (isFinal) {
          api.updateChatMessageRecord(sessionId, messageId, { ...imagePatch, content: nextContent, blocks: nextBlocks }).catch(() => undefined)
          taskOriginSessionRef.current.delete(t.id)
          taskOriginMessageRef.current.delete(t.id)
          taskOriginBlocksRef.current.delete(t.id)
          taskToolUseSplitRef.current.delete(t.id)
          taskBubbleTtsProgressRef.current.delete(t.id)
          taskBubblePreviewProgressRef.current.delete(t.id)
        }
      }
    })

    return () => off()
  }, [
    addSessionToolFacts,
    api,
    buildVisionPartsFromImagePaths,
    currentSessionId,
    debugLog,
    runAutoExtractIfNeeded,
    sendBubblePreview,
  ])

  const closeOverlays = useCallback(() => {
    setContextMenu(null)
    setSessionContextMenu(null)
    setShowSessionList(false)
    setShowStatusDetails(false)
    setShowMoreMenu(false)
    setShowAttachmentMenu(false)
  }, [])

  const readAvatarFile = useCallback((file: File, onLoaded: (dataUrl: string) => void) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 2 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => onLoaded(String(reader.result || ''))
    reader.readAsDataURL(file)
  }, [])

  const newAttachmentId = useCallback(() => {
    if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  const addPendingAttachment = useCallback((att: Omit<PendingAttachment, 'id'>) => {
    setPendingAttachments((prev) => [...prev, { id: newAttachmentId(), ...att }])
  }, [newAttachmentId])

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const readChatImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) return
      if (file.size > 5 * 1024 * 1024) {
        setError('图片太大（>5MB），请压缩后再发送')
        return
      }

      const readAsDataUrl = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('read failed'))
          reader.onload = () => resolve(String(reader.result || ''))
          reader.readAsDataURL(file)
        })

      try {
        const dataUrl = await readAsDataUrl()
        setError(null)

        const saved = await api
          ?.saveChatAttachmentFile(file, 'image', file.name)
          .catch(() => api.saveChatAttachment({ kind: 'image', dataUrl, filename: file.name || 'clipboard.png' }))
        if (saved?.ok) {
          addPendingAttachment({
            kind: 'image',
            path: saved.path,
            resourceId: saved.resourceId,
            filename: saved.filename,
            previewDataUrl: dataUrl,
          })
        }
      } catch (err) {
        console.error('[chat] read/save image failed:', err)
        setError('读取/保存图片失败')
      }
    },
    [addPendingAttachment, api],
  )

  const readChatVideoFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/')) return
      try {
        setError(null)
        const saved = await api?.saveChatAttachmentFile(file, 'video', file.name)
        if (saved?.ok) {
          addPendingAttachment({
            kind: 'video',
            path: saved.path,
            resourceId: saved.resourceId,
            filename: saved.filename,
          })
        }
      } catch (err) {
        console.error('[chat] save video failed:', err)
        setError('保存视频失败')
      }
    },
    [addPendingAttachment, api],
  )

  const canUseVision = settings?.ai?.enableVision ?? false
  const canUseMainVision =
    canUseVision &&
    settings?.ai?.visionRoutingMode !== 'fallback-only' &&
    settings?.ai?.visionCapability !== 'unsupported'

  const chatOrbEnabled = settings?.chatUi?.contextOrbEnabled ?? false
  const chatOrbX = settings?.chatUi?.contextOrbX ?? 6
  const chatOrbY = settings?.chatUi?.contextOrbY ?? 14

  useEffect(() => {
    if (!api) return
    let disposed = false
    api
      .getMcpState()
      .then((snap) => {
        if (disposed) return
        setMcpSnapshotForContext(snap)
      })
      .catch(() => {
        /* ignore */
      })
    const off = api.onMcpChanged((snap) => {
      if (disposed) return
      setMcpSnapshotForContext(snap)
    })
    return () => {
      disposed = true
      off()
    }
  }, [api])

  const estimateTokensFromText = useCallback((text: string): number => {
    const cleaned = (text ?? '').trim()
    if (!cleaned) return 0
    return Math.max(1, Math.ceil(cleaned.length / 4))
  }, [])

  const estimateTokensForChatMessage = useCallback(
    (m: ChatMessage): number => {
      if (!m) return 0
      if (typeof m.content === 'string') return estimateTokensFromText(m.content)

      let total = 0
      for (const part of m.content) {
        if (part.type === 'text') total += estimateTokensFromText(part.text)
        else total += 800 // 图片大致占用（粗略估计）
      }
      return total
    },
    [estimateTokensFromText],
  )

  const toolDirectoryAddon = useMemo(() => {
    const defs = getBuiltinToolDefinitions()
    const lines: string[] = defs.map((d) => `- ${d.name}：${d.description}`)

    const servers = Array.isArray(mcpSnapshotForContext?.servers) ? mcpSnapshotForContext!.servers : []
    for (const s of servers) {
      const tools = Array.isArray(s.tools) ? s.tools : []
      for (const t of tools) {
        const toolName = typeof t?.toolName === 'string' ? t.toolName : ''
        if (!toolName) continue
        const desc =
          (typeof t?.description === 'string' && t.description.trim()) ||
          (typeof t?.title === 'string' && t.title.trim()) ||
          (typeof t?.name === 'string' && t.name.trim()) ||
          ''
        lines.push(`- ${toolName}：${desc || 'MCP tool'}`)
      }
    }

    const MAX_TOOL_LINES = 80
    const toolLines =
      lines.length > MAX_TOOL_LINES ? [...lines.slice(0, MAX_TOOL_LINES), `- ...（${lines.length - MAX_TOOL_LINES} 项已省略）`] : lines

    const toolSwitch = toolCallingEnabled ? `已启用（mode=${toolCallingMode}）` : '已关闭'
    const plannerSwitch = plannerEnabled ? `已启用（mode=${plannerMode}）` : '已关闭'

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
  }, [
    mcpSnapshotForContext,
    plannerEnabled,
    plannerMode,
    toolCallingEnabled,
    toolCallingMode,
  ])

  useEffect(() => {
    if (!api) return

    if (!memEnabled || !retrieveEnabled) {
      setContextRetrieveAddon('')
      return
    }

    const queryText = (input ?? '').trim()
    if (!queryText) {
      setContextRetrieveAddon('')
      return
    }

    const nowId = (contextRetrieveAddonReqIdRef.current += 1)
    const includeShared = settingsRef.current?.memory?.includeSharedOnRetrieve ?? true
    const personaId = getActivePersonaId()

    const timer = window.setTimeout(() => {
      void api
        .retrieveMemory({
          personaId,
          query: queryText,
          limit: 12,
          maxChars: 3200,
          includeShared,
          reinforce: false,
        })
        .then((res) => {
          if (contextRetrieveAddonReqIdRef.current !== nowId) return
          const addon = removeDuplicatedPersonaFromMemoryAddon(res.addon?.trim() ?? '')
          setContextRetrieveAddon(addon)
        })
        .catch(() => {
          if (contextRetrieveAddonReqIdRef.current !== nowId) return
          setContextRetrieveAddon('')
        })
    }, 800)

    return () => window.clearTimeout(timer)
  }, [api, getActivePersonaId, input, memEnabled, removeDuplicatedPersonaFromMemoryAddon, retrieveEnabled])

  const worldBookAddonForUsage = useMemo(() => {
    const activePersonaId = settings?.activePersonaId?.trim() || 'default'
    return buildWorldBookAddon(settings, activePersonaId)
  }, [settings])

  const systemAddonForUsage = useMemo(() => {
    const parts = [personaSystemAddon.trim(), contextRetrieveAddon.trim(), worldBookAddonForUsage.trim(), toolDirectoryAddon.trim()].filter(Boolean)
    return parts.join('\n\n')
  }, [contextRetrieveAddon, personaSystemAddon, toolDirectoryAddon, worldBookAddonForUsage])

  const trimChatHistoryToMaxContext = useCallback(
    (history: ChatMessage[], systemAddon: string): { history: ChatMessage[]; trimmedCount: number } => {
      const ai = settingsRef.current?.ai
      const maxContextTokensRaw = ai?.maxContextTokens ?? 128000
      const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

      const maxTokensRaw = ai?.maxTokens ?? 2048
      const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

      const systemPromptTokens = estimateTokensFromText(ai?.systemPrompt ?? '')
      const addonTokens = estimateTokensFromText(systemAddon ?? '')

      let budget = maxContextTokens - outputReserve - systemPromptTokens - addonTokens
      if (!Number.isFinite(budget) || budget < 256) budget = 256

      const kept: ChatMessage[] = []
      let total = 0
      for (let i = history.length - 1; i >= 0; i--) {
        const cost = estimateTokensForChatMessage(history[i])
        if (kept.length > 0 && total + cost > budget) break
        kept.push(history[i])
        total += cost
      }
      kept.reverse()
      return { history: kept, trimmedCount: Math.max(0, history.length - kept.length) }
    },
    [estimateTokensForChatMessage, estimateTokensFromText],
  )

  const maybeCompressChatHistoryToMaxContext = useCallback(
    async (
      _aiService: AIService,
      history: ChatMessage[],
      systemAddon: string,
      opts?: { signal?: AbortSignal; notify?: boolean; reason?: string },
    ): Promise<{ history: ChatMessage[]; trimmedCount: number; compressed: boolean }> => {
      const notify = opts?.notify ?? false
      const applyTrimOnly = (): { history: ChatMessage[]; trimmedCount: number; compressed: boolean } => {
        const trimmed = trimChatHistoryToMaxContext(history, systemAddon)
        if (notify && trimmed.trimmedCount > 0) {
          setError(`提示：对话上下文过长，已自动截断为最近 ${trimmed.history.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`)
        }
        return { ...trimmed, compressed: false }
      }

      const settingsSnapshot = settingsRef.current
      const ai = settingsSnapshot?.ai
      if (!ai) return applyTrimOnly()

      const compressionEnabled = ai.autoContextCompressionEnabled ?? true
      if (!compressionEnabled || history.length < 8) return applyTrimOnly()

      const maxContextTokensRaw = ai.maxContextTokens ?? 128000
      const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

      const maxTokensRaw = ai.maxTokens ?? 2048
      const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

      const systemPromptTokens = estimateTokensFromText(ai.systemPrompt ?? '')
      const addonTokens = estimateTokensFromText(systemAddon ?? '')
      const historyTokens = history.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
      const estimatedUsed = systemPromptTokens + addonTokens + historyTokens + outputReserve

      const thresholdPctRaw = ai.autoContextCompressionThresholdPct ?? 85
      const targetPctRaw = ai.autoContextCompressionTargetPct ?? 65
      const compressionModel = String(ai.autoContextCompressionModel ?? '').trim()
      const compressionApiSource = ai.autoContextCompressionApiSource === 'profile' ? 'profile' : 'main'
      const compressionProfileId = String(ai.autoContextCompressionProfileId ?? '').trim()
      const compressionProfile =
        compressionApiSource === 'profile'
          ? (Array.isArray(settingsSnapshot?.aiProfiles)
              ? settingsSnapshot.aiProfiles.find((p) => p.id === compressionProfileId) ?? null
              : null)
          : null
      const thresholdPct = Math.max(50, Math.min(99, Math.trunc(Number.isFinite(thresholdPctRaw) ? thresholdPctRaw : 85)))
      const targetPct = Math.max(35, Math.min(thresholdPct - 5, Math.trunc(Number.isFinite(targetPctRaw) ? targetPctRaw : 65)))

      const triggerTokens = Math.floor((maxContextTokens * thresholdPct) / 100)
      if (estimatedUsed <= triggerTokens) return applyTrimOnly()

      const targetUsedTokens = Math.floor((maxContextTokens * targetPct) / 100)
      let allowedHistoryTokensAfter = targetUsedTokens - outputReserve - systemPromptTokens - addonTokens
      if (!Number.isFinite(allowedHistoryTokensAfter) || allowedHistoryTokensAfter < 512) {
        allowedHistoryTokensAfter = 512
      }

      let keepRecentCount = Math.max(6, Math.min(12, history.length))
      while (keepRecentCount > 4) {
        const recent = history.slice(history.length - keepRecentCount)
        const recentTokens = recent.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
        if (recentTokens <= Math.max(256, allowedHistoryTokensAfter - 256)) break
        keepRecentCount -= 2
      }

      const oldMessages = history.slice(0, Math.max(0, history.length - keepRecentCount))
      const recentMessages = history.slice(Math.max(0, history.length - keepRecentCount))
      if (oldMessages.length < 4 || recentMessages.length === 0) return applyTrimOnly()

      const rawCompressionInput = buildContextCompressionSummaryPrompt(oldMessages)
      const compressionInput = rawCompressionInput.trim()
      if (!compressionInput) return applyTrimOnly()

      if (notify) {
        setError('提示：上下文接近阈值，正在自动压缩上下文…')
      }

        debugLog('chat:context.compress.start', {
          reason: opts?.reason ?? 'chat',
          totalMessages: history.length,
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
        const compressionMaxTokens = Math.max(512, Math.min(2200, Math.trunc((ai.maxTokens ?? 2048) / 2)))
        const compressionAiSettings = {
          ...ai,
          apiMode: compressionProfile?.apiMode ?? ai.apiMode,
          apiKey: compressionProfile?.apiKey?.trim() || ai.apiKey,
          hasApiKey: compressionProfile?.hasApiKey ?? ai.hasApiKey,
          baseUrl: compressionProfile?.baseUrl?.trim() || ai.baseUrl,
          model: compressionModel || compressionProfile?.model?.trim() || ai.model,
        }
        const compactor = new AIService(
          {
            ...compressionAiSettings,
            maxTokens: compressionMaxTokens,
            thinkingEffort: 'disabled',
            openaiReasoningEffort: 'disabled',
            claudeThinkingEffort: 'disabled',
            geminiThinkingEffort: 'disabled',
            enableVision: false,
            enableChatStreaming: false,
          },
          compressionProfile ? { kind: 'profile', profileId: compressionProfile.id } : { kind: 'main' },
        )
        const summaryTargetChars = Math.max(600, Math.min(12000, allowedHistoryTokensAfter * 4))
        const compressionPrompt = compressionInput.length > 20000 ? `${compressionInput.slice(0, 20000)}\n\n（已截断过长历史）` : compressionInput

        const res = await compactor.chat(
          [
            {
              role: 'system',
              content:
                '你是“对话上下文压缩器”。请把更早对话压缩成可供后续回答继续使用的摘要。\n' +
                '要求：1) 只保留事实、偏好、约束、目标、已完成事项、未完成事项、关键结论；2) 不要编造；3) 用简体中文；4) 输出纯文本，不要 Markdown 标题/代码块；5) 尽量精简。',
            },
            {
              role: 'user',
              content:
                `请压缩以下较早对话（目标尽量简洁，约 ${summaryTargetChars} 字以内，不必严格）：\n\n` +
                compressionPrompt,
            },
          ],
          { signal: opts?.signal },
        )

        if (res.error) {
          if (res.error === ABORTED_ERROR) throw new DOMException('Aborted', 'AbortError')
          throw new Error(res.error)
        }

        let summaryText = normalizeAssistantDisplayText(res.content, { trim: true })
        if (!summaryText) throw new Error('压缩结果为空')
        if (summaryText.length > summaryTargetChars) {
          summaryText = `${summaryText.slice(0, summaryTargetChars).trim()}\n（摘要已截断）`
        }

        const summaryMessage: ChatMessage = {
          role: 'assistant',
          content: `【自动压缩上下文摘要（系统生成）】\n${summaryText}`,
        }

        const compressedHistory = [summaryMessage, ...recentMessages]
        const trimmed = trimChatHistoryToMaxContext(compressedHistory, systemAddon)

        debugLog('chat:context.compress.done', {
          reason: opts?.reason ?? 'chat',
          compressed: true,
          compressionApiSource,
          compressionProfileId: compressionProfile?.id ?? '',
          compressionModel: compressionAiSettings.model,
          oldMessages: oldMessages.length,
          keepRecentMessages: recentMessages.length,
          finalMessages: trimmed.history.length,
          trimmedCount: trimmed.trimmedCount,
        })

        if (notify) {
          const extraTrim = trimmed.trimmedCount > 0 ? `；另外又截断 ${trimmed.trimmedCount} 条` : ''
          setError(`提示：已自动压缩上下文（压缩 ${oldMessages.length} 条，保留最近 ${recentMessages.length} 条原文${extraTrim}）。`)
        }
        return { history: trimmed.history, trimmedCount: trimmed.trimmedCount, compressed: true }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.warn('[ContextCompression] failed:', err)
          debugLog('chat:context.compress.fail', {
            reason: opts?.reason ?? 'chat',
            error: err instanceof Error ? err.message : String(err),
          })
          if (notify) {
            setError('提示：自动压缩上下文失败，已回退为普通截断。')
          }
        }
        return applyTrimOnly()
      }
    },
    [debugLog, estimateTokensForChatMessage, estimateTokensFromText, trimChatHistoryToMaxContext],
  )

  const chatContextUsage = useMemo<ContextUsageSnapshot | null>(() => {
    const ai = settings?.ai
    if (!ai) return null

    const maxContextTokensRaw = ai.maxContextTokens ?? 128000
    const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

    const maxTokensRaw = ai.maxTokens ?? 2048
    const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

    // 如果有 API 返回的真实 usage，优先使用真实值
    if (lastApiUsage && lastApiUsage.promptTokens > 0) {
      // 真实的 usedTokens = 上次请求的 prompt_tokens + 上次请求的 completion_tokens
      // 这代表了当前上下文实际消耗的 token 数
      const realUsedTokens = lastApiUsage.promptTokens + lastApiUsage.completionTokens
      return {
        usedTokens: realUsedTokens,
        maxContextTokens,
        outputReserveTokens: outputReserve,
        systemPromptTokens: 0, // 真实 usage 时这些细分不再需要估算
        addonTokens: 0,
        historyTokens: lastApiUsage.promptTokens, // prompt_tokens 包含了 system + history
        trimmedCount: 0,
        updatedAt: Date.now(),
        isRealUsage: true, // 标记这是真实值
      }
    }

    // 没有真实 usage 时，使用估算值（发送前预测）
    const systemPromptTokens = estimateTokensFromText(ai.systemPrompt ?? '')
    const addonTokens = estimateTokensFromText(systemAddonForUsage ?? '')

    const chatHistory: ChatMessage[] = messages.map((m) => {
      if (m.role !== 'user') return { role: 'assistant', content: m.content }

      const imgCountFromAttachments = Array.isArray(m.attachments)
        ? m.attachments.filter((a) => a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'image').length
        : 0

      if ((m.image || imgCountFromAttachments > 0) && canUseVision) {
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
        const text = m.content === '[图片]' ? '' : m.content
        if (text.trim().length > 0) parts.push({ type: 'text', text })
        if (m.image) {
          parts.push({ type: 'image_url', image_url: { url: m.image } })
        } else {
          const n = Math.max(0, Math.min(4, imgCountFromAttachments))
          for (let i = 0; i < n; i += 1) parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
        }
        return { role: 'user', content: parts }
      }

      const plain = m.content.trim().length > 0 ? m.content : '[消息]'
      return { role: 'user', content: plain }
    })

    // 估算"下一次发送"时会附带的内容：把当前输入（以及待发送图片）也视为会进入上下文
    const inputText = (input ?? '').trim()
    const withPending: ChatMessage[] = [...chatHistory]
    const pendingImageCount = pendingAttachments.filter((a) => a.kind === 'image').length
    if (inputText || pendingImageCount > 0) {
      if (pendingImageCount > 0 && canUseVision) {
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
        if (inputText) parts.push({ type: 'text', text: inputText })
        const n = Math.max(0, Math.min(4, pendingImageCount))
        for (let i = 0; i < n; i += 1) parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' } })
        withPending.push({ role: 'user', content: parts })
      } else {
        withPending.push({ role: 'user', content: inputText || '[消息]' })
      }
    }

    const trimmed = trimChatHistoryToMaxContext(withPending, systemAddonForUsage)
    const historyTokens = trimmed.history.reduce((sum, msg) => sum + estimateTokensForChatMessage(msg), 0)
    return {
      usedTokens: systemPromptTokens + addonTokens + historyTokens + outputReserve,
      maxContextTokens,
      outputReserveTokens: outputReserve,
      systemPromptTokens,
      addonTokens,
      historyTokens,
      trimmedCount: trimmed.trimmedCount,
      updatedAt: Date.now(),
    }
  }, [
    canUseVision,
    estimateTokensForChatMessage,
    estimateTokensFromText,
    input,
    lastApiUsage,
    messages,
    pendingAttachments,
    settings?.ai,
    systemAddonForUsage,
    trimChatHistoryToMaxContext,
  ])

  useEffect(() => {
    if (!api) return
    if (!chatContextUsage) return
    contextUsagePendingRef.current = chatContextUsage

    const flushPending = () => {
      const pending = contextUsagePendingRef.current
      if (!pending) return
      contextUsagePendingRef.current = null
      contextUsageLastSentAtRef.current = Date.now()
      try {
        api.setContextUsage(pending)
      } catch {
        /* ignore */
      }
    }

    const nowTs = Date.now()
    const waitMs = 250 - (nowTs - contextUsageLastSentAtRef.current)
    if (waitMs <= 0) {
      if (contextUsageSendTimerRef.current != null) {
        window.clearTimeout(contextUsageSendTimerRef.current)
        contextUsageSendTimerRef.current = null
      }
      flushPending()
      return
    }

    if (contextUsageSendTimerRef.current != null) return
    contextUsageSendTimerRef.current = window.setTimeout(() => {
      contextUsageSendTimerRef.current = null
      flushPending()
    }, waitMs)
  }, [api, chatContextUsage])

  useEffect(() => {
    return () => {
      if (contextUsageSendTimerRef.current != null) {
        window.clearTimeout(contextUsageSendTimerRef.current)
        contextUsageSendTimerRef.current = null
      }
      contextUsagePendingRef.current = null
    }
  }, [])

  const formatAiErrorForUser = useCallback((raw: string): { message: string; shouldAlert: boolean } => {
    const text = String(raw ?? '').trim()
    const lower = text.toLowerCase()
    const isContextTooLong =
      lower.includes('context_length') ||
      lower.includes('maximum context') ||
      (lower.includes('context') && lower.includes('length')) ||
      (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum'))) ||
      text.includes('上下文') ||
      text.includes('长度超出') ||
      text.includes('超出上下文')

    if (!isContextTooLong) return { message: text || '未知错误', shouldAlert: false }

    return {
      message: `上下文过长导致请求失败，可右键“一键总结”或清空对话后重试。（原始错误：${text || 'unknown'}）`,
      shouldAlert: true,
    }
  }, [])

  const pickAvatar = useCallback(
    (role: 'user' | 'assistant') => {
      if (role === 'user') userAvatarInputRef.current?.click()
      else assistantAvatarInputRef.current?.click()
    },
    [],
  )

  const refreshSessions = useCallback(async () => {
    if (!api) return
    const activePersonaId = getActivePersonaId()
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    let filtered = filterSessionsForPersona(allSessions)

    // 如果当前人设完全没有会话，则自动创建一个，避免出现“没有 currentSessionId 导致无法清空/发送”的卡死状态
    if (filtered.length === 0) {
      const created = await api.createChatSession(undefined, activePersonaId)
      const { sessions: again, currentSessionId: cur2 } = await api.listChatSessions()
      filtered = filterSessionsForPersona(again)
      setSessions(filtered)
      setCurrentSessionId(filtered.some((s) => s.id === cur2) ? cur2 : created.id)
      return
    }

    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null))
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const interrupt = useCallback(
    (opts?: { stopTts?: boolean }) => {
      chatStopSeqRef.current += 1
      try {
        aiAbortRef.current?.abort()
      } catch (_) {
        /* ignore */
      }
      aiAbortRef.current = null

      if (opts?.stopTts !== false) {
        try {
          api?.stopTtsAll()
        } catch (_) {
          /* ignore */
        }
      }

      sendBubblePreview({ clear: true }, { force: true })
      isLoadingRef.current = false
      setIsLoading(false)
    },
    [api, sendBubblePreview],
  )

  const hasActiveTts = ttsPendingUtteranceId != null || Object.keys(ttsRevealedSegments).length > 0
  const isAssistantOutputting = isLoading || currentActiveChatTaskIds.length > 0 || hasActiveTts

  const stopAssistantOutput = useCallback(() => {
    interrupt()
    setTtsPendingUtteranceId(null)
    setTtsRevealedSegments({})
    ttsUtteranceMetaRef.current = {}
    if (!api || currentActiveChatTaskIds.length === 0) return

    for (const taskId of currentActiveChatTaskIds) {
      void api.cancelTask(taskId).catch((err) => console.error('[ChatStop] cancel task failed:', err))
    }
  }, [api, currentActiveChatTaskIds, interrupt])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isAssistantOutputting) {
          stopAssistantOutput()
          return
        }
        closeOverlays()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeOverlays, isAssistantOutputting, stopAssistantOutput])

  useEffect(() => {
    if (!editingMessageId) return
    const el = editingTextareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editingMessageId, editingMessageContent])

  useEffect(() => {
    const el = composerTextareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`
  }, [input])

  useEffect(() => {
    if (!confirmClearOpen) return
    confirmClearButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmClearOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmClearOpen])

  const send = useCallback(async (override?: {
    text?: string
    source?: 'manual' | 'asr'
    baseMessages?: ChatMessageRecord[]
    attachments?: ChatAttachment[]
  }) => {
    const source = override?.source ?? 'manual'
    const text = (override?.text ?? inputRef.current).trim()
    const attachmentsRaw =
      source === 'manual'
        ? (override?.attachments ??
          pendingAttachments.map((a) => ({
            kind: a.kind,
            path: a.path,
            resourceId: a.resourceId,
            filename: a.filename,
          })))
        : (override?.attachments ?? [])
    const attachments = attachmentsRaw
      .map((a) => ({
        kind: a.kind,
        path: String(a.path ?? '').trim(),
        resourceId: typeof a.resourceId === 'string' ? a.resourceId.trim() : undefined,
        filename: typeof a.filename === 'string' ? a.filename.trim() : '',
      }))
      .filter((a) => (a.kind === 'image' || a.kind === 'video') && a.path.length > 0)
    if (!api || !currentSessionId) return

    // 发送新消息前先停止正在播放的 TTS/气泡（作为“打断”）
    try {
      api.stopTtsAll()
    } catch (_) {
      /* ignore */
    }

    if (isLoadingRef.current) {
      interrupt()
      if (!text && attachments.length === 0) return
    } else {
      if (!text && attachments.length === 0) return
    }

    const aiService = getAIService()
    if (!aiService) {
      setError('AI 服务未初始化，请先配置 AI 设置')
      return
    }

    // Add user message
    const attachmentLabel = (() => {
      const tags: string[] = []
      const imgCount = attachments.filter((a) => a.kind === 'image').length
      const vidCount = attachments.filter((a) => a.kind === 'video').length
      if (imgCount > 0) tags.push(imgCount === 1 ? '[图片]' : `[图片x${imgCount}]`)
      if (vidCount > 0) tags.push(vidCount === 1 ? '[视频]' : `[视频x${vidCount}]`)
      return tags.join('') || ''
    })()
    const firstImagePath = attachments.find((a) => a.kind === 'image')?.path ?? ''
    const firstVideoPath = attachments.find((a) => a.kind === 'video')?.path ?? ''
    const userMessage: ChatMessageRecord = {
      id: newMessageId(),
      role: 'user',
      content: text || attachmentLabel || '[消息]',
      attachments: attachments.length ? attachments : undefined,
      imagePath: firstImagePath || undefined, // 兼容旧逻辑：保留第一张图路径
      videoPath: firstVideoPath || undefined, // 兼容旧逻辑：保留第一个视频路径
      createdAt: Date.now(),
    }
    let baseMessages = override?.baseMessages ?? messagesRef.current
    let recoveredBaseFromStore = false
    if (!override?.baseMessages) {
      try {
        const persisted = await api.getChatSession(currentSessionId).catch(() => null)
        const persistedMessages = Array.isArray(persisted?.messages) ? persisted!.messages : []
        if (persistedMessages.length > baseMessages.length) {
          baseMessages = persistedMessages
          recoveredBaseFromStore = true
          messagesRef.current = persistedMessages
          setMessages((prev) => (prev.length >= persistedMessages.length ? prev : persistedMessages))
        }
      } catch {
        /* ignore */
      }
    }
    debugLog('chat:send.base', {
      sessionId: currentSessionId,
      source,
      inMemoryCount: (override?.baseMessages ?? messagesRef.current).length,
      baseCount: baseMessages.length,
      recoveredBaseFromStore,
    })
    const nextMessages = [...baseMessages, userMessage]
    messagesRef.current = nextMessages
    setMessages(nextMessages)
    if (source === 'manual') {
      inputRef.current = ''
      setInput('')
      syncAsrComposePreview('', { clearFinals: true })
      setPendingAttachments([])
    }
    if (source === 'asr' && (settingsRef.current?.asr?.autoSend ?? false)) {
      syncAsrComposePreview('', { clearFinals: true })
    }
    setError(null)
    isLoadingRef.current = true
    setIsLoading(true)
    sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })
    const abort = new AbortController()
    aiAbortRef.current = abort

    try {
      // Build chat history for context
      type VisionPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      const buildLastUserWithVision = async (m: ChatMessageRecord): Promise<ChatMessage> => {
        const text = String(m.content ?? '').trim()
        const imagePaths = collectMessageImagePaths(m).slice(0, settingsRef.current?.ai?.visionMaxImagesPerLook ?? 4)
        if (!canUseMainVision || imagePaths.length === 0) return { role: 'user', content: text || attachmentLabel || '[消息]' }

        const parts: VisionPart[] = []
        if (text.length > 0) parts.push({ type: 'text', text })
        parts.push(...((await buildVisionPartsFromImagePaths(imagePaths, 4)) as VisionPart[]))
        if (parts.some((x) => x.type === 'image_url')) return { role: 'user', content: parts }
        return { role: 'user', content: text || attachmentLabel || '[消息]' }
      }

      let chatHistory: ChatMessage[] = []
      for (const m of nextMessages) {
        if (m.role !== 'user') {
          if (m.content.trim().length > 0) chatHistory.push({ role: 'assistant', content: m.content })
          continue
        }

        if (m.id === userMessage.id) {
          chatHistory.push(await buildLastUserWithVision(m))
          continue
        }

        chatHistory.push({ role: 'user', content: m.content.trim().length > 0 ? m.content : '[消息]' })
      }

      await api.addChatMessage(currentSessionId, userMessage)

      // M4：对话 → 任务规划器（LLM Planner）→ TaskService
      const orch = settingsRef.current?.orchestrator
      const plannerEnabledNow = orch?.plannerEnabled ?? false
      const plannerModeNow = orch?.plannerMode ?? 'auto'
      const toolCallingEnabledNow = orch?.toolCallingEnabled ?? false
      const toolCallingModeNow = orch?.toolCallingMode ?? 'auto'

      const requestForTools = (text ?? '').trim() || attachmentLabel || ''
      const visualArtifacts = canUseVision ? collectRecentVisualArtifacts(nextMessages, 12) : []
      const initialVisionIds = visualArtifacts
        .filter((artifact) => artifact.source === 'upload' && artifact.messageId === userMessage.id)
        .map((artifact) => artifact.id)
      const attachmentAddon = (() => {
        const lines: string[] = []
        for (const a of attachments) {
          if (a.kind === 'video') lines.push(`- videoPath: ${a.path}`)
        }
        if (lines.length === 0) return ''
        return ['【本次用户附带本地视频（仅供工具调用，不要在最终回复中暴露路径）】', ...lines].join('\n')
      })()
      const worldBookAddon = buildWorldBookAddon(settingsRef.current, getActivePersonaId())
      const shouldRunToolAgent =
        requestForTools.trim().length > 0 &&
        ((plannerEnabledNow && toolCallingEnabledNow) || visualArtifacts.length > 0)
      debugLog('chat:toolAgent.gate', {
        sessionId: currentSessionId,
        plannerEnabled: plannerEnabledNow,
        toolCallingEnabled: toolCallingEnabledNow,
        toolCallingMode: toolCallingModeNow,
        requestForTools,
        visualArtifactIds: visualArtifacts.map((artifact) => artifact.id),
        initialVisionIds,
        shouldRunToolAgent,
      })
      if (shouldRunToolAgent) {
        try {
          const toPlainText = (content: unknown): string => {
            if (typeof content === 'string') return content
            if (Array.isArray(content)) {
              // OpenAI vision parts: [{type:'text',text:'...'} , {type:'image_url',...}]
              const parts = content as Array<Record<string, unknown>>
              return parts
                .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
                .filter(Boolean)
                .join('\n')
            }
            return ''
          }

          const request = requestForTools.trim() || '[消息]'
          // ToolAgent 也要注入“召回记忆”，否则用户会看到“尚无召回记录/完全不召回”的错觉。
          // 注意：召回开关取自全局 memory.enabled + 当前 persona.retrieveEnabled。
          let memoryAddon = ''
          setLastRetrieveDebug(null)
          setLastVisionDebug(null)
          try {
            const memEnabled = settingsRef.current?.memory?.enabled ?? true
            if (!memEnabled || !retrieveEnabled) throw new Error('recall disabled')
            const queryText = request
            if (queryText.length > 0) {
              const personaId = getActivePersonaId()
              const res = await api.retrieveMemory({
                personaId,
                query: queryText,
                limit: 12,
                maxChars: 3200,
                includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
              })
              memoryAddon = removeDuplicatedPersonaFromMemoryAddon(res.addon?.trim() ?? '')
              setLastRetrieveDebug(res.debug ?? null)
            }
          } catch {
            memoryAddon = ''
            setLastRetrieveDebug(null)
          }

          const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
          const toolContext = [personaSystemAddon, memoryAddon, worldBookAddon, toolFactsAddon, attachmentAddon]
            .filter(Boolean)
            .join('\n\n')

          // 使用 token 预算动态截断历史，而非硬编码轮数，充分利用模型的上下文窗口
          const historyForAgent: ChatMessage[] = chatHistory
            .slice(0, -1)
            .map((m) => ({ role: m.role, content: toPlainText(m.content).trim() }))
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.length > 0)
          const preparedHistory = await maybeCompressChatHistoryToMaxContext(aiService, historyForAgent, toolContext, {
            signal: abort.signal,
            notify: true,
            reason: 'tool-agent',
          })
          const history = preparedHistory.history

          const title = request.length > 40 ? `${request.slice(0, 40)}…` : request

          const created = await api.createTask({
            queue: 'chat',
            title: title || '对话',
            why: '对话工具代理（agent.run）',
            visualArtifacts,
            initialVisionIds,
            steps: [
              {
                title: '对话/工具',
                tool: 'agent.run',
                input: JSON.stringify({
                  request,
                  mode: toolCallingModeNow,
                  history,
                  context: toolContext,
                }),
              },
            ],
          })

          taskOriginSessionRef.current.set(created.id, currentSessionId)
          taskToolUseSplitRef.current.set(created.id, { runIds: [], segments: [''], lastDisplay: '' })

          const assistantId = newMessageId()
          // 先用轻量状态占位，避免“空消息/无反馈”；真正的文本与工具卡片由任务流式进度增量驱动更新。
          const blocks: ChatMessageBlock[] = [{ type: 'status', text: '思考中…' }]
          const assistantMessage: ChatMessageRecord = {
            id: assistantId,
            role: 'assistant',
            content: joinTextBlocks(blocks),
            blocks,
            taskId: created.id,
            createdAt: Date.now(),
          }

          taskOriginMessageRef.current.set(created.id, assistantId)
          taskOriginBlocksRef.current.set(created.id, blocks)
          debugLog('chat:agentRun.created', {
            sessionId: currentSessionId,
            taskId: created.id,
            messageId: assistantId,
            blocks,
          })

          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          return
        } catch (err) {
          console.error('[ToolAgent] failed:', err)
          // 失败时回退到原先的 planner/普通聊天链路
        }
      }

      const shouldTryPlanner =
        plannerEnabledNow &&
        toolCallingEnabledNow &&
        (plannerModeNow === 'always' || plannerModeNow === 'auto') &&
        requestForTools.trim().length > 0

      if (shouldTryPlanner) {
        try {
          const toolSettingsNow = settingsRef.current?.tools
          const builtinToolNames = getBuiltinToolDefinitions()
            .filter((tool) => tool.name !== 'vision.look')
            .map((tool) => tool.name)

          let mcpToolNames: string[] = []
          try {
            const mcp = await api.getMcpState()
            const servers = Array.isArray(mcp.servers) ? mcp.servers : []
            mcpToolNames = servers.flatMap((s) => {
              const tools = Array.isArray(s.tools) ? s.tools : []
              return tools.map((t) => (typeof t?.toolName === 'string' ? t.toolName : '')).filter(Boolean)
            })
          } catch {
            mcpToolNames = []
          }

          const plannerToolNames = Array.from(new Set([...builtinToolNames, ...mcpToolNames].map((t) => t.trim()).filter(Boolean))).filter(
            (t) => isToolEnabled(t, toolSettingsNow),
          )
          const plannerToolSet = new Set(plannerToolNames)

          // Planner 也使用 token 预算动态截断历史
          const plannerHistoryRaw: ChatMessage[] = nextMessages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: typeof m.content === 'string' ? m.content : '',
          }))
          const plannerContext = [personaSystemAddon, worldBookAddon, attachmentAddon].filter(Boolean).join('\n\n')
          const plannerPrepared = await maybeCompressChatHistoryToMaxContext(aiService, plannerHistoryRaw, plannerContext, {
            signal: abort.signal,
            notify: true,
            reason: 'planner',
          })
          const plannerHistory = plannerPrepared.history

          const planRes = await aiService.chat(
            [
              {
                role: 'system',
                content: buildPlannerSystemPrompt({
                  systemPrompt: settingsRef.current?.ai?.systemPrompt,
                  toolNames: plannerToolNames,
                  expressions: toolAnimRef.current.expressions ?? [],
                  motions: toolAnimRef.current.motionGroups ?? [],
                }),
              },
              ...(personaSystemAddon ? [{ role: 'system' as const, content: personaSystemAddon }] : []),
              ...(worldBookAddon ? [{ role: 'system' as const, content: worldBookAddon }] : []),
              ...(attachmentAddon ? [{ role: 'system' as const, content: attachmentAddon }] : []),
              ...(requestLikelyNeedsToolAction(requestForTools)
                ? [
                    {
                      role: 'system' as const,
                      content:
                        '程序提示：本轮用户请求可能需要工具行动。若确实需要截图、搜索、网页操作、文件读写或运行命令，优先输出 create_task；若只是普通聊天、解释、安慰、角色互动或不需要真实工具结果，允许输出 chat。',
                    },
                  ]
                : []),
              ...plannerHistory,
            ],
            { signal: abort.signal },
          )

          if (planRes.error) {
            if (planRes.error === ABORTED_ERROR) return
          } else {
            const decision = parsePlannerDecision(planRes.content)

            if (decision?.type === 'need_info') {
              plannerPendingRef.current = true
              const assistantMessage: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: decision.assistantReply,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              if (assistantMessage.content) api.sendBubbleMessage(assistantMessage.content)
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'create_task') {
              const runnable = (decision.task.steps ?? []).some((s) => typeof s.tool === 'string' && plannerToolSet.has(s.tool))
              if (!runnable) throw new Error('规划器未生成可执行步骤（没有可用 tool）')

              const inferQueue = (): TaskCreateArgs['queue'] => {
                if (decision.task.queue) return decision.task.queue
                const tools = (decision.task.steps ?? []).map((s) => (typeof s.tool === 'string' ? s.tool : ''))
                if (tools.some((t) => t.startsWith('browser.'))) return 'browser'
                if (tools.some((t) => t.startsWith('cli.'))) return 'cli'
                if (tools.some((t) => t.startsWith('file.'))) return 'file'
                if (tools.some((t) => t.startsWith('llm.'))) return 'chat'
                return 'other'
              }

              const queue = inferQueue()

              const created = await api.createTask({ ...decision.task, queue })

              taskOriginSessionRef.current.set(created.id, currentSessionId)

              plannerPendingRef.current = false

              // 统一为“单消息 turn 容器”：前置对话 + ToolUse 卡片 +（任务完成后追加的最终回复）
              const prefaceRaw = String(decision.assistantReply ?? '').trim()
              const prefaceText = prefaceRaw ? normalizeAssistantDisplayText(prefaceRaw, { trim: true }) : ''
              const prefaceTags = prefaceRaw ? extractLastLive2DTags(prefaceRaw) : { expression: undefined, motion: undefined }

              const assistantId = newMessageId()
              const blocks: ChatMessageBlock[] = [
                ...(prefaceText ? [{ type: 'text', text: prefaceText } as const] : []),
                { type: 'tool_use', taskId: created.id },
                { type: 'text', text: '' },
              ]

              const assistantMessage: ChatMessageRecord = {
                id: assistantId,
                role: 'assistant',
                content: joinTextBlocks(blocks),
                blocks,
                taskId: created.id,
                createdAt: Date.now(),
              }

              taskOriginMessageRef.current.set(created.id, assistantId)
              taskOriginBlocksRef.current.set(created.id, blocks)

              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)

              if (prefaceText) api.sendBubbleMessage(prefaceText)
              {
                const resolveFromList = (nameRaw: string, list: string[]): string | null => {
                  const name = String(nameRaw ?? '').trim()
                  if (!name) return null
                  if (list.includes(name)) return name
                  const lower = name.toLowerCase()
                  return list.find((x) => x.toLowerCase() === lower) ?? null
                }
                const exp = prefaceTags.expression
                  ? resolveFromList(prefaceTags.expression, toolAnimRef.current.expressions ?? [])
                  : null
                const motion = prefaceTags.motion ? resolveFromList(prefaceTags.motion, toolAnimRef.current.motionGroups ?? []) : null
                if (exp) api.triggerExpression(exp)
                if (motion) api.triggerMotion(motion, 0)
              }

              // 任务完成后：用“同一 turn 第二段 LLM 请求”生成最终回复（不把工具结果写进对话/记忆正文）
              let systemAddon = ''
              try {
                const memEnabled = settingsRef.current?.memory?.enabled ?? true
                if (!memEnabled) throw new Error('memory disabled')
                const queryText = (text ?? '').trim()
                if (queryText.length > 0) {
                  const personaId = getActivePersonaId()
                  const res = await api.retrieveMemory({
                    personaId,
                    query: queryText,
                    limit: 12,
                    maxChars: 3200,
                    includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
                  })
                  systemAddon = removeDuplicatedPersonaFromMemoryAddon(res.addon?.trim() ?? '')
                }
              } catch {
                systemAddon = ''
              }
              const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
              const mergedSystemAddon = [personaSystemAddon, systemAddon.trim(), worldBookAddon.trim(), toolFactsAddon.trim()]
                .filter(Boolean)
                .join('\n\n')

              const historyWithPreface = [...chatHistory, { role: 'assistant' as const, content: assistantMessage.content }]
              const trimmed = await maybeCompressChatHistoryToMaxContext(aiService, historyWithPreface, mergedSystemAddon, {
                signal: abort.signal,
                notify: false,
                reason: 'task-finalize',
              })
              taskFinalizeContextRef.current.set(created.id, {
                sessionId: currentSessionId,
                messageId: assistantId,
                chatHistory: trimmed.history,
                systemAddon: mergedSystemAddon,
                userText: text,
              })
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'chat') {
              plannerPendingRef.current = false
              // 纯聊天：不使用 planner 的“代答复”，保持一次请求的流式对话体验
            }
          }
        } catch (err) {
          console.error('[Planner] failed:', err)
        }
      }

      const systemAddonParts: string[] = personaSystemAddon ? [personaSystemAddon] : []
      setLastRetrieveDebug(null)
      try {
        const memEnabled = settingsRef.current?.memory?.enabled ?? true
        if (!memEnabled) throw new Error('memory disabled')
        const queryText = (text ?? '').trim()
        if (queryText.length > 0) {
          const personaId = getActivePersonaId()
          const res = await api.retrieveMemory({
            personaId,
            query: queryText,
            limit: 12,
            maxChars: 3200,
            includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
          })
          const addon = removeDuplicatedPersonaFromMemoryAddon(res.addon?.trim() ?? '')
          if (addon) systemAddonParts.push(addon)
          setLastRetrieveDebug(res.debug ?? null)
        }
      } catch (_) {
        setLastRetrieveDebug(null)
      }

      {
        if (worldBookAddon.trim()) systemAddonParts.push(worldBookAddon.trim())
      }

      {
        const toolFactsAddon = buildSessionToolFactsAddon(currentSessionId)
        if (toolFactsAddon.trim()) systemAddonParts.push(toolFactsAddon.trim())
      }

      const systemAddon = systemAddonParts.filter(Boolean).join('\n\n')

      {
        const prepared = await maybeCompressChatHistoryToMaxContext(aiService, chatHistory, systemAddon, {
          signal: abort.signal,
          notify: true,
          reason: 'chat-send',
        })
        chatHistory = prepared.history
      }

      const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false
      const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)

      if (ttsSegmented) {
        const utteranceId = newMessageId()
        setTtsPendingUtteranceId(utteranceId)
        setTtsRevealedSegments((prev) => ({ ...prev, [utteranceId]: 0 }))
        const segmentedStopSeq = chatStopSeqRef.current
        const isSegmentedStopped = () => abort.signal.aborted || chatStopSeqRef.current !== segmentedStopSeq

        try {
          const response = enableChatStreaming
            ? await (async () => {
                let acc = ''

                const res = await aiService.chatStream(chatHistory, {
                  signal: abort.signal,
                  systemAddon,
                  onDelta: (delta) => {
                    if (isSegmentedStopped()) return
                    acc += delta
                    const display = normalizeAssistantDisplayText(acc)
                    if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
                  },
                })
                if (isSegmentedStopped()) return { content: '', error: ABORTED_ERROR }
                if (!res.error) {
                  const merged = res.content?.trim().length ? res.content : acc
                  return { ...res, content: merged }
                }
                return res
              })()
            : await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

          if (isSegmentedStopped()) {
            sendBubblePreview({ clear: true }, { force: true })
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            return
          }

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              sendBubblePreview({ clear: true }, { force: true })
              setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
              setTtsRevealedSegments((prev) => {
                const next = { ...prev }
                delete next[utteranceId]
                return next
              })
              return
            }
            sendBubblePreview({ clear: true }, { force: true })
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            const msg: ChatMessageRecord = {
              id: newMessageId(),
              role: 'assistant',
              content: `[错误] ${response.error}`,
              createdAt: Date.now(),
            }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
            return
          }

          const content = normalizeAssistantDisplayText(response.content, { trim: true })
          if (content.trim()) sendBubblePreview({ text: content, autoHideDelay: 0 })
          // 更新真实的 API usage 统计
          if (response.usage) setLastApiUsage(response.usage)
          const assistantCreatedAt = Date.now()

          const assistantMessage: ChatMessageRecord = {
            id: utteranceId,
            role: 'assistant',
            content,
            createdAt: assistantCreatedAt,
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          setTtsSegmentedMessageFlags((prev) => ({ ...prev, [utteranceId]: true }))

          const segs = splitTextIntoTtsSegments(content, { lang: 'zh', textSplitMethod: 'cut5' })
          ttsUtteranceMetaRef.current[utteranceId] = {
            sessionId: currentSessionId,
            createdAt: assistantCreatedAt,
            messageId: utteranceId,
            displayedSegments: 0,
            fallbackContent: content,
          }

          api.enqueueTtsUtterance({ utteranceId, mode: 'replace', segments: segs.length ? segs : [content], fullText: content })
          api.finalizeTtsUtterance(utteranceId)

          if (response.expression) api.triggerExpression(response.expression)
          if (response.motion) api.triggerMotion(response.motion, 0)
        } catch (err) {
          sendBubblePreview({ clear: true }, { force: true })
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
          setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
          setTtsRevealedSegments((prev) => {
            const next = { ...prev }
            delete next[utteranceId]
            return next
          })
          const assistantMessage: ChatMessageRecord = {
            id: newMessageId(),
            role: 'assistant',
            content: `[错误] ${msg}`,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
        }

        return
      }

      if (enableChatStreaming) {
        const assistantId = newMessageId()
        let created = false
        const createdAt = Date.now()
        let acc = ''
        let pending = ''
        let lastExpression: string | undefined
        let lastMotion: string | undefined
        const streamStopSeq = chatStopSeqRef.current
        const isStreamStopped = () => abort.signal.aborted || chatStopSeqRef.current !== streamStopSeq

        const ensureMessageCreated = () => {
          if (isStreamStopped()) return
          if (created) return
          created = true
          const assistantMessage: ChatMessageRecord = {
            id: assistantId,
            role: 'assistant',
            content: '',
            createdAt,
          }
          setMessages((prev) => [...prev, assistantMessage])
          api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
        }

        const flush = () => {
          if (isStreamStopped()) {
            pending = ''
            return
          }
          if (!pending) return
          const appended = pending
          acc += pending
          pending = ''
          if (!created) ensureMessageCreated()
          const display = normalizeAssistantDisplayText(acc)
          if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)))

          const tags = extractTailLive2DTags(acc, appended.length)
          if (tags.expression && tags.expression !== lastExpression) {
            lastExpression = tags.expression
            api.triggerExpression(tags.expression)
          }
          if (tags.motion && tags.motion !== lastMotion) {
            lastMotion = tags.motion
            api.triggerMotion(tags.motion, 0)
          }
        }
        const flushThrottle = createStreamFlushThrottle(flush)

        const response = await aiService.chatStream(chatHistory, {
          signal: abort.signal,
          systemAddon,
          onDelta: (delta) => {
            if (isStreamStopped()) return
            pending += delta
            flushThrottle.schedule()
          },
        })
        flushThrottle.finalize()
        if (isStreamStopped()) {
          sendBubblePreview({ clear: true }, { force: true })
          return
        }

        if (response.error) {
          if (response.error === ABORTED_ERROR) {
            // 被打断：不写入错误信息，直接结束
            sendBubblePreview({ clear: true }, { force: true })
            return
          }
          const partialForUi = normalizeAssistantDisplayText(response.content || acc, { trim: true })
          if (partialForUi) sendBubblePreview({ text: partialForUi, autoHideDelay: 0 })
          else sendBubblePreview({ clear: true }, { force: true })
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const nextContent = buildInterruptedStreamContent(partialForUi, response.error)
          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }
          return
        }

        const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
        // 更新真实的 API usage 统计
        if (response.usage) setLastApiUsage(response.usage)
        if (created) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalContent } : m)))
          await api.updateChatMessage(currentSessionId, assistantId, finalContent).catch(() => undefined)
        } else {
          const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: finalContent, createdAt }
          setMessages((prev) => [...prev, msg])
          await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
        }
        if (finalContent.trim()) sendBubblePreview({ text: finalContent, autoHideDelay: 0 })
        if (finalContent) api.sendBubbleMessage(finalContent)
        void runAutoExtractIfNeeded(currentSessionId)
        return
      }

      const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

      if (response.error) {
        if (response.error === ABORTED_ERROR) {
          sendBubblePreview({ clear: true }, { force: true })
          return
        }
        sendBubblePreview({ clear: true }, { force: true })
        const errUi = formatAiErrorForUser(response.error)
        setError(errUi.message)
        if (errUi.shouldAlert) window.alert(errUi.message)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${response.error}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)
        return
      }

      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      }
      // 更新真实的 API usage 统计
      if (response.usage) setLastApiUsage(response.usage)
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage)

      if (response.expression) api.triggerExpression(response.expression)
      if (response.motion) api.triggerMotion(response.motion, 0)
      if (response.content?.trim()) sendBubblePreview({ text: response.content, autoHideDelay: 0 })
      if (response.content) api.sendBubbleMessage(response.content)
      void runAutoExtractIfNeeded(currentSessionId)
    } catch (err) {
      sendBubblePreview({ clear: true }, { force: true })
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: `[错误] ${errorMessage}`,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
    } finally {
      if (aiAbortRef.current === abort) aiAbortRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      refreshSessions().catch(() => undefined)
    }
  }, [
    api,
    buildVisionPartsFromImagePaths,
    canUseMainVision,
    canUseVision,
    collectRecentVisualArtifacts,
    currentSessionId,
    debugLog,
    getActivePersonaId,
    newMessageId,
    pendingAttachments,
    personaSystemAddon,
    removeDuplicatedPersonaFromMemoryAddon,
    buildSessionToolFactsAddon,
    refreshSessions,
    retrieveEnabled,
    interrupt,
    runAutoExtractIfNeeded,
    maybeCompressChatHistoryToMaxContext,
    formatAiErrorForUser,
    syncAsrComposePreview,
    sendBubblePreview,
  ])

  const flushAsrAutoSendQueue = useCallback(() => {
    if (!api) return
    if (!currentSessionId) return
    if (asrAutoSendFlushingRef.current) return

    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (!asr.autoSend) return

    const pending = pendingAsrAutoSendRef.current
    if (pending.length === 0) return

    asrAutoSendFlushingRef.current = true
    const batch = pending.slice(0, pending.length)
    pendingAsrAutoSendRef.current = []

    void (async () => {
      try {
        for (const text of batch) {
          const cleaned = String(text ?? '').trim()
          if (!cleaned) continue
          await send({ text: cleaned, source: 'asr' })
        }
      } finally {
        asrAutoSendFlushingRef.current = false
      }
      flushAsrAutoSendQueue()
    })()
  }, [api, currentSessionId, send])

  // ASR transcript from pet window: manual mode fills input only; autoSend mode triggers send（chat window 可隐藏）
  useEffect(() => {
    if (!api) return

    let cancelled = false
    let drainingPending = false

    const handleTranscript = (text: string) => {
      const cleaned = String(text ?? '').trim()
      if (!cleaned) return

      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return

      if (asr.autoSend) {
        if (!currentSessionId) {
          pendingAsrAutoSendRef.current.push(cleaned)
          syncAsrComposePreview('', { clearFinals: true })
          return
        }
        syncAsrComposePreview('', { clearFinals: true })
        void send({ text: cleaned, source: 'asr', baseMessages: messagesRef.current }).then(() => flushAsrAutoSendQueue())
        return
      }

      setInput((prev) => {
        const base = prev.trim()
        const next = !base ? cleaned : `${prev} ${cleaned}`
        inputRef.current = next
        queueMicrotask(() => syncAsrComposePreview(next))
        return next
      })
    }

    const notifyTranscriptReady = () => {
      try {
        api.notifyAsrTranscriptReady()
      } catch {
        /* ignore */
      }
    }

    const drainPendingTranscript = () => {
      if (drainingPending) return
      drainingPending = true
      void (async () => {
        try {
          // 告知主进程聊天窗口已可接收实时 transcript，避免文本长期堆积在 pending 队列里。
          notifyTranscriptReady()
          const asr = settingsRef.current?.asr
          if (!asr?.enabled) return
          const cached = await api.takeAsrTranscript().catch(() => '')
          if (cancelled) return
          handleTranscript(cached)
        } finally {
          drainingPending = false
        }
      })()
    }

    const off = api.onAsrTranscript(handleTranscript)
    drainPendingTranscript()
    const onWindowVisible = () => {
      notifyTranscriptReady()
      if (document.visibilityState !== 'visible') return
      drainPendingTranscript()
    }
    window.addEventListener('focus', onWindowVisible)
    document.addEventListener('visibilitychange', onWindowVisible)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onWindowVisible)
      document.removeEventListener('visibilitychange', onWindowVisible)
      off()
    }
  }, [api, currentSessionId, flushAsrAutoSendQueue, send, syncAsrComposePreview])

  useEffect(() => {
    flushAsrAutoSendQueue()
  }, [flushAsrAutoSendQueue])

  useEffect(() => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) {
      syncAsrComposePreview('', { clearFinals: true })
      return
    }
    if (asr.autoSend) {
      syncAsrComposePreview('', { clearFinals: true })
      return
    }
    syncAsrComposePreview(inputRef.current)
  }, [currentSessionId, input, settings?.asr?.enabled, settings?.asr?.autoSend, syncAsrComposePreview])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composerComposingRef.current) {
      e.preventDefault()
      if (isAssistantOutputting) stopAssistantOutput()
      else send()
    }
  }

  const clearMessages = async () => {
    if (!api) return
    const sid =
      currentSessionId ??
      (await api.listChatSessions().then((r) => r.currentSessionId).catch(() => '')) ??
      ''
    if (!sid) return
    await api.clearChatSession(sid)
    setMessages([])
    setLastApiUsage(null)
    setError(null)
    await refreshSessions()
  }

  const requestClearMessages = () => {
    closeOverlays()
    setConfirmClearOpen(true)
  }

  const handleNewSession = useCallback(async () => {
    if (!api) return
    const session = await api.createChatSession(undefined, getActivePersonaId())
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    const filtered = filterSessionsForPersona(allSessions)
    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : session.id)
    setMessages(session.messages)
    setError(null)
    setShowSessionList(false)
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      await api.setCurrentChatSession(sessionId)
      const session = await api.getChatSession(sessionId)
      setCurrentSessionId(sessionId)
      setMessages(session.messages)
      setLastApiUsage(null) // 切换会话时清空真实 usage，使用估算值直到收到新的 API 响应
      setError(null)
      setShowSessionList(false)
    },
    [api],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const result = await api.deleteChatSession(sessionId)
      const filtered = filterSessionsForPersona(result.sessions)
      setSessions(filtered)
      let nextId =
        filtered.some((s) => s.id === result.currentSessionId) ? result.currentSessionId : (filtered[0]?.id ?? null)
      if (!nextId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextId = created.id
      }
      setCurrentSessionId(nextId)
      const session = await api.getChatSession(nextId)
      setMessages(session.messages)
      setError(null)
      setShowSessionList(false)
    },
    [api, filterSessionsForPersona, getActivePersonaId],
  )

  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      if (!api) return
      await api.renameChatSession(sessionId, name)
      const { sessions: allSessions } = await api.listChatSessions()
      setSessions(filterSessionsForPersona(allSessions))
      setEditingSessionId(null)
      setEditingSessionName('')
    },
    [api, filterSessionsForPersona],
  )

  const handleMessageContextMenu = useCallback((e: React.MouseEvent, messageId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setSessionContextMenu(null)
    setContextMenu({ messageId, x: e.clientX, y: e.clientY })
  }, [])

  const handleChatRootContextMenu = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    if (el.closest('.ndp-msg-row')) return
    if (el.closest('.ndp-session-list')) return
    if (el.closest('.ndp-context-menu')) return
    e.preventDefault()
    setContextMenu(null)
    setSessionContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const runQuickExtract = useCallback(async () => {
    if (!api) return
    if (!currentSessionId) return

    const settings = settingsRef.current
    const mem = settings?.memory
    if (!mem?.enabled) {
      window.alert('记忆功能已关闭，请先在设置中开启。')
      return
    }
    if (!settings?.ai) {
      window.alert('AI 服务未配置，请先在设置中配置 API Key。')
      return
    }

    if (autoExtractRunningRef.current[currentSessionId]) {
      window.alert('正在提炼中，请稍后再试。')
      return
    }
    autoExtractRunningRef.current[currentSessionId] = true

    let attemptAt = 0
    let effectiveCount = 0
    try {
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )

      const useCustomAi = !!mem.autoExtractUseCustomAi
      const base = settings.ai
      const extractAiSettings = useCustomAi
        ? {
            ...base,
            apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
            hasApiKey: mem.hasAutoExtractAiApiKey || base.hasApiKey,
            baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
            model: mem.autoExtractAiModel?.trim() || base.model,
            temperature:
              typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                ? mem.autoExtractAiTemperature
                : base.temperature,
            maxTokens:
              typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                ? mem.autoExtractAiMaxTokens
                : base.maxTokens,
          }
        : base

      const ai = new AIService(
        extractAiSettings,
        useCustomAi ? { kind: 'memory-auto-extract' } : { kind: 'main' },
      )

      const session = await api.getChatSession(currentSessionId)
      attemptAt = Date.now()
      const effective = collapseAssistantRuns(session.messages)
      effectiveCount = effective.length
      if (effectiveCount < 4) {
        window.alert('对话内容太少，暂时不需要总结。')
        return
      }

      const tail = sliceTail(effective, maxEffective)
      const conversation = tail
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n\n')
        .trim()
      if (!conversation) {
        window.alert('对话内容为空，无法总结。')
        return
      }

      const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。
规则：1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。4) 如果没有值得记的内容，返回空数组 []。5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。
输出格式：[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]
说明：scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

      const res = await ai.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
      ])
      if (res.error) {
        const msg = `一键总结失败：${res.error}`
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const parseJsonArray = (text: string): unknown[] | null => {
        const cleaned = (text ?? '').trim()
        if (!cleaned) return null
        try {
          const parsed = JSON.parse(cleaned)
          return Array.isArray(parsed) ? parsed : null
        } catch {
          const start = cleaned.indexOf('[')
          const end = cleaned.lastIndexOf(']')
          if (start < 0 || end < 0 || end <= start) return null
          const slice = cleaned.slice(start, end + 1)
          try {
            const parsed = JSON.parse(slice)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            return null
          }
        }
      }

      const arr = parseJsonArray(res.content)
      if (!arr) {
        const msg = '一键总结失败：无法解析模型输出（不是 JSON 数组）。'
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const uniq = new Set<string>()
      const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        const obj = it as Record<string, unknown>
        const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
        const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
        const content = typeof obj.content === 'string' ? obj.content.trim() : ''
        if (!content) continue
        const normalized = content.replace(/\s+/g, ' ').trim()
        if (!normalized) continue
        if (normalized.length > 140) continue
        if (uniq.has(`${scope}::${normalized}`)) continue
        uniq.add(`${scope}::${normalized}`)
        items.push({ scope, content: normalized })
      }

      if (items.length === 0) {
        window.alert('模型没有返回可写入的长期记忆（空数组或无有效条目）。')
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: '',
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
        ? (consoleSettings.personaId || session.personaId || 'default')
        : (session.personaId || 'default')
      const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'

      for (const it of items) {
        const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
        await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
      }
      await api.setChatAutoExtractMeta(currentSessionId, {
        autoExtractCursor: effectiveCount,
        autoExtractLastRunAt: attemptAt,
        autoExtractLastWriteCount: items.length,
        autoExtractLastError: '',
      })
      refreshSessions().catch(() => undefined)
      setError(null)
      window.alert(`已写入 ${items.length} 条长期记忆。`)
    } catch (err) {
      const msg = `一键总结失败：${err instanceof Error ? err.message : String(err)}`
      console.error(err)
      setError(msg)
      window.alert(msg)
      try {
        await api.setChatAutoExtractMeta(currentSessionId, {
          ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
          autoExtractLastRunAt: attemptAt || Date.now(),
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
      } catch (_) {
        /* ignore */
      }
    } finally {
      autoExtractRunningRef.current[currentSessionId] = false
      setSessionContextMenu(null)
    }
  }, [api, currentSessionId, refreshSessions])

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      setContextMenu(null)
      await api.deleteChatMessage(currentSessionId, messageId)
      await refreshSessions()
    },
    [api, currentSessionId, refreshSessions],
  )

  const handleStartEdit = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      const editText =
        msg.role === 'assistant' && Array.isArray(msg.blocks) && msg.blocks.length > 0
          ? joinTextBlocks(normalizeMessageBlocks(msg)) || String(msg.content ?? '')
          : String(msg.content ?? '')
      setEditingMessageId(messageId)
      setEditingMessageContent(editText)
      setContextMenu(null)
    },
    [messages],
  )

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!api || !currentSessionId || !editingMessageId) return
    const nextContent = String(editingMessageContent ?? '')
    const target = messages.find((m) => m.id === editingMessageId)
    if (!target) return
    const isAssistant = target.role === 'assistant'
    const nextBlocks: ChatMessageBlock[] | undefined = isAssistant ? [{ type: 'text', text: nextContent }] : undefined

    setMessages((prev) =>
      prev.map((m) =>
        m.id === editingMessageId
          ? {
              ...m,
              content: nextContent,
              ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
              updatedAt: Date.now(),
            }
          : m,
      ),
    )
    await api.updateChatMessageRecord(currentSessionId, editingMessageId, {
      content: nextContent,
      ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
    })
    await refreshSessions()
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [api, currentSessionId, editingMessageId, editingMessageContent, messages, refreshSessions])

  const handleResend = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      if (isLoadingRef.current) interrupt()

      const msgIndex = messages.findIndex((m) => m.id === messageId)
      if (msgIndex === -1) return

      let userIndex = msgIndex
      if (messages[msgIndex].role === 'assistant') {
        for (let i = msgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            userIndex = i
            break
          }
        }
      }

      const userMsg = messages[userIndex]
      if (!userMsg || userMsg.role !== 'user') return

      // 重新生成：优先复用 send() 全链路（规划器 + 工具 + 流式/TTS），确保能触发工具
      try {
        setContextMenu(null)
        setError(null)

        const baseMessages = messages.slice(0, userIndex)
        setMessages(baseMessages)
        await api.setChatMessages(currentSessionId, baseMessages)

        const rawText = String(userMsg.content ?? '').trim()
        const hasText = rawText.replace(/\[[^\]]+\]/g, '').trim().length > 0
        const resendText = hasText ? rawText : ''
        const resendAttachmentsRaw =
          Array.isArray(userMsg.attachments) && userMsg.attachments.length > 0
            ? userMsg.attachments
            : [
                ...(userMsg.imagePath ? [{ kind: 'image' as const, path: userMsg.imagePath }] : []),
                ...(userMsg.videoPath ? [{ kind: 'video' as const, path: userMsg.videoPath }] : []),
              ]
        const resendAttachments = resendAttachmentsRaw
          .map((a) => {
            const kind = (a as { kind?: unknown }).kind === 'video' ? ('video' as const) : ('image' as const)
            const path = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
            const resourceId =
              typeof (a as { resourceId?: unknown }).resourceId === 'string'
                ? String((a as { resourceId: string }).resourceId).trim()
                : ''
            const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
            return { kind, path, ...(resourceId ? { resourceId } : {}), ...(filename ? { filename } : {}) }
          })
          .filter((a) => a.path.length > 0)
        await send({ text: resendText, attachments: resendAttachments, source: 'manual', baseMessages })
        return
      } catch (err) {
        console.error('[Resend] fallback legacy resend:', err)
      }

      const aiService = getAIService()
      if (!aiService) {
        setError('AI 服务未初始化，请先配置 AI 设置')
        return
      }

      setContextMenu(null)
      setError(null)
      setIsLoading(true)
      isLoadingRef.current = true
      sendBubblePreview({ placeholder: true, text: '思考中…', autoHideDelay: 0 })
      const abort = new AbortController()
      aiAbortRef.current = abort
      try {
        api.stopTtsAll()
      } catch (_) {
        /* ignore */
      }

      const truncated = messages.slice(0, userIndex + 1)
      setMessages(truncated)
      await api.setChatMessages(currentSessionId, truncated)

      try {
        let chatHistory: ChatMessage[] = truncated.map((m) => {
          if (m.role !== 'user') return { role: 'assistant', content: m.content }

          if (m.image && canUseVision) {
            const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
            const text = m.content === '[图片]' ? '' : m.content
            if (text.trim().length > 0) parts.push({ type: 'text', text })
            parts.push({ type: 'image_url', image_url: { url: m.image } })
            return { role: 'user', content: parts }
          }

          const plain = m.content.trim().length > 0 ? m.content : '[图片]'
          return { role: 'user', content: plain }
        })

        let systemAddon = ''
        try {
          const memEnabled = settings?.memory?.enabled ?? true
          if (!memEnabled) throw new Error('memory disabled')
          const queryText = userMsg.content.trim()
          if (queryText.length > 0) {
            const personaId = getActivePersonaId()
            const res = await api.retrieveMemory({
              personaId,
              query: queryText,
              limit: 12,
              maxChars: 3200,
              includeShared: settings?.memory?.includeSharedOnRetrieve ?? true,
            })
            systemAddon = removeDuplicatedPersonaFromMemoryAddon(res.addon?.trim() ?? '')
          }
        } catch (_) {
          systemAddon = ''
        }
        {
          const worldBookAddon = buildWorldBookAddon(settingsRef.current ?? settings, getActivePersonaId())
          systemAddon = [personaSystemAddon, systemAddon.trim(), worldBookAddon.trim()].filter(Boolean).join('\n\n')
        }

        {
          const prepared = await maybeCompressChatHistoryToMaxContext(aiService, chatHistory, systemAddon, {
            signal: abort.signal,
            notify: true,
            reason: 'chat-regenerate',
          })
          chatHistory = prepared.history
        }

        const enableChatStreaming = settings?.ai?.enableChatStreaming ?? false
        const ttsSegmented = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)

        if (ttsSegmented) {
          const utteranceId = newMessageId()
          setTtsPendingUtteranceId(utteranceId)
          setTtsRevealedSegments((prev) => ({ ...prev, [utteranceId]: 0 }))

          try {
            const assistantCreatedAt = Date.now()
            let created = false
            let acc = ''
            let pending = ''
            let lastExpression: string | undefined
            let lastMotion: string | undefined
            let sentSegments = 0

            const ensureMessageCreated = (content: string) => {
              if (created) return
              created = true
              const assistantMessage: ChatMessageRecord = {
                id: utteranceId,
                role: 'assistant',
                content,
                createdAt: assistantCreatedAt,
              }
              setMessages((prev) => [...prev, assistantMessage])
              api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              setTtsSegmentedMessageFlags((prev) => ({ ...prev, [utteranceId]: true }))
              ttsUtteranceMetaRef.current[utteranceId] = {
                sessionId: currentSessionId,
                createdAt: assistantCreatedAt,
                messageId: utteranceId,
                displayedSegments: 0,
                fallbackContent: content,
              }
            }

            const enqueueStableSegments = (displayText: string, forceAll: boolean) => {
              const display = normalizeAssistantDisplayText(displayText)
              const segs = splitTextIntoTtsSegments(display, { lang: 'zh', textSplitMethod: 'cut5' })
              const stableCount = countStableTtsSegments(display, segs, forceAll)
              if (stableCount <= sentSegments) {
                if (created) {
                  setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: display } : m)))
                  ttsUtteranceMetaRef.current[utteranceId].fallbackContent = display
                }
                return
              }

              const nextSegs = segs.slice(sentSegments, stableCount)
              if (nextSegs.length === 0) return

              ensureMessageCreated(display)
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: display } : m)))
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = display

              api.enqueueTtsUtterance({
                utteranceId,
                mode: sentSegments === 0 ? 'replace' : 'append',
                segments: nextSegs,
                fullText: undefined,
              })
              sentSegments = stableCount
            }

            const flush = () => {
              if (!pending) return
              const appended = pending
              acc += pending
              pending = ''

              const display = normalizeAssistantDisplayText(acc)

              const tags = extractTailLive2DTags(acc, appended.length)
              if (tags.expression && tags.expression !== lastExpression) {
                lastExpression = tags.expression
                api.triggerExpression(tags.expression)
              }
              if (tags.motion && tags.motion !== lastMotion) {
                lastMotion = tags.motion
                api.triggerMotion(tags.motion, 0)
              }

              enqueueStableSegments(display, false)
            }

            const flushThrottle = createStreamFlushThrottle(flush)

            const response = enableChatStreaming
              ? await aiService.chatStream(chatHistory, {
                  signal: abort.signal,
                  systemAddon,
                  onDelta: (delta) => {
                    pending += delta
                    flushThrottle.schedule()
                  },
                })
              : await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

            flushThrottle.finalize()

            if (response.error) {
              if (response.error === ABORTED_ERROR) {
                try {
                  api.stopTtsAll()
                } catch {
                  /* ignore */
                }
                setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
                setTtsRevealedSegments((prev) => {
                  const next = { ...prev }
                  delete next[utteranceId]
                  return next
                })
                // aborted：保留已生成的部分（若已创建 message），但不再走分句控制
                if (created) {
                  setTtsSegmentedMessageFlags((prev) => {
                    const next = { ...prev }
                    delete next[utteranceId]
                    return next
                  })
                }
                return
              }
              const errUi = formatAiErrorForUser(response.error)
              setError(errUi.message)
              if (errUi.shouldAlert) window.alert(errUi.message)
              try {
                api.stopTtsAll()
              } catch {
                /* ignore */
              }
              setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
              setTtsRevealedSegments((prev) => {
                const next = { ...prev }
                delete next[utteranceId]
                return next
              })
              const msg: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: `[错误] ${response.error}`,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, msg])
              await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
              return
            }

            const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
            // 更新真实的 API usage 统计
            if (response.usage) setLastApiUsage(response.usage)
            if (!created) {
              ensureMessageCreated(finalContent)
            } else {
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: finalContent } : m)))
              api.updateChatMessage(currentSessionId, utteranceId, finalContent).catch(() => undefined)
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = finalContent
            }

            enqueueStableSegments(finalContent, true)
            api.finalizeTtsUtterance(utteranceId)

            if (response.expression) api.triggerExpression(response.expression)
            if (response.motion) api.triggerMotion(response.motion, 0)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg)
            setTtsPendingUtteranceId((prev) => (prev === utteranceId ? null : prev))
            setTtsRevealedSegments((prev) => {
              const next = { ...prev }
              delete next[utteranceId]
              return next
            })
            const assistantMessage: ChatMessageRecord = {
              id: newMessageId(),
              role: 'assistant',
              content: `[错误] ${msg}`,
              createdAt: Date.now(),
            }
            setMessages((prev) => [...prev, assistantMessage])
            await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          }

          return
        }

        if (enableChatStreaming) {
          const assistantId = newMessageId()
          let created = false
          const createdAt = Date.now()
          let acc = ''
          let pending = ''
          let lastExpression: string | undefined
          let lastMotion: string | undefined

          const ensureMessageCreated = () => {
            if (created) return
            created = true
            const assistantMessage: ChatMessageRecord = {
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt,
            }
            setMessages((prev) => [...prev, assistantMessage])
            api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          }

          const flush = () => {
            if (!pending) return
            const appended = pending
            acc += pending
            pending = ''
            if (!created) ensureMessageCreated()
            const display = normalizeAssistantDisplayText(acc)
            if (display.trim()) sendBubblePreview({ text: display, autoHideDelay: 0 })
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)))

            const tags = extractTailLive2DTags(acc, appended.length)
            if (tags.expression && tags.expression !== lastExpression) {
              lastExpression = tags.expression
              api.triggerExpression(tags.expression)
            }
            if (tags.motion && tags.motion !== lastMotion) {
              lastMotion = tags.motion
              api.triggerMotion(tags.motion, 0)
            }
          }
          const flushThrottle = createStreamFlushThrottle(flush)

          const response = await aiService.chatStream(chatHistory, {
            signal: abort.signal,
            systemAddon,
            onDelta: (delta) => {
              pending += delta
              flushThrottle.schedule()
            },
          })
          flushThrottle.finalize()

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              sendBubblePreview({ clear: true }, { force: true })
              return
            }
            const partialForUi = normalizeAssistantDisplayText(response.content || acc, { trim: true })
            if (partialForUi) sendBubblePreview({ text: partialForUi, autoHideDelay: 0 })
            else sendBubblePreview({ clear: true }, { force: true })
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            const nextContent = buildInterruptedStreamContent(partialForUi, response.error)
            if (created) {
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
              await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
            } else {
              const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
              setMessages((prev) => [...prev, msg])
              await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
            }
            return
          }

          const finalContent = normalizeAssistantDisplayText(response.content, { trim: true })
          // 更新真实的 API usage 统计
          if (response.usage) setLastApiUsage(response.usage)
          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalContent } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, finalContent).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: finalContent, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }

          if (finalContent.trim()) sendBubblePreview({ text: finalContent, autoHideDelay: 0 })
          if (finalContent) api.sendBubbleMessage(finalContent)
          void runAutoExtractIfNeeded(currentSessionId)
          return
        }

        const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
        if (response.error) {
          if (response.error === ABORTED_ERROR) return
          sendBubblePreview({ clear: true }, { force: true })
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const assistantMessage: ChatMessageRecord = {
            id: newMessageId(),
            role: 'assistant',
            content: `[错误] ${response.error}`,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage)
          return
        }

        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: response.content,
          createdAt: Date.now(),
        }
        // 更新真实的 API usage 统计
        if (response.usage) setLastApiUsage(response.usage)
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)

        if (response.expression) api.triggerExpression(response.expression)
        if (response.motion) api.triggerMotion(response.motion, 0)
        if (response.content?.trim()) sendBubblePreview({ text: response.content, autoHideDelay: 0 })
        if (response.content) api.sendBubbleMessage(response.content)
        void runAutoExtractIfNeeded(currentSessionId)
      } catch (err) {
        sendBubblePreview({ clear: true }, { force: true })
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${errorMessage}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
      } finally {
        if (aiAbortRef.current === abort) aiAbortRef.current = null
        isLoadingRef.current = false
        setIsLoading(false)
        refreshSessions().catch(() => undefined)
      }
    },
    [
      api,
      canUseVision,
      currentSessionId,
      getActivePersonaId,
      interrupt,
      messages,
      send,
      newMessageId,
      personaSystemAddon,
      removeDuplicatedPersonaFromMemoryAddon,
      refreshSessions,
      sendBubblePreview,
      settings,
      runAutoExtractIfNeeded,
      maybeCompressChatHistoryToMaxContext,
      formatAiErrorForUser,
    ],
  )

  const handleRerollImageGenerate = useCallback(
    async (
      inputPreview: string,
      ctx?: { taskId?: string; runId?: string; messageId?: string; oldImagePaths?: string[] },
    ): Promise<string[]> => {
      if (!api) return []

      // reroll 成功后把新图写回原任务 toolRun 与消息附件，否则 AI“看图”收集到的仍是旧图，
      // 且重启后工具卡预览也会回退到旧图（此前新图只存在组件临时 state 里）
      const persistRerolledImages = async (nextPaths: string[]) => {
        if (!ctx || nextPaths.length === 0) return
        const taskId = String(ctx.taskId ?? '').trim()
        const runId = String(ctx.runId ?? '').trim()
        const messageId = String(ctx.messageId ?? '').trim()
        if (taskId && runId) await api.updateTaskToolRunImages(taskId, runId, nextPaths).catch(() => undefined)

        const sessionId = currentSessionId
        if (!messageId || !sessionId) return
        const source = messagesRef.current.find((x) => x.id === messageId)
        if (!source) return
        const oldSet = new Set((ctx.oldImagePaths ?? []).map((p) => canonicalizeLocalImagePath(p)).filter(Boolean))
        const kept = (Array.isArray(source.attachments) ? source.attachments : []).filter(
          (a) => !(a?.kind === 'image' && oldSet.has(canonicalizeLocalImagePath(a.path))),
        )
        const attachments = [...nextPaths.map((p) => ({ kind: 'image' as const, path: p })), ...kept]
        const patch: Partial<ChatMessageRecord> = { attachments }
        if (source.imagePath && oldSet.has(canonicalizeLocalImagePath(source.imagePath))) patch.imagePath = nextPaths[0]
        setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, ...patch } : x)))
        await api.updateChatMessageRecord(sessionId, messageId, patch).catch(() => undefined)
      }

      const raw = String(inputPreview ?? '').trim()
      if (!raw) return []
      let parsed: unknown = raw
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        const first = raw.indexOf('{')
        const last = raw.lastIndexOf('}')
        if (first >= 0 && last > first) {
          try {
            parsed = JSON.parse(raw.slice(first, last + 1)) as unknown
          } catch {
            parsed = raw
          }
        }
      }

      const inputForTool =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>), seed: -1 }
          : { prompt: String(parsed ?? raw), seed: -1 }
      const prompt = typeof inputForTool.prompt === 'string' ? inputForTool.prompt.trim() : ''
      if (!prompt) {
        setError('无法重新生成：上一轮 image.generate 输入里没有可复用的 prompt。')
        return []
      }

      try {
        const created = await api.createTask({
          queue: 'other',
          title: '重新生成图片',
          why: '用户点击图片卡片重新 roll',
          steps: [{ title: '重新生成图片', tool: 'image.generate', input: JSON.stringify({ ...inputForTool, nSamples: 1 }) }],
        })
        const startedAt = Date.now()
        while (Date.now() - startedAt < 10 * 60 * 1000) {
          const latest = await api.getTask(created.id).catch(() => null)
          const runs = Array.isArray(latest?.toolRuns) ? latest.toolRuns : []
          const imageRun = [...runs].reverse().find((run) => run.toolName === 'image.generate')
          if (latest?.status === 'done') {
            const nextPaths = Array.isArray(imageRun?.imagePaths) ? imageRun.imagePaths.filter(Boolean).slice(0, 1) : []
            await persistRerolledImages(nextPaths)
            return nextPaths
          }
          if (latest?.status === 'failed' || latest?.status === 'canceled') {
            const msg = imageRun?.error || latest.lastError || '重新生成失败'
            throw new Error(msg)
          }
          await new Promise((resolve) => window.setTimeout(resolve, 900))
        }
        throw new Error('重新生成超时')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return []
      }
    },
    [api, currentSessionId],
  )

  const chatStyle = useMemo(() => {
    const ui = settings?.chatUi
    const bgImage = ui?.backgroundImage?.trim() ?? ''
    const imgOpacity = Math.max(0, Math.min(1, ui?.backgroundImageOpacity ?? 0.6))
    const overlay = bgImage ? 1 - imgOpacity : 0

    return {
      ['--ndp-chat-bg' as unknown as string]: ui?.background ?? 'rgba(20, 20, 24, 0.45)',
      ['--ndp-user-bubble-bg' as unknown as string]: ui?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)',
      ['--ndp-assistant-bubble-bg' as unknown as string]: ui?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)',
      ['--ndp-bubble-radius' as unknown as string]: `${ui?.bubbleRadius ?? 14}px`,
      backgroundImage: bgImage
        ? `linear-gradient(rgba(0,0,0,${overlay}), rgba(0,0,0,${overlay})), url(${bgImage})`
        : undefined,
      backgroundSize: bgImage ? 'cover' : undefined,
      backgroundPosition: bgImage ? 'center' : undefined,
      backgroundRepeat: bgImage ? 'no-repeat' : undefined,
    } as CSSProperties
  }, [settings?.chatUi])

  return (
    <div
      className="ndp-chat-root"
      style={chatStyle}
      onContextMenu={handleChatRootContextMenu}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.ndp-session-list')) return
        if ((e.target as HTMLElement).closest('.ndp-context-menu')) return
        if ((e.target as HTMLElement).closest('.ndp-chat-popover')) return
        if ((e.target as HTMLElement).closest('.ndp-chat-status-drawer')) return
        if ((e.target as HTMLElement).closest('.ndp-dialog-backdrop')) return
        closeOverlays()
      }}
    >
      <ContextUsageOrb
        enabled={chatOrbEnabled}
        usage={chatContextUsage}
        position={{ x: chatOrbX, y: chatOrbY }}
        onPositionChange={(next) => api?.setChatUiSettings({ contextOrbX: next.x, contextOrbY: next.y })}
      />
      <header className="ndp-chat-header">
        <button className="ndp-session-name" onMouseDown={(event) => event.stopPropagation()} onClick={() => setShowSessionList((v) => !v)} title="对话管理">
          <span>{currentSession?.name ?? '新对话'}</span>
          <span className={`ndp-session-arrow ${showSessionList ? 'open' : ''}`}>▾</span>
        </button>
        <div className="ndp-chat-header-actions">
          <button className="ndp-chat-header-command" onClick={() => void handleNewSession()} title="新对话" aria-label="新对话">
            <span aria-hidden="true">＋</span>
            <span className="ndp-chat-header-command-label">新对话</span>
          </button>
          <button
            type="button"
            className={`ndp-chat-status-button ${isAssistantOutputting ? 'active' : ''}`}
            aria-expanded={showStatusDetails}
            aria-controls="ndp-chat-status-details"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setShowStatusDetails((value) => !value)}
            title="运行状态"
          >
            <span className="ndp-chat-status-dot" aria-hidden="true" />
            <span>{isAssistantOutputting ? '运行中' : '空闲'}</span>
            <span className="ndp-chat-status-secondary">记忆 {memEnabled ? '开' : '关'} · 工具 {plannerEnabled ? '开' : '关'}</span>
          </button>
          <div className="ndp-chat-menu-anchor">
            <button
              className="ndp-chat-icon-button"
              onClick={() => setShowMoreMenu((value) => !value)}
              title="更多"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={showMoreMenu}
              onMouseDown={(event) => event.stopPropagation()}
            >
              ⋯
            </button>
            {showMoreMenu ? (
              <div className="ndp-chat-popover ndp-chat-more-menu" role="menu" aria-label="更多操作">
                <button type="button" role="menuitem" onClick={() => void api?.openSettings()}>
                  设置
                </button>
                <button type="button" role="menuitem" onClick={() => void api?.openMemory()}>
                  记忆管理
                </button>
                <div className="ndp-chat-menu-divider" />
                <button type="button" role="menuitem" className="danger" onClick={requestClearMessages} disabled={messages.length === 0}>
                  清空当前对话
                </button>
              </div>
            ) : null}
          </div>
          <button className="ndp-chat-icon-button ndp-btn-close" onClick={() => api?.closeCurrent()} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>
      </header>

      {showStatusDetails ? (
        <aside id="ndp-chat-status-details" className="ndp-chat-status-drawer" aria-label="运行状态">
          <div className="ndp-chat-status-drawer-header">
            <div>
              <strong>运行状态</strong>
              <span>{isAssistantOutputting ? '正在处理当前请求' : '当前没有运行中的任务'}</span>
            </div>
            <button type="button" className="ndp-chat-icon-button" onClick={() => setShowStatusDetails(false)} aria-label="关闭运行状态">
              ×
            </button>
          </div>
          <div className="ndp-chat-status-section">
            <div className="ndp-chat-status-section-title">快速开关</div>
            <div className="ndp-chat-status-controls">
          <label className="ndp-chat-mem-toggle" title="采集：写入原文到长期记忆">
            <input type="checkbox" checked={captureEnabled} onChange={(e) => void toggleCaptureEnabled(e.target.checked)} />
            采集
          </label>
          <label className="ndp-chat-mem-toggle" title="召回：检索注入到对话上下文">
            <input type="checkbox" checked={retrieveEnabled} onChange={(e) => void toggleRetrieveEnabled(e.target.checked)} />
            召回
          </label>
          <label className="ndp-chat-mem-toggle" title="自动提炼：对话达到阈值后自动写入长期记忆">
            <input
              type="checkbox"
              checked={autoExtractEnabled}
              onChange={(e) => void toggleAutoExtractEnabled(e.target.checked)}
              disabled={!memEnabled}
            />
            自动提炼
          </label>
          <label className="ndp-chat-mem-toggle" title="工具：把“想做事”的话交给规划器生成任务（可在桌宠任务面板查看进度）">
            <input
              type="checkbox"
              checked={plannerEnabled}
              onChange={(e) => void toggleTaskPlannerEnabled(e.target.checked)}
            />
            工具
          </label>
          <select
            className="ndp-select ndp-chat-mem-select"
            value={plannerMode}
            onChange={(e) => void setTaskPlannerMode(e.target.value as 'auto' | 'always')}
            disabled={!plannerEnabled}
            title="auto=仅在像“想做事”的话时触发；always=每条消息都先过规划器"
          >
            <option value="auto">auto</option>
            <option value="always">always</option>
          </select>
          <label
            className="ndp-chat-mem-toggle"
            title="工具系统：让模型直接选择并调用工具执行（更通用，但会更频繁调用 LLM）"
          >
            <input
              type="checkbox"
              checked={toolCallingEnabled}
              onChange={(e) => void toggleToolCallingEnabled(e.target.checked)}
              disabled={!plannerEnabled}
            />
            工具Agent
          </label>
          <select
            className="ndp-select ndp-chat-mem-select"
            value={toolCallingMode}
            onChange={(e) => void setToolCallingMode(e.target.value as 'auto' | 'native' | 'text')}
            disabled={!plannerEnabled || !toolCallingEnabled}
            title="auto=优先原生工具调用，失败自动降级兼容模式；native=仅原生工具调用；text=兼容模式（通常更稳）"
          >
            <option value="auto">auto</option>
            <option value="native">native</option>
            <option value="text">text</option>
          </select>
            </div>
          </div>
          <div className="ndp-chat-status-section">
            <div className="ndp-chat-status-section-title">本次会话</div>
            <dl className="ndp-chat-status-grid">
              <div><dt>有效消息</dt><dd>{effectiveCountUi}</dd></div>
              <div><dt>提炼游标</dt><dd>{cursorUi}</dd></div>
              <div title={`阈值=${everyUi}`}><dt>距离提炼</dt><dd>{memEnabled && autoExtractEnabled ? remainingUi : '-'}</dd></div>
              <div><dt>最近写入</dt><dd>{lastWriteCountUi}</dd></div>
              <div title={retrieveUi.title}><dt>记忆召回</dt><dd>{retrieveUi.text}</dd></div>
              <div title={visionUi.title}><dt>视觉回执</dt><dd>{visionUi.text}</dd></div>
              <div className="wide"><dt>上次提炼</dt><dd>{lastRunAtUi > 0 ? new Date(lastRunAtUi).toLocaleString() : '-'}</dd></div>
            </dl>
            {lastErrorUi ? (
              <div className="ndp-chat-status-error" title={lastErrorUi}>最近失败：{lastErrorPreviewUi}</div>
            ) : null}
          </div>
        </aside>
      ) : null}

      {showSessionList && (
        <div className="ndp-session-list" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ndp-session-list-header">
            <div className="ndp-session-current">{currentSession?.name ?? '对话'}</div>
            <button className="ndp-btn" onClick={handleNewSession}>
              新对话
            </button>
          </div>
          <div className="ndp-session-list-items">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`ndp-session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => handleSwitchSession(s.id)}
              >
                <div className="ndp-session-info">
                  {editingSessionId === s.id ? (
                    <input
                      className="ndp-session-rename-input"
                      value={editingSessionName}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingSessionName(e.target.value)}
                      onBlur={() => handleRenameSession(s.id, editingSessionName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSession(s.id, editingSessionName)
                        if (e.key === 'Escape') {
                          setEditingSessionId(null)
                          setEditingSessionName('')
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="ndp-session-item-name">{s.name}</span>
                      <span className="ndp-session-item-count">{s.messageCount} 条</span>
                    </>
                  )}
                </div>
                <div
                  className="ndp-session-actions"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="ndp-session-action"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingSessionId(s.id)
                      setEditingSessionName(s.name)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="ndp-session-action delete"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="ndp-chat-messages">
        {messages.length === 0 ? (
          <div className="ndp-chat-empty">
            <div className="ndp-chat-empty-kicker">{currentPersona?.name ?? '默认角色'}</div>
            <h1>开始一段新对话</h1>
            <p>
              {settings?.ai?.hasApiKey
                ? `当前模型：${settings.ai.model || '已配置模型'}`
                : '先配置模型连接，然后就可以发送第一条消息。'}
            </p>
            <div className="ndp-chat-empty-actions">
              <button className="ndp-btn ndp-btn-primary" onClick={() => void api?.openSettings('aiConnection')}>
                {settings?.ai?.hasApiKey ? '检查模型配置' : '配置模型'}
              </button>
              <button className="ndp-btn" onClick={() => void api?.openSettings('persona')}>
                选择角色
              </button>
              <button className="ndp-btn" onClick={() => void api?.openSettings('tools')}>
                导入配置
              </button>
            </div>
          </div>
        ) : null}
        {messages.map((m) => (
          <ChatMessageItem
            key={m.id}
            m={m}
            api={api}
            avatar={m.role === 'user' ? userAvatar : assistantAvatar}
            segmentedActive={m.role !== 'user' && ttsSegmentedUi && !!ttsSegmentedMessageFlags[m.id]}
            revealCount={ttsRevealedSegments[m.id]}
            tasksById={tasksById}
            isEditing={editingMessageId === m.id}
            editingContent={editingMessageId === m.id ? editingMessageContent : ''}
            editingTextareaRef={editingTextareaRef}
            onEditingContentChange={setEditingMessageContent}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={handleCancelEdit}
            onContextMenu={handleMessageContextMenu}
            onPickAvatar={pickAvatar}
            onRerollImageGenerate={handleRerollImageGenerate}
          />
        ))}
        {(settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false) && ttsPendingUtteranceId ? (
          <div className="ndp-msg-row ndp-msg-row-pet" title="生成中…">
            <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('assistant')} title="点击更换头像">
              {settings?.chatProfile?.assistantAvatar ? (
                <img src={settings.chatProfile.assistantAvatar} alt="assistant" />
              ) : (
                <span>宠</span>
              )}
            </div>
            <div className="ndp-msg ndp-msg-pet">
              <div className="ndp-msg-content ndp-muted">思考中…</div>
            </div>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </main>

      {error && (
        <div className="ndp-chat-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <footer className="ndp-chat-input">
        {pendingAttachments.length > 0 ? (
          <div className="ndp-input-previews" onMouseDown={(e) => e.stopPropagation()}>
            {pendingAttachments.map((a) => (
              <div key={a.id} className="ndp-input-preview">
                {a.kind === 'video' ? (
                  <LocalVideo api={api} videoPath={a.path} resourceId={a.resourceId} controls={false} muted playsInline preload="metadata" />
                ) : a.previewDataUrl ? (
                  <img src={a.previewDataUrl} alt="preview" />
                ) : (
                  <MmvectorImagePreview api={api} imagePath={a.path} resourceId={a.resourceId} alt="preview" />
                )}
                <div className="ndp-input-preview-meta" title={a.path}>
                  {a.filename || a.kind}
                </div>
                <button className="ndp-preview-remove" onClick={() => removePendingAttachment(a.id)} title="移除">
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="ndp-chat-input-row">
          <div className="ndp-chat-menu-anchor ndp-chat-attachment-anchor">
            <button
              type="button"
              className="ndp-chat-icon-button ndp-chat-composer-button"
              onClick={() => setShowAttachmentMenu((value) => !value)}
              title="添加附件"
              aria-label="添加附件"
              aria-haspopup="menu"
              aria-expanded={showAttachmentMenu}
              onMouseDown={(event) => event.stopPropagation()}
            >
              ＋
            </button>
            {showAttachmentMenu ? (
              <div className="ndp-chat-popover ndp-chat-attachment-menu" role="menu" aria-label="添加附件">
                <button type="button" role="menuitem" onClick={() => { setShowAttachmentMenu(false); imageInputRef.current?.click() }}>
                  图片
                </button>
                <button type="button" role="menuitem" onClick={() => { setShowAttachmentMenu(false); videoInputRef.current?.click() }}>
                  视频
                </button>
                <button type="button" role="menuitem" onClick={() => { setShowAttachmentMenu(false); attachmentInputRef.current?.click() }}>
                  图片或视频
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            ref={composerTextareaRef}
            value={input}
            onChange={(e) => {
              const next = e.target.value
              inputRef.current = next
              setInput(next)
              if ((settingsRef.current?.asr?.enabled ?? false) && !(settingsRef.current?.asr?.autoSend ?? false)) {
                syncAsrComposePreview(next)
              }
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composerComposingRef.current = true
            }}
            onCompositionEnd={() => {
              composerComposingRef.current = false
            }}
            onPaste={(e) => {
              const dt = e.clipboardData
              if (!dt) return

              const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
              if (files.length > 0) {
                e.preventDefault()
                for (const f of files) {
                  if (f.type.startsWith('image/')) void readChatImageFile(f)
                  else void readChatVideoFile(f)
                }
                return
              }

              const items = dt.items
              if (!items) return
              const mediaItems = Array.from(items).filter((it) => it.type.startsWith('image/') || it.type.startsWith('video/'))
              if (mediaItems.length === 0) return
              e.preventDefault()
              for (const item of mediaItems) {
                const file = item.getAsFile()
                if (!file) continue
                if (file.type.startsWith('image/')) void readChatImageFile(file)
                else void readChatVideoFile(file)
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
              if (files.length === 0) {
                setError('只支持拖拽图片或视频文件')
                return
              }
              for (const file of files) {
                if (file.type.startsWith('image/')) void readChatImageFile(file)
                else void readChatVideoFile(file)
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            placeholder="输入消息"
            aria-label="消息输入"
            rows={1}
          />
          <button
            className={`ndp-chat-icon-button ndp-chat-composer-button ${isAssistantOutputting ? 'ndp-btn-stop' : 'ndp-chat-send-button'}`}
            onClick={() => {
              if (isAssistantOutputting) stopAssistantOutput()
              else send()
            }}
            disabled={!isAssistantOutputting && !input.trim() && pendingAttachments.length === 0}
            title={isAssistantOutputting ? '停止当前输出' : '发送'}
            aria-label={isAssistantOutputting ? '停止当前输出' : '发送'}
          >
            <span aria-hidden="true">{isAssistantOutputting ? '■' : '↑'}</span>
          </button>
        </div>
      </footer>

      {confirmClearOpen ? (
        <div className="ndp-dialog-backdrop" onMouseDown={() => setConfirmClearOpen(false)}>
          <div
            className="ndp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ndp-clear-chat-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="ndp-clear-chat-dialog-title">清空当前对话</h2>
            <p>当前会话中的全部消息将被删除，此操作无法撤销。</p>
            <div className="ndp-dialog-actions">
              <button type="button" className="ndp-btn" onClick={() => setConfirmClearOpen(false)}>
                取消
              </button>
              <button
                ref={confirmClearButtonRef}
                type="button"
                className="ndp-btn ndp-btn-danger"
                onClick={() => {
                  setConfirmClearOpen(false)
                  void clearMessages().catch((err) => setError(err instanceof Error ? err.message : String(err)))
                }}
              >
                清空对话
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            void readChatImageFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            void readChatVideoFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={attachmentInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          for (const file of files) {
            if (!file) continue
            if (file.type.startsWith('image/')) void readChatImageFile(file)
            else if (file.type.startsWith('video/')) void readChatVideoFile(file)
          }
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={userAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ userAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />
      <input
        ref={assistantAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ assistantAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />

      {sessionContextMenu ? (
        <div className="ndp-context-menu" style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}>
          <button onClick={() => void runQuickExtract()}>一键总结（写入长期记忆）</button>
        </div>
      ) : null}

      {contextMenu ? (
        <div className="ndp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => handleResend(contextMenu.messageId)}>🔄 重新生成</button>
          <button onClick={() => handleStartEdit(contextMenu.messageId)}>✏️ 编辑</button>
          <button className="delete" onClick={() => handleDeleteMessage(contextMenu.messageId)}>
            🗑️ 删除
          </button>
        </div>
      ) : null}
    </div>
  )
}

type ChatMessageItemProps = {
  m: ChatMessageRecord
  api: ReturnType<typeof getApi> | null
  avatar: string | undefined
  segmentedActive: boolean
  revealCount: number | undefined
  tasksById: Map<string, TaskRecord>
  isEditing: boolean
  editingContent: string
  editingTextareaRef: React.RefObject<HTMLTextAreaElement>
  onEditingContentChange: (value: string) => void
  onSaveEdit: () => void | Promise<void>
  onCancelEdit: () => void
  onContextMenu: (e: React.MouseEvent, messageId: string) => void
  onPickAvatar: (kind: 'user' | 'assistant') => void
  onRerollImageGenerate: (
    inputPreview: string,
    ctx?: { taskId?: string; runId?: string; messageId?: string; oldImagePaths?: string[] },
  ) => Promise<string[]>
}

// 单条聊天消息。memo 化后，流式 setMessages 只会重渲染内容变化的那一条，
// 历史消息项在 token 级更新时全部跳过（步骤 2 性能优化的核心）。
const ChatMessageItem = memo(function ChatMessageItem(props: ChatMessageItemProps) {
  const {
    m,
    api,
    avatar,
    segmentedActive,
    revealCount,
    tasksById,
    isEditing,
    editingContent,
    editingTextareaRef,
    onEditingContentChange,
    onSaveEdit,
    onCancelEdit,
    onContextMenu,
    onPickAvatar,
    onRerollImageGenerate,
  } = props
  const isUser = m.role === 'user'
  const [imageViewer, setImageViewer] = useState<{ items: ImageViewerItem[]; index: number } | null>(null)
  const [rerollingRuns, setRerollingRuns] = useState<Record<string, true>>({})
  const [rerolledImagePaths, setRerolledImagePaths] = useState<Record<string, string[]>>({})

  const openImageViewer = useCallback(
    async (paths: string[], index: number) => {
      const cleaned = paths.map((x) => String(x ?? '').trim()).filter(Boolean)
      if (cleaned.length === 0) return
      const items = (await Promise.all(
        cleaned.map(async (raw) => {
          if (/^(https?:|data:|blob:)/i.test(raw)) return { src: raw, title: raw }
          if (api) {
            try {
              const res = await api.getChatAttachmentUrl(raw)
              if (res?.ok && typeof res.url === 'string') return { src: res.url, title: raw }
            } catch {
              /* ignore */
            }
          }
          return { src: toLocalMediaSrc(raw), title: raw }
        }),
      )).filter((item) => Boolean(item.src))
      if (items.length === 0) return
      setImageViewer({ items, index: Math.max(0, Math.min(index, items.length - 1)) })
    },
    [api],
  )


          const renderToolUseNode = (taskId: string, runId?: string): React.ReactNode => {
            const t = tasksById.get(taskId) ?? null
            if (!t) return null
            // agent.run 壳 run/step 不渲染为工具卡（旧存档里可能已写入）
            const runs = filterVisibleToolRuns(Array.isArray(t.toolRuns) ? t.toolRuns : [])
            const steps = (Array.isArray(t.steps) ? t.steps : []).filter((s) => !isAgentShellToolName(s?.tool))

            const toMediaSrc = (mediaUrl: string, mediaPath: string): string => {
              const url = String(mediaUrl ?? '').trim()
              if (url) return url
              const p = String(mediaPath ?? '').trim()
              if (!p) return ''
              if (/^(https?:|data:|blob:)/i.test(p)) return p
              return p
            }

            const parseMmvectorResults = (
              raw: string,
            ): null | {
              count?: number
              results: Array<{
                id?: number
                type?: string
                score?: number
                filename?: string
                imagePath?: string
                videoUrl?: string
                videoPath?: string
              }>
            } => {
              const text = String(raw ?? '').trim()
              if (!text) return null
              const first = text.indexOf('{')
              const last = text.lastIndexOf('}')
              if (first < 0 || last <= first) return null
              try {
                const parsed = (() => {
                  try {
                    return JSON.parse(text) as unknown
                  } catch {
                    return JSON.parse(text.slice(first, last + 1)) as unknown
                  }
                })()
                const obj = parsed
                if (!obj || typeof obj !== 'object') return null
                const ok = (obj as { ok?: unknown }).ok
                if (ok !== true) return null
                const results = (obj as { results?: unknown }).results
                if (!Array.isArray(results)) return null
                return {
                  count: typeof (obj as { count?: unknown }).count === 'number' ? (obj as { count: number }).count : undefined,
                  results: results as Array<{
                    id?: number
                    type?: string
                    score?: number
                    filename?: string
                    videoUrl?: string
                    videoPath?: string
                  }>,
                }
              } catch {
                return null
              }
            }

            const renderRun = (r: (typeof runs)[number], idx: number): React.ReactNode => {
              const progress = runs.length > 1 ? `${idx + 1}/${runs.length}` : ''
              const pillStatus = r.status === 'error' ? 'failed' : r.status
              const runKey = String(r.id ?? `${idx}`)
              const rerolling = rerollingRuns[runKey] === true
              const rerollForRun = async () => {
                if (!r.inputPreview || rerolling) return
                setRerollingRuns((prev) => ({ ...prev, [runKey]: true }))
                try {
                  const nextPaths = await onRerollImageGenerate(r.inputPreview, {
                    taskId,
                    runId: String(r.id ?? ''),
                    messageId: m.id,
                    oldImagePaths: Array.isArray(r.imagePaths) ? r.imagePaths.filter(Boolean) : [],
                  })
                  if (nextPaths.length > 0) setRerolledImagePaths((prev) => ({ ...prev, [runKey]: nextPaths }))
                } finally {
                  setRerollingRuns((prev) => {
                    const next = { ...prev }
                    delete next[runKey]
                    return next
                  })
                }
              }
              const isPreviewableToolImagePath = (raw: string): boolean => {
                const s = String(raw ?? '').trim()
                if (!s) return false
                if (/^data:image\//i.test(s)) return true
                if (/^blob:/i.test(s)) return true
                if (/^file:\/\//i.test(s)) return true
                if (/^https?:\/\//i.test(s)) return /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(s)
                if (/^\/\//.test(s)) return false
                if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(s)) return false
                return true
              }
              const rawToolImagePaths = rerolledImagePaths[runKey] ?? r.imagePaths
              const toolImagePaths = Array.isArray(rawToolImagePaths)
                ? Array.from(
                    new Set(
                      rawToolImagePaths
                        .map((x) => String(x ?? '').trim())
                        .filter((x) => x && isPreviewableToolImagePath(x)),
                    ),
                  ).slice(0, r.toolName === 'image.generate' ? 1 : 8)
                : []
              const mm = r.outputPreview ? parseMmvectorResults(r.outputPreview) : null
              const mmMedia =
                mm?.results?.filter((x) => {
                  const t = String(x?.type ?? '')
                  if (t === 'video') return String(x?.videoUrl ?? '').trim() || String(x?.videoPath ?? '').trim()
                  if (t === 'image') return String(x?.imagePath ?? '').trim()
                  return false
                }) ?? []
              return (
                <>
                  {toolImagePaths.length > 0 ? (
                    <div className="ndp-mmvector-results">
                      <div className="ndp-mmvector-title">工具输出图片（可预览）</div>
                      <div className="ndp-mmvector-grid">
                        {toolImagePaths.map((imgPath, imgIdx) => (
                          <div key={`tool-img-${String(r.id ?? `${idx}`)}-${imgIdx}`} className="ndp-mmvector-item">
                            <div
                              className="ndp-mmvector-image-hit"
                              onClick={() => void openImageViewer(toolImagePaths, imgIdx)}
                              title={imgPath}
                            >
                              <MmvectorImagePreview api={api} imagePath={imgPath} alt={`tool-image-${imgIdx + 1}`} />
                            </div>
                            <div className="ndp-mmvector-meta" title={imgPath}>
                              image {imgIdx + 1}
                            </div>
                          </div>
                        ))}
                      </div>
                      {r.toolName === 'image.generate' && r.inputPreview ? (
                        <div className="ndp-mmvector-actions ndp-mmvector-actions-left">
                          <button className="ndp-btn ndp-btn-mini" type="button" disabled={rerolling} onClick={() => void rerollForRun()}>
                            {rerolling ? '正在生成' : '重新生成'}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <details key={r.id} className="ndp-tooluse">
                    <summary className="ndp-tooluse-summary">
                      <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                        DeskPet · ToolUse: {r.toolName}
                        {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
                      </span>
                    </summary>
                    <div className="ndp-tooluse-body">
                      <div className="ndp-tooluse-run">
                        <div className="ndp-tooluse-run-title">
                          <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${r.status}`}>{r.status}</span>
                          <span className="ndp-tooluse-run-name">{r.toolName}</span>
                        </div>
                        {r.inputPreview ? <div className="ndp-tooluse-run-io">in: {r.inputPreview}</div> : null}
                        {r.outputPreview ? <div className="ndp-tooluse-run-io">out: {r.outputPreview}</div> : null}
                        {r.toolName === 'image.generate' && r.inputPreview && toolImagePaths.length === 0 ? (
                          <div className="ndp-tooluse-run-actions">
                            <button className="ndp-btn ndp-btn-mini" type="button" disabled={rerolling} onClick={() => void rerollForRun()}>
                              {rerolling ? '正在生成' : '重新生成'}
                            </button>
                          </div>
                        ) : null}
                        {mmMedia.length > 0 ? (
                          <div className="ndp-mmvector-results">
                            <div className="ndp-mmvector-title">多模态结果（可预览/播放）</div>
                            <div className="ndp-mmvector-grid">
                              {mmMedia.map((it) => {
                                const isVideo = String(it.type ?? '') === 'video'
                                const src = isVideo
                                  ? toMediaSrc(String(it.videoUrl ?? ''), String(it.videoPath ?? ''))
                                  : toMediaSrc('', String(it.imagePath ?? ''))
                                if (!src) return null
                                const labelParts: string[] = []
                                if (it.filename) labelParts.push(String(it.filename))
                                if (typeof it.score === 'number' && Number.isFinite(it.score)) labelParts.push(it.score.toFixed(4))
                                const label = labelParts.join(' · ')
                                return (
                                  <div key={`mmv-${String(it.id ?? '')}-${src}`} className="ndp-mmvector-item">
                                    {isVideo ? (
                                      <LocalVideo api={api} videoPath={src} className="ndp-mmvector-video" controls preload="metadata" playsInline />
                                    ) : (
                                      <MmvectorImagePreview api={api} imagePath={String(it.imagePath ?? '')} alt={String(it.filename ?? 'image')} />
                                    )}
                                    <div className="ndp-mmvector-meta" title={src}>
                                      {label || src}
                                    </div>
                                    <div className="ndp-mmvector-actions">
                                      <button
                                        className="ndp-btn ndp-btn-mini"
                                        onClick={() => {
                                          const target = isVideo
                                            ? (String(it.videoUrl ?? '').trim() || String(it.videoPath ?? '').trim() || src)
                                            : (String(it.imagePath ?? '').trim() || src)
                                          void (async () => {
                                            const raw = String(target ?? '').trim()
                                            if (!raw) return
                                            if (/^(https?:|data:|blob:)/i.test(raw)) {
                                              window.open(raw, '_blank')
                                              return
                                            }
                                            if (api) {
                                              try {
                                                const res = await api.getChatAttachmentUrl(raw)
                                                if (res?.ok && typeof res.url === 'string') {
                                                  window.open(res.url, '_blank')
                                                  return
                                                }
                                              } catch {
                                                /* ignore */
                                              }
                                            }
                                          })()
                                        }}
                                      >
                                        打开
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                        {r.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {r.error}</div> : null}
                      </div>
                    </div>
                  </details>
                </>
              )
            }

            const renderStep = (s: TaskStepRecord, idx: number): React.ReactNode => {
              const toolName = String(s.tool ?? '').trim()
              const name = toolName || s.title
              const input = String(s.input ?? '').trim()
              const output = String(s.output ?? '').trim()
              const error = String(s.error ?? '').trim()
              const statusText = String(s.status ?? '').trim() || 'pending'
              const statusKey = statusText === 'failed' ? 'error' : statusText === 'skipped' ? 'disconnected' : statusText
              const progress = steps.length > 1 ? `${idx + 1}/${steps.length}` : ''
              const pillStatus =
                statusText === 'failed'
                  ? 'failed'
                  : statusText === 'done'
                    ? 'done'
                    : statusText === 'running'
                      ? 'running'
                      : statusText === 'paused'
                        ? 'paused'
                        : 'pending'

              return (
                <details key={s.id || `${t.id}-step-${idx}`} className="ndp-tooluse">
                  <summary className="ndp-tooluse-summary">
                    <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                      DeskPet · ToolUse: {name}
                      {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
                    </span>
                  </summary>
                  <div className="ndp-tooluse-body">
                    <div className="ndp-tooluse-run">
                      <div className="ndp-tooluse-run-title">
                        <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${statusKey}`}>{statusText}</span>
                        <span className="ndp-tooluse-run-name">{name}</span>
                      </div>
                      {input ? <div className="ndp-tooluse-run-io">in: {input}</div> : null}
                      {output ? <div className="ndp-tooluse-run-io">out: {output}</div> : null}
                      {error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {error}</div> : null}
                    </div>
                  </div>
                </details>
              )
            }

            if (runId) {
              // runId 精确指向某一次真实工具调用；匹配不到时（例如旧存档里 agent.run 壳 run 的 block）
              // 直接不渲染，避免 fallback 把全部 runs 重复渲染一遍。
              const idx = runs.findIndex((r) => String(r.id ?? '') === runId)
              return idx >= 0 ? renderRun(runs[idx], idx) : null
            }

            if (runs.length > 0) return <>{runs.map((r, idx) => renderRun(r, idx))}</>
            if (steps.length > 0) return <>{steps.map((s, idx) => renderStep(s, idx))}</>
            return null
          }

          const blocks = !isUser ? normalizeMessageBlocks(m) : []
          const hasToolBlock = !isUser && blocks.some((b) => b.type === 'tool_use')

          const attachmentsNode = (
            <ChatMessageAttachments
              message={m}
              api={api}
              hidden={hasToolBlock}
              onOpenImageViewer={openImageViewer}
            />
          )

          const imageViewerNode = imageViewer ? (
            <ImageViewer
              items={imageViewer.items}
              index={imageViewer.index}
              onIndexChange={(index) => setImageViewer((prev) => (prev ? { ...prev, index } : prev))}
              onClose={() => setImageViewer(null)}
            />
          ) : null

          if (segmentedActive && !hasToolBlock && !isEditing) {
            const segments = splitTextIntoTtsSegments(m.content, { lang: 'zh', textSplitMethod: 'cut5' })
            const effectiveReveal = typeof revealCount === 'number' ? revealCount : segments.length
            const visible = segments.slice(0, Math.max(0, Math.min(segments.length, effectiveReveal)))
            if (visible.length === 0) return null

            return (
              <>
                <div
                  key={m.id}
                  className="ndp-msg-row ndp-msg-row-pet"
                  onContextMenu={(e) => onContextMenu(e, m.id)}
                  title={new Date(m.createdAt).toLocaleString()}
                >
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => onPickAvatar('assistant')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {visible.map((seg, i) => {
                    const displaySeg = trimTrailingCommaForSegment(seg)
                    const isLast = i === visible.length - 1
                    return (
                        <div key={`${m.id}-${i}`} className="ndp-msg ndp-msg-pet">
                          <div className="ndp-msg-content">
                            {displaySeg}
                            {isLast ? (
                              <>
                                {attachmentsNode}
                              </>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                </div>
                </div>
                {imageViewerNode}
              </>
            )
          }

          return (
            <>
              <div
                key={m.id}
                className={`ndp-msg-row ${isUser ? 'ndp-msg-row-user' : 'ndp-msg-row-pet'}`}
                onContextMenu={(e) => onContextMenu(e, m.id)}
                title={new Date(m.createdAt).toLocaleString()}
              >
              {!isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => onPickAvatar('assistant')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
                </div>
              ) : null}

              <div className={`ndp-msg ndp-msg-${isUser ? 'user' : 'pet'}`}>
                {isEditing ? (
                  <div className="ndp-msg-edit">
                    <textarea
                      ref={editingTextareaRef}
                      className="ndp-inline-textarea"
                      value={editingContent}
                      rows={1}
                      onChange={(e) => onEditingContentChange(e.target.value)}
                      onInput={(e) => {
                        const el = e.currentTarget
                        el.style.height = '0px'
                        el.style.height = `${el.scrollHeight}px`
                      }}
                    />
                    <div className="ndp-msg-edit-actions">
                      <button className="ndp-btn" onClick={onSaveEdit}>
                        保存
                      </button>
                      <button className="ndp-btn" onClick={onCancelEdit}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ndp-msg-content">
                    {isUser
                      ? m.content
                      : blocks.length === 0
                        ? (() => {
                            const text = normalizeInterleavedTextSegment(String(m.content ?? ''))
                            return text ? <MarkdownMessage text={text} /> : null
                          })()
                        : (() => {
                          let toolSeen = 0
                          let statusSeen = 0
                          let textSeen = 0
                          return blocks.map((b) => {
                          if (b.type === 'text') {
                            const text = normalizeInterleavedTextSegment(String(b.text ?? ''))
                            if (!text) return null
                            const key = `${m.id}-text-${toolSeen}-${textSeen++}`
                            return <MarkdownMessage key={key} text={text} />
                          }
                          if (b.type === 'status') {
                            const text = String(b.text ?? '').trim()
                            if (!text) return null
                            return (
                              <div key={`${m.id}-status-${statusSeen++}`} className="ndp-muted">
                                {text}
                              </div>
                            )
                          }
                          if (b.type === 'tool_use') {
                            const rid = (b as { runId?: string }).runId
                            const key = rid?.trim() ? `${m.id}-tool-${rid}` : `${m.id}-tool-${b.taskId}-${toolSeen}`
                            toolSeen += 1
                            return <div key={key}>{renderToolUseNode(b.taskId, rid)}</div>
                          }
                          return null
                        })
                        })()}
                    {attachmentsNode}
                  </div>
                )}
              </div>

              {isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => onPickAvatar('user')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="user" /> : <span>我</span>}
                </div>
              ) : null}
              </div>
              {imageViewerNode}
            </>
          )
})
