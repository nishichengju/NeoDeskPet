import { describe, expect, it } from 'vitest'
import { normalizePersonaStorageRow, type PersonaStorageRow } from '../electron/personaRecord'

function row(overrides: Partial<PersonaStorageRow> = {}): PersonaStorageRow {
  return {
    id: 'persona-1',
    name: 'Persona',
    prompt: '',
    captureEnabled: 1,
    captureUser: 0,
    captureAssistant: 1,
    retrieveEnabled: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('persona storage row normalization', () => {
  it('converts SQLite 0/1 flags to real booleans', () => {
    expect(normalizePersonaStorageRow(row())).toMatchObject({
      captureEnabled: true,
      captureUser: false,
      captureAssistant: true,
      retrieveEnabled: false,
    })
  })

  it('preserves boolean inputs and handles missing rows', () => {
    expect(normalizePersonaStorageRow(row({ captureEnabled: false, captureUser: true }))).toMatchObject({
      captureEnabled: false,
      captureUser: true,
    })
    expect(normalizePersonaStorageRow(null)).toBeNull()
  })
})
