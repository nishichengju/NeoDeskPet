import type { MemoryService } from '../memoryService'
import type {
  AISettings,
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  MemoryListArgs,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryListResult,
  MemoryListVersionsArgs,
  MemoryRecord,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemorySettings,
  MemoryUpdateArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryUpsertManualArgs,
  MemoryVersionRecord,
  Persona,
  PersonaSummary,
} from '../types'
import type { IpcHandle } from './registration'

export type MemoryPersonaPatch = {
  name?: string
  prompt?: string
  captureEnabled?: boolean
  captureUser?: boolean
  captureAssistant?: boolean
  retrieveEnabled?: boolean
}

export type MemoryIpcService = Pick<
  MemoryService,
  | 'listPersonas'
  | 'getPersona'
  | 'createPersona'
  | 'updatePersona'
  | 'deletePersona'
  | 'retrieveContext'
  | 'listMemory'
  | 'upsertManualMemory'
  | 'updateMemory'
  | 'updateMemoryMeta'
  | 'updateManyMemoryMeta'
  | 'updateMemoryByFilterMeta'
  | 'listMemoryVersions'
  | 'rollbackMemoryVersion'
  | 'listMemoryConflicts'
  | 'resolveMemoryConflict'
  | 'deleteMemory'
  | 'deleteManyMemory'
  | 'deleteMemoryByFilter'
>

export type MemoryIpcDependencies = {
  handle: IpcHandle
  getMemoryService: () => MemoryIpcService | null
  getSettings: () => { memory: MemorySettings; ai: AISettings }
}

function requireMemoryService(getMemoryService: () => MemoryIpcService | null): MemoryIpcService {
  const memoryService = getMemoryService()
  if (!memoryService) throw new Error('Memory service not ready')
  return memoryService
}

export function registerMemoryIpc({ handle, getMemoryService, getSettings }: MemoryIpcDependencies): void {
  handle('memory:listPersonas', (): PersonaSummary[] => getMemoryService()?.listPersonas() ?? [])
  handle('memory:getPersona', (_event, personaId: string): Persona | null =>
    getMemoryService()?.getPersona(personaId) ?? null,
  )
  handle('memory:createPersona', (_event, name: string): Persona => requireMemoryService(getMemoryService).createPersona(name))
  handle('memory:updatePersona', (_event, personaId: string, patch: MemoryPersonaPatch): Persona =>
    requireMemoryService(getMemoryService).updatePersona(personaId, patch),
  )
  handle('memory:deletePersona', (_event, personaId: string): { ok: true } => {
    requireMemoryService(getMemoryService).deletePersona(personaId)
    return { ok: true }
  })
  handle('memory:retrieve', async (_event, args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => {
    const memoryService = getMemoryService()
    if (!memoryService) return { addon: '' }
    const settings = getSettings()
    if (!settings.memory.enabled) return { addon: '' }
    return memoryService.retrieveContext(args, settings.memory, settings.ai)
  })
  handle('memory:list', (_event, args: MemoryListArgs): MemoryListResult =>
    getMemoryService()?.listMemory(args) ?? { total: 0, items: [] },
  )
  handle('memory:upsertManual', async (_event, args: MemoryUpsertManualArgs): Promise<MemoryRecord> => {
    const memoryService = requireMemoryService(getMemoryService)
    const settings = getSettings()
    return memoryService.upsertManualMemory(args, settings.memory, settings.ai)
  })
  handle('memory:update', (_event, args: MemoryUpdateArgs): MemoryRecord =>
    requireMemoryService(getMemoryService).updateMemory(args),
  )
  handle('memory:updateMeta', (_event, args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult =>
    requireMemoryService(getMemoryService).updateMemoryMeta(args),
  )
  handle('memory:updateManyMeta', (_event, args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult =>
    requireMemoryService(getMemoryService).updateManyMemoryMeta(args),
  )
  handle('memory:updateByFilterMeta', (_event, args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult =>
    requireMemoryService(getMemoryService).updateMemoryByFilterMeta(args),
  )
  handle('memory:listVersions', (_event, args: MemoryListVersionsArgs): MemoryVersionRecord[] =>
    getMemoryService()?.listMemoryVersions(args) ?? [],
  )
  handle('memory:rollbackVersion', (_event, args: MemoryRollbackVersionArgs): MemoryRecord =>
    requireMemoryService(getMemoryService).rollbackMemoryVersion(args),
  )
  handle('memory:listConflicts', (_event, args: MemoryListConflictsArgs): MemoryListConflictsResult =>
    getMemoryService()?.listMemoryConflicts(args) ?? { total: 0, items: [] },
  )
  handle('memory:resolveConflict', (_event, args: MemoryResolveConflictArgs): MemoryResolveConflictResult =>
    requireMemoryService(getMemoryService).resolveMemoryConflict(args),
  )
  handle('memory:delete', (_event, args: MemoryDeleteArgs): { ok: true } =>
    requireMemoryService(getMemoryService).deleteMemory(args),
  )
  handle('memory:deleteMany', (_event, args: MemoryDeleteManyArgs): { deleted: number } =>
    requireMemoryService(getMemoryService).deleteManyMemory(args),
  )
  handle('memory:deleteByFilter', (_event, args: MemoryDeleteByFilterArgs): { deleted: number } =>
    requireMemoryService(getMemoryService).deleteMemoryByFilter(args),
  )
}
