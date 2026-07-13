import { randomUUID } from 'node:crypto'
import { openMemoryDatabase, type MemoryDatabaseHandle } from './memory/memoryDatabase'
import {
  MemoryEmbeddingClient,
  hashMemoryEmbeddingInput,
  resolveMemoryEmbeddingConfig,
} from './memory/memoryEmbeddingClient'
import { MemoryIndexQueue } from './memory/memoryIndexQueue'
import { MemoryKgIndexMaintainer } from './memory/memoryKgIndex'
import { computeMemoryRetentionScore, MemoryRetrievalEngine } from './memory/memoryRetrieval'
import { MemoryTagIndexMaintainer } from './memory/memoryTagIndex'
import { MemoryVectorIndexMaintainer } from './memory/memoryVectorIndex'
import { MemoryVectorSearchClient } from './memory/memoryVectorSearchClient'
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
import { normalizePersonaStorageRow, type PersonaStorageRow } from './personaRecord'

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

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
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

export class MemoryService {
  private db: MemoryDatabaseHandle
  private indexQueue = new MemoryIndexQueue()
  private embeddingClient = new MemoryEmbeddingClient()
  private chatIngestRedirect = new Map<string, number>()
  private kgIndexMaintainer: MemoryKgIndexMaintainer
  private tagIndexMaintainer: MemoryTagIndexMaintainer
  private vectorIndexMaintainer: MemoryVectorIndexMaintainer
  private retrievalEngine: MemoryRetrievalEngine
  private vectorSearchClient: MemoryVectorSearchClient

  constructor(userDataDir: string) {
    const opened = openMemoryDatabase(userDataDir)
    this.db = opened.db
    this.kgIndexMaintainer = new MemoryKgIndexMaintainer(opened.db, this.indexQueue)
    this.tagIndexMaintainer = new MemoryTagIndexMaintainer(opened.db, this.indexQueue)
    this.vectorIndexMaintainer = new MemoryVectorIndexMaintainer(opened.db, this.indexQueue, this.embeddingClient)
    this.vectorSearchClient = new MemoryVectorSearchClient(opened.dbPath)
    this.retrievalEngine = new MemoryRetrievalEngine(
      opened.db,
      this.embeddingClient,
      this.vectorSearchClient,
      (personaId) => this.getPersona(personaId),
    )
  }

  close(): void {
    this.vectorSearchClient.close()
    this.db.close()
  }

  private rememberChatIngestRedirect(key: string, rowid: number): void {
    if (!key.trim() || rowid <= 0) return
    if (this.chatIngestRedirect.has(key)) this.chatIngestRedirect.delete(key)
    this.chatIngestRedirect.set(key, rowid)
    const max = 600
    while (this.chatIngestRedirect.size > max) {
      const first = this.chatIngestRedirect.keys().next().value as string | undefined
      if (!first) break
      this.chatIngestRedirect.delete(first)
    }
  }


