import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDatabaseHandle } from '../electron/memory/memoryDatabase'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'
import { MemoryKgIndexMaintainer } from '../electron/memory/memoryKgIndex'
import type { AISettings, MemorySettings } from '../electron/types'

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

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON')
  }

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

function kgHash(personaId: string, kind: string, content: string): string {
  return createHash('sha1').update(`${personaId}\n${kind}\n${content}`).digest('hex')
}

function successResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: `result:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` } }] }),
    { status: 200 },
  )
}

function createHarness(fetchImpl: typeof fetch = vi.fn()) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  adapter.exec(`
    CREATE TABLE memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
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
    CREATE UNIQUE INDEX idx_kg_entity_unique ON kg_entity(persona_id, key, entity_type);
    CREATE TABLE kg_entity_mention (
      entity_id INTEGER NOT NULL,
      memory_rowid INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, memory_rowid),
      FOREIGN KEY(entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
      FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
    );
    CREATE TABLE kg_relation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT,
      subject_entity_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      object_entity_id INTEGER,
      object_literal TEXT,
      confidence REAL NOT NULL DEFAULT 0.6,
      memory_rowid INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(subject_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
      FOREIGN KEY(object_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
      FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_kg_relation_unique ON kg_relation(
      persona_id,
      subject_entity_id,
      predicate,
      COALESCE(object_entity_id, 0),
      COALESCE(object_literal, ''),
      memory_rowid
    );
    CREATE TABLE kg_memory_index (
      memory_rowid INTEGER PRIMARY KEY,
      persona_id TEXT,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      extracted_at INTEGER NOT NULL,
      FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
    );
  `)
  const db = adapter as unknown as MemoryDatabaseHandle
  const queue = new MemoryIndexQueue()
  const now = vi.fn(() => 5000)
  const maintainer = new MemoryKgIndexMaintainer(db, queue, { fetchImpl, now })
  const memSettings = {
    kgEnabled: true,
    kgUseCustomAi: true,
    kgAiApiKey: 'kg-key',
    kgAiBaseUrl: 'https://kg.example/v1/',
    kgAiModel: 'kg-model',
    kgAiTemperature: 0.3,
    kgAiMaxTokens: 900,
  } as MemorySettings
  return { db, queue, maintainer, memSettings, aiSettings: {} as AISettings, now }
}

function insertMemory(
  db: MemoryDatabaseHandle,
  content: string,
  updatedAt: number,
  overrides: { personaId?: string | null; kind?: string; role?: string | null; createdAt?: number } = {},
): number {
  const inserted = db
    .prepare(
      'INSERT INTO memory (persona_id, kind, content, updated_at, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      overrides.personaId ?? 'persona-a',
      overrides.kind ?? 'manual_note',
      content,
      updatedAt,
      overrides.role ?? null,
      overrides.createdAt ?? 1000,
    )
  return Number(inserted.lastInsertRowid)
}

