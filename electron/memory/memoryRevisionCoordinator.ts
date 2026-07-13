import { randomUUID } from 'node:crypto'
import type {
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryListVersionsArgs,
  MemoryRecord,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryUpdateArgs,
  MemoryVersionRecord,
} from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { MemoryIndexQueue } from './memoryIndexQueue'
import { MemoryRecordStore } from './memoryRecordStore'

export type MemoryRevisionCoordinatorOptions = {
  now?: () => number
  createId?: () => string
}

type MemoryUpdateResult = {
  record: MemoryRecord
  changed: boolean
}

type ConflictResolutionTransactionResult = {
  response: MemoryResolveConflictResult
  indexRowid?: number
}

type ConflictResolutionRow = {
  id: string
  memoryRowid: number
  conflictType: string
  candidateContent: string
  candidateSource: string | null
  candidateImportance: number | null
  candidateStrength: number | null
  candidateMemoryType: string | null
  status: string
  basePersonaId: string | null
  baseScope: string
  baseContent: string
  baseMemoryType: string
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function normalizeForComparison(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, '')
}

export class MemoryRevisionCoordinator {
  private readonly db: MemoryDatabaseHandle
  private readonly indexQueue: MemoryIndexQueue
  private readonly records: MemoryRecordStore
  private readonly now: () => number
  private readonly createId: () => string

