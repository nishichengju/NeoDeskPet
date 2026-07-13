import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  ChatSession,
  ChatSessionSummary,
  MemoryConflictRecord,
  MemoryMetaPatch,
  MemoryOrderBy,
  MemoryRecord,
  MemoryStatus,
  MemoryVersionRecord,
  Persona,
  PersonaSummary,
} from '../../electron/types'
import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { getApi } from '../neoDeskPetApi'
import { getAIService, type ChatMessage } from '../services/aiService'

type Props = {
  api: ReturnType<typeof getApi>
  settings: AppSettings | null
}

type ExtractedMemoryItem = {
  id: string
  scope: 'persona' | 'shared'
  content: string
  checked: boolean
}

function extractJsonArray(text: string): unknown[] | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    // Try to locate a JSON array within the text
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

function buildConversationText(messages: ChatSession['messages'], maxMessages: number): string {
  const filtered = messages.filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
  const usable = filtered.slice(Math.max(0, filtered.length - maxMessages))
  return usable
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助手'
      return `${role}：${m.content.trim()}`
    })
    .join('\n\n')
}

function clampIntValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function countEffectiveMessages(messages: ChatSession['messages']): number {
  let count = 0
  let lastRole: 'user' | 'assistant' | null = null
  for (const m of messages) {
    const content = (m.content ?? '').trim()
    if (!content) continue
    if (m.role === 'assistant') {
      if (lastRole === 'assistant') continue
      lastRole = 'assistant'
      count += 1
      continue
    }
    lastRole = 'user'
    count += 1
  }
  return count
}

