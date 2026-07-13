import './orb.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
import { useProgressiveMessageWindow } from '../hooks/useProgressiveMessageWindow'
import { ABORTED_ERROR, getAIService, type ChatMessage } from '../services/aiService'
import {
  computeAppendDelta,
  filterVisibleToolRuns,
  joinTextBlocks,
  mergeLeadingPunctuationAcrossToolBoundary,
  normalizeInterleavedTextSegment,
} from '../utils/chatMessages'
import { OrbBallView } from './OrbBallView'
import { OrbBarView, type OrbPendingAttachment } from './OrbBarView'
import { OrbAssistantMessageContent } from './OrbAssistantMessageContent'
import { OrbHistoryPopover } from './OrbHistoryPopover'
import { OrbImageViewer, type OrbImageViewerItem } from './OrbImageViewer'
import { OrbMessageAttachments } from './OrbMessageAttachments'
import { OrbMessageMenu } from './OrbMessageMenu'
import { OrbPanelView } from './OrbPanelView'
import { buildOrbHistoryItems, getOrbHistoryPopoverPosition, type OrbHistoryItem } from './orbHistoryUtils'
import type { OrbImageViewerRequestItem } from './orbMessageContentUtils'
import { getOrbMessageMenuPosition } from './orbMessageMenuUtils'

type OrbMode = 'ball' | 'bar' | 'panel'
type PopoverKind = 'history'
type OrbUiTransition =
  | 'idle'
  | 'opening-bar'
  | 'opening-panel'
  | 'expanding-panel'
  | 'closing-bar-to-ball'
  | 'closing-panel-to-ball'

const ORB_BALL_SIZE = 40
const ORB_BAR_HEIGHT = 80
const ORB_UI_OPEN_MS = 220
const ORB_UI_CLOSE_MS = 260

