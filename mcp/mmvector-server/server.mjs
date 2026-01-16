import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

function nowBeijingIso() {
  // ISO string is good enough for logs/ids; no need to force TZ offset formatting here.
  return new Date().toISOString()
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function clampFloat(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim()
  return s.replace(/\/+$/, '')
}

function stripV1(baseUrl) {
  const b = normalizeBaseUrl(baseUrl)
  return b.replace(/\/v1$/i, '')
}

function buildEmbeddingsEndpoint(baseUrl) {
  const b = normalizeBaseUrl(baseUrl)
  if (!b) return '/v1/embeddings'
  const fixed = b.replace(/\/embeddings$/i, '')
  return `${fixed}/embeddings`
}

function jsonText(obj) {
  return JSON.stringify(obj)
}

function coerceArgsObject(args) {
  // MCP arguments 可能被上游包装成 { value: "<json>" } 或 { value: "<path>" }；这里尽量还原。
  if (!args || typeof args !== 'object') return {}
  const v = args.value
  if (typeof v !== 'string') return args
  const raw = v.trim()
  if (!raw) return args
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...args, ...(parsed ?? {}) }
    } catch {
      // ignore
    }
  }
  return args
}

function pickMimeByExt(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.avi') return 'video/x-msvideo'
  if (ext === '.mkv') return 'video/x-matroska'
  return 'application/octet-stream'
}

async function fileToDataUrl(filePath) {
  const p = String(filePath ?? '').trim()
  if (!p) throw new Error('imagePath/path 为空')
  const buf = await fs.readFile(p)
  const mime = pickMimeByExt(p)
  const b64 = buf.toString('base64')
  return `data:${mime};base64,${b64}`
}

function l2Normalize(vec) {
  let sumSq = 0
  for (let i = 0; i < vec.length; i += 1) sumSq += vec[i] * vec[i]
  if (!Number.isFinite(sumSq) || sumSq <= 0) return vec
  const inv = 1 / Math.sqrt(sumSq)
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] * inv
  return out
}

function dot(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i += 1) s += a[i] * b[i]
  return s
}

class SimpleIndex {
  constructor(opts) {
    const dataDir = String(opts?.dataDir ?? '').trim()
    this.dataDir = dataDir || path.join(process.cwd(), 'mcp-output', 'mmvector')
    this.indexFile = path.join(this.dataDir, 'index.json')
    this.dim = 0
    this.items = []
    this.embeddings = []
  }

  async ensureDir() {
    await fs.mkdir(this.dataDir, { recursive: true })
  }

