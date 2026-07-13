import type {
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  MemoryFilterArgs,
  MemoryListArgs,
  MemoryListResult,
  MemoryMetaPatch,
  MemoryOrderBy,
  MemoryRecord,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
} from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { computeMemoryRetentionScore } from './memoryRetrieval'

export type MemoryCatalogOptions = {
  now?: () => number
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

export class MemoryCatalog {
  private readonly db: MemoryDatabaseHandle
  private readonly now: () => number

  constructor(db: MemoryDatabaseHandle, options: MemoryCatalogOptions = {}) {
    this.db = db
    this.now = options.now ?? Date.now
  }

  list(args: MemoryListArgs): MemoryListResult {
    const limit = clampInt(args.limit, 50, 1, 200)
    const offset = clampInt(args.offset, 0, 0, 1_000_000)
    const { whereSql, params } = this.buildWhere(args)
    const orderBySql = this.buildOrderBy(args.orderBy, args.orderDir)
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

    const timestamp = this.now()
    for (const item of items) {
      item.retention = computeMemoryRetentionScore(
        timestamp,
        item.createdAt,
        item.lastAccessedAt,
        item.strength,
      )
    }
    return { total, items }
  }

  updateMeta(args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult {
    const rowid = clampInt(args.rowid, 0, 0, 2_000_000_000)
    if (rowid <= 0) throw new Error('rowid 不合法')

    const built = this.buildMetaSet(args.patch ?? ({} as MemoryMetaPatch))
    if (!built.setSql) return { updated: 0 }
    const result = this.db
      .prepare(`UPDATE memory SET ${built.setSql} WHERE rowid = ? AND COALESCE(status, 'active') <> 'deleted'`)
      .run(...built.params, rowid)
    return { updated: result.changes }
  }

  updateManyMeta(args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult {
    const rowids = this.normalizeRowids(args.rowids)
    if (rowids.length === 0) return { updated: 0 }

    const built = this.buildMetaSet(args.patch ?? ({} as MemoryMetaPatch))
    if (!built.setSql) return { updated: 0 }
    const placeholders = rowids.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE memory SET ${built.setSql} WHERE rowid IN (${placeholders}) AND COALESCE(status, 'active') <> 'deleted'`,
      )
      .run(...built.params, ...rowids)
    return { updated: result.changes }
  }

  updateByFilterMeta(args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult {
    const built = this.buildMetaSet(args.patch ?? ({} as MemoryMetaPatch))
    if (!built.setSql) return { updated: 0 }

    const { whereSql, params } = this.buildWhere(args)
    const result = this.db.prepare(`UPDATE memory SET ${built.setSql} ${whereSql}`).run(...built.params, ...params)
    return { updated: result.changes }
  }

  delete(args: MemoryDeleteArgs): { ok: true } {
    const rowid = clampInt(args.rowid, 0, 0, 2_000_000_000)
    if (rowid > 0) this.db.prepare('DELETE FROM memory WHERE rowid = ?').run(rowid)
    return { ok: true }
  }

  deleteMany(args: MemoryDeleteManyArgs): { deleted: number } {
    const rowids = this.normalizeRowids(args.rowids)
    if (rowids.length === 0) return { deleted: 0 }

    const placeholders = rowids.map(() => '?').join(',')
    const result = this.db.prepare(`DELETE FROM memory WHERE rowid IN (${placeholders})`).run(...rowids)
    return { deleted: result.changes }
  }

  deleteByFilter(args: MemoryDeleteByFilterArgs): { deleted: number } {
    const { whereSql, params } = this.buildWhere(args)
    const result = this.db.prepare(`DELETE FROM memory ${whereSql}`).run(...params)
    return { deleted: result.changes }
  }

  private buildWhere(args: MemoryFilterArgs): { whereSql: string; params: Array<string | number> } {
    const personaId = args.personaId.trim() || 'default'
    const scope = args.scope ?? 'persona'
    const role = args.role ?? 'all'
    const query = (args.query ?? '').trim()
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
    if (query) {
      where.push('content LIKE ?')
      params.push(`%${query.slice(0, 200)}%`)
    }
    return { whereSql: `WHERE ${where.join(' AND ')}`, params }
  }

  private buildOrderBy(orderBy: MemoryOrderBy | undefined, orderDir: 'asc' | 'desc' | undefined): string {
    const direction = orderDir === 'asc' ? 'ASC' : 'DESC'
    const pinnedSql = 'pinned DESC'
    const statusSql = "CASE WHEN status = 'archived' THEN 1 WHEN status = 'deleted' THEN 2 ELSE 0 END ASC"
    const selected: MemoryOrderBy =
      orderBy === 'updatedAt' ||
      orderBy === 'retention' ||
      orderBy === 'importance' ||
      orderBy === 'strength' ||
      orderBy === 'accessCount' ||
      orderBy === 'lastAccessedAt' ||
      orderBy === 'createdAt'
        ? orderBy
        : 'createdAt'

    if (selected === 'lastAccessedAt') {
      return `${pinnedSql}, ${statusSql}, (last_accessed_at IS NULL) ASC, last_accessed_at ${direction}, rowid DESC`
    }

    const column =
      selected === 'updatedAt'
        ? 'updated_at'
        : selected === 'retention'
          ? 'retention'
          : selected === 'importance'
            ? 'importance'
            : selected === 'strength'
              ? 'strength'
              : selected === 'accessCount'
                ? 'access_count'
                : 'created_at'
    return `${pinnedSql}, ${statusSql}, ${column} ${direction}, rowid DESC`
  }

  private buildMetaSet(patch: MemoryMetaPatch): { setSql: string; params: Array<string | number | null> } {
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

    sets.push('updated_at = ?')
    params.push(this.now())
    return { setSql: sets.join(', '), params }
  }

  private normalizeRowids(values: number[]): number[] {
    return Array.from(
      new Set((values ?? []).map((value) => clampInt(value, 0, 0, 2_000_000_000)).filter((value) => value > 0)),
    )
  }
}
