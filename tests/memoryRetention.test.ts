import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeMemoryDatabase,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'
import { computeMemoryRetentionScore } from '../electron/memory/memoryRetrieval'
import { MemoryRetentionMaintainer } from '../electron/memory/memoryRetention'

type NodeStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[]
  get: (...params: unknown[]) => Record<string, unknown> | undefined
  run: (...params: unknown[]) => unknown
}

type NodeDatabase = {
  exec: (source: string) => void
  prepare: (source: string) => NodeStatement
  close: () => void
}

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (file: string) => NodeDatabase
}

class NodeDatabaseAdapter {
  private readonly db = new DatabaseSync(':memory:')

  exec(source: string): void {
    this.db.exec(source)
  }

  prepare(source: string): ReturnType<MemoryDatabaseHandle['prepare']> {
    return this.db.prepare(source) as unknown as ReturnType<MemoryDatabaseHandle['prepare']>
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args) => {
      this.db.exec('BEGIN')
      try {
        const result = fn(...args)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

const databases: NodeDatabaseAdapter[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createHarness(now: number) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  const db = adapter as unknown as MemoryDatabaseHandle
  initializeMemoryDatabase(db, () => 1_000)
  return { db, maintainer: new MemoryRetentionMaintainer(db, () => now) }
}

let memoryId = 0

function insertMemory(
  db: MemoryDatabaseHandle,
  options: {
    createdAt: number
    lastAccessedAt?: number | null
    strength?: number
    retention?: number
    status?: string
    pinned?: number
  },
): number {
  const inserted = db
    .prepare(
      `
      INSERT INTO memory (
        id, persona_id, scope, kind, role, content, created_at, updated_at,
        strength, last_accessed_at, retention, status, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `retention-memory-${++memoryId}`,
      'persona-a',
      'persona',
      'manual_note',
      'note',
      `Retention ${memoryId}`,
      options.createdAt,
      options.createdAt,
      options.strength ?? 0,
      options.lastAccessedAt ?? null,
      options.retention ?? 1,
      options.status ?? 'active',
      options.pinned ?? 0,
    )
  return Number(inserted.lastInsertRowid)
}

describe('MemoryRetentionMaintainer', () => {
  it('archives weak old memories, reactivates pinned rows, and skips deleted rows', () => {
    const day = 24 * 60 * 60_000
    const now = 120 * day
    const harness = createHarness(now)
    const oldRowid = insertMemory(harness.db, { createdAt: 0, strength: 0, retention: 1 })
    const pinnedRowid = insertMemory(harness.db, {
      createdAt: 0,
      strength: 0,
      retention: 1,
      status: 'archived',
      pinned: 1,
    })
    insertMemory(harness.db, { createdAt: 0, status: 'deleted' })

    expect(harness.maintainer.run({ minIdleMs: 0, archiveThreshold: 0.5 })).toEqual({
      scanned: 2,
      updated: 2,
      archived: 1,
    })
    expect(harness.db.prepare('SELECT status FROM memory WHERE rowid = ?').get(oldRowid)).toEqual({ status: 'archived' })
    expect(harness.db.prepare('SELECT status FROM memory WHERE rowid = ?').get(pinnedRowid)).toEqual({ status: 'active' })
  })

  it('skips writes when stored retention and status are already current', () => {
    const day = 24 * 60 * 60_000
    const now = 10 * day
    const harness = createHarness(now)
    const retention = computeMemoryRetentionScore(now, 0, null, 0.4)
    insertMemory(harness.db, { createdAt: 0, strength: 0.4, retention })

    expect(harness.maintainer.run({ minIdleMs: 0, archiveThreshold: 0 })).toEqual({
      scanned: 1,
      updated: 0,
      archived: 0,
    })
  })

  it('rolls back the whole retention batch when one row update fails', () => {
    const day = 24 * 60 * 60_000
    const now = 120 * day
    const harness = createHarness(now)
    const first = insertMemory(harness.db, { createdAt: 0, retention: 1 })
    const second = insertMemory(harness.db, { createdAt: 1, retention: 1 })
    harness.db.exec(`
      CREATE TRIGGER fail_second_retention_update
      BEFORE UPDATE ON memory
      WHEN OLD.rowid = ${second}
      BEGIN
        SELECT RAISE(ABORT, 'retention update failed');
      END;
    `)

    expect(() => harness.maintainer.run({ minIdleMs: 0, archiveThreshold: 0.5 })).toThrow(
      /retention update failed/,
    )
    expect(harness.db.prepare('SELECT retention, status FROM memory WHERE rowid = ?').get(first)).toEqual({
      retention: 1,
      status: 'active',
    })
    expect(harness.db.prepare('SELECT retention, status FROM memory WHERE rowid = ?').get(second)).toEqual({
      retention: 1,
      status: 'active',
    })
  })
})
