import './orb.css'
import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import type {
  AppSettings,
  ChatMessageBlock,
  ChatMessageRecord,
  ChatSession,
  ChatSessionSummary,
  OrbUiState,
  TaskRecord,
} from '../../electron/types'
import { getApi } from '../neoDeskPetApi'
import { ABORTED_ERROR, getAIService, type ChatMessage } from '../services/aiService'
import { MarkdownMessage } from '../components/MarkdownMessage'

type OrbMode = 'ball' | 'bar' | 'panel'
type PopoverKind = 'menu' | 'history'

const ORB_BALL_SIZE = 40
const ORB_BAR_HEIGHT = 80
const ORB_POPOVER_GAP = 10

const MENU_WIDTH = 240
const MENU_RADIUS = 16

const HISTORY_WIDTH = 320
const HISTORY_MAX_ITEMS = 8

const MSG_MENU_WIDTH = 188
const MSG_MENU_ITEM_HEIGHT = 36
const MSG_MENU_PADDING = 8
const MSG_MENU_RADIUS = 14

function normalizeMode(state: OrbUiState): OrbMode {
  if (state === 'ball') return 'ball'
  if (state === 'panel') return 'panel'
  return 'bar'
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function newMessageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function joinTextBlocks(blocks: ChatMessageBlock[]): string {
  const parts = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String((b as { text: string }).text ?? '').trim())
    .filter(Boolean)
  return parts.join('\n\n')
}

function toLocalMediaSrc(mediaPath: string): string {
  const p = String(mediaPath ?? '').trim()
  if (!p) return ''
  if (/^(https?:|file:|data:|blob:)/i.test(p)) return p
  if (/^[a-zA-Z]:[\\/]/.test(p)) return `file:///${p.replace(/\\/g, '/')}`
  if (p.startsWith('\\\\')) return `file:${p.replace(/\\/g, '/')}`
  if (p.startsWith('/')) return `file://${p}`
  return p
}

function normalizeInterleavedTextSegment(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/g, '')
    .replace(/\n+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function computeAppendDelta(prev: string, next: string): string {
  const p = String(prev ?? '')
  const n = String(next ?? '')
  if (!p) return n
  if (n.startsWith(p)) return n.slice(p.length)
  const pTrimEnd = p.replace(/\s+$/, '')
  if (pTrimEnd && n.startsWith(pTrimEnd)) return n.slice(pTrimEnd.length)
  return ''
}

function mergeLeadingPunctuationAcrossToolBoundary(segments: string[], runIds: string[]): string[] {
  // 体验优化：把极短语气词/标点尽量合并到前一个文本块，避免工具卡把语义切碎。
  const segs = Array.isArray(segments) ? [...segments] : ['']
  const ids = Array.isArray(runIds) ? runIds : []
  if (ids.length === 0 || segs.length < ids.length + 1) return segs

  const stripLeft = (s: string) => String(s ?? '').replace(/^[ \t\r\n]+/g, '')
  const endsWithPunc = (s: string) => /[，。！？：；…\s*]$/.test(String(s ?? ''))

  // 允许搬运的“短前缀”：2字以内语气词 + 可选标点；或连续标点。
  const pickLead = (s: string): { lead: string; rest: string } => {
    const trimmed = stripLeft(s)
    if (!trimmed) return { lead: '', rest: '' }

    const m1 = trimmed.match(/^([吗呢啊吧呀]{1,2}[，。！？]?)/u)
    if (m1?.[1]) {
      const lead = m1[1]
      return { lead, rest: trimmed.slice(lead.length) }
    }

    const m2 = trimmed.match(/^([，。！？…]{1,3})/u)
    if (m2?.[1]) {
      const lead = m2[1]
      return { lead, rest: trimmed.slice(lead.length) }
    }

    return { lead: '', rest: trimmed }
  }

  for (let i = 0; i < ids.length; i += 1) {
    const before = String(segs[i] ?? '')
    const after = String(segs[i + 1] ?? '')
    if (!before.trim()) continue
    if (!after.trim()) continue
    if (endsWithPunc(before)) continue

    const { lead, rest } = pickLead(after)
    if (!lead) continue
    if (lead.length > 4) continue

    segs[i] = before + lead
    segs[i + 1] = rest
  }

  return segs
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  if (hours > 0) {
    const head = `${hours}小时`
    const tail = minutes > 0 || seconds > 0 ? `${minutes}${seconds}秒` : ''
    return `${head}${tail}`
  }

  if (minutes > 0) return `${minutes}${seconds}秒`
  return `${seconds}秒`
}

function ToolUseDuration(props: { startedAt: number; endedAt: number | null }) {
  const startedAt = typeof props.startedAt === 'number' ? props.startedAt : 0
  const endedAt = typeof props.endedAt === 'number' ? props.endedAt : null

  const isRunning = startedAt > 0 && endedAt == null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  const durationText = startedAt > 0 ? formatDurationMs(Math.max(0, (endedAt ?? now) - startedAt)) : ''
  if (!durationText) return null

  return (
    <span className="ndp-tooluse-duration">
      执行时间 {durationText} <span className="ndp-tooluse-caret"></span>
    </span>
  )
}

function OrbImagePreview(props: {
  api: ReturnType<typeof getApi> | null
  imagePath: string
  alt: string
  dataUrl?: string
  className?: string
  onClick?: () => void
}) {
  const { api, imagePath, alt, dataUrl, className, onClick } = props
  const [src, setSrc] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(imagePath ?? '').trim()
    if (dataUrl) {
      setSrc(String(dataUrl))
      return
    }
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) {
      setSrc(p)
      return
    }
    api
      .readChatAttachmentDataUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.dataUrl === 'string') setSrc(res.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, dataUrl, imagePath])

  const fallback = String(dataUrl ?? imagePath ?? '').trim()
  const finalSrc = src || fallback
  if (!finalSrc) return null
  return <img className={className} src={finalSrc} alt={alt} onClick={onClick} />
}

function OrbLocalVideo(props: {
  api: ReturnType<typeof getApi> | null
  videoPath: string
  className?: string
  controls?: boolean
  muted?: boolean
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
}) {
  const { api, videoPath, className, controls = true, muted, playsInline, preload } = props
  const [src, setSrc] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(videoPath ?? '').trim()
    if (!p) return
    if (/^(https?:|file:|data:|blob:)/i.test(p)) {
      setSrc(p)
      return
    }
    if (!api) {
      setSrc(toLocalMediaSrc(p))
      return
    }
    api
      .getChatAttachmentUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.url === 'string') setSrc(res.url)
        else setSrc(toLocalMediaSrc(p))
      })
      .catch(() => {
        if (!alive) return
        setSrc(toLocalMediaSrc(p))
      })
    return () => {
      alive = false
    }
  }, [api, videoPath])

  if (!src) return null
  return <video className={className} src={src} controls={controls} muted={muted} playsInline={playsInline} preload={preload} />
}