export function MemoryConsoleWindow(props: Props) {
  const { api, settings } = props

  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [personaId, setPersonaId] = useState<string>('default')
  const [personaDetail, setPersonaDetail] = useState<Persona | null>(null)
  const [scope, setScope] = useState<'persona' | 'shared' | 'all'>('persona')
  const [role, setRole] = useState<'user' | 'assistant' | 'note' | 'all'>('all')
  const [query, setQuery] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | 'all'>('active')
  const [pinnedFilter, setPinnedFilter] = useState<'all' | 'pinned' | 'unpinned'>('all')
  const [sourceFilter, setSourceFilter] = useState<string | 'all'>('all')
  const [memoryTypeFilter, setMemoryTypeFilter] = useState<string | 'all'>('all')
  const [orderBy, setOrderBy] = useState<MemoryOrderBy>('createdAt')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')
  const [limit, setLimit] = useState<number>(50)
  const [offset, setOffset] = useState<number>(0)
  const [total, setTotal] = useState<number>(0)
  const [items, setItems] = useState<MemoryRecord[]>([])
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const [conflictStatus, setConflictStatus] = useState<'open' | 'resolved' | 'ignored' | 'all'>('open')
  const [conflictTotal, setConflictTotal] = useState<number>(0)
  const [conflicts, setConflicts] = useState<MemoryConflictRecord[]>([])
  const [conflictLoading, setConflictLoading] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)

  const [activeRowid, setActiveRowid] = useState<number | null>(null)
  const [activeEditText, setActiveEditText] = useState<string>('')
  const [activeEditDirty, setActiveEditDirty] = useState(false)
  const [activeEditNotice, setActiveEditNotice] = useState<string | null>(null)
  const [versions, setVersions] = useState<MemoryVersionRecord[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const activeEditRef = useRef<HTMLTextAreaElement | null>(null)
  const activeEditHadFocusRef = useRef(false)
  const activeEditNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevFilterKeyRef = useRef<string>('')
  const uiHydratedRef = useRef(false)
  const skipPersistOnceRef = useRef(true)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPersistPatchRef = useRef<Partial<AppSettings['memoryConsole']> | null>(null)

  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [extractSessionId, setExtractSessionId] = useState<string | null>(null)
  const [extractMaxMessages, setExtractMaxMessages] = useState<number>(30)
  const [extractEffectiveCount, setExtractEffectiveCount] = useState<number>(0)
  const [extracted, setExtracted] = useState<ExtractedMemoryItem[]>([])
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [extractWriteToSelectedPersona, setExtractWriteToSelectedPersona] = useState(false)
  const [extractSaveScope, setExtractSaveScope] = useState<'model' | 'persona' | 'shared'>('model')

  useEffect(() => {
    if (!settings?.ai) return
    getAIService(settings.ai)
  }, [settings?.ai])

  useEffect(() => {
    if (!settings) return
    if (uiHydratedRef.current) return

    const ui = settings.memoryConsole
    const initialPersonaId = ui?.personaId?.trim() || settings.activePersonaId?.trim() || 'default'
    setPersonaId(initialPersonaId)
    setScope(ui?.scope ?? 'persona')
    setRole(ui?.role ?? 'all')
    setQuery(ui?.query ?? '')
    setStatusFilter(ui?.status ?? 'active')
    setPinnedFilter(ui?.pinned ?? 'all')
    setSourceFilter(ui?.source ?? 'all')
    setMemoryTypeFilter(ui?.memoryType ?? 'all')
    setOrderBy(ui?.orderBy ?? 'createdAt')
    setOrderDir(ui?.orderDir ?? 'desc')
    setLimit(typeof ui?.limit === 'number' && Number.isFinite(ui.limit) ? ui.limit : 50)
    setAutoRefresh(!!ui?.autoRefresh)
    setExtractSessionId(ui?.extractSessionId ?? null)
    setExtractMaxMessages(typeof ui?.extractMaxMessages === 'number' && Number.isFinite(ui.extractMaxMessages) ? ui.extractMaxMessages : 30)
    setExtractWriteToSelectedPersona(!!ui?.extractWriteToSelectedPersona)
    setExtractSaveScope(ui?.extractSaveScope ?? 'model')

    uiHydratedRef.current = true
    skipPersistOnceRef.current = true
  }, [settings])

  useEffect(() => {
    if (!api) return
    if (!settings) return
    if (!uiHydratedRef.current) return
    if (skipPersistOnceRef.current) {
      skipPersistOnceRef.current = false
      return
    }

    const ui = settings.memoryConsole
    const patch: Partial<AppSettings['memoryConsole']> = {}

    if (personaId !== ui.personaId) patch.personaId = personaId
    if (scope !== ui.scope) patch.scope = scope
    if (role !== ui.role) patch.role = role
    if (query !== ui.query) patch.query = query
    if (statusFilter !== ui.status) patch.status = statusFilter
    if (pinnedFilter !== ui.pinned) patch.pinned = pinnedFilter
    if (sourceFilter !== ui.source) patch.source = sourceFilter
    if (memoryTypeFilter !== ui.memoryType) patch.memoryType = memoryTypeFilter
    if (orderBy !== ui.orderBy) patch.orderBy = orderBy
    if (orderDir !== ui.orderDir) patch.orderDir = orderDir
    if (limit !== ui.limit) patch.limit = limit
    if (autoRefresh !== ui.autoRefresh) patch.autoRefresh = autoRefresh
    if ((extractSessionId ?? null) !== (ui.extractSessionId ?? null)) patch.extractSessionId = extractSessionId ?? null
    if (extractMaxMessages !== ui.extractMaxMessages) patch.extractMaxMessages = extractMaxMessages
    if (extractWriteToSelectedPersona !== ui.extractWriteToSelectedPersona) {
      patch.extractWriteToSelectedPersona = extractWriteToSelectedPersona
    }
    if (extractSaveScope !== ui.extractSaveScope) patch.extractSaveScope = extractSaveScope

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    if (Object.keys(patch).length === 0) return

    pendingPersistPatchRef.current = patch
    persistTimerRef.current = setTimeout(() => {
      api.setMemoryConsoleSettings(patch).catch((err) => console.error(err))
      pendingPersistPatchRef.current = null
    }, 300)

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [
    api,
    settings,
    personaId,
    scope,
    role,
    query,
    limit,
    autoRefresh,
    extractSessionId,
    extractMaxMessages,
    extractWriteToSelectedPersona,
    extractSaveScope,
    statusFilter,
    pinnedFilter,
    sourceFilter,
    memoryTypeFilter,
    orderBy,
    orderDir,
  ])

  useEffect(() => {
    return () => {
      const pending = pendingPersistPatchRef.current
      if (!api) return
      if (!pending || Object.keys(pending).length === 0) return
      try {
        api.setMemoryConsoleSettings(pending).catch((err) => console.error(err))
      } catch (_) {
        /* ignore */
      }
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    api
      .listPersonas()
      .then((rows) => setPersonas(rows))
      .catch((err) => console.error(err))
  }, [api])

  useEffect(() => {
    if (!api) return
    api
      .getPersona(personaId)
      .then((p) => setPersonaDetail(p))
      .catch(() => setPersonaDetail(null))
  }, [api, personaId])

  useEffect(() => {
    if (!api) return
    api
      .listChatSessions()
      .then((res) => {
        setSessions(res.sessions)
        setCurrentSessionId(res.currentSessionId)
        setExtractSessionId((prev) => prev ?? res.currentSessionId ?? null)
      })
      .catch((err) => console.error(err))
  }, [api])

  useEffect(() => {
    if (!api) return
    if (!extractSessionId) {
      setExtractEffectiveCount(0)
      return
    }

    let cancelled = false
    api
      .getChatSession(extractSessionId)
      .then((s) => {
        if (cancelled) return
        setExtractEffectiveCount(countEffectiveMessages(s.messages))
      })
      .catch(() => {
        if (cancelled) return
        setExtractEffectiveCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [api, extractSessionId])

  const fetchList = useCallback(
    async (nextOffset: number) => {
      if (!api) return
      if (isLoading) return

      setIsLoading(true)
      setError(null)
      try {
        const res = await api.listMemory({
          personaId,
          scope,
          role,
          query,
          status: statusFilter,
          pinned: pinnedFilter,
          source: sourceFilter,
          memoryType: memoryTypeFilter,
          orderBy,
          orderDir,
          limit,
          offset: nextOffset,
        })
        setTotal(res.total)
        setItems(res.items)
        setSelected((prev) => {
          if (prev.size === 0) return prev
          const next = new Set<number>()
          for (const row of res.items) if (prev.has(row.rowid)) next.add(row.rowid)
          return next
        })
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsLoading(false)
        if (activeEditHadFocusRef.current) {
          setTimeout(() => activeEditRef.current?.focus(), 0)
        }
      }
    },
    [
      api,
      isLoading,
      personaId,
      scope,
      role,
      query,
      statusFilter,
      pinnedFilter,
      sourceFilter,
      memoryTypeFilter,
      orderBy,
      orderDir,
      limit,
    ],
  )

  const fetchConflicts = useCallback(async () => {
    if (!api) return
    if (conflictLoading) return
    setConflictLoading(true)
    setConflictError(null)
    try {
      const res = await api.listMemoryConflicts({
        personaId,
        scope,
        status: conflictStatus,
        limit: 30,
        offset: 0,
      })
      setConflictTotal(res.total)
      setConflicts(res.items)
    } catch (err) {
      console.error(err)
      setConflictError(err instanceof Error ? err.message : String(err))
    } finally {
      setConflictLoading(false)
    }
  }, [api, conflictLoading, personaId, scope, conflictStatus])

  useEffect(() => {
    const filterKey = `${personaId}::${scope}::${role}::${query}::${statusFilter}::${pinnedFilter}::${sourceFilter}::${memoryTypeFilter}::${orderBy}::${orderDir}::${limit}`
    const prevKey = prevFilterKeyRef.current
    prevFilterKeyRef.current = filterKey
    if (prevKey && prevKey !== filterKey && offset !== 0) {
      setOffset(0)
      return
    }
    void fetchList(offset)
  }, [
    personaId,
    scope,
    role,
    query,
    statusFilter,
    pinnedFilter,
    sourceFilter,
    memoryTypeFilter,
    orderBy,
    orderDir,
    limit,
    offset,
    fetchList,
  ])

  useEffect(() => {
    void fetchConflicts()
  }, [fetchConflicts])

  useVisibleInterval(() => void fetchList(offset), 1500, autoRefresh)
  useVisibleInterval(() => void fetchConflicts(), 2000, autoRefresh)

  const activeMemory = useMemo(() => {
    if (!activeRowid) return null
    return items.find((x) => x.rowid === activeRowid) ?? null
  }, [activeRowid, items])

  useEffect(() => {
    if (!api) return
    if (!activeRowid) {
      setVersions([])
      setVersionsError(null)
      setActiveEditText('')
      setActiveEditDirty(false)
      return
    }

    if (activeMemory && !activeEditDirty) {
      setActiveEditText(activeMemory.content)
    }

    let cancelled = false
    setVersionsLoading(true)
    setVersionsError(null)
    api
      .listMemoryVersions({ rowid: activeRowid, limit: 80 })
      .then((rows) => {
        if (cancelled) return
        setVersions(rows)
      })
      .catch((err) => {
        if (cancelled) return
        console.error(err)
        setVersionsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (cancelled) return
        setVersionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [api, activeRowid, activeMemory, activeEditDirty])

  useEffect(() => {
    if (!activeRowid) return
    const t = setTimeout(() => activeEditRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [activeRowid])

  useEffect(() => {
    return () => {
      if (activeEditNoticeTimerRef.current) clearTimeout(activeEditNoticeTimerRef.current)
    }
  }, [])

  const showActiveEditNotice = useCallback((msg: string) => {
    setActiveEditNotice(msg)
    if (activeEditNoticeTimerRef.current) clearTimeout(activeEditNoticeTimerRef.current)
    activeEditNoticeTimerRef.current = setTimeout(() => setActiveEditNotice(null), 1400)
  }, [])

  const extractSessionLabel = useMemo(() => {
    if (!extractSessionId) return '未选择对话'
    const s = sessions.find((x) => x.id === extractSessionId)
    return s ? `${s.name}（${new Date(s.updatedAt).toLocaleString()}）` : extractSessionId
  }, [extractSessionId, sessions])

  const extractSessionSummary = useMemo(() => {
    if (!extractSessionId) return null
    return sessions.find((x) => x.id === extractSessionId) ?? null
  }, [extractSessionId, sessions])

  const extractEveryUi = clampIntValue(settings?.memory?.autoExtractEveryEffectiveMessages, 20, 2, 2000)
  const extractCursorUi = clampIntValue(extractSessionSummary?.autoExtractCursor ?? 0, 0, 0, 1_000_000)
  const extractDeltaUi = Math.max(0, extractEffectiveCount - extractCursorUi)
  const extractRemainingUi = Math.max(0, extractEveryUi - extractDeltaUi)
  const extractLastRunAtUi = clampIntValue(extractSessionSummary?.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
  const extractLastWriteCountUi = clampIntValue(extractSessionSummary?.autoExtractLastWriteCount ?? 0, 0, 0, 1_000_000)
  const extractLastErrorUi = (extractSessionSummary?.autoExtractLastError ?? '').trim()
  const extractLastErrorPreviewUi =
    extractLastErrorUi.length > 120 ? `${extractLastErrorUi.slice(0, 120)}…` : extractLastErrorUi

  const toggleSelected = useCallback((rowid: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowid)) next.delete(rowid)
      else next.add(rowid)
      return next
    })
  }, [])

  const selectPage = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const row of items) next.add(row.rowid)
      return next
    })
  }, [items])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const deleteSelected = useCallback(async () => {
    if (!api) return
    const rowids = Array.from(selected)
    if (rowids.length === 0) return
    if (!window.confirm(`确定删除已选 ${rowids.length} 条记忆吗？`)) return
    await api.deleteManyMemory({ rowids })
    clearSelection()
    await fetchList(offset)
  }, [api, selected, clearSelection, fetchList, offset])

  const deleteAllFiltered = useCallback(async () => {
    if (!api) return
    if (!window.confirm(`确定删除当前筛选条件下的全部记忆吗？\n（当前显示总数：${total}）`)) return
    await api.deleteMemoryByFilter({
      personaId,
      scope,
      role,
      query,
      status: statusFilter,
      pinned: pinnedFilter,
      source: sourceFilter,
      memoryType: memoryTypeFilter,
    })
    clearSelection()
    setOffset(0)
    await fetchList(0)
  }, [api, personaId, scope, role, query, statusFilter, pinnedFilter, sourceFilter, memoryTypeFilter, total, clearSelection, fetchList])

  const deleteAllPersona = useCallback(async () => {
    if (!api) return
    if (!window.confirm(`确定删除当前角色（${personaId}）的全部个人记忆吗？`)) return
    await api.deleteMemoryByFilter({
      personaId,
      scope: 'persona',
      role: 'all',
      query: '',
      status: 'all',
      pinned: 'all',
      source: 'all',
      memoryType: 'all',
    })
    clearSelection()
    setOffset(0)
    setScope('persona')
    setRole('all')
    setQuery('')
    setStatusFilter('active')
    setPinnedFilter('all')
    setSourceFilter('all')
    setMemoryTypeFilter('all')
    await fetchList(0)
  }, [api, personaId, clearSelection, fetchList])

  const deleteAllShared = useCallback(async () => {
    if (!api) return
    if (!window.confirm(`确定删除全部共享记忆吗？`)) return
    await api.deleteMemoryByFilter({
      personaId,
      scope: 'shared',
      role: 'all',
      query: '',
      status: 'all',
      pinned: 'all',
      source: 'all',
      memoryType: 'all',
    })
    clearSelection()
    setOffset(0)
    setScope('shared')
    setRole('all')
    setQuery('')
    setStatusFilter('active')
    setPinnedFilter('all')
    setSourceFilter('all')
    setMemoryTypeFilter('all')
    await fetchList(0)
  }, [api, personaId, clearSelection, fetchList])

  const applyMetaToSelected = useCallback(
    async (patch: MemoryMetaPatch, confirmText: string) => {
      if (!api) return
      const rowids = Array.from(selected)
      if (rowids.length === 0) return
      if (!window.confirm(`${confirmText}\n（已选：${rowids.length}）`)) return
      await api.updateManyMemoryMeta({ rowids, patch })
      clearSelection()
      await fetchList(offset)
    },
    [api, selected, clearSelection, fetchList, offset],
  )

  const applyMetaToFiltered = useCallback(
    async (patch: MemoryMetaPatch, confirmText: string) => {
      if (!api) return
      if (total <= 0) return
      if (!window.confirm(`${confirmText}\n（当前筛选总数：${total}）`)) return
      await api.updateMemoryByFilterMeta({
        personaId,
        scope,
        role,
        query,
        status: statusFilter,
        pinned: pinnedFilter,
        source: sourceFilter,
        memoryType: memoryTypeFilter,
        patch,
      })
      clearSelection()
      setOffset(0)
      await fetchList(0)
    },
    [
      api,
      total,
      personaId,
      scope,
      role,
      query,
      statusFilter,
      pinnedFilter,
      sourceFilter,
      memoryTypeFilter,
      clearSelection,
      fetchList,
    ],
  )

  const resolveConflict = useCallback(
    async (id: string, action: 'accept' | 'keepBoth' | 'merge' | 'ignore') => {
      if (!api) return
      try {
        const ok = action === 'ignore' ? true : window.confirm(`确定执行操作：${action}？`)
        if (!ok) return
        await api.resolveMemoryConflict({ id, action })
        await fetchConflicts()
        await fetchList(offset)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api, fetchConflicts, fetchList, offset],
  )

  const saveActiveEdit = useCallback(async () => {
    if (!api) return
    if (!activeRowid) return
    const next = activeEditText.trim()
    if (!next) return
    try {
      await api.updateMemory({ rowid: activeRowid, content: next, reason: 'memory_console_edit', source: 'memory_console' })
      setActiveEditDirty(false)
      await fetchList(offset)
      const nextVersions = await api.listMemoryVersions({ rowid: activeRowid, limit: 80 })
      setVersions(nextVersions)
      showActiveEditNotice('已保存（已生成版本）')
      activeEditRef.current?.focus()
    } catch (err) {
      console.error(err)
      showActiveEditNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [api, activeRowid, activeEditText, fetchList, offset, showActiveEditNotice])

  const rollbackVersion = useCallback(
    async (versionId: string) => {
      if (!api) return
      if (!activeRowid) return
      const ok = window.confirm('确定回滚到该版本的旧内容？（会生成一条新的版本记录）')
      if (!ok) return
      try {
        await api.rollbackMemoryVersion({ versionId })
        setActiveEditDirty(false)
        await fetchList(offset)
        const nextVersions = await api.listMemoryVersions({ rowid: activeRowid, limit: 80 })
        setVersions(nextVersions)
        showActiveEditNotice('回滚成功')
        activeEditRef.current?.focus()
      } catch (err) {
        console.error(err)
        showActiveEditNotice(`回滚失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [api, activeRowid, fetchList, offset, showActiveEditNotice],
  )

  const setMemoryEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ enabled })
    },
    [api],
  )

  const setIncludeSharedOnRetrieve = useCallback(
    async (includeSharedOnRetrieve: boolean) => {
      if (!api) return
      await api.setMemorySettings({ includeSharedOnRetrieve })
    },
    [api],
  )

  const setAutoExtractEnabled = useCallback(
    async (autoExtractEnabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ autoExtractEnabled })
    },
    [api],
  )

  const setPersonaFlags = useCallback(
    async (patch: { captureEnabled?: boolean; retrieveEnabled?: boolean }) => {
      if (!api) return
      try {
        const p = await api.updatePersona(personaId, patch)
        setPersonaDetail(p)
      } catch (err) {
        console.error(err)
      }
    },
    [api, personaId],
  )

  const runExtract = useCallback(async () => {
    if (!api) return
    if (!settings?.ai) {
      setExtractError('AI 设置未加载')
      return
    }
    if (!extractSessionId) {
      setExtractError('请选择要提炼的对话')
      return
    }
    const ai = getAIService(settings.ai)
    if (!ai) {
      setExtractError('AI 服务未初始化')
      return
    }

    setIsExtracting(true)
    setExtractError(null)
    try {
      const session = await api.getChatSession(extractSessionId)
      const maxMessages = Math.max(6, Math.min(2000, Math.trunc(extractMaxMessages)))
      const conversation = buildConversationText(session.messages, maxMessages)
      if (!conversation.trim()) {
        setExtractError('对话内容为空')
        return
      }

      const systemPrompt = `你是“长期记忆提炼器”。你的任务是从对话中提炼“长期稳定、对未来有用”的记忆条目。

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

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
      ]

      const res = await ai.chat(messages)
      if (res.error) {
        setExtractError(res.error)
        return
      }

      const arr = extractJsonArray(res.content)
      if (!arr) {
        setExtractError('无法解析模型输出的 JSON 数组')
        return
      }

      const mapped: ExtractedMemoryItem[] = []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        const obj = it as Record<string, unknown>
        const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
        const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
        const content = typeof obj.content === 'string' ? obj.content.trim() : ''
        if (!content) continue
        mapped.push({ id: `${Math.random().toString(16).slice(2)}-${mapped.length}`, scope, content, checked: true })
      }
      setExtracted(mapped.slice(0, 50))
      if (mapped.length === 0) setExtractError('模型返回为空数组或无有效条目')
    } catch (err) {
      console.error(err)
      setExtractError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExtracting(false)
    }
  }, [api, extractSessionId, extractMaxMessages, settings?.ai])

  const saveExtracted = useCallback(async () => {
    if (!api) return
    if (!extractSessionId) return
    const checked = extracted
      .filter((x) => x.checked)
      .map((x) => ({ scope: x.scope, content: x.content.trim() }))
      .filter((x) => x.content.length > 0)
    if (checked.length === 0) return

    const session = await api.getChatSession(extractSessionId)
    const targetPersonaId = extractWriteToSelectedPersona ? personaId : session.personaId

    if (
      !window.confirm(
        `确定写入 ${checked.length} 条记忆吗？\n目标人设：${targetPersonaId}\n来源对话：${extractSessionLabel}`,
      )
    ) {
      return
    }

    for (const it of checked) {
      const scopeToSave =
        extractSaveScope === 'model'
          ? it.scope
          : extractSaveScope === 'shared'
            ? 'shared'
            : 'persona'
      await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
    }

    setExtracted([])
    setExtractError(null)
    setPersonaId(targetPersonaId)
    setScope('persona')
    setRole('all')
    setQuery('')
    setStatusFilter('active')
    setPinnedFilter('all')
    setSourceFilter('all')
    setMemoryTypeFilter('all')
    setOffset(0)
    await fetchList(0)

    try {
      const effectiveCount = countEffectiveMessages(session.messages)
      await api.setChatAutoExtractMeta(extractSessionId, {
        autoExtractCursor: effectiveCount,
        autoExtractLastRunAt: Date.now(),
        autoExtractLastWriteCount: checked.length,
        autoExtractLastError: '',
      })
      const res = await api.listChatSessions()
      setSessions(res.sessions)
      setCurrentSessionId(res.currentSessionId)
    } catch (err) {
      console.error(err)
    }
  }, [
    api,
    extractSessionId,
    extracted,
    extractWriteToSelectedPersona,
    personaId,
    extractSaveScope,
    extractSessionLabel,
    fetchList,
  ])

  if (!api) {
    return (
      <div className="ndp-settings-root">
        <header className="ndp-settings-header">
          <div className="ndp-settings-title">
            <span className="ndp-settings-icon">🧠</span>
            <span>记忆控制台</span>
          </div>
          <div className="ndp-actions">
            <button className="ndp-btn ndp-btn-close" onClick={() => window.close()}>
              ×
            </button>
          </div>
        </header>
        <div className="ndp-settings-content">
          <div className="ndp-settings-section">
            <h3>错误</h3>
            <div>neoDeskPet API 不可用</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ndp-settings-root">
      <header className="ndp-settings-header">
        <div className="ndp-settings-title">
          <span className="ndp-settings-icon">🧠</span>
          <span>记忆控制台</span>
        </div>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={() => api?.openSettings()}>
            设置
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      <div className="ndp-settings-content">
        <div className="ndp-settings-section">
          <h3>全局开关</h3>
          <label className="ndp-checkbox-label">
            <input
              type="checkbox"
              checked={settings?.memory.enabled ?? true}
              onChange={(e) => void setMemoryEnabled(e.target.checked)}
            />
            <span>启用记忆（关闭后不写入也不召回）</span>
          </label>
          <label className="ndp-checkbox-label" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={settings?.memory.includeSharedOnRetrieve ?? true}
              onChange={(e) => void setIncludeSharedOnRetrieve(e.target.checked)}
            />
            <span>召回时默认包含共享记忆</span>
          </label>
          <label className="ndp-checkbox-label" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={settings?.memory.autoExtractEnabled ?? false}
              onChange={(e) => void setAutoExtractEnabled(e.target.checked)}
            />
            <span>启用自动提炼（对话超过阈值自动写入长期记忆）</span>
          </label>
        </div>

        <div className="ndp-settings-section">
          <h3>自动提炼（从对话生成长期记忆）</h3>
          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <select
              className="ndp-select"
              value={extractSessionId ?? ''}
              onChange={(e) => setExtractSessionId(e.target.value || null)}
              title={extractSessionLabel}
            >
              {currentSessionId && (
                <option value={currentSessionId}>
                  当前对话：{sessions.find((s) => s.id === currentSessionId)?.name ?? currentSessionId}
                </option>
              )}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{new Date(s.updatedAt).toLocaleDateString()}）
                </option>
              ))}
            </select>
            <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              最近消息数
              <input
                className="ndp-input"
                style={{ marginLeft: 8, width: 90 }}
                type="number"
                min={6}
                max={2000}
                value={extractMaxMessages}
                onChange={(e) => setExtractMaxMessages(Number(e.target.value))}
              />
            </label>
            <button className="ndp-btn" onClick={() => void runExtract()} disabled={isExtracting}>
              {isExtracting ? '提炼中...' : '开始提炼'}
            </button>
          </div>

          <div
            className="ndp-row"
            style={{ marginBottom: 10, fontSize: 12, color: 'rgba(255,255,255,0.72)', flexWrap: 'wrap' }}
          >
            <span title="有效消息=合并连续助手消息后的条数">有效 {extractEffectiveCount}</span>
            <span>游标 {extractCursorUi}</span>
            <span title={`阈值=${extractEveryUi}`}>
              还差 {settings?.memory.enabled && settings?.memory.autoExtractEnabled ? extractRemainingUi : '-'}
            </span>
            <span>上次 {extractLastRunAtUi > 0 ? new Date(extractLastRunAtUi).toLocaleString() : '-'}</span>
            <span>写入 {extractLastWriteCountUi}</span>
            {extractLastErrorUi ? (
              <span style={{ color: 'rgba(255,180,180,0.95)' }} title={extractLastErrorUi}>
                失败 {extractLastErrorPreviewUi}
              </span>
            ) : null}
          </div>

          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <label className="ndp-checkbox-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={extractWriteToSelectedPersona}
                onChange={(e) => setExtractWriteToSelectedPersona(e.target.checked)}
              />
              <span>写入到当前筛选人设（否则写入到对话所属人设）</span>
            </label>
            <select
              className="ndp-select"
              style={{ width: 200, marginLeft: 'auto' }}
              value={extractSaveScope}
              onChange={(e) => setExtractSaveScope(e.target.value as typeof extractSaveScope)}
              title="保存范围"
            >
              <option value="model">按模型建议（当前默认 persona）</option>
              <option value="persona">全部保存为个人</option>
              <option value="shared">全部保存为共享</option>
            </select>
            <button className="ndp-btn" onClick={() => void saveExtracted()} disabled={extracted.every((x) => !x.checked)}>
              写入已选
            </button>
          </div>

          {extractError && <div style={{ color: 'rgba(255,180,180,0.95)', whiteSpace: 'pre-wrap' }}>{extractError}</div>}

            {extracted.length > 0 && (
            <div className="ndp-memory-list" style={{ marginTop: 10 }}>
              {extracted.map((m) => (
                <div key={m.id} className="ndp-memory-item">
                  <div className="ndp-memory-meta">
                    <label className="ndp-checkbox-label" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={m.checked}
                        onChange={() =>
                          setExtracted((prev) => prev.map((x) => (x.id === m.id ? { ...x, checked: !x.checked } : x)))
                        }
                      />
                      <span>保存</span>
                    </label>
                    <span>{m.scope}</span>
                  </div>
                  <div className="ndp-memory-content">{m.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ndp-settings-section">
          <h3>筛选与刷新</h3>
          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <select className="ndp-select" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
            <select className="ndp-select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="persona">仅个人</option>
              <option value="shared">仅共享</option>
              <option value="all">个人+共享</option>
            </select>
            <select className="ndp-select" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="all">全部</option>
              <option value="user">用户</option>
              <option value="assistant">助手</option>
              <option value="note">笔记</option>
            </select>
            <label className="ndp-checkbox-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={personaDetail?.captureEnabled ?? true}
                onChange={(e) => void setPersonaFlags({ captureEnabled: e.target.checked })}
              />
              <span>采集</span>
            </label>
            <label className="ndp-checkbox-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={personaDetail?.retrieveEnabled ?? true}
                onChange={(e) => void setPersonaFlags({ retrieveEnabled: e.target.checked })}
              />
              <span>召回</span>
            </label>
          </div>

          <div className="ndp-row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as typeof statusFilter)
                setOffset(0)
              }}
              title="状态"
            >
              <option value="active">仅 active</option>
              <option value="archived">仅 archived</option>
              <option value="all">active+archived</option>
            </select>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={pinnedFilter}
              onChange={(e) => {
                setPinnedFilter(e.target.value as typeof pinnedFilter)
                setOffset(0)
              }}
              title="置顶"
            >
              <option value="all">置顶：全部</option>
              <option value="pinned">仅置顶</option>
              <option value="unpinned">仅未置顶</option>
            </select>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value as typeof sourceFilter)
                setOffset(0)
              }}
              title="来源"
            >
              <option value="all">来源：全部</option>
              <option value="user_msg">user_msg</option>
              <option value="assistant_msg">assistant_msg</option>
              <option value="auto_extract">auto_extract</option>
              <option value="manual">manual</option>
              <option value="memory_console">memory_console</option>
            </select>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={memoryTypeFilter}
              onChange={(e) => {
                setMemoryTypeFilter(e.target.value as typeof memoryTypeFilter)
                setOffset(0)
              }}
              title="类型"
            >
              <option value="all">类型：全部</option>
              <option value="semantic">semantic</option>
              <option value="episodic">episodic</option>
              <option value="profile">profile</option>
              <option value="preference">preference</option>
              <option value="task">task</option>
              <option value="other">other</option>
            </select>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={orderBy}
              onChange={(e) => {
                setOrderBy(e.target.value as typeof orderBy)
                setOffset(0)
              }}
              title="排序字段"
            >
              <option value="createdAt">createdAt</option>
              <option value="updatedAt">updatedAt</option>
              <option value="retention">retention</option>
              <option value="importance">importance</option>
              <option value="strength">strength</option>
              <option value="accessCount">accessCount</option>
              <option value="lastAccessedAt">lastAccessedAt</option>
            </select>
            <select
              className="ndp-select"
              style={{ width: 120 }}
              value={orderDir}
              onChange={(e) => {
                setOrderDir(e.target.value as typeof orderDir)
                setOffset(0)
              }}
              title="排序方向"
            >
              <option value="desc">desc</option>
              <option value="asc">asc</option>
            </select>
          </div>

          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <input
              className="ndp-input"
              placeholder="搜索（content LIKE）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setOffset(0)
              }}
            />
            <button
              className="ndp-btn"
              onClick={() => {
                setOffset(0)
                void fetchList(0)
              }}
              disabled={isLoading}
            >
              刷新
            </button>
          </div>

          <div className="ndp-row">
            <label className="ndp-checkbox-label" style={{ margin: 0 }}>
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              <span>自动刷新</span>
            </label>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>总数：{total}</div>
          </div>
        </div>

        <div className="ndp-settings-section">
          <h3>批量操作</h3>
          <div className="ndp-row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <button className="ndp-btn" onClick={selectPage} disabled={items.length === 0}>
              全选本页
            </button>
            <button className="ndp-btn" onClick={clearSelection} disabled={selected.size === 0}>
              清空选择
            </button>
          </div>

          <div className="ndp-row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToSelected({ pinned: 1, status: 'active' }, '确定置顶已选记忆吗？')}
              disabled={selected.size === 0}
            >
              置顶已选（{selected.size}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToSelected({ pinned: 0 }, '确定取消置顶已选记忆吗？')}
              disabled={selected.size === 0}
            >
              取消置顶已选（{selected.size}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToSelected({ status: 'archived' }, '确定归档已选记忆吗？')}
              disabled={selected.size === 0}
            >
              归档已选（{selected.size}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToSelected({ status: 'active' }, '确定恢复已选记忆吗？')}
              disabled={selected.size === 0}
            >
              恢复已选（{selected.size}）
            </button>
            <button className="ndp-btn" onClick={() => void deleteSelected()} disabled={selected.size === 0}>
              删除已选（{selected.size}）
            </button>
          </div>

          <div className="ndp-row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToFiltered({ pinned: 1, status: 'active' }, '确定置顶当前筛选全部记忆吗？')}
              disabled={total === 0}
            >
              置顶当前筛选全部（{total}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToFiltered({ pinned: 0 }, '确定取消置顶当前筛选全部记忆吗？')}
              disabled={total === 0}
            >
              取消置顶当前筛选全部（{total}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToFiltered({ status: 'archived' }, '确定归档当前筛选全部记忆吗？')}
              disabled={total === 0}
            >
              归档当前筛选全部（{total}）
            </button>
            <button
              className="ndp-btn"
              onClick={() => void applyMetaToFiltered({ status: 'active' }, '确定恢复当前筛选全部记忆吗？')}
              disabled={total === 0}
            >
              恢复当前筛选全部（{total}）
            </button>
            <button className="ndp-btn" onClick={() => void deleteAllFiltered()} disabled={total === 0}>
              删除当前筛选全部（{total}）
            </button>
          </div>

          <div className="ndp-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="ndp-btn" onClick={() => void deleteAllPersona()}>
              删除当前角色全部个人记忆
            </button>
            <button className="ndp-btn" onClick={() => void deleteAllShared()}>
              删除全部共享记忆
            </button>
          </div>
        </div>

        {error && (
          <div className="ndp-settings-section">
            <h3>错误</h3>
            <div style={{ whiteSpace: 'pre-wrap' }}>{error}</div>
          </div>
        )}

        <div className="ndp-settings-section">
          <h3>待处理（冲突/合并）</h3>

          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <select
              className="ndp-select"
              style={{ width: 160 }}
              value={conflictStatus}
              onChange={(e) => setConflictStatus(e.target.value as typeof conflictStatus)}
              title="状态"
            >
              <option value="open">待处理</option>
              <option value="resolved">已处理</option>
              <option value="ignored">已忽略</option>
              <option value="all">全部</option>
            </select>
            <button className="ndp-btn" onClick={() => void fetchConflicts()} disabled={conflictLoading}>
              刷新
            </button>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
              总数：{conflictTotal}
            </div>
          </div>

          {conflictError ? (
            <div style={{ color: 'rgba(255,180,180,0.95)', whiteSpace: 'pre-wrap', marginBottom: 10 }}>{conflictError}</div>
          ) : null}

          {conflicts.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.6)' }}>暂无待处理项</div>
          ) : (
            <div className="ndp-memory-list" style={{ marginTop: 10 }}>
              {conflicts.map((c) => {
                const basePreview = c.baseContent.length > 120 ? `${c.baseContent.slice(0, 120)}…` : c.baseContent
                const candPreview =
                  c.candidateContent.length > 120 ? `${c.candidateContent.slice(0, 120)}…` : c.candidateContent
                return (
                  <div key={c.id} className="ndp-memory-item">
                    <div className="ndp-memory-meta" style={{ flexWrap: 'wrap' }}>
                      <span>#{c.memoryRowid}</span>
                      <span>{c.baseScope}</span>
                      <span>{c.conflictType}</span>
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                      <span title={c.candidateSource || ''}>src:{c.candidateSource || '-'}</span>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                        <button className="ndp-btn" onClick={() => void resolveConflict(c.id, 'accept')}>
                          采用新
                        </button>
                        <button className="ndp-btn" onClick={() => void resolveConflict(c.id, 'keepBoth')}>
                          保留两条
                        </button>
                        <button className="ndp-btn" onClick={() => void resolveConflict(c.id, 'merge')}>
                          合并
                        </button>
                        <button className="ndp-btn" onClick={() => void resolveConflict(c.id, 'ignore')}>
                          忽略
                        </button>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>旧：{basePreview}</div>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>新：{candPreview}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="ndp-settings-section">
          <h3>记忆列表</h3>

          <div className="ndp-row" style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              每页
              <select
                className="ndp-select"
                style={{ marginLeft: 8, width: 120 }}
                value={String(limit)}
                onChange={(e) => {
                  setLimit(Number(e.target.value))
                  setOffset(0)
                  void fetchList(0)
                }}
              >
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
              </select>
            </label>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button
                className="ndp-btn"
                onClick={() => {
                  const next = Math.max(0, offset - limit)
                  setOffset(next)
                }}
                disabled={offset <= 0 || isLoading}
              >
                上一页
              </button>
              <button
                className="ndp-btn"
                onClick={() => {
                  const next = offset + limit
                  if (next >= total) return
                  setOffset(next)
                }}
                disabled={offset + limit >= total || isLoading}
              >
                下一页
              </button>
            </div>
          </div>

          <div className="ndp-memory-list">
            {items.map((m) => (
              <div
                key={m.rowid}
                className="ndp-memory-item"
                onClick={() => setActiveRowid(m.rowid)}
                style={
                  activeRowid === m.rowid
                    ? { outline: '1px solid rgba(120,200,255,0.65)', outlineOffset: 2 }
                    : undefined
                }
              >
                <div className="ndp-memory-meta">
                  <label className="ndp-checkbox-label" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(m.rowid)}
                      onChange={() => toggleSelected(m.rowid)}
                    />
                    <span>选择</span>
                  </label>
                  <span>#{m.rowid}</span>
                  <span>{m.scope}</span>
                  <span>{m.role ?? 'note'}</span>
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div className="ndp-memory-content">{m.content}</div>
                <div
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 10,
                    fontSize: 12,
                    color: 'rgba(255,255,255,0.55)',
                  }}
                >
                  <span>status:{m.status}</span>
                  <span>ret:{Math.round(m.retention * 100)}%</span>
                  <span>imp:{m.importance.toFixed(2)}</span>
                  <span>str:{m.strength.toFixed(2)}</span>
                  <span>hit:{m.accessCount}</span>
                  <span>last:{m.lastAccessedAt ? new Date(m.lastAccessedAt).toLocaleString() : '-'}</span>
                  <span>type:{m.memoryType || '-'}</span>
                  <span title={m.source || ''}>src:{m.source || '-'}</span>
                  {m.pinned ? <span>PIN</span> : null}
                </div>
              </div>
            ))}
            {items.length === 0 && <div style={{ color: 'rgba(255,255,255,0.6)' }}>暂无数据</div>}
          </div>
        </div>

        <div className="ndp-settings-section">
          <h3>当前记忆（编辑/版本/回滚）</h3>
          {!activeMemory ? (
            <div style={{ color: 'rgba(255,255,255,0.6)' }}>点击一条记忆查看详情</div>
          ) : (
            <div>
              <div className="ndp-row" style={{ marginBottom: 10, fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>
                <span>#{activeMemory.rowid}</span>
                <span>{activeMemory.scope}</span>
                <span>{activeMemory.role ?? 'note'}</span>
                <span>status:{activeMemory.status}</span>
                <span>src:{activeMemory.source || '-'}</span>
                <span>type:{activeMemory.memoryType || '-'}</span>
                <span style={{ marginLeft: 'auto' }}>hit:{activeMemory.accessCount}</span>
              </div>

              <textarea
                className="ndp-input"
                style={{ height: 90, whiteSpace: 'pre-wrap' }}
                ref={activeEditRef}
                value={activeEditText}
                onChange={(e) => {
                  setActiveEditText(e.target.value)
                  setActiveEditDirty(true)
                }}
                onFocus={() => {
                  activeEditHadFocusRef.current = true
                }}
                onBlur={() => {
                  activeEditHadFocusRef.current = false
                }}
              />
              <div className="ndp-row" style={{ marginTop: 8 }}>
                <button className="ndp-btn" onClick={() => void saveActiveEdit()} disabled={!activeEditDirty}>
                  保存修改（生成版本）
                </button>
                <button
                  className="ndp-btn"
                  onClick={() => {
                    if (!activeMemory) return
                    setActiveEditText(activeMemory.content)
                    setActiveEditDirty(false)
                  }}
                  disabled={!activeEditDirty}
                >
                  放弃修改
                </button>
                {activeEditNotice ? (
                  <span style={{ marginLeft: 10, fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>{activeEditNotice}</span>
                ) : null}
              </div>

              <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>
                版本历史（{versions.length}）
                {versionsLoading ? <span style={{ marginLeft: 8 }}>加载中…</span> : null}
              </div>
              {versionsError ? (
                <div style={{ marginTop: 6, color: 'rgba(255,180,180,0.95)', whiteSpace: 'pre-wrap' }}>{versionsError}</div>
              ) : null}
              {versions.length === 0 ? (
                <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.6)' }}>暂无版本记录</div>
              ) : (
                <div className="ndp-memory-list" style={{ marginTop: 10 }}>
                  {versions.map((v) => {
                    const oldPreview = v.oldContent.length > 80 ? `${v.oldContent.slice(0, 80)}…` : v.oldContent
                    const newPreview = v.newContent.length > 80 ? `${v.newContent.slice(0, 80)}…` : v.newContent
                    return (
                      <div key={v.id} className="ndp-memory-item">
                        <div className="ndp-memory-meta" style={{ flexWrap: 'wrap' }}>
                          <span>{new Date(v.createdAt).toLocaleString()}</span>
                          <span title={v.reason}>reason:{v.reason}</span>
                          <span title={v.source || ''}>src:{v.source || '-'}</span>
                          <div style={{ marginLeft: 'auto' }}>
                            <button className="ndp-btn" onClick={() => void rollbackVersion(v.id)}>
                              回滚到旧内容
                            </button>
                          </div>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>旧：{oldPreview}</div>
                        <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>新：{newPreview}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
