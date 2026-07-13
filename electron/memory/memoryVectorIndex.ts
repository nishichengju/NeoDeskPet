import type { AISettings, MemorySettings } from '../types'
import {
  MemoryEmbeddingClient,
  hashMemoryEmbeddingInput,
  normalizeMemoryEmbeddingText,
  resolveMemoryEmbeddingConfig,
} from './memoryEmbeddingClient'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { MemoryIndexQueue } from './memoryIndexQueue'

export type MemoryVectorMaintenanceResult = {
  scanned: number
  embedded: number
  skipped: number
  error?: string
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

type VectorCandidate = {
  rowid: number
  content: string
  updatedAt: number
  existModel: string | null
  existHash: string | null
  existUpdatedAt: number | null
}

export class MemoryVectorIndexMaintainer {
  private readonly db: MemoryDatabaseHandle
  private readonly queue: MemoryIndexQueue
  private readonly embeddingClient: MemoryEmbeddingClient
  private readonly now: () => number

  constructor(
    db: MemoryDatabaseHandle,
    queue: MemoryIndexQueue,
    embeddingClient: MemoryEmbeddingClient,
    now: () => number = Date.now,
  ) {
    this.db = db
    this.queue = queue
    this.embeddingClient = embeddingClient
    this.now = now
  }

  async run(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    options: { batchSize?: number } = {},
  ): Promise<MemoryVectorMaintenanceResult> {
    if ((memSettings.vectorEnabled ?? false) === false) return { scanned: 0, embedded: 0, skipped: 0 }

    const model = (memSettings.vectorEmbeddingModel ?? '').trim()
    if (!model) return { scanned: 0, embedded: 0, skipped: 0, error: 'embeddings 模型为空' }

    const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings, { requireExplicitModel: true })
    if (!config) {
      return { scanned: 0, embedded: 0, skipped: 0, error: 'embeddings API 未配置（缺少 apiKey/baseUrl）' }
    }

    const batchSize = clampInt(options.batchSize, 8, 1, 64)
    const pending = this.queue.take('embedding', batchSize)
    const rows: VectorCandidate[] = []

    if (pending.length > 0) {
      const placeholders = pending.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.content as content,
              m.updated_at as updatedAt,
              e.model as existModel,
              e.content_hash as existHash,
              e.updated_at as existUpdatedAt
            FROM memory m
            LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid
            WHERE m.rowid IN (${placeholders})
              AND COALESCE(m.status, 'active') <> 'deleted'
              AND LENGTH(TRIM(m.content)) >= 2
            `,
          )
          .all(...pending) as VectorCandidate[]),
      )
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const pendingExclusion = pending.length > 0 ? `AND m.rowid NOT IN (${pending.map(() => '?').join(',')})` : ''
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.content as content,
              m.updated_at as updatedAt,
              e.model as existModel,
              e.content_hash as existHash,
              e.updated_at as existUpdatedAt
            FROM memory m
            LEFT JOIN memory_embedding e ON e.memory_rowid = m.rowid
            WHERE COALESCE(m.status, 'active') <> 'deleted'
              AND LENGTH(TRIM(m.content)) >= 2
              AND (e.memory_rowid IS NULL OR e.model <> ? OR e.updated_at < m.updated_at)
              ${pendingExclusion}
            ORDER BY m.updated_at DESC, m.rowid DESC
            LIMIT ?
            `,
          )
          .all(model, ...pending, remaining) as VectorCandidate[]),
      )
    }

    if (rows.length === 0) return { scanned: 0, embedded: 0, skipped: 0 }

    const toEmbed: Array<{ rowid: number; text: string; hash: string }> = []
    const toTouch: number[] = []
    for (const row of rows) {
      const text = normalizeMemoryEmbeddingText(row.content).slice(0, 2000)
      const hash = hashMemoryEmbeddingInput(model, text)
      if (
        row.existModel === model &&
        row.existHash === hash &&
        (row.existUpdatedAt ?? 0) >= (row.updatedAt ?? 0)
      ) {
        toTouch.push(row.rowid)
      } else {
        toEmbed.push({ rowid: row.rowid, text, hash })
      }
    }

    if (toTouch.length > 0) {
      const placeholders = toTouch.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE memory_embedding SET updated_at = ? WHERE memory_rowid IN (${placeholders})`)
        .run(this.now(), ...toTouch)
    }

    if (toEmbed.length === 0) return { scanned: rows.length, embedded: 0, skipped: toTouch.length }

    try {
      const embedded = await this.embeddingClient.embedTexts(
        config,
        toEmbed.map((item) => item.text),
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
        for (let i = 0; i < toEmbed.length; i++) {
          const item = toEmbed[i]
          const vec = embedded[i].vec
          const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
          upsert.run(item.rowid, model, vec.length, item.hash, buffer, timestamp, timestamp)
        }
      })
      transaction()
      return { scanned: rows.length, embedded: toEmbed.length, skipped: toTouch.length }
    } catch (error) {
      return {
        scanned: rows.length,
        embedded: 0,
        skipped: toTouch.length,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