  async load() {
    await this.ensureDir()
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8')
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      const embeddings = Array.isArray(parsed?.embeddings) ? parsed.embeddings : []
      const dim = clampInt(parsed?.dim, 0, 0, 1_000_000)
      if (!dim || items.length !== embeddings.length) {
        this.dim = 0
        this.items = []
        this.embeddings = []
        return
      }
      this.dim = dim
      this.items = items
      this.embeddings = embeddings.map((v) => {
        const arr = Array.isArray(v) ? v : []
        const f32 = new Float32Array(arr.map((x) => (typeof x === 'number' ? x : Number(x) || 0)))
        return f32.length === dim ? f32 : new Float32Array(dim)
      })
    } catch {
      this.dim = 0
      this.items = []
      this.embeddings = []
    }
  }

  async save() {
    await this.ensureDir()
    const payload = {
      version: 1,
      dim: this.dim,
      items: this.items,
      embeddings: this.embeddings.map((v) => Array.from(v)),
    }
    await fs.writeFile(this.indexFile, JSON.stringify(payload), 'utf8')
  }

  count() {
    const total = this.items.length
    const images = this.items.filter((x) => x?.type === 'image').length
    const videos = this.items.filter((x) => x?.type === 'video').length
    return { total, images, videos, dim: this.dim }
  }

  async clear() {
    this.items = []
    this.embeddings = []
    this.dim = 0
    await this.save()
  }

  async deleteById(id) {
    const idx = clampInt(id, -1, 0, this.items.length - 1)
    if (idx < 0 || idx >= this.items.length) return null
    const item = this.items[idx]
    this.items.splice(idx, 1)
    this.embeddings.splice(idx, 1)
    // Re-number IDs to keep it stable for UI like app.py demo
    for (let i = 0; i < this.items.length; i += 1) {
      this.items[i].id = i
    }
    await this.save()
    return item
  }

  async addItem(meta, embedding) {
    const vec = l2Normalize(embedding)
    if (!this.dim) this.dim = vec.length
    if (vec.length !== this.dim) {
      // Dimension changed: reset to avoid mixing incompatible vectors.
      this.items = []
      this.embeddings = []
      this.dim = vec.length
    }
    const id = this.items.length
    const item = { ...meta, id, createdAt: nowBeijingIso() }
    this.items.push(item)
    this.embeddings.push(vec)
    await this.save()
    return item
  }

  search(queryVec, opts) {
    // 默认 6：避免输出过长导致聊天工具卡片 outputPreview 被截断，从而无法解析 JSON。
    const topK = clampInt(opts?.topK, 6, 1, 50)
    const minScore = clampFloat(opts?.minScore, 0, -1, 1)
    const filter = String(opts?.filter ?? 'all').trim()

    if (!this.dim || this.items.length === 0) return []
    const q = l2Normalize(queryVec)
    if (q.length !== this.dim) return []

    const scored = []
    for (let i = 0; i < this.embeddings.length; i += 1) {
      const item = this.items[i]
      if (!item) continue
      const type = item.type === 'video' ? 'video' : 'image'
      if (filter === 'image' && type !== 'image') continue
      if (filter === 'video' && type !== 'video') continue
      const s = dot(q, this.embeddings[i])
      if (!Number.isFinite(s)) continue
      if (s < minScore) continue
      scored.push({ idx: i, score: s })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map((r) => ({ ...this.items[r.idx], score: r.score }))
  }
}

function buildVideoUrl(baseUrl, serverPath) {
  const sp = String(serverPath ?? '').trim()
  if (!sp) return ''
  const filename = path.basename(sp)
  const root = stripV1(baseUrl)
  if (!root) return ''
  return `${root}/v1/videos/${filename}`
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, text, json: data }
}

async function healthCheck({ baseUrl, apiKey, timeoutMs }) {
  const b = normalizeBaseUrl(baseUrl)
  if (!b) return { ok: false, mode: 'offline', error: 'baseUrl 为空' }

  const root = stripV1(b) || b
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), clampInt(timeoutMs, 5000, 500, 60000))

  try {
    const headers = {}
    const token = String(apiKey ?? '').trim()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await httpJson(`${root}/`, { method: 'GET', headers, signal: ac.signal })
    if (!res.ok) return { ok: false, mode: 'offline', error: res.json?.detail || res.text || `HTTP ${res.status}` }
    const features = Array.isArray(res.json?.features) ? res.json.features : []
    return { ok: true, mode: 'online', features }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, mode: 'offline', error: msg }
  } finally {
    clearTimeout(timer)
  }
}

async function createEmbedding({ baseUrl, apiKey, model, input, timeoutMs }) {
  const endpoint = buildEmbeddingsEndpoint(baseUrl)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), clampInt(timeoutMs, 120000, 1000, 600000))
  try {
    const headers = { 'content-type': 'application/json' }
    const token = String(apiKey ?? '').trim()
    if (token) headers.authorization = `Bearer ${token}`
    const body = JSON.stringify({ model: String(model ?? '').trim() || 'qwen3-vl-embedding-8b', encoding_format: 'float', input })
    const res = await httpJson(endpoint, { method: 'POST', headers, body, signal: ac.signal })
    if (!res.ok) {
      const errMsg = res.json?.detail || res.json?.error?.message || res.text || `HTTP ${res.status}`
      throw new Error(errMsg)
    }
    const emb = res.json?.data?.[0]?.embedding
    if (!Array.isArray(emb) || emb.length < 8) throw new Error('embeddings 返回为空或维度过小')
    const f32 = new Float32Array(emb.map((x) => (typeof x === 'number' ? x : Number(x) || 0)))
    return f32
  } finally {
    clearTimeout(timer)
  }
}

