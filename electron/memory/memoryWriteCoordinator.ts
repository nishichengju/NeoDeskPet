import { randomUUID } from 'node:crypto'
import type {
  AISettings,
  MemoryRecord,
  MemorySettings,
  MemoryUpsertManualArgs,
  Persona,
} from '../types'
import {
  hashMemoryEmbeddingInput,
  resolveMemoryEmbeddingConfig,
  type MemoryEmbeddingClient,
} from './memoryEmbeddingClient'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { MemoryIndexQueue } from './memoryIndexQueue'
import { MemoryRecordStore } from './memoryRecordStore'

export type MemoryIngestChatMessageArgs = {
  personaId: string
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export type MemoryWriteCoordinatorOptions = {
  now?: () => number
  createId?: () => string
  maxChatRedirects?: number
}

type EmbeddingRow = {
  rowid: number
  content: string
  updatedAt: number
}

type StoredEmbedding = {
  model: string
  hash: string
  vec: Float32Array
}

type VectorDuplicate = {
  rowid: number
  sim: number
  content: string
  createdAt: number
  updatedAt: number
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function normalizeMemoryText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeForComparison(text: string): string {
  return normalizeMemoryText(text).replace(/\s+/g, '')
}

function extractKeyValue(textRaw: string): { key: string; value: string } | null {
  const text = normalizeMemoryText(textRaw)
  if (!text) return null

  const colon = text.match(/^(.{2,20})[：:]\s*(.{1,80})$/u)
  if (colon) {
    const key = colon[1].trim()
    const value = colon[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  const eq = text.match(/^(.{2,20})\s*[=＝]\s*(.{1,80})$/u)
  if (eq) {
    const key = eq[1].trim()
    const value = eq[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  const shi = text.match(/^(.{2,18})是(.{1,80})$/u)
  if (shi) {
    const key = shi[1].trim()
    const value = shi[2].trim()
    if (key.length >= 2 && value.length >= 1) return { key, value }
  }

  return null
}

function extractTurnUserText(turnRaw: string): string {
  const turn = String(turnRaw ?? '').trim()
  if (!turn) return ''
  const match = turn.match(/用户：([\s\S]*?)(?:\r?\n助手：|$)/)
  return (match?.[1] ?? '').trim()
}

function extractTurnAssistantText(turnRaw: string): string {
  const turn = String(turnRaw ?? '').trim()
  if (!turn) return ''
  const match = turn.match(/\r?\n助手：([\s\S]*)$/)
  return (match?.[1] ?? '').trim()
}

function mergeTurnContent(baseRaw: string, candidateRaw: string): string {
  const base = String(baseRaw ?? '').trim()
  const candidate = String(candidateRaw ?? '').trim()
  if (!base) return candidate
  if (!candidate) return base

  const baseUser = extractTurnUserText(base)
  const candidateUser = extractTurnUserText(candidate)
  const baseUserNormalized = normalizeForComparison(baseUser)
  const candidateUserNormalized = normalizeForComparison(candidateUser)
  let finalUser = baseUser
  if (
    candidateUserNormalized &&
    (candidateUserNormalized.length > baseUserNormalized.length || candidateUserNormalized.includes(baseUserNormalized))
  ) {
    finalUser = candidateUser
  }

  const baseAssistant = extractTurnAssistantText(base)
  const candidateAssistant = extractTurnAssistantText(candidate)
  const baseAssistantNormalized = normalizeForComparison(baseAssistant)
  const candidateAssistantNormalized = normalizeForComparison(candidateAssistant)
  let finalAssistant = baseAssistant
  if (
    candidateAssistantNormalized &&
    (candidateAssistantNormalized.length > baseAssistantNormalized.length ||
      candidateAssistantNormalized.includes(baseAssistantNormalized))
  ) {
    finalAssistant = candidateAssistant
  }

  if (finalUser.trim() && finalAssistant.trim()) {
    return `用户：${finalUser.trim()}\n助手：${finalAssistant.trim()}`.trim()
  }
  return candidate || base
}

function mergeManualNoteContent(baseRaw: string, candidateRaw: string): string {
  const base = baseRaw.trim()
  const candidate = candidateRaw.trim()
  if (!base) return candidate
  if (!candidate) return base

  const baseNormalized = normalizeForComparison(base)
  const candidateNormalized = normalizeForComparison(candidate)
  if (!baseNormalized) return candidate
  if (!candidateNormalized) return base
  if (baseNormalized === candidateNormalized) return base
  if (candidateNormalized.includes(baseNormalized)) return candidate
  if (baseNormalized.includes(candidateNormalized)) return base

  const baseKeyValue = extractKeyValue(base)
  const candidateKeyValue = extractKeyValue(candidate)
  if (baseKeyValue && candidateKeyValue && baseKeyValue.key === candidateKeyValue.key) {
    return `${candidateKeyValue.key}：${candidateKeyValue.value}`
  }

  if (candidate.length >= base.length + 8) return candidate
  if (base.length >= candidate.length + 8) return base

  const merged = `${base}；${candidate}`.replace(/\s+/g, ' ').trim()
  return merged.length > 600 ? merged.slice(0, 600) : merged
}

function float32View(blob: Uint8Array): Float32Array | null {
  if (blob.byteLength < 8 * 4 || blob.byteLength % 4 !== 0) return null
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
  }
  const copy = Uint8Array.from(blob)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}

export class MemoryWriteCoordinator {
  private readonly db: MemoryDatabaseHandle
  private readonly indexQueue: MemoryIndexQueue
  private readonly embeddingClient: Pick<MemoryEmbeddingClient, 'embedTexts'>
  private readonly getPersona: (personaId: string) => Persona | null
  private readonly records: MemoryRecordStore
  private readonly now: () => number
  private readonly createId: () => string
  private readonly maxChatRedirects: number
  private readonly chatIngestRedirect = new Map<string, number>()

  constructor(
    db: MemoryDatabaseHandle,
    indexQueue: MemoryIndexQueue,
    embeddingClient: Pick<MemoryEmbeddingClient, 'embedTexts'>,
    getPersona: (personaId: string) => Persona | null,
    records: MemoryRecordStore,
    options: MemoryWriteCoordinatorOptions = {},
  ) {
    this.db = db
    this.indexQueue = indexQueue
    this.embeddingClient = embeddingClient
    this.getPersona = getPersona
    this.records = records
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.maxChatRedirects = clampInt(options.maxChatRedirects, 600, 1, 10_000)
  }

  async ingestChatMessage(
    args: MemoryIngestChatMessageArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<void> {
    const personaId = args.personaId.trim() || 'default'
    const persona = this.getPersona(personaId)
    if (persona) {
      if (!persona.captureEnabled) return
      if (args.role === 'user' && !persona.captureUser) return
      if (args.role === 'assistant' && !persona.captureAssistant) return
    }

    const content = args.content.trim()
    if (!content) return

    const createdAt = args.createdAt || this.now()
    const updatedAt = this.now()
    const source = args.role === 'assistant' ? 'assistant_msg' : 'user_msg'
    const importance = args.role === 'user' ? 0.25 : 0.15
    const strength = 0.15
    const turnKey = `${args.sessionId}\n${args.messageId}`
    const redirected = this.chatIngestRedirect.get(turnKey)

    if (redirected && redirected > 0) {
      const target = this.records.getByRowid(redirected)
      if (!target || target.status === 'deleted') {
        this.chatIngestRedirect.delete(turnKey)
      } else {
        const merged = mergeTurnContent(target.content, content)
        if (normalizeForComparison(merged) !== normalizeForComparison(target.content)) {
          this.records.addVersion({
            memoryRowid: redirected,
            oldContent: target.content,
            newContent: merged,
            reason: 'vector_dedupe_merge',
            source,
            createdAt: updatedAt,
          })
        }
        this.db
          .prepare(
            "UPDATE memory SET content = ?, created_at = MIN(created_at, ?), updated_at = ?, retention = 1, strength = MIN(1, strength + 0.01), status = 'active', source = ? WHERE rowid = ?",
          )
          .run(merged, createdAt, updatedAt, source, redirected)
        await this.refreshEmbeddingBestEffort(redirected, merged, updatedAt, memSettings, aiSettings)
        this.indexQueue.enqueueAll(redirected)
        return
      }
    }

    this.db
      .prepare(
        `
        INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, message_id) DO UPDATE SET
          persona_id = excluded.persona_id,
          scope = excluded.scope,
          kind = excluded.kind,
          role = excluded.role,
          content = excluded.content,
          created_at = MIN(created_at, excluded.created_at),
          updated_at = excluded.updated_at,
          source = excluded.source
        `,
      )
      .run(
        this.createId(),
        personaId,
        'persona',
        'chat_message',
        args.role,
        args.sessionId,
        args.messageId,
        content,
        createdAt,
        updatedAt,
        importance,
        strength,
        'episodic',
        source,
      )

    let rowid = 0
    try {
      const inserted = this.db
        .prepare('SELECT rowid as rowid FROM memory WHERE session_id = ? AND message_id = ? LIMIT 1')
        .get(args.sessionId, args.messageId) as { rowid?: number } | undefined
      rowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
    } catch {
      rowid = 0
    }
    if (rowid <= 0) return

    let vector: Float32Array | null = null
    try {
      const embedded = await this.ensureEmbeddingsForRows([{ rowid, content, updatedAt }], memSettings, aiSettings)
      vector = embedded.get(rowid)?.vec ?? null
    } catch {
      vector = null
    }

    if (vector && vector.length >= 8) {
      try {
        const duplicate = await this.findBestVectorDuplicate({
          personaId,
          scope: 'persona',
          kind: 'chat_message',
          role: args.role,
          excludeRowid: rowid,
          vec: vector,
          threshold: clampFloat(memSettings?.vectorDedupeThreshold, 0.9, 0.1, 0.99),
          memSettings,
          aiSettings,
        })

        if (duplicate && duplicate.rowid > 0) {
          const merged = mergeTurnContent(duplicate.content, content)
          if (normalizeForComparison(merged) !== normalizeForComparison(duplicate.content)) {
            this.records.addVersion({
              memoryRowid: duplicate.rowid,
              oldContent: duplicate.content,
              newContent: merged,
              reason: 'vector_dedupe_merge',
              source,
              createdAt: updatedAt,
            })
          }

          this.db
            .prepare(
              "UPDATE memory SET content = ?, created_at = MIN(created_at, ?), updated_at = ?, retention = 1, strength = MIN(1, strength + 0.01), status = 'active', source = ? WHERE rowid = ?",
            )
            .run(merged, createdAt, updatedAt, source, duplicate.rowid)
          this.db.prepare("UPDATE memory SET status = 'deleted', updated_at = ? WHERE rowid = ?").run(updatedAt, rowid)
          this.rememberChatIngestRedirect(turnKey, duplicate.rowid)
          await this.refreshEmbeddingBestEffort(duplicate.rowid, merged, updatedAt, memSettings, aiSettings)
          this.indexQueue.enqueueAll(duplicate.rowid)
          return
        }
      } catch {
        // Vector dedupe is best-effort; the inserted chat row remains valid on failure.
      }
    }

    this.indexQueue.enqueueAll(rowid)
  }

  async upsertManualMemory(
    args: MemoryUpsertManualArgs,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<MemoryRecord> {
    const personaId = args.personaId.trim() || 'default'
    const content = args.content.trim()
    if (!content) throw new Error('内容不能为空')

    const scope = args.scope
    const storedPersonaId = scope === 'shared' ? null : personaId
    const timestamp = this.now()
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'manual'
    const memoryType =
      typeof args.memoryType === 'string' && args.memoryType.trim() ? args.memoryType.trim() : 'semantic'
    const importance = clampFloat(args.importance, 0.75, 0, 1)
    const strength = clampFloat(args.strength, 0.6, 0, 1)
    const threshold = clampFloat(memSettings?.vectorDedupeThreshold, 0.9, 0.1, 0.99)
    const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings)
    const normalized = normalizeMemoryText(content)

    if (config && normalized.length >= 3) {
      try {
        const vector = (await this.embeddingClient.embedTexts(config, [normalized]))[0]?.vec ?? null
        if (vector && vector.length >= 8) {
          const duplicate = await this.findBestVectorDuplicate({
            personaId: storedPersonaId,
            scope,
            kind: 'manual_note',
            role: 'note',
            excludeRowid: 0,
            vec: vector,
            threshold,
            memSettings,
            aiSettings,
          })

          if (duplicate && duplicate.rowid > 0) {
            const existing = this.records.getByRowid(duplicate.rowid)
            if (!existing) throw new Error('重复检测命中，但记录不存在')

            const mergedContent = mergeManualNoteContent(existing.content, content)
            if (normalizeForComparison(mergedContent) === normalizeForComparison(existing.content)) {
              this.db
                .prepare(
                  "UPDATE memory SET updated_at = ?, importance = MAX(importance, ?), strength = MIN(1, MAX(strength, ?) + 0.01), retention = 1, status = 'active' WHERE rowid = ?",
                )
                .run(timestamp, importance, strength, duplicate.rowid)
              const refreshed = this.records.getByRowid(duplicate.rowid)
              if (!refreshed) throw new Error('重复检测命中，但记录不存在')
              return refreshed
            }

            this.records.addVersion({
              memoryRowid: duplicate.rowid,
              oldContent: existing.content,
              newContent: mergedContent,
              reason: 'vector_dedupe_merge',
              source,
              createdAt: timestamp,
            })
            this.db
              .prepare(
                "UPDATE memory SET content = ?, updated_at = ?, importance = MAX(importance, ?), strength = MIN(1, MAX(strength, ?) + 0.05), retention = 1, status = 'active', memory_type = ?, source = ? WHERE rowid = ?",
              )
              .run(mergedContent, timestamp, importance, strength, memoryType, source, duplicate.rowid)
            await this.refreshEmbeddingBestEffort(
              duplicate.rowid,
              mergedContent,
              timestamp,
              memSettings,
              aiSettings,
            )

            const updated = this.records.getByRowid(duplicate.rowid)
            if (!updated) throw new Error('重复合并命中，但记录不存在')
            this.indexQueue.enqueueAll(updated.rowid)
            return updated
          }
        }
      } catch {
        // Manual writes fall back to a new row when vector setup or dedupe fails.
      }
    }

    this.db
      .prepare(
        'INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at, updated_at, importance, strength, memory_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.createId(),
        storedPersonaId,
        scope,
        'manual_note',
        'note',
        null,
        null,
        content,
        timestamp,
        timestamp,
        importance,
        strength,
        memoryType,
        source,
      )

    const inserted = this.db.prepare('SELECT rowid as rowid FROM memory WHERE rowid = last_insert_rowid()').get() as
      | { rowid?: number }
      | undefined
    const rowid = clampInt(inserted?.rowid, 0, 1, 2_000_000_000)
    const record = rowid > 0 ? this.records.getByRowid(rowid) : null
    if (!record) throw new Error('写入失败')

    await this.refreshEmbeddingBestEffort(record.rowid, record.content, timestamp, memSettings, aiSettings)
    this.indexQueue.enqueueAll(record.rowid)
    return record
  }

  private rememberChatIngestRedirect(key: string, rowid: number): void {
    if (!key.trim() || rowid <= 0) return
    if (this.chatIngestRedirect.has(key)) this.chatIngestRedirect.delete(key)
    this.chatIngestRedirect.set(key, rowid)
    while (this.chatIngestRedirect.size > this.maxChatRedirects) {
      const oldest = this.chatIngestRedirect.keys().next().value as string | undefined
      if (!oldest) break
      this.chatIngestRedirect.delete(oldest)
    }
  }

  private async refreshEmbeddingBestEffort(
    rowid: number,
    content: string,
    updatedAt: number,
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<void> {
    try {
      await this.ensureEmbeddingsForRows([{ rowid, content, updatedAt }], memSettings, aiSettings)
    } catch {
      // Embeddings are optional and background maintenance can retry later.
    }
  }

  private async ensureEmbeddingsForRows(
    rows: EmbeddingRow[],
    memSettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ): Promise<Map<number, StoredEmbedding>> {
    const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings)
    if (!config) return new Map()

    const picked = rows.filter((row) => row.rowid > 0 && normalizeMemoryText(row.content).length >= 2)
    if (picked.length === 0) return new Map()

    const rowids = Array.from(new Set(picked.map((row) => row.rowid)))
    const placeholders = rowids.map(() => '?').join(',')
    type ExistingEmbedding = {
      rowid: number
      model: string
      contentHash: string
      embedding: Uint8Array
      updatedAt: number
    }
    const existingRows = this.db
      .prepare(
        `
        SELECT
          memory_rowid as rowid,
          model as model,
          content_hash as contentHash,
          embedding as embedding,
          updated_at as updatedAt
        FROM memory_embedding
        WHERE memory_rowid IN (${placeholders})
        `,
      )
      .all(...rowids) as ExistingEmbedding[]
    const existingByRowid = new Map(existingRows.map((row) => [row.rowid, row]))
    const needed: Array<{ rowid: number; text: string; hash: string }> = []
    const output = new Map<number, StoredEmbedding>()

    for (const row of picked) {
      const text = normalizeMemoryText(row.content).slice(0, 2000)
      const hash = hashMemoryEmbeddingInput(config.model, text)
      const existing = existingByRowid.get(row.rowid)
      if (
        existing &&
        existing.model === config.model &&
        existing.contentHash === hash &&
        (existing.updatedAt ?? 0) >= (row.updatedAt ?? 0)
      ) {
        const vector = float32View(existing.embedding)
        if (vector) {
          output.set(row.rowid, { model: config.model, hash, vec: vector })
          continue
        }
      }
      needed.push({ rowid: row.rowid, text, hash })
    }

    if (needed.length === 0) return output

    const embedded = await this.embeddingClient.embedTexts(
      config,
      needed.map((item) => item.text),
    )
    const timestamp = this.now()
    const upsert = this.db.prepare(
      `
      INSERT INTO memory_embedding (memory_rowid, model, dims, content_hash, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_rowid) DO UPDATE SET
        model = excluded.model,
        dims = excluded.dims,
        content_hash = excluded.content_hash,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
      `,
    )
    const transaction = this.db.transaction(() => {
      for (let index = 0; index < needed.length; index += 1) {
        const item = needed[index]
        const vector = embedded[index].vec
        const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
        upsert.run(item.rowid, config.model, vector.length, item.hash, buffer, timestamp, timestamp)
        output.set(item.rowid, { model: config.model, hash: item.hash, vec: vector })
      }
    })
    transaction()
    return output
  }

  private async findBestVectorDuplicate(options: {
    personaId: string | null
    scope: 'persona' | 'shared'
    kind: string
    role: string | null
    excludeRowid?: number
    vec: Float32Array
    threshold: number
    memSettings: MemorySettings | undefined
    aiSettings: AISettings
  }): Promise<VectorDuplicate | null> {
    const { vec, threshold } = options
    if (vec.length < 8) return null

    const config = resolveMemoryEmbeddingConfig(options.memSettings, options.aiSettings)
    if (!config) return null

    const scanLimit = 400
    const embedBatchLimit = 40
    const excludeRowid = clampInt(options.excludeRowid, 0, 0, 2_000_000_000)
    const wherePersona = options.personaId === null ? 'm.persona_id IS NULL' : 'm.persona_id = ?'
    const params: unknown[] = [config.model]
    if (options.personaId !== null) params.push(options.personaId)
    params.push(options.scope, options.kind)
    if (options.role === null) {
      params.push(excludeRowid, scanLimit)
    } else {
      params.push(options.role, excludeRowid, scanLimit)
    }

    type Candidate = {
      rowid: number
      content: string
      createdAt: number
      updatedAt: number
      embedding: Uint8Array | null
    }
    const rows = this.db
      .prepare(
        `
        SELECT
          m.rowid as rowid,
          m.content as content,
          m.created_at as createdAt,
          m.updated_at as updatedAt,
          e.embedding as embedding
        FROM memory m
        LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid AND e.model = ?
        WHERE ${wherePersona}
          AND m.scope = ?
          AND m.kind = ?
          ${options.role === null ? '' : 'AND m.role = ?'}
          AND COALESCE(m.status, 'active') <> 'deleted'
          AND m.rowid <> ?
        ORDER BY m.updated_at DESC, m.rowid DESC
        LIMIT ?
        `,
      )
      .all(...params) as Candidate[]
    if (rows.length === 0) return null

    const missing = rows
      .filter((row) => !row.embedding)
      .slice(0, embedBatchLimit)
      .map((row) => ({ rowid: row.rowid, content: row.content, updatedAt: row.updatedAt }))
    if (missing.length > 0) {
      try {
        await this.ensureEmbeddingsForRows(missing, options.memSettings, options.aiSettings)
      } catch {
        // Existing candidates without embeddings are skipped when hydration fails.
      }
    }

    let best: VectorDuplicate | null = null
    for (const row of rows) {
      let blob = row.embedding
      if (!blob) {
        const fetched = this.db
          .prepare('SELECT embedding as embedding FROM memory_embedding WHERE memory_rowid = ? AND model = ? LIMIT 1')
          .get(row.rowid, config.model) as { embedding?: Uint8Array } | undefined
        blob = fetched?.embedding ?? null
      }
      if (!blob) continue
      const candidateVector = float32View(blob)
      if (!candidateVector || candidateVector.length !== vec.length) continue

      let similarity = 0
      for (let index = 0; index < candidateVector.length; index += 1) {
        similarity += vec[index] * candidateVector[index]
      }
      if (!Number.isFinite(similarity) || similarity < threshold) continue
      if (!best || similarity > best.sim) {
        best = {
          rowid: row.rowid,
          sim: similarity,
          content: row.content,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      }
    }
    return best
  }
}
