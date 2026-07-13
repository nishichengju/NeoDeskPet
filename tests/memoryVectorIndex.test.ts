import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDatabaseHandle } from '../electron/memory/memoryDatabase'
import {
  MemoryEmbeddingClient,
  hashMemoryEmbeddingInput,
} from '../electron/memory/memoryEmbeddingClient'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'
import { MemoryVectorIndexMaintainer } from '../electron/memory/memoryVectorIndex'
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

function vector(a: number, b = 0): number[] {
  return [a, b, 0, 0, 0, 0, 0, 0]
}

function createHarness(fetchImpl: typeof fetch = vi.fn()) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  adapter.exec(`
    CREATE TABLE memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_embedding (
      memory_rowid INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const db = adapter as unknown as MemoryDatabaseHandle
  const queue = new MemoryIndexQueue()
  const embeddingClient = new MemoryEmbeddingClient({ fetchImpl })
  const now = vi.fn(() => 5000)
  const maintainer = new MemoryVectorIndexMaintainer(db, queue, embeddingClient, now)
  const memSettings = {
    vectorEnabled: true,
    vectorEmbeddingModel: 'vector-model',
    vectorUseCustomAi: true,
    vectorAiApiKey: 'vector-key',
    vectorAiBaseUrl: 'https://vector.example/v1',
  } as MemorySettings
  const aiSettings = {} as AISettings
  return { db, queue, maintainer, memSettings, aiSettings, now }
}

describe('MemoryVectorIndexMaintainer', () => {
  it('validates feature, model, and API configuration before consuming pending work', async () => {
    const harness = createHarness()
    const rowid = Number(harness.db.prepare('INSERT INTO memory (content, updated_at) VALUES (?, ?)').run('pending', 1).lastInsertRowid)
    harness.queue.enqueue('embedding', rowid)

    await expect(
      harness.maintainer.run({ vectorEnabled: false } as MemorySettings, harness.aiSettings),
    ).resolves.toEqual({ scanned: 0, embedded: 0, skipped: 0 })
    await expect(
      harness.maintainer.run({ vectorEnabled: true } as MemorySettings, harness.aiSettings),
    ).resolves.toMatchObject({ error: 'embeddings 模型为空' })
    await expect(
      harness.maintainer.run(
        { vectorEnabled: true, vectorEmbeddingModel: 'vector-model' } as MemorySettings,
        harness.aiSettings,
      ),
    ).resolves.toMatchObject({ error: 'embeddings API 未配置（缺少 apiKey/baseUrl）' })
    expect(harness.queue.take('embedding', 10)).toEqual([rowid])
  })

  it('deduplicates pending and sweep candidates, touches fresh rows, and embeds missing rows', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'vector-model',
        input: ['Needs embedding'],
        encoding_format: 'float',
      })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector(3, 4) }] }), { status: 200 })
    })
    const harness = createHarness(fetchImpl)
    const insert = harness.db.prepare('INSERT INTO memory (content, updated_at) VALUES (?, ?)')
    const freshRowid = Number(insert.run('Already indexed', 100).lastInsertRowid)
    const missingRowid = Number(insert.run('Needs embedding', 300).lastInsertRowid)
    const deferredRowid = Number(insert.run('Later batch', 200).lastInsertRowid)
    const existingVector = new Float32Array(vector(1))
    harness.db
      .prepare(
        'INSERT INTO memory_embedding (memory_rowid, model, dims, content_hash, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        freshRowid,
        'vector-model',
        existingVector.length,
        hashMemoryEmbeddingInput('vector-model', 'Already indexed'),
        Buffer.from(existingVector.buffer),
        100,
        100,
      )
    harness.queue.enqueue('embedding', freshRowid)

    await expect(harness.maintainer.run(harness.memSettings, harness.aiSettings, { batchSize: 2 })).resolves.toEqual({
      scanned: 2,
      embedded: 1,
      skipped: 1,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      harness.db
        .prepare('SELECT model, dims, updated_at as updatedAt FROM memory_embedding WHERE memory_rowid = ?')
        .get(missingRowid),
    ).toEqual({ model: 'vector-model', dims: 8, updatedAt: 5000 })
    expect(
      harness.db.prepare('SELECT updated_at as updatedAt FROM memory_embedding WHERE memory_rowid = ?').get(freshRowid),
    ).toEqual({ updatedAt: 5000 })
    expect(
      harness.db.prepare('SELECT COUNT(*) as count FROM memory_embedding WHERE memory_rowid = ?').get(deferredRowid),
    ).toEqual({ count: 0 })
  })

  it('reports provider errors without writing a partial embedding row', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'embedding service offline' } }), { status: 503 }),
    )
    const harness = createHarness(fetchImpl)
    const rowid = Number(
      harness.db.prepare('INSERT INTO memory (content, updated_at) VALUES (?, ?)').run('Failed embedding', 100).lastInsertRowid,
    )
    harness.queue.enqueue('embedding', rowid)

    await expect(harness.maintainer.run(harness.memSettings, harness.aiSettings, { batchSize: 1 })).resolves.toEqual({
      scanned: 1,
      embedded: 0,
      skipped: 0,
      error: 'embedding service offline',
    })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory_embedding').get()).toEqual({ count: 0 })
  })
})