async function uploadVideo({ baseUrl, apiKey, videoPath, timeoutMs }) {
  const p = String(videoPath ?? '').trim()
  if (!p) throw new Error('videoPath/path 为空')
  const b = normalizeBaseUrl(baseUrl)
  const uploadUrl = `${stripV1(b)}/v1/upload/video`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), clampInt(timeoutMs, 180000, 1000, 600000))
  try {
    const buf = await fs.readFile(p)
    const mime = pickMimeByExt(p)
    const form = new FormData()
    form.append('file', new Blob([buf], { type: mime }), path.basename(p))

    const headers = {}
    const token = String(apiKey ?? '').trim()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await httpJson(uploadUrl, { method: 'POST', headers, body: form, signal: ac.signal })
    if (!res.ok) {
      const errMsg = res.json?.detail || res.text || `HTTP ${res.status}`
      throw new Error(errMsg)
    }
    const serverPath = String(res.json?.path ?? '').trim()
    if (!serverPath) throw new Error('upload/video 未返回 path')
    return { path: serverPath, filename: String(res.json?.filename ?? '').trim() }
  } finally {
    clearTimeout(timer)
  }
}

function pickFirstNonEmptyString(obj, keys) {
  const src = coerceArgsObject(obj)
  if (!src || typeof src !== 'object') return ''
  for (const k of keys) {
    const v = src?.[k]
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (s) return s
  }
  // 兼容：直接把路径当字符串传（mcpManager 会包装成 value）
  const direct = typeof src?.value === 'string' ? src.value.trim() : ''
  if (direct) return direct
  return ''
}

