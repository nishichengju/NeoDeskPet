import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeMemoryDatabase,
  openMemoryDatabase,
  type MemoryDatabaseConstructor,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'

const tempDirs: string[] = []

type NodeSqliteStatement = {
  get: (...params: unknown[]) => Record<string, unknown> | undefined
}

type NodeSqliteDatabase = {
  exec: (source: string) => void
  prepare: (source: string) => NodeSqliteStatement
  close: () => void
}

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (file: string) => NodeSqliteDatabase
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neodeskpet-memory-db-'))
  tempDirs.push(dir)
  return dir
}

class NodeSqliteDatabaseAdapter {
  private readonly db: NodeSqliteDatabase

  constructor(file: string) {
    this.db = new DatabaseSync(file)
  }

  exec(source: string): void {
    this.db.exec(source)
  }

  prepare(source: string): ReturnType<MemoryDatabaseHandle['prepare']> {
    return this.db.prepare(source) as unknown as ReturnType<MemoryDatabaseHandle['prepare']>
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (source.includes('=')) {
      this.db.exec(`PRAGMA ${source}`)
      return undefined
    }
    const row = this.db.prepare(`PRAGMA ${source}`).get() as Record<string, unknown> | undefined
    if (options?.simple) return row ? Object.values(row)[0] : undefined
    return row ? [row] : []
  }

  close(): void {
    this.db.close()
  }
}

const nodeSqliteConstructor = NodeSqliteDatabaseAdapter as unknown as MemoryDatabaseConstructor

function openTestMemoryDatabase(dir: string, now: () => number = Date.now) {
  return openMemoryDatabase(dir, { now, databaseConstructor: nodeSqliteConstructor })
}

