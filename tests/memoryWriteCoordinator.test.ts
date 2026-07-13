import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initializeMemoryDatabase,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'
import { hashMemoryEmbeddingInput } from '../electron/memory/memoryEmbeddingClient'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'
import { MemoryRecordStore } from '../electron/memory/memoryRecordStore'
import { MemoryWriteCoordinator } from '../electron/memory/memoryWriteCoordinator'
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

function vector(x: number, y = 0): Float32Array {
  return new Float32Array([x, y, 0, 0, 0, 0, 0, 0])
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'persona-a',
    name: 'Persona A',
    prompt: '',
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
  persona?: Persona | null
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>
} = {}) {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  const db = adapter as unknown as MemoryDatabaseHandle
  initializeMemoryDatabase(db, () => 1_000)

  let id = 0
  const createId = () => `test-id-${++id}`
  const now = vi.fn(() => 5_000)
  const queue = new MemoryIndexQueue()
  const records = new MemoryRecordStore(db, { now, createId })
  const embedTexts = vi.fn(async (_config: unknown, texts: string[]) => {
    const vectors = options.embedTexts
      ? await options.embedTexts(texts)
      : texts.map(() => vector(1))
    return texts.map((text, index) => ({ text, hash: `hash-${index}`, vec: vectors[index] }))
  })
  let activePersona = options.persona === undefined ? persona() : options.persona
  const coordinator = new MemoryWriteCoordinator(
    db,
    queue,
    { embedTexts },
    () => activePersona,
    records,
    { now, createId, maxChatRedirects: 4 },
  )
  const memSettings = {
    vectorEmbeddingModel: 'write-model',
    vectorUseCustomAi: true,
    vectorAiApiKey: 'write-key',
    vectorAiBaseUrl: 'https://write.example/v1',
    vectorDedupeThreshold: 0.9,
  } as MemorySettings
  return {
    db,
    queue,
    coordinator,
    embedTexts,
    memSettings,
    aiSettings: {} as AISettings,
    setPersona: (next: Persona | null) => {
      activePersona = next
    },
  }
}

