import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryDatabaseHandle } from '../electron/memory/memoryDatabase'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'
import { MemoryTagIndexMaintainer, extractMemoryTags } from '../electron/memory/memoryTagIndex'
import type { MemorySettings } from '../electron/types'

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

function createHarness(now = () => 1234) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  adapter.exec(`
    CREATE TABLE memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_tag (
      memory_rowid INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(memory_rowid, tag_id)
    );
  `)
  const db = adapter as unknown as MemoryDatabaseHandle
  const queue = new MemoryIndexQueue()
  const maintainer = new MemoryTagIndexMaintainer(db, queue, now)
  return { db, queue, maintainer }
}

function memoryTags(db: MemoryDatabaseHandle, rowid: number): string[] {
  return (
    db
      .prepare(
        'SELECT t.name as name FROM memory_tag mt JOIN tag t ON t.id = mt.tag_id WHERE mt.memory_rowid = ? ORDER BY t.name',
      )
      .all(rowid) as Array<{ name: string }>
  ).map((row) => row.name)
}

describe('MemoryTagIndexMaintainer', () => {
  it('extracts stable English and Chinese tags with limits and stop words', () => {
    expect(extractMemoryTags('Alpha ALPHA beta')).toEqual(['alpha', 'beta'])
    expect(extractMemoryTags('我还记得上海咖啡店', { maxTags: 4 })).toEqual([
      '我还记得',
      '还记得上',
      '记得上海',
      '得上海咖',
    ])
  })

  it('replaces tags for pending rows inside one transaction', () => {
    const { db, queue, maintainer } = createHarness(() => 9000)
    const inserted = db.prepare('INSERT INTO memory (content, updated_at) VALUES (?, ?)').run('Alpha beta', 100)
    const rowid = Number(inserted.lastInsertRowid)
    db.prepare('INSERT INTO tag (name, created_at) VALUES (?, ?)').run('old-tag', 1)
    db.prepare('INSERT INTO memory_tag (memory_rowid, tag_id, created_at) VALUES (?, ?, ?)').run(rowid, 1, 1)
    queue.enqueue('tag', rowid)

    expect(maintainer.run({ tagEnabled: true } as MemorySettings, { batchSize: 10 })).toEqual({
      scanned: 1,
      updated: 1,
    })
    expect(memoryTags(db, rowid)).toEqual(['alpha', 'beta'])
    expect(db.prepare('SELECT created_at as createdAt FROM memory_tag WHERE memory_rowid = ? LIMIT 1').get(rowid)).toEqual({
      createdAt: 9000,
    })
  })

  it('fills the batch with unique sweep rows and preserves pending work while disabled', () => {
    const { db, queue, maintainer } = createHarness()
    const insert = db.prepare('INSERT INTO memory (content, status, updated_at) VALUES (?, ?, ?)')
    const first = Number(insert.run('First memory', 'active', 30).lastInsertRowid)
    const second = Number(insert.run('Second memory', 'active', 20).lastInsertRowid)
    const deleted = Number(insert.run('Deleted memory', 'deleted', 10).lastInsertRowid)
    queue.enqueue('tag', first)
    queue.enqueue('tag', deleted)

    expect(maintainer.run({ tagEnabled: false } as MemorySettings, { batchSize: 10 })).toEqual({
      scanned: 0,
      updated: 0,
    })
    expect(maintainer.run({ tagEnabled: true } as MemorySettings, { batchSize: 10 })).toEqual({
      scanned: 2,
      updated: 2,
    })
    expect(memoryTags(db, first).length).toBeGreaterThan(0)
    expect(memoryTags(db, second).length).toBeGreaterThan(0)
    expect(memoryTags(db, deleted)).toEqual([])
  })
})