function normalizeMode(state: OrbUiState): OrbMode {
  if (state === 'ball') return 'ball'
  if (state === 'panel') return 'panel'
  return 'bar'
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function getDockSideFromWindow(): 'left' | 'right' {
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
}

function getDockSideFromScreenX(screenX: number): 'left' | 'right' {
  try {
    const s = screen as unknown as { availLeft?: number; availWidth?: number; width?: number }
    const screenLeft = s.availLeft ?? 0
    const screenWidth = s.availWidth ?? screen.width
    const screenCenterX = screenLeft + screenWidth / 2
    return screenX < screenCenterX ? 'left' : 'right'
  } catch {
    return 'left'
  }
}

function newMessageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function OrbApp(props: { api: ReturnType<typeof getApi> }) {
  const { api } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<OrbMode>('ball')
  const [renderMode, setRenderMode] = useState<OrbMode>('ball')
  const [dockSide, setDockSide] = useState<'left' | 'right'>(() => getDockSideFromWindow())
  const [uiTransition, setUiTransition] = useState<OrbUiTransition>('idle')
  const [resizeMask, setResizeMask] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const dragLastPointRef = useRef<{ x: number; y: number } | null>(null)
  const prevModeRef = useRef<OrbMode>('ball')
  const dockSideRef = useRef<'left' | 'right'>(dockSide)
  const transitionTimerRef = useRef<number | null>(null)
  const resizeMaskRafRef = useRef<number | null>(null)

  useEffect(() => {
    dockSideRef.current = dockSide
  }, [dockSide])

  const [pendingAttachments, setPendingAttachments] = useState<OrbPendingAttachment[]>([])
  const [imageViewer, setImageViewer] = useState<{ open: boolean; items: OrbImageViewerItem[]; index: number }>({
    open: false,
    items: [],
    index: 0,
  })
  const imageViewerReqRef = useRef(0)
  const pendingAttachmentsRef = useRef<OrbPendingAttachment[]>([])
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
    | {
        kind: 'history'
        left: number
        top: number
        arrowX: number
        ready: boolean
        loading: boolean
        sessions: OrbHistoryItem[]
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
    (att: Omit<OrbPendingAttachment, 'id'>) => {
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

        const saved = await api
          .saveChatAttachmentFile(file, 'image', file.name)
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
      try {
        setPanelError(null)
        const saved = await api.saveChatAttachmentFile(file, 'video', file.name || 'video.mp4')
        if (saved?.ok) {
          addPendingAttachment({
            kind: 'video',
            path: saved.path,
            resourceId: saved.resourceId,
            filename: saved.filename,
          })
        }
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

  const syncDockSide = useCallback((next: 'left' | 'right') => {
    dockSideRef.current = next
    setDockSide(next)
  }, [])

  const lockDockSide = useCallback((): 'left' | 'right' => {
    const next = dockSideRef.current
    syncDockSide(next)
    return next
  }, [syncDockSide])

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

  const clearUiTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current == null) return
    window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
  }, [])

  const clearResizeMaskRaf = useCallback(() => {
    if (resizeMaskRafRef.current == null) return
    window.cancelAnimationFrame(resizeMaskRafRef.current)
    resizeMaskRafRef.current = null
  }, [])

  useEffect(() => {
    const prevMode = prevModeRef.current
    prevModeRef.current = mode

    if (mode !== 'ball') {
      setRenderMode(mode)

      clearUiTransitionTimer()
      const nextTransition: OrbUiTransition =
        prevMode === 'ball'
          ? mode === 'panel'
            ? 'opening-panel'
            : 'opening-bar'
          : prevMode === 'bar' && mode === 'panel'
            ? 'expanding-panel'
            : 'idle'

      setUiTransition(nextTransition)
      if (nextTransition !== 'idle') {
        transitionTimerRef.current = window.setTimeout(() => {
          transitionTimerRef.current = null
          setUiTransition('idle')
        }, ORB_UI_OPEN_MS)
      }
      return
    }

    clearUiTransitionTimer()
    setUiTransition('idle')

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
  }, [clearUiTransitionTimer, mode])

  useEffect(
    () => () => {
      clearUiTransitionTimer()
      clearResizeMaskRaf()
    },
    [clearResizeMaskRaf, clearUiTransitionTimer],
  )

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

  const openBall = useCallback((opts?: { immediate?: boolean }) => {
    if (!api) return
    if (mode === 'ball') return
    popoverTokenRef.current += 1
    setPopover(null)
    setMessageMenu(null)
    overlayActiveRef.current = false
    clearOverlayBounds({ force: true })

    clearUiTransitionTimer()
    if (opts?.immediate) {
      setUiTransition('idle')
      void api.setOrbUiState('ball', { focus: false, animate: false }).catch((err) => console.error(err))
      return
    }

    const closingTransition: OrbUiTransition = renderMode === 'panel' ? 'closing-panel-to-ball' : 'closing-bar-to-ball'
    if (uiTransition === 'closing-panel-to-ball' || uiTransition === 'closing-bar-to-ball') return
    setUiTransition(closingTransition)
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null
      void api.setOrbUiState('ball', { focus: false, animate: false }).catch((err) => console.error(err))
    }, ORB_UI_CLOSE_MS)
  }, [api, clearOverlayBounds, clearUiTransitionTimer, mode, renderMode, uiTransition])

  const openBar = useCallback(() => {
    if (!api) return
    clearUiTransitionTimer()
    clearResizeMaskRaf()
    const nextTransition: OrbUiTransition = mode === 'ball' ? 'opening-bar' : 'idle'
    if (mode === 'ball') {
      flushSync(() => {
        setResizeMask(true)
      })
      resizeMaskRafRef.current = window.requestAnimationFrame(() => {
        resizeMaskRafRef.current = null
        flushSync(() => {
          lockDockSide()
          setRenderMode('bar')
          setUiTransition(nextTransition)
        })
        void api.setOrbUiState('bar', { focus: true, animate: false }).catch((err) => console.error(err))
        resizeMaskRafRef.current = window.requestAnimationFrame(() => {
          resizeMaskRafRef.current = null
          setResizeMask(false)
        })
      })
    } else {
      flushSync(() => {
        lockDockSide()
        setRenderMode('bar')
        setUiTransition(nextTransition)
      })
      void api.setOrbUiState('bar', { focus: true, animate: false }).catch((err) => console.error(err))
    }
    if (nextTransition !== 'idle') {
      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null
        setUiTransition('idle')
      }, ORB_UI_OPEN_MS)
    }
  }, [api, clearResizeMaskRaf, clearUiTransitionTimer, lockDockSide, mode])

  const openPanel = useCallback(() => {
    if (!api) return
    clearUiTransitionTimer()
    clearResizeMaskRaf()
    const nextTransition: OrbUiTransition =
      mode === 'ball' ? 'opening-panel' : mode === 'bar' ? 'expanding-panel' : 'idle'
    if (mode === 'ball') {
      flushSync(() => {
        setResizeMask(true)
      })
      resizeMaskRafRef.current = window.requestAnimationFrame(() => {
        resizeMaskRafRef.current = null
        flushSync(() => {
          lockDockSide()
          setRenderMode('panel')
          setUiTransition(nextTransition)
        })
        void api.setOrbUiState('panel', { focus: true, animate: false }).catch((err) => console.error(err))
        resizeMaskRafRef.current = window.requestAnimationFrame(() => {
          resizeMaskRafRef.current = null
          setResizeMask(false)
        })
      })
    } else {
      flushSync(() => {
        lockDockSide()
        setRenderMode('panel')
        setUiTransition(nextTransition)
      })
      void api.setOrbUiState('panel', { focus: true, animate: false }).catch((err) => console.error(err))
    }
    if (nextTransition !== 'idle') {
      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null
        setUiTransition('idle')
      }, ORB_UI_OPEN_MS)
    }
  }, [api, clearResizeMaskRaf, clearUiTransitionTimer, lockDockSide, mode])

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

      // agent.run 壳 run 只是任务外壳，不是用户可感知的工具调用（兜旧存档/旧主进程写入的脏数据）
      const runs = filterVisibleToolRuns(Array.isArray(t.toolRuns) ? t.toolRuns : [])
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
      if (!isClick) {
        syncDockSide(getDockSideFromScreenX(e.x))
      }
      if (!isClick) return

      if (popoverKindRef.current) {
        closePopover()
        return
      }

      if (mode === 'ball') {
        const sid = String(currentSessionId ?? '').trim()
        const summary = sid ? sessionSummaries.find((s) => s.id === sid) ?? null : null
        const hasMessages = typeof summary?.messageCount === 'number' && summary.messageCount > 0
        if (hasMessages) openPanel()
        else openBar()
      }
    },
    [api, closePopover, currentSessionId, mode, openBar, openPanel, sessionSummaries, syncDockSide],
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

      const position = getOrbHistoryPopoverPosition(anchorCenterX, window.innerWidth)
      const token = (popoverTokenRef.current += 1)
      setPopover({ kind: 'history', ...position, ready: false, loading: true, sessions: [] })
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
          const recent = buildOrbHistoryItems(res?.sessions ?? [], pid)
          setPopover((prev) => (prev?.kind === 'history' ? { ...prev, loading: false, sessions: recent } : prev))
        })
        .catch(() => {
          if (popoverTokenRef.current !== token) return
          setPopover((prev) => (prev?.kind === 'history' ? { ...prev, loading: false } : prev))
        })
    },
    [api, setOverlayDataset],
  )

  const selectHistorySession = useCallback(
    (sessionId: string) => {
      void (async () => {
        await api?.setCurrentChatSession(sessionId)
        setCurrentSessionId(sessionId)
        void refreshSessions().catch(() => undefined)
        closePopover()
        if (mode !== 'panel') setTimeout(() => openPanel(), 40)
      })().catch((error) => console.error(error))
    },
    [api, closePopover, mode, openPanel, refreshSessions],
  )

  const deleteHistorySession = useCallback(
    (sessionId: string) => {
      void (async () => {
        const token = popoverTokenRef.current
        setPopover((prev) =>
          prev?.kind === 'history' ? { ...prev, sessions: prev.sessions.filter((session) => session.id !== sessionId) } : prev,
        )

        try {
          const result = await api?.deleteChatSession(sessionId)
          await refreshSessions().catch(() => undefined)
          if (popoverTokenRef.current !== token) return
          const personaId = activePersonaIdRef.current?.trim() || 'default'
          const sessions = buildOrbHistoryItems(result?.sessions ?? [], personaId)
          setPopover((prev) => (prev?.kind === 'history' ? { ...prev, sessions } : prev))
        } catch (error) {
          console.error(error)
          if (popoverTokenRef.current !== token) return
          void api
            ?.listChatSessions()
            .then((result) => {
              if (popoverTokenRef.current !== token) return
              const personaId = activePersonaIdRef.current?.trim() || 'default'
              const sessions = buildOrbHistoryItems(result?.sessions ?? [], personaId)
              setPopover((prev) => (prev?.kind === 'history' ? { ...prev, sessions } : prev))
            })
            .catch(() => undefined)
        }
      })()
    },
    [api, refreshSessions],
  )

  const openAllHistory = useCallback(() => {
    void api
      ?.openChat()
      .finally(() => openBall())
      .finally(() => closePopover())
  }, [api, closePopover, openBall])

  const onSend = useCallback(async (opts?: { text?: string; attachments?: OrbPendingAttachment[]; seedMessages?: ChatMessageRecord[] }) => {
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
                resourceId: a.resourceId,
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

      const target = panelMessagesRef.current.find((m) => m.id === messageId) ?? null
      const rect = rootRef.current?.getBoundingClientRect()
      const position = getOrbMessageMenuPosition({
        clientX: e.clientX,
        clientY: e.clientY,
        rootBounds: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        role: target?.role,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })

      closePopover()
      setMessageMenu({ messageId, ...position })
    },
    [closeMessageMenu, closePopover, messageMenu?.messageId, mode],
  )

  const handleStartEdit = useCallback(
    (messageId: string) => {
      const msg = panelMessagesRef.current.find((m) => m.id === messageId) ?? null
      if (!msg) return
      const editText =
        msg.role === 'assistant' && Array.isArray(msg.blocks) && msg.blocks.length > 0
          ? joinTextBlocks(msg.blocks) || String(msg.content ?? '')
          : String(msg.content ?? '')
      setEditingMessageId(messageId)
      setEditingMessageContent(editText)
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

      const resendAttachments: OrbPendingAttachment[] = resendAttachmentsRaw
        .map((a) => {
          const kind = (a as { kind?: unknown }).kind === 'video' ? ('video' as const) : ('image' as const)
          const path = typeof (a as { path?: unknown }).path === 'string' ? String((a as { path: string }).path).trim() : ''
          const resourceId =
            typeof (a as { resourceId?: unknown }).resourceId === 'string'
              ? String((a as { resourceId: string }).resourceId).trim()
              : ''
          const filename = typeof (a as { filename?: unknown }).filename === 'string' ? String((a as { filename: string }).filename).trim() : ''
          if (!path) return null
          return {
            id: newAttachmentId(),
            kind,
            path,
            ...(resourceId ? { resourceId } : {}),
            filename: filename || (kind === 'video' ? 'video.mp4' : 'image.png'),
          }
        })
        .filter((a): a is OrbPendingAttachment => !!a)

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

      const nextContent = String(editingMessageContent ?? '')
      const prev = panelMessagesRef.current
      const target = prev.find((m) => m.id === messageId) ?? null
      if (!target) return
      const isAssistant = target.role === 'assistant'
      const nextBlocks: ChatMessageBlock[] | undefined = isAssistant ? [{ type: 'text', text: nextContent }] : undefined
      const next = prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: nextContent,
              ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
              updatedAt: Date.now(),
            }
          : m,
      )
      applyPanelMessages(next)

      try {
        await api.updateChatMessageRecord(sid, messageId, {
          content: nextContent,
          ...(isAssistant ? { blocks: nextBlocks, taskId: undefined } : {}),
        })
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
    const classes = [`ndp-orbapp-root`, `ndp-orbapp-mode-${renderMode}`, `ndp-orbapp-dock-${dockSide}`]
    if (dragging) classes.push('ndp-orbapp-dragging')
    if (resizeMask) classes.push('ndp-orbapp-resize-mask')
    if (uiTransition !== 'idle') classes.push(`ndp-orbapp-transition-${uiTransition}`)
    return classes.join(' ')
  }, [dockSide, dragging, renderMode, resizeMask, uiTransition])

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
      if (/^(https?:|data:|blob:)/i.test(raw)) return raw
      try {
        const res = await api?.getChatAttachmentUrl(raw)
        if (res?.ok && typeof res.url === 'string') return res.url
      } catch {
        /* ignore */
      }
      return ''
    },
    [api],
  )

  const openImageViewer = useCallback(
    async (items: OrbImageViewerRequestItem[], startIndex = 0) => {
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
      setImageViewer({ open: true, items: finalItems, index: safeIndex })
    },
    [resolveImageViewerSrc],
  )

  const closeImageViewer = useCallback(() => {
    setImageViewer((prev) => ({ ...prev, open: false }))
  }, [])

  const setImageViewerIndex = useCallback((index: number) => {
    setImageViewer((prev) => {
      if (!prev.open || prev.items.length === 0) return prev
      const safeIndex = Math.max(0, Math.min(Math.trunc(index), prev.items.length - 1))
      return { ...prev, index: safeIndex }
    })
  }, [])

  const renderMessageBlocks = useCallback(
    (message: ChatMessageRecord) => (
      <OrbAssistantMessageContent
        api={api}
        message={message}
        tasksById={tasksById}
        onOpenImageViewer={openImageViewer}
      />
    ),
    [api, openImageViewer, tasksById],
  )

  const openAttachment = useCallback(
    async (pathOrUrl: string, resourceId?: string) => {
      const raw = String(pathOrUrl ?? '').trim()
      if (!raw) return
      if (/^(https?:|data:|blob:)/i.test(raw)) {
        window.open(raw, '_blank')
        return
      }
      try {
        const res = await api?.getChatAttachmentUrl(resourceId ? { resourceId, path: raw } : raw)
        if (res?.ok && typeof res.url === 'string') {
          window.open(res.url, '_blank')
          return
        }
      } catch {
        /* ignore */
      }
    },
    [api],
  )

  const renderMessageAttachments = useCallback(
    (message: ChatMessageRecord) => (
      <OrbMessageAttachments
        api={api}
        message={message}
        onOpenAttachment={openAttachment}
        onOpenImageViewer={openImageViewer}
      />
    ),
    [api, openAttachment, openImageViewer],
  )

  const {
    visibleItems: visiblePanelMessages,
    hiddenCount: hiddenPanelMessageCount,
    loadEarlier: loadEarlierPanelMessageWindow,
  } = useProgressiveMessageWindow(panelMessages, currentSessionId ?? '')
  const loadEarlierPanelMessages = useCallback(() => {
    const list = panelListRef.current
    const previousScrollHeight = list?.scrollHeight ?? 0
    loadEarlierPanelMessageWindow()
    if (!list) return
    window.requestAnimationFrame(() => {
      const current = panelListRef.current
      if (!current) return
      current.scrollTop += Math.max(0, current.scrollHeight - previousScrollHeight)
    })
  }, [loadEarlierPanelMessageWindow])

  const messageMenuTarget = useMemo(() => {
    const id = String(messageMenu?.messageId ?? '').trim()
    if (!id) return null
    return panelMessages.find((m) => m.id === id) ?? null
  }, [messageMenu?.messageId, panelMessages])

  const startNewConversation = useCallback(() => {
    void (async () => {
      const personaId = activePersonaIdRef.current?.trim() || 'default'
      const session = await api?.createChatSession(undefined, personaId).catch(() => null)
      if (session?.id) setCurrentSessionId(session.id)
      void refreshSessions().catch(() => undefined)
      setPanelSession(null)
      setPanelMessages([])
      setPanelError(null)
      openBar()
      closePopover()
    })().catch((error) => console.error(error))
  }, [api, closePopover, openBar, refreshSessions])

  const toggleHistoryFromBar = useCallback(
    (anchorCenterX: number) => {
      if (popover?.kind === 'history') {
        closePopover()
        return
      }
      if (mode !== 'panel') {
        openPanel()
        window.setTimeout(() => openHistoryPopover(anchorCenterX), 120)
        return
      }
      openHistoryPopover(anchorCenterX)
    },
    [closePopover, mode, openHistoryPopover, openPanel, popover?.kind],
  )

  const addBarMediaFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) void readChatImageFile(file)
        else if (file.type.startsWith('video/')) void readChatVideoFile(file)
      }
    },
    [readChatImageFile, readChatVideoFile],
  )

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
        <OrbBallView dockSide={dockSide} onMouseDown={startDrag} onDragStop={stopDrag} onContextMenu={openMenuPopover} />
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
      <div className="ndp-orbapp-shell">
        <div className="ndp-orbapp-shell-skin" aria-hidden="true"></div>
        <div className="ndp-orbapp-shell-main">
          <OrbBarView
            api={api}
            inputRef={inputRef}
            input={input}
            pendingAttachments={pendingAttachments}
            sending={sending}
            onBarMouseDown={onBarMouseDown}
            onBarMouseUp={onBarMouseUp}
            onNewConversation={startNewConversation}
            onToggleHistory={toggleHistoryFromBar}
            onRemoveAttachment={removePendingAttachment}
            onInputChange={setInput}
            onMediaFiles={addBarMediaFiles}
            onInvalidDrop={() => setPanelError('只支持拖拽图片或视频文件')}
            onSubmit={() => void onSend()}
            onClose={openBall}
          />

          {renderMode === 'panel' ? (
            <OrbPanelView
              sessionName={panelSession?.name}
              summary={currentSummary}
              loading={panelLoading}
              error={panelError}
              messages={visiblePanelMessages}
              hiddenMessageCount={hiddenPanelMessageCount}
              listRef={panelListRef}
              endRef={panelEndRef}
              editingMessageId={editingMessageId}
              editingMessageContent={editingMessageContent}
              renderAssistantMessage={renderMessageBlocks}
              renderAttachments={renderMessageAttachments}
              onOpenFullChat={() => {
                void api
                  ?.openChat()
                  .finally(() => openBar())
                  .catch(() => undefined)
              }}
              onLoadEarlierMessages={loadEarlierPanelMessages}
              onMessageContextMenu={openMessageMenu}
              onEditingMessageContentChange={setEditingMessageContent}
              onSaveEdit={(resend) => void handleSaveEdit(resend ? { resend: true } : undefined)}
              onCancelEdit={handleCancelEdit}
            />
          ) : null}

        </div>
      </div>

      {imageViewer.open ? (
        <OrbImageViewer
          items={imageViewer.items}
          index={imageViewer.index}
          onIndexChange={setImageViewerIndex}
          onClose={closeImageViewer}
        />
      ) : null}

      {renderMode === 'panel' && messageMenu && messageMenuTarget ? (
        <OrbMessageMenu
          message={messageMenuTarget}
          left={messageMenu.left}
          top={messageMenu.top}
          onCopyAssistantText={() => void handleCopyAssistantText(messageMenuTarget.id)}
          onEdit={() => handleStartEdit(messageMenuTarget.id)}
          onResend={() => void handleResend(messageMenuTarget.id)}
          onDeleteMessage={() => void handleDeleteMessage(messageMenuTarget.id)}
          onDeleteTurn={() => void handleDeleteTurn(messageMenuTarget.id)}
        />
      ) : null}

      {popover?.kind === 'history' && popover.ready ? (
        <OrbHistoryPopover
          left={popover.left}
          top={popover.top}
          arrowX={popover.arrowX}
          loading={popover.loading}
          sessions={popover.sessions}
          onSelect={selectHistorySession}
          onDelete={deleteHistorySession}
          onOpenAll={openAllHistory}
        />
      ) : null}
    </div>
  )
}



