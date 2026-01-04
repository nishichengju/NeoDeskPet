import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import type { ChatMessageRecord, ChatSession, ChatSessionSummary } from './types'

type ChatStoreState = {
  version: 1
  currentSessionId: string
  sessions: ChatSession[]
}

type SessionNameMode = 'auto' | 'manual'

const MAX_SESSIONS = 30

const store = new Store<ChatStoreState>({
  name: 'neodeskpet-chat',
  defaults: {
    version: 1,
    currentSessionId: '',
    sessions: [],
  },
})

function now(): number {
  return Date.now()
}

function createSession(name: string | undefined, personaId: string): ChatSession {
  const ts = now()
  const cleaned = name?.trim()
  const nameMode: SessionNameMode = cleaned && cleaned.length > 0 ? 'manual' : 'auto'
  return {
    id: randomUUID(),
    name: cleaned && cleaned.length > 0 ? cleaned : '新对话',
    nameMode,
    personaId,
    autoExtractCursor: 0,
    autoExtractLastRunAt: 0,
    autoExtractLastWriteCount: 0,
    autoExtractLastError: '',
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  }
}

function toSummary(session: ChatSession): ChatSessionSummary {
  const last = session.messages[session.messages.length - 1]
  const preview = last?.content?.trim()
  return {
    id: session.id,
    name: session.name,
    personaId: session.personaId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    autoExtractCursor: session.autoExtractCursor ?? 0,
    autoExtractLastRunAt: session.autoExtractLastRunAt ?? 0,
    autoExtractLastWriteCount: session.autoExtractLastWriteCount ?? 0,
    autoExtractLastError: session.autoExtractLastError ?? '',
    lastMessagePreview: preview ? preview.slice(0, 60) : undefined,
  }
}

function autoSessionNameFromFirstMessage(content: string): string | null {
  const text = content.trim().replace(/\s+/g, ' ')
  if (!text) return null
  const shortened = text.slice(0, 24) + (text.length > 24 ? '…' : '')
  return shortened
}

function normalizeState(state: ChatStoreState | undefined): ChatStoreState {
  const s = state ?? store.store
  const sessions = Array.isArray(s.sessions) ? s.sessions : []
  let currentSessionId = typeof s.currentSessionId === 'string' ? s.currentSessionId : ''

  if (sessions.length === 0) {
    const initial = createSession(undefined, 'default')
    const next: ChatStoreState = { version: 1, currentSessionId: initial.id, sessions: [initial] }
    store.store = next
    return next
  }

  // Normalize legacy sessions: default personaId if missing
  for (const session of sessions) {
    const pid = (session as unknown as { personaId?: string }).personaId
    if (typeof pid === 'string' && pid.trim().length > 0) continue
    ;(session as unknown as { personaId: string }).personaId = 'default'
  }

  // Normalize legacy sessions: infer nameMode if missing
  for (const session of sessions) {
    const candidate = (session as unknown as { nameMode?: SessionNameMode }).nameMode
    if (candidate === 'auto' || candidate === 'manual') continue

    const inferred: SessionNameMode =
      session.name === '新对话' || session.name.startsWith('对话 ') ? 'auto' : 'manual'
    ;(session as unknown as { nameMode: SessionNameMode }).nameMode = inferred
  }

  // Normalize legacy sessions: autoExtractCursor default
  for (const session of sessions) {
    const cursor = (session as unknown as { autoExtractCursor?: unknown }).autoExtractCursor
    if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) continue
    ;(session as unknown as { autoExtractCursor: number }).autoExtractCursor = 0
  }

  // Normalize legacy sessions: autoExtractLastRunAt default
  for (const session of sessions) {
    const v = (session as unknown as { autoExtractLastRunAt?: unknown }).autoExtractLastRunAt
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) continue
    ;(session as unknown as { autoExtractLastRunAt: number }).autoExtractLastRunAt = 0
  }

  // Normalize legacy sessions: autoExtractLastWriteCount default
  for (const session of sessions) {
    const v = (session as unknown as { autoExtractLastWriteCount?: unknown }).autoExtractLastWriteCount
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) continue
    ;(session as unknown as { autoExtractLastWriteCount: number }).autoExtractLastWriteCount = 0
  }

  // Normalize legacy sessions: autoExtractLastError default
  for (const session of sessions) {
    const v = (session as unknown as { autoExtractLastError?: unknown }).autoExtractLastError
    if (typeof v === 'string') continue
    ;(session as unknown as { autoExtractLastError: string }).autoExtractLastError = ''
  }

  // If it is auto-named and already has messages, use the first user message as the title.
  for (const session of sessions) {
    const nameMode = (session as unknown as { nameMode?: SessionNameMode }).nameMode ?? 'auto'
    if (nameMode !== 'auto') continue
    if (!(session.name === '新对话' || session.name.startsWith('对话 '))) continue
    if (!Array.isArray(session.messages) || session.messages.length === 0) continue

    const firstUser = session.messages.find((m) => m.role === 'user' && m.content.trim().length > 0)
    if (!firstUser) continue
    const auto = autoSessionNameFromFirstMessage(firstUser.content)
    if (!auto) continue
    session.name = auto
  }

  if (!currentSessionId || !sessions.some((x) => x.id === currentSessionId)) {
    currentSessionId = sessions[0].id
    const next: ChatStoreState = { version: 1, currentSessionId, sessions }
    store.store = next
    return next
  }

  return { version: 1, currentSessionId, sessions }
}

