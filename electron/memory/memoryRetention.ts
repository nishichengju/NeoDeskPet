import type { MemoryDatabaseHandle } from './memoryDatabase'
import { computeMemoryRetentionScore } from './memoryRetrieval'

export type MemoryRetentionMaintenanceOptions = {
  batchSize?: number
  minIdleMs?: number
  archiveThreshold?: number
}

export type MemoryRetentionMaintenanceResult = {
  scanned: number
  updated: number
  archived: number
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

export class MemoryRetentionMaintainer {
  private readonly db: MemoryDatabaseHandle
  private readonly now: () => number

  constructor(db: MemoryDatabaseHandle, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  run(options: MemoryRetentionMaintenanceOptions = {}): MemoryRetentionMaintenanceResult {
    const timestamp = this.now()
    const batchSize = clampInt(options.batchSize, 400, 50, 5_000)
    const minIdleMs = clampInt(options.minIdleMs, 6 * 60 * 60_000, 0, 30 * 24 * 60 * 60_000)
    const archiveThreshold = clampFloat(options.archiveThreshold, 0.05, 0, 1)
    const idleBefore = timestamp - minIdleMs
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
    for (const row of rows) {
      const retention = computeMemoryRetentionScore(timestamp, row.createdAt, row.lastAccessedAt, row.strength)
      const currentStatus = (row.status ?? 'active').trim() || 'active'
      let nextStatus = currentStatus
      if ((row.pinned ?? 0) !== 0) {
        nextStatus = 'active'
      } else if (retention < archiveThreshold) {
        nextStatus = 'archived'
      }

      const previousRetention = clampFloat(row.storedRetention, retention, 0, 1)
      if (Math.abs(retention - previousRetention) < 0.02 && nextStatus === currentStatus) continue
      if (currentStatus !== 'archived' && nextStatus === 'archived') archived += 1
      updates.push({ rowid: row.rowid, retention, status: nextStatus })
    }

    if (updates.length === 0) return { scanned: rows.length, updated: 0, archived: 0 }
    const transaction = this.db.transaction((items: Array<{ rowid: number; retention: number; status: string }>) => {
      const statement = this.db.prepare('UPDATE memory SET retention = ?, status = ? WHERE rowid = ?')
      for (const item of items) statement.run(item.retention, item.status, item.rowid)
    })
    transaction(updates)
    return { scanned: rows.length, updated: updates.length, archived }
  }
}
