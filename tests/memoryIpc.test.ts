import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerMemoryIpc, type MemoryIpcService } from '../electron/ipc/registerMemoryIpc'
import type { IpcHandle } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'
import type {
  MemoryConflictRecord,
  MemoryRecord,
  MemoryResolveConflictResult,
  MemoryVersionRecord,
  Persona,
} from '../electron/types'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function persona(): Persona {
  return {
    id: 'persona-1',
    name: 'Persona',
    prompt: '',
    captureEnabled: true,
    captureUser: true,
    captureAssistant: true,
    retrieveEnabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function memoryRecord(): MemoryRecord {
  return { rowid: 1, content: 'Memory' } as MemoryRecord
}

function createService(): MemoryIpcService {
  const record = memoryRecord()
  const version = { id: 'version-1', memoryRowid: 1 } as MemoryVersionRecord
  const conflict = { id: 'conflict-1', memoryRowid: 1 } as MemoryConflictRecord
  const resolved = { ok: true } as MemoryResolveConflictResult
  return {
    listPersonas: vi.fn(() => [persona()]),
    getPersona: vi.fn(() => persona()),
    createPersona: vi.fn(() => persona()),
    updatePersona: vi.fn(() => persona()),
    deletePersona: vi.fn(),
    retrieveContext: vi.fn(async () => ({ addon: 'remembered' })),
    listMemory: vi.fn(() => ({ total: 1, items: [record] })),
    upsertManualMemory: vi.fn(async () => record),
    updateMemory: vi.fn(() => record),
    updateMemoryMeta: vi.fn(() => ({ updated: 1 })),
    updateManyMemoryMeta: vi.fn(() => ({ updated: 2 })),
    updateMemoryByFilterMeta: vi.fn(() => ({ updated: 3 })),
    listMemoryVersions: vi.fn(() => [version]),
    rollbackMemoryVersion: vi.fn(() => record),
    listMemoryConflicts: vi.fn(() => ({ total: 1, items: [conflict] })),
    resolveMemoryConflict: vi.fn(() => resolved),
    deleteMemory: vi.fn(() => ({ ok: true })),
    deleteManyMemory: vi.fn(() => ({ deleted: 2 })),
    deleteMemoryByFilter: vi.fn(() => ({ deleted: 3 })),
  }
}

function createHarness(service: MemoryIpcService | null, memoryEnabled = true) {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => {
    handlers.set(channel, listener)
  }) as IpcHandle
  const settings = createDefaultSettings()
  settings.memory.enabled = memoryEnabled
  registerMemoryIpc({ handle, getMemoryService: () => service, getSettings: () => settings })

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({} as IpcMainInvokeEvent, ...args) as Result
  }
  return { handlers, invoke }
}

