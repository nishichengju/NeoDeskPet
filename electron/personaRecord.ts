import type { Persona } from './types'

export type PersonaStorageRow = Omit<
  Persona,
  'captureEnabled' | 'captureUser' | 'captureAssistant' | 'retrieveEnabled'
> & {
  captureEnabled: boolean | number
  captureUser: boolean | number
  captureAssistant: boolean | number
  retrieveEnabled: boolean | number
}

export function normalizePersonaStorageRow(row: PersonaStorageRow | null | undefined): Persona | null {
  if (!row) return null
  return {
    ...row,
    captureEnabled: row.captureEnabled === true || row.captureEnabled === 1,
    captureUser: row.captureUser === true || row.captureUser === 1,
    captureAssistant: row.captureAssistant === true || row.captureAssistant === 1,
    retrieveEnabled: row.retrieveEnabled === true || row.retrieveEnabled === 1,
  }
}
