import { randomUUID } from 'node:crypto'
import type { MemoryRecord } from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { computeMemoryRetentionScore } from './memoryRetrieval'

export type AddMemoryVersionArgs = {
  memoryRowid: number
  oldContent: string
  newContent: string
  reason: string
  source: string | null
  createdAt: number
}

export type MemoryRecordStoreOptions = {
  now?: () => number
  createId?: () => string
}

export class MemoryRecordStore {
  private readonly db: MemoryDatabaseHandle
  private readonly now: () => number
  private readonly createId: () => string

  constructor(db: MemoryDatabaseHandle, options: MemoryRecordStoreOptions = {}) {
    this.db = db
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  getByRowid(rowid: number): MemoryRecord | null {
    const record = this.db
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

    if (!record) return null
    record.retention = computeMemoryRetentionScore(
      this.now(),
      record.createdAt,
      record.lastAccessedAt,
      record.strength,
    )
    return record
  }

  addVersion(args: AddMemoryVersionArgs): void {
    const reason = args.reason.trim() || 'manual_edit'
    this.db
      .prepare(
        'INSERT INTO memory_version (id, memory_rowid, old_content, new_content, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.createId(),
        args.memoryRowid,
        args.oldContent,
        args.newContent,
        reason,
        args.source,
        args.createdAt,
      )
  }
}