export function OrbApp(props: { api: ReturnType<typeof getApi> }) {
  const { api } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<OrbMode>('ball')
  const [renderMode, setRenderMode] = useState<OrbMode>('ball')
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const dragLastPointRef = useRef<{ x: number; y: number } | null>(null)

  type PendingAttachment = { id: string; kind: 'image' | 'video'; path: string; filename: string; previewDataUrl?: string }
  type ImageViewerRequestItem = { source: string; title?: string }
  type ImageViewerItem = { src: string; title: string }
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [imageViewer, setImageViewer] = useState<{ open: boolean; items: ImageViewerItem[]; index: number; scale: number }>({
    open: false,
    items: [],
    index: 0,
    scale: 1,
  })
  const imageViewerReqRef = useRef(0)
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments
  }, [pendingAttachments])

  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [activePersonaId, setActivePersonaId] = useState('default')
  const activePersonaIdRef = useRef('default')
  useEffect(() => {
    activePersonaIdRef.current = activePersonaId
  }, [activePersonaId])

  const [sessionSummaries, setSessionSummaries] = useState<ChatSessionSummary[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])
  const [panelSession, setPanelSession] = useState<ChatSession | null>(null)
  const [panelMessages, setPanelMessages] = useState<ChatMessageRecord[]>([])
  const panelMessagesRef = useRef<ChatMessageRecord[]>([])
  useEffect(() => {
    panelMessagesRef.current = panelMessages
  }, [panelMessages])
  const [panelLoading, setPanelLoading] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)

  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const submitInFlightRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)
  const streamDraftRef = useRef('')
  const streamRafRef = useRef<number | null>(null)
  useEffect(() => {
    sendingRef.current = sending
  }, [sending])

  const panelListRef = useRef<HTMLDivElement>(null)
  const panelEndRef = useRef<HTMLDivElement>(null)

  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const taskToolUseSplitRef = useRef<Map<string, { runIds: string[]; segments: string[]; lastDisplay: string }>>(new Map())
  const taskOriginRef = useRef<Map<string, { sessionId: string; messageId: string }>>(new Map())
  const taskLatestPatchRef = useRef<Map<string, { content: string; blocks: ChatMessageBlock[] }>>(new Map())
  const taskPersistedRef = useRef<Set<string>>(new Set())

  const [popover, setPopover] = useState<
    | null
    | { kind: 'menu'; left: number; top: number; arrowX: number; ready: boolean }
    | {
        kind: 'history'
        left: number
        top: number
        arrowX: number
        ready: boolean
        loading: boolean
        sessions: Array<{ id: string; name: string; messageCount: number }>
      }
  >(null)
  const overlayActiveRef = useRef(false)
  const setOverlayDataset = useCallback((active: boolean) => {
    const root = document.documentElement
    if (active) root.setAttribute('data-ndp-orb-overlay', 'true')
    else root.removeAttribute('data-ndp-orb-overlay')
  }, [])
  const popoverKindRef = useRef<PopoverKind | null>(null)
  const popoverTokenRef = useRef(0)
  const suppressBlurCollapseRef = useRef(false)

  const [messageMenu, setMessageMenu] = useState<null | { messageId: string; left: number; top: number }>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = useState('')

  useEffect(() => {
    popoverKindRef.current = popover?.kind ?? null
  }, [popover?.kind])

  useEffect(() => {
    if (mode === 'ball') {
      setMessageMenu(null)
      setEditingMessageId(null)
      setEditingMessageContent('')
    }
  }, [mode])

  const newAttachmentId = useCallback(() => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    } catch {
      /* ignore */
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  const addPendingAttachment = useCallback(
    (att: Omit<PendingAttachment, 'id'>) => {
      setPendingAttachments((prev) => [...prev, { id: newAttachmentId(), ...att }])
    },
    [newAttachmentId],
  )

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const readChatImageFile = useCallback(
    async (file: File) => {
      if (!api) return
      if (!file.type.startsWith('image/')) return
      if (file.size > 5 * 1024 * 1024) {
        setPanelError('图片太大（>5MB），请压缩后再发送')
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
        setPanelError(null)

        const filePath = typeof (file as unknown as { path?: unknown }).path === 'string' ? String((file as unknown as { path: string }).path) : ''
        const saved = await api.saveChatAttachment({
          kind: 'image',
          ...(filePath ? { sourcePath: filePath } : { dataUrl }),
          ...(file.name ? { filename: file.name } : { filename: 'clipboard.png' }),
        })
        if (saved?.ok) {
          addPendingAttachment({ kind: 'image', path: saved.path, filename: saved.filename, previewDataUrl: dataUrl })
        }
      } catch (err) {
        console.error('[orb] read/save image failed:', err)
        setPanelError('读取/保存图片失败')
      }
    },
    [addPendingAttachment, api],
  )

  const readChatVideoFile = useCallback(
    async (file: File) => {
      if (!api) return
      if (!file.type.startsWith('video/')) return
      const filePath = typeof (file as unknown as { path?: unknown }).path === 'string' ? String((file as unknown as { path: string }).path) : ''
      if (!filePath) {
        setPanelError('当前视频无法读取本地路径（请用拖拽文件方式添加）')
        return
      }
      try {
        setPanelError(null)
        const saved = await api.saveChatAttachment({
          kind: 'video',
          sourcePath: filePath,
          ...(file.name ? { filename: file.name } : { filename: 'video.mp4' }),
        })
        if (saved?.ok) addPendingAttachment({ kind: 'video', path: saved.path, filename: saved.filename })
      } catch (err) {
        console.error('[orb] save video failed:', err)
        setPanelError('保存视频失败')
      }
    },
    [addPendingAttachment, api],
  )

  const refreshSessions = useCallback(async (): Promise<string | null> => {
    if (!api) return null
    const pid = activePersonaIdRef.current?.trim() || 'default'
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    let filtered = allSessions.filter((s) => s.personaId === pid)

    // 与 ChatWindow 对齐：当前人设没有会话时自动创建一个。
    if (filtered.length === 0) {
      const created = await api.createChatSession(undefined, pid)
      const { sessions: again, currentSessionId: cur2 } = await api.listChatSessions()
      filtered = again.filter((s) => s.personaId === pid)
      setSessionSummaries(filtered)
      const nextId = filtered.some((s) => s.id === cur2) ? cur2 : created.id
      setCurrentSessionId(nextId)
      return nextId
    }

    setSessionSummaries(filtered)

    // 当前会话可能属于其它人设：自动切到本人人设的最新会话。
    const nextSessionId = filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null)
    if (nextSessionId && nextSessionId !== currentSessionId) {
      await api.setCurrentChatSession(nextSessionId)
    }
    setCurrentSessionId(nextSessionId)
    return nextSessionId
  }, [api])

  const clearOverlayBounds = useCallback(
    (opts?: { force?: boolean }) => {
      if (!api) return
      if (!opts?.force && !overlayActiveRef.current) return
      overlayActiveRef.current = false
      void api
        .clearOrbOverlayBounds({ focus: false })
        .catch(() => undefined)
        .finally(() => setOverlayDataset(false))
    },
    [api, setOverlayDataset],
  )

  useEffect(() => {
    if (!api) return
    if (mode !== 'ball') return
    // 兜底：ball 状态下强制清理 overlay，避免残留扩窗影响渲染。
    popoverTokenRef.current += 1
    setPopover(null)
    setMessageMenu(null)
    overlayActiveRef.current = false
    clearOverlayBounds({ force: true })
  }, [api, clearOverlayBounds, mode])

  const closePopover = useCallback(() => {
    popoverTokenRef.current += 1
    setPopover(null)
    // 先卸载 UI 再缩窗，避免出现“先缩窗导致内容裁剪”的闪缩
    window.requestAnimationFrame(() => clearOverlayBounds())
  }, [clearOverlayBounds])

  const dockSide: 'left' | 'right' = (() => {
    try {
      const winCenterX = window.screenX + window.outerWidth / 2
      const s = screen as unknown as { availLeft?: number; availWidth?: number; width?: number }
      const screenLeft = s.availLeft ?? 0
      const screenWidth = s.availWidth ?? screen.width
      const screenCenterX = screenLeft + screenWidth / 2
      return winCenterX < screenCenterX ? 'left' : 'right'
    } catch {
      return 'left'
    }
  })()

  useEffect(() => {
    if (!api) return
    let alive = true
    api
      .getOrbUiState()
      .then((res) => {
        if (!alive) return
        const s = res?.state === 'ball' || res?.state === 'bar' || res?.state === 'panel' ? res.state : 'ball'
        setMode(normalizeMode(s))
      })
      .catch(() => undefined)

    const off = api.onOrbStateChanged((payload) => {
      const s = payload?.state === 'ball' || payload?.state === 'bar' || payload?.state === 'panel' ? payload.state : 'ball'
      setMode(normalizeMode(s))
    })
    return () => {
      alive = false
      off()
    }
  }, [api])

  useEffect(() => {
    if (mode !== 'ball') {
      setRenderMode(mode)
      return
    }

    const ready = () => window.innerWidth <= ORB_BALL_SIZE + 4 && window.innerHeight <= ORB_BALL_SIZE + 4
    if (ready()) {
      setRenderMode('ball')
      return
    }

    const onResize = () => {
      if (!ready()) return
      setRenderMode('ball')
      window.removeEventListener('resize', onResize)
    }

    const raf = window.requestAnimationFrame(onResize)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.cancelAnimationFrame(raf)
    }
  }, [mode])

  useEffect(() => {
    if (!api) return
    let alive = true

    const applySettings = (s: AppSettings) => {
      const pid = typeof s?.activePersonaId === 'string' && s.activePersonaId.trim().length > 0 ? s.activePersonaId.trim() : 'default'
      setActivePersonaId(pid)
    }

    void api
      .getSettings()
      .then((s) => {
        if (!alive) return
        applySettings(s)
      })
      .catch(() => undefined)

    const off = api.onSettingsChanged((s) => applySettings(s))
    return () => {
      alive = false
      off()
    }
  }, [api])

  useEffect(() => {
    void refreshSessions().catch(() => undefined)
  }, [activePersonaId, refreshSessions])

  useEffect(() => {
    if (mode !== 'bar' && mode !== 'panel') return
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [mode])

  const openBall = useCallback(() => {
    if (!api) return
    if (mode === 'ball') return
    popoverTokenRef.current += 1
    setPopover(null)
    setMessageMenu(null)
    overlayActiveRef.current = false
    clearOverlayBounds({ force: true })
    void api.setOrbUiState('ball', { focus: false }).catch((err) => console.error(err))
  }, [api, clearOverlayBounds, mode])

  const openBar = useCallback(() => {
    if (!api) return
    void api.setOrbUiState('bar', { focus: true }).catch((err) => console.error(err))
  }, [api])

  const openPanel = useCallback(() => {
    if (!api) return
    void api.setOrbUiState('panel', { focus: true }).catch((err) => console.error(err))
  }, [api])

  useEffect(() => {
    const onBlur = () => {
      if (suppressBlurCollapseRef.current) {
        suppressBlurCollapseRef.current = false
        return
      }
      if (mode === 'ball') return
      openBall()
    }

    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [mode, openBall])

  useEffect(() => {
    if (!api) return
    let alive = true

    const isTaskFinal = (t: TaskRecord): boolean => t.status === 'done' || t.status === 'failed' || t.status === 'canceled'

    const blocksEqual = (a: ChatMessageBlock[] | undefined, b: ChatMessageBlock[]): boolean => {
      const aa = Array.isArray(a) ? a : []
      if (aa.length !== b.length) return false
      for (let i = 0; i < b.length; i += 1) {
        const x = aa[i] as unknown as { type?: unknown; text?: unknown; taskId?: unknown; runId?: unknown }
        const y = b[i] as unknown as { type?: unknown; text?: unknown; taskId?: unknown; runId?: unknown }
        if (x?.type !== y?.type) return false
        if (x.type === 'text' || x.type === 'status') {
          if (String(x.text ?? '') !== String(y.text ?? '')) return false
        } else if (x.type === 'tool_use') {
          if (String(x.taskId ?? '') !== String(y.taskId ?? '')) return false
          if (String(x.runId ?? '') !== String(y.runId ?? '')) return false
        }
      }
      return true
    }

    const computeTaskMessagePatch = (t: TaskRecord): { content: string; blocks: ChatMessageBlock[] } | null => {
      const rawText = String((isTaskFinal(t) ? (t.finalReply ?? t.draftReply ?? t.lastError) : (t.draftReply ?? t.lastError ?? t.finalReply)) ?? '')
      const displayText = normalizeInterleavedTextSegment(rawText)

      const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
      const runIdsNow = runs.map((r) => String(r.id ?? '').trim()).filter(Boolean)

      let split = taskToolUseSplitRef.current.get(t.id) ?? { runIds: [], segments: [''], lastDisplay: '' }

      const knownIdsNow = new Set(runIdsNow)
      const hasOrphan = split.runIds.some((id) => !knownIdsNow.has(id)) || split.segments.length !== split.runIds.length + 1
      if (hasOrphan) {
        split = { runIds: [], segments: [''], lastDisplay: '' }
      } else {
        split = { runIds: [...split.runIds], segments: [...split.segments], lastDisplay: String(split.lastDisplay ?? '') }
      }

      const prevRunIds = split.runIds
      const isPrefix = prevRunIds.every((id, i) => runIdsNow[i] === id)
      if (!isPrefix) {
        split = {
          runIds: [...runIdsNow],
          segments: new Array(runIdsNow.length + 1).fill(''),
          lastDisplay: split.lastDisplay,
        }
      } else if (runIdsNow.length > prevRunIds.length) {
        for (let i = prevRunIds.length; i < runIdsNow.length; i += 1) {
          split.runIds.push(runIdsNow[i])
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
      taskToolUseSplitRef.current.set(t.id, split)

      const hasAnyText = displayText.trim().length > 0
      const segsForBlocks = mergeLeadingPunctuationAcrossToolBoundary(split.segments, split.runIds)
      const blocks: ChatMessageBlock[] = []

      if (!hasAnyText && split.runIds.length > 0 && !isTaskFinal(t)) {
        blocks.push({ type: 'status', text: '正在调用工具…' })
      }

      if (split.runIds.length > 0) {
        for (let i = 0; i < split.runIds.length + 1; i += 1) {
          const seg = String(segsForBlocks[i] ?? '')
          const normalizedSeg = normalizeInterleavedTextSegment(seg)
          if (normalizedSeg.trim().length > 0) blocks.push({ type: 'text', text: normalizedSeg })
          if (i < split.runIds.length) blocks.push({ type: 'tool_use', taskId: t.id, runId: split.runIds[i] })
        }
      } else {
        if (displayText.trim().length > 0) blocks.push({ type: 'text', text: displayText })
      }

      if (blocks.length === 0) return null
      return { content: joinTextBlocks(blocks), blocks }
    }

    const applyTasks = (items: TaskRecord[]) => {
      for (const t of items) {
        const patch = computeTaskMessagePatch(t)
        if (patch) taskLatestPatchRef.current.set(t.id, patch)
      }

      const prevMsgs = panelMessagesRef.current
      if (Array.isArray(prevMsgs) && prevMsgs.length > 0) {
        let changed = false
        const nextMsgs = prevMsgs.map((m) => {
          if (m.role !== 'assistant') return m
          const taskId = typeof m.taskId === 'string' ? m.taskId.trim() : ''
          if (!taskId) return m
          const patch = taskLatestPatchRef.current.get(taskId)
          if (!patch) return m
          if (String(m.content ?? '') === patch.content && blocksEqual(m.blocks, patch.blocks)) return m
          changed = true
          return { ...m, content: patch.content, blocks: patch.blocks }
        })
        if (changed) {
          panelMessagesRef.current = nextMsgs
          setPanelMessages(nextMsgs)
        }
      }

      for (const t of items) {
        if (!isTaskFinal(t)) continue
        if (taskPersistedRef.current.has(t.id)) continue
        const origin = taskOriginRef.current.get(t.id)
        if (!origin) continue
        const patch = taskLatestPatchRef.current.get(t.id)
        if (!patch) continue
        taskPersistedRef.current.add(t.id)
        void api
          .updateChatMessageRecord(origin.sessionId, origin.messageId, patch)
          .catch(() => undefined)
          .finally(() => {
            taskOriginRef.current.delete(t.id)
            taskToolUseSplitRef.current.delete(t.id)
            taskLatestPatchRef.current.delete(t.id)
          })
      }
    }

    void api
      .listTasks()
      .then((res) => {
        if (!alive) return
        const items = Array.isArray(res?.items) ? res.items : []
        setTasks(items)
        applyTasks(items)
      })
      .catch(() => undefined)

    const offTasks = api.onTasksChanged((payload) => {
      const items = Array.isArray(payload?.items) ? payload.items : []
      setTasks(items)
      applyTasks(items)
    })

    return () => {
      alive = false
      offTasks()
    }
  }, [api])

  const hasRunningTaskInSessionRef = useRef(false)
  useEffect(() => {
    const sid = String(currentSessionId ?? '').trim()
    if (!sid) {
      hasRunningTaskInSessionRef.current = false
      return
    }
    for (const t of tasks) {
      if (t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused') continue
      const origin = taskOriginRef.current.get(t.id)
      if (origin?.sessionId === sid) {
        hasRunningTaskInSessionRef.current = true
        return
      }
      if (panelMessages.some((m) => String(m.taskId ?? '') === t.id)) {
        hasRunningTaskInSessionRef.current = true
        return
      }
    }
    hasRunningTaskInSessionRef.current = false
  }, [currentSessionId, panelMessages, tasks])

  useEffect(() => {
    if (!api) return
    if (mode !== 'panel') return
    if (sending) return
    if (hasRunningTaskInSessionRef.current && panelMessagesRef.current.length > 0) return
    setPanelLoading(true)
    setPanelError(null)
    void api
      .getChatSession(currentSessionId ?? undefined)
      .then((session) => {
        setPanelSession(session)
        setPanelMessages(Array.isArray(session?.messages) ? session.messages : [])
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        setPanelError(msg || '加载会话失败')
      })
      .finally(() => setPanelLoading(false))
  }, [api, currentSessionId, mode, sending])

  const scrollPanelToBottom = useCallback(() => {
    const list = panelListRef.current
    if (!list) return
    try {
      list.scrollTop = list.scrollHeight
    } catch {
      /* ignore */
    }
    const end = panelEndRef.current
    if (!end) return
    try {
      end.scrollIntoView({ block: 'end' })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (mode !== 'panel') return
    const ids: number[] = []
    ids.push(
      window.requestAnimationFrame(() => {
        scrollPanelToBottom()
        ids.push(window.requestAnimationFrame(() => scrollPanelToBottom()))
      }),
    )
    return () => {
      for (const id of ids) window.cancelAnimationFrame(id)
    }
  }, [currentSessionId, mode, panelLoading, panelMessages.length, scrollPanelToBottom])

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      setDragging(true)
      dragStartRef.current = { x: e.screenX, y: e.screenY, time: Date.now() }
      const point = { x: e.screenX, y: e.screenY }
      dragLastPointRef.current = point
      api?.startDrag(point)
    },
    [api],
  )

  const stopDrag = useCallback(
    (e?: { x: number; y: number }) => {
      const start = dragStartRef.current
      dragStartRef.current = null
      setDragging(false)
      const point = e ?? dragLastPointRef.current ?? undefined
      api?.stopDrag(point)
      dragLastPointRef.current = null

      if (!start || !e) return
      const dx = e.x - start.x
      const dy = e.y - start.y
      const movedSq = dx * dx + dy * dy
      const clickThresholdSq = 10 * 10
      const clickTimeMs = 350
      const isClick = movedSq < clickThresholdSq && Date.now() - start.time < clickTimeMs
      if (!isClick) return

      if (popoverKindRef.current) {
        closePopover()
        return
      }

      if (mode === 'ball') {
        const sid = String(currentSessionId ?? '').trim()
        const summary = sid ? sessionSummaries.find((s) => s.id === sid) ?? null : null
        const hasMessages = typeof summary?.messageCount === 'number' && summary.messageCount > 0
        setTimeout(() => {
          if (hasMessages) openPanel()
          else openBar()
        }, 40)
      }
    },
    [api, closePopover, currentSessionId, mode, openBar, openPanel, sessionSummaries],
  )

  const onBarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const el = e.target as HTMLElement | null
      if (!el) return
      if (el.closest('[data-orb-nodrag="true"]')) return
      if (el.closest('input,textarea,button,select,a,[role="button"],[contenteditable="true"]')) return
      startDrag(e)
    },
    [startDrag],
  )

  const onBarMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      stopDrag({ x: e.screenX, y: e.screenY })
    },
    [dragging, stopDrag],
  )

  useEffect(() => {
    if (!dragging) return

    const onMouseMove = (e: MouseEvent) => {
      const point = { x: e.screenX, y: e.screenY }
      dragLastPointRef.current = point
      api?.dragMove(point)
    }

    const onMouseUp = (e: MouseEvent) => {
      stopDrag({ x: e.screenX, y: e.screenY })
    }

    const onBlur = () => {
      stopDrag(undefined)
    }

    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [api, dragging, stopDrag])

  const openMenuPopover = useCallback(
    (e: React.MouseEvent) => {
      if (!api) return

      e.preventDefault()
      closePopover()
      suppressBlurCollapseRef.current = true
      window.setTimeout(() => {
        suppressBlurCollapseRef.current = false
      }, 260)
      void api
        .showOrbContextMenu({
          x: e.screenX,
          y: e.screenY,
        })
        .catch(() => undefined)
    },
    [api, closePopover],
  )

  const openHistoryPopover = useCallback(
    (anchorCenterX: number) => {
      if (!api) return

      const popoverTop = ORB_BAR_HEIGHT + ORB_POPOVER_GAP

      const barWidth = Math.max(360, Math.round(window.innerWidth))
      const left = clamp(Math.round(anchorCenterX - HISTORY_WIDTH / 2), 10, barWidth - HISTORY_WIDTH - 10)
      const arrowX = clamp(anchorCenterX, left + 16, left + HISTORY_WIDTH - 16)
      const arrowInPopover = Math.round(arrowX - left)
      const token = (popoverTokenRef.current += 1)
      setPopover({ kind: 'history', left, top: popoverTop, arrowX: arrowInPopover, ready: false, loading: true, sessions: [] })
      overlayActiveRef.current = false
      setOverlayDataset(false)
      window.requestAnimationFrame(() => {
        if (popoverTokenRef.current !== token) return
        setPopover((prev) => (prev?.kind === 'history' ? { ...prev, ready: true } : prev))
      })

      void api
        .listChatSessions()
        .then((res) => {
          if (popoverTokenRef.current !== token) return
          const pid = activePersonaIdRef.current?.trim() || 'default'
          const sessions = (res?.sessions ?? []).filter((s) => s.personaId === pid)
          const recent = sessions
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, HISTORY_MAX_ITEMS)
            .map((s) => ({ id: s.id, name: s.name || '未命名会话', messageCount: s.messageCount ?? 0 }))
          setPopover((prev) => (prev?.kind === 'history' ? { ...prev, loading: false, sessions: recent } : prev))
        })
        .catch(() => {
          if (popoverTokenRef.current !== token) return
          setPopover((prev) => (prev?.kind === 'history' ? { ...prev, loading: false } : prev))
        })
    },
    [api, setOverlayDataset],
  )

  const onSend = useCallback(async (opts?: { text?: string; attachments?: PendingAttachment[]; seedMessages?: ChatMessageRecord[] }) => {
    if (Array.isArray(opts?.seedMessages)) {
      panelMessagesRef.current = opts.seedMessages
      setPanelMessages(opts.seedMessages)
    }

    const text = String(opts?.text ?? input).trim()
    const attachmentsNow = Array.isArray(opts?.attachments) ? opts.attachments : pendingAttachmentsRef.current
    if (!text && attachmentsNow.length === 0) return
    if (!api) return

    if (sendingRef.current) {
      try {
        sendAbortRef.current?.abort()
      } catch {
        /* ignore */
      }
      return
    }
    if (submitInFlightRef.current) return

    setPanelError(null)
    submitInFlightRef.current = true
    sendingRef.current = true
    setSending(true)
    try {
      // bar 发送第一条消息后进入 panel（但不依赖 setBounds 插值；主进程只对 panel 做动画）
      if (mode === 'bar') openPanel()

      const settings = await api.getSettings().catch(() => null)
      if (!settings) {
        setPanelError('无法读取设置，请先打开设置页完成初始化')
        return
      }

      const orch = settings.orchestrator
      const plannerEnabledNow = orch?.plannerEnabled ?? false
      const toolCallingEnabledNow = orch?.toolCallingEnabled ?? false
      const toolCallingModeNow = orch?.toolCallingMode ?? 'auto'

      if (attachmentsNow.length > 0 && !(plannerEnabledNow && toolCallingEnabledNow)) {
        setPanelError('发送图片/视频需要开启：设置 -> 任务规划器 + 工具执行')
        return
      }

      const ensuredId = await refreshSessions().catch(() => null)
      const activeSessionId = ensuredId || currentSessionId
      if (!activeSessionId) {
        setPanelError('当前会话不可用')
        return
      }

      setInput('')
      setPendingAttachments([])

      const userMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'user',
        content: text,
        ...(attachmentsNow.length > 0
          ? {
              attachments: attachmentsNow.map((a) => ({
                kind: a.kind,
                path: a.path,
                filename: a.filename,
              })),
            }
          : {}),
        createdAt: Date.now(),
      }

      setPanelMessages((prev) => [...prev, userMessage])
      await api.addChatMessage(activeSessionId, userMessage).catch(() => undefined)

      const shouldRunToolAgent = plannerEnabledNow && toolCallingEnabledNow && (text.trim().length > 0 || attachmentsNow.length > 0)
      if (shouldRunToolAgent) {
        const pid = activePersonaIdRef.current?.trim() || 'default'

        let memoryAddon = ''
        try {
          const memEnabled = settings.memory?.enabled ?? true
          const persona = await api.getPersona(pid).catch(() => null)
          const retrieveEnabled = persona?.retrieveEnabled ?? true
          const queryText = text.trim()
          if (memEnabled && retrieveEnabled && queryText.length > 0) {
            const res = await api.retrieveMemory({
              personaId: pid,
              query: queryText,
              limit: 12,
              maxChars: 3200,
              includeShared: settings.memory?.includeSharedOnRetrieve ?? true,
            })
            memoryAddon = res.addon?.trim() ?? ''
          }
        } catch {
          memoryAddon = ''
        }

        const imagePaths = attachmentsNow.filter((a) => a.kind === 'image').map((a) => a.path).slice(0, 4)
        const attachmentLabel =
          attachmentsNow.length > 0
            ? `[附件] 图片${attachmentsNow.filter((a) => a.kind === 'image').length} 视频${attachmentsNow.filter((a) => a.kind === 'video').length}`
            : ''
        const requestText = text.trim() || attachmentLabel || '[消息]'

        const historyForAgent: ChatMessage[] = (() => {
          // agent.run 会把 request 作为当前 user 输入追加一次；这里仅传“历史消息”，避免同一句被重复注入。
          const msgs = [...panelMessagesRef.current]
          const compact = msgs
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: String(m.content ?? '') }))
            .filter((m) => m.content.trim().length > 0)
          return compact.slice(Math.max(0, compact.length - 20))
        })()

        const title = requestText.length > 40 ? `${requestText.slice(0, 40)}…` : requestText
        const created = await api.createTask({
          queue: 'chat',
          title: title || '对话',
          why: 'orb 对话工具代理（agent.run）',
          steps: [
            {
              title: '对话/工具',
              tool: 'agent.run',
              input: JSON.stringify({
                request: requestText,
                mode: toolCallingModeNow,
                history: historyForAgent,
                context: memoryAddon,
                ...(imagePaths.length > 0 ? { imagePaths } : {}),
              }),
            },
          ],
        })

        const assistantId = newMessageId()
        const blocks: ChatMessageBlock[] = [{ type: 'status', text: '思考中…' }]
        const assistantMessage: ChatMessageRecord = {
          id: assistantId,
          role: 'assistant',
          content: joinTextBlocks(blocks),
          blocks,
          taskId: created.id,
          createdAt: Date.now(),
        }

        taskOriginRef.current.set(created.id, { sessionId: activeSessionId, messageId: assistantId })
        taskToolUseSplitRef.current.set(created.id, { runIds: [], segments: [''], lastDisplay: '' })

        setPanelMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(activeSessionId, assistantMessage).catch(() => undefined)
        void refreshSessions().catch(() => undefined)
        return
      }

      const historyForModel: ChatMessage[] = (() => {
        const msgs = [...panelMessagesRef.current, userMessage]
        const compact = msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: String(m.content ?? '') }))
          .filter((m) => m.content.trim().length > 0)
        return compact.slice(Math.max(0, compact.length - 20))
      })()

      const ai = getAIService(settings.ai)
      if (!ai) {
        setPanelError('AI 服务未初始化，请先在设置里配置 API')
        return
      }

      const assistantId = newMessageId()
      const assistantMessage: ChatMessageRecord = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
      }

      setPanelMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(activeSessionId, assistantMessage).catch(() => undefined)

      const abort = new AbortController()
      sendAbortRef.current = abort
      streamDraftRef.current = ''

      const flushDraft = () => {
        const next = streamDraftRef.current
        setPanelMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: next } : m)))
      }

      const res = await ai.chatStream(historyForModel, {
        signal: abort.signal,
        onDelta: (delta) => {
          streamDraftRef.current += delta
          if (streamRafRef.current != null) return
          streamRafRef.current = window.requestAnimationFrame(() => {
            streamRafRef.current = null
            flushDraft()
          })
        },
      })

      if (res.error) {
        if (res.error === ABORTED_ERROR) return
        setPanelError(res.error)
        return
      }

      const finalText = String(res.content ?? streamDraftRef.current)
      streamDraftRef.current = finalText
      flushDraft()
      await api.updateChatMessage(activeSessionId, assistantId, finalText).catch(() => undefined)
      void refreshSessions().catch(() => undefined)
    } finally {
      if (streamRafRef.current != null) {
        window.cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      sendAbortRef.current = null
      sendingRef.current = false
      submitInFlightRef.current = false
      setSending(false)
    }
  }, [api, currentSessionId, input, mode, openPanel, refreshSessions])

  const closeMessageMenu = useCallback(() => setMessageMenu(null), [])

  const openMessageMenu = useCallback(
    (e: React.MouseEvent, messageId: string) => {
      if (mode !== 'panel') return
      e.preventDefault()
      e.stopPropagation()

      if (messageMenu?.messageId === messageId) {
        closeMessageMenu()
        return
      }

      const itemCount = 4
      const menuHeight = MSG_MENU_PADDING * 2 + itemCount * MSG_MENU_ITEM_HEIGHT

      const rect = rootRef.current?.getBoundingClientRect()
      const maxW = rect?.width ?? window.innerWidth
      const maxH = rect?.height ?? window.innerHeight
      const rawX = rect ? e.clientX - rect.left : e.clientX
      const rawY = rect ? e.clientY - rect.top : e.clientY
      const left = clamp(Math.round(rawX), 10, Math.max(10, Math.round(maxW - MSG_MENU_WIDTH - 10)))
      const top = clamp(Math.round(rawY), 10, Math.max(10, Math.round(maxH - menuHeight - 10)))

      closePopover()
      setMessageMenu({ messageId, left, top })
    },
    [closeMessageMenu, closePopover, messageMenu?.messageId, mode],
  )

  const handleStartEdit = useCallback(
    (messageId: string) => {
      const msg = panelMessagesRef.current.find((m) => m.id === messageId) ?? null
      if (!msg || msg.role !== 'user') return
      setEditingMessageId(messageId)
      setEditingMessageContent(String(msg.content ?? ''))
      closeMessageMenu()
    },
    [closeMessageMenu],
  )

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [])

  const cleanupTaskRefs = useCallback((taskId: string) => {
    const id = String(taskId ?? '').trim()
    if (!id) return
    taskOriginRef.current.delete(id)
    taskToolUseSplitRef.current.delete(id)
    taskLatestPatchRef.current.delete(id)
    taskPersistedRef.current.delete(id)
  }, [])

  const cancelTasksForMessages = useCallback(
    async (items: ChatMessageRecord[]) => {
      const ids = new Set<string>()
      for (const m of items) {
        const id = typeof m.taskId === 'string' ? m.taskId.trim() : ''
        if (id) ids.add(id)
      }
      if (ids.size === 0) return

      await Promise.allSettled(
        Array.from(ids).map(async (id) => {
          cleanupTaskRefs(id)
          await api?.cancelTask(id).catch(() => undefined)
        }),
      )
    },
    [api, cleanupTaskRefs],
  )

  const applyPanelMessages = useCallback((next: ChatMessageRecord[]) => {
    panelMessagesRef.current = next
    setPanelMessages(next)
  }, [])

  const copyToClipboard = useCallback(async (text: string): Promise<boolean> => {
    const value = String(text ?? '')
    if (!value.trim()) return false

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch {
      /* ignore */
    }

    try {
      const el = document.createElement('textarea')
      el.value = value
      el.setAttribute('readonly', 'true')
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      el.style.opacity = '0'
      el.style.pointerEvents = 'none'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }, [])

  const handleCopyAssistantText = useCallback(
    async (messageId: string) => {
      const m = panelMessagesRef.current.find((x) => x.id === messageId) ?? null
      if (!m || m.role !== 'assistant') return

      const text = Array.isArray(m.blocks) && m.blocks.length > 0 ? joinTextBlocks(m.blocks) : String(m.content ?? '')
      closeMessageMenu()
      const ok = await copyToClipboard(text)
      if (!ok) setPanelError('复制失败（可能没有权限访问剪贴板）')
    },
    [closeMessageMenu, copyToClipboard],
  )

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!api) return
      const ensuredId = await refreshSessions().catch(() => null)
      const sid = ensuredId || currentSessionIdRef.current
      if (!sid) return
      if (sending) return

      const prev = panelMessagesRef.current
      const idx = prev.findIndex((m) => m.id === messageId)
      if (idx === -1) return

      closeMessageMenu()
      if (editingMessageId === messageId) handleCancelEdit()

      const removed = prev[idx]
      const next = prev.filter((m) => m.id !== messageId)
      applyPanelMessages(next)
      await cancelTasksForMessages([removed])

      try {
        await api.setChatMessages(sid, next)
        void refreshSessions().catch(() => undefined)
      } catch (err) {
        console.error('[orb] delete message failed:', err)
        const session = await api.getChatSession(sid).catch(() => null)
        if (session?.messages) applyPanelMessages(session.messages)
      }
    },
    [
      api,
      applyPanelMessages,
      cancelTasksForMessages,
      closeMessageMenu,
      editingMessageId,
      handleCancelEdit,
      refreshSessions,
      sending,
    ],
  )

  const handleDeleteTurn = useCallback(
    async (messageId: string) => {
      if (!api) return
      const ensuredId = await refreshSessions().catch(() => null)
      const sid = ensuredId || currentSessionIdRef.current
      if (!sid) return
      if (sending) return

      const prev = panelMessagesRef.current
      const idx = prev.findIndex((m) => m.id === messageId)
      if (idx === -1) return

      let userIndex = idx
      if (prev[idx]?.role === 'assistant') {
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (prev[i]?.role === 'user') {
            userIndex = i
            break
          }
        }
      }
      const userMsg = prev[userIndex]
      if (!userMsg || userMsg.role !== 'user') return

      let endIndex = prev.length
      for (let i = userIndex + 1; i < prev.length; i += 1) {
        if (prev[i]?.role === 'user') {
          endIndex = i
          break
        }
      }

      closeMessageMenu()
      if (editingMessageId && editingMessageId === userMsg.id) handleCancelEdit()

      const removed = prev.slice(userIndex, endIndex)
      const next = [...prev.slice(0, userIndex), ...prev.slice(endIndex)]
      applyPanelMessages(next)
      await cancelTasksForMessages(removed)

      try {
        await api.setChatMessages(sid, next)
        void refreshSessions().catch(() => undefined)
      } catch (err) {
        console.error('[orb] delete turn failed:', err)
        const session = await api.getChatSession(sid).catch(() => null)
        if (session?.messages) applyPanelMessages(session.messages)
      }
    },
    [
      api,
      applyPanelMessages,
      cancelTasksForMessages,
      closeMessageMenu,
      editingMessageId,
      handleCancelEdit,
      refreshSessions,
      sending,
    ],
  )

  const handleResend = useCallback(
    async (messageId: string, opts?: { overrideContent?: string }) => {
      if (!api) return
      if (sending) return

      const ensuredId = await refreshSessions().catch(() => null)
      const sid = ensuredId || currentSessionIdRef.current
      if (!sid) return

      const messages = panelMessagesRef.current
      const msgIndex = messages.findIndex((m) => m.id === messageId)
      if (msgIndex === -1) return

      let userIndex = msgIndex
      if (messages[msgIndex]?.role === 'assistant') {
        for (let i = msgIndex - 1; i >= 0; i -= 1) {
          if (messages[i]?.role === 'user') {
            userIndex = i
            break
          }
        }
      }

      const userMsg = messages[userIndex]
      if (!userMsg || userMsg.role !== 'user') return

      closeMessageMenu()
      handleCancelEdit()

      const baseMessages = messages.slice(0, userIndex)
      const removed = messages.slice(userIndex)
      applyPanelMessages(baseMessages)
      await cancelTasksForMessages(removed)
      await api.setChatMessages(sid, baseMessages).catch(() => undefined)
      void refreshSessions().catch(() => undefined)

      const rawText = String(opts?.overrideContent ?? userMsg.content ?? '').trim()
      const hasText = rawText.replace(/\[[^\]]+\]/g, '').trim().length > 0
      const resendText = hasText ? rawText : ''

      const resendAttachmentsRaw =
        Array.isArray(userMsg.attachments) && userMsg.attachments.length > 0
          ? userMsg.attachments
          : [
              ...(userMsg.imagePath ? [{ kind: 'image' as const, path: userMsg.imagePath }] : []),
              ...(userMsg.videoPath ? [{ kind: 'video' as const, path: userMsg.videoPath }] : []),
            ]

      const resendAttachments: PendingAttachment[] = resendAttachmentsRaw
        .map((a) => {
          const kind = (a as { kind?: unknown }).kind === 'video' ? ('video' as const) : ('image' as const)
          const path = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
          const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
          if (!path) return null
          return { id: newAttachmentId(), kind, path, filename: filename || (kind === 'video' ? 'video.mp4' : 'image.png') }
        })
        .filter((a): a is PendingAttachment => !!a)

      await onSend({ text: resendText, attachments: resendAttachments, seedMessages: baseMessages })
    },
    [api, applyPanelMessages, cancelTasksForMessages, closeMessageMenu, handleCancelEdit, newAttachmentId, onSend, refreshSessions, sending],
  )

  const handleSaveEdit = useCallback(
    async (opts?: { resend?: boolean }) => {
      if (!api) return
      const messageId = editingMessageId
      if (!messageId) return
      const ensuredId = await refreshSessions().catch(() => null)
      const sid = ensuredId || currentSessionIdRef.current
      if (!sid) return

      const nextContent = editingMessageContent
      const prev = panelMessagesRef.current
      const next = prev.map((m) => (m.id === messageId ? { ...m, content: nextContent, updatedAt: Date.now() } : m))
      applyPanelMessages(next)

      try {
        await api.updateChatMessage(sid, messageId, nextContent)
        void refreshSessions().catch(() => undefined)
      } catch (err) {
        console.error('[orb] update message failed:', err)
      } finally {
        setEditingMessageId(null)
        setEditingMessageContent('')
      }

      if (opts?.resend) {
        void handleResend(messageId, { overrideContent: nextContent }).catch(() => undefined)
      }
    },
    [api, applyPanelMessages, editingMessageContent, editingMessageId, handleResend, refreshSessions],
  )

  const rootClassName = useMemo(() => {
    const classes = [`ndp-orbapp-root`, `ndp-orbapp-mode-${renderMode}`]
    if (dragging) classes.push('ndp-orbapp-dragging')
    return classes.join(' ')
  }, [dragging, renderMode])

  useEffect(() => {
    const root = document.documentElement
    let raf = 0

    const update = () => {
      const h = Math.max(0, Math.round(window.innerHeight))
      const denom = ORB_BAR_HEIGHT - ORB_BALL_SIZE
      const pRaw = denom > 0 ? (h - ORB_BALL_SIZE) / denom : 1
      const p = clamp(pRaw, 0, 1)
      const inv = clamp(1 - p, 0, 1)

      root.style.setProperty('--ndp-orbapp-bar-progress', p.toFixed(3))
      root.style.setProperty('--ndp-orbapp-bar-progress-inv', inv.toFixed(3))
      if (p >= 0.999) root.setAttribute('data-ndp-orb-bar-open', 'true')
      else root.removeAttribute('data-ndp-orb-bar-open')
    }

    const onResize = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        update()
      })
    }

    update()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  const currentSummary = useMemo(() => {
    const id = String(currentSessionId ?? '').trim()
    if (!id) return null
    return sessionSummaries.find((s) => s.id === id) ?? null
  }, [currentSessionId, sessionSummaries])

  const autoExpandSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (mode === 'ball') autoExpandSessionRef.current = null
  }, [mode])
  useEffect(() => {
    // ball 状态不应残留弹层（否则会出现“透明区域挡点 + 裁剪闪烁”）
    if (mode === 'ball' && popover?.kind === 'history') closePopover()
  }, [mode, popover?.kind, closePopover])

  const resolveImageViewerSrc = useCallback(
    async (pathOrUrl: string): Promise<string> => {
      const raw = String(pathOrUrl ?? '').trim()
      if (!raw) return ''
      if (/^(https?:|data:|blob:|file:)/i.test(raw)) return raw
      try {
        const res = await api?.getChatAttachmentUrl(raw)
        if (res?.ok && typeof res.url === 'string') return res.url
      } catch {
        /* ignore */
      }
      return toLocalMediaSrc(raw)
    },
    [api],
  )

  const openImageViewer = useCallback(
    async (items: ImageViewerRequestItem[], startIndex = 0) => {
      const cleaned = items
        .map((it) => ({ source: String(it?.source ?? '').trim(), title: String(it?.title ?? '').trim() }))
        .filter((it) => Boolean(it.source))
      if (cleaned.length === 0) return

      const reqId = imageViewerReqRef.current + 1
      imageViewerReqRef.current = reqId
      const resolved = await Promise.all(
        cleaned.map(async (it, idx) => ({
          src: await resolveImageViewerSrc(it.source),
          title: it.title || `图片 ${idx + 1}`,
        })),
      )
      if (imageViewerReqRef.current !== reqId) return

      const finalItems = resolved.filter((it) => Boolean(it.src))
      if (finalItems.length === 0) return
      const safeIndex = Math.max(0, Math.min(Math.trunc(startIndex), finalItems.length - 1))
      setImageViewer({ open: true, items: finalItems, index: safeIndex, scale: 1 })
    },
    [resolveImageViewerSrc],
  )

  const closeImageViewer = useCallback(() => {
    setImageViewer((prev) => ({ ...prev, open: false, scale: 1 }))
  }, [])

  const prevImageViewer = useCallback(() => {
    setImageViewer((prev) => {
      const total = prev.items.length
      if (!prev.open || total <= 1) return prev
      const next = (prev.index - 1 + total) % total
      return { ...prev, index: next, scale: 1 }
    })
  }, [])

  const nextImageViewer = useCallback(() => {
    setImageViewer((prev) => {
      const total = prev.items.length
      if (!prev.open || total <= 1) return prev
      const next = (prev.index + 1) % total
      return { ...prev, index: next, scale: 1 }
    })
  }, [])

  const resetImageViewerScale = useCallback(() => {
    setImageViewer((prev) => ({ ...prev, scale: 1 }))
  }, [])

  const onImageViewerWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY
    setImageViewer((prev) => {
      if (!prev.open) return prev
      const factor = delta < 0 ? 1.1 : 0.9
      const nextScale = Math.max(0.2, Math.min(6, prev.scale * factor))
      return { ...prev, scale: nextScale }
    })
  }, [])

  useEffect(() => {
    if (!imageViewer.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeImageViewer()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prevImageViewer()
        return
      }
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        prevImageViewer()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        nextImageViewer()
        return
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        nextImageViewer()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeImageViewer, imageViewer.open, nextImageViewer, prevImageViewer])

  const renderToolCard = useCallback(
    (taskId: string, runId?: string) => {
      const t = tasksById.get(taskId)
      if (!t) return <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: ToolUse（任务未加载</div>

      const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
      const steps = Array.isArray(t.steps) ? t.steps : []

      const renderRun = (r: (typeof runs)[number], idx: number) => {
        const progress = runs.length > 1 ? `${idx + 1}/${runs.length}` : ''
        const pillStatus = r.status === 'error' ? 'failed' : r.status
        const toolImagePaths = Array.isArray(r.imagePaths)
          ? Array.from(new Set(r.imagePaths.map((x) => String(x ?? '').trim()).filter(Boolean))).slice(0, 8)
          : []
        const allToolImagePaths = Array.from(
          new Set(
            runs.flatMap((run) =>
              Array.isArray(run.imagePaths)
                ? run.imagePaths.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8)
                : [],
            ),
          ),
        )
        const toolImageViewerItems = allToolImagePaths.map((imgPath, imgIdx) => ({ source: imgPath, title: `图片 ${imgIdx + 1}` }))
        const startedAt = typeof r.startedAt === 'number' ? r.startedAt : 0
        const endedAt = typeof r.endedAt === 'number' ? r.endedAt : null
        const toolImageBlock =
          toolImagePaths.length > 0 ? (
            <div className="ndp-orbpanel-attachments" data-orb-nodrag="true">
              {toolImagePaths.map((imgPath, imgIdx) => (
                <div
                  key={`tool-outside-img-${String(r.id ?? `${taskId}-run-${idx}`)}-${imgIdx}`}
                  className="ndp-orbpanel-attachment"
                  title={imgPath}
                  onClick={() => {
                    const navIndex = allToolImagePaths.findIndex((p) => p === imgPath)
                    void openImageViewer(toolImageViewerItems, navIndex >= 0 ? navIndex : imgIdx)
                  }}
                >
                  <OrbImagePreview api={api} className="ndp-orbpanel-image" imagePath={imgPath} alt={`tool-image-${imgIdx + 1}`} />
                  <div className="ndp-orbpanel-attachment-meta">image {imgIdx + 1}</div>
                </div>
              ))}
            </div>
          ) : null
        return (
          <>
            {toolImageBlock}
            <details key={String(r.id ?? `${taskId}-run-${idx}`)} className="ndp-tooluse">
              <summary className="ndp-tooluse-summary">
                <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                  DeskPet · ToolUse: {r.toolName}
                  {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
                </span>
                <ToolUseDuration startedAt={startedAt} endedAt={endedAt} />
              </summary>
              <div className="ndp-tooluse-body">
                <div className="ndp-tooluse-run">
                  <div className="ndp-tooluse-run-title">
                    <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${r.status}`}>{r.status}</span>
                    <span className="ndp-tooluse-run-name">{r.toolName}</span>
                  </div>
                  {r.inputPreview ? <div className="ndp-tooluse-run-io">in: {r.inputPreview}</div> : null}
                  {r.outputPreview ? <div className="ndp-tooluse-run-io">out: {r.outputPreview}</div> : null}
                  {false ? (
                    <div className="ndp-orbpanel-attachments" data-orb-nodrag="true">
                      {toolImagePaths.map((imgPath, imgIdx) => (
                        <div
                          key={`tool-img-${String(r.id ?? `${taskId}-run-${idx}`)}-${imgIdx}`}
                          className="ndp-orbpanel-attachment"
                          title={imgPath}
                          onClick={() => {
                            void (async () => {
                              const raw = String(imgPath ?? '').trim()
                              if (!raw) return
                              if (/^(https?:|data:|blob:)/i.test(raw)) {
                                window.open(raw, '_blank')
                                return
                              }
                              try {
                                const res = await api?.getChatAttachmentUrl(raw)
                                if (res?.ok && typeof res.url === 'string') {
                                  window.open(res.url, '_blank')
                                  return
                                }
                              } catch {
                                /* ignore */
                              }
                              window.open(toLocalMediaSrc(raw), '_blank')
                            })()
                          }}
                        >
                          <OrbImagePreview api={api} className="ndp-orbpanel-image" imagePath={imgPath} alt={`tool-image-${imgIdx + 1}`} />
                          <div className="ndp-orbpanel-attachment-meta">image {imgIdx + 1}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {r.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {r.error}</div> : null}
                </div>
              </div>
            </details>
          </>
        )
      }

      const renderStep = (s: (typeof steps)[number], idx: number) => {
        const tool = typeof (s as { tool?: unknown }).tool === 'string' ? String((s as { tool: string }).tool) : ''
        const name = tool || String((s as { title?: unknown }).title ?? `step-${idx}`)
        const progress = steps.length > 1 ? `${idx + 1}/${steps.length}` : ''
        const statusText = String((s as { status?: unknown }).status ?? 'pending')
        const statusKey = statusText === 'error' ? 'error' : statusText === 'done' ? 'done' : statusText === 'running' ? 'running' : statusText === 'paused' ? 'paused' : 'pending'
        const pillStatus =
          statusText === 'failed' || statusText === 'error'
            ? 'failed'
            : statusText === 'done'
              ? 'done'
              : statusText === 'running'
                ? 'running'
                : statusText === 'paused'
                  ? 'paused'
                  : 'pending'

        const input = typeof (s as { input?: unknown }).input === 'string' ? String((s as { input: string }).input) : ''
        const output = typeof (s as { output?: unknown }).output === 'string' ? String((s as { output: string }).output) : ''
        const error = typeof (s as { error?: unknown }).error === 'string' ? String((s as { error: string }).error) : ''
        const startedAt = typeof (s as { startedAt?: unknown }).startedAt === 'number' ? (s as { startedAt: number }).startedAt : 0
        const endedAt = typeof (s as { endedAt?: unknown }).endedAt === 'number' ? (s as { endedAt: number }).endedAt : null

        return (
          <details key={String((s as { id?: unknown }).id ?? `${taskId}-step-${idx}`)} className="ndp-tooluse">
            <summary className="ndp-tooluse-summary">
              <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
                DeskPet · ToolUse: {name}
                {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
              </span>
              <ToolUseDuration startedAt={startedAt} endedAt={endedAt} />
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

      if (runId && runs.length > 0) {
        const idx = runs.findIndex((r) => String(r.id ?? '') === runId)
        if (idx >= 0) return renderRun(runs[idx], idx)
      }

      if (runs.length > 0) return <>{runs.map((r, idx) => renderRun(r, idx))}</>

      const usefulSteps = steps.filter((s) => {
        const ss = s as unknown as { tool?: unknown; output?: unknown; error?: unknown }
        return Boolean(ss.tool || ss.output || ss.error)
      })
      if (usefulSteps.length > 0) return <>{usefulSteps.map((s, idx) => renderStep(s, idx))}</>

      if (t.lastError) return <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {t.lastError}</div>
      return null
    },
    [api, openImageViewer, tasksById],
  )

  const renderMessageBlocks = useCallback(
    (m: ChatMessageRecord) => {
      const blocks: ChatMessageBlock[] =
        Array.isArray(m.blocks) && m.blocks.length > 0
          ? m.blocks
          : m.taskId
            ? (() => {
              const taskId = String(m.taskId ?? '').trim()
              const t = taskId ? tasksById.get(taskId) : null
              const runs = Array.isArray(t?.toolRuns) ? (t?.toolRuns ?? []) : []
              if (runs.length === 0) return [{ type: 'text', text: String(m.content ?? '') }]
              return [{ type: 'text', text: String(m.content ?? '') }, { type: 'tool_use', taskId }]
            })()
            : [{ type: 'text', text: String(m.content ?? '') }]

      let toolSeen = 0
      let statusSeen = 0
      let textSeen = 0
      return blocks.map((b) => {
        if (b.type === 'text') {
          const text = String(b.text ?? '')
          if (!text) return null
          return <MarkdownMessage key={`${m.id}-t-${textSeen++}`} text={text} />
        }
        if (b.type === 'status') {
          const text = String(b.text ?? '').trim()
          if (!text) return null
          return (
            <div key={`${m.id}-s-${statusSeen++}`} className="ndp-orbpanel-status">
              {text}
            </div>
          )
        }
        if (b.type === 'tool_use') {
          const rid = (b as { runId?: string }).runId
          const key = rid?.trim() ? `${m.id}-u-${rid}` : `${m.id}-u-${b.taskId}-${toolSeen++}`
          return <div key={key}>{renderToolCard(b.taskId, rid)}</div>
        }
        return null
      })
    },
    [renderToolCard, tasksById],
  )

  const openAttachment = useCallback(
    async (pathOrUrl: string) => {
      const raw = String(pathOrUrl ?? '').trim()
      if (!raw) return
      if (/^(https?:|data:|blob:)/i.test(raw)) {
        window.open(raw, '_blank')
        return
      }
      try {
        const res = await api?.getChatAttachmentUrl(raw)
        if (res?.ok && typeof res.url === 'string') {
          window.open(res.url, '_blank')
          return
        }
      } catch {
        /* ignore */
      }
      window.open(toLocalMediaSrc(raw), '_blank')
    },
    [api],
  )

  const renderMessageAttachments = useCallback(
    (m: ChatMessageRecord) => {
      const normalized: Array<{ kind: 'image' | 'video'; path?: string; dataUrl?: string; filename?: string }> = []

      if (Array.isArray(m.attachments)) {
        for (const a of m.attachments) {
          if (!a || typeof a !== 'object') continue
          const kind = (a as { kind?: unknown }).kind === 'video' ? 'video' : (a as { kind?: unknown }).kind === 'image' ? 'image' : ''
          const p = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
          const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
          if (!kind || !p) continue
          normalized.push({ kind, path: p, ...(filename ? { filename } : {}) })
        }
      }

      if (normalized.length === 0) {
        if (m.videoPath) normalized.push({ kind: 'video', path: String(m.videoPath) })
        if (m.imagePath) normalized.push({ kind: 'image', path: String(m.imagePath) })
        if (m.image && !m.imagePath) normalized.push({ kind: 'image', dataUrl: String(m.image) })
      }

      if (normalized.length === 0) return null

      const attachmentImageViewerItems = normalized
        .filter((a) => a.kind === 'image')
        .map((a, idx) => {
          const dataUrl = String(a.dataUrl ?? '').trim()
          const p = String(a.path ?? '').trim()
          const source = dataUrl || p
          return {
            source,
            title: String(a.filename ?? '').trim() || `图片 ${idx + 1}`,
          }
        })
        .filter((x) => Boolean(x.source))

      return (
        <div className="ndp-orbpanel-attachments" data-orb-nodrag="true">
          {normalized.map((a) => {
            const key = `${String(a.kind)}-${String(a.path ?? a.dataUrl ?? '')}`
            if (a.kind === 'video') {
              const p = String(a.path ?? '').trim()
              if (!p) return null
              return (
                <div key={key} className="ndp-orbpanel-attachment" title={p} onClick={() => void openAttachment(p)}>
                  <OrbLocalVideo api={api} className="ndp-orbpanel-video" videoPath={p} controls preload="metadata" playsInline />
                  <div className="ndp-orbpanel-attachment-meta">{a.filename || 'video'}</div>
                </div>
              )
            }

            const dataUrl = String(a.dataUrl ?? '').trim()
            const p = String(a.path ?? '').trim()
            const src = dataUrl || p
            if (!src) return null
            const imageNavIndex = attachmentImageViewerItems.findIndex((x) => x.source === src)
            return (
              <div
                key={key}
                className="ndp-orbpanel-attachment"
                title={src}
                onClick={() => {
                  if (imageNavIndex >= 0) void openImageViewer(attachmentImageViewerItems, imageNavIndex)
                }}
              >
                {dataUrl ? (
                  <img className="ndp-orbpanel-image" src={dataUrl} alt={a.filename || 'image'} />
                ) : (
                  <OrbImagePreview api={api} className="ndp-orbpanel-image" imagePath={p} alt={a.filename || 'image'} />
                )}
                <div className="ndp-orbpanel-attachment-meta">{a.filename || 'image'}</div>
              </div>
            )
          })}
        </div>
      )
    },
    [api, openAttachment, openImageViewer],
  )

  const messageMenuTarget = useMemo(() => {
    const id = String(messageMenu?.messageId ?? '').trim()
    if (!id) return null
    return panelMessages.find((m) => m.id === id) ?? null
  }, [messageMenu?.messageId, panelMessages])

  if (renderMode === 'ball') {
    return (
      <div
        ref={rootRef}
        className={rootClassName}
        onMouseDownCapture={(e) => {
          if (messageMenu) {
            const el = e.target as HTMLElement | null
            if (!el?.closest?.('[data-orb-msgmenu="true"]')) setMessageMenu(null)
          }
          if (!popover) return
          if (e.button !== 0) return
          const el = e.target as HTMLElement | null
          if (el?.closest?.('[data-orb-popover="true"]')) return
          closePopover()
        }}
      >
        <div
          className="ndp-orbapp-ball ndp-orbapp-ball-fixed"
          style={{
            alignSelf: dockSide === 'left' ? 'flex-start' : 'flex-end',
          }}
          onMouseDown={startDrag}
          onMouseUp={(e) => stopDrag({ x: e.screenX, y: e.screenY })}
          onContextMenu={openMenuPopover}
          title="单击：打开输入栏｜右键：菜单｜拖拽：移动并吸附"
        >
          <div className="ndp-orbapp-ball-icon"></div>
        </div>

        {popover?.kind === 'menu' && popover.ready ? (
          <div
            className="ndp-orbapp-popover"
            data-orb-popover="true"
            style={
              {
                left: popover.left,
                top: popover.top,
                width: MENU_WIDTH,
                borderRadius: MENU_RADIUS,
                ['--ndp-orbapp-popover-arrow-x' as never]: `${popover.arrowX}px`,
              } as React.CSSProperties
            }
          >
            <button
              className="ndp-orbapp-popover-item"
              onClick={() => void api?.openSettings().finally(() => openBall())}
              title="设置"
            >
              <span className="ndp-orbapp-popover-icon"></span>设置
            </button>
            <button
              className="ndp-orbapp-popover-item"
              onClick={() => {
                closePopover()
                void api?.setDisplayMode('live2d').catch(() => undefined)
              }}
              title="切换 Live2D 桌宠"
            >
              <span className="ndp-orbapp-popover-icon">🧸</span>切换 Live2D 桌宠
            </button>
            <button
              className="ndp-orbapp-popover-item"
              onClick={() => {
                closePopover()
                void api?.setDisplayMode('hidden').catch(() => undefined)
              }}
              title="关闭悬浮窗"
            >
              <span className="ndp-orbapp-popover-icon">✕</span>关闭悬浮窗
            </button>
            <div className="ndp-orbapp-popover-divider" />
            <button className="ndp-orbapp-popover-item" onClick={() => void api?.quit().finally(() => openBall())} title="退出">
              <span className="ndp-orbapp-popover-icon">⏻</span>退出
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      onMouseDownCapture={(e) => {
        if (messageMenu) {
          const el = e.target as HTMLElement | null
          if (!el?.closest?.('[data-orb-msgmenu="true"]')) setMessageMenu(null)
        }
        if (!popover) return
        if (e.button !== 0) return
        const el = e.target as HTMLElement | null
        if (el?.closest?.('[data-orb-popover="true"]')) return
        if (el?.closest?.('[data-orb-noclose="true"]')) return
        closePopover()
      }}
      onContextMenu={openMenuPopover}
    >
        <div className="ndp-orbapp-bar-frame">
          <div className="ndp-orbapp-bar-pill" aria-hidden="true">
            <div className="ndp-orbapp-ball-icon"></div>
          </div>
          <div className="ndp-orbapp-bar" title="输入栏" onMouseDown={onBarMouseDown} onMouseUp={(e) => onBarMouseUp(e)}>
            <div className="ndp-orbapp-bar-left" data-orb-nodrag="true">
              <button
                className="ndp-orbapp-btn"
                onClick={() => {
                  void (async () => {
                    const pid = activePersonaIdRef.current?.trim() || 'default'
                  const s = await api?.createChatSession(undefined, pid).catch(() => null)
                  if (s?.id) setCurrentSessionId(s.id)
                  void refreshSessions().catch(() => undefined)
                  setPanelSession(null)
                  setPanelMessages([])
                  setPanelError(null)
                  openBar()
                  closePopover()
                })().catch((err) => console.error(err))
              }}
              title="新对话"
            >
              ＋
            </button>
              <button
                className="ndp-orbapp-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  if (popover?.kind === 'history') {
                    closePopover()
                    return
                  }
                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                  const anchorX = rect.left + rect.width / 2
                  if (mode !== 'panel') {
                    openPanel()
                    window.setTimeout(() => openHistoryPopover(anchorX), 120)
                    return
                  }
                  openHistoryPopover(anchorX)
                }}
                title="历史对话"
                data-orb-noclose="true"
              >
                🕒
              </button>

              {pendingAttachments.length > 0 ? (
                <div className="ndp-orbapp-pending" data-orb-nodrag="true" title={`已添加附件：${pendingAttachments.length}个`}>
                  {pendingAttachments.slice(0, 3).map((a) => {
                    const label = a.filename || a.kind
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className="ndp-orbapp-pending-item"
                        onClick={() => removePendingAttachment(a.id)}
                        title={`移除${label}`}
                      >
                        {a.kind === 'video' ? (
                          <span className="ndp-orbapp-pending-video">🎞</span>
                        ) : a.previewDataUrl ? (
                          <img className="ndp-orbapp-pending-img" src={a.previewDataUrl} alt={label} />
                        ) : (
                          <OrbImagePreview api={api} className="ndp-orbapp-pending-img" imagePath={a.path} alt={label} />
                        )}
                        <span className="ndp-orbapp-pending-x">×</span>
                      </button>
                    )
                  })}
                  {pendingAttachments.length > 3 ? <span className="ndp-orbapp-pending-more">+{pendingAttachments.length - 3}</span> : null}
                </div>
              ) : null}
            </div>

          <input
            ref={inputRef}
            className="ndp-orbapp-input"
            data-orb-nodrag="true"
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
                setPanelError('只支持拖拽图片或视频文件')
                return
              }
              for (const file of files) {
                if (file.type.startsWith('image/')) void readChatImageFile(file)
                else void readChatVideoFile(file)
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (e.repeat) return
                if (e.nativeEvent.isComposing) return
                e.preventDefault()
                void onSend()
              }
              if (e.key === 'Escape') {
                openBall()
              }
            }}
            placeholder="描述任务需求（可拖拽图片/视频或粘贴截图）"
          />

          <div className="ndp-orbapp-bar-right" data-orb-nodrag="true">
            <button
              className="ndp-orbapp-send"
              onClick={() => void onSend()}
              disabled={!input.trim() && pendingAttachments.length === 0 && !sending}
              title={sending ? '点击取消' : '发送'}
            >
              ▶
            </button>
          </div>
        </div>
      </div>

      {renderMode === 'panel' ? (
        <div className="ndp-orbpanel">
          <div className="ndp-orbpanel-header" data-orb-nodrag="true">
            <div className="ndp-orbpanel-title" title={panelSession?.name || '未命名会话'}>
              {panelSession?.name || '未命名会话'}
            </div>
            <div className="ndp-orbpanel-actions">
              {currentSummary ? (
                <div className="ndp-orbpanel-meta">
                  {(currentSummary.messageCount ?? 0) > 0 ? `${currentSummary.messageCount}条` : '空对话'}
                </div>
              ) : null}
              <button
                className="ndp-orbpanel-action"
                onClick={() => {
                  void api
                    ?.openChat()
                    .finally(() => openBar())
                    .catch(() => undefined)
                }}
                title="打开完整聊天窗口"
              >
                ↗
              </button>
            </div>
          </div>

          <div className="ndp-orbpanel-body" ref={panelListRef} data-orb-nodrag="true">
            {panelLoading ? <div className="ndp-orbpanel-empty">加载中</div> : null}
            {panelError ? <div className="ndp-orbpanel-empty ndp-orbpanel-empty-error">{panelError}</div> : null}
            {!panelLoading && !panelError && panelMessages.length === 0 ? (
              <div className="ndp-orbpanel-empty">还没有消息</div>
            ) : null}

            {panelMessages.map((m) => {
              const isUser = m.role === 'user'
              const isEditing = isUser && editingMessageId === m.id
              const attachmentsNode = renderMessageAttachments(m)
              return (
                <div
                  key={m.id}
                  className={isUser ? 'ndp-orbpanel-msg ndp-orbpanel-msg-user' : 'ndp-orbpanel-msg ndp-orbpanel-msg-assistant'}
                  onContextMenu={(e) => openMessageMenu(e, m.id)}
                >
                  {isUser ? (
                    isEditing ? (
                      <div className="ndp-orbpanel-edit" data-orb-nodrag="true">
                        <textarea
                          className="ndp-orbpanel-edit-textarea"
                          value={editingMessageContent}
                          onChange={(e) => setEditingMessageContent(e.target.value)}
                          rows={3}
                          data-orb-nodrag="true"
                        />
                        <div className="ndp-orbpanel-edit-actions" data-orb-nodrag="true">
                          <button className="ndp-orbpanel-edit-btn" onClick={() => void handleSaveEdit()} data-orb-nodrag="true">
                            保存
                          </button>
                          <button
                            className="ndp-orbpanel-edit-btn"
                            onClick={() => void handleSaveEdit({ resend: true })}
                            data-orb-nodrag="true"
                          >
                            保存并重发
                          </button>
                          <button className="ndp-orbpanel-edit-btn ndp-orbpanel-edit-btn-ghost" onClick={handleCancelEdit} data-orb-nodrag="true">
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <MarkdownMessage text={String(m.content ?? '')} />
                    )
                  ) : (
                    renderMessageBlocks(m)
                  )}
                  {attachmentsNode}
                </div>
              )
            })}
            <div ref={panelEndRef} />
          </div>
        </div>
      ) : null}

      {imageViewer.open && imageViewer.items.length > 0 ? (
        <div className="ndp-orbimg-viewer" data-orb-nodrag="true" onClick={closeImageViewer}>
          <div className="ndp-orbimg-viewer-shell" data-orb-nodrag="true" onClick={(e) => e.stopPropagation()}>
            <div className="ndp-orbimg-viewer-toolbar" data-orb-nodrag="true">
              <div className="ndp-orbimg-viewer-title" title={imageViewer.items[imageViewer.index]?.title || ''}>
                {imageViewer.items[imageViewer.index]?.title || `图片 ${imageViewer.index + 1}`}
              </div>
              <div className="ndp-orbimg-viewer-meta">
                {imageViewer.index + 1}/{imageViewer.items.length}
              </div>
              <div className="ndp-orbimg-viewer-tools">
                <button className="ndp-orbimg-viewer-btn" onClick={resetImageViewerScale} title="重置缩放" data-orb-nodrag="true">
                  1:1
                </button>
                <button className="ndp-orbimg-viewer-btn" onClick={closeImageViewer} title="关闭" data-orb-nodrag="true">
                  关闭
                </button>
              </div>
            </div>
            <div className="ndp-orbimg-viewer-stage" data-orb-nodrag="true" onWheel={onImageViewerWheel}>
              {imageViewer.items.length > 1 ? (
                <button className="ndp-orbimg-viewer-nav" onClick={prevImageViewer} title="上一张" data-orb-nodrag="true">
                  ◀
                </button>
              ) : (
                <div />
              )}
              <img
                className="ndp-orbimg-viewer-img"
                src={imageViewer.items[imageViewer.index]?.src || ''}
                alt={imageViewer.items[imageViewer.index]?.title || 'image'}
                style={{ transform: `scale(${imageViewer.scale})` }}
              />
              {imageViewer.items.length > 1 ? (
                <button className="ndp-orbimg-viewer-nav" onClick={nextImageViewer} title="下一张" data-orb-nodrag="true">
                  ▶
                </button>
              ) : (
                <div />
              )}
            </div>
            <div className="ndp-orbimg-viewer-tip">滚轮缩放 · ←/→ 或 A/D 切换 · Esc 关闭</div>
          </div>
        </div>
      ) : null}

      {renderMode === 'panel' && messageMenu && messageMenuTarget ? (
        <div
          className="ndp-orbapp-msgmenu"
          data-orb-msgmenu="true"
          style={
            {
              left: messageMenu.left,
              top: messageMenu.top,
              width: MSG_MENU_WIDTH,
              borderRadius: MSG_MENU_RADIUS,
            } as React.CSSProperties
          }
        >
          {messageMenuTarget.role === 'assistant' ? (
            <button className="ndp-orbapp-msgmenu-item" onClick={() => void handleCopyAssistantText(messageMenuTarget.id)}>
              复制正文
            </button>
          ) : null}
          {messageMenuTarget.role === 'user' ? (
            <button className="ndp-orbapp-msgmenu-item" onClick={() => handleStartEdit(messageMenuTarget.id)}>
              编辑
            </button>
          ) : null}
          <button className="ndp-orbapp-msgmenu-item" onClick={() => void handleResend(messageMenuTarget.id)}>
            重新生成
          </button>
          <button className="ndp-orbapp-msgmenu-item" onClick={() => void handleDeleteMessage(messageMenuTarget.id)}>
            删除此条
          </button>
          <button className="ndp-orbapp-msgmenu-item" onClick={() => void handleDeleteTurn(messageMenuTarget.id)}>
            删除本轮
          </button>
        </div>
      ) : null}

      {popover?.kind === 'menu' && popover.ready ? (
        <div
          className="ndp-orbapp-popover"
          data-orb-popover="true"
          style={
            {
              left: popover.left,
              top: popover.top,
              width: MENU_WIDTH,
              borderRadius: MENU_RADIUS,
              ['--ndp-orbapp-popover-arrow-x' as never]: `${popover.arrowX}px`,
            } as React.CSSProperties
          }
        >
          <button className="ndp-orbapp-popover-item" onClick={() => void api?.openSettings().finally(() => openBall())} title="设置">
            <span className="ndp-orbapp-popover-icon"></span>设置
          </button>
          <button
            className="ndp-orbapp-popover-item"
            onClick={() => {
              closePopover()
              void api?.setDisplayMode('live2d').catch(() => undefined)
            }}
            title="切换 Live2D 桌宠"
          >
            <span className="ndp-orbapp-popover-icon">🧸</span>切换 Live2D 桌宠
          </button>
          <button
            className="ndp-orbapp-popover-item"
            onClick={() => {
              closePopover()
              void api?.setDisplayMode('hidden').catch(() => undefined)
            }}
            title="关闭悬浮窗"
          >
            <span className="ndp-orbapp-popover-icon">✕</span>关闭悬浮窗
          </button>
          <div className="ndp-orbapp-popover-divider" />
          <button className="ndp-orbapp-popover-item" onClick={() => void api?.quit().finally(() => openBall())} title="退出">
            <span className="ndp-orbapp-popover-icon">⏻</span>退出
          </button>
        </div>
      ) : null}

      {popover?.kind === 'history' && popover.ready ? (
        <div
          className="ndp-orbapp-popover"
          data-orb-popover="true"
          style={
            {
              left: popover.left,
              top: popover.top,
              width: HISTORY_WIDTH,
              borderRadius: MENU_RADIUS,
              ['--ndp-orbapp-popover-arrow-x' as never]: `${popover.arrowX}px`,
            } as React.CSSProperties
          }
        >
          {popover.sessions.length > 0 ? (
            popover.sessions.map((s) => (
              <div key={s.id} className="ndp-orbapp-popover-row">
                <button
                  className="ndp-orbapp-popover-item ndp-orbapp-popover-item-main"
                  onClick={() => {
                    void (async () => {
                      await api?.setCurrentChatSession(s.id)
                      setCurrentSessionId(s.id)
                      void refreshSessions().catch(() => undefined)
                      closePopover()
                      if (mode !== 'panel') setTimeout(() => openPanel(), 40)
                    })().catch((err) => console.error(err))
                  }}
                  title={s.name}
                >
                  <span className="ndp-orbapp-popover-icon">🕒</span>
                  <span className="ndp-orbapp-popover-text">
                    {s.name || '未命名会话'}
                    <span className="ndp-orbapp-popover-count">{(s.messageCount ?? 0) > 0 ? String(s.messageCount) : '空'}</span>
                  </span>
                </button>

                <button
                  className="ndp-orbapp-popover-action"
                  title="删除该会话"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void (async () => {
                      const token = popoverTokenRef.current
                      setPopover((prev) =>
                        prev?.kind === 'history' ? { ...prev, sessions: prev.sessions.filter((x) => x.id !== s.id) } : prev,
                      )

                      try {
                        const res = await api?.deleteChatSession(s.id)
                        await refreshSessions().catch(() => undefined)
                        if (popoverTokenRef.current !== token) return

                        const pid = activePersonaIdRef.current?.trim() || 'default'
                        const sessions = (res?.sessions ?? [])
                          .filter((x) => x.personaId === pid)
                          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                          .slice(0, HISTORY_MAX_ITEMS)
                          .map((x) => ({ id: x.id, name: x.name || '未命名会话', messageCount: x.messageCount ?? 0 }))

                        setPopover((prev) => (prev?.kind === 'history' ? { ...prev, sessions } : prev))
                      } catch (err) {
                        console.error(err)
                        if (popoverTokenRef.current !== token) return
                        void api
                          ?.listChatSessions()
                          .then((r) => {
                            if (popoverTokenRef.current !== token) return
                            const pid = activePersonaIdRef.current?.trim() || 'default'
                            const sessions = (r?.sessions ?? [])
                              .filter((x) => x.personaId === pid)
                              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                              .slice(0, HISTORY_MAX_ITEMS)
                              .map((x) => ({ id: x.id, name: x.name || '未命名会话', messageCount: x.messageCount ?? 0 }))
                            setPopover((prev) => (prev?.kind === 'history' ? { ...prev, sessions } : prev))
                          })
                          .catch(() => undefined)
                      }
                    })()
                  }}
                >
                  ×
                </button>
              </div>
            ))
          ) : popover.loading ? (
            <div className="ndp-orbapp-popover-empty">加载中</div>
          ) : (
            <div className="ndp-orbapp-popover-empty">暂无历史对话</div>
          )}
          <div className="ndp-orbapp-popover-divider" />
          <button
            className="ndp-orbapp-popover-item"
            onClick={() => {
              void api
                ?.openChat()
                .finally(() => openBall())
                .finally(() => closePopover())
            }}
          >
            <span className="ndp-orbapp-popover-icon">→</span>
            <span className="ndp-orbapp-popover-text">查看全部历史对话</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}



