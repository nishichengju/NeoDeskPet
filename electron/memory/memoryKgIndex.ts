import { createHash } from 'node:crypto'
import type { AISettings, MemorySettings } from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { MemoryIndexQueue } from './memoryIndexQueue'

export type MemoryKgMaintenanceResult = {
  scanned: number
  extracted: number
  skipped: number
  error?: string
}

type KgCandidate = {
  rowid: number
  personaId: string | null
  kind: string
  content: string
  updatedAt: number
  role: string | null
  createdAt: number
  prevHash: string | null
  prevUpdatedAt: number | null
}

type KgEntity = {
  name: string
  type: string
  aliases: string[]
}

type KgRelation = {
  subject: string
  predicate: string
  objectType: string
  objectValue: string
  confidence: number
  evidence: string
}

type MemoryKgIndexOptions = {
  fetchImpl?: typeof fetch
  now?: () => number
}

const KG_SYSTEM_PROMPT = `你是“记忆图谱抽取器”。

目标：从一段对话/记忆原文中抽取【实体/关系】并给出证据。
要求：
1) 只输出严格 JSON 对象，不要输出任何解释、代码块、Markdown。
2) 用中文字段值；实体名尽量短且可复用。
3) 关系 predicate 用简短动词/短语（如“喜欢”“属于”“位于”“工作于”“需要”“计划”）。

输出 JSON 结构：
{
  "entities": [
    { "name": "", "type": "entity|person|place|food|work|task|preference|other", "aliases": [""] }
  ],
  "relations": [
    { "subject": "", "predicate": "", "object": { "type": "entity|literal", "value": "" }, "confidence": 0.0, "evidence": "" }
  ]
}

注意：
- evidence 必须来自原文的直接片段（可截短），用于追溯。
- 关系不要过多，最多 12 条。实体最多 20 个。`

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

function normalizeText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeEntityKey(text: string): string {
  return normalizeText(text)
    .replace(/[，。！？；：,.!?;:、【】「」『』（）()《》<>“”"'\s]/g, '')
    .trim()
    .toLowerCase()
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Some compatible providers wrap the JSON in prose or a code block.
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return null
  }
  return null
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function hashKgInput(personaId: string, kind: string, content: string): string {
  return createHash('sha1').update(`${personaId}\n${kind}\n${content}`).digest('hex')
}

function parseExtraction(value: Record<string, unknown>): { entities: KgEntity[]; relations: KgRelation[] } {
  const entitiesRaw = Array.isArray(value.entities) ? (value.entities as unknown[]) : []
  const relationsRaw = Array.isArray(value.relations) ? (value.relations as unknown[]) : []

  const entities = entitiesRaw
    .map((item) => item as { name?: unknown; type?: unknown; aliases?: unknown })
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      type: typeof item.type === 'string' ? item.type.trim() : 'entity',
      aliases: Array.isArray(item.aliases)
        ? item.aliases.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter(Boolean)
        : [],
    }))
    .filter((entity) => entity.name.length >= 2)
    .slice(0, 20)

  const relations = relationsRaw
    .map((item) => item as {
      subject?: unknown
      predicate?: unknown
      object?: unknown
      confidence?: unknown
      evidence?: unknown
    })
    .map((item) => {
      const object = item.object as { type?: unknown; value?: unknown } | null
      return {
        subject: typeof item.subject === 'string' ? item.subject.trim() : '',
        predicate: typeof item.predicate === 'string' ? item.predicate.trim() : '',
        objectType: object && typeof object.type === 'string' ? object.type.trim() : 'literal',
        objectValue: object && typeof object.value === 'string' ? object.value.trim() : '',
        confidence: clampFloat(item.confidence, 0.6, 0, 1),
        evidence: typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 160) : '',
      }
    })
    .filter((relation) => relation.subject && relation.predicate && relation.objectValue)
    .slice(0, 12)

  return { entities, relations }
}

