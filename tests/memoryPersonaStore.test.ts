import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeMemoryDatabase,
  type MemoryDatabaseHandle,
} from '../electron/memory/memoryDatabase'
import { MemoryPersonaStore } from '../electron/memory/memoryPersonaStore'

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

function createHarness() {
  const adapter = new NodeDatabaseAdapter()
  databases.push(adapter)
  const db = adapter as unknown as MemoryDatabaseHandle
  initializeMemoryDatabase(db, () => 1_000)
  let id = 0
  const store = new MemoryPersonaStore(db, {
    now: () => 5_000,
    createId: () => `persona-test-${++id}`,
  })
  return { db, store }
}

describe('MemoryPersonaStore', () => {
  it('lists and reads personas with normalized SQLite booleans', () => {
    const harness = createHarness()
    harness.db
      .prepare(
        'INSERT INTO persona (id, name, prompt, capture_enabled, capture_user, capture_assistant, retrieve_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('persona-a', 'Persona A', 'Prompt', 0, 1, 0, 1, 2_000, 3_000)

    expect(harness.store.list()[0]).toEqual({ id: 'persona-a', name: 'Persona A', updatedAt: 3_000 })
    expect(harness.store.get('persona-a')).toMatchObject({
      captureEnabled: false,
      captureUser: true,
      captureAssistant: false,
      retrieveEnabled: true,
    })
    expect(harness.store.get('missing')).toBeNull()
  })

  it('creates named and fallback personas with every capture flag enabled', () => {
    const harness = createHarness()
    expect(harness.store.create(' 角色 A ')).toMatchObject({
      id: 'persona-test-1',
      name: '角色 A',
      prompt: '',
      captureEnabled: true,
      captureUser: true,
      captureAssistant: true,
      retrieveEnabled: true,
      createdAt: 5_000,
      updatedAt: 5_000,
    })
    expect(harness.store.create('   ')).toMatchObject({ id: 'persona-test-2', name: '未命名角色' })
  })

  it('updates only supplied persona fields and preserves the current name for blank patches', () => {
    const harness = createHarness()
    const created = harness.store.create('Persona A')
    const updated = harness.store.update(created.id, {
      name: '   ',
      prompt: 'New prompt',
      captureEnabled: false,
      captureAssistant: false,
    })

    expect(updated).toMatchObject({
      name: 'Persona A',
      prompt: 'New prompt',
      captureEnabled: false,
      captureUser: true,
      captureAssistant: false,
      retrieveEnabled: true,
      updatedAt: 5_000,
    })
    expect(() => harness.store.update('missing', {})).toThrow('角色不存在')
  })

  it('protects the default persona and deletes custom personas', () => {
    const harness = createHarness()
    const created = harness.store.create('Temporary')

    expect(() => harness.store.delete('default')).toThrow('默认角色不可删除')
    harness.store.delete(created.id)
    expect(harness.store.get(created.id)).toBeNull()
    expect(harness.store.get('default')).not.toBeNull()
  })
})
