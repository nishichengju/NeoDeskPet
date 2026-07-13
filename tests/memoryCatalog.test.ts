import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCatalog } from '../electron/memory/memoryCatalog'
import {
  initializeMemoryDatabase,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'

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

  close(): void {
    this.db.close()
  }
}

const databases: NodeDatabaseAdapter[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createHarness(now = 10_000) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  const db = adapter as unknown as MemoryDatabaseHandle
  initializeMemoryDatabase(db, () => 1_000)
  return { db, catalog: new MemoryCatalog(db, { now: () => now }) }
}

let memoryId = 0

function insertMemory(
  db: MemoryDatabaseHandle,
  content: string,
  options: {
    personaId?: string | null
    scope?: 'persona' | 'shared'
    role?: string
    createdAt?: number
    updatedAt?: number
    importance?: number
    strength?: number
    accessCount?: number
    lastAccessedAt?: number | null
    retention?: number
    status?: string
    memoryType?: string
    source?: string | null
    pinned?: number
  } = {},
): number {
  const inserted = db
    .prepare(
      `
      INSERT INTO memory (
        id, persona_id, scope, kind, role, content, created_at, updated_at,
        importance, strength, access_count, last_accessed_at, retention,
        status, memory_type, source, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `catalog-memory-${++memoryId}`,
      options.personaId === undefined ? 'persona-a' : options.personaId,
      options.scope ?? 'persona',
      'manual_note',
      options.role ?? 'note',
      content,
      options.createdAt ?? 1_000,
      options.updatedAt ?? 1_000,
      options.importance ?? 0.5,
      options.strength ?? 0.4,
      options.accessCount ?? 0,
      options.lastAccessedAt ?? null,
      options.retention ?? 1,
      options.status ?? 'active',
      options.memoryType ?? 'semantic',
      options.source === undefined ? 'manual' : options.source,
      options.pinned ?? 0,
    )
  return Number(inserted.lastInsertRowid)
}

describe('MemoryCatalog', () => {
  it('combines scope, role, status, pinned, source, type, and query filters', () => {
    const harness = createHarness()
    const target = insertMemory(harness.db, 'Needle preference', {
      role: 'user',
      status: 'active',
      pinned: 1,
      source: 'manual',
      memoryType: 'preference',
    })
    insertMemory(harness.db, 'Needle shared', { personaId: null, scope: 'shared', role: 'user', pinned: 1 })
    insertMemory(harness.db, 'Needle archived', { role: 'user', status: 'archived', pinned: 1 })
    insertMemory(harness.db, 'Needle deleted', { role: 'user', status: 'deleted', pinned: 1 })
    insertMemory(harness.db, 'Different content', { role: 'user', pinned: 1 })

    expect(
      harness.catalog.list({
        personaId: 'persona-a',
        scope: 'all',
        role: 'user',
        status: 'active',
        pinned: 'pinned',
        source: 'manual',
        memoryType: 'preference',
        query: 'Needle',
      }),
    ).toMatchObject({ total: 1, items: [{ rowid: target, content: 'Needle preference' }] })
    expect(harness.catalog.list({ personaId: 'persona-a', status: 'deleted' })).toMatchObject({
      total: 1,
      items: [{ content: 'Needle deleted' }],
    })
  })

  it('keeps pinned and active records first while computing live retention for returned rows', () => {
    const harness = createHarness(20 * 24 * 60 * 60_000)
    const pinned = insertMemory(harness.db, 'Pinned old', { createdAt: 100, pinned: 1, retention: 1 })
    const active = insertMemory(harness.db, 'Active new', { createdAt: 300, retention: 1 })
    const archived = insertMemory(harness.db, 'Archived middle', {
      createdAt: 200,
      status: 'archived',
      retention: 1,
    })

    const result = harness.catalog.list({
      personaId: 'persona-a',
      status: 'all',
      orderBy: 'createdAt',
      orderDir: 'asc',
    })
    expect(result.items.map((item) => item.rowid)).toEqual([pinned, active, archived])
    expect(result.items[0].retention).toBeLessThan(1)
  })

  it('validates single metadata rowids and clamps editable metadata fields', () => {
    const harness = createHarness(5_000)
    const rowid = insertMemory(harness.db, 'Metadata target')
    const deletedRowid = insertMemory(harness.db, 'Deleted target', { status: 'deleted' })

    expect(() => harness.catalog.updateMeta({ rowid: 0, patch: { pinned: 1 } })).toThrow('rowid 不合法')
    expect(
      harness.catalog.updateMeta({
        rowid,
        patch: {
          pinned: 2,
          importance: 2,
          strength: -1,
          retention: 0.3,
          memoryType: 'x'.repeat(100),
          source: null,
        },
      }),
    ).toEqual({ updated: 1 })
    expect(
      harness.db
        .prepare(
          'SELECT pinned, importance, strength, retention, LENGTH(memory_type) as typeLength, source, updated_at as updatedAt FROM memory WHERE rowid = ?',
        )
        .get(rowid),
    ).toEqual({
      pinned: 1,
      importance: 1,
      strength: 0,
      retention: 0.3,
      typeLength: 80,
      source: null,
      updatedAt: 5_000,
    })
    expect(harness.catalog.updateMeta({ rowid: deletedRowid, patch: { pinned: 1 } })).toEqual({ updated: 0 })
  })

  it('deduplicates bulk metadata rowids and applies filter metadata only to matching records', () => {
    const harness = createHarness(5_000)
    const first = insertMemory(harness.db, 'Group A one', { source: 'group-a' })
    const second = insertMemory(harness.db, 'Group A two', { source: 'group-a' })
    const third = insertMemory(harness.db, 'Group B', { source: 'group-b' })

    expect(harness.catalog.updateManyMeta({ rowids: [0, first, first, second], patch: { pinned: 1 } })).toEqual({
      updated: 2,
    })
    expect(
      harness.catalog.updateByFilterMeta({
        personaId: 'persona-a',
        source: 'group-a',
        patch: { status: 'archived' },
      }),
    ).toEqual({ updated: 2 })
    expect(harness.db.prepare('SELECT status, pinned FROM memory WHERE rowid = ?').get(third)).toEqual({
      status: 'active',
      pinned: 0,
    })
  })

  it('never maps invalid delete rowids to row 1 and supports deduplicated/filter deletion', () => {
    const harness = createHarness()
    const first = insertMemory(harness.db, 'Keep row one', { source: 'keep' })
    const second = insertMemory(harness.db, 'Delete explicit', { source: 'delete' })
    insertMemory(harness.db, 'Delete by filter', { source: 'delete' })

    expect(harness.catalog.delete({ rowid: 0 })).toEqual({ ok: true })
    expect(harness.db.prepare('SELECT content FROM memory WHERE rowid = ?').get(first)).toEqual({ content: 'Keep row one' })
    expect(harness.catalog.deleteMany({ rowids: [0, second, second] })).toEqual({ deleted: 1 })
    expect(harness.catalog.deleteByFilter({ personaId: 'persona-a', source: 'delete' })).toEqual({ deleted: 1 })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory').get()).toEqual({ count: 1 })
  })
})