export class MemoryKgIndexMaintainer {
  private readonly db: MemoryDatabaseHandle
  private readonly queue: MemoryIndexQueue
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(db: MemoryDatabaseHandle, queue: MemoryIndexQueue, options: MemoryKgIndexOptions = {}) {
    this.db = db
    this.queue = queue
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async run(
    memSettings: MemorySettings,
    aiSettings: AISettings,
    options: { batchSize?: number } = {},
  ): Promise<MemoryKgMaintenanceResult> {
    if ((memSettings.kgEnabled ?? false) === false) return { scanned: 0, extracted: 0, skipped: 0 }

    const useCustom = memSettings.kgUseCustomAi ?? true
    const apiKey = ((useCustom ? memSettings.kgAiApiKey : aiSettings.apiKey) ?? '').trim()
    const baseUrl = ((useCustom ? memSettings.kgAiBaseUrl : aiSettings.baseUrl) ?? '').trim()
    const model = (memSettings.kgAiModel ?? '').trim() || (aiSettings.model ?? '').trim()
    if (!apiKey || !baseUrl || !model) {
      return { scanned: 0, extracted: 0, skipped: 0, error: 'KG 抽取 API 未配置（缺少 apiKey/baseUrl/model）' }
    }

    const temperature = clampFloat(memSettings.kgAiTemperature, 0.2, 0, 2)
    const maxTokens = clampInt(memSettings.kgAiMaxTokens, 1200, 200, 8000)
    const batchSize = clampInt(options.batchSize, 2, 1, 10)
    const pending = this.queue.take('kg', batchSize)
    const rows: KgCandidate[] = []

    if (pending.length > 0) {
      const placeholders = pending.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.persona_id as personaId,
              m.kind as kind,
              m.content as content,
              m.updated_at as updatedAt,
              m.role as role,
              m.created_at as createdAt,
              ki.content_hash as prevHash,
              ki.updated_at as prevUpdatedAt
            FROM memory m
            LEFT JOIN kg_memory_index ki ON ki.memory_rowid = m.rowid
            WHERE m.rowid IN (${placeholders})
              AND COALESCE(m.status, 'active') <> 'deleted'
              AND LENGTH(TRIM(m.content)) >= 2
            `,
          )
          .all(...pending) as KgCandidate[]),
      )
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const kinds = (memSettings.kgIncludeChatMessages ?? false) ? "('manual_note','chat_message')" : "('manual_note')"
      const pendingExclusion = pending.length > 0 ? `AND m.rowid NOT IN (${pending.map(() => '?').join(',')})` : ''
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.persona_id as personaId,
              m.kind as kind,
              m.content as content,
              m.updated_at as updatedAt,
              m.role as role,
              m.created_at as createdAt,
              ki.content_hash as prevHash,
              ki.updated_at as prevUpdatedAt
            FROM memory m
            LEFT JOIN kg_memory_index ki ON ki.memory_rowid = m.rowid
            WHERE COALESCE(m.status, 'active') <> 'deleted'
              AND m.kind IN ${kinds}
              AND LENGTH(TRIM(m.content)) >= 2
              AND (ki.memory_rowid IS NULL OR ki.updated_at < m.updated_at)
              ${pendingExclusion}
            ORDER BY m.updated_at DESC, m.rowid DESC
            LIMIT ?
            `,
          )
          .all(...pending, remaining) as KgCandidate[]),
      )
    }

    if (rows.length === 0) return { scanned: 0, extracted: 0, skipped: 0 }

    const toExtract = rows.flatMap((row) => {
      const personaId = row.personaId ?? 'default'
      const content = normalizeText(row.content).slice(0, 2500)
      const contentHash = hashKgInput(personaId, row.kind, content)
      if (row.prevHash === contentHash && (row.prevUpdatedAt ?? 0) >= (row.updatedAt ?? 0)) return []
      return [{ ...row, contentHash }]
    })

    if (toExtract.length === 0) return { scanned: rows.length, extracted: 0, skipped: rows.length }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    const extractedAt = this.now()
    let extracted = 0

    for (const row of toExtract) {
      const personaId = (row.personaId ?? 'default').trim() || 'default'
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : 'note'
      const content = normalizeText(row.content).slice(0, 2500)
      const userPrompt = `persona=${personaId}\nkind=${row.kind}\nrole=${role}\ncreatedAt=${formatTimestamp(row.createdAt)}\n\n原文：\n${content}`

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: KG_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({} as unknown))
          const message =
            (errorData as { error?: { message?: string } }).error?.message ??
            `HTTP ${response.status}: ${response.statusText}`
          this.upsertIndexRow({
            memoryRowid: row.rowid,
            personaId,
            contentHash: row.contentHash,
            updatedAt: row.updatedAt,
            extractedAt,
            status: 'error',
            error: message,
          })
          continue
        }

        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const parsed = extractJsonObject(data.choices?.[0]?.message?.content ?? '')
        if (!parsed) {
          this.upsertIndexRow({
            memoryRowid: row.rowid,
            personaId,
            contentHash: row.contentHash,
            updatedAt: row.updatedAt,
            extractedAt,
            status: 'error',
            error: 'KG 输出不是有效 JSON 对象',
          })
          continue
        }

        const extraction = parseExtraction(parsed)
        this.applyExtraction({
          personaId,
          memoryRowid: row.rowid,
          memoryUpdatedAt: row.updatedAt,
          extractedAt,
          contentHash: row.contentHash,
          ...extraction,
        })
        extracted += 1
      } catch (error) {
        this.upsertIndexRow({
          memoryRowid: row.rowid,
          personaId,
          contentHash: row.contentHash,
          updatedAt: row.updatedAt,
          extractedAt,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { scanned: rows.length, extracted, skipped: rows.length - toExtract.length }
  }

  private upsertIndexRow(args: {
    memoryRowid: number
    personaId: string
    contentHash: string
    status: 'ok' | 'error'
    error?: string
    updatedAt: number
    extractedAt: number
  }): void {
    const rowid = clampInt(args.memoryRowid, 0, 1, 2_000_000_000)
    if (rowid <= 0) return
    const exists = this.db.prepare('SELECT 1 FROM memory WHERE rowid = ? LIMIT 1').get(rowid) as
      | { 1: number }
      | undefined
    if (!exists) return

    try {
      this.db
        .prepare(
          `
          INSERT INTO kg_memory_index (memory_rowid, persona_id, content_hash, status, last_error, updated_at, extracted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(memory_rowid) DO UPDATE SET
            persona_id = excluded.persona_id,
            content_hash = excluded.content_hash,
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at,
            extracted_at = excluded.extracted_at
          `,
        )
        .run(
          rowid,
          args.personaId.trim() || 'default',
          args.contentHash,
          args.status,
          args.error ?? null,
          clampInt(args.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
          args.extractedAt,
        )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('FOREIGN KEY constraint failed')) return
      throw error
    }
  }

  private applyExtraction(args: {
    personaId: string
    memoryRowid: number
    memoryUpdatedAt: number
    extractedAt: number
    contentHash: string
    entities: KgEntity[]
    relations: KgRelation[]
  }): void {
    const personaId = args.personaId.trim() || 'default'
    const rowid = clampInt(args.memoryRowid, 0, 1, 2_000_000_000)
    if (rowid <= 0) return
    const exists = this.db.prepare('SELECT 1 FROM memory WHERE rowid = ? LIMIT 1').get(rowid) as
      | { 1: number }
      | undefined
    if (!exists) return

    const timestamp = args.extractedAt
    const upsertEntity = this.db.prepare(
      `
      INSERT INTO kg_entity (persona_id, name, entity_type, aliases_json, key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(persona_id, key, entity_type) DO UPDATE SET
        name = excluded.name,
        aliases_json = excluded.aliases_json,
        updated_at = excluded.updated_at
      `,
    )
    const getEntity = this.db.prepare(
      'SELECT id as id FROM kg_entity WHERE persona_id = ? AND key = ? AND entity_type = ? LIMIT 1',
    )
    const clearMentions = this.db.prepare('DELETE FROM kg_entity_mention WHERE memory_rowid = ?')
    const insertMention = this.db.prepare(
      'INSERT OR IGNORE INTO kg_entity_mention (entity_id, memory_rowid, created_at) VALUES (?, ?, ?)',
    )
    const clearRelations = this.db.prepare('DELETE FROM kg_relation WHERE memory_rowid = ?')
    const insertRelation = this.db.prepare(
      `
      INSERT OR IGNORE INTO kg_relation (
        persona_id, subject_entity_id, predicate, object_entity_id, object_literal, confidence, memory_rowid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )

    const transaction = this.db.transaction(() => {
      const idByKey = new Map<string, number>()
      for (const entity of args.entities) {
        const key = normalizeEntityKey(entity.name)
        if (!key) continue
        const entityType = entity.type.trim() || 'entity'
        const aliases = Array.from(
          new Set([...(entity.aliases ?? []), entity.name].map((alias) => alias.trim()).filter(Boolean)),
        ).slice(0, 12)
        upsertEntity.run(personaId, entity.name, entityType, JSON.stringify(aliases), key, timestamp, timestamp)
        const stored = getEntity.get(personaId, key, entityType) as { id?: number } | undefined
        const id = clampInt(stored?.id, 0, 1, 2_000_000_000)
        if (id > 0) idByKey.set(`${entityType}:${key}`, id)
      }

      clearMentions.run(rowid)
      for (const id of idByKey.values()) insertMention.run(id, rowid, timestamp)

      clearRelations.run(rowid)
      for (const relation of args.relations) {
        const subjectKey = normalizeEntityKey(relation.subject)
        if (!subjectKey) continue
        const subjectTypeKey = Array.from(idByKey.keys()).find((key) => key.endsWith(`:${subjectKey}`))
        const subjectId = subjectTypeKey ? idByKey.get(subjectTypeKey) : undefined
        if (!subjectId) continue

        let objectEntityId: number | null = null
        let objectLiteral: string | null = null
        if (relation.objectType === 'entity') {
          const objectKey = normalizeEntityKey(relation.objectValue)
          const objectTypeKey = Array.from(idByKey.keys()).find((key) => key.endsWith(`:${objectKey}`))
          objectEntityId = objectTypeKey ? (idByKey.get(objectTypeKey) ?? null) : null
          if (!objectEntityId) objectLiteral = relation.objectValue
        } else {
          objectLiteral = relation.objectValue
        }

        insertRelation.run(
          personaId,
          subjectId,
          relation.predicate.slice(0, 40),
          objectEntityId,
          objectLiteral?.slice(0, 120) ?? null,
          relation.confidence,
          rowid,
          timestamp,
        )
      }

      this.upsertIndexRow({
        memoryRowid: rowid,
        personaId,
        contentHash: args.contentHash,
        status: 'ok',
        updatedAt: args.memoryUpdatedAt,
        extractedAt: timestamp,
      })
    })

    transaction()
  }
}