describe('memory IPC registration', () => {
  it('registers every memory channel', () => {
    const harness = createHarness(null)
    expect([...harness.handlers.keys()].sort()).toEqual([
      'memory:createPersona',
      'memory:delete',
      'memory:deleteByFilter',
      'memory:deleteMany',
      'memory:deletePersona',
      'memory:getPersona',
      'memory:list',
      'memory:listConflicts',
      'memory:listPersonas',
      'memory:listVersions',
      'memory:resolveConflict',
      'memory:retrieve',
      'memory:rollbackVersion',
      'memory:update',
      'memory:updateByFilterMeta',
      'memory:updateManyMeta',
      'memory:updateMeta',
      'memory:updatePersona',
      'memory:upsertManual',
    ])
  })

  it('preserves empty results and errors when the service is unavailable', async () => {
    const harness = createHarness(null)
    expect(harness.invoke('memory:listPersonas')).toEqual([])
    expect(harness.invoke('memory:getPersona', 'persona-1')).toBeNull()
    await expect(harness.invoke<Promise<unknown>>('memory:retrieve', { personaId: 'persona-1', query: 'q' }))
      .resolves.toEqual({ addon: '' })
    expect(harness.invoke('memory:list', {})).toEqual({ total: 0, items: [] })
    expect(harness.invoke('memory:listVersions', { rowid: 1 })).toEqual([])
    expect(harness.invoke('memory:listConflicts', {})).toEqual({ total: 0, items: [] })
    expect(() => harness.invoke('memory:createPersona', 'Persona')).toThrow('Memory service not ready')
    await expect(
      harness.invoke<Promise<unknown>>('memory:upsertManual', {
        personaId: 'persona-1',
        scope: 'persona',
        content: 'Memory',
      }),
    ).rejects.toThrow('Memory service not ready')
    expect(() => harness.invoke('memory:delete', { rowid: 1 })).toThrow('Memory service not ready')
  })

  it('skips retrieval when memory is disabled', async () => {
    const service = createService()
    const harness = createHarness(service, false)
    await expect(harness.invoke<Promise<unknown>>('memory:retrieve', { personaId: 'persona-1', query: 'q' }))
      .resolves.toEqual({ addon: '' })
    expect(service.retrieveContext).not.toHaveBeenCalled()
  })

  it('delegates persona, retrieval, CRUD, version, conflict, and bulk operations', async () => {
    const service = createService()
    const harness = createHarness(service)

    expect(harness.invoke('memory:listPersonas')).toHaveLength(1)
    expect(harness.invoke('memory:getPersona', 'persona-1')).toMatchObject({ id: 'persona-1' })
    expect(harness.invoke('memory:createPersona', 'New')).toMatchObject({ id: 'persona-1' })
    expect(harness.invoke('memory:updatePersona', 'persona-1', { name: 'Updated' })).toMatchObject({ id: 'persona-1' })
    expect(harness.invoke('memory:deletePersona', 'persona-1')).toEqual({ ok: true })

    await expect(harness.invoke<Promise<unknown>>('memory:retrieve', { personaId: 'persona-1', query: 'q' }))
      .resolves.toEqual({ addon: 'remembered' })
    expect(service.retrieveContext).toHaveBeenCalledWith(
      { personaId: 'persona-1', query: 'q' },
      expect.objectContaining({ enabled: true }),
      expect.any(Object),
    )
    expect(harness.invoke('memory:list', {})).toMatchObject({ total: 1 })
    await expect(
      harness.invoke<Promise<unknown>>('memory:upsertManual', {
        personaId: 'persona-1',
        scope: 'persona',
        content: 'Memory',
      }),
    ).resolves.toMatchObject({ rowid: 1 })
    expect(harness.invoke('memory:update', { rowid: 1, content: 'Updated' })).toMatchObject({ rowid: 1 })
    expect(harness.invoke('memory:updateMeta', { rowid: 1, patch: { pinned: 1 } })).toEqual({ updated: 1 })
    expect(harness.invoke('memory:updateManyMeta', { rowids: [1, 2], patch: { pinned: 1 } })).toEqual({ updated: 2 })
    expect(harness.invoke('memory:updateByFilterMeta', { personaId: 'persona-1', patch: { pinned: 1 } })).toEqual({ updated: 3 })
    expect(harness.invoke('memory:listVersions', { rowid: 1 })).toHaveLength(1)
    expect(harness.invoke('memory:rollbackVersion', { versionId: 'version-1' })).toMatchObject({ rowid: 1 })
    expect(harness.invoke('memory:listConflicts', {})).toMatchObject({ total: 1 })
    expect(harness.invoke('memory:resolveConflict', { conflictId: 'conflict-1', action: 'acceptIncoming' })).toEqual({ ok: true })
    expect(harness.invoke('memory:delete', { rowid: 1 })).toEqual({ ok: true })
    expect(harness.invoke('memory:deleteMany', { rowids: [1, 2] })).toEqual({ deleted: 2 })
    expect(harness.invoke('memory:deleteByFilter', { personaId: 'persona-1' })).toEqual({ deleted: 3 })
  })
})