  private async ensureEmbeddingsForRows(
    rows: Array<{ rowid: number; content: string; updatedAt: number }>,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<Map<number, { model: string; hash: string; vec: Float32Array }>> {
    const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings)
    if (!config) return new Map()

    const picked = rows.filter((r) => r.rowid > 0 && normalizeMemoryText(r.content).length >= 2)
    if (picked.length === 0) return new Map()

    const rowids = Array.from(new Set(picked.map((r) => r.rowid)))
    const placeholders = rowids.map(() => '?').join(',')

    type Exist = { rowid: number; model: string; contentHash: string; embedding: Buffer; updatedAt: number }
    const existRows = this.db
      .prepare(
        `
        SELECT
          memory_rowid as rowid,
          model as model,
          content_hash as contentHash,
          embedding as embedding,
          updated_at as updatedAt
        FROM memory_embedding
        WHERE memory_rowid IN (${placeholders})
        `,
      )
      .all(...rowids) as Exist[]
    const existByRowid = new Map<number, Exist>()
    for (const e of existRows) existByRowid.set(e.rowid, e)

    const need: Array<{ rowid: number; text: string; hash: string }> = []
    const out = new Map<number, { model: string; hash: string; vec: Float32Array }>()

    for (const r of picked) {
      const text = normalizeMemoryText(r.content).slice(0, 2000)
      const hash = hashMemoryEmbeddingInput(config.model, text)
      const exist = existByRowid.get(r.rowid)
      if (exist && exist.model === config.model && exist.contentHash === hash && (exist.updatedAt ?? 0) >= (r.updatedAt ?? 0)) {
        const buf = exist.embedding
        if (buf && buf.byteLength >= 8 * 4) {
          const dim = Math.floor(buf.byteLength / 4)
          const vec = new Float32Array(buf.buffer, buf.byteOffset, dim)
          out.set(r.rowid, { model: config.model, hash, vec })
          continue
        }
      }
      need.push({ rowid: r.rowid, text, hash })
    }

    if (need.length === 0) return out

    const embedded = await this.embeddingClient.embedTexts(
      config,
      need.map((n) => n.text),
    )

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
      for (let i = 0; i < need.length; i++) {
        const item = need[i]
        const vec = embedded[i].vec
        const buf = Buffer.from(vec.buffer)
        upsert.run(item.rowid, config.model, vec.length, item.hash, buf, ts, ts)
        out.set(item.rowid, { model: config.model, hash: item.hash, vec })
      }
    })
    tx()
    return out
  }

  private async findBestVectorDuplicate(opts: {
    personaId: string | null
    scope: 'persona' | 'shared'
    kind: string
    role: string | null
    excludeRowid?: number
    vec: Float32Array
    threshold: number
    memSettings: MemorySettings | undefined
    aiSettings: AISettings
  }): Promise<{ rowid: number; sim: number; content: string; createdAt: number; updatedAt: number } | null> {
    const { vec, threshold } = opts
    if (vec.length < 8) return null

    const config = resolveMemoryEmbeddingConfig(opts.memSettings, opts.aiSettings)
    if (!config) return null

    const scanLimit = 400
    const embedBatchLimit = 40
    const excludeRowid = clampInt(opts.excludeRowid, 0, 0, 2_000_000_000)

    const wherePersona = opts.personaId === null ? 'm.persona_id IS NULL' : 'm.persona_id = ?'
    const params: unknown[] = [config.model]
    if (opts.personaId !== null) params.push(opts.personaId)
    params.push(opts.scope, opts.kind)
    if (opts.role === null) {
      params.push(excludeRowid, scanLimit)
    } else {
      params.push(opts.role, excludeRowid, scanLimit)
    }

    type Row = {
      rowid: number
      content: string
      createdAt: number
      updatedAt: number
      embedding: Buffer | null
    }

    const rows = this.db
      .prepare(
        `
        SELECT
          m.rowid as rowid,
          m.content as content,
          m.created_at as createdAt,
          m.updated_at as updatedAt,
          e.embedding as embedding
        FROM memory m
        LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid AND e.model = ?
        WHERE ${wherePersona}
          AND m.scope = ?
          AND m.kind = ?
          ${opts.role === null ? '' : 'AND m.role = ?'}
          AND COALESCE(m.status, 'active') <> 'deleted'
          AND m.rowid <> ?
        ORDER BY m.updated_at DESC, m.rowid DESC
        LIMIT ?
        `,
      )
      .all(...params) as Row[]

    if (rows.length === 0) return null

    const needEmbed = rows
      .filter((r) => !r.embedding)
      .slice(0, embedBatchLimit)
      .map((r) => ({ rowid: r.rowid, content: r.content, updatedAt: r.updatedAt }))
    if (needEmbed.length > 0) {
      try {
        await this.ensureEmbeddingsForRows(needEmbed, opts.memSettings, opts.aiSettings)
      } catch {
        // ignore
      }
    }

    let best: { rowid: number; sim: number; content: string; createdAt: number; updatedAt: number } | null = null

    for (const r of rows) {
      let buf = r.embedding
      if (!buf) {
        const fetched = this.db
          .prepare('SELECT embedding as embedding FROM memory_embedding WHERE memory_rowid = ? AND model = ? LIMIT 1')
          .get(r.rowid, config.model) as { embedding?: Buffer } | undefined
        buf = (fetched?.embedding as Buffer | undefined) ?? null
      }
      if (!buf || buf.byteLength < 8 * 4) continue
      const dim = Math.floor(buf.byteLength / 4)
      if (dim !== vec.length) continue
      const v = new Float32Array(buf.buffer, buf.byteOffset, dim)
      let dot = 0
      for (let i = 0; i < dim; i++) dot += vec[i] * v[i]
      if (!Number.isFinite(dot)) continue
      if (dot < threshold) continue
      if (!best || dot > best.sim) best = { rowid: r.rowid, sim: dot, content: r.content, createdAt: r.createdAt, updatedAt: r.updatedAt }
    }

    return best
  }

  /** 注册"有新索引工作入队"的通知回调（debounce 由调用方负责） */
  setMaintenanceKick(cb: (() => void) | null): void {
    this.indexQueue.setKick(cb)
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
    r.retention = computeMemoryRetentionScore(now(), r.createdAt, r.lastAccessedAt, r.strength)
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
      .get(personaId) as PersonaStorageRow | undefined
    return normalizePersonaStorageRow(row)
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

  async ingestChatMessage(args: MemoryIngestChatMessageArgs, memSettings: MemorySettings | undefined, aiSettings: AISettings): Promise<void> {
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

    const extractTurnUserText = (turnRaw: string): string => {
      const turn = String(turnRaw ?? '').trim()
      if (!turn) return ''
      const m = turn.match(/用户：([\s\S]*?)(?:\r?\n助手：|$)/)
      return (m?.[1] ?? '').trim()
    }

    const extractTurnAssistantText = (turnRaw: string): string => {
      const turn = String(turnRaw ?? '').trim()
      if (!turn) return ''
      const m = turn.match(/\r?\n助手：([\s\S]*)$/)
      return (m?.[1] ?? '').trim()
    }

    const mergeTurnContent = (baseRaw: string, candRaw: string): string => {
      const base = String(baseRaw ?? '').trim()
      const cand = String(candRaw ?? '').trim()
      if (!base) return cand
      if (!cand) return base

      const baseUser = extractTurnUserText(base)
      const candUser = extractTurnUserText(cand)
      const baseUserNorm = normalizeMemoryText(baseUser).replace(/\s+/g, '')
      const candUserNorm = normalizeMemoryText(candUser).replace(/\s+/g, '')
      let finalUser = baseUser
      if (candUserNorm && (candUserNorm.length > baseUserNorm.length || candUserNorm.includes(baseUserNorm))) finalUser = candUser

      const baseAssistant = extractTurnAssistantText(base)
      const candAssistant = extractTurnAssistantText(cand)
      const baseA = normalizeMemoryText(baseAssistant).replace(/\s+/g, '')
      const candA = normalizeMemoryText(candAssistant).replace(/\s+/g, '')
      let finalAssistant = baseAssistant
      if (candA && (candA.length > baseA.length || candA.includes(baseA))) finalAssistant = candAssistant

      if (finalUser.trim() && finalAssistant.trim()) return `用户：${finalUser.trim()}\n助手：${finalAssistant.trim()}`.trim()
      if (cand.trim()) return cand
      return base
    }

    const turnKey = `${args.sessionId}\n${args.messageId}`
    const redirected = this.chatIngestRedirect.get(turnKey)
    if (redirected && redirected > 0) {
      const target = this.getMemoryByRowid(redirected)
      if (!target || target.status === 'deleted') {
        this.chatIngestRedirect.delete(turnKey)
      } else {
        const merged = mergeTurnContent(target.content, content)
        const mergedNorm = normalizeMemoryText(merged).replace(/\s+/g, '')
        const oldNorm = normalizeMemoryText(target.content).replace(/\s+/g, '')
        if (mergedNorm !== oldNorm) {
          this.addMemoryVersion({
            memoryRowid: redirected,
            oldContent: target.content,
            newContent: merged,
            reason: 'vector_dedupe_merge',
            source,
            createdAt: updatedAt,
          })
        }
        this.db
          .prepare(
            "UPDATE memory SET content = ?, created_at = MIN(created_at, ?), updated_at = ?, retention = 1, strength = MIN(1, strength + 0.01), status = 'active', source = ? WHERE rowid = ?",
          )
          .run(merged, createdAt, updatedAt, source, redirected)
        try {
          await this.ensureEmbeddingsForRows([{ rowid: redirected, content: merged, updatedAt }], memSettings, aiSettings)
        } catch {
          /* ignore */
        }
        this.indexQueue.enqueueAll(redirected)
        return
      }
    }

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

    let rowid = 0
    try {
      const inserted = this.db
        .prepare('SELECT rowid as rowid FROM memory WHERE session_id = ? AND message_id = ? LIMIT 1')
        .get(args.sessionId, args.messageId) as { rowid?: number } | undefined
      rowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
    } catch {
      rowid = 0
    }

    if (rowid <= 0) return

    const threshold = clampFloat(memSettings?.vectorDedupeThreshold, 0.9, 0.1, 0.99)
    let vec: Float32Array | null = null
    try {
      const embedded = await this.ensureEmbeddingsForRows([{ rowid, content, updatedAt }], memSettings, aiSettings)
      vec = embedded.get(rowid)?.vec ?? null
    } catch {
      vec = null
    }

    if (vec && vec.length >= 8) {
      try {
        const dup = await this.findBestVectorDuplicate({
          personaId: pid,
          scope: 'persona',
          kind: 'chat_message',
          role: args.role,
          excludeRowid: rowid,
          vec,
          threshold,
          memSettings,
          aiSettings,
        })

        if (dup && dup.rowid > 0) {
          const merged = mergeTurnContent(dup.content, content)
          const mergedNorm = normalizeMemoryText(merged).replace(/\s+/g, '')
          const oldNorm = normalizeMemoryText(dup.content).replace(/\s+/g, '')
          if (mergedNorm !== oldNorm) {
            this.addMemoryVersion({
              memoryRowid: dup.rowid,
              oldContent: dup.content,
              newContent: merged,
              reason: 'vector_dedupe_merge',
              source,
              createdAt: updatedAt,
            })
          }

          this.db
            .prepare(
              "UPDATE memory SET content = ?, created_at = MIN(created_at, ?), updated_at = ?, retention = 1, strength = MIN(1, strength + 0.01), status = 'active', source = ? WHERE rowid = ?",
            )
            .run(merged, createdAt, updatedAt, source, dup.rowid)

          this.db.prepare("UPDATE memory SET status = 'deleted', updated_at = ? WHERE rowid = ?").run(updatedAt, rowid)

          this.rememberChatIngestRedirect(turnKey, dup.rowid)

          try {
            await this.ensureEmbeddingsForRows([{ rowid: dup.rowid, content: merged, updatedAt }], memSettings, aiSettings)
          } catch {
            /* ignore */
          }

          this.indexQueue.enqueueAll(dup.rowid)
          return
        }
      } catch {
        /* ignore */
      }
    }

    this.indexQueue.enqueueAll(rowid)
  }

  runTagMaintenance(settings: MemorySettings, opts?: { batchSize?: number }): { scanned: number; updated: number } {
    return this.tagIndexMaintainer.run(settings, opts)
  }

  async runVectorEmbeddingMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; embedded: number; skipped: number; error?: string }> {
    return this.vectorIndexMaintainer.run(memSettings, aiSettings, opts)
  }

  async runKgMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; extracted: number; skipped: number; error?: string }> {
    return this.kgIndexMaintainer.run(memSettings, aiSettings, opts)
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
      it.retention = computeMemoryRetentionScore(nowMs, it.createdAt, it.lastAccessedAt, it.strength)
    }

    return { total, items }
  }

  async upsertManualMemory(args: MemoryUpsertManualArgs, memSettings: MemorySettings | undefined, aiSettings: AISettings): Promise<MemoryRecord> {
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

    const mergeManualNoteContent = (baseRaw: string, candRaw: string): string => {
      const base = baseRaw.trim()
      const cand = candRaw.trim()
      if (!base) return cand
      if (!cand) return base

      const baseNorm = normalizeMemoryText(base).replace(/\s+/g, '')
      const candNorm = normalizeMemoryText(cand).replace(/\s+/g, '')
      if (!baseNorm) return cand
      if (!candNorm) return base
      if (baseNorm === candNorm) return base
      if (candNorm.includes(baseNorm)) return cand
      if (baseNorm.includes(candNorm)) return base

      const baseKv = extractKeyValue(base)
      const candKv = extractKeyValue(cand)
      if (baseKv && candKv && baseKv.key === candKv.key) {
        return `${candKv.key}：${candKv.value}`
      }

      if (cand.length >= base.length + 8) return cand
      if (base.length >= cand.length + 8) return base

      const merged = `${base}；${cand}`.replace(/\s+/g, ' ').trim()
      return merged.length > 600 ? merged.slice(0, 600) : merged
    }

    const threshold = clampFloat(memSettings?.vectorDedupeThreshold, 0.9, 0.1, 0.99)
    const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings)
    const normalized = normalizeMemoryText(content)

    if (config && normalized.length >= 3) {
      try {
        const vec = (await this.embeddingClient.embedTexts(config, [normalized]))[0]?.vec ?? null
        if (vec && vec.length >= 8) {
          const dup = await this.findBestVectorDuplicate({
            personaId: pid,
            scope,
            kind: 'manual_note',
            role: 'note',
            excludeRowid: 0,
            vec,
            threshold,
            memSettings,
            aiSettings,
          })

          if (dup && dup.rowid > 0) {
            const existing = this.getMemoryByRowid(dup.rowid)
            if (!existing) throw new Error('重复检测命中，但记录不存在')

            const mergedContent = mergeManualNoteContent(existing.content, content)
            const mergedNorm = normalizeMemoryText(mergedContent).replace(/\s+/g, '')
            const existingNorm = normalizeMemoryText(existing.content).replace(/\s+/g, '')

            if (mergedNorm === existingNorm) {
              this.db
                .prepare(
                  "UPDATE memory SET updated_at = ?, importance = MAX(importance, ?), strength = MIN(1, MAX(strength, ?) + 0.01), retention = 1, status = 'active' WHERE rowid = ?",
                )
                .run(ts, importance, strength, dup.rowid)
              const refreshed = this.getMemoryByRowid(dup.rowid)
              if (!refreshed) throw new Error('重复检测命中，但记录不存在')
              return refreshed
            }

            this.addMemoryVersion({
              memoryRowid: dup.rowid,
              oldContent: existing.content,
              newContent: mergedContent,
              reason: 'vector_dedupe_merge',
              source,
              createdAt: ts,
            })

            this.db
              .prepare(
                "UPDATE memory SET content = ?, updated_at = ?, importance = MAX(importance, ?), strength = MIN(1, MAX(strength, ?) + 0.05), retention = 1, status = 'active', memory_type = ?, source = ? WHERE rowid = ?",
              )
              .run(mergedContent, ts, importance, strength, memoryType, source, dup.rowid)

            try {
              await this.ensureEmbeddingsForRows([{ rowid: dup.rowid, content: mergedContent, updatedAt: ts }], memSettings, aiSettings)
            } catch {
              /* ignore */
            }

            const updated = this.getMemoryByRowid(dup.rowid)
            if (!updated) throw new Error('重复合并命中，但记录不存在')
            this.indexQueue.enqueueAll(updated.rowid)
            return updated
          }
        }
      } catch {
        // ignore
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

    try {
      await this.ensureEmbeddingsForRows([{ rowid: row.rowid, content: row.content, updatedAt: ts }], memSettings, aiSettings)
    } catch {
      /* ignore */
    }

    // 后台索引：避免阻塞 UI
    this.indexQueue.enqueueAll(row.rowid)
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
    this.indexQueue.enqueueAll(updated.rowid)
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
      this.indexQueue.enqueueAll(createdRowid)
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
      const retention = computeMemoryRetentionScore(nowMs, r.createdAt, r.lastAccessedAt, r.strength)
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

  async retrieveContext(
    args: MemoryRetrieveArgs,
    memSettings: MemorySettings,
    aiSettings: AISettings,
  ): Promise<MemoryRetrieveResult> {
    return this.retrievalEngine.retrieve(args, memSettings, aiSettings)
  }

}
