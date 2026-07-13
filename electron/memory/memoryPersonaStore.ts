import { randomUUID } from 'node:crypto'
import { normalizePersonaStorageRow, type PersonaStorageRow } from '../personaRecord'
import type { Persona, PersonaSummary } from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'

export type MemoryPersonaPatch = {
  name?: string
  prompt?: string
  captureEnabled?: boolean
  captureUser?: boolean
  captureAssistant?: boolean
  retrieveEnabled?: boolean
}

export type MemoryPersonaStoreOptions = {
  now?: () => number
  createId?: () => string
}

export class MemoryPersonaStore {
  private readonly db: MemoryDatabaseHandle
  private readonly now: () => number
  private readonly createId: () => string

  constructor(db: MemoryDatabaseHandle, options: MemoryPersonaStoreOptions = {}) {
    this.db = db
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  list(): PersonaSummary[] {
    return this.db
      .prepare('SELECT id, name, updated_at as updatedAt FROM persona ORDER BY updated_at DESC')
      .all() as PersonaSummary[]
  }

  get(personaId: string): Persona | null {
    const row = this.db
      .prepare(
        `
        SELECT
          id,
          name,
          prompt,
          capture_enabled as captureEnabled,
          capture_user as captureUser,
          capture_assistant as captureAssistant,
          retrieve_enabled as retrieveEnabled,
          created_at as createdAt,
          updated_at as updatedAt
        FROM persona
        WHERE id = ?
        `,
      )
      .get(personaId) as PersonaStorageRow | undefined
    return normalizePersonaStorageRow(row)
  }

  create(name: string): Persona {
    const cleaned = name.trim() || '未命名角色'
    const id = this.createId()
    const timestamp = this.now()
    this.db
      .prepare(
        'INSERT INTO persona (id, name, prompt, capture_enabled, capture_user, capture_assistant, retrieve_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, cleaned, '', 1, 1, 1, 1, timestamp, timestamp)
    const persona = this.get(id)
    if (!persona) throw new Error('创建角色失败')
    return persona
  }

  update(personaId: string, patch: MemoryPersonaPatch): Persona {
    const current = this.get(personaId)
    if (!current) throw new Error('角色不存在')

    const nextName = typeof patch.name === 'string' ? patch.name.trim() || current.name : current.name
    const nextPrompt = typeof patch.prompt === 'string' ? patch.prompt : current.prompt
    const nextCaptureEnabled =
      typeof patch.captureEnabled === 'boolean' ? patch.captureEnabled : current.captureEnabled
    const nextCaptureUser = typeof patch.captureUser === 'boolean' ? patch.captureUser : current.captureUser
    const nextCaptureAssistant =
      typeof patch.captureAssistant === 'boolean' ? patch.captureAssistant : current.captureAssistant
    const nextRetrieveEnabled =
      typeof patch.retrieveEnabled === 'boolean' ? patch.retrieveEnabled : current.retrieveEnabled
    const timestamp = this.now()

    this.db
      .prepare(
        'UPDATE persona SET name = ?, prompt = ?, capture_enabled = ?, capture_user = ?, capture_assistant = ?, retrieve_enabled = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        nextName,
        nextPrompt,
        nextCaptureEnabled ? 1 : 0,
        nextCaptureUser ? 1 : 0,
        nextCaptureAssistant ? 1 : 0,
        nextRetrieveEnabled ? 1 : 0,
        timestamp,
        personaId,
      )
    const updated = this.get(personaId)
    if (!updated) throw new Error('更新角色失败')
    return updated
  }

  delete(personaId: string): void {
    if (personaId === 'default') throw new Error('默认角色不可删除')
    this.db.prepare('DELETE FROM persona WHERE id = ?').run(personaId)
  }
}