describe('MemoryKgIndexMaintainer', () => {
  it('validates feature and API configuration before consuming pending work', async () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, 'pending KG memory', 1)
    harness.queue.enqueue('kg', rowid)

    await expect(
      harness.maintainer.run({ kgEnabled: false } as MemorySettings, harness.aiSettings),
    ).resolves.toEqual({ scanned: 0, extracted: 0, skipped: 0 })
    await expect(
      harness.maintainer.run({ kgEnabled: true } as MemorySettings, harness.aiSettings),
    ).resolves.toMatchObject({ error: 'KG 抽取 API 未配置（缺少 apiKey/baseUrl/model）' })
    expect(harness.queue.take('kg', 10)).toEqual([rowid])
  })

  it('deduplicates pending and sweep candidates, skips fresh hashes, and persists the graph transaction', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://kg.example/v1/chat/completions')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer kg-key' })
      const body = JSON.parse(String(init?.body)) as {
        model: string
        temperature: number
        max_tokens: number
        messages: Array<{ role: string; content: string }>
      }
      expect(body.model).toBe('kg-model')
      expect(body.temperature).toBe(0.3)
      expect(body.max_tokens).toBe(900)
      expect(body.messages[1]?.content).toContain('原文：\nNeeds KG extraction')
      return successResponse({
        entities: [
          { name: 'Alice', type: 'person', aliases: ['Ally', 'Alice', ''] },
          { name: 'Tea', type: 'food', aliases: [] },
          { name: 'x', type: 'other', aliases: [] },
        ],
        relations: [
          {
            subject: 'Alice',
            predicate: 'likes',
            object: { type: 'entity', value: 'Tea' },
            confidence: 1.4,
            evidence: 'Alice likes tea',
          },
          {
            subject: 'Alice',
            predicate: 'visits',
            object: { type: 'entity', value: 'Paris' },
            confidence: 0.7,
            evidence: 'Alice visits Paris',
          },
        ],
      })
    })
    const harness = createHarness(fetchImpl)
    const freshRowid = insertMemory(harness.db, 'Already indexed', 100)
    const missingRowid = insertMemory(harness.db, 'Needs KG extraction', 300, { role: 'user' })
    const deferredRowid = insertMemory(harness.db, 'Later KG batch', 200)
    harness.db
      .prepare(
        'INSERT INTO kg_memory_index (memory_rowid, persona_id, content_hash, status, updated_at, extracted_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(freshRowid, 'persona-a', kgHash('persona-a', 'manual_note', 'Already indexed'), 'ok', 100, 100)
    harness.queue.enqueue('kg', freshRowid)

    await expect(harness.maintainer.run(harness.memSettings, harness.aiSettings, { batchSize: 2 })).resolves.toEqual({
      scanned: 2,
      extracted: 1,
      skipped: 1,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      harness.db
        .prepare('SELECT name, entity_type as entityType, aliases_json as aliasesJson FROM kg_entity ORDER BY id')
        .all(),
    ).toEqual([
      { name: 'Alice', entityType: 'person', aliasesJson: '["Ally","Alice"]' },
      { name: 'Tea', entityType: 'food', aliasesJson: '["Tea"]' },
    ])
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM kg_entity_mention WHERE memory_rowid = ?').get(missingRowid)).toEqual({
      count: 2,
    })
    expect(
      harness.db
        .prepare(
          `
          SELECT s.name as subject, r.predicate, o.name as objectEntity, r.object_literal as objectLiteral, r.confidence
          FROM kg_relation r
          JOIN kg_entity s ON s.id = r.subject_entity_id
          LEFT JOIN kg_entity o ON o.id = r.object_entity_id
          WHERE r.memory_rowid = ?
          ORDER BY r.id
          `,
        )
        .all(missingRowid),
    ).toEqual([
      { subject: 'Alice', predicate: 'likes', objectEntity: 'Tea', objectLiteral: null, confidence: 1 },
      { subject: 'Alice', predicate: 'visits', objectEntity: null, objectLiteral: 'Paris', confidence: 0.7 },
    ])
    expect(harness.db.prepare('SELECT status, updated_at as updatedAt FROM kg_memory_index WHERE memory_rowid = ?').get(missingRowid)).toEqual({
      status: 'ok',
      updatedAt: 300,
    })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM kg_memory_index WHERE memory_rowid = ?').get(deferredRowid)).toEqual({
      count: 0,
    })
  })

  it('isolates provider failures to their source row and continues the batch', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      if (body.messages[1]?.content.includes('Broken KG row')) {
        return new Response(JSON.stringify({ error: { message: 'KG provider offline' } }), { status: 503 })
      }
      return successResponse({ entities: [], relations: [] })
    })
    const harness = createHarness(fetchImpl)
    const brokenRowid = insertMemory(harness.db, 'Broken KG row', 100)
    const okRowid = insertMemory(harness.db, 'Healthy KG row', 200)
    harness.queue.enqueue('kg', brokenRowid)
    harness.queue.enqueue('kg', okRowid)

    await expect(harness.maintainer.run(harness.memSettings, harness.aiSettings, { batchSize: 2 })).resolves.toEqual({
      scanned: 2,
      extracted: 1,
      skipped: 0,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(
      harness.db
        .prepare('SELECT status, last_error as lastError FROM kg_memory_index WHERE memory_rowid = ?')
        .get(brokenRowid),
    ).toEqual({ status: 'error', lastError: 'KG provider offline' })
    expect(harness.db.prepare('SELECT status, last_error as lastError FROM kg_memory_index WHERE memory_rowid = ?').get(okRowid)).toEqual({
      status: 'ok',
      lastError: null,
    })
  })

  it('rolls graph writes back before recording a persistence error', async () => {
    const fetchImpl = vi.fn(async () =>
      successResponse({
        entities: [
          { name: 'Alice', type: 'person', aliases: [] },
          { name: 'Tea', type: 'food', aliases: [] },
        ],
        relations: [
          { subject: 'Alice', predicate: 'likes', object: { type: 'entity', value: 'Tea' } },
        ],
      }),
    )
    const harness = createHarness(fetchImpl)
    const rowid = insertMemory(harness.db, 'Rollback KG row', 100)
    harness.db.exec(`
      CREATE TRIGGER fail_kg_relation BEFORE INSERT ON kg_relation BEGIN
        SELECT RAISE(ABORT, 'relation write failed');
      END;
    `)
    harness.queue.enqueue('kg', rowid)

    await expect(harness.maintainer.run(harness.memSettings, harness.aiSettings, { batchSize: 1 })).resolves.toEqual({
      scanned: 1,
      extracted: 0,
      skipped: 0,
    })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM kg_entity').get()).toEqual({ count: 0 })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM kg_entity_mention').get()).toEqual({ count: 0 })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM kg_relation').get()).toEqual({ count: 0 })
    expect(
      harness.db
        .prepare('SELECT status, last_error as lastError FROM kg_memory_index WHERE memory_rowid = ?')
        .get(rowid),
    ).toMatchObject({ status: 'error', lastError: expect.stringContaining('relation write failed') })
  })
})
