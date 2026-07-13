import { MemoryCatalog } from './memory/memoryCatalog'
import { openMemoryDatabase, type MemoryDatabaseHandle } from './memory/memoryDatabase'
import { MemoryEmbeddingClient } from './memory/memoryEmbeddingClient'
import { MemoryIndexQueue } from './memory/memoryIndexQueue'
import { MemoryKgIndexMaintainer } from './memory/memoryKgIndex'
import { MemoryPersonaStore, type MemoryPersonaPatch } from './memory/memoryPersonaStore'
import { MemoryRetrievalEngine } from './memory/memoryRetrieval'
import { MemoryRecordStore } from './memory/memoryRecordStore'
import { MemoryRetentionMaintainer } from './memory/memoryRetention'
import { MemoryRevisionCoordinator } from './memory/memoryRevisionCoordinator'
import { MemoryTagIndexMaintainer } from './memory/memoryTagIndex'
import { MemoryVectorIndexMaintainer } from './memory/memoryVectorIndex'
import { MemoryVectorSearchClient } from './memory/memoryVectorSearchClient'
import {
  MemoryWriteCoordinator,
  type MemoryIngestChatMessageArgs,
} from './memory/memoryWriteCoordinator'
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
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryVersionRecord,
  MemoryRecord,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemoryUpdateArgs,
  MemoryUpsertManualArgs,
  MemorySettings,
  Persona,
  PersonaSummary,
} from './types'
export type { MemoryIngestChatMessageArgs } from './memory/memoryWriteCoordinator'

export class MemoryService {
  private db: MemoryDatabaseHandle
  private catalog: MemoryCatalog
  private indexQueue = new MemoryIndexQueue()
  private embeddingClient = new MemoryEmbeddingClient()
  private kgIndexMaintainer: MemoryKgIndexMaintainer
  private personaStore: MemoryPersonaStore
  private recordStore: MemoryRecordStore
  private retentionMaintainer: MemoryRetentionMaintainer
  private revisionCoordinator: MemoryRevisionCoordinator
  private tagIndexMaintainer: MemoryTagIndexMaintainer
  private vectorIndexMaintainer: MemoryVectorIndexMaintainer
  private retrievalEngine: MemoryRetrievalEngine
  private vectorSearchClient: MemoryVectorSearchClient
  private writeCoordinator: MemoryWriteCoordinator

  constructor(userDataDir: string) {
    const opened = openMemoryDatabase(userDataDir)
    this.db = opened.db
    this.catalog = new MemoryCatalog(opened.db)
    this.kgIndexMaintainer = new MemoryKgIndexMaintainer(opened.db, this.indexQueue)
    this.personaStore = new MemoryPersonaStore(opened.db)
    this.recordStore = new MemoryRecordStore(opened.db)
    this.retentionMaintainer = new MemoryRetentionMaintainer(opened.db)
    this.revisionCoordinator = new MemoryRevisionCoordinator(opened.db, this.indexQueue, this.recordStore)
    this.tagIndexMaintainer = new MemoryTagIndexMaintainer(opened.db, this.indexQueue)
    this.vectorIndexMaintainer = new MemoryVectorIndexMaintainer(opened.db, this.indexQueue, this.embeddingClient)
    this.vectorSearchClient = new MemoryVectorSearchClient(opened.dbPath)
    this.retrievalEngine = new MemoryRetrievalEngine(
      opened.db,
      this.embeddingClient,
      this.vectorSearchClient,
      (personaId) => this.getPersona(personaId),
    )
    this.writeCoordinator = new MemoryWriteCoordinator(
      opened.db,
      this.indexQueue,
      this.embeddingClient,
      (personaId) => this.getPersona(personaId),
      this.recordStore,
    )
  }

  close(): void {
    this.vectorSearchClient.close()
    this.db.close()
  }

  /** 注册"有新索引工作入队"的通知回调（debounce 由调用方负责） */
  setMaintenanceKick(cb: (() => void) | null): void {
    this.indexQueue.setKick(cb)
  }

  listPersonas(): PersonaSummary[] {
    return this.personaStore.list()
  }

  getPersona(personaId: string): Persona | null {
    return this.personaStore.get(personaId)
  }

  createPersona(name: string): Persona {
    return this.personaStore.create(name)
  }

  updatePersona(personaId: string, patch: MemoryPersonaPatch): Persona {
    return this.personaStore.update(personaId, patch)
  }

  deletePersona(personaId: string): void {
    this.personaStore.delete(personaId)
  }

  async ingestChatMessage(
    args: MemoryIngestChatMessageArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<void> {
    return this.writeCoordinator.ingestChatMessage(args, memSettings, aiSettings)
  }

  runTagMaintenance(settings: MemorySettings, opts?: { batchSize?: number }): { scanned: number; updated: number } {
    return this.tagIndexMaintainer.run(settings, opts)
  }

  async runVectorEmbeddingMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; embedded: number; skipped: number; error?: string }> {
    return this.vectorIndexMaintainer.run(memSettings, aiSettings, opts)
  }

  async runKgMaintenance(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    opts?: { batchSize?: number },
  ): Promise<{ scanned: number; extracted: number; skipped: number; error?: string }> {
    return this.kgIndexMaintainer.run(memSettings, aiSettings, opts)
  }

  listMemory(args: MemoryListArgs): MemoryListResult {
    return this.catalog.list(args)
  }

  async upsertManualMemory(
    args: MemoryUpsertManualArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<MemoryRecord> {
    return this.writeCoordinator.upsertManualMemory(args, memSettings, aiSettings)
  }

  updateMemory(args: MemoryUpdateArgs): MemoryRecord {
    return this.revisionCoordinator.updateMemory(args)
  }

  updateMemoryMeta(args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult {
    return this.catalog.updateMeta(args)
  }

  updateManyMemoryMeta(args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult {
    return this.catalog.updateManyMeta(args)
  }

  updateMemoryByFilterMeta(args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult {
    return this.catalog.updateByFilterMeta(args)
  }

  deleteMemory(args: MemoryDeleteArgs): { ok: true } {
    return this.catalog.delete(args)
  }

  deleteManyMemory(args: MemoryDeleteManyArgs): { deleted: number } {
    return this.catalog.deleteMany(args)
  }

  deleteMemoryByFilter(args: MemoryDeleteByFilterArgs): { deleted: number } {
    return this.catalog.deleteByFilter(args)
  }

  listMemoryVersions(args: MemoryListVersionsArgs): MemoryVersionRecord[] {
    return this.revisionCoordinator.listMemoryVersions(args)
  }

  rollbackMemoryVersion(args: MemoryRollbackVersionArgs): MemoryRecord {
    return this.revisionCoordinator.rollbackMemoryVersion(args)
  }

  listMemoryConflicts(args: MemoryListConflictsArgs): MemoryListConflictsResult {
    return this.revisionCoordinator.listMemoryConflicts(args)
  }

  resolveMemoryConflict(args: MemoryResolveConflictArgs): MemoryResolveConflictResult {
    return this.revisionCoordinator.resolveMemoryConflict(args)
  }

  runRetentionMaintenance(opts?: {
    batchSize?: number
    minIdleMs?: number
    archiveThreshold?: number
  }): { scanned: number; updated: number; archived: number } {
    return this.retentionMaintainer.run(opts)
  }

  async retrieveContext(
    args: MemoryRetrieveArgs,
    memSettings: MemorySettings,
    aiSettings: AISettings,
  ): Promise<MemoryRetrieveResult> {
    return this.retrievalEngine.retrieve(args, memSettings, aiSettings)
  }

}
