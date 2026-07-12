import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { ChatMessageRecord, ChatSession, ChatSessionSummary } from './types'

type SessionNameMode = 'auto' | 'manual'

type DatabaseHandle = import('better-sqlite3').Database

const MAX_SESSIONS = 30

// 旧版使用 electron-store（每次写入全量序列化整个聊天历史到 JSON，阻塞主进程且随
// 数据量线性恶化）。现迁移到 better-sqlite3：追加一条消息只是一次 INSERT。
// 对外 API 签名与旧版完全一致，调用方零改动。

let dbHandle: DatabaseHandle | null = null

type SessionRow = {
  id: string
  name: string
  name_mode: string
  persona_id: string
  auto_extract_cursor: number
  auto_extract_last_run_at: number
  auto_extract_last_write_count: number
  auto_extract_last_error: string
  created_at: number
  updated_at: number
}

type MessageRow = {
  id: string
  role: string
  content: string
  created_at: number
  updated_at: number | null
  extra: string | null
}

function db(): DatabaseHandle {
  if (dbHandle) return dbHandle

  const require = createRequire(import.meta.url)
  const mod = require('better-sqlite3') as unknown as { default?: unknown }
  const Database = (mod.default ?? mod) as unknown as { new (file: string): DatabaseHandle }
  const userDataDir = app.getPath('userData')
  const dbPath = path.join(userDataDir, 'neodeskpet-chat.sqlite3')
  const handle = new Database(dbPath)

  handle.pragma('journal_mode = WAL')
  handle.pragma('synchronous = NORMAL')
  handle.pragma('foreign_keys = ON')

  handle.exec(`
    CREATE TABLE IF NOT EXISTS chat_session (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_mode TEXT NOT NULL DEFAULT 'auto',
      persona_id TEXT NOT NULL DEFAULT 'default',
      auto_extract_cursor INTEGER NOT NULL DEFAULT 0,
      auto_extract_last_run_at INTEGER NOT NULL DEFAULT 0,
      auto_extract_last_write_count INTEGER NOT NULL DEFAULT 0,
      auto_extract_last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_message (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      extra TEXT,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES chat_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_message_session_seq ON chat_message(session_id, seq);
    CREATE TABLE IF NOT EXISTS chat_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  dbHandle = handle
  migrateFromLegacyJson(handle, userDataDir)
  return handle
}

function now(): number {
  return Date.now()
}

// ---------- meta ----------

function getMeta(key: string): string {
  const row = db().prepare('SELECT value FROM chat_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? ''
}

function setMeta(key: string, value: string): void {
  db().prepare('INSERT INTO chat_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ---------- 行 <-> 对象 ----------

// 可选字段（attachments/image/imagePath/videoPath/taskId/blocks 等）整体存入 extra JSON，
// 避免类型每加一个可选字段就改一次表结构。
const MESSAGE_CORE_FIELDS = new Set(['id', 'role', 'content', 'createdAt', 'updatedAt'])

function messageExtra(m: ChatMessageRecord): string | null {
  const slim: Record<string, unknown> = {}
  let count = 0
  for (const [k, v] of Object.entries(m)) {
    if (MESSAGE_CORE_FIELDS.has(k) || v === undefined) continue
    slim[k] = v
    count++
  }
  if (count === 0) return null
  try {
    return JSON.stringify(slim)
  } catch {
    return null
  }
}

function rowToMessage(r: MessageRow): ChatMessageRecord {
  let extra: Record<string, unknown> = {}
  if (r.extra) {
    try {
      const parsed = JSON.parse(r.extra) as unknown
      if (parsed && typeof parsed === 'object') extra = parsed as Record<string, unknown>
    } catch {
      // ignore broken extra
    }
  }
  const role = (r.role === 'user' || r.role === 'assistant' || r.role === 'system' ? r.role : 'assistant') as ChatMessageRecord['role']
  return {
    ...(extra as Partial<ChatMessageRecord>),
    id: r.id,
    role,
    content: r.content,
    createdAt: r.created_at,
    ...(typeof r.updated_at === 'number' ? { updatedAt: r.updated_at } : {}),
  }
}

function getSessionMessages(sessionId: string): ChatMessageRecord[] {
  const rows = db()
    .prepare('SELECT id, role, content, created_at, updated_at, extra FROM chat_message WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as MessageRow[]
  return rows.map(rowToMessage)
}

function rowToSession(r: SessionRow): ChatSession {
  return {
    id: r.id,
    name: r.name,
    nameMode: (r.name_mode === 'manual' ? 'manual' : 'auto') as SessionNameMode,
    personaId: r.persona_id,
    autoExtractCursor: r.auto_extract_cursor,
    autoExtractLastRunAt: r.auto_extract_last_run_at,
    autoExtractLastWriteCount: r.auto_extract_last_write_count,
    autoExtractLastError: r.auto_extract_last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messages: getSessionMessages(r.id),
  }
}

function getSessionRow(sessionId: string): SessionRow | undefined {
  return db().prepare('SELECT * FROM chat_session WHERE id = ?').get(sessionId) as SessionRow | undefined
}

// ---------- 基础操作 ----------

function insertSessionRow(s: {
  id: string
  name: string
  nameMode: SessionNameMode
  personaId: string
  createdAt: number
  updatedAt: number
}): void {
  db()
    .prepare(
      `INSERT INTO chat_session (id, name, name_mode, persona_id, created_at, updated_at)
       VALUES (@id, @name, @nameMode, @personaId, @createdAt, @updatedAt)`,
    )
    .run(s)
}

function insertMessageRow(sessionId: string, seq: number, m: ChatMessageRecord): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO chat_message (session_id, id, seq, role, content, created_at, updated_at, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, m.id, seq, m.role, m.content ?? '', m.createdAt ?? now(), m.updatedAt ?? null, messageExtra(m))
}

function nextSeq(sessionId: string): number {
  const row = db().prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM chat_message WHERE session_id = ?').get(sessionId) as {
    maxSeq: number
  }
  return row.maxSeq + 1
}

function touchSession(sessionId: string, ts?: number): void {
  db().prepare('UPDATE chat_session SET updated_at = ? WHERE id = ?').run(ts ?? now(), sessionId)
}

function sessionCount(): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM chat_session').get() as { n: number }
  return row.n
}

function createSessionInDb(name: string | undefined, personaId: string): string {
  const ts = now()
  const cleaned = name?.trim()
  const nameMode: SessionNameMode = cleaned && cleaned.length > 0 ? 'manual' : 'auto'
  const id = randomUUID()
  insertSessionRow({
    id,
    name: cleaned && cleaned.length > 0 ? cleaned : '新对话',
    nameMode,
    personaId,
    createdAt: ts,
    updatedAt: ts,
  })
  return id
}

// 会话数量超过上限时淘汰最旧的（按 updated_at）
function clampSessionsInDb(): void {
  const n = sessionCount()
  if (n <= MAX_SESSIONS) return
  const victims = db()
    .prepare('SELECT id FROM chat_session ORDER BY updated_at DESC LIMIT -1 OFFSET ?')
    .all(MAX_SESSIONS) as Array<{ id: string }>
  const del = db().prepare('DELETE FROM chat_session WHERE id = ?')
  for (const v of victims) del.run(v.id)
}

// 保证至少存在一个会话，并保证 currentSessionId 有效（对应旧版 normalizeState 的兜底语义）
function ensureConsistent(): string {
  const d = db()
  if (sessionCount() === 0) {
    const id = createSessionInDb(undefined, 'default')
    setMeta('currentSessionId', id)
    return id
  }
  let current = getMeta('currentSessionId')
  if (!current || !getSessionRow(current)) {
    const first = d.prepare('SELECT id FROM chat_session ORDER BY updated_at DESC LIMIT 1').get() as { id: string }
    current = first.id
    setMeta('currentSessionId', current)
  }
  return current
}

function autoSessionNameFromFirstMessage(content: string): string | null {
  const text = content.trim().replace(/\s+/g, ' ')
  if (!text) return null
  return text.slice(0, 24) + (text.length > 24 ? '…' : '')
}

// ---------- 旧 electron-store JSON 一次性迁移 ----------

function migrateFromLegacyJson(handle: DatabaseHandle, userDataDir: string): void {
  try {
    if (getMetaWith(handle, 'migratedFromJson') === '1') return
    const legacyPath = path.join(userDataDir, 'neodeskpet-chat.json')
    if (!fs.existsSync(legacyPath)) {
      setMetaWith(handle, 'migratedFromJson', '1')
      return
    }

    const raw = fs.readFileSync(legacyPath, 'utf-8').replace(/^\uFEFF/, '')
    const state = JSON.parse(raw) as {
      currentSessionId?: string
      sessions?: Array<Partial<ChatSession> & { messages?: ChatMessageRecord[] }>
    }
    const sessions = Array.isArray(state.sessions) ? state.sessions : []

    const run = handle.transaction(() => {
      for (const s of sessions) {
        if (!s || typeof s.id !== 'string' || !s.id) continue
        const messages = Array.isArray(s.messages) ? s.messages : []
        const personaId = typeof s.personaId === 'string' && s.personaId.trim() ? s.personaId : 'default'
        const nameMode: SessionNameMode =
          s.nameMode === 'manual' || s.nameMode === 'auto'
            ? s.nameMode
            : s.name === '新对话' || String(s.name ?? '').startsWith('对话 ')
              ? 'auto'
              : 'manual'
        let name = typeof s.name === 'string' && s.name ? s.name : '新对话'
        // 旧版语义：auto 命名且已有消息的会话用第一条用户消息当标题
        if (nameMode === 'auto' && (name === '新对话' || name.startsWith('对话 ')) && messages.length > 0) {
          const firstUser = messages.find((m) => m.role === 'user' && m.content?.trim())
          const auto = firstUser ? autoSessionNameFromFirstMessage(firstUser.content) : null
          if (auto) name = auto
        }

        handle
          .prepare(
            `INSERT OR REPLACE INTO chat_session
             (id, name, name_mode, persona_id, auto_extract_cursor, auto_extract_last_run_at,
              auto_extract_last_write_count, auto_extract_last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            s.id,
            name,
            nameMode,
            personaId,
            Math.max(0, Math.trunc(Number(s.autoExtractCursor) || 0)),
            Math.max(0, Math.trunc(Number(s.autoExtractLastRunAt) || 0)),
            Math.max(0, Math.trunc(Number(s.autoExtractLastWriteCount) || 0)),
            typeof s.autoExtractLastError === 'string' ? s.autoExtractLastError : '',
            Number(s.createdAt) || now(),
            Number(s.updatedAt) || now(),
          )

        const insMsg = handle.prepare(
          `INSERT OR REPLACE INTO chat_message (session_id, id, seq, role, content, created_at, updated_at, extra)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        messages.forEach((m, i) => {
          if (!m || typeof m.id !== 'string' || !m.id) return
          insMsg.run(
            s.id,
            m.id,
            i,
            m.role ?? 'assistant',
            m.content ?? '',
            Number(m.createdAt) || now(),
            typeof m.updatedAt === 'number' ? m.updatedAt : null,
            messageExtra(m),
          )
        })
      }
      if (typeof state.currentSessionId === 'string' && state.currentSessionId) {
        setMetaWith(handle, 'currentSessionId', state.currentSessionId)
      }
      setMetaWith(handle, 'migratedFromJson', '1')
    })
    run()

    // 迁移成功后把旧文件改名备份（不删除）；失败不影响使用
    try {
      fs.renameSync(legacyPath, `${legacyPath}.migrated-backup`)
    } catch {
      // ignore
    }
    console.log(`[ChatStore] migrated ${sessions.length} sessions from legacy JSON to SQLite`)
  } catch (err) {
    console.error('[ChatStore] legacy JSON migration failed:', err)
    // 标记已尝试，避免每次启动重复失败；旧文件保留可手动恢复
    try {
      setMetaWith(handle, 'migratedFromJson', '1')
    } catch {
      // ignore
    }
  }
}

// 迁移期间 dbHandle 尚未赋值，meta 读写需要显式句柄
function getMetaWith(handle: DatabaseHandle, key: string): string {
  const row = handle.prepare('SELECT value FROM chat_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? ''
}

function setMetaWith(handle: DatabaseHandle, key: string, value: string): void {
  handle.prepare('INSERT INTO chat_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ---------- 对外 API（签名与旧版一致） ----------

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

function summaryRowOf(r: SessionRow): ChatSessionSummary {
  const countRow = db().prepare('SELECT COUNT(*) AS n FROM chat_message WHERE session_id = ?').get(r.id) as { n: number }
  const lastRow = db()
    .prepare('SELECT content FROM chat_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
    .get(r.id) as { content: string } | undefined
  const preview = lastRow?.content?.trim()
  return {
    id: r.id,
    name: r.name,
    personaId: r.persona_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: countRow.n,
    autoExtractCursor: r.auto_extract_cursor,
    autoExtractLastRunAt: r.auto_extract_last_run_at,
    autoExtractLastWriteCount: r.auto_extract_last_write_count,
    autoExtractLastError: r.auto_extract_last_error,
    lastMessagePreview: preview ? preview.slice(0, 60) : undefined,
  }
}

export function listChatSessions(): { sessions: ChatSessionSummary[]; currentSessionId: string } {
  const currentSessionId = ensureConsistent()
  const rows = db().prepare('SELECT * FROM chat_session ORDER BY updated_at DESC').all() as SessionRow[]
  return { sessions: rows.map(summaryRowOf), currentSessionId }
}

export function getChatSession(sessionId?: string): ChatSession {
  const current = ensureConsistent()
  const id = sessionId ?? current
  const row = getSessionRow(id) ?? (getSessionRow(current) as SessionRow)
  return rowToSession(row)
}

export function setCurrentChatSession(sessionId: string): { currentSessionId: string } {
  ensureConsistent()
  if (getSessionRow(sessionId)) setMeta('currentSessionId', sessionId)
  return { currentSessionId: getMeta('currentSessionId') }
}

export function createChatSession(name?: string, personaId?: string): ChatSession {
  ensureConsistent()
  const pid = personaId?.trim() || 'default'
  const tx = db().transaction(() => {
    const id = createSessionInDb(name, pid)
    setMeta('currentSessionId', id)
    clampSessionsInDb()
    return id
  })
  return getChatSession(tx())
}

export function renameChatSession(sessionId: string, name: string): ChatSessionSummary {
  ensureConsistent()
  const cleaned = name.trim()
  if (cleaned && getSessionRow(sessionId)) {
    db().prepare("UPDATE chat_session SET name = ?, name_mode = 'manual', updated_at = ? WHERE id = ?").run(cleaned, now(), sessionId)
  }
  const row = getSessionRow(sessionId)
  return row ? summaryRowOf(row) : toSummary(getChatSession(sessionId))
}

export function deleteChatSession(sessionId: string): { sessions: ChatSessionSummary[]; currentSessionId: string } {
  ensureConsistent()
  const tx = db().transaction(() => {
    const removed = getSessionRow(sessionId)
    const fallbackPersonaId = removed?.persona_id?.trim() || 'default'
    db().prepare('DELETE FROM chat_session WHERE id = ?').run(sessionId)
    if (sessionCount() === 0) {
      const id = createSessionInDb(undefined, fallbackPersonaId)
      setMeta('currentSessionId', id)
    }
  })
  tx()
  return listChatSessions()
}

export function clearChatSession(sessionId: string): ChatSession {
  ensureConsistent()
  const tx = db().transaction(() => {
    const row = getSessionRow(sessionId)
    if (!row) return
    const ts = now()
    db().prepare('DELETE FROM chat_message WHERE session_id = ?').run(sessionId)
    if (row.name_mode !== 'manual') {
      db()
        .prepare(
          `UPDATE chat_session SET name = '新对话', name_mode = 'auto', created_at = ?, updated_at = ?,
           auto_extract_cursor = 0, auto_extract_last_run_at = 0, auto_extract_last_write_count = 0, auto_extract_last_error = ''
           WHERE id = ?`,
        )
        .run(ts, ts, sessionId)
    } else {
      db()
        .prepare(
          `UPDATE chat_session SET updated_at = ?,
           auto_extract_cursor = 0, auto_extract_last_run_at = 0, auto_extract_last_write_count = 0, auto_extract_last_error = ''
           WHERE id = ?`,
        )
        .run(ts, sessionId)
    }
  })
  tx()
  return getChatSession(sessionId)
}

export function setChatMessages(sessionId: string, messages: ChatMessageRecord[]): ChatSession {
  ensureConsistent()
  const tx = db().transaction(() => {
    if (!getSessionRow(sessionId)) return
    db().prepare('DELETE FROM chat_message WHERE session_id = ?').run(sessionId)
    messages.forEach((m, i) => insertMessageRow(sessionId, i, m))
    touchSession(sessionId)
  })
  tx()
  return getChatSession(sessionId)
}

export function addChatMessage(sessionId: string, message: ChatMessageRecord): ChatSession {
  ensureConsistent()
  const tx = db().transaction(() => {
    const row = getSessionRow(sessionId)
    if (!row) return
    const seq = nextSeq(sessionId)
    insertMessageRow(sessionId, seq, message)

    // 首条用户消息触发自动命名（与旧版语义一致）
    if (seq === 0 && row.name_mode !== 'manual' && message.role === 'user') {
      const auto = autoSessionNameFromFirstMessage(message.content)
      if (auto) db().prepare('UPDATE chat_session SET name = ? WHERE id = ?').run(auto, sessionId)
    }
    touchSession(sessionId)
  })
  tx()
  return getChatSession(sessionId)
}

export function updateChatMessage(sessionId: string, messageId: string, content: string): ChatSession {
  ensureConsistent()
  const ts = now()
  db().prepare('UPDATE chat_message SET content = ?, updated_at = ? WHERE session_id = ? AND id = ?').run(content, ts, sessionId, messageId)
  touchSession(sessionId, ts)
  return getChatSession(sessionId)
}

export function updateChatMessageRecord(sessionId: string, messageId: string, patch: unknown): ChatSession {
  if (!patch || typeof patch !== 'object') return getChatSession(sessionId)
  ensureConsistent()

  const p = patch as Partial<ChatMessageRecord> & Record<string, unknown>

  const tx = db().transaction(() => {
    const row = db()
      .prepare('SELECT id, role, content, created_at, updated_at, extra FROM chat_message WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as MessageRow | undefined
    if (!row) return

    const current = rowToMessage(row)
    const next: ChatMessageRecord = { ...current }

    if ('content' in p && typeof p.content === 'string') next.content = p.content
    if ('attachments' in p) {
      next.attachments = Array.isArray(p.attachments) ? (p.attachments as ChatMessageRecord['attachments']) : undefined
    }
    if ('image' in p) next.image = typeof p.image === 'string' ? p.image : undefined
    if ('imagePath' in p) next.imagePath = typeof p.imagePath === 'string' ? p.imagePath : undefined
    if ('videoPath' in p) next.videoPath = typeof p.videoPath === 'string' ? p.videoPath : undefined
    if ('taskId' in p) next.taskId = typeof p.taskId === 'string' ? p.taskId : undefined
    if ('blocks' in p) next.blocks = Array.isArray(p.blocks) ? (p.blocks as ChatMessageRecord['blocks']) : undefined
    next.updatedAt = now()

    db()
      .prepare('UPDATE chat_message SET content = ?, updated_at = ?, extra = ? WHERE session_id = ? AND id = ?')
      .run(next.content ?? '', next.updatedAt, messageExtra(next), sessionId, messageId)
    touchSession(sessionId, next.updatedAt)
  })
  tx()
  return getChatSession(sessionId)
}

export function deleteChatMessage(sessionId: string, messageId: string): ChatSession {
  ensureConsistent()
  db().prepare('DELETE FROM chat_message WHERE session_id = ? AND id = ?').run(sessionId, messageId)
  touchSession(sessionId)
  return getChatSession(sessionId)
}

export function setChatSessionAutoExtractCursor(sessionId: string, cursor: number): ChatSession {
  ensureConsistent()
  const nextCursor = Math.max(0, Math.trunc(Number.isFinite(cursor) ? cursor : 0))
  db().prepare('UPDATE chat_session SET auto_extract_cursor = ? WHERE id = ?').run(nextCursor, sessionId)
  return getChatSession(sessionId)
}

export function setChatSessionAutoExtractMeta(sessionId: string, patch: unknown): ChatSession {
  if (!patch || typeof patch !== 'object') return getChatSession(sessionId)
  ensureConsistent()

  const sets: string[] = []
  const args: Array<number | string> = []

  if ('autoExtractCursor' in patch) {
    const n = Number((patch as { autoExtractCursor?: unknown }).autoExtractCursor)
    if (Number.isFinite(n)) {
      sets.push('auto_extract_cursor = ?')
      args.push(Math.max(0, Math.trunc(n)))
    }
  }
  if ('autoExtractLastRunAt' in patch) {
    const n = Number((patch as { autoExtractLastRunAt?: unknown }).autoExtractLastRunAt)
    if (Number.isFinite(n)) {
      sets.push('auto_extract_last_run_at = ?')
      args.push(Math.max(0, Math.trunc(n)))
    }
  }
  if ('autoExtractLastWriteCount' in patch) {
    const n = Number((patch as { autoExtractLastWriteCount?: unknown }).autoExtractLastWriteCount)
    if (Number.isFinite(n)) {
      sets.push('auto_extract_last_write_count = ?')
      args.push(Math.max(0, Math.trunc(n)))
    }
  }
  if ('autoExtractLastError' in patch) {
    const v = (patch as { autoExtractLastError?: unknown }).autoExtractLastError
    if (typeof v === 'string') {
      sets.push('auto_extract_last_error = ?')
      args.push(v.trim().slice(0, 2000))
    }
  }

  if (sets.length === 0) return getChatSession(sessionId)

  db()
    .prepare(`UPDATE chat_session SET ${sets.join(', ')} WHERE id = ?`)
    .run(...args, sessionId)
  return getChatSession(sessionId)
}
