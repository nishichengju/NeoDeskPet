import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDatabaseHandle } from '../electron/memory/memoryDatabase'
import type { MemoryEmbeddingClient } from '../electron/memory/memoryEmbeddingClient'
import {
  computeMemoryRetentionScore,
  MemoryRetrievalEngine,
} from '../electron/memory/memoryRetrieval'
import type { MemoryVectorSearchClient } from '../electron/memory/memoryVectorSearchClient'
import type { AISettings, MemorySettings, Persona } from '../electron/types'

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

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'persona-a',
    name: 'Persona A',
    prompt: 'Stay concise.',
    captureEnabled: true,
    captureUser: true,
    captureAssistant: true,
    retrieveEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function createHarness(options: {
  now?: number
  persona?: Persona | null
  embedTexts?: Pick<MemoryEmbeddingClient, 'embedTexts'>['embedTexts']
  vectorSearch?: Pick<MemoryVectorSearchClient, 'search'>['search']
} = {}) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  adapter.exec(`
    CREATE TABLE memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT,
      role TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      strength REAL NOT NULL DEFAULT 0.2,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      retention REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
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
    CREATE TABLE kg_entity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT,
      name TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE kg_entity_fts USING fts5(name, aliases, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TABLE kg_entity_mention (
      entity_id INTEGER NOT NULL,
      memory_rowid INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, memory_rowid)
    );
  `)
  const db = adapter as unknown as MemoryDatabaseHandle
  const embedTexts = options.embedTexts ?? vi.fn()
  const vectorSearch = options.vectorSearch ?? vi.fn()
  const activePersona = options.persona === undefined ? persona() : options.persona
  const engine = new MemoryRetrievalEngine(
    db,
    { embedTexts },
    { search: vectorSearch },
    () => activePersona,
    { now: () => options.now ?? 5_000 },
  )
  return { db, engine }
}