function writeState(mutator: (draft: ChatStoreState) => void): ChatStoreState {
  const draft = normalizeState(store.store)
  mutator(draft)
  store.store = draft
  return normalizeState(store.store)
}

function clampSessions(sessions: ChatSession[]): ChatSession[] {
  if (sessions.length <= MAX_SESSIONS) return sessions
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return sorted.slice(0, MAX_SESSIONS)
}

export function listChatSessions(): { sessions: ChatSessionSummary[]; currentSessionId: string } {
  const state = normalizeState(store.store)
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(toSummary)
  return { sessions, currentSessionId: state.currentSessionId }
}

export function getChatSession(sessionId?: string): ChatSession {
  const state = normalizeState(store.store)
  const id = sessionId ?? state.currentSessionId
  const session = state.sessions.find((s) => s.id === id)
  return session ?? state.sessions[0]
}

export function setCurrentChatSession(sessionId: string): { currentSessionId: string } {
  const state = writeState((draft) => {
    if (draft.sessions.some((s) => s.id === sessionId)) {
      draft.currentSessionId = sessionId
    }
  })
  return { currentSessionId: state.currentSessionId }
}

export function createChatSession(name?: string, personaId?: string): ChatSession {
  const pid = personaId?.trim() || 'default'
  const created = createSession(name, pid)
  const state = writeState((draft) => {
    draft.sessions = clampSessions([created, ...draft.sessions])
    draft.currentSessionId = created.id
  })
  return getChatSession(state.currentSessionId)
}

export function renameChatSession(sessionId: string, name: string): ChatSessionSummary {
  const cleaned = name.trim()
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    draft.sessions[idx] = {
      ...draft.sessions[idx],
      name: cleaned || draft.sessions[idx].name,
      nameMode: 'manual',
      updatedAt: now(),
    }
  })
  return toSummary(getChatSession(sessionId))
}

export function deleteChatSession(sessionId: string): { sessions: ChatSessionSummary[]; currentSessionId: string } {
  writeState((draft) => {
    const removed = draft.sessions.find((s) => s.id === sessionId)
    const fallbackPersonaId = removed?.personaId?.trim() || 'default'
    const remaining = draft.sessions.filter((s) => s.id !== sessionId)
    draft.sessions = remaining.length > 0 ? remaining : [createSession(undefined, fallbackPersonaId)]
    if (!draft.sessions.some((s) => s.id === draft.currentSessionId)) {
      draft.currentSessionId = draft.sessions[0].id
    }
  })
  return listChatSessions()
}

export function clearChatSession(sessionId: string): ChatSession {
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const session = draft.sessions[idx]
    const nameMode = (session as unknown as { nameMode?: SessionNameMode }).nameMode ?? 'auto'
    const shouldResetTitle = nameMode === 'auto'
    const ts = now()
    draft.sessions[idx] = {
      ...session,
      ...(shouldResetTitle ? { name: '新对话', nameMode: 'auto', createdAt: ts } : { nameMode }),
      messages: [],
      autoExtractCursor: 0,
      autoExtractLastRunAt: 0,
      autoExtractLastWriteCount: 0,
      autoExtractLastError: '',
      updatedAt: ts,
    }
  })
  return getChatSession(sessionId)
}

export function setChatMessages(sessionId: string, messages: ChatMessageRecord[]): ChatSession {
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    draft.sessions[idx] = {
      ...draft.sessions[idx],
      messages,
      updatedAt: now(),
    }
  })
  return getChatSession(sessionId)
}

