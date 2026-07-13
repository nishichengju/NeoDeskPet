import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeMemoryDatabase,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'
import { MemoryRecordStore } from '../electron/memory/memoryRecordStore'
import { MemoryRevisionCoordinator } from '../electron/memory/memoryRevisionCoordinator'

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

function createHarness() {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  const db = adapter as unknown as MemoryDatabaseHandle
  initializeMemoryDatabase(db, () => 1_000)
  let id = 0
  const createId = () => `revision-id-${++id}`
  const now = () => 5_000
  const queue = new MemoryIndexQueue()
  const records = new MemoryRecordStore(db, { now, createId })
  const coordinator = new MemoryRevisionCoordinator(db, queue, records, { now, createId })
  return { db, queue, coordinator }
}

let seedId = 0

function insertMemory(
  db: MemoryDatabaseHandle,
  content: string,
  options: {
    personaId?: string | null
    scope?: 'persona' | 'shared'
    status?: string
    strength?: number
    memoryType?: string
  } = {},
): number {
  const inserted = db
    .prepare(
      `
      INSERT INTO memory (
        id, persona_id, scope, kind, role, session_id, message_id, content,
        created_at, updated_at, importance, strength, memory_type, source, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `revision-seed-${++seedId}`,
      options.personaId === undefined ? 'persona-a' : options.personaId,
      options.scope ?? 'persona',
      'manual_note',
      'note',
      null,
      null,
      content,
      1_000,
      1_000,
      0.5,
      options.strength ?? 0.4,
      options.memoryType ?? 'semantic',
      'seed',
      options.status ?? 'active',
    )
  return Number(inserted.lastInsertRowid)
}

function insertVersion(
  db: MemoryDatabaseHandle,
  id: string,
  rowid: number,
  oldContent: string,
  newContent: string,
  createdAt: number,
): void {
  db.prepare(
    'INSERT INTO memory_version (id, memory_rowid, old_content, new_content, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, rowid, oldContent, newContent, 'manual_edit', 'seed', createdAt)
}

function insertConflict(
  db: MemoryDatabaseHandle,
  id: string,
  rowid: number,
  candidateContent: string,
  options: {
    status?: string
    createdAt?: number
    conflictType?: string
    source?: string | null
    importance?: number | null
    strength?: number | null
    memoryType?: string | null
  } = {},
): void {
  db.prepare(
    `
    INSERT INTO memory_conflict (
      id, memory_rowid, conflict_type, candidate_content, candidate_source,
      candidate_importance, candidate_strength, candidate_memory_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    rowid,
    options.conflictType ?? 'conflict',
    candidateContent,
    options.source ?? null,
    options.importance ?? null,
    options.strength ?? null,
    options.memoryType ?? null,
    options.status ?? 'open',
    options.createdAt ?? 1_000,
  )
}

function expectAllIndexesQueued(queue: MemoryIndexQueue, rowid: number): void {
  expect(queue.take('tag', 10)).toEqual([rowid])
  expect(queue.take('embedding', 10)).toEqual([rowid])
  expect(queue.take('kg', 10)).toEqual([rowid])
}

function expectNoIndexesQueued(queue: MemoryIndexQueue): void {
  expect(queue.take('tag', 10)).toEqual([])
  expect(queue.take('embedding', 10)).toEqual([])
  expect(queue.take('kg', 10)).toEqual([])
}

describe('MemoryRevisionCoordinator', () => {
  it('rejects invalid rowids, skips normalized no-op edits, and versions real updates atomically', () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, '原始内容', { status: 'archived', strength: 0.4 })

    expect(() => harness.coordinator.updateMemory({ rowid: 0, content: '不能改第一条' })).toThrow('rowid 不合法')
    expect(harness.db.prepare('SELECT content FROM memory WHERE rowid = ?').get(rowid)).toEqual({ content: '原始内容' })

    expect(harness.coordinator.updateMemory({ rowid, content: ' 原始内容 ' })).toMatchObject({ rowid, content: '原始内容' })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory_version').get()).toEqual({ count: 0 })
    expectNoIndexesQueued(harness.queue)

    const updated = harness.coordinator.updateMemory({
      rowid,
      content: '更新内容',
      reason: 'review_edit',
      source: 'memory_console',
    })
    expect(updated).toMatchObject({ rowid, content: '更新内容', status: 'active', strength: 0.45 })
    expect(
      harness.db
        .prepare('SELECT old_content as oldContent, new_content as newContent, reason, source FROM memory_version')
        .get(),
    ).toEqual({
      oldContent: '原始内容',
      newContent: '更新内容',
      reason: 'review_edit',
      source: 'memory_console',
    })
    expectAllIndexesQueued(harness.queue, rowid)
  })

  it('lists bounded versions and rolls a record back while preserving a new audit version', () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, '当前内容')
    insertVersion(harness.db, 'version-old', rowid, '最初内容', '当前内容', 100)
    insertVersion(harness.db, 'version-newer', rowid, '中间内容', '当前内容', 200)

    expect(harness.coordinator.listMemoryVersions({ rowid: 0 })).toEqual([])
    expect(harness.coordinator.listMemoryVersions({ rowid, limit: 1 })).toMatchObject([
      { id: 'version-newer', createdAt: 200 },
    ])

    const rolledBack = harness.coordinator.rollbackMemoryVersion({ versionId: 'version-old' })
    expect(rolledBack).toMatchObject({ rowid, content: '最初内容' })
    expect(
      harness.db
        .prepare(
          "SELECT old_content as oldContent, new_content as newContent, reason, source FROM memory_version WHERE reason LIKE 'rollback:%'",
        )
        .get(),
    ).toEqual({
      oldContent: '当前内容',
      newContent: '最初内容',
      reason: 'rollback:version-old',
      source: 'rollback',
    })
    expectAllIndexesQueued(harness.queue, rowid)
  })

  it('filters conflicts by persona/shared scope and status while excluding deleted base memories', () => {
    const harness = createHarness()
    const personaRowid = insertMemory(harness.db, 'Persona base')
    const sharedRowid = insertMemory(harness.db, 'Shared base', { personaId: null, scope: 'shared' })
    const otherRowid = insertMemory(harness.db, 'Other base', { personaId: 'persona-b' })
    const deletedRowid = insertMemory(harness.db, 'Deleted base', { status: 'deleted' })
    insertConflict(harness.db, 'persona-open', personaRowid, 'Persona candidate', { createdAt: 100 })
    insertConflict(harness.db, 'shared-open', sharedRowid, 'Shared candidate', { createdAt: 200 })
    insertConflict(harness.db, 'other-open', otherRowid, 'Other candidate', { createdAt: 300 })
    insertConflict(harness.db, 'deleted-open', deletedRowid, 'Deleted candidate', { createdAt: 400 })
    insertConflict(harness.db, 'persona-resolved', personaRowid, 'Resolved candidate', {
      createdAt: 500,
      status: 'resolved',
    })

    expect(
      harness.coordinator.listMemoryConflicts({
        personaId: 'persona-a',
        scope: 'all',
        status: 'open',
        limit: 1,
        offset: 1,
      }),
    ).toMatchObject({ total: 2, items: [{ id: 'persona-open', baseScope: 'persona' }] })
    expect(
      harness.coordinator.listMemoryConflicts({ personaId: 'persona-a', scope: 'shared', status: 'all' }),
    ).toMatchObject({ total: 1, items: [{ id: 'shared-open', baseScope: 'shared' }] })
  })

  it('handles ignore, accept, and default merge resolutions with the expected audit records', () => {
    const harness = createHarness()
    const ignoreRowid = insertMemory(harness.db, 'Ignore base')
    const acceptRowid = insertMemory(harness.db, 'Accept base')
    const mergeRowid = insertMemory(harness.db, 'Merge base')
    insertConflict(harness.db, 'ignore-id', ignoreRowid, 'Ignore candidate')
    insertConflict(harness.db, 'accept-id', acceptRowid, 'Accepted candidate', {
      conflictType: 'update',
      source: 'auto_extract',
    })
    insertConflict(harness.db, 'merge-id', mergeRowid, 'Merge candidate', { conflictType: 'merge' })

    expect(harness.coordinator.resolveMemoryConflict({ id: 'ignore-id', action: 'ignore' })).toEqual({ ok: true })
    expect(harness.db.prepare('SELECT status, resolution FROM memory_conflict WHERE id = ?').get('ignore-id')).toEqual({
      status: 'ignored',
      resolution: 'ignore',
    })
    expectNoIndexesQueued(harness.queue)

    expect(harness.coordinator.resolveMemoryConflict({ id: 'accept-id', action: 'accept' })).toEqual({
      ok: true,
      updatedRowid: acceptRowid,
    })
    expect(harness.db.prepare('SELECT content FROM memory WHERE rowid = ?').get(acceptRowid)).toEqual({
      content: 'Accepted candidate',
    })
    expectAllIndexesQueued(harness.queue, acceptRowid)

    expect(harness.coordinator.resolveMemoryConflict({ id: 'merge-id', action: 'merge' })).toEqual({
      ok: true,
      updatedRowid: mergeRowid,
    })
    expect(harness.db.prepare('SELECT content FROM memory WHERE rowid = ?').get(mergeRowid)).toEqual({
      content: 'Merge base\nMerge candidate',
    })
    expectAllIndexesQueued(harness.queue, mergeRowid)
    expect(
      harness.db.prepare('SELECT reason FROM memory_version ORDER BY memory_rowid').all(),
    ).toEqual([{ reason: 'conflict_accept:accept-id:update' }, { reason: 'conflict_merge:merge-id:merge' }])
  })

  it('keeps both conflict values with clamped metadata and queues the new shared record', () => {
    const harness = createHarness()
    const baseRowid = insertMemory(harness.db, 'Shared base', {
      personaId: null,
      scope: 'shared',
      memoryType: 'profile',
    })
    insertConflict(harness.db, 'keep-both-id', baseRowid, 'Shared candidate', {
      importance: 2,
      strength: -1,
      memoryType: 'preference',
    })

    const result = harness.coordinator.resolveMemoryConflict({ id: 'keep-both-id', action: 'keepBoth' })
    expect(result.ok).toBe(true)
    expect(result.createdRowid).toBeGreaterThan(baseRowid)
    expect(
      harness.db
        .prepare(
          'SELECT persona_id as personaId, scope, content, importance, strength, memory_type as memoryType, source FROM memory WHERE rowid = ?',
        )
        .get(result.createdRowid),
    ).toEqual({
      personaId: null,
      scope: 'shared',
      content: 'Shared candidate',
      importance: 1,
      strength: 0,
      memoryType: 'preference',
      source: 'conflict_keep_both',
    })
    expect(harness.db.prepare('SELECT status, resolution FROM memory_conflict WHERE id = ?').get('keep-both-id')).toEqual({
      status: 'resolved',
      resolution: 'keepBoth',
    })
    expectAllIndexesQueued(harness.queue, result.createdRowid as number)
  })

  it('rolls back memory and version changes when conflict finalization fails', () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, 'Atomic base')
    insertConflict(harness.db, 'atomic-id', rowid, 'Atomic candidate', { source: 'auto_extract' })
    harness.db.exec(`
      CREATE TRIGGER fail_conflict_finalize
      BEFORE UPDATE ON memory_conflict
      WHEN NEW.status = 'resolved'
      BEGIN
        SELECT RAISE(ABORT, 'finalize failed');
      END;
    `)

    expect(() => harness.coordinator.resolveMemoryConflict({ id: 'atomic-id', action: 'accept' })).toThrow(
      /finalize failed/,
    )
    expect(harness.db.prepare('SELECT content FROM memory WHERE rowid = ?').get(rowid)).toEqual({ content: 'Atomic base' })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory_version').get()).toEqual({ count: 0 })
    expect(harness.db.prepare('SELECT status, resolution FROM memory_conflict WHERE id = ?').get('atomic-id')).toEqual({
      status: 'open',
      resolution: null,
    })
    expectNoIndexesQueued(harness.queue)
  })
})