function insertMemory(
  db: MemoryDatabaseHandle,
  content: string,
  options: {
    personaId?: string | null
    role?: string | null
    createdAt?: number
    importance?: number
    strength?: number
    status?: string
    pinned?: number
  } = {},
): number {
  const inserted = db
    .prepare(
      `
      INSERT INTO memory (persona_id, role, content, created_at, importance, strength, status, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      options.personaId === undefined ? 'persona-a' : options.personaId,
      options.role ?? 'user',
      content,
      options.createdAt ?? 1_000,
      options.importance ?? 0.5,
      options.strength ?? 0.4,
      options.status ?? 'active',
      options.pinned ?? 0,
    )
  return Number(inserted.lastInsertRowid)
}

describe('MemoryRetrievalEngine', () => {
  it('honors persona retrieval disablement and still returns the persona prompt for an empty query', async () => {
    const disabled = createHarness({ persona: persona({ retrieveEnabled: false }) })
    await expect(
      disabled.engine.retrieve({ personaId: 'persona-a', query: 'Alice' }, {} as MemorySettings, {} as AISettings),
    ).resolves.toEqual({ addon: '' })

    const enabled = createHarness()
    await expect(
      enabled.engine.retrieve({ personaId: 'persona-a', query: '   ' }, {} as MemorySettings, {} as AISettings),
    ).resolves.toEqual({ addon: '【当前人设】\nStay concise.' })
  })

  it('retrieves an exact relative time range and reinforces only emitted rows', async () => {
    const now = new Date(2026, 6, 14, 12, 0, 0, 0).getTime()
    const harness = createHarness({ now })
    const hitRowid = insertMemory(harness.db, '凌晨的原话', {
      role: 'assistant',
      createdAt: new Date(2026, 6, 13, 2, 30, 0, 0).getTime(),
    })
    insertMemory(harness.db, '白天内容', {
      createdAt: new Date(2026, 6, 13, 10, 0, 0, 0).getTime(),
    })

    const result = await harness.engine.retrieve(
      { personaId: 'persona-a', query: '请准确复述昨天凌晨', reinforce: true },
      { vectorEnabled: true } as MemorySettings,
      {} as AISettings,
    )

    expect(result.addon).toContain('【引用规则】')
    expect(result.addon).toContain('凌晨的原话')
    expect(result.addon).not.toContain('白天内容')
    expect(result.debug).toMatchObject({
      layers: ['timeRange'],
      counts: { timeRange: 1, fts: 0, like: 0, tag: 0, vector: 0, kg: 0 },
      vector: { enabled: true, attempted: false, reason: 'timeRange' },
    })
    expect(
      harness.db
        .prepare('SELECT access_count as accessCount, last_accessed_at as lastAccessedAt, strength FROM memory WHERE rowid = ?')
        .get(hitRowid),
    ).toEqual({ accessCount: 1, lastAccessedAt: now, strength: 0.44 })
  })

  it('merges FTS, Tag, and KG evidence into one candidate without duplicating the output', async () => {
    const harness = createHarness({ now: 2_000 })
    const rowid = insertMemory(harness.db, 'Alice likes Tea', { createdAt: 1_500 })
    const tagId = Number(harness.db.prepare('INSERT INTO tag (name, created_at) VALUES (?, ?)').run('alice', 1).lastInsertRowid)
    harness.db.prepare('INSERT INTO memory_tag (memory_rowid, tag_id, created_at) VALUES (?, ?, ?)').run(rowid, tagId, 1)
    const entityId = Number(
      harness.db.prepare('INSERT INTO kg_entity (persona_id, name) VALUES (?, ?)').run('persona-a', 'Alice').lastInsertRowid,
    )
    harness.db.prepare('INSERT INTO kg_entity_fts (rowid, name, aliases) VALUES (?, ?, ?)').run(entityId, 'Alice', '["Ally"]')
    harness.db.prepare('INSERT INTO kg_entity_mention (entity_id, memory_rowid, created_at) VALUES (?, ?, ?)').run(entityId, rowid, 1)

    const result = await harness.engine.retrieve(
      { personaId: 'persona-a', query: 'Alice', reinforce: false },
      { tagEnabled: true, tagMaxExpand: 0, kgEnabled: true, vectorEnabled: false } as MemorySettings,
      {} as AISettings,
    )

    expect(result.debug).toMatchObject({
      layers: ['fts', 'tag', 'kg'],
      counts: { timeRange: 0, fts: 1, like: 0, tag: 1, vector: 0, kg: 1 },
      tag: { queryTags: 1, matchedTags: 1, expandedTags: 1 },
      vector: { enabled: false, attempted: false, reason: 'disabled' },
    })
    expect(result.addon.match(/Alice likes Tea/g)).toHaveLength(1)
  })

  it('uses vector retrieval only when local candidates are insufficient', async () => {
    const embedTexts = vi.fn(async () => [
      { text: 'semantic beacon recollection', hash: 'query-hash', vec: new Float32Array([1, 0]) },
    ])
    const vectorSearch = vi.fn(async () => [{ rowid: 1, sim: 0.88 }])
    const harness = createHarness({ embedTexts, vectorSearch, now: 2_000 })
    insertMemory(harness.db, 'A cobalt lighthouse watches the sea.', { createdAt: 1_500 })
    const memSettings = {
      tagEnabled: false,
      kgEnabled: false,
      vectorEnabled: true,
      vectorEmbeddingModel: 'vector-model',
      vectorUseCustomAi: true,
      vectorAiApiKey: 'vector-key',
      vectorAiBaseUrl: 'https://vector.example/v1',
      vectorMinScore: 0.5,
      vectorTopK: 5,
      vectorScanLimit: 300,
    } as MemorySettings

    const result = await harness.engine.retrieve(
      { personaId: 'persona-a', query: 'semantic beacon recollection', limit: 3, reinforce: false },
      memSettings,
      {} as AISettings,
    )

    expect(embedTexts).toHaveBeenCalledTimes(1)
    expect(vectorSearch).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'vector-model', personaId: 'persona-a', minScore: 0.5, topK: 5, scanLimit: 300 }),
    )
    expect(result.debug).toMatchObject({
      layers: ['vector'],
      counts: { vector: 1 },
      vector: { enabled: true, attempted: true },
    })
    expect(result.addon).toContain('A cobalt lighthouse watches the sea.')
  })

  it('reports vector failures without losing the persona addon', async () => {
    const embedTexts = vi.fn(async () => [
      { text: 'unknown', hash: 'query-hash', vec: new Float32Array([1, 0]) },
    ])
    const vectorSearch = vi.fn(async () => {
      throw new Error('vector worker offline')
    })
    const harness = createHarness({ embedTexts, vectorSearch })
    const result = await harness.engine.retrieve(
      { personaId: 'persona-a', query: 'unknown', reinforce: false },
      {
        tagEnabled: false,
        kgEnabled: false,
        vectorEnabled: true,
        vectorEmbeddingModel: 'vector-model',
        vectorUseCustomAi: true,
        vectorAiApiKey: 'vector-key',
        vectorAiBaseUrl: 'https://vector.example/v1',
      } as MemorySettings,
      {} as AISettings,
    )

    expect(result.addon).toBe('【当前人设】\nStay concise.')
    expect(result.debug).toMatchObject({
      layers: ['none'],
      counts: { vector: 0 },
      vector: { enabled: true, attempted: true, error: 'vector worker offline' },
    })
  })
})

describe('computeMemoryRetentionScore', () => {
  it('returns full retention at access time and decays with age', () => {
    const now = 30 * 86_400_000
    expect(computeMemoryRetentionScore(now, now, null, 0.5)).toBe(1)
    expect(computeMemoryRetentionScore(now, 0, null, 0.5)).toBeLessThan(1)
  })
})