export function addChatMessage(sessionId: string, message: ChatMessageRecord): ChatSession {
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return

    const session = draft.sessions[idx]
    const nextMessages = [...session.messages, message]

    let nextName = session.name
    const nameMode = (session as unknown as { nameMode?: SessionNameMode }).nameMode ?? 'auto'
    if (session.messages.length === 0 && nameMode === 'auto' && message.role === 'user') {
      const auto = autoSessionNameFromFirstMessage(message.content)
      if (auto) nextName = auto
    }

    draft.sessions[idx] = {
      ...session,
      name: nextName,
      nameMode,
      messages: nextMessages,
      updatedAt: now(),
    }
  })
  return getChatSession(sessionId)
}

export function updateChatMessage(sessionId: string, messageId: string, content: string): ChatSession {
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return

    const session = draft.sessions[idx]
    const nextMessages = session.messages.map((m) =>
      m.id === messageId ? { ...m, content, updatedAt: now() } : m,
    )
    draft.sessions[idx] = { ...session, messages: nextMessages, updatedAt: now() }
  })
  return getChatSession(sessionId)
}

export function updateChatMessageRecord(sessionId: string, messageId: string, patch: unknown): ChatSession {
  if (!patch || typeof patch !== 'object') return getChatSession(sessionId)

  const p = patch as Partial<ChatMessageRecord> & Record<string, unknown>
  const cleaned: Partial<ChatMessageRecord> = {}

  if ('content' in p) {
    if (typeof p.content === 'string') cleaned.content = p.content
  }
  if ('image' in p) {
    if (typeof p.image === 'string') cleaned.image = p.image
    else if (p.image == null) cleaned.image = undefined
  }
  if ('taskId' in p) {
    if (typeof p.taskId === 'string') cleaned.taskId = p.taskId
    else if (p.taskId == null) cleaned.taskId = undefined
  }
  if ('blocks' in p) {
    if (Array.isArray(p.blocks)) cleaned.blocks = p.blocks as unknown as ChatMessageRecord['blocks']
    else if (p.blocks == null) cleaned.blocks = undefined
  }

  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return

    const session = draft.sessions[idx]
    const nextMessages = session.messages.map((m) => (m.id === messageId ? { ...m, ...cleaned, updatedAt: now() } : m))
    draft.sessions[idx] = { ...session, messages: nextMessages, updatedAt: now() }
  })
  return getChatSession(sessionId)
}

export function deleteChatMessage(sessionId: string, messageId: string): ChatSession {
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return

    const session = draft.sessions[idx]
    draft.sessions[idx] = { ...session, messages: session.messages.filter((m) => m.id !== messageId), updatedAt: now() }
  })
  return getChatSession(sessionId)
}

export function setChatSessionAutoExtractCursor(sessionId: string, cursor: number): ChatSession {
  const nextCursor = Math.max(0, Math.trunc(Number.isFinite(cursor) ? cursor : 0))
  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const session = draft.sessions[idx]
    draft.sessions[idx] = { ...session, autoExtractCursor: nextCursor }
  })
  return getChatSession(sessionId)
}

export function setChatSessionAutoExtractMeta(sessionId: string, patch: unknown): ChatSession {
  if (!patch || typeof patch !== 'object') return getChatSession(sessionId)

  const cleaned: Partial<
    Pick<
      ChatSession,
      'autoExtractCursor' | 'autoExtractLastRunAt' | 'autoExtractLastWriteCount' | 'autoExtractLastError'
    >
  > = {}

  if ('autoExtractCursor' in patch) {
    const v = (patch as { autoExtractCursor?: unknown }).autoExtractCursor
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) cleaned.autoExtractCursor = Math.max(0, Math.trunc(n))
  }
  if ('autoExtractLastRunAt' in patch) {
    const v = (patch as { autoExtractLastRunAt?: unknown }).autoExtractLastRunAt
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) cleaned.autoExtractLastRunAt = Math.max(0, Math.trunc(n))
  }
  if ('autoExtractLastWriteCount' in patch) {
    const v = (patch as { autoExtractLastWriteCount?: unknown }).autoExtractLastWriteCount
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) cleaned.autoExtractLastWriteCount = Math.max(0, Math.trunc(n))
  }
  if ('autoExtractLastError' in patch) {
    const v = (patch as { autoExtractLastError?: unknown }).autoExtractLastError
    if (typeof v === 'string') cleaned.autoExtractLastError = v.trim().slice(0, 2000)
  }

  if (Object.keys(cleaned).length === 0) return getChatSession(sessionId)

  writeState((draft) => {
    const idx = draft.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const session = draft.sessions[idx]
    draft.sessions[idx] = { ...session, ...cleaned }
  })
  return getChatSession(sessionId)
}
