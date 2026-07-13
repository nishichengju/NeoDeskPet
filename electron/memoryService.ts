import { randomUUID } from 'node:crypto'
import { openMemoryDatabase, type MemoryDatabaseHandle } from './memory/memoryDatabase'
import { MemoryEmbeddingClient } from './memory/memoryEmbeddingClient'
import { MemoryIndexQueue } from './memory/memoryIndexQueue'
import { MemoryKgIndexMaintainer } from './memory/memoryKgIndex'
import { computeMemoryRetentionScore, MemoryRetrievalEngine } from './memory/memoryRetrieval'
import { MemoryRecordStore } from './memory/memoryRecordStore'
import { MemoryTagIndexMaintainer } from './memory/memoryTagIndex'
import { MemoryVectorIndexMaintainer } from './memory/memoryVectorIndex'
import { MemoryVectorSearchClient } from './memory/memoryVectorSearchClient'
import {
  MemoryWriteCoordinator,
  type MemoryIngestChatMessageArgs,
} from './memory/memoryWriteCoordinator'
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

export type { MemoryIngestChatMessageArgs } from './memory/memoryWriteCoordinator'

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

export class MemoryService {
  private db: MemoryDatabaseHandle
  private indexQueue = new MemoryIndexQueue()
  private embeddingClient = new MemoryEmbeddingClient()
  private kgIndexMaintainer: MemoryKgIndexMaintainer
  private recordStore: MemoryRecordStore
  private tagIndexMaintainer: MemoryTagIndexMaintainer
  private vectorIndexMaintainer: MemoryVectorIndexMaintainer
  private retrievalEngine: MemoryRetrievalEngine
  private vectorSearchClient: MemoryVectorSearchClient
  private writeCoordinator: MemoryWriteCoordinator

  constructor(userDataDir: string) {
    const opened = openMemoryDatabase(userDataDir)
    this.db = opened.db
    this.kgIndexMaintainer = new MemoryKgIndexMaintainer(opened.db, this.indexQueue)
    this.recordStore = new MemoryRecordStore(opened.db)
    this.tagIndexMaintainer = new MemoryTagIndexMaintainer(opened.db, this.indexQueue)
    this.vectorIndexMaintainer = new MemoryVectorIndexMaintainer(opened.db, this.indexQueue, this.embeddingClient)
    this.vectorSearchClient = new MemoryVectorSearchClient(opened.dbPath)
    this.retrievalEngine = new MemoryRetrievalEngine(
      opened.db,
      this.embeddingClient,
      this.vectorSearchClient,
      (personaId) => this.getPersona(personaId),
    )
    this.writeCoordinator = new MemoryWriteCoordinator(
      opened.db,
      this.indexQueue,
      this.embeddingClient,
      (personaId) => this.getPersona(personaId),
      this.recordStore,
    )
  }

  close(): void {
    this.vectorSearchClient.close()
    this.db.close()
  }

  /** 注册"有新索引工作入队"的通知回调（debounce 由调用方负责） */
  setMaintenanceKick(cb: (() => void) | null): void {
    this.indexQueue.setKick(cb)
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

  async ingestChatMessage(
    args: MemoryIngestChatMessageArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<void> {
    return this.writeCoordinator.ingestChatMessage(args, memSettings, aiSettings)
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

  async upsertManualMemory(
    args: MemoryUpsertManualArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<MemoryRecord> {
    return this.writeCoordinator.upsertManualMemory(args, memSettings, aiSettings)
  }

  updateMemory(args: MemoryUpdateArgs): MemoryRecord {
    const rowid = clampInt(args.rowid, 0, 1, 2_000_000_000)
    const content = args.content.trim()
    if (!content) throw new Error('内容不能为空')

    const current = this.recordStore.getByRowid(rowid)
    if (!current) throw new Error('记录不存在')

    const nextNormalized = normalizeMemoryText(content)
    const currentNormalized = normalizeMemoryText(current.content)
    if (nextNormalized.replace(/\s+/g, '') === currentNormalized.replace(/\s+/g, '')) {
      return current
    }

    const ts = now()
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual_edit'
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : null

    this.recordStore.addVersion({
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
    const updated = this.recordStore.getByRowid(rowid)
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