async function deleteServerFile({ baseUrl, apiKey, serverPath, timeoutMs }) {
  const b = normalizeBaseUrl(baseUrl)
  const url = `${stripV1(b)}/v1/file?${new URLSearchParams({ path: String(serverPath ?? '') })}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), clampInt(timeoutMs, 30000, 1000, 120000))
  try {
    const headers = {}
    const token = String(apiKey ?? '').trim()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await httpJson(url, { method: 'DELETE', headers, signal: ac.signal })
    return { ok: !!res.ok, status: res.status, message: res.json?.message || res.text || '' }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const envBaseUrl = normalizeBaseUrl(process.env.NDP_MMVECTOR_BASE_URL)
  const envApiKey = String(process.env.NDP_MMVECTOR_API_KEY ?? '').trim()
  const envModel = String(process.env.NDP_MMVECTOR_MODEL ?? '').trim() || 'qwen3-vl-embedding-8b'
  const envDataDir = String(process.env.NDP_MMVECTOR_DATA_DIR ?? '').trim()

  const index = new SimpleIndex({ dataDir: envDataDir })
  await index.load()

  if (process.argv.includes('--selftest')) {
    const hc = await healthCheck({ baseUrl: envBaseUrl, apiKey: envApiKey, timeoutMs: 5000 })
    if (!hc.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: hc.error }, null, 2)}\n`)
      process.exit(2)
    }
    const emb = await createEmbedding({ baseUrl: envBaseUrl, apiKey: envApiKey, model: envModel, input: 'test', timeoutMs: 30000 })
    process.stdout.write(`${JSON.stringify({ ok: true, dim: emb.length, features: hc.features, index: index.count() }, null, 2)}\n`)
    return
  }

  const server = new McpServer({ name: 'ndp-mmvector', version: '0.1.1' }, { capabilities: { tools: {} } })

  server.tool(
    'health',
    '检查多模态向量服务是否在线（优先走 GET /）。',
    {
      baseUrl: z.string().optional().describe('OpenAI-compatible BaseUrl，例如：http://127.0.0.1:7860/v1（不填则用环境变量 NDP_MMVECTOR_BASE_URL）'),
      apiKey: z.string().optional().describe('不填则用环境变量 NDP_MMVECTOR_API_KEY'),
      timeoutMs: z.number().int().min(500).max(60000).optional(),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const out = await healthCheck({ baseUrl, apiKey, timeoutMs: args?.timeoutMs })
      return { content: [{ type: 'text', text: jsonText(out) }] }
    },
  )

  server.tool(
    'index_stats',
    '查看当前索引统计（数量/维度）。',
    {},
    async () => ({ content: [{ type: 'text', text: jsonText({ ok: true, ...index.count() }) }] }),
  )

  server.tool(
    'index_clear',
    '清空索引（不删除服务器视频文件，仅删除本地索引记录）。',
    {},
    async () => {
      await index.clear()
      return { content: [{ type: 'text', text: jsonText({ ok: true, ...index.count() }) }] }
    },
  )

  server.tool(
    'index_delete',
    '按 ID 删除索引项（视频会尝试调用 /v1/file 删除服务器文件）。',
    {
      id: z.number().int().min(0),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(120000).optional(),
    },
    async (args) => {
      const removed = await index.deleteById(args.id)
      if (!removed) return { content: [{ type: 'text', text: jsonText({ ok: false, error: 'not_found' }) }] }

      let cleanup = null
      if (removed.type === 'video' && removed.serverPath) {
        const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
        const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
        cleanup = await deleteServerFile({ baseUrl, apiKey, serverPath: removed.serverPath, timeoutMs: args?.timeoutMs })
      }
      return { content: [{ type: 'text', text: jsonText({ ok: true, removed, cleanup }) }] }
    },
  )

  server.tool(
    'index_add_image',
    '添加图片到索引（会调用 embeddings 生成向量）。',
    {
      imagePath: z.string().optional().describe('本地图片路径（推荐字段）'),
      path: z.string().optional().describe('imagePath 的别名（兼容字段）'),
      value: z.string().optional().describe('兼容：直接传路径字符串/JSON 字符串（上游可能包装在 value）'),
      filename: z.string().optional().describe('展示用文件名（默认取路径 basename）'),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(600000).optional(),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const model = String(args?.model ?? '').trim() || envModel
      const imagePath = pickFirstNonEmptyString(args, ['imagePath', 'path'])
      if (!imagePath) return { content: [{ type: 'text', text: jsonText({ ok: false, error: '缺少参数：imagePath/path' }) }] }
      const filename = String(args?.filename ?? '').trim() || path.basename(imagePath)

      try {
        const imageDataUrl = await fileToDataUrl(imagePath)
        const emb = await createEmbedding({ baseUrl, apiKey, model, input: [{ image: imageDataUrl }], timeoutMs: args?.timeoutMs })
        const item = await index.addItem({ type: 'image', filename, imagePath }, emb)
        return { content: [{ type: 'text', text: jsonText({ ok: true, item, index: index.count() }) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg }) }] }
      }
    },
  )

  server.tool(
    'index_add_video',
    '添加视频到索引（上传到服务器 /v1/upload/video，再 embeddings 生成向量；结果可用于播放）。',
    {
      videoPath: z.string().optional().describe('本地视频路径（推荐字段）'),
      path: z.string().optional().describe('videoPath 的别名（兼容字段）'),
      value: z.string().optional().describe('兼容：直接传路径字符串/JSON 字符串（上游可能包装在 value）'),
      fps: z.number().min(0.1).max(10).optional().describe('采样帧率（默认 1.0）'),
      maxFrames: z.number().int().min(1).max(128).optional().describe('最大帧数（默认 32）'),
      filename: z.string().optional().describe('展示用文件名（默认取路径 basename）'),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(600000).optional(),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const model = String(args?.model ?? '').trim() || envModel
      const videoPath = pickFirstNonEmptyString(args, ['videoPath', 'path'])
      if (!videoPath) return { content: [{ type: 'text', text: jsonText({ ok: false, error: '缺少参数：videoPath/path' }) }] }
      const filename = String(args?.filename ?? '').trim() || path.basename(videoPath)
      const fps = clampFloat(args?.fps, 1.0, 0.1, 10)
      const maxFrames = clampInt(args?.maxFrames, 32, 1, 128)

      try {
        const uploaded = await uploadVideo({ baseUrl, apiKey, videoPath, timeoutMs: args?.timeoutMs })
        const serverPath = uploaded.path
        const emb = await createEmbedding({ baseUrl, apiKey, model, input: [{ video: serverPath, fps, max_frames: maxFrames }], timeoutMs: args?.timeoutMs })
        const videoUrl = buildVideoUrl(baseUrl, serverPath)
        const item = await index.addItem({ type: 'video', filename, videoPath, serverPath, videoUrl }, emb)
        return { content: [{ type: 'text', text: jsonText({ ok: true, item, index: index.count() }) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg }) }] }
      }
    },
  )

  server.tool(
    'search_by_text',
    '以文搜索（会调用 embeddings 获取 query 向量，然后在本地索引里检索）。',
    {
      query: z.string(),
      topK: z.number().int().min(1).max(50).optional(),
      minScore: z.number().min(-1).max(1).optional(),
      filter: z.enum(['all', 'image', 'video']).optional(),
      instruction: z.string().optional().describe('可选：检索指令（不填则使用默认）'),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(600000).optional(),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const model = String(args?.model ?? '').trim() || envModel
      const query = String(args.query ?? '').trim()
      const instruction = String(args?.instruction ?? '').trim() || "Retrieve images or videos relevant to the user's query."

      try {
        const input = instruction ? [{ text: query, instruction }] : query
        const emb = await createEmbedding({ baseUrl, apiKey, model, input, timeoutMs: args?.timeoutMs })
        const results = index.search(emb, { topK: args?.topK, minScore: args?.minScore, filter: args?.filter ?? 'all' })
        // Keep output compact to avoid UI truncation.
        const compact = results.map((r) => ({
          id: r.id,
          type: r.type,
          score: clampFloat(r.score, 0, -1, 1),
          filename: r.filename,
          imagePath: r.type === 'image' ? r.imagePath : undefined,
          videoUrl: r.type === 'video' ? r.videoUrl || buildVideoUrl(baseUrl, r.serverPath) : undefined,
          videoPath: r.type === 'video' ? r.videoPath : undefined,
        }))
        return { content: [{ type: 'text', text: jsonText({ ok: true, count: compact.length, results: compact }) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg }) }] }
      }
    },
  )

  server.tool(
    'search_by_image',
    '以图搜索（会调用 embeddings 获取 query 向量，然后在本地索引里检索）。',
    {
      imagePath: z.string().optional(),
      path: z.string().optional().describe('imagePath 的别名（兼容字段）'),
      value: z.string().optional().describe('兼容：直接传路径字符串/JSON 字符串（上游可能包装在 value）'),
      topK: z.number().int().min(1).max(50).optional(),
      minScore: z.number().min(-1).max(1).optional(),
      filter: z.enum(['all', 'image', 'video']).optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(600000).optional(),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const model = String(args?.model ?? '').trim() || envModel
      const imagePath = pickFirstNonEmptyString(args, ['imagePath', 'path'])
      if (!imagePath) return { content: [{ type: 'text', text: jsonText({ ok: false, error: '缺少参数：imagePath/path' }) }] }

      try {
        const imageDataUrl = await fileToDataUrl(imagePath)
        const emb = await createEmbedding({ baseUrl, apiKey, model, input: [{ image: imageDataUrl }], timeoutMs: args?.timeoutMs })
        const results = index.search(emb, { topK: args?.topK, minScore: args?.minScore, filter: args?.filter ?? 'all' })
        const compact = results.map((r) => ({
          id: r.id,
          type: r.type,
          score: clampFloat(r.score, 0, -1, 1),
          filename: r.filename,
          imagePath: r.type === 'image' ? r.imagePath : undefined,
          videoUrl: r.type === 'video' ? r.videoUrl || buildVideoUrl(baseUrl, r.serverPath) : undefined,
          videoPath: r.type === 'video' ? r.videoPath : undefined,
        }))
        return { content: [{ type: 'text', text: jsonText({ ok: true, count: compact.length, results: compact }) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg }) }] }
      }
    },
  )

  server.tool(
    'search_by_video',
    '以视频搜索（会临时上传 query 视频用于 embeddings，并在检索后尝试删除临时文件）。',
    {
      videoPath: z.string().optional(),
      path: z.string().optional().describe('videoPath 的别名（兼容字段）'),
      value: z.string().optional().describe('兼容：直接传路径字符串/JSON 字符串（上游可能包装在 value）'),
      fps: z.number().min(0.1).max(10).optional(),
      maxFrames: z.number().int().min(1).max(128).optional(),
      topK: z.number().int().min(1).max(50).optional(),
      minScore: z.number().min(-1).max(1).optional(),
      filter: z.enum(['all', 'image', 'video']).optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(600000).optional(),
      deleteQueryVideoOnServer: z.boolean().optional().describe('默认 true：检索后删除临时上传的 query 视频'),
    },
    async (args) => {
      const baseUrl = normalizeBaseUrl(args?.baseUrl) || envBaseUrl
      const apiKey = String(args?.apiKey ?? '').trim() || envApiKey
      const model = String(args?.model ?? '').trim() || envModel
      const videoPath = pickFirstNonEmptyString(args, ['videoPath', 'path'])
      if (!videoPath) return { content: [{ type: 'text', text: jsonText({ ok: false, error: '缺少参数：videoPath/path' }) }] }
      const fps = clampFloat(args?.fps, 1.0, 0.1, 10)
      const maxFrames = clampInt(args?.maxFrames, 32, 1, 128)
      const shouldDelete = typeof args?.deleteQueryVideoOnServer === 'boolean' ? args.deleteQueryVideoOnServer : true

      let queryServerPath = ''
      try {
        const uploaded = await uploadVideo({ baseUrl, apiKey, videoPath, timeoutMs: args?.timeoutMs })
        queryServerPath = uploaded.path
        const emb = await createEmbedding({ baseUrl, apiKey, model, input: [{ video: queryServerPath, fps, max_frames: maxFrames }], timeoutMs: args?.timeoutMs })
        const results = index.search(emb, { topK: args?.topK, minScore: args?.minScore, filter: args?.filter ?? 'all' })
        const compact = results.map((r) => ({
          id: r.id,
          type: r.type,
          score: clampFloat(r.score, 0, -1, 1),
          filename: r.filename,
          imagePath: r.type === 'image' ? r.imagePath : undefined,
          videoUrl: r.type === 'video' ? r.videoUrl || buildVideoUrl(baseUrl, r.serverPath) : undefined,
          videoPath: r.type === 'video' ? r.videoPath : undefined,
        }))
        return { content: [{ type: 'text', text: jsonText({ ok: true, count: compact.length, results: compact }) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg }) }] }
      } finally {
        if (shouldDelete && queryServerPath) {
          try {
            await deleteServerFile({ baseUrl, apiKey, serverPath: queryServerPath, timeoutMs: 30000 })
          } catch {
            // ignore
          }
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err)
  process.stderr.write(`[ndp-mmvector] fatal: ${msg}\n`)
  process.exit(1)
})