function schemaNames(db: MemoryDatabaseHandle, type: string): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function tableColumns(db: MemoryDatabaseHandle, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function ftsRowids(db: MemoryDatabaseHandle, table: 'memory_fts' | 'kg_entity_fts', query: string): number[] {
  return (db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`).all(query) as Array<{
    rowid: number
  }>).map((row) => row.rowid)
}

describe('Memory database lifecycle', () => {
  it('opens a fresh WAL database with the complete schema and default persona', async () => {
    const dir = await tempDir()
    const opened = openTestMemoryDatabase(dir, () => 12_345)

    try {
      expect(opened.dbPath).toBe(path.join(dir, 'neodeskpet-memory.sqlite3'))
      expect(opened.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(opened.db.pragma('synchronous', { simple: true })).toBe(1)
      expect(opened.db.pragma('foreign_keys', { simple: true })).toBe(1)

      const tables = schemaNames(opened.db, 'table')
      for (const table of [
        'persona',
        'memory',
        'memory_fts',
        'memory_version',
        'memory_conflict',
        'tag',
        'memory_tag',
        'memory_embedding',
        'kg_entity',
        'kg_entity_fts',
        'kg_entity_mention',
        'kg_relation',
        'kg_memory_index',
      ]) {
        expect(tables.has(table), `missing table ${table}`).toBe(true)
      }

      const triggers = schemaNames(opened.db, 'trigger')
      for (const trigger of ['memory_ai', 'memory_ad', 'memory_au', 'kg_entity_ai', 'kg_entity_ad', 'kg_entity_au']) {
        expect(triggers.has(trigger), `missing trigger ${trigger}`).toBe(true)
      }
      const indexes = schemaNames(opened.db, 'index')
      expect(indexes.has('idx_memory_kind_persona_updated')).toBe(true)
      expect(indexes.has('idx_memory_persona_status_pinned_created')).toBe(true)

      expect(
        opened.db
          .prepare(
            'SELECT id, name, capture_enabled as captureEnabled, capture_user as captureUser, capture_assistant as captureAssistant, retrieve_enabled as retrieveEnabled, created_at as createdAt, updated_at as updatedAt FROM persona WHERE id = ?',
          )
          .get('default'),
      ).toEqual({
        id: 'default',
        name: '默认角色',
        captureEnabled: 1,
        captureUser: 1,
        captureAssistant: 1,
        retrieveEnabled: 1,
        createdAt: 12_345,
        updatedAt: 12_345,
      })

      const inserted = opened.db
        .prepare(
          'INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('fresh-memory', 'default', 'persona', 'chat', 'user', 'session-1', 'message-1', 'fresh searchable memory', 100)
      expect(ftsRowids(opened.db, 'memory_fts', 'searchable')).toEqual([Number(inserted.lastInsertRowid)])
    } finally {
      opened.db.close()
    }
  })

  it('migrates a legacy database before creating indexes that depend on new columns', async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, 'neodeskpet-memory.sqlite3')
    const legacy = new NodeSqliteDatabaseAdapter(dbPath)
    legacy.exec(`
      CREATE TABLE persona (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        persona_id TEXT,
        scope TEXT NOT NULL DEFAULT 'persona',
        kind TEXT NOT NULL,
        role TEXT,
        session_id TEXT,
        message_id TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO persona (id, name, prompt, created_at, updated_at)
        VALUES ('legacy-persona', '旧角色', 'keep prompt', 10, 20);
      INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at)
        VALUES ('legacy-memory', 'legacy-persona', 'persona', 'chat', 'user', 'legacy-session', 'legacy-message', 'legacy searchable content', 777);
    `)
    legacy.close()

    const opened = openTestMemoryDatabase(dir, () => 88_888)
    try {
      const personaColumns = tableColumns(opened.db, 'persona')
      for (const column of ['capture_enabled', 'capture_user', 'capture_assistant', 'retrieve_enabled']) {
        expect(personaColumns.has(column), `missing persona column ${column}`).toBe(true)
      }
      const memoryColumns = tableColumns(opened.db, 'memory')
      for (const column of [
        'updated_at',
        'importance',
        'strength',
        'access_count',
        'last_accessed_at',
        'retention',
        'status',
        'memory_type',
        'source',
        'pinned',
      ]) {
        expect(memoryColumns.has(column), `missing memory column ${column}`).toBe(true)
      }

      expect(
        opened.db
          .prepare(
            'SELECT updated_at as updatedAt, importance, strength, access_count as accessCount, retention, status, memory_type as memoryType, pinned FROM memory WHERE id = ?',
          )
          .get('legacy-memory'),
      ).toEqual({
        updatedAt: 777,
        importance: 0.5,
        strength: 0.2,
        accessCount: 0,
        retention: 1,
        status: 'active',
        memoryType: 'other',
        pinned: 0,
      })
      expect(ftsRowids(opened.db, 'memory_fts', 'searchable')).toEqual([1])
      expect(opened.db.prepare('SELECT name, prompt FROM persona WHERE id = ?').get('legacy-persona')).toEqual({
        name: '旧角色',
        prompt: 'keep prompt',
      })
      expect(opened.db.prepare('SELECT created_at as createdAt FROM persona WHERE id = ?').get('default')).toEqual({
        createdAt: 88_888,
      })
      const indexes = schemaNames(opened.db, 'index')
      expect(indexes.has('idx_memory_kind_persona_updated')).toBe(true)
      expect(indexes.has('idx_memory_persona_status_pinned_created')).toBe(true)
    } finally {
      opened.db.close()
    }
  })

  it('is idempotent, preserves a customized default persona, and refreshes update triggers', async () => {
    const dir = await tempDir()
    const opened = openTestMemoryDatabase(dir, () => 1_000)

    try {
      opened.db
        .prepare('UPDATE persona SET name = ?, prompt = ?, updated_at = ? WHERE id = ?')
        .run('自定义默认角色', 'custom prompt', 2_000, 'default')
      const inserted = opened.db
        .prepare(
          'INSERT INTO memory (id, persona_id, scope, kind, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run('idempotent-memory', 'default', 'persona', 'chat', 'user', 'before trigger refresh', 3_000)
      const rowid = Number(inserted.lastInsertRowid)

      initializeMemoryDatabase(opened.db, () => 9_999)

      expect(opened.db.prepare('SELECT name, prompt, updated_at as updatedAt FROM persona WHERE id = ?').get('default')).toEqual({
        name: '自定义默认角色',
        prompt: 'custom prompt',
        updatedAt: 2_000,
      })
      expect(opened.db.prepare('SELECT COUNT(*) as count FROM persona WHERE id = ?').get('default')).toEqual({ count: 1 })
      expect(ftsRowids(opened.db, 'memory_fts', 'before')).toEqual([rowid])

      opened.db.prepare('UPDATE memory SET content = ? WHERE rowid = ?').run('after trigger refresh', rowid)
      expect(ftsRowids(opened.db, 'memory_fts', 'before')).toEqual([])
      expect(ftsRowids(opened.db, 'memory_fts', 'after')).toEqual([rowid])

      opened.db.prepare('DELETE FROM memory WHERE rowid = ?').run(rowid)
      expect(ftsRowids(opened.db, 'memory_fts', 'after')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('indexes legacy KG entities when the FTS table is introduced', async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, 'neodeskpet-memory.sqlite3')
    const legacy = new NodeSqliteDatabaseAdapter(dbPath)
    legacy.exec(`
      CREATE TABLE kg_entity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'entity',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO kg_entity (persona_id, name, entity_type, aliases_json, key, created_at, updated_at)
        VALUES ('default', 'Alice', 'person', '["Ally"]', 'alice', 1, 1);
    `)
    legacy.close()

    const opened = openTestMemoryDatabase(dir)
    try {
      expect(ftsRowids(opened.db, 'kg_entity_fts', 'Alice')).toEqual([1])
      expect(ftsRowids(opened.db, 'kg_entity_fts', 'Ally')).toEqual([1])

      opened.db.prepare('UPDATE kg_entity SET aliases_json = ?, updated_at = ? WHERE id = ?').run('["Alicia"]', 2, 1)
      expect(ftsRowids(opened.db, 'kg_entity_fts', 'Ally')).toEqual([])
      expect(ftsRowids(opened.db, 'kg_entity_fts', 'Alicia')).toEqual([1])
    } finally {
      opened.db.close()
    }
  })

  it('closes a partially opened handle while preserving the schema initialization error', async () => {
    const dir = await tempDir()
    let closed = false
    class FailingDatabase {
      pragma(): void {}
      prepare(): { get: () => undefined } {
        return { get: () => undefined }
      }
      exec(): never {
        throw new Error('schema initialization failed')
      }
      close(): never {
        closed = true
        throw new Error('close also failed')
      }
    }

    expect(() =>
      openMemoryDatabase(dir, {
        databaseConstructor: FailingDatabase as unknown as MemoryDatabaseConstructor,
      }),
    ).toThrow('schema initialization failed')
    expect(closed).toBe(true)
  })
})
