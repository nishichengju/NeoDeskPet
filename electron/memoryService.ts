import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import type {
  AISettings,
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  MemoryFilterArgs,
  MemoryListArgs,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryListResult,
  MemoryListVersionsArgs,
  MemoryMetaPatch,
  MemoryOrderBy,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryVersionRecord,
  MemoryRecord,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemoryUpdateArgs,
  MemoryUpsertManualArgs,
  MemorySettings,
  Persona,
  PersonaSummary,
} from './types'

type DatabaseHandle = import('better-sqlite3').Database

export type MemoryIngestChatMessageArgs = {
  personaId: string
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

function now(): number {
  return Date.now()
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function ftsQueryFromText(text: string): string | null {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  if (!cleaned) return null

  // 若没有空格（中文常见），尝试拆分成字符 token，提高召回
  if (!/\s/.test(cleaned) && cleaned.length >= 2) {
    const chars = Array.from(cleaned)
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((c) => /[\p{L}\p{N}]/u.test(c))
      .slice(0, 12)

    if (chars.length >= 2) {
      return chars.map((c) => `"${c.replace(/"/g, '')}"`).join(' OR ')
    }
  }

  const tokens = cleaned
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)

  if (tokens.length === 0) return null
  // 用 OR 提高召回率；FTS5 会自动做 BM25 排序
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

function extractKeywordFromQueryForLike(query: string): string | null {
  const raw = query.trim()
  if (!raw) return null

  let text = raw
    .replace(/[，。！？,.!?；;：:“”"'（）()【】[\]{}<>《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // 常见“记忆提问”外壳词，去掉后更容易提取实体/关键词
  text = text
    .replace(/^(你|我)?(还)?(记得|想得起|能想起)(我|我们)?(说过|提过|讲过|聊过)?/u, '')
    .replace(/^(还)?(记得|想得起|能想起)(我|我们)?(说过|提过|讲过|聊过)?/u, '')
    .replace(/^(你|我)?(之前|以前|刚才|刚刚|那天|那次|上次)(说过|提过|讲过|聊过)?/u, '')
    .replace(/[吗呢吧呀啊哦哇]$/u, '')
    .trim()

  if (!text) return null

  const candidates = Array.from(text.matchAll(/[\p{L}\p{N}]{2,}/gu)).map((m) => m[0])
  if (candidates.length === 0) return null

  const stop = new Set(['还记得', '记得', '想得起', '能想起', '之前', '以前', '刚才', '刚刚', '那天', '那次', '上次', '说过', '提过', '讲过', '聊过'])
  const filtered = candidates.filter((c) => !stop.has(c))
  const pickFrom = filtered.length ? filtered : candidates

  pickFrom.sort((a, b) => b.length - a.length)
  const best = pickFrom[0]?.trim() ?? ''
  if (best.length < 2) return null
  return best.length > 40 ? best.slice(0, 40) : best
}

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

function hashEmbeddingInput(model: string, text: string): string {
  const normalized = normalizeMemoryText(text)
  return createHash('sha1').update(`${model}\n${normalized}`).digest('hex')
}

function normalizeEntityKey(textRaw: string): string {
  return normalizeMemoryText(textRaw)
    .replace(/[，。！？；：,.!?;:、【】「」『』（）()《》<>“”"'\s]/g, '')
    .trim()
    .toLowerCase()
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // ignore
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  const slice = cleaned.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return null
  }
  return null
}

function extractTagsFromText(textRaw: string, opts?: { maxTags?: number }): string[] {
  const maxTags = clampInt(opts?.maxTags, 24, 4, 80)
  const text = normalizeMemoryText(textRaw)
    .replace(/[，。！？；：,.!?;:、【】「」『』（）()《》<>“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return []

  const tags: string[] = []
  const seen = new Set<string>()

  const stop = new Set([
    '我',
    '你',
    '他',
    '她',
    '它',
    '我们',
    '你们',
    '他们',
    '这是',
    '那个',
    '这个',
    '什么',
    '怎么',
    '为什么',
    '是否',
    '还是',
    '记得',
    '还记得',
    '能不能',
    '可以吗',
  ])

  const push = (t: string) => {
    const tag = t.trim()
    if (tag.length < 2) return
    if (tag.length > 40) return
    if (stop.has(tag)) return
    if (seen.has(tag)) return
    seen.add(tag)
    tags.push(tag)
  }

  // 英文/数字关键词
  for (const m of text.matchAll(/[A-Za-z0-9_]{2,}/g)) {
    push(m[0].toLowerCase())
    if (tags.length >= maxTags) return tags
  }

  // 中文（Han）用 n-gram 提升“截句/换说法”命中
  for (const m of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = m[0]
    const chars = Array.from(chunk).slice(0, 32)
    for (const n of [4, 3, 2]) {
      if (chars.length < n) continue
      for (let i = 0; i <= chars.length - n; i++) {
        push(chars.slice(i, i + n).join(''))
        if (tags.length >= maxTags) return tags
      }
    }
  }

  // 兜底：其他字母/数字连续片段
  for (const m of text.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    push(m[0])
    if (tags.length >= maxTags) return tags
  }

  return tags
}

function diceCoefficient(aRaw: string, bRaw: string): number {
  const a = normalizeMemoryText(aRaw).replace(/[，。！？,.!?；;：:]/g, '').replace(/\s+/g, '')
  const b = normalizeMemoryText(bRaw).replace(/[，。！？,.!?；;：:]/g, '').replace(/\s+/g, '')
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const counts = new Map<string, number>()
  const aChars = Array.from(a)
  for (let i = 0; i < aChars.length - 1; i++) {
    const bg = aChars[i] + aChars[i + 1]
    counts.set(bg, (counts.get(bg) ?? 0) + 1)
  }

  let intersection = 0
  const bChars = Array.from(b)
  for (let i = 0; i < bChars.length - 1; i++) {
    const bg = bChars[i] + bChars[i + 1]
    const n = counts.get(bg) ?? 0
    if (n <= 0) continue
    intersection += 1
    if (n === 1) counts.delete(bg)
    else counts.set(bg, n - 1)
  }

  const total = (aChars.length - 1) + (bChars.length - 1)
  if (total <= 0) return 0
  return (2 * intersection) / total
}

function extractKeyValue(textRaw: string): { key: string; value: string } | null {
  const text = normalizeMemoryText(textRaw)
  if (!text) return null

  const colon = text.match(/^(.{2,20})[：:]\s*(.{1,80})$/u)
  if (colon) {
    const key = colon[1].trim()
    const value = colon[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  const eq = text.match(/^(.{2,20})\s*[=＝]\s*(.{1,80})$/u)
  if (eq) {
    const key = eq[1].trim()
    const value = eq[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  const shi = text.match(/^(.{2,18})是(.{1,80})$/u)
  if (shi) {
    const key = shi[1].trim()
    const value = shi[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  return null
}

type TimeRangeParseResult = {
  startMs: number
  endMs: number
  quoteOnly: boolean
  reason: string
}

function parseTimeRangeFromQuery(query: string, nowMs: number): TimeRangeParseResult | null {
  const text = query.trim()
  if (!text) return null

  const quoteOnly = /(准确|原话|复述|逐字|一字不差|完整复述)/.test(text)
  const now = new Date(nowMs)

  const clampRange = (startMs: number, endMs: number) => {
    const s = Math.min(startMs, endMs)
    const e = Math.max(startMs, endMs)
    return { startMs: s, endMs: e }
  }

  const toLocalMs = (y: number, mo: number, d: number, h: number, mi: number, s: number) => {
    const dt = new Date(y, mo - 1, d, h, mi, s, 0)
    const ms = dt.getTime()
    return Number.isFinite(ms) ? ms : NaN
  }

  const periodToHours = (period: string): { startH: number; endH: number } | null => {
    if (period.includes('凌晨')) return { startH: 0, endH: 6 }
    if (period.includes('早上') || period.includes('上午')) return { startH: 6, endH: 12 }
    if (period.includes('中午')) return { startH: 11, endH: 13 }
    if (period.includes('下午')) return { startH: 13, endH: 18 }
    if (period.includes('晚上') || period.includes('夜里') || period.includes('夜间')) return { startH: 18, endH: 24 }
    return null
  }

  // yyyy/m/d hh:mm(:ss)
  const full = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/)
  if (full) {
    const y = Number(full[1])
    const mo = Number(full[2])
    const d = Number(full[3])
    const h = Number(full[4])
    const mi = Number(full[5])
    const sec = full[6] ? Number(full[6]) : NaN
    const base = toLocalMs(y, mo, d, h, mi, Number.isFinite(sec) ? sec : 0)
    if (Number.isFinite(base)) {
      const win = Number.isFinite(sec) ? 30_000 : 5 * 60_000
      const { startMs, endMs } = clampRange(base - win, base + win)
      return { startMs, endMs, quoteOnly, reason: 'full_datetime' }
    }
  }

  // yyyy/m/d
  const dateOnly = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const mo = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    const period = periodToHours(text) ?? { startH: 0, endH: 24 }
    const start = toLocalMs(y, mo, d, period.startH, 0, 0)
    const end = toLocalMs(y, mo, d, period.endH === 24 ? 23 : period.endH, period.endH === 24 ? 59 : 0, period.endH === 24 ? 59 : 0)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const { startMs, endMs } = clampRange(start, end)
      return { startMs, endMs, quoteOnly, reason: 'date_only' }
    }
  }

  // 昨天/今天/前天 + 时段
  const rel = text.match(/(前天|昨天|今天)/)
  if (rel) {
    const offsetDays = rel[1] === '前天' ? -2 : rel[1] === '昨天' ? -1 : 0
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 0, 0, 0, 0)
    const y = baseDate.getFullYear()
    const mo = baseDate.getMonth() + 1
    const d = baseDate.getDate()
    const period = periodToHours(text) ?? { startH: 0, endH: 24 }
    const start = toLocalMs(y, mo, d, period.startH, 0, 0)
    const end = toLocalMs(y, mo, d, period.endH === 24 ? 23 : period.endH, period.endH === 24 ? 59 : 0, period.endH === 24 ? 59 : 0)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const { startMs, endMs } = clampRange(start, end)
      return { startMs, endMs, quoteOnly, reason: 'relative_day' }
    }
  }

  // 1月1日 + 时段（年缺省：尽量取“最近的过去”）
  const md = text.match(/(\d{1,2})月(\d{1,2})日/)
  if (md) {
    const mo = Number(md[1])
    const d = Number(md[2])
    let y = now.getFullYear()
    const period = periodToHours(text) ?? { startH: 0, endH: 24 }
    const candidateStart = toLocalMs(y, mo, d, period.startH, 0, 0)
    // 如果构造出的日期明显在未来，则回退到去年
    if (Number.isFinite(candidateStart) && candidateStart > nowMs + 24 * 60 * 60_000) {
      y -= 1
    }
    const start = toLocalMs(y, mo, d, period.startH, 0, 0)
    const end = toLocalMs(y, mo, d, period.endH === 24 ? 23 : period.endH, period.endH === 24 ? 59 : 0, period.endH === 24 ? 59 : 0)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const { startMs, endMs } = clampRange(start, end)
      return { startMs, endMs, quoteOnly, reason: 'month_day' }
    }
  }

  return null
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export class MemoryService {
  private db: DatabaseHandle
  private pendingTagRowids = new Set<number>()
  private pendingEmbeddingRowids = new Set<number>()
  private pendingKgRowids = new Set<number>()

  constructor(userDataDir: string) {
    const require = createRequire(import.meta.url)
    const mod = require('better-sqlite3') as unknown as { default?: unknown }
    const Database = (mod.default ?? mod) as unknown as { new (file: string): DatabaseHandle }
    const dbPath = path.join(userDataDir, 'neodeskpet-memory.sqlite3')
    this.db = new Database(dbPath)

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')

    this.initSchema()
    this.ensurePersonaColumns()
    this.ensureMemoryColumns()
    this.ensureDefaultPersona()
  }

  close(): void {
    this.db.close()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        persona_id TEXT,
        scope TEXT NOT NULL DEFAULT 'persona',
        kind TEXT NOT NULL,
        role TEXT,
        session_id TEXT,
        message_id TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 0.2,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        retention REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        memory_type TEXT NOT NULL DEFAULT 'other',
        source TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memory_persona_created ON memory(persona_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_session_message ON memory(session_id, message_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        tokenize = 'unicode61 remove_diacritics 2',
        content = 'memory',
        content_rowid = 'rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;

      DROP TRIGGER IF EXISTS memory_au;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF content ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS memory_version (
        id TEXT PRIMARY KEY,
        memory_rowid INTEGER NOT NULL,
        old_content TEXT NOT NULL,
        new_content TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_version_rowid_created ON memory_version(memory_rowid, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_conflict (
        id TEXT PRIMARY KEY,
        memory_rowid INTEGER NOT NULL,
        conflict_type TEXT NOT NULL,
        candidate_content TEXT NOT NULL,
        candidate_source TEXT,
        candidate_importance REAL,
        candidate_strength REAL,
        candidate_memory_type TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_conflict_status_created ON memory_conflict(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_conflict_rowid_created ON memory_conflict(memory_rowid, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_conflict_open_unique
        ON memory_conflict(memory_rowid, conflict_type, candidate_content, status);

      CREATE INDEX IF NOT EXISTS idx_memory_kind_persona_updated ON memory(kind, persona_id, updated_at DESC);

      -- M5: Tag 网络（轻量，本地）
      CREATE TABLE IF NOT EXISTS tag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_tag (
        memory_rowid INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(memory_rowid, tag_id),
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tag(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_tag_tag_rowid ON memory_tag(tag_id, memory_rowid);
      CREATE INDEX IF NOT EXISTS idx_memory_tag_rowid ON memory_tag(memory_rowid);

      -- M5: 向量召回（本地存储 embedding，查询时做相似度）
      CREATE TABLE IF NOT EXISTS memory_embedding (
        memory_rowid INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embedding_model ON memory_embedding(model);
      CREATE INDEX IF NOT EXISTS idx_memory_embedding_updated ON memory_embedding(updated_at DESC);

      -- M6: KG（实体/事件/关系）内置图谱层
      CREATE TABLE IF NOT EXISTS kg_entity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'entity',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entity_unique ON kg_entity(persona_id, key, entity_type);
      CREATE INDEX IF NOT EXISTS idx_kg_entity_persona_updated ON kg_entity(persona_id, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS kg_entity_fts USING fts5(
        name,
        aliases,
        tokenize = 'unicode61 remove_diacritics 2',
        content = 'kg_entity',
        content_rowid = 'id'
      );

      CREATE TRIGGER IF NOT EXISTS kg_entity_ai AFTER INSERT ON kg_entity BEGIN
        INSERT INTO kg_entity_fts(rowid, name, aliases) VALUES (new.id, new.name, new.aliases_json);
      END;

      CREATE TRIGGER IF NOT EXISTS kg_entity_ad AFTER DELETE ON kg_entity BEGIN
        INSERT INTO kg_entity_fts(kg_entity_fts, rowid, name, aliases) VALUES('delete', old.id, old.name, old.aliases_json);
      END;

      DROP TRIGGER IF EXISTS kg_entity_au;
      CREATE TRIGGER IF NOT EXISTS kg_entity_au AFTER UPDATE OF name, aliases_json ON kg_entity BEGIN
        INSERT INTO kg_entity_fts(kg_entity_fts, rowid, name, aliases) VALUES('delete', old.id, old.name, old.aliases_json);
        INSERT INTO kg_entity_fts(rowid, name, aliases) VALUES (new.id, new.name, new.aliases_json);
      END;

      CREATE TABLE IF NOT EXISTS kg_entity_mention (
        entity_id INTEGER NOT NULL,
        memory_rowid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(entity_id, memory_rowid),
        FOREIGN KEY(entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kg_entity_mention_rowid ON kg_entity_mention(memory_rowid);
      CREATE INDEX IF NOT EXISTS idx_kg_entity_mention_entity ON kg_entity_mention(entity_id);

      CREATE TABLE IF NOT EXISTS kg_relation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT,
        subject_entity_id INTEGER NOT NULL,
        predicate TEXT NOT NULL,
        object_entity_id INTEGER,
        object_literal TEXT,
        confidence REAL NOT NULL DEFAULT 0.6,
        memory_rowid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(subject_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
        FOREIGN KEY(object_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kg_relation_persona_subject ON kg_relation(persona_id, subject_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kg_relation_persona_object ON kg_relation(persona_id, object_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kg_relation_rowid ON kg_relation(memory_rowid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_relation_unique ON kg_relation(
        persona_id,
        subject_entity_id,
        predicate,
        COALESCE(object_entity_id, 0),
        COALESCE(object_literal, ''),
        memory_rowid
      );

      CREATE TABLE IF NOT EXISTS kg_memory_index (
        memory_rowid INTEGER PRIMARY KEY,
        persona_id TEXT,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        extracted_at INTEGER NOT NULL,
        FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kg_memory_index_persona_updated ON kg_memory_index(persona_id, updated_at DESC);
    `)
  }

  private ensurePersonaColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info('persona')`).all() as Array<{ name: string }>).map((r) => r.name),
    )

    const add = (name: string, ddl: string) => {
      if (cols.has(name)) return
      this.db.exec(ddl)
      cols.add(name)
    }

    add('capture_enabled', `ALTER TABLE persona ADD COLUMN capture_enabled INTEGER NOT NULL DEFAULT 1;`)
    add('capture_user', `ALTER TABLE persona ADD COLUMN capture_user INTEGER NOT NULL DEFAULT 1;`)
    add('capture_assistant', `ALTER TABLE persona ADD COLUMN capture_assistant INTEGER NOT NULL DEFAULT 1;`)
    add('retrieve_enabled', `ALTER TABLE persona ADD COLUMN retrieve_enabled INTEGER NOT NULL DEFAULT 1;`)
  }

  private ensureMemoryColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info('memory')`).all() as Array<{ name: string }>).map((r) => r.name),
    )

    const add = (name: string, ddl: string) => {
      if (cols.has(name)) return
      this.db.exec(ddl)
      cols.add(name)
    }

    add('updated_at', `ALTER TABLE memory ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`)
    add('importance', `ALTER TABLE memory ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;`)
    add('strength', `ALTER TABLE memory ADD COLUMN strength REAL NOT NULL DEFAULT 0.2;`)
    add('access_count', `ALTER TABLE memory ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;`)
    add('last_accessed_at', `ALTER TABLE memory ADD COLUMN last_accessed_at INTEGER;`)
    add('retention', `ALTER TABLE memory ADD COLUMN retention REAL NOT NULL DEFAULT 1;`)
    add('status', `ALTER TABLE memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`)
    add('memory_type', `ALTER TABLE memory ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'other';`)
    add('source', `ALTER TABLE memory ADD COLUMN source TEXT;`)
    add('pinned', `ALTER TABLE memory ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`)

    if (cols.has('updated_at')) {
      this.db.exec(`UPDATE memory SET updated_at = created_at WHERE updated_at = 0;`)
    }

    if (cols.has('status') && cols.has('pinned')) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_persona_status_pinned_created
          ON memory(persona_id, status, pinned, created_at DESC);
      `)
    }
  }

  private ensureDefaultPersona(): void {
    const existing = this.db.prepare('SELECT id FROM persona WHERE id = ?').get('default') as { id?: string } | undefined
    if (existing?.id) return
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO persona (id, name, prompt, capture_enabled, capture_user, capture_assistant, retrieve_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('default', '默认角色', '', 1, 1, 1, 1, ts, ts)
  }

  private takePending(set: Set<number>, limit: number): number[] {
    const out: number[] = []
    for (const v of set) {
      out.push(v)
      set.delete(v)
      if (out.length >= limit) break
    }
    return out
  }

  private enqueueTagIndex(rowid: number): void {
    const id = clampInt(rowid, 0, 1, 2_000_000_000)
    if (id <= 0) return
    this.pendingTagRowids.add(id)
  }

  private enqueueEmbeddingIndex(rowid: number): void {
    const id = clampInt(rowid, 0, 1, 2_000_000_000)
    if (id <= 0) return
    this.pendingEmbeddingRowids.add(id)
  }

  private enqueueKgIndex(rowid: number): void {
    const id = clampInt(rowid, 0, 1, 2_000_000_000)
    if (id <= 0) return
    this.pendingKgRowids.add(id)
  }

  private getMemoryByRowid(rowid: number): MemoryRecord | null {
    const r = this.db
      .prepare(
        `
        SELECT
          rowid as rowid,
          persona_id as personaId,
          CASE WHEN persona_id IS NULL THEN 'shared' ELSE 'persona' END as scope,
          kind as kind,
          role as role,
          content as content,
          created_at as createdAt,
          updated_at as updatedAt,
          importance as importance,
          strength as strength,
          access_count as accessCount,
          last_accessed_at as lastAccessedAt,
          retention as retention,
          status as status,
          memory_type as memoryType,
          source as source,
          pinned as pinned
        FROM memory
        WHERE rowid = ?
        `,
      )
      .get(rowid) as MemoryRecord | undefined

    if (!r) return null
    r.retention = this.computeRetentionScore(now(), r.createdAt, r.lastAccessedAt, r.strength)
    return r
  }

  private addMemoryVersion(args: {
    memoryRowid: number
    oldContent: string
    newContent: string
    reason: string
    source: string | null
    createdAt: number
  }): void {
    const reason = args.reason.trim() || 'manual_edit'
    this.db
      .prepare(
        'INSERT INTO memory_version (id, memory_rowid, old_content, new_content, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), args.memoryRowid, args.oldContent, args.newContent, reason, args.source, args.createdAt)
  }

  private createConflictIfNeeded(args: {
    memoryRowid: number
    conflictType: 'update' | 'merge' | 'conflict'
    candidateContent: string
    candidateSource: string | null
    candidateImportance: number | null
    candidateStrength: number | null
    candidateMemoryType: string | null
  }): string {
    const candidate = args.candidateContent.trim()
    if (!candidate) throw new Error('候选内容为空')

    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM memory_conflict
        WHERE memory_rowid = ?
          AND conflict_type = ?
          AND candidate_content = ?
          AND status = 'open'
        LIMIT 1
        `,
      )
      .get(args.memoryRowid, args.conflictType, candidate) as { id?: string } | undefined

    if (existing?.id) return existing.id

    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        `
        INSERT INTO memory_conflict (
          id,
          memory_rowid,
          conflict_type,
          candidate_content,
          candidate_source,
          candidate_importance,
          candidate_strength,
          candidate_memory_type,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
        `,
      )
      .run(
        id,
        args.memoryRowid,
        args.conflictType,
        candidate,
        args.candidateSource,
        args.candidateImportance,
        args.candidateStrength,
        args.candidateMemoryType,
        ts,
      )

    return id
  }

  listPersonas(): PersonaSummary[] {
    const rows = this.db
      .prepare('SELECT id, name, updated_at as updatedAt FROM persona ORDER BY updated_at DESC')
      .all() as PersonaSummary[]
    return rows
  }

  getPersona(personaId: string): Persona | null {
    const row = this.db
      .prepare(
        `
        SELECT
          id,
          name,
          prompt,
          capture_enabled as captureEnabled,
          capture_user as captureUser,
          capture_assistant as captureAssistant,
          retrieve_enabled as retrieveEnabled,
          created_at as createdAt,
          updated_at as updatedAt
        FROM persona
        WHERE id = ?
        `,
      )
      .get(personaId) as Persona | undefined
    return row ?? null
  }

  createPersona(name: string): Persona {
    const cleaned = name.trim() || '未命名角色'
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO persona (id, name, prompt, capture_enabled, capture_user, capture_assistant, retrieve_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, cleaned, '', 1, 1, 1, 1, ts, ts)
    const persona = this.getPersona(id)
    if (!persona) throw new Error('创建角色失败')
    return persona
  }

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
  ): Persona {
    const current = this.getPersona(personaId)
    if (!current) throw new Error('角色不存在')
    const nextName = typeof patch.name === 'string' ? patch.name.trim() || current.name : current.name
    const nextPrompt = typeof patch.prompt === 'string' ? patch.prompt : current.prompt
    const nextCaptureEnabled = typeof patch.captureEnabled === 'boolean' ? patch.captureEnabled : current.captureEnabled
    const nextCaptureUser = typeof patch.captureUser === 'boolean' ? patch.captureUser : current.captureUser
    const nextCaptureAssistant =
      typeof patch.captureAssistant === 'boolean' ? patch.captureAssistant : current.captureAssistant
    const nextRetrieveEnabled = typeof patch.retrieveEnabled === 'boolean' ? patch.retrieveEnabled : current.retrieveEnabled
    const ts = now()
    this.db
      .prepare(
        'UPDATE persona SET name = ?, prompt = ?, capture_enabled = ?, capture_user = ?, capture_assistant = ?, retrieve_enabled = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        nextName,
        nextPrompt,
        nextCaptureEnabled ? 1 : 0,
        nextCaptureUser ? 1 : 0,
        nextCaptureAssistant ? 1 : 0,
        nextRetrieveEnabled ? 1 : 0,
        ts,
        personaId,
      )
    const updated = this.getPersona(personaId)
    if (!updated) throw new Error('更新角色失败')
    return updated
  }

  deletePersona(personaId: string): void {
    if (personaId === 'default') throw new Error('默认角色不可删除')
    this.db.prepare('DELETE FROM persona WHERE id = ?').run(personaId)
  }

  ingestChatMessage(args: MemoryIngestChatMessageArgs): void {
    const persona = this.getPersona(args.personaId.trim() || 'default')
    if (persona) {
      if (!persona.captureEnabled) return
      if (args.role === 'user' && !persona.captureUser) return
      if (args.role === 'assistant' && !persona.captureAssistant) return
    }

    const content = args.content.trim()
    if (!content) return

    const pid = args.personaId.trim() || 'default'
    const createdAt = args.createdAt || now()
    const updatedAt = now()
    const source = args.role === 'assistant' ? 'assistant_msg' : 'user_msg'
    const importance = args.role === 'user' ? 0.25 : 0.15
    const strength = 0.15
    this.db
      .prepare(
        `
        INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, message_id) DO UPDATE SET
          persona_id = excluded.persona_id,
          scope = excluded.scope,
          kind = excluded.kind,
          role = excluded.role,
          content = excluded.content,
          created_at = MIN(created_at, excluded.created_at),
          updated_at = excluded.updated_at,
          source = excluded.source
        `,
      )
      .run(
        randomUUID(),
        pid,
        'persona',
        'chat_message',
        args.role,
        args.sessionId,
        args.messageId,
        content,
        createdAt,
        updatedAt,
        importance,
        strength,
        'episodic',
        source,
      )

    // 后台索引：避免阻塞聊天主流程
    try {
      const inserted = this.db
        .prepare('SELECT rowid as rowid FROM memory WHERE session_id = ? AND message_id = ? LIMIT 1')
        .get(args.sessionId, args.messageId) as { rowid?: number } | undefined
      const rowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
      if (rowid > 0) {
        this.enqueueTagIndex(rowid)
        this.enqueueEmbeddingIndex(rowid)
        this.enqueueKgIndex(rowid)
      }
    } catch {
      /* ignore */
    }
  }

  runTagMaintenance(settings: MemorySettings, opts?: { batchSize?: number }): { scanned: number; updated: number } {
    const tagEnabled = settings.tagEnabled ?? true
    if (!tagEnabled) return { scanned: 0, updated: 0 }

    const batchSize = clampInt(opts?.batchSize, 80, 10, 500)
    const picked = this.takePending(this.pendingTagRowids, batchSize)

    type Row = { rowid: number; content: string }
    const rows: Row[] = []

    if (picked.length > 0) {
      const placeholders = picked.map(() => '?').join(',')
      const found = this.db
        .prepare(
          `
          SELECT rowid as rowid, content as content
          FROM memory
          WHERE rowid IN (${placeholders})
            AND COALESCE(status, 'active') <> 'deleted'
            AND LENGTH(TRIM(content)) >= 2
          `,
        )
        .all(...picked) as Row[]
      rows.push(...found)
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const more = this.db
        .prepare(
          `
          SELECT m.rowid as rowid, m.content as content
          FROM memory m
          LEFT JOIN memory_tag mt ON mt.memory_rowid = m.rowid
          WHERE mt.memory_rowid IS NULL
            AND COALESCE(m.status, 'active') <> 'deleted'
            AND LENGTH(TRIM(m.content)) >= 2
          ORDER BY m.updated_at DESC, m.rowid DESC
          LIMIT ?
          `,
        )
        .all(remaining) as Row[]
      rows.push(...more)
    }

    if (rows.length === 0) return { scanned: 0, updated: 0 }

    const ts = now()
    const insertTag = this.db.prepare('INSERT INTO tag(name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
    const getTag = this.db.prepare('SELECT id as id FROM tag WHERE name = ? LIMIT 1')
    const clear = this.db.prepare('DELETE FROM memory_tag WHERE memory_rowid = ?')
    const insertRel = this.db.prepare(
      'INSERT OR IGNORE INTO memory_tag(memory_rowid, tag_id, created_at) VALUES (?, ?, ?)',
    )

    const tx = this.db.transaction((items: Row[]) => {
      for (const r of items) {
        const tags = extractTagsFromText(r.content, { maxTags: 24 })
        const finalTags = tags.length ? tags : ['__no_tag__']
        clear.run(r.rowid)
        for (const name of finalTags) {
          insertTag.run(name, ts)
          const idRow = getTag.get(name) as { id?: number } | undefined
          const tagId = clampInt(idRow?.id, 0, 1, 2_000_000_000)
          if (tagId > 0) insertRel.run(r.rowid, tagId, ts)
        }
      }
    })

    tx(rows)
    return { scanned: rows.length, updated: rows.length }
  }

  async runVectorEmbeddingMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; embedded: number; skipped: number; error?: string }> {
    const enabled = memSettings.vectorEnabled ?? false
    if (!enabled) return { scanned: 0, embedded: 0, skipped: 0 }

    const model = (memSettings.vectorEmbeddingModel ?? '').trim()
    if (!model) return { scanned: 0, embedded: 0, skipped: 0, error: 'embeddings 模型为空' }

    const useCustom = memSettings.vectorUseCustomAi ?? false
    const apiKey = (useCustom ? memSettings.vectorAiApiKey : aiSettings.apiKey) ?? ''
    const baseUrl = (useCustom ? memSettings.vectorAiBaseUrl : aiSettings.baseUrl) ?? ''
    if (!apiKey.trim() || !baseUrl.trim()) {
      const err = 'embeddings API 未配置（缺少 apiKey/baseUrl）'
      return { scanned: 0, embedded: 0, skipped: 0, error: err }
    }

    const batchSize = clampInt(opts?.batchSize, 8, 1, 64)
    const pending = this.takePending(this.pendingEmbeddingRowids, batchSize)

    type Candidate = {
      rowid: number
      content: string
      updatedAt: number
      existModel: string | null
      existHash: string | null
      existUpdatedAt: number | null
    }

    const rows: Candidate[] = []
    if (pending.length > 0) {
      const placeholders = pending.map(() => '?').join(',')
      const found = this.db
        .prepare(
          `
          SELECT
            m.rowid as rowid,
            m.content as content,
            m.updated_at as updatedAt,
            e.model as existModel,
            e.content_hash as existHash,
            e.updated_at as existUpdatedAt
          FROM memory m
          LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid
          WHERE m.rowid IN (${placeholders})
            AND COALESCE(m.status, 'active') <> 'deleted'
            AND LENGTH(TRIM(m.content)) >= 2
          `,
        )
        .all(...pending) as Candidate[]
      rows.push(...found)
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const more = this.db
        .prepare(
          `
          SELECT
            m.rowid as rowid,
            m.content as content,
            m.updated_at as updatedAt,
            e.model as existModel,
            e.content_hash as existHash,
            e.updated_at as existUpdatedAt
          FROM memory m
          LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid
          WHERE COALESCE(m.status, 'active') <> 'deleted'
            AND LENGTH(TRIM(m.content)) >= 2
            AND (e.memory_rowid IS NULL OR e.model <> ? OR e.updated_at < m.updated_at)
          ORDER BY m.updated_at DESC, m.rowid DESC
          LIMIT ?
          `,
        )
        .all(model, remaining) as Candidate[]
      rows.push(...more)
    }

    if (rows.length === 0) return { scanned: 0, embedded: 0, skipped: 0 }

    const toEmbed: Array<{ rowid: number; text: string; hash: string }> = []
    const toTouch: number[] = []

    for (const r of rows) {
      const clipped = normalizeMemoryText(r.content).slice(0, 2000)
      const h = hashEmbeddingInput(model, clipped)
      if (r.existModel === model && r.existHash === h && (r.existUpdatedAt ?? 0) >= (r.updatedAt ?? 0)) {
        toTouch.push(r.rowid)
        continue
      }
      toEmbed.push({ rowid: r.rowid, text: clipped, hash: h })
    }

    if (toTouch.length > 0) {
      const placeholders = toTouch.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE memory_embedding SET updated_at = ? WHERE memory_rowid IN (${placeholders})`)
        .run(now(), ...toTouch)
    }

    if (toEmbed.length === 0) return { scanned: rows.length, embedded: 0, skipped: toTouch.length }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`
    const input = toEmbed.map((x) => x.text)

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input }),
      })

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({} as unknown))
        const msg =
          (errData as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}: ${resp.statusText}`
        return { scanned: rows.length, embedded: 0, skipped: toTouch.length, error: msg }
      }

      const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
      const embeddings = Array.isArray(data.data) ? data.data.map((d) => d.embedding ?? []) : []

      if (embeddings.length !== toEmbed.length) {
        const msg = `embeddings 返回数量不匹配：expect=${toEmbed.length} got=${embeddings.length}`
        return { scanned: rows.length, embedded: 0, skipped: toTouch.length, error: msg }
      }

      const ts = now()
      const upsert = this.db.prepare(
        `
        INSERT INTO memory_embedding (memory_rowid, model, dims, content_hash, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_rowid) DO UPDATE SET
          model = excluded.model,
          dims = excluded.dims,
          content_hash = excluded.content_hash,
          embedding = excluded.embedding,
          updated_at = excluded.updated_at
        `,
      )

      const tx = this.db.transaction(() => {
        for (let i = 0; i < toEmbed.length; i++) {
          const item = toEmbed[i]
          const vec = embeddings[i]
          if (!Array.isArray(vec) || vec.length < 8) continue

          const out = new Float32Array(vec.length)
          let norm = 0
          for (let j = 0; j < vec.length; j++) {
            const v = Number(vec[j])
            out[j] = Number.isFinite(v) ? v : 0
            norm += out[j] * out[j]
          }
          norm = Math.sqrt(norm) || 1
          for (let j = 0; j < out.length; j++) out[j] = out[j] / norm

          const buf = Buffer.from(out.buffer)
          upsert.run(item.rowid, model, out.length, item.hash, buf, ts, ts)
        }
      })

      tx()
      return { scanned: rows.length, embedded: toEmbed.length, skipped: toTouch.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { scanned: rows.length, embedded: 0, skipped: toTouch.length, error: msg }
    }
  }

  async runKgMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; extracted: number; skipped: number; error?: string }> {
    const enabled = memSettings.kgEnabled ?? false
    if (!enabled) return { scanned: 0, extracted: 0, skipped: 0 }

    const useCustom = memSettings.kgUseCustomAi ?? true
    const apiKey = (useCustom ? memSettings.kgAiApiKey : aiSettings.apiKey) ?? ''
    const baseUrl = (useCustom ? memSettings.kgAiBaseUrl : aiSettings.baseUrl) ?? ''
    const model = (memSettings.kgAiModel ?? '').trim() || (aiSettings.model ?? '').trim()
    const temperature = clampFloat(memSettings.kgAiTemperature, 0.2, 0, 2)
    const maxTokens = clampInt(memSettings.kgAiMaxTokens, 1200, 200, 8000)

    if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) {
      return { scanned: 0, extracted: 0, skipped: 0, error: 'KG 抽取 API 未配置（缺少 apiKey/baseUrl/model）' }
    }

    const batchSize = clampInt(opts?.batchSize, 2, 1, 10)
    const picked = this.takePending(this.pendingKgRowids, batchSize)

    type Row = {
      rowid: number
      personaId: string | null
      kind: string
      content: string
      updatedAt: number
      role: string | null
      createdAt: number
      prevHash: string | null
      prevUpdatedAt: number | null
    }

    const rows: Row[] = []
    if (picked.length > 0) {
      const placeholders = picked.map(() => '?').join(',')
      const found = this.db
        .prepare(
          `
          SELECT
            m.rowid as rowid,
            m.persona_id as personaId,
            m.kind as kind,
            m.content as content,
            m.updated_at as updatedAt,
            m.role as role,
            m.created_at as createdAt,
            ki.content_hash as prevHash,
            ki.updated_at as prevUpdatedAt
          FROM memory m
          LEFT JOIN kg_memory_index ki ON ki.memory_rowid = m.rowid
          WHERE m.rowid IN (${placeholders})
            AND COALESCE(m.status, 'active') <> 'deleted'
            AND LENGTH(TRIM(m.content)) >= 2
          `,
        )
        .all(...picked) as Row[]
      rows.push(...found)
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const includeChat = memSettings.kgIncludeChatMessages ?? false
      const kinds = includeChat ? "('manual_note','chat_message')" : "('manual_note')"

      const more = this.db
        .prepare(
          `
          SELECT
            m.rowid as rowid,
            m.persona_id as personaId,
            m.kind as kind,
            m.content as content,
            m.updated_at as updatedAt,
            m.role as role,
            m.created_at as createdAt,
            ki.content_hash as prevHash,
            ki.updated_at as prevUpdatedAt
          FROM memory m
          LEFT JOIN kg_memory_index ki ON ki.memory_rowid = m.rowid
          WHERE COALESCE(m.status, 'active') <> 'deleted'
            AND m.kind IN ${kinds}
            AND LENGTH(TRIM(m.content)) >= 2
            AND (ki.memory_rowid IS NULL OR ki.updated_at < m.updated_at)
          ORDER BY m.updated_at DESC, m.rowid DESC
          LIMIT ?
          `,
        )
        .all(remaining) as Row[]
      rows.push(...more)
    }

    if (rows.length === 0) return { scanned: 0, extracted: 0, skipped: 0 }

    const toExtract: Array<Row & { h: string }> = []
    for (const r of rows) {
      const pid = r.personaId ?? 'default'
      const clipped = normalizeMemoryText(r.content).slice(0, 2500)
      const h = createHash('sha1').update(`${pid}\n${r.kind}\n${clipped}`).digest('hex')
      if (r.prevHash === h && (r.prevUpdatedAt ?? 0) >= (r.updatedAt ?? 0)) continue
      toExtract.push({ ...r, h })
    }

    if (toExtract.length === 0) return { scanned: rows.length, extracted: 0, skipped: rows.length }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    const systemPrompt = `你是“记忆图谱抽取器”。

目标：从一段对话/记忆原文中抽取【实体/关系】并给出证据。
要求：
1) 只输出严格 JSON 对象，不要输出任何解释、代码块、Markdown。
2) 用中文字段值；实体名尽量短且可复用。
3) 关系 predicate 用简短动词/短语（如“喜欢”“属于”“位于”“工作于”“需要”“计划”）。

输出 JSON 结构：
{
  "entities": [
    { "name": "", "type": "entity|person|place|food|work|task|preference|other", "aliases": [""] }
  ],
  "relations": [
    { "subject": "", "predicate": "", "object": { "type": "entity|literal", "value": "" }, "confidence": 0.0, "evidence": "" }
  ]
}

注意：
- evidence 必须来自原文的直接片段（可截短），用于追溯。
- 关系不要过多，最多 12 条。实体最多 20 个。`

    const extractedAt = now()
    let extracted = 0

    for (const r of toExtract) {
      const personaId = (r.personaId ?? 'default').trim() || 'default'
      const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : 'note'
      const content = normalizeMemoryText(r.content).slice(0, 2500)
      const userPrompt = `persona=${personaId}\nkind=${r.kind}\nrole=${role}\ncreatedAt=${formatTs(r.createdAt)}\n\n原文：\n${content}`

      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        })

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({} as unknown))
          const msg =
            (errData as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}: ${resp.statusText}`
          this.upsertKgIndexRow({
            memoryRowid: r.rowid,
            personaId,
            contentHash: r.h,
            updatedAt: r.updatedAt,
            extractedAt,
            status: 'error',
            error: msg,
          })
          continue
        }

        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const text = data.choices?.[0]?.message?.content ?? ''
        const obj = extractJsonObject(text)
        if (!obj) {
          this.upsertKgIndexRow({
            memoryRowid: r.rowid,
            personaId,
            contentHash: r.h,
            updatedAt: r.updatedAt,
            extractedAt,
            status: 'error',
            error: 'KG 输出不是有效 JSON 对象',
          })
          continue
        }

        const entitiesRaw = Array.isArray(obj.entities) ? (obj.entities as unknown[]) : []
        const relationsRaw = Array.isArray(obj.relations) ? (obj.relations as unknown[]) : []

        const entities = entitiesRaw
          .map((it) => it as { name?: unknown; type?: unknown; aliases?: unknown })
          .map((it) => ({
            name: typeof it.name === 'string' ? it.name.trim() : '',
            type: typeof it.type === 'string' ? it.type.trim() : 'entity',
            aliases: Array.isArray(it.aliases) ? it.aliases.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [],
          }))
          .filter((e) => e.name.length >= 2)
          .slice(0, 20)

        const rels = relationsRaw
          .map((it) => it as {
            subject?: unknown
            predicate?: unknown
            object?: unknown
            confidence?: unknown
            evidence?: unknown
          })
          .map((it) => {
            const subject = typeof it.subject === 'string' ? it.subject.trim() : ''
            const predicate = typeof it.predicate === 'string' ? it.predicate.trim() : ''
            const confidence = clampFloat(it.confidence, 0.6, 0, 1)
            const evidence = typeof it.evidence === 'string' ? it.evidence.trim().slice(0, 160) : ''
            const objVal = it.object as { type?: unknown; value?: unknown } | null
            const oType = objVal && typeof objVal.type === 'string' ? objVal.type.trim() : 'literal'
            const oValue = objVal && typeof objVal.value === 'string' ? objVal.value.trim() : ''
            return { subject, predicate, objectType: oType, objectValue: oValue, confidence, evidence }
          })
          .filter((x) => x.subject && x.predicate && x.objectValue)
          .slice(0, 12)

        this.applyKgExtraction({
          personaId,
          memoryRowid: r.rowid,
          memoryUpdatedAt: r.updatedAt,
          extractedAt,
          contentHash: r.h,
          entities,
          relations: rels,
        })
        extracted += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.upsertKgIndexRow({
          memoryRowid: r.rowid,
          personaId,
          contentHash: r.h,
          updatedAt: r.updatedAt,
          extractedAt,
          status: 'error',
          error: msg,
        })
      }
    }

    return { scanned: rows.length, extracted, skipped: rows.length - toExtract.length }
  }

  private upsertKgIndexRow(args: {
    memoryRowid: number
    personaId: string
    contentHash: string
    status: 'ok' | 'error'
    error?: string
    updatedAt: number
    extractedAt: number
  }): void {
    const rowid = clampInt(args.memoryRowid, 0, 1, 2_000_000_000)
    if (rowid <= 0) return
    const exists = this.db.prepare('SELECT 1 FROM memory WHERE rowid = ? LIMIT 1').get(rowid) as { 1: number } | undefined
    if (!exists) return
    const pid = args.personaId.trim() || 'default'
    const memUpdatedAt = clampInt(args.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER)
    try {
      this.db
        .prepare(
          `
          INSERT INTO kg_memory_index (memory_rowid, persona_id, content_hash, status, last_error, updated_at, extracted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(memory_rowid) DO UPDATE SET
            persona_id = excluded.persona_id,
            content_hash = excluded.content_hash,
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at,
            extracted_at = excluded.extracted_at
          `,
        )
        .run(rowid, pid, args.contentHash, args.status, args.error ?? null, memUpdatedAt, args.extractedAt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('FOREIGN KEY constraint failed')) return
      throw err
    }
  }

  private applyKgExtraction(args: {
    personaId: string
    memoryRowid: number
    memoryUpdatedAt: number
    extractedAt: number
    contentHash: string
    entities: Array<{ name: string; type: string; aliases: string[] }>
    relations: Array<{
      subject: string
      predicate: string
      objectType: string
      objectValue: string
      confidence: number
      evidence: string
    }>
  }): void {
    const personaId = args.personaId.trim() || 'default'
    const rowid = clampInt(args.memoryRowid, 0, 1, 2_000_000_000)
    if (rowid <= 0) return
    const exists = this.db.prepare('SELECT 1 FROM memory WHERE rowid = ? LIMIT 1').get(rowid) as { 1: number } | undefined
    if (!exists) return

    const ts = args.extractedAt

    const upsertEntity = this.db.prepare(
      `
      INSERT INTO kg_entity (persona_id, name, entity_type, aliases_json, key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(persona_id, key, entity_type) DO UPDATE SET
        name = excluded.name,
        aliases_json = excluded.aliases_json,
        updated_at = excluded.updated_at
      `,
    )
    const getEntity = this.db.prepare(
      'SELECT id as id FROM kg_entity WHERE persona_id = ? AND key = ? AND entity_type = ? LIMIT 1',
    )

    const clearMentions = this.db.prepare('DELETE FROM kg_entity_mention WHERE memory_rowid = ?')
    const insertMention = this.db.prepare(
      'INSERT OR IGNORE INTO kg_entity_mention (entity_id, memory_rowid, created_at) VALUES (?, ?, ?)',
    )

    const clearRels = this.db.prepare('DELETE FROM kg_relation WHERE memory_rowid = ?')
    const insertRel = this.db.prepare(
      `
      INSERT OR IGNORE INTO kg_relation (
        persona_id, subject_entity_id, predicate, object_entity_id, object_literal, confidence, memory_rowid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )

    const tx = this.db.transaction(() => {
      const idByKey = new Map<string, number>()

      for (const e of args.entities) {
        const key = normalizeEntityKey(e.name)
        if (!key) continue
        const entityType = e.type.trim() || 'entity'
        const aliases = Array.from(new Set([...(e.aliases ?? []), e.name].map((x) => x.trim()).filter(Boolean))).slice(0, 12)
        const aliasesJson = JSON.stringify(aliases, null, 0)
        upsertEntity.run(personaId, e.name, entityType, aliasesJson, key, ts, ts)
        const row = getEntity.get(personaId, key, entityType) as { id?: number } | undefined
        const id = clampInt(row?.id, 0, 1, 2_000_000_000)
        if (id > 0) idByKey.set(`${entityType}:${key}`, id)
      }

      clearMentions.run(rowid)
      for (const [k, id] of idByKey) {
        void k
        insertMention.run(id, rowid, ts)
      }

      clearRels.run(rowid)
      for (const rel of args.relations) {
        const skey = normalizeEntityKey(rel.subject)
        if (!skey) continue
        const subjTypeKey = Array.from(idByKey.keys()).find((k) => k.endsWith(`:${skey}`))
        const subjId = subjTypeKey ? idByKey.get(subjTypeKey) : undefined
        if (!subjId) continue

        let objEntityId: number | null = null
        let objLiteral: string | null = null

        if (rel.objectType === 'entity') {
          const okey = normalizeEntityKey(rel.objectValue)
          const objTypeKey = Array.from(idByKey.keys()).find((k) => k.endsWith(`:${okey}`))
          objEntityId = objTypeKey ? (idByKey.get(objTypeKey) ?? null) : null
          if (!objEntityId) objLiteral = rel.objectValue
        } else {
          objLiteral = rel.objectValue
        }

        insertRel.run(personaId, subjId, rel.predicate.slice(0, 40), objEntityId, objLiteral?.slice(0, 120) ?? null, rel.confidence, rowid, ts)
      }

      this.upsertKgIndexRow({
        memoryRowid: rowid,
        personaId,
        contentHash: args.contentHash,
        status: 'ok',
        updatedAt: args.memoryUpdatedAt,
        extractedAt: ts,
      })
    })

    tx()
  }

  private buildMemoryWhere(args: MemoryFilterArgs): { whereSql: string; params: Array<string | number> } {
    const personaId = args.personaId.trim() || 'default'
    const scope = args.scope ?? 'persona'
    const role = args.role ?? 'all'
    const q = (args.query ?? '').trim()
    const status = args.status ?? 'all'
    const pinned = args.pinned ?? 'all'
    const sourceRaw = typeof args.source === 'string' ? args.source.trim() : ''
    const source = args.source === 'all' ? '' : sourceRaw
    const memoryTypeRaw = typeof args.memoryType === 'string' ? args.memoryType.trim() : ''
    const memoryType = args.memoryType === 'all' ? '' : memoryTypeRaw

    const where: string[] = []
    const params: Array<string | number> = []

    if (scope === 'persona') {
      where.push('persona_id = ?')
      params.push(personaId)
    } else if (scope === 'shared') {
      where.push('persona_id IS NULL')
    } else {
      where.push('(persona_id = ? OR persona_id IS NULL)')
      params.push(personaId)
    }

    if (role !== 'all') {
      where.push("COALESCE(role, 'note') = ?")
      params.push(role)
    }

    if (status === 'deleted') {
      where.push("COALESCE(status, 'active') = 'deleted'")
    } else {
      where.push("COALESCE(status, 'active') <> 'deleted'")
      if (status !== 'all') {
        where.push('status = ?')
        params.push(status)
      }
    }

    if (pinned === 'pinned') {
      where.push('COALESCE(pinned, 0) <> 0')
    } else if (pinned === 'unpinned') {
      where.push('COALESCE(pinned, 0) = 0')
    }

    if (source) {
      where.push("COALESCE(source, '') = ?")
      params.push(source.slice(0, 80))
    }

    if (memoryType) {
      where.push('memory_type = ?')
      params.push(memoryType.slice(0, 80))
    }

    if (q) {
      where.push('content LIKE ?')
      params.push(`%${q.slice(0, 200)}%`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return { whereSql, params }
  }

  private buildMemoryOrderBy(orderBy: MemoryOrderBy | undefined, orderDir: 'asc' | 'desc' | undefined): string {
    const dir = orderDir === 'asc' ? 'ASC' : 'DESC'
    const pinnedSql = 'pinned DESC'
    const statusSql = "CASE WHEN status = 'archived' THEN 1 WHEN status = 'deleted' THEN 2 ELSE 0 END ASC"

    const by: MemoryOrderBy =
      orderBy === 'updatedAt' ||
      orderBy === 'retention' ||
      orderBy === 'importance' ||
      orderBy === 'strength' ||
      orderBy === 'accessCount' ||
      orderBy === 'lastAccessedAt' ||
      orderBy === 'createdAt'
        ? orderBy
        : 'createdAt'

    if (by === 'lastAccessedAt') {
      return `${pinnedSql}, ${statusSql}, (last_accessed_at IS NULL) ASC, last_accessed_at ${dir}, rowid DESC`
    }

    const col =
      by === 'updatedAt'
        ? 'updated_at'
        : by === 'retention'
          ? 'retention'
          : by === 'importance'
            ? 'importance'
            : by === 'strength'
              ? 'strength'
              : by === 'accessCount'
                ? 'access_count'
                : 'created_at'

    return `${pinnedSql}, ${statusSql}, ${col} ${dir}, rowid DESC`
  }

  private buildMemoryMetaSet(patch: MemoryMetaPatch): { setSql: string; params: Array<string | number | null> } {
    const sets: string[] = []
    const params: Array<string | number | null> = []

    if (patch.status === 'active' || patch.status === 'archived' || patch.status === 'deleted') {
      sets.push('status = ?')
      params.push(patch.status)
    }

    if (typeof patch.pinned === 'number' && Number.isFinite(patch.pinned)) {
      sets.push('pinned = ?')
      params.push(patch.pinned ? 1 : 0)
    }

    if (typeof patch.importance === 'number' && Number.isFinite(patch.importance)) {
      sets.push('importance = ?')
      params.push(clampFloat(patch.importance, 0.5, 0, 1))
    }

    if (typeof patch.strength === 'number' && Number.isFinite(patch.strength)) {
      sets.push('strength = ?')
      params.push(clampFloat(patch.strength, 0.2, 0, 1))
    }

    if (typeof patch.retention === 'number' && Number.isFinite(patch.retention)) {
      sets.push('retention = ?')
      params.push(clampFloat(patch.retention, 1, 0, 1))
    }

    if (typeof patch.memoryType === 'string' && patch.memoryType.trim()) {
      sets.push('memory_type = ?')
      params.push(patch.memoryType.trim().slice(0, 80))
    }

    if (patch.source === null) {
      sets.push('source = NULL')
    } else if (typeof patch.source === 'string' && patch.source.trim()) {
      sets.push('source = ?')
      params.push(patch.source.trim().slice(0, 80))
    }

    if (sets.length === 0) return { setSql: '', params: [] }

    const ts = now()
    sets.push('updated_at = ?')
    params.push(ts)

    return { setSql: sets.join(', '), params }
  }

  listMemory(args: MemoryListArgs): MemoryListResult {
    const limit = clampInt(args.limit, 50, 1, 200)
    const offset = clampInt(args.offset, 0, 0, 1_000_000)
    const { whereSql, params } = this.buildMemoryWhere(args)
    const orderBySql = this.buildMemoryOrderBy(args.orderBy, args.orderDir)

    const total = (this.db
      .prepare(`SELECT COUNT(1) as c FROM memory ${whereSql}`)
      .get(...params) as { c: number }).c

    const items = this.db
      .prepare(
        `
        SELECT
          rowid as rowid,
          persona_id as personaId,
          CASE WHEN persona_id IS NULL THEN 'shared' ELSE 'persona' END as scope,
          kind as kind,
          role as role,
          content as content,
          created_at as createdAt,
          updated_at as updatedAt,
          importance as importance,
          strength as strength,
          access_count as accessCount,
          last_accessed_at as lastAccessedAt,
          retention as retention,
          status as status,
          memory_type as memoryType,
          source as source,
          pinned as pinned
        FROM memory
        ${whereSql}
        ORDER BY ${orderBySql}
        LIMIT ? OFFSET ?
        `,
      )
      .all(...params, limit, offset) as MemoryRecord[]

    const nowMs = now()
    for (const it of items) {
      it.retention = this.computeRetentionScore(nowMs, it.createdAt, it.lastAccessedAt, it.strength)
    }

    return { total, items }
  }

  upsertManualMemory(args: MemoryUpsertManualArgs): MemoryRecord {
    const personaId = args.personaId.trim() || 'default'
    const content = args.content.trim()
    if (!content) throw new Error('内容不能为空')

    const scope = args.scope
    const pid = scope === 'shared' ? null : personaId
    const ts = now()
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'manual'
    const memoryType = typeof args.memoryType === 'string' && args.memoryType.trim() ? args.memoryType.trim() : 'semantic'
    const importance = clampFloat(args.importance, 0.75, 0, 1)
    const strength = clampFloat(args.strength, 0.6, 0, 1)

    // 去重/冲突检测仅针对“长期记忆条目”（manual_note），不影响原文采集（chat_message）
    // 目标：避免记忆越写越乱，同时不擅自覆盖（冲突/更新进入待处理队列）
    const normalized = normalizeMemoryText(content)
    if (normalized.length >= 3) {
      const wherePersona = pid === null ? 'persona_id IS NULL' : 'persona_id = ?'
      const scan = this.db
        .prepare(
          `
          SELECT rowid as rowid, content as content
          FROM memory
          WHERE kind = 'manual_note'
            AND scope = ?
            AND ${wherePersona}
            AND COALESCE(status, 'active') <> 'deleted'
          ORDER BY updated_at DESC, rowid DESC
          LIMIT ?
          `,
        )
        .all(...(pid === null ? [scope] : [scope, pid]), 240) as Array<{ rowid: number; content: string }>

      let best: { rowid: number; content: string; score: number } | null = null
      for (const r of scan) {
        const score = diceCoefficient(r.content, normalized)
        if (!best || score > best.score) best = { rowid: r.rowid, content: r.content, score }
      }

      if (best) {
        const bestNorm = normalizeMemoryText(best.content)
        const isExact = bestNorm.replace(/\s+/g, '') === normalized.replace(/\s+/g, '')
        if (isExact || best.score >= 0.92) {
          // 高度重复：不新增，仅轻微增强（不记作 hit）
          this.db
            .prepare(
              "UPDATE memory SET updated_at = ?, strength = MIN(1, strength + 0.01), retention = 1, status = 'active' WHERE rowid = ?",
            )
            .run(ts, best.rowid)
          const existing = this.getMemoryByRowid(best.rowid)
          if (!existing) throw new Error('重复检测命中，但记录不存在')
          return existing
        }

        if (best.score >= 0.78) {
          const baseKv = extractKeyValue(best.content)
          const candKv = extractKeyValue(normalized)
          const conflictType: 'update' | 'merge' | 'conflict' =
            baseKv && candKv && baseKv.key === candKv.key && baseKv.value !== candKv.value ? 'update' : 'merge'

          this.createConflictIfNeeded({
            memoryRowid: best.rowid,
            conflictType,
            candidateContent: normalized,
            candidateSource: source,
            candidateImportance: importance,
            candidateStrength: strength,
            candidateMemoryType: memoryType,
          })

          const existing = this.getMemoryByRowid(best.rowid)
          if (!existing) throw new Error('冲突检测命中，但记录不存在')
          return existing
        }
      }
    }

    this.db
      .prepare(
        'INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), pid, scope, 'manual_note', 'note', null, null, content, ts, ts, importance, strength, memoryType, source)

    const inserted = this.db.prepare('SELECT rowid as rowid FROM memory WHERE rowid = last_insert_rowid()').get() as
      | { rowid?: number }
      | undefined
    const rowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
    const row = rowid > 0 ? this.getMemoryByRowid(rowid) : null
    if (!row) throw new Error('写入失败')

    // 后台索引：避免阻塞 UI
    this.enqueueTagIndex(row.rowid)
    this.enqueueEmbeddingIndex(row.rowid)
    this.enqueueKgIndex(row.rowid)
    return row
  }

  updateMemory(args: MemoryUpdateArgs): MemoryRecord {
    const rowid = clampInt(args.rowid, 0, 1, 2_000_000_000)
    const content = args.content.trim()
    if (!content) throw new Error('内容不能为空')

    const current = this.getMemoryByRowid(rowid)
    if (!current) throw new Error('记录不存在')

    const nextNormalized = normalizeMemoryText(content)
    const currentNormalized = normalizeMemoryText(current.content)
    if (nextNormalized.replace(/\s+/g, '') === currentNormalized.replace(/\s+/g, '')) {
      return current
    }

    const ts = now()
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual_edit'
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : null

    this.addMemoryVersion({
      memoryRowid: rowid,
      oldContent: current.content,
      newContent: content,
      reason,
      source,
      createdAt: ts,
    })

    this.db
      .prepare(
        "UPDATE memory SET content = ?, updated_at = ?, strength = MIN(1, strength + 0.05), retention = 1, status = 'active' WHERE rowid = ?",
      )
      .run(content, ts, rowid)
    const updated = this.getMemoryByRowid(rowid)
    if (!updated) throw new Error('记录不存在')

    // 后台索引：内容变更后需要更新 tags / embedding
    this.enqueueTagIndex(updated.rowid)
    this.enqueueEmbeddingIndex(updated.rowid)
    this.enqueueKgIndex(updated.rowid)
    return updated
  }

  updateMemoryMeta(args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult {
    const rowid = clampInt(args.rowid, 0, 1, 2_000_000_000)
    if (rowid <= 0) throw new Error('rowid 不合法')

    const patch = args.patch ?? ({} as MemoryMetaPatch)
    const built = this.buildMemoryMetaSet(patch)
    if (!built.setSql) return { updated: 0 }

    const res = this.db
      .prepare(`UPDATE memory SET ${built.setSql} WHERE rowid = ? AND COALESCE(status, 'active') <> 'deleted'`)
      .run(...built.params, rowid)

    return { updated: res.changes }
  }

  updateManyMemoryMeta(args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult {
    const rowids = Array.from(
      new Set((args.rowids ?? []).map((v) => clampInt(v, 0, 1, 2_000_000_000)).filter((v) => v > 0)),
    )
    if (rowids.length === 0) return { updated: 0 }

    const patch = args.patch ?? ({} as MemoryMetaPatch)
    const built = this.buildMemoryMetaSet(patch)
    if (!built.setSql) return { updated: 0 }

    const placeholders = rowids.map(() => '?').join(',')
    const res = this.db
      .prepare(
        `UPDATE memory SET ${built.setSql} WHERE rowid IN (${placeholders}) AND COALESCE(status, 'active') <> 'deleted'`,
      )
      .run(...built.params, ...rowids)

    return { updated: res.changes }
  }

  updateMemoryByFilterMeta(args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult {
    const patch = args.patch ?? ({} as MemoryMetaPatch)
    const built = this.buildMemoryMetaSet(patch)
    if (!built.setSql) return { updated: 0 }

    const { whereSql, params } = this.buildMemoryWhere(args)
    const res = this.db.prepare(`UPDATE memory SET ${built.setSql} ${whereSql}`).run(...built.params, ...params)
    return { updated: res.changes }
  }

  deleteMemory(args: MemoryDeleteArgs): { ok: true } {
    const rowid = clampInt(args.rowid, 0, 1, 2_000_000_000)
    this.db.prepare('DELETE FROM memory WHERE rowid = ?').run(rowid)
    return { ok: true }
  }

  deleteManyMemory(args: MemoryDeleteManyArgs): { deleted: number } {
    const rowids = Array.from(
      new Set((args.rowids ?? []).map((v) => clampInt(v, 0, 1, 2_000_000_000)).filter((v) => v > 0)),
    )
    if (rowids.length === 0) return { deleted: 0 }

    const placeholders = rowids.map(() => '?').join(',')
    const res = this.db.prepare(`DELETE FROM memory WHERE rowid IN (${placeholders})`).run(...rowids)
    return { deleted: res.changes }
  }

  deleteMemoryByFilter(args: MemoryDeleteByFilterArgs): { deleted: number } {
    const { whereSql, params } = this.buildMemoryWhere(args)
    const res = this.db.prepare(`DELETE FROM memory ${whereSql}`).run(...params)
    return { deleted: res.changes }
  }

  listMemoryVersions(args: MemoryListVersionsArgs): MemoryVersionRecord[] {
    const rowid = clampInt(args.rowid, 0, 1, 2_000_000_000)
    const limit = clampInt(args.limit, 50, 1, 200)
    if (rowid <= 0) return []

    const rows = this.db
      .prepare(
        `
        SELECT
          id as id,
          memory_rowid as memoryRowid,
          old_content as oldContent,
          new_content as newContent,
          reason as reason,
          source as source,
          created_at as createdAt
        FROM memory_version
        WHERE memory_rowid = ?
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(rowid, limit) as MemoryVersionRecord[]

    return rows
  }

  rollbackMemoryVersion(args: MemoryRollbackVersionArgs): MemoryRecord {
    const versionId = args.versionId.trim()
    if (!versionId) throw new Error('versionId 不能为空')

    const v = this.db
      .prepare(
        `
        SELECT
          id as id,
          memory_rowid as memoryRowid,
          old_content as oldContent,
          new_content as newContent,
          reason as reason,
          source as source,
          created_at as createdAt
        FROM memory_version
        WHERE id = ?
        LIMIT 1
        `,
      )
      .get(versionId) as MemoryVersionRecord | undefined

    if (!v) throw new Error('版本不存在')

    return this.updateMemory({
      rowid: v.memoryRowid,
      content: v.oldContent,
      reason: `rollback:${versionId}`,
      source: 'rollback',
    })
  }

  listMemoryConflicts(args: MemoryListConflictsArgs): MemoryListConflictsResult {
    const personaId = args.personaId.trim() || 'default'
    const scope = args.scope ?? 'persona'
    const status = args.status ?? 'open'
    const limit = clampInt(args.limit, 50, 1, 200)
    const offset = clampInt(args.offset, 0, 0, 1_000_000)

    const where: string[] = []
    const params: Array<string | number> = []

    if (scope === 'persona') {
      where.push('m.persona_id = ?')
      params.push(personaId)
    } else if (scope === 'shared') {
      where.push('m.persona_id IS NULL')
    } else {
      where.push('(m.persona_id = ? OR m.persona_id IS NULL)')
      params.push(personaId)
    }

    if (status !== 'all') {
      where.push('c.status = ?')
      params.push(status)
    }

    where.push("COALESCE(m.status, 'active') <> 'deleted'")

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const total = (this.db
      .prepare(
        `
        SELECT COUNT(1) as c
        FROM memory_conflict c
        JOIN memory m ON m.rowid = c.memory_rowid
        ${whereSql}
        `,
      )
      .get(...params) as { c: number }).c

    const items = this.db
      .prepare(
        `
        SELECT
          c.id as id,
          c.memory_rowid as memoryRowid,
          m.persona_id as basePersonaId,
          CASE WHEN m.persona_id IS NULL THEN 'shared' ELSE 'persona' END as baseScope,
          m.content as baseContent,
          m.memory_type as baseMemoryType,
          c.conflict_type as conflictType,
          c.candidate_content as candidateContent,
          c.candidate_source as candidateSource,
          c.candidate_importance as candidateImportance,
          c.candidate_strength as candidateStrength,
          c.candidate_memory_type as candidateMemoryType,
          c.status as status,
          c.created_at as createdAt,
          c.resolved_at as resolvedAt,
          c.resolution as resolution
        FROM memory_conflict c
        JOIN memory m ON m.rowid = c.memory_rowid
        ${whereSql}
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
        `,
      )
      .all(...params, limit, offset) as MemoryListConflictsResult['items']

    return { total, items }
  }

  resolveMemoryConflict(args: MemoryResolveConflictArgs): MemoryResolveConflictResult {
    const id = args.id.trim()
    if (!id) throw new Error('id 不能为空')

    const row = this.db
      .prepare(
        `
        SELECT
          c.id as id,
          c.memory_rowid as memoryRowid,
          c.conflict_type as conflictType,
          c.candidate_content as candidateContent,
          c.candidate_source as candidateSource,
          c.candidate_importance as candidateImportance,
          c.candidate_strength as candidateStrength,
          c.candidate_memory_type as candidateMemoryType,
          c.status as status,
          m.persona_id as basePersonaId,
          m.scope as baseScope,
          m.content as baseContent,
          m.memory_type as baseMemoryType
        FROM memory_conflict c
        JOIN memory m ON m.rowid = c.memory_rowid
        WHERE c.id = ?
        LIMIT 1
        `,
      )
      .get(id) as
      | (Pick<MemoryListConflictsResult['items'][number], 'id' | 'memoryRowid' | 'conflictType' | 'candidateContent'> & {
          candidateSource: string | null
          candidateImportance: number | null
          candidateStrength: number | null
          candidateMemoryType: string | null
          status: string
          basePersonaId: string | null
          baseScope: string
          baseContent: string
          baseMemoryType: string
        })
      | undefined

    if (!row) throw new Error('冲突记录不存在')

    const ts = now()
    const finalize = (
      status: 'resolved' | 'ignored',
      resolution: string,
      extra?: { createdRowid?: number; updatedRowid?: number },
    ): MemoryResolveConflictResult => {
      this.db
        .prepare('UPDATE memory_conflict SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?')
        .run(status, ts, resolution, id)
      return {
        ok: true,
        ...(extra?.createdRowid ? { createdRowid: extra.createdRowid } : {}),
        ...(extra?.updatedRowid ? { updatedRowid: extra.updatedRowid } : {}),
      }
    }

    if (args.action === 'ignore') {
      return finalize('ignored', 'ignore')
    }

    if (args.action === 'accept') {
      const updated = this.updateMemory({
        rowid: row.memoryRowid,
        content: row.candidateContent,
        reason: `conflict_accept:${id}:${row.conflictType}`,
        source: row.candidateSource ?? 'conflict_accept',
      })
      return finalize('resolved', 'accept', { updatedRowid: updated.rowid })
    }

    if (args.action === 'keepBoth') {
      const scope = row.baseScope === 'shared' ? 'shared' : 'persona'
      const personaId = row.basePersonaId ?? 'default'
      const pid = scope === 'shared' ? null : personaId
      const createdAt = ts
      const updatedAt = ts
      const importance = clampFloat(row.candidateImportance ?? undefined, 0.75, 0, 1)
      const strength = clampFloat(row.candidateStrength ?? undefined, 0.6, 0, 1)
      const memoryType = (row.candidateMemoryType ?? row.baseMemoryType ?? 'semantic').trim() || 'semantic'
      const source = row.candidateSource ?? 'conflict_keep_both'

      this.db
        .prepare(
          'INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          pid,
          scope,
          'manual_note',
          'note',
          null,
          null,
          row.candidateContent,
          createdAt,
          updatedAt,
          importance,
          strength,
          memoryType,
          source,
        )
      const inserted = this.db.prepare('SELECT rowid as rowid FROM memory WHERE rowid = last_insert_rowid()').get() as
        | { rowid?: number }
        | undefined
      const createdRowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
      if (createdRowid <= 0) throw new Error('新增候选记忆失败')

      // 后台索引：新建记忆需要补齐 tags / embedding
      this.enqueueTagIndex(createdRowid)
      this.enqueueEmbeddingIndex(createdRowid)
      this.enqueueKgIndex(createdRowid)
      return finalize('resolved', 'keepBoth', { createdRowid })
    }

    if (args.action === 'merge') {
      const mergedRaw = typeof args.mergedContent === 'string' ? args.mergedContent.trim() : ''
      const merged = mergedRaw || `${row.baseContent.trim()}\n${row.candidateContent.trim()}`.trim()
      const updated = this.updateMemory({
        rowid: row.memoryRowid,
        content: merged,
        reason: `conflict_merge:${id}:${row.conflictType}`,
        source: row.candidateSource ?? 'conflict_merge',
      })
      return finalize('resolved', 'merge', { updatedRowid: updated.rowid })
    }

    throw new Error('未知 action')
  }

  private computeRetentionScore(nowMs: number, createdAt: number, lastAccessedAt: number | null, strength: number): number {
    const baseAt =
      typeof lastAccessedAt === 'number' && Number.isFinite(lastAccessedAt) && lastAccessedAt > 0 ? lastAccessedAt : createdAt
    const ageMs = Math.max(0, nowMs - baseAt)
    const s = clampFloat(strength, 0.2, 0, 1)
    const baseHalfLifeDays = 14
    const halfLifeDays = baseHalfLifeDays * (0.3 + s * 2)
    if (halfLifeDays <= 0) return 0
    const ageDays = ageMs / 86_400_000
    const retention = Math.pow(0.5, ageDays / halfLifeDays)
    return clampFloat(retention, 1, 0, 1)
  }

  private reinforceMemoryHits(rowids: number[], nowMs: number): void {
    const ids = Array.from(new Set(rowids.map((v) => clampInt(v, 0, 1, 2_000_000_000)).filter((v) => v > 0)))
    if (ids.length === 0) return

    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(
        `
        UPDATE memory
        SET
          access_count = access_count + 1,
          last_accessed_at = ?,
          strength = MIN(1, strength + 0.04),
          retention = 1,
          status = 'active'
        WHERE rowid IN (${placeholders})
          AND COALESCE(status, 'active') <> 'deleted'
        `,
      )
      .run(nowMs, ...ids)
  }

  runRetentionMaintenance(opts?: {
    batchSize?: number
    minIdleMs?: number
    archiveThreshold?: number
  }): { scanned: number; updated: number; archived: number } {
    const nowMs = now()
    const batchSize = clampInt(opts?.batchSize, 400, 50, 5000)
    const minIdleMs = clampInt(opts?.minIdleMs, 6 * 60 * 60_000, 0, 30 * 24 * 60 * 60_000)
    const archiveThreshold = clampFloat(opts?.archiveThreshold, 0.05, 0, 1)
    const idleBefore = nowMs - minIdleMs

    const rows = this.db
      .prepare(
        `
        SELECT
          rowid as rowid,
          created_at as createdAt,
          last_accessed_at as lastAccessedAt,
          strength as strength,
          pinned as pinned,
          status as status,
          retention as storedRetention
        FROM memory
        WHERE COALESCE(status, 'active') <> 'deleted'
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)
        ORDER BY COALESCE(last_accessed_at, created_at) ASC, rowid ASC
        LIMIT ?
        `,
      )
      .all(idleBefore, batchSize) as Array<{
      rowid: number
      createdAt: number
      lastAccessedAt: number | null
      strength: number
      pinned: number
      status: string | null
      storedRetention: number
    }>

    if (rows.length === 0) return { scanned: 0, updated: 0, archived: 0 }

    const updates: Array<{ rowid: number; retention: number; status: string }> = []
    let archived = 0

    for (const r of rows) {
      const retention = this.computeRetentionScore(nowMs, r.createdAt, r.lastAccessedAt, r.strength)
      const isPinned = (r.pinned ?? 0) !== 0
      const currentStatus = (r.status ?? 'active').trim() || 'active'
      let nextStatus = currentStatus

      if (isPinned) {
        nextStatus = 'active'
      } else if (retention < archiveThreshold) {
        nextStatus = 'archived'
      }

      const prevRetention = clampFloat(r.storedRetention, retention, 0, 1)
      const shouldUpdate = Math.abs(retention - prevRetention) >= 0.02 || nextStatus !== currentStatus
      if (!shouldUpdate) continue
      if (currentStatus !== 'archived' && nextStatus === 'archived') archived += 1
      updates.push({ rowid: r.rowid, retention, status: nextStatus })
    }

    if (updates.length === 0) return { scanned: rows.length, updated: 0, archived: 0 }

    const tx = this.db.transaction((items: Array<{ rowid: number; retention: number; status: string }>) => {
      const stmt = this.db.prepare('UPDATE memory SET retention = ?, status = ? WHERE rowid = ?')
      for (const it of items) stmt.run(it.retention, it.status, it.rowid)
    })
    tx(updates)

    return { scanned: rows.length, updated: updates.length, archived }
  }

  async retrieveContext(args: MemoryRetrieveArgs, memSettings: MemorySettings, aiSettings: AISettings): Promise<MemoryRetrieveResult> {
    const startedAt = now()
    const personaId = args.personaId.trim() || 'default'
    const persona = this.getPersona(personaId)
    if (persona && !persona.retrieveEnabled) return { addon: '' }
    const query = args.query.trim()
    if (!query) return { addon: this.buildPersonaAddon(personaId, '') }

    const limit = clampInt(args.limit, 12, 1, 50)
    const maxChars = clampInt(args.maxChars, 2800, 200, 20000)
    const includeShared = args.includeShared !== false
    const nowMs = now()

    // 时间线索优先：针对“某天凌晨/某个时间点/准确复述”类问题，按 created_at 范围直接取原文片段
    const tr = parseTimeRangeFromQuery(query, nowMs)
    if (tr) {
      const rows = this.db
        .prepare(
          `
          SELECT rowid as rowid, role as role, content as content, created_at as createdAt
          FROM memory
          WHERE created_at BETWEEN ? AND ?
            AND COALESCE(role, 'note') IN ('user', 'assistant')
            AND COALESCE(status, 'active') <> 'deleted'
            AND (
              persona_id = ?
              ${includeShared ? 'OR persona_id IS NULL' : ''}
            )
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
          `,
        )
        .all(tr.startMs, tr.endMs, personaId, Math.max(limit, 20)) as Array<{
        rowid: number
        role: string | null
        content: string
        createdAt: number
      }>

      const lines: string[] = []
      const hitRowids: number[] = []
      let used = 0
      for (const r of rows) {
        const content = r.content.trim()
        if (!content) continue
        const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : 'note'
        const prefix = `- (${formatTs(r.createdAt)}) ${role}: `
        const available = Math.max(0, maxChars - used - prefix.length)
        if (available <= 0) break
        const clipped = content.length > available ? content.slice(0, available) + '…' : content
        const line = prefix + clipped
        lines.push(line)
        hitRowids.push(r.rowid)
        used += line.length + 1
        if (used >= maxChars) break
      }

      if (hitRowids.length > 0) this.reinforceMemoryHits(hitRowids, nowMs)

      const hint =
        tr.quoteOnly
          ? '【引用规则】\n用户要求“准确复述/原话”时，只能依据下方【时间片段原文】逐字引用；若未找到对应内容，直接说“我忘了/没检索到”。'
          : ''
      const timeBlock = lines.length > 0 ? `【时间片段原文】\n${lines.join('\n')}` : '【时间片段原文】\n（未检索到该时间段的原文）'
      const memoryBlock = [hint, timeBlock].filter(Boolean).join('\n\n')
      return {
        addon: this.buildPersonaAddon(personaId, memoryBlock),
        debug: {
          tookMs: Math.max(0, now() - startedAt),
          layers: ['timeRange'],
          counts: { timeRange: hitRowids.length, fts: 0, like: 0, tag: 0, vector: 0, kg: 0 },
          vector: { enabled: memSettings.vectorEnabled ?? false, attempted: false, reason: 'timeRange' },
          tag: { queryTags: 0, matchedTags: 0, expandedTags: 0 },
        },
      }
    }

    const match = ftsQueryFromText(query)
    if (!match) {
      return {
        addon: this.buildPersonaAddon(personaId, ''),
        debug: {
          tookMs: Math.max(0, now() - startedAt),
          layers: ['none'],
          counts: { timeRange: 0, fts: 0, like: 0, tag: 0, vector: 0, kg: 0 },
          vector: { enabled: memSettings.vectorEnabled ?? false, attempted: false, reason: 'no_match' },
          tag: { queryTags: 0, matchedTags: 0, expandedTags: 0 },
        },
      }
    }

    type CandidateRow = {
      rowid: number
      role: string | null
      content: string
      createdAt: number
      importance: number
      strength: number
      accessCount: number
      lastAccessedAt: number | null
      status: string | null
      pinned: number | null
    }

    type Candidate = CandidateRow & {
      ftsRel: number
      likeRel: number
      tagRel: number
      vecRel: number
      kgRel: number
    }

    const candidates = new Map<number, Candidate>()
    const upsert = (
      row: CandidateRow,
      patch: Partial<Pick<Candidate, 'ftsRel' | 'likeRel' | 'tagRel' | 'vecRel' | 'kgRel'>>,
    ) => {
      const prev = candidates.get(row.rowid)
      if (!prev) {
        candidates.set(row.rowid, {
          ...row,
          ftsRel: patch.ftsRel ?? 0,
          likeRel: patch.likeRel ?? 0,
          tagRel: patch.tagRel ?? 0,
          vecRel: patch.vecRel ?? 0,
          kgRel: patch.kgRel ?? 0,
        })
        return
      }
      prev.ftsRel = Math.max(prev.ftsRel, patch.ftsRel ?? 0)
      prev.likeRel = Math.max(prev.likeRel, patch.likeRel ?? 0)
      prev.tagRel = Math.max(prev.tagRel, patch.tagRel ?? 0)
      prev.vecRel = Math.max(prev.vecRel, patch.vecRel ?? 0)
      prev.kgRel = Math.max(prev.kgRel, patch.kgRel ?? 0)
    }

    const ftsLimit = clampInt(limit * 5, 60, limit, 200)

    const ftsRows = this.db
      .prepare(
        `
        SELECT
          m.rowid as rowid,
          m.role as role,
          m.content as content,
          m.created_at as createdAt,
          m.importance as importance,
          m.strength as strength,
          m.access_count as accessCount,
          m.last_accessed_at as lastAccessedAt,
          m.status as status,
          m.pinned as pinned,
          bm25(memory_fts) as score
        FROM memory_fts
        JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
          AND (
            m.persona_id = ?
            ${includeShared ? 'OR m.persona_id IS NULL' : ''}
          )
          AND COALESCE(m.status, 'active') <> 'deleted'
        ORDER BY score ASC, m.created_at DESC
        LIMIT ?
        `,
      )
      .all(match, personaId, ftsLimit) as Array<CandidateRow & { score: number | null }>

    for (const r of ftsRows) {
      const rel = typeof r.score === 'number' && Number.isFinite(r.score) ? 1 / (1 + Math.max(0, r.score)) : 0
      upsert(r, { ftsRel: rel })
    }

    // FTS 没命中时，退化为 LIKE（对中文无分词/符号影响更鲁棒）
    if (ftsRows.length === 0) {
      const kw = extractKeywordFromQueryForLike(query)
      const needle = (kw && kw !== query ? kw : query).slice(0, 120)
      const like = `%${needle}%`
      const likeRows = this.db
        .prepare(
          `
          SELECT
            rowid as rowid,
            role as role,
            content as content,
            created_at as createdAt,
            importance as importance,
            strength as strength,
            access_count as accessCount,
            last_accessed_at as lastAccessedAt,
            status as status,
            pinned as pinned
          FROM memory
          WHERE content LIKE ?
            AND (
              persona_id = ?
              ${includeShared ? 'OR persona_id IS NULL' : ''}
            )
            AND COALESCE(status, 'active') <> 'deleted'
          ORDER BY created_at DESC
          LIMIT ?
          `,
        )
        .all(like, personaId, ftsLimit) as CandidateRow[]

      for (const r of likeRows) upsert(r, { likeRel: 0.38 })
    }

    // M5：Tag 网络召回（本地，解决“截句/外壳词/换说法”）
    const tagEnabled = memSettings.tagEnabled ?? true
    const tagMaxExpand = clampInt(memSettings.tagMaxExpand, 6, 0, 40)
    const queryTags = tagEnabled ? extractTagsFromText(query, { maxTags: 12 }) : []
    const baseTagNames = queryTags.filter((t) => t && !t.startsWith('__')).slice(0, 12)

    let allTagIds: number[] = []
    let baseTagIds: number[] = []
    let matchedTagCount = 0

    if (tagEnabled && baseTagNames.length > 0) {
      const placeholders = baseTagNames.map(() => '?').join(',')
      const found = this.db
        .prepare(`SELECT id as id, name as name FROM tag WHERE name IN (${placeholders})`)
        .all(...baseTagNames) as Array<{ id: number; name: string }>
      baseTagIds = found.map((r) => clampInt(r.id, 0, 1, 2_000_000_000)).filter((v) => v > 0)
      matchedTagCount = baseTagIds.length
      allTagIds = [...baseTagIds]

      if (baseTagIds.length > 0 && tagMaxExpand > 0) {
        const inA = baseTagIds.map(() => '?').join(',')
        const inB = baseTagIds.map(() => '?').join(',')
        const related = this.db
          .prepare(
            `
            SELECT mt2.tag_id as tagId, COUNT(*) as c
            FROM memory_tag mt1
            JOIN memory_tag mt2 ON mt1.memory_rowid = mt2.memory_rowid
            JOIN memory m ON m.rowid = mt1.memory_rowid
            WHERE mt1.tag_id IN (${inA})
              AND mt2.tag_id NOT IN (${inB})
              AND (
                m.persona_id = ?
                ${includeShared ? 'OR m.persona_id IS NULL' : ''}
              )
              AND COALESCE(m.status, 'active') <> 'deleted'
            GROUP BY mt2.tag_id
            ORDER BY c DESC
            LIMIT ?
            `,
          )
          .all(...baseTagIds, ...baseTagIds, personaId, tagMaxExpand) as Array<{ tagId: number }>
        const extra = related.map((r) => clampInt(r.tagId, 0, 1, 2_000_000_000)).filter((v) => v > 0)
        allTagIds = Array.from(new Set([...allTagIds, ...extra]))
      }

      if (allTagIds.length > 0) {
        const inTags = allTagIds.map(() => '?').join(',')
        const tagLimit = clampInt(limit * 8, 120, limit, 600)
        const tagRows = this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.role as role,
              m.content as content,
              m.created_at as createdAt,
              m.importance as importance,
              m.strength as strength,
              m.access_count as accessCount,
              m.last_accessed_at as lastAccessedAt,
              m.status as status,
              m.pinned as pinned,
              COUNT(DISTINCT mt.tag_id) as tagHits
            FROM memory_tag mt
            JOIN memory m ON m.rowid = mt.memory_rowid
            WHERE mt.tag_id IN (${inTags})
              AND (
                m.persona_id = ?
                ${includeShared ? 'OR m.persona_id IS NULL' : ''}
              )
              AND COALESCE(m.status, 'active') <> 'deleted'
            GROUP BY m.rowid
            ORDER BY tagHits DESC, m.created_at DESC
            LIMIT ?
            `,
          )
          .all(...allTagIds, personaId, tagLimit) as Array<CandidateRow & { tagHits: number }>

        const denom = Math.max(1, baseTagIds.length)
        for (const r of tagRows) {
          const rel = clampFloat(r.tagHits / denom, 0, 0, 1)
          upsert(r, { tagRel: rel })
        }
      }
    }

    // M6：KG 图谱召回（实体/关系 -> 反查证据 memory_rowid）
    const kgEnabled = memSettings.kgEnabled ?? false
    if (kgEnabled) {
      const kgMatch = ftsQueryFromText(query)
      if (kgMatch) {
        const entRows = this.db
          .prepare(
            `
            SELECT e.id as id
            FROM kg_entity_fts
            JOIN kg_entity e ON e.id = kg_entity_fts.rowid
            WHERE kg_entity_fts MATCH ?
              AND e.persona_id = ?
            LIMIT 12
            `,
          )
          .all(kgMatch, personaId) as Array<{ id: number }>

        const entIds = entRows.map((r) => clampInt(r.id, 0, 1, 2_000_000_000)).filter((v) => v > 0)
        if (entIds.length > 0) {
          const placeholders = entIds.map(() => '?').join(',')
          const kgLimit = clampInt(limit * 6, 120, limit, 500)

          const memRows = this.db
            .prepare(
              `
              SELECT
                m.rowid as rowid,
                m.role as role,
                m.content as content,
                m.created_at as createdAt,
                m.importance as importance,
                m.strength as strength,
                m.access_count as accessCount,
                m.last_accessed_at as lastAccessedAt,
                m.status as status,
                m.pinned as pinned,
                COUNT(DISTINCT em.entity_id) as entHits
              FROM kg_entity_mention em
              JOIN memory m ON m.rowid = em.memory_rowid
              WHERE em.entity_id IN (${placeholders})
                AND m.persona_id = ?
                AND COALESCE(m.status, 'active') <> 'deleted'
              GROUP BY m.rowid
              ORDER BY entHits DESC, m.created_at DESC
              LIMIT ?
              `,
            )
            .all(...entIds, personaId, kgLimit) as Array<CandidateRow & { entHits: number }>

          const denom = Math.max(1, entIds.length)
          for (const r of memRows) {
            const rel = clampFloat(r.entHits / denom, 0, 0, 1)
            upsert(r, { kgRel: rel })
          }
        }
      }
    }

    // M5：向量召回（仅在候选不足时启用，降低额外延迟）
    const vectorEnabled = memSettings.vectorEnabled ?? false
    const needVector = vectorEnabled && candidates.size < limit
    let vectorAttempted = false
    let vectorReason: string | undefined
    let vectorError: string | undefined

    if (needVector) {
      const model = (memSettings.vectorEmbeddingModel ?? '').trim()
      const minScore = clampFloat(memSettings.vectorMinScore, 0.35, 0, 1)
      const topK = clampInt(memSettings.vectorTopK, 20, 1, 100)
      const scanLimit = clampInt(memSettings.vectorScanLimit, 2000, 200, 200000)

      const useCustom = memSettings.vectorUseCustomAi ?? false
      const apiKey = (useCustom ? memSettings.vectorAiApiKey : aiSettings.apiKey) ?? ''
      const baseUrl = (useCustom ? memSettings.vectorAiBaseUrl : aiSettings.baseUrl) ?? ''

      if (model && apiKey.trim() && baseUrl.trim()) {
        const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`
        try {
          vectorAttempted = true
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, input: normalizeMemoryText(query).slice(0, 800) }),
          })

          if (resp.ok) {
            const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
            const vec = data.data?.[0]?.embedding ?? []
            if (Array.isArray(vec) && vec.length >= 8) {
              const q = new Float32Array(vec.length)
              let norm = 0
              for (let i = 0; i < vec.length; i++) {
                const v = Number(vec[i])
                q[i] = Number.isFinite(v) ? v : 0
                norm += q[i] * q[i]
              }
              norm = Math.sqrt(norm) || 1
              for (let i = 0; i < q.length; i++) q[i] = q[i] / norm

              const embedRows = this.db
                .prepare(
                  `
                  SELECT
                    m.rowid as rowid,
                    m.role as role,
                    m.content as content,
                    m.created_at as createdAt,
                    m.importance as importance,
                    m.strength as strength,
                    m.access_count as accessCount,
                    m.last_accessed_at as lastAccessedAt,
                    m.status as status,
                    m.pinned as pinned,
                    e.embedding as embedding
                  FROM memory_embedding e
                  JOIN memory m ON m.rowid = e.memory_rowid
                  WHERE e.model = ?
                    AND (
                      m.persona_id = ?
                      ${includeShared ? 'OR m.persona_id IS NULL' : ''}
                    )
                    AND COALESCE(m.status, 'active') <> 'deleted'
                  ORDER BY m.pinned DESC, m.retention DESC, m.importance DESC, m.updated_at DESC
                  LIMIT ?
                  `,
                )
                .all(model, personaId, scanLimit) as Array<CandidateRow & { embedding: Buffer }>

              const scored: Array<CandidateRow & { sim: number }> = []
              for (const r of embedRows) {
                const buf = r.embedding
                if (!buf || buf.byteLength < 8 * 4) continue
                const dim = Math.floor(buf.byteLength / 4)
                if (dim !== q.length) continue
                const v = new Float32Array(buf.buffer, buf.byteOffset, dim)
                let dot = 0
                for (let i = 0; i < dim; i++) dot += q[i] * v[i]
                if (!Number.isFinite(dot)) continue
                if (dot < minScore) continue
                scored.push({ ...r, sim: dot })
              }

              scored.sort((a, b) => b.sim - a.sim || b.createdAt - a.createdAt || b.rowid - a.rowid)
              for (const r of scored.slice(0, topK)) {
                upsert(r, { vecRel: clampFloat(r.sim, 0, 0, 1) })
              }
            } else {
              vectorError = 'embeddings 返回为空或维度过小'
            }
          } else {
            const errData = await resp.json().catch(() => ({} as unknown))
            vectorError =
              (errData as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}: ${resp.statusText}`
          }
        } catch (err) {
          vectorError = err instanceof Error ? err.message : String(err)
        }
      } else {
        vectorReason = 'missing_config'
      }
    } else {
      vectorReason = vectorEnabled ? 'candidates_sufficient' : 'disabled'
    }

    const ranked = Array.from(candidates.values())
      .map((r) => {
        const importance = clampFloat(r.importance, 0.5, 0, 1)
        const strength = clampFloat(r.strength, 0.2, 0, 1)
        const retention = this.computeRetentionScore(nowMs, r.createdAt, r.lastAccessedAt, strength)

        const fts = clampFloat(r.ftsRel, 0, 0, 1)
        const like = clampFloat(r.likeRel, 0, 0, 1)
        const tag = clampFloat(r.tagRel, 0, 0, 1)
        const kg = clampFloat(r.kgRel, 0, 0, 1)
        const vec = clampFloat(r.vecRel, 0, 0, 1)
        const relevance = 1 - (1 - fts) * (1 - like) * (1 - tag) * (1 - kg) * (1 - vec)

        const statusFactor = r.status === 'archived' ? 0.3 : 1
        const pinnedFactor = (r.pinned ?? 0) ? 1.4 : 1
        const weight = relevance * retention * (0.5 + importance) * statusFactor * pinnedFactor
        return { ...r, importance, strength, retention, relevance, weight }
      })
      .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt || b.rowid - a.rowid)
      .slice(0, limit)

    const lines: string[] = []
    const hitRowids: number[] = []
    let used = 0
    for (const r of ranked) {
      const content = r.content.trim().replace(/\s+/g, ' ')
      if (!content) continue
      const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : 'note'
      const prefix = `- (${formatTs(r.createdAt)}) ${role}: `
      const available = Math.max(0, maxChars - used - prefix.length)
      if (available <= 0) break
      const clipped = content.length > available ? content.slice(0, available) + '…' : content
      const line = prefix + clipped
      lines.push(line)
      hitRowids.push(r.rowid)
      used += line.length + 1
      if (used >= maxChars) break
    }

    if (hitRowids.length > 0) this.reinforceMemoryHits(hitRowids, nowMs)

    const memoryBlock = lines.length > 0 ? `【相关记忆】\n${lines.join('\n')}` : ''

    const counts = {
      timeRange: 0,
      fts: ranked.filter((r) => r.ftsRel > 0).length,
      like: ranked.filter((r) => r.likeRel > 0).length,
      tag: ranked.filter((r) => r.tagRel > 0).length,
      vector: ranked.filter((r) => r.vecRel > 0).length,
      kg: ranked.filter((r) => r.kgRel > 0).length,
    }

    const layers: Array<'none' | 'timeRange' | 'fts' | 'like' | 'tag' | 'vector' | 'kg'> = []
    if (counts.fts > 0) layers.push('fts')
    if (counts.like > 0) layers.push('like')
    if (counts.tag > 0) layers.push('tag')
    if (counts.kg > 0) layers.push('kg')
    if (counts.vector > 0) layers.push('vector')
    if (layers.length === 0) layers.push('none')

    return {
      addon: this.buildPersonaAddon(personaId, memoryBlock),
      debug: {
        tookMs: Math.max(0, now() - startedAt),
        layers,
        counts,
        tag: { queryTags: baseTagNames.length, matchedTags: matchedTagCount, expandedTags: allTagIds.length },
        vector: { enabled: vectorEnabled, attempted: vectorAttempted, ...(vectorReason ? { reason: vectorReason } : {}), ...(vectorError ? { error: vectorError } : {}) },
      },
    }
  }

  private buildPersonaAddon(personaId: string, memoryBlock: string): string {
    const persona = this.getPersona(personaId)
    const parts: string[] = []

    if (persona && persona.prompt.trim().length > 0) {
      parts.push(`【当前人设】\n${persona.prompt.trim()}`)
    }
    if (memoryBlock.trim().length > 0) {
      parts.push(memoryBlock.trim())
    }
    return parts.join('\n\n').trim()
  }
}