function insertMemory(
  db: MemoryDatabaseHandle,
  content: string,
  options: {
    personaId?: string | null
    scope?: 'persona' | 'shared'
    kind?: string
    role?: string
    sessionId?: string | null
    messageId?: string | null
    createdAt?: number
    updatedAt?: number
    importance?: number
    strength?: number
    memoryType?: string
    source?: string
  } = {},
): number {
  const inserted = db
    .prepare(
      `
      INSERT INTO memory (
        id, persona_id, scope, kind, role, session_id, message_id, content,
        created_at, updated_at, importance, strength, memory_type, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `seed-${Math.random()}`,
      options.personaId === undefined ? 'persona-a' : options.personaId,
      options.scope ?? 'persona',
      options.kind ?? 'manual_note',
      options.role ?? 'note',
      options.sessionId ?? null,
      options.messageId ?? null,
      content,
      options.createdAt ?? 1_000,
      options.updatedAt ?? 1_000,
      options.importance ?? 0.4,
      options.strength ?? 0.4,
      options.memoryType ?? 'semantic',
      options.source ?? 'seed',
    )
  return Number(inserted.lastInsertRowid)
}

function insertEmbedding(db: MemoryDatabaseHandle, rowid: number, content: string, vec: Float32Array): void {
  db.prepare(
    `
    INSERT INTO memory_embedding (memory_rowid, model, dims, content_hash, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    rowid,
    'write-model',
    vec.length,
    hashMemoryEmbeddingInput('write-model', content),
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    1_000,
    1_000,
  )
}

function expectAllIndexesQueued(queue: MemoryIndexQueue, rowid: number): void {
  expect(queue.take('tag', 10)).toEqual([rowid])
  expect(queue.take('embedding', 10)).toEqual([rowid])
  expect(queue.take('kg', 10)).toEqual([rowid])
}

describe('MemoryWriteCoordinator', () => {
  it('honors capture gates and upserts the same chat message without creating duplicate rows', async () => {
    const harness = createHarness({ persona: persona({ captureEnabled: false }) })
    const args = {
      personaId: 'persona-a',
      sessionId: 'session-a',
      messageId: 'turn:user-a',
      role: 'assistant' as const,
      content: '用户：你好\n助手：你好呀',
      createdAt: 100,
    }

    await harness.coordinator.ingestChatMessage(args, undefined, harness.aiSettings)
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory').get()).toEqual({ count: 0 })

    harness.setPersona(persona({ captureAssistant: false }))
    await harness.coordinator.ingestChatMessage(args, undefined, harness.aiSettings)
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory').get()).toEqual({ count: 0 })

    harness.setPersona(persona())
    await harness.coordinator.ingestChatMessage(args, undefined, harness.aiSettings)
    await harness.coordinator.ingestChatMessage(
      { ...args, content: '用户：你好\n助手：你好呀，很高兴见到你', createdAt: 200 },
      undefined,
      harness.aiSettings,
    )

    expect(
      harness.db
        .prepare(
          'SELECT COUNT(*) as count, MIN(created_at) as createdAt, MAX(content) as content FROM memory WHERE session_id = ?',
        )
        .get('session-a'),
    ).toEqual({ count: 1, createdAt: 100, content: '用户：你好\n助手：你好呀，很高兴见到你' })
    expectAllIndexesQueued(harness.queue, 1)
  })

  it('merges a vector-duplicate chat row, deletes the source, records versions, and redirects later turn updates', async () => {
    const harness = createHarness()
    const targetRowid = insertMemory(harness.db, '用户：你好\n助手：你好', {
      kind: 'chat_message',
      role: 'assistant',
      sessionId: 'old-session',
      messageId: 'old-message',
    })
    insertEmbedding(harness.db, targetRowid, '用户：你好\n助手：你好', vector(1))
    const args = {
      personaId: 'persona-a',
      sessionId: 'session-b',
      messageId: 'turn:user-b',
      role: 'assistant' as const,
      content: '用户：你好\n助手：你好，很高兴见到你',
      createdAt: 200,
    }

    await harness.coordinator.ingestChatMessage(args, harness.memSettings, harness.aiSettings)
    await harness.coordinator.ingestChatMessage(
      { ...args, content: '用户：你好\n助手：你好，很高兴见到你！今天想聊什么？', createdAt: 250 },
      harness.memSettings,
      harness.aiSettings,
    )

    expect(
      harness.db.prepare('SELECT content, status, source FROM memory WHERE rowid = ?').get(targetRowid),
    ).toEqual({
      content: '用户：你好\n助手：你好，很高兴见到你！今天想聊什么？',
      status: 'active',
      source: 'assistant_msg',
    })
    expect(
      harness.db.prepare('SELECT status FROM memory WHERE session_id = ? AND message_id = ?').get('session-b', 'turn:user-b'),
    ).toEqual({ status: 'deleted' })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory').get()).toEqual({ count: 2 })
    expect(
      harness.db
        .prepare('SELECT old_content as oldContent, new_content as newContent FROM memory_version ORDER BY created_at, rowid')
        .all(),
    ).toEqual([
      {
        oldContent: '用户：你好\n助手：你好',
        newContent: '用户：你好\n助手：你好，很高兴见到你',
      },
      {
        oldContent: '用户：你好\n助手：你好，很高兴见到你',
        newContent: '用户：你好\n助手：你好，很高兴见到你！今天想聊什么？',
      },
    ])
    expectAllIndexesQueued(harness.queue, targetRowid)
  })

  it('refreshes an unchanged manual duplicate without creating a version or a second row', async () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, '喜好：红茶')
    insertEmbedding(harness.db, rowid, '喜好：红茶', vector(1))

    const result = await harness.coordinator.upsertManualMemory(
      {
        personaId: 'persona-a',
        scope: 'persona',
        content: '喜好：红茶',
        importance: 0.8,
        strength: 0.7,
      },
      harness.memSettings,
      harness.aiSettings,
    )

    expect(result.rowid).toBe(rowid)
    expect(
      harness.db.prepare('SELECT COUNT(*) as count, MAX(updated_at) as updatedAt FROM memory').get(),
    ).toEqual({ count: 1, updatedAt: 5_000 })
    expect(harness.db.prepare('SELECT importance, strength FROM memory WHERE rowid = ?').get(rowid)).toEqual({
      importance: 0.8,
      strength: 0.71,
    })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory_version').get()).toEqual({ count: 0 })
  })

  it('merges a key-value manual duplicate, records the old value, and queues every index', async () => {
    const harness = createHarness()
    const rowid = insertMemory(harness.db, '饮品：咖啡')
    insertEmbedding(harness.db, rowid, '饮品：咖啡', vector(1))

    const result = await harness.coordinator.upsertManualMemory(
      {
        personaId: 'persona-a',
        scope: 'persona',
        content: '饮品：红茶',
        source: 'memory_console',
        memoryType: 'preference',
        importance: 0.9,
        strength: 0.8,
      },
      harness.memSettings,
      harness.aiSettings,
    )

    expect(result).toMatchObject({
      rowid,
      content: '饮品：红茶',
      memoryType: 'preference',
      source: 'memory_console',
    })
    expect(
      harness.db
        .prepare('SELECT old_content as oldContent, new_content as newContent, reason, source FROM memory_version')
        .get(),
    ).toEqual({
      oldContent: '饮品：咖啡',
      newContent: '饮品：红茶',
      reason: 'vector_dedupe_merge',
      source: 'memory_console',
    })
    expectAllIndexesQueued(harness.queue, rowid)
  })

  it('falls back to a new shared manual row when the embedding provider fails', async () => {
    const harness = createHarness({
      embedTexts: async () => {
        throw new Error('provider offline')
      },
    })

    const result = await harness.coordinator.upsertManualMemory(
      {
        personaId: 'persona-a',
        scope: 'shared',
        content: '全局备忘录',
      },
      harness.memSettings,
      harness.aiSettings,
    )

    expect(result).toMatchObject({ personaId: null, scope: 'shared', content: '全局备忘录' })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory').get()).toEqual({ count: 1 })
    expect(harness.db.prepare('SELECT COUNT(*) as count FROM memory_embedding').get()).toEqual({ count: 0 })
    expect(harness.embedTexts).toHaveBeenCalledTimes(2)
    expectAllIndexesQueued(harness.queue, result.rowid)
  })

  it('persists only the exact byte range of an offset embedding view', async () => {
    const backing = new Float32Array([99, 98, 1, 0, 0, 0, 0, 0, 0, 0, 97])
    const offsetVector = backing.subarray(2, 10)
    const harness = createHarness({ embedTexts: async (texts) => texts.map(() => offsetVector) })

    const result = await harness.coordinator.upsertManualMemory(
      {
        personaId: 'persona-a',
        scope: 'persona',
        content: '精确向量范围',
      },
      harness.memSettings,
      harness.aiSettings,
    )

    const stored = harness.db
      .prepare('SELECT dims, LENGTH(embedding) as bytes, embedding FROM memory_embedding WHERE memory_rowid = ?')
      .get(result.rowid) as { dims: number; bytes: number; embedding: Uint8Array }
    expect(stored.dims).toBe(8)
    expect(stored.bytes).toBe(32)
    expect(Array.from(new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, 8))).toEqual(
      Array.from(offsetVector),
    )
  })
})
