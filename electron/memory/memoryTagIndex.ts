import type { MemorySettings } from '../types'
import type { MemoryDatabaseHandle } from './memoryDatabase'
import { MemoryIndexQueue } from './memoryIndexQueue'

export type MemoryTagMaintenanceResult = {
  scanned: number
  updated: number
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function normalizeText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractMemoryTags(textRaw: string, options: { maxTags?: number } = {}): string[] {
  const maxTags = clampInt(options.maxTags, 24, 4, 80)
  const text = normalizeText(textRaw)
    .replace(/[，。！？；：,.!?;:、【】「」『』（）()《》<>“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return []

  const tags: string[] = []
  const seen = new Set<string>()
  const stop = new Set([
    '我',
    '你',
    '他',
    '她',
    '它',
    '我们',
    '你们',
    '他们',
    '这是',
    '那个',
    '这个',
    '什么',
    '怎么',
    '为什么',
    '是否',
    '还是',
    '记得',
    '还记得',
    '能不能',
    '可以吗',
  ])

  const push = (value: string) => {
    const tag = value.trim()
    if (tag.length < 2 || tag.length > 40 || stop.has(tag) || seen.has(tag)) return
    seen.add(tag)
    tags.push(tag)
  }

  for (const match of text.matchAll(/[A-Za-z0-9_]{2,}/g)) {
    push(match[0].toLowerCase())
    if (tags.length >= maxTags) return tags
  }

  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = Array.from(match[0]).slice(0, 32)
    for (const size of [4, 3, 2]) {
      if (chars.length < size) continue
      for (let i = 0; i <= chars.length - size; i++) {
        push(chars.slice(i, i + size).join(''))
        if (tags.length >= maxTags) return tags
      }
    }
  }

  for (const match of text.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    const value = match[0]
    push(/^[A-Za-z0-9_]+$/.test(value) ? value.toLowerCase() : value)
    if (tags.length >= maxTags) return tags
  }

  return tags
}

export class MemoryTagIndexMaintainer {
  private readonly db: MemoryDatabaseHandle
  private readonly queue: MemoryIndexQueue
  private readonly now: () => number

  constructor(db: MemoryDatabaseHandle, queue: MemoryIndexQueue, now: () => number = Date.now) {
    this.db = db
    this.queue = queue
    this.now = now
  }

  run(settings: MemorySettings, options: { batchSize?: number } = {}): MemoryTagMaintenanceResult {
    if ((settings.tagEnabled ?? true) === false) return { scanned: 0, updated: 0 }

    const batchSize = clampInt(options.batchSize, 80, 10, 500)
    const pending = this.queue.take('tag', batchSize)
    type Row = { rowid: number; content: string }
    const rows: Row[] = []

    if (pending.length > 0) {
      const placeholders = pending.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT rowid as rowid, content as content
            FROM memory
            WHERE rowid IN (${placeholders})
              AND COALESCE(status, 'active') <> 'deleted'
              AND LENGTH(TRIM(content)) >= 2
            `,
          )
          .all(...pending) as Row[]),
      )
    }

    const remaining = batchSize - rows.length
    if (remaining > 0) {
      const pendingExclusion = pending.length > 0 ? `AND m.rowid NOT IN (${pending.map(() => '?').join(',')})` : ''
      rows.push(
        ...(this.db
          .prepare(
            `
            SELECT m.rowid as rowid, m.content as content
            FROM memory m
            LEFT JOIN memory_tag mt ON mt.memory_rowid = m.rowid
            WHERE mt.memory_rowid IS NULL
              AND COALESCE(m.status, 'active') <> 'deleted'
              AND LENGTH(TRIM(m.content)) >= 2
              ${pendingExclusion}
            ORDER BY m.updated_at DESC, m.rowid DESC
            LIMIT ?
            `,
          )
          .all(...pending, remaining) as Row[]),
      )
    }

    if (rows.length === 0) return { scanned: 0, updated: 0 }

    const timestamp = this.now()
    const insertTag = this.db.prepare('INSERT INTO tag(name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
    const getTag = this.db.prepare('SELECT id as id FROM tag WHERE name = ? LIMIT 1')
    const clear = this.db.prepare('DELETE FROM memory_tag WHERE memory_rowid = ?')
    const insertRelation = this.db.prepare(
      'INSERT OR IGNORE INTO memory_tag(memory_rowid, tag_id, created_at) VALUES (?, ?, ?)',
    )

    const transaction = this.db.transaction((items: Row[]) => {
      for (const row of items) {
        const tags = extractMemoryTags(row.content, { maxTags: 24 })
        const finalTags = tags.length > 0 ? tags : ['__no_tag__']
        clear.run(row.rowid)
        for (const name of finalTags) {
          insertTag.run(name, timestamp)
          const tagRow = getTag.get(name) as { id?: number } | undefined
          const tagId = clampInt(tagRow?.id, 0, 1, 2_000_000_000)
          if (tagId > 0) insertRelation.run(row.rowid, tagId, timestamp)
        }
      }
    })

    transaction(rows)
    return { scanned: rows.length, updated: rows.length }
  }
}