  constructor(
    db: MemoryDatabaseHandle,
    indexQueue: MemoryIndexQueue,
    records: MemoryRecordStore,
    options: MemoryRevisionCoordinatorOptions = {},
  ) {
    this.db = db
    this.indexQueue = indexQueue
    this.records = records
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  updateMemory(args: MemoryUpdateArgs): MemoryRecord {
    const timestamp = this.now()
    const transaction = this.db.transaction(() => this.performUpdate(args, timestamp))
    const result = transaction()
    if (result.changed) this.indexQueue.enqueueAll(result.record.rowid)
    return result.record
  }

  listMemoryVersions(args: MemoryListVersionsArgs): MemoryVersionRecord[] {
    const rowid = clampInt(args.rowid, 0, 0, 2_000_000_000)
    const limit = clampInt(args.limit, 50, 1, 200)
    if (rowid <= 0) return []

    return this.db
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
  }

  rollbackMemoryVersion(args: MemoryRollbackVersionArgs): MemoryRecord {
    const versionId = args.versionId.trim()
    if (!versionId) throw new Error('versionId 不能为空')

    const timestamp = this.now()
    const transaction = this.db.transaction(() => {
      const version = this.getVersion(versionId)
      if (!version) throw new Error('版本不存在')
      return this.performUpdate(
        {
          rowid: version.memoryRowid,
          content: version.oldContent,
          reason: `rollback:${versionId}`,
          source: 'rollback',
        },
        timestamp,
      )
    })
    const result = transaction()
    if (result.changed) this.indexQueue.enqueueAll(result.record.rowid)
    return result.record
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
    const whereSql = `WHERE ${where.join(' AND ')}`
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

    const timestamp = this.now()
    const transaction = this.db.transaction(() => {
      const row = this.getConflict(id)
      if (!row) throw new Error('冲突记录不存在')

      if (args.action === 'ignore') {
        this.finalizeConflict(id, 'ignored', timestamp, 'ignore')
        return { response: { ok: true } } satisfies ConflictResolutionTransactionResult
      }

      if (args.action === 'accept') {
        const updated = this.performUpdate(
          {
            rowid: row.memoryRowid,
            content: row.candidateContent,
            reason: `conflict_accept:${id}:${row.conflictType}`,
            source: row.candidateSource ?? 'conflict_accept',
          },
          timestamp,
        )
        this.finalizeConflict(id, 'resolved', timestamp, 'accept')
        return {
          response: { ok: true, updatedRowid: updated.record.rowid },
          ...(updated.changed ? { indexRowid: updated.record.rowid } : {}),
        } satisfies ConflictResolutionTransactionResult
      }

      if (args.action === 'keepBoth') {
        const scope = row.baseScope === 'shared' ? 'shared' : 'persona'
        const personaId = row.basePersonaId ?? 'default'
        const storedPersonaId = scope === 'shared' ? null : personaId
        const importance = clampFloat(row.candidateImportance ?? undefined, 0.75, 0, 1)
        const strength = clampFloat(row.candidateStrength ?? undefined, 0.6, 0, 1)
        const memoryType = (row.candidateMemoryType ?? row.baseMemoryType ?? 'semantic').trim() || 'semantic'
        const source = row.candidateSource ?? 'conflict_keep_both'

        this.db
          .prepare(
            'INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            this.createId(),
            storedPersonaId,
            scope,
            'manual_note',
            'note',
            null,
            null,
            row.candidateContent,
            timestamp,
            timestamp,
            importance,
            strength,
            memoryType,
            source,
          )
        const inserted = this.db.prepare('SELECT rowid as rowid FROM memory WHERE rowid = last_insert_rowid()').get() as
          | { rowid?: number }
          | undefined
        const createdRowid = clampInt(inserted?.rowid, 0, 0, 2_000_000_000)
        if (createdRowid <= 0) throw new Error('新增候选记忆失败')

        this.finalizeConflict(id, 'resolved', timestamp, 'keepBoth')
        return {
          response: { ok: true, createdRowid },
          indexRowid: createdRowid,
        } satisfies ConflictResolutionTransactionResult
      }

      if (args.action === 'merge') {
        const mergedRaw = typeof args.mergedContent === 'string' ? args.mergedContent.trim() : ''
        const merged = mergedRaw || `${row.baseContent.trim()}\n${row.candidateContent.trim()}`.trim()
        const updated = this.performUpdate(
          {
            rowid: row.memoryRowid,
            content: merged,
            reason: `conflict_merge:${id}:${row.conflictType}`,
            source: row.candidateSource ?? 'conflict_merge',
          },
          timestamp,
        )
        this.finalizeConflict(id, 'resolved', timestamp, 'merge')
        return {
          response: { ok: true, updatedRowid: updated.record.rowid },
          ...(updated.changed ? { indexRowid: updated.record.rowid } : {}),
        } satisfies ConflictResolutionTransactionResult
      }

      throw new Error('未知 action')
    })

    const result = transaction()
    if (result.indexRowid) this.indexQueue.enqueueAll(result.indexRowid)
    return result.response
  }

  private performUpdate(args: MemoryUpdateArgs, timestamp: number): MemoryUpdateResult {
    const rowid = clampInt(args.rowid, 0, 0, 2_000_000_000)
    if (rowid <= 0) throw new Error('rowid 不合法')
    const content = args.content.trim()
    if (!content) throw new Error('内容不能为空')

    const current = this.records.getByRowid(rowid)
    if (!current) throw new Error('记录不存在')
    if (normalizeForComparison(content) === normalizeForComparison(current.content)) {
      return { record: current, changed: false }
    }

    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual_edit'
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : null
    this.records.addVersion({
      memoryRowid: rowid,
      oldContent: current.content,
      newContent: content,
      reason,
      source,
      createdAt: timestamp,
    })
    this.db
      .prepare(
        "UPDATE memory SET content = ?, updated_at = ?, strength = MIN(1, strength + 0.05), retention = 1, status = 'active' WHERE rowid = ?",
      )
      .run(content, timestamp, rowid)
    const updated = this.records.getByRowid(rowid)
    if (!updated) throw new Error('记录不存在')
    return { record: updated, changed: true }
  }

  private getVersion(versionId: string): MemoryVersionRecord | null {
    const version = this.db
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
    return version ?? null
  }

  private getConflict(id: string): ConflictResolutionRow | null {
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
      .get(id) as ConflictResolutionRow | undefined
    return row ?? null
  }

  private finalizeConflict(
    id: string,
    status: 'resolved' | 'ignored',
    timestamp: number,
    resolution: string,
  ): void {
    this.db
      .prepare('UPDATE memory_conflict SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?')
      .run(status, timestamp, resolution, id)
  }
}
