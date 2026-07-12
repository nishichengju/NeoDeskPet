// 向量检索工作线程：embedding 余弦评分在独立线程进行，避免 better-sqlite3 同步扫描阻塞主进程。
// 评分阶段只取 rowid/created_at/embedding（不取 content），topK 确定后由主进程按 rowid 回表取内容。
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

type DatabaseHandle = import('better-sqlite3').Database

export type VectorSearchRequest = {
  id: number
  model: string
  personaId: string
  includeShared: boolean
  scanLimit: number
  minScore: number
  topK: number
  query: Float32Array
}

export type VectorSearchHit = { rowid: number; sim: number }

export type VectorSearchResponse =
  | { id: number; hits: VectorSearchHit[] }
  | { id: number; error: string }

const dbPath = String((workerData as { dbPath?: string } | undefined)?.dbPath ?? '')

let db: DatabaseHandle | null = null

function openDb(): DatabaseHandle {
  if (db) return db
  const require = createRequire(import.meta.url)
  const mod = require('better-sqlite3') as unknown as { default?: unknown }
  const Database = (mod.default ?? mod) as unknown as {
    new (file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): DatabaseHandle
  }
  // 只读连接与主进程 WAL 连接可并存；busy_timeout 兜底偶发的 checkpoint 竞争
  db = new Database(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 3000')
  return db
}

function search(req: VectorSearchRequest): VectorSearchHit[] {
  const q = req.query
  const rows = openDb()
    .prepare(
      `
      SELECT
        e.memory_rowid as rowid,
        m.created_at as createdAt,
        e.embedding as embedding
      FROM memory_embedding e
      JOIN memory m ON m.rowid = e.memory_rowid
      WHERE e.model = ?
        AND (
          m.persona_id = ?
          ${req.includeShared ? 'OR m.persona_id IS NULL' : ''}
        )
        AND COALESCE(m.status, 'active') <> 'deleted'
      ORDER BY m.pinned DESC, m.retention DESC, m.importance DESC, m.updated_at DESC
      LIMIT ?
      `,
    )
    .all(req.model, req.personaId, req.scanLimit) as Array<{ rowid: number; createdAt: number; embedding: Buffer }>

  const scored: Array<VectorSearchHit & { createdAt: number }> = []
  for (const r of rows) {
    const buf = r.embedding
    if (!buf || buf.byteLength < 8 * 4) continue
    const dim = Math.floor(buf.byteLength / 4)
    if (dim !== q.length) continue
    const v = new Float32Array(buf.buffer, buf.byteOffset, dim)
    let dot = 0
    for (let i = 0; i < dim; i++) dot += q[i] * v[i]
    if (!Number.isFinite(dot)) continue
    if (dot < req.minScore) continue
    scored.push({ rowid: r.rowid, sim: dot, createdAt: r.createdAt })
  }

  scored.sort((a, b) => b.sim - a.sim || b.createdAt - a.createdAt || b.rowid - a.rowid)
  return scored.slice(0, req.topK).map((r) => ({ rowid: r.rowid, sim: r.sim }))
}

parentPort?.on('message', (req: VectorSearchRequest) => {
  let resp: VectorSearchResponse
  try {
    resp = { id: req.id, hits: search(req) }
  } catch (err) {
    resp = { id: req.id, error: err instanceof Error ? err.message : String(err) }
  }
  parentPort?.postMessage(resp)
})
