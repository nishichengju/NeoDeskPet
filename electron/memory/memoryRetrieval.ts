import type {
  AISettings,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemorySettings,
  Persona,
} from '../types'
import {
  type MemoryEmbeddingClient,
  resolveMemoryEmbeddingConfig,
} from './memoryEmbeddingClient'
import { buildMemoryFtsQuery } from './memoryFtsQuery'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { extractMemoryTags } from './memoryTagIndex'
import type { MemoryVectorSearchClient } from './memoryVectorSearchClient'

type TimeRangeParseResult = {
  startMs: number
  endMs: number
  quoteOnly: boolean
}

type CandidateRow = {
  rowid: number
  role: string | null
  content: string
  createdAt: number
  importance: number
  strength: number
  accessCount: number
  lastAccessedAt: number | null
  status: string | null
  pinned: number | null
}

type Candidate = CandidateRow & {
  ftsRel: number
  likeRel: number
  tagRel: number
  vecRel: number
  kgRel: number
}

type MemoryRetrievalEngineOptions = {
  now?: () => number
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

function normalizeText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

function extractKeywordFromQueryForLike(query: string): string | null {
  const raw = query.trim()
  if (!raw) return null

  const text = raw
    .replace(/[，。！？,.!?；;：:“”"'（）()【】[\]{}<>《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(你|我)?(还)?(记得|想得起|能想起)(我|我们)?(说过|提过|讲过|聊过)?/u, '')
    .replace(/^(还)?(记得|想得起|能想起)(我|我们)?(说过|提过|讲过|聊过)?/u, '')
    .replace(/^(你|我)?(之前|以前|刚才|刚刚|那天|那次|上次)(说过|提过|讲过|聊过)?/u, '')
    .replace(/[吗呢吧呀啊哦哇]$/u, '')
    .trim()

  if (!text) return null
  const candidates = Array.from(text.matchAll(/[\p{L}\p{N}]{2,}/gu)).map((match) => match[0])
  if (candidates.length === 0) return null

  const stop = new Set([
    '还记得',
    '记得',
    '想得起',
    '能想起',
    '之前',
    '以前',
    '刚才',
    '刚刚',
    '那天',
    '那次',
    '上次',
    '说过',
    '提过',
    '讲过',
    '聊过',
  ])
  const filtered = candidates.filter((candidate) => !stop.has(candidate))
  const pickFrom = filtered.length > 0 ? filtered : candidates
  pickFrom.sort((left, right) => right.length - left.length)
  const best = pickFrom[0]?.trim() ?? ''
  if (best.length < 2) return null
  return best.length > 40 ? best.slice(0, 40) : best
}

function parseTimeRangeFromQuery(query: string, nowMs: number): TimeRangeParseResult | null {
  const text = query.trim()
  if (!text) return null

  const quoteOnly = /(准确|原话|复述|逐字|一字不差|完整复述)/.test(text)
  const current = new Date(nowMs)
  const clampRange = (startMs: number, endMs: number) => ({
    startMs: Math.min(startMs, endMs),
    endMs: Math.max(startMs, endMs),
  })
  const toLocalMs = (year: number, month: number, day: number, hour: number, minute: number, second: number) => {
    const timestamp = new Date(year, month - 1, day, hour, minute, second, 0).getTime()
    return Number.isFinite(timestamp) ? timestamp : NaN
  }
  const periodToHours = (period: string): { startHour: number; endHour: number } | null => {
    if (period.includes('凌晨')) return { startHour: 0, endHour: 6 }
    if (period.includes('早上') || period.includes('上午')) return { startHour: 6, endHour: 12 }
    if (period.includes('中午')) return { startHour: 11, endHour: 13 }
    if (period.includes('下午')) return { startHour: 13, endHour: 18 }
    if (period.includes('晚上') || period.includes('夜里') || period.includes('夜间')) {
      return { startHour: 18, endHour: 24 }
    }
    return null
  }
  const dayRange = (year: number, month: number, day: number, period: { startHour: number; endHour: number }) => {
    const start = toLocalMs(year, month, day, period.startHour, 0, 0)
    const end = toLocalMs(
      year,
      month,
      day,
      period.endHour === 24 ? 23 : period.endHour,
      period.endHour === 24 ? 59 : 0,
      period.endHour === 24 ? 59 : 0,
    )
    return Number.isFinite(start) && Number.isFinite(end) ? clampRange(start, end) : null
  }

  const full = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/)
  if (full) {
    const second = full[6] ? Number(full[6]) : NaN
    const base = toLocalMs(
      Number(full[1]),
      Number(full[2]),
      Number(full[3]),
      Number(full[4]),
      Number(full[5]),
      Number.isFinite(second) ? second : 0,
    )
    if (Number.isFinite(base)) {
      const windowMs = Number.isFinite(second) ? 30_000 : 5 * 60_000
      return { ...clampRange(base - windowMs, base + windowMs), quoteOnly }
    }
  }

  const dateOnly = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (dateOnly) {
    const range = dayRange(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      periodToHours(text) ?? { startHour: 0, endHour: 24 },
    )
    if (range) return { ...range, quoteOnly }
  }

  const relativeDay = text.match(/(前天|昨天|今天)/)
  if (relativeDay) {
    const offsetDays = relativeDay[1] === '前天' ? -2 : relativeDay[1] === '昨天' ? -1 : 0
    const baseDate = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + offsetDays,
      0,
      0,
      0,
      0,
    )
    const range = dayRange(
      baseDate.getFullYear(),
      baseDate.getMonth() + 1,
      baseDate.getDate(),
      periodToHours(text) ?? { startHour: 0, endHour: 24 },
    )
    if (range) return { ...range, quoteOnly }
  }

  const monthDay = text.match(/(\d{1,2})月(\d{1,2})日/)
  if (monthDay) {
    const month = Number(monthDay[1])
    const day = Number(monthDay[2])
    let year = current.getFullYear()
    const period = periodToHours(text) ?? { startHour: 0, endHour: 24 }
    const candidateStart = toLocalMs(year, month, day, period.startHour, 0, 0)
    if (Number.isFinite(candidateStart) && candidateStart > nowMs + 86_400_000) year -= 1
    const range = dayRange(year, month, day, period)
    if (range) return { ...range, quoteOnly }
  }

  return null
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function computeMemoryRetentionScore(
  nowMs: number,
  createdAt: number,
  lastAccessedAt: number | null,
  strength: number,
): number {
  const baseAt =
    typeof lastAccessedAt === 'number' && Number.isFinite(lastAccessedAt) && lastAccessedAt > 0
      ? lastAccessedAt
      : createdAt
  const ageDays = Math.max(0, nowMs - baseAt) / 86_400_000
  const normalizedStrength = clampFloat(strength, 0.2, 0, 1)
  const halfLifeDays = 14 * (0.3 + normalizedStrength * 2)
  if (halfLifeDays <= 0) return 0
  return clampFloat(Math.pow(0.5, ageDays / halfLifeDays), 1, 0, 1)
}

export class MemoryRetrievalEngine {
  private readonly db: MemoryDatabaseHandle
  private readonly embeddingClient: Pick<MemoryEmbeddingClient, 'embedTexts'>
  private readonly vectorSearchClient: Pick<MemoryVectorSearchClient, 'search'>
  private readonly getPersona: (personaId: string) => Persona | null
  private readonly now: () => number

  constructor(
    db: MemoryDatabaseHandle,
    embeddingClient: Pick<MemoryEmbeddingClient, 'embedTexts'>,
    vectorSearchClient: Pick<MemoryVectorSearchClient, 'search'>,
    getPersona: (personaId: string) => Persona | null,
    options: MemoryRetrievalEngineOptions = {},
  ) {
    this.db = db
    this.embeddingClient = embeddingClient
    this.vectorSearchClient = vectorSearchClient
    this.getPersona = getPersona
    this.now = options.now ?? Date.now
  }

  async retrieve(
    args: MemoryRetrieveArgs,
    memSettings: MemorySettings,
    aiSettings: AISettings,
  ): Promise<MemoryRetrieveResult> {
    const startedAt = this.now()
    const personaId = args.personaId.trim() || 'default'
    const persona = this.getPersona(personaId)
    if (persona && !persona.retrieveEnabled) return { addon: '' }
    const query = args.query.trim()
    if (!query) return { addon: this.buildPersonaAddon(personaId, '') }

    const limit = clampInt(args.limit, 12, 1, 50)
    const maxChars = clampInt(args.maxChars, 2800, 200, 20000)
    const includeShared = args.includeShared !== false
    const shouldReinforce = args.reinforce !== false
    const nowMs = this.now()

    const timeRange = parseTimeRangeFromQuery(query, nowMs)
    if (timeRange) {
      return this.retrieveTimeRange({
        personaId,
        includeShared,
        shouldReinforce,
        limit,
        maxChars,
        nowMs,
        startedAt,
        timeRange,
        vectorEnabled: memSettings.vectorEnabled ?? false,
      })
    }

    const match = buildMemoryFtsQuery(query)
    if (!match) {
      return {
        addon: this.buildPersonaAddon(personaId, ''),
        debug: {
          tookMs: Math.max(0, this.now() - startedAt),
          layers: ['none'],
          counts: { timeRange: 0, fts: 0, like: 0, tag: 0, vector: 0, kg: 0 },
          vector: { enabled: memSettings.vectorEnabled ?? false, attempted: false, reason: 'no_match' },
          tag: { queryTags: 0, matchedTags: 0, expandedTags: 0 },
        },
      }
    }

    const candidates = new Map<number, Candidate>()
    const upsert = (
      row: CandidateRow,
      patch: Partial<Pick<Candidate, 'ftsRel' | 'likeRel' | 'tagRel' | 'vecRel' | 'kgRel'>>,
    ) => {
      const previous = candidates.get(row.rowid)
      if (!previous) {
        candidates.set(row.rowid, {
          ...row,
          ftsRel: patch.ftsRel ?? 0,
          likeRel: patch.likeRel ?? 0,
          tagRel: patch.tagRel ?? 0,
          vecRel: patch.vecRel ?? 0,
          kgRel: patch.kgRel ?? 0,
        })
        return
      }
      previous.ftsRel = Math.max(previous.ftsRel, patch.ftsRel ?? 0)
      previous.likeRel = Math.max(previous.likeRel, patch.likeRel ?? 0)
      previous.tagRel = Math.max(previous.tagRel, patch.tagRel ?? 0)
      previous.vecRel = Math.max(previous.vecRel, patch.vecRel ?? 0)
      previous.kgRel = Math.max(previous.kgRel, patch.kgRel ?? 0)
    }

    const ftsLimit = clampInt(limit * 5, 60, limit, 200)
    const ftsRows = this.db
      .prepare(
        `
        SELECT
          m.rowid as rowid,
          m.role as role,
          m.content as content,
          m.created_at as createdAt,
          m.importance as importance,
          m.strength as strength,
          m.access_count as accessCount,
          m.last_accessed_at as lastAccessedAt,
          m.status as status,
          m.pinned as pinned,
          bm25(memory_fts) as score
        FROM memory_fts
        JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
          AND (m.persona_id = ? ${includeShared ? 'OR m.persona_id IS NULL' : ''})
          AND COALESCE(m.status, 'active') <> 'deleted'
        ORDER BY score ASC, m.created_at DESC
        LIMIT ?
        `,
      )
      .all(match, personaId, ftsLimit) as Array<CandidateRow & { score: number | null }>
    for (const row of ftsRows) {
      const relevance =
        typeof row.score === 'number' && Number.isFinite(row.score) ? 1 / (1 + Math.max(0, row.score)) : 0
      upsert(row, { ftsRel: relevance })
    }

    if (ftsRows.length === 0) {
      const keyword = extractKeywordFromQueryForLike(query)
      const needle = (keyword && keyword !== query ? keyword : query).slice(0, 120)
      const likeRows = this.db
        .prepare(
          `
          SELECT
            rowid as rowid,
            role as role,
            content as content,
            created_at as createdAt,
            importance as importance,
            strength as strength,
            access_count as accessCount,
            last_accessed_at as lastAccessedAt,
            status as status,
            pinned as pinned
          FROM memory
          WHERE content LIKE ?
            AND (persona_id = ? ${includeShared ? 'OR persona_id IS NULL' : ''})
            AND COALESCE(status, 'active') <> 'deleted'
          ORDER BY created_at DESC
          LIMIT ?
          `,
        )
        .all(`%${needle}%`, personaId, ftsLimit) as CandidateRow[]
      for (const row of likeRows) upsert(row, { likeRel: 0.38 })
    }

    const tagEnabled = memSettings.tagEnabled ?? true
    const tagMaxExpand = clampInt(memSettings.tagMaxExpand, 6, 0, 40)
    const baseTagNames = (tagEnabled ? extractMemoryTags(query, { maxTags: 12 }) : [])
      .filter((tag) => tag && !tag.startsWith('__'))
      .slice(0, 12)
    let allTagIds: number[] = []
    let baseTagIds: number[] = []
    let matchedTagCount = 0

    if (tagEnabled && baseTagNames.length > 0) {
      const placeholders = baseTagNames.map(() => '?').join(',')
      const found = this.db
        .prepare(`SELECT id as id, name as name FROM tag WHERE name IN (${placeholders})`)
        .all(...baseTagNames) as Array<{ id: number; name: string }>
      baseTagIds = found.map((row) => clampInt(row.id, 0, 1, 2_000_000_000)).filter((id) => id > 0)
      matchedTagCount = baseTagIds.length
      allTagIds = [...baseTagIds]

      if (baseTagIds.length > 0 && tagMaxExpand > 0) {
        const inA = baseTagIds.map(() => '?').join(',')
        const inB = baseTagIds.map(() => '?').join(',')
        const related = this.db
          .prepare(
            `
            SELECT mt2.tag_id as tagId, COUNT(*) as count
            FROM memory_tag mt1
            JOIN memory_tag mt2 ON mt1.memory_rowid = mt2.memory_rowid
            JOIN memory m ON m.rowid = mt1.memory_rowid
            WHERE mt1.tag_id IN (${inA})
              AND mt2.tag_id NOT IN (${inB})
              AND (m.persona_id = ? ${includeShared ? 'OR m.persona_id IS NULL' : ''})
              AND COALESCE(m.status, 'active') <> 'deleted'
            GROUP BY mt2.tag_id
            ORDER BY count DESC
            LIMIT ?
            `,
          )
          .all(...baseTagIds, ...baseTagIds, personaId, tagMaxExpand) as Array<{ tagId: number }>
        allTagIds = Array.from(
          new Set([
            ...allTagIds,
            ...related.map((row) => clampInt(row.tagId, 0, 1, 2_000_000_000)).filter((id) => id > 0),
          ]),
        )
      }

      if (allTagIds.length > 0) {
        const inTags = allTagIds.map(() => '?').join(',')
        const tagLimit = clampInt(limit * 8, 120, limit, 600)
        const tagRows = this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.role as role,
              m.content as content,
              m.created_at as createdAt,
              m.importance as importance,
              m.strength as strength,
              m.access_count as accessCount,
              m.last_accessed_at as lastAccessedAt,
              m.status as status,
              m.pinned as pinned,
              COUNT(DISTINCT mt.tag_id) as tagHits
            FROM memory_tag mt
            JOIN memory m ON m.rowid = mt.memory_rowid
            WHERE mt.tag_id IN (${inTags})
              AND (m.persona_id = ? ${includeShared ? 'OR m.persona_id IS NULL' : ''})
              AND COALESCE(m.status, 'active') <> 'deleted'
            GROUP BY m.rowid
            ORDER BY tagHits DESC, m.created_at DESC
            LIMIT ?
            `,
          )
          .all(...allTagIds, personaId, tagLimit) as Array<CandidateRow & { tagHits: number }>
        const denominator = Math.max(1, baseTagIds.length)
        for (const row of tagRows) upsert(row, { tagRel: clampFloat(row.tagHits / denominator, 0, 0, 1) })
      }
    }

    if (memSettings.kgEnabled ?? false) {
      const entityRows = this.db
        .prepare(
          `
          SELECT e.id as id
          FROM kg_entity_fts
          JOIN kg_entity e ON e.id = kg_entity_fts.rowid
          WHERE kg_entity_fts MATCH ? AND e.persona_id = ?
          LIMIT 12
          `,
        )
        .all(match, personaId) as Array<{ id: number }>
      const entityIds = entityRows.map((row) => clampInt(row.id, 0, 1, 2_000_000_000)).filter((id) => id > 0)
      if (entityIds.length > 0) {
        const placeholders = entityIds.map(() => '?').join(',')
        const kgLimit = clampInt(limit * 6, 120, limit, 500)
        const memoryRows = this.db
          .prepare(
            `
            SELECT
              m.rowid as rowid,
              m.role as role,
              m.content as content,
              m.created_at as createdAt,
              m.importance as importance,
              m.strength as strength,
              m.access_count as accessCount,
              m.last_accessed_at as lastAccessedAt,
              m.status as status,
              m.pinned as pinned,
              COUNT(DISTINCT em.entity_id) as entHits
            FROM kg_entity_mention em
            JOIN memory m ON m.rowid = em.memory_rowid
            WHERE em.entity_id IN (${placeholders})
              AND m.persona_id = ?
              AND COALESCE(m.status, 'active') <> 'deleted'
            GROUP BY m.rowid
            ORDER BY entHits DESC, m.created_at DESC
            LIMIT ?
            `,
          )
          .all(...entityIds, personaId, kgLimit) as Array<CandidateRow & { entHits: number }>
        const denominator = Math.max(1, entityIds.length)
        for (const row of memoryRows) upsert(row, { kgRel: clampFloat(row.entHits / denominator, 0, 0, 1) })
      }
    }

    const vectorEnabled = memSettings.vectorEnabled ?? false
    const needVector = vectorEnabled && candidates.size < limit
    let vectorAttempted = false
    let vectorReason: string | undefined
    let vectorError: string | undefined
    if (needVector) {
      const config = resolveMemoryEmbeddingConfig(memSettings, aiSettings, { requireExplicitModel: true })
      if (config) {
        try {
          vectorAttempted = true
          const queryEmbedding = await this.embeddingClient.embedTexts(config, [normalizeText(query).slice(0, 800)])
          const hits = await this.vectorSearchClient.search({
            model: config.model,
            personaId,
            includeShared,
            scanLimit: clampInt(memSettings.vectorScanLimit, 2000, 200, 10000),
            minScore: clampFloat(memSettings.vectorMinScore, 0.35, 0, 1),
            topK: clampInt(memSettings.vectorTopK, 20, 1, 100),
            query: queryEmbedding[0].vec,
          })
          if (hits.length > 0) {
            const placeholders = hits.map(() => '?').join(',')
            const rows = this.db
              .prepare(
                `
                SELECT
                  rowid as rowid,
                  role as role,
                  content as content,
                  created_at as createdAt,
                  importance as importance,
                  strength as strength,
                  access_count as accessCount,
                  last_accessed_at as lastAccessedAt,
                  status as status,
                  pinned as pinned
                FROM memory
                WHERE rowid IN (${placeholders})
                `,
              )
              .all(...hits.map((hit) => hit.rowid)) as CandidateRow[]
            const byRowid = new Map(rows.map((row) => [row.rowid, row]))
            for (const hit of hits) {
              const row = byRowid.get(hit.rowid)
              if (row) upsert(row, { vecRel: clampFloat(hit.sim, 0, 0, 1) })
            }
          }
        } catch (error) {
          vectorError = error instanceof Error ? error.message : String(error)
        }
      } else {
        vectorReason = 'missing_config'
      }
    } else {
      vectorReason = vectorEnabled ? 'candidates_sufficient' : 'disabled'
    }

    const finalRanked = Array.from(candidates.values())
      .map((row) => {
        const importance = clampFloat(row.importance, 0.5, 0, 1)
        const strength = clampFloat(row.strength, 0.2, 0, 1)
        const retention = computeMemoryRetentionScore(nowMs, row.createdAt, row.lastAccessedAt, strength)
        const relevance =
          1 -
          (1 - clampFloat(row.ftsRel, 0, 0, 1)) *
            (1 - clampFloat(row.likeRel, 0, 0, 1)) *
            (1 - clampFloat(row.tagRel, 0, 0, 1)) *
            (1 - clampFloat(row.kgRel, 0, 0, 1)) *
            (1 - clampFloat(row.vecRel, 0, 0, 1))
        const statusFactor = row.status === 'archived' ? 0.3 : 1
        const pinnedFactor = (row.pinned ?? 0) ? 1.4 : 1
        return {
          ...row,
          retention,
          weight: relevance * retention * (0.5 + importance) * statusFactor * pinnedFactor,
        }
      })
      .sort((left, right) => right.weight - left.weight || right.createdAt - left.createdAt || right.rowid - left.rowid)
      .slice(0, limit)

    const { memoryBlock, hitRowids } = this.buildMemoryBlock(finalRanked, maxChars)
    if (shouldReinforce && hitRowids.length > 0) this.reinforceMemoryHits(hitRowids, nowMs)
    const counts = {
      timeRange: 0,
      fts: finalRanked.filter((row) => row.ftsRel > 0).length,
      like: finalRanked.filter((row) => row.likeRel > 0).length,
      tag: finalRanked.filter((row) => row.tagRel > 0).length,
      vector: finalRanked.filter((row) => row.vecRel > 0).length,
      kg: finalRanked.filter((row) => row.kgRel > 0).length,
    }
    const layers: Array<'none' | 'timeRange' | 'fts' | 'like' | 'tag' | 'vector' | 'kg'> = []
    if (counts.fts > 0) layers.push('fts')
    if (counts.like > 0) layers.push('like')
    if (counts.tag > 0) layers.push('tag')
    if (counts.kg > 0) layers.push('kg')
    if (counts.vector > 0) layers.push('vector')
    if (layers.length === 0) layers.push('none')

    return {
      addon: this.buildPersonaAddon(personaId, memoryBlock),
      debug: {
        tookMs: Math.max(0, this.now() - startedAt),
        layers,
        counts,
        tag: { queryTags: baseTagNames.length, matchedTags: matchedTagCount, expandedTags: allTagIds.length },
        vector: {
          enabled: vectorEnabled,
          attempted: vectorAttempted,
          ...(vectorReason ? { reason: vectorReason } : {}),
          ...(vectorError ? { error: vectorError } : {}),
        },
      },
    }
  }

  private retrieveTimeRange(args: {
    personaId: string
    includeShared: boolean
    shouldReinforce: boolean
    limit: number
    maxChars: number
    nowMs: number
    startedAt: number
    timeRange: TimeRangeParseResult
    vectorEnabled: boolean
  }): MemoryRetrieveResult {
    const rows = this.db
      .prepare(
        `
        SELECT rowid as rowid, role as role, content as content, created_at as createdAt
        FROM memory
        WHERE created_at BETWEEN ? AND ?
          AND COALESCE(role, 'note') IN ('user', 'assistant')
          AND COALESCE(status, 'active') <> 'deleted'
          AND (persona_id = ? ${args.includeShared ? 'OR persona_id IS NULL' : ''})
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
        `,
      )
      .all(args.timeRange.startMs, args.timeRange.endMs, args.personaId, Math.max(args.limit, 20)) as Array<{
      rowid: number
      role: string | null
      content: string
      createdAt: number
    }>

    const lines: string[] = []
    const hitRowids: number[] = []
    let used = 0
    for (const row of rows) {
      const content = row.content.trim()
      if (!content) continue
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : 'note'
      const prefix = `- (${formatTimestamp(row.createdAt)}) ${role}: `
      const available = Math.max(0, args.maxChars - used - prefix.length)
      if (available <= 0) break
      lines.push(prefix + (content.length > available ? `${content.slice(0, available)}…` : content))
      hitRowids.push(row.rowid)
      used += lines[lines.length - 1].length + 1
      if (used >= args.maxChars) break
    }

    if (args.shouldReinforce && hitRowids.length > 0) this.reinforceMemoryHits(hitRowids, args.nowMs)
    const hint = args.timeRange.quoteOnly
      ? '【引用规则】\n用户要求“准确复述/原话”时，只能依据下方【时间片段原文】逐字引用；若未找到对应内容，直接说“我忘了/没检索到”。'
      : ''
    const timeBlock =
      lines.length > 0 ? `【时间片段原文】\n${lines.join('\n')}` : '【时间片段原文】\n（未检索到该时间段的原文）'
    return {
      addon: this.buildPersonaAddon(args.personaId, [hint, timeBlock].filter(Boolean).join('\n\n')),
      debug: {
        tookMs: Math.max(0, this.now() - args.startedAt),
        layers: ['timeRange'],
        counts: { timeRange: hitRowids.length, fts: 0, like: 0, tag: 0, vector: 0, kg: 0 },
        vector: { enabled: args.vectorEnabled, attempted: false, reason: 'timeRange' },
        tag: { queryTags: 0, matchedTags: 0, expandedTags: 0 },
      },
    }
  }

  private buildMemoryBlock(rows: Candidate[], maxChars: number): { memoryBlock: string; hitRowids: number[] } {
    const lines: string[] = []
    const hitRowids: number[] = []
    let used = 0
    for (const row of rows) {
      const content = row.content.trim().replace(/\s+/g, ' ')
      if (!content) continue
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : 'note'
      const prefix = `- (${formatTimestamp(row.createdAt)}) ${role}: `
      const available = Math.max(0, maxChars - used - prefix.length)
      if (available <= 0) break
      lines.push(prefix + (content.length > available ? `${content.slice(0, available)}…` : content))
      hitRowids.push(row.rowid)
      used += lines[lines.length - 1].length + 1
      if (used >= maxChars) break
    }
    return { memoryBlock: lines.length > 0 ? `【相关记忆】\n${lines.join('\n')}` : '', hitRowids }
  }

  private reinforceMemoryHits(rowids: number[], nowMs: number): void {
    const ids = Array.from(
      new Set(rowids.map((rowid) => clampInt(rowid, 0, 1, 2_000_000_000)).filter((rowid) => rowid > 0)),
    )
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(
        `
        UPDATE memory
        SET
          access_count = access_count + 1,
          last_accessed_at = ?,
          strength = MIN(1, strength + 0.04),
          retention = 1,
          status = 'active'
        WHERE rowid IN (${placeholders})
          AND COALESCE(status, 'active') <> 'deleted'
        `,
      )
      .run(nowMs, ...ids)
  }

  private buildPersonaAddon(personaId: string, memoryBlock: string): string {
    const persona = this.getPersona(personaId)
    const parts: string[] = []
    if (persona && persona.prompt.trim().length > 0) parts.push(`【当前人设】\n${persona.prompt.trim()}`)
    if (memoryBlock.trim().length > 0) parts.push(memoryBlock.trim())
    return parts.join('\n\n').trim()
  }
}
