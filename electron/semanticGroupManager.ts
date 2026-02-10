/**
 * 语义组管理器 (SemanticGroupManager)
 *
 * 基于 VCPToolBox 的语义动力学方法，实现词元组捕网机制：
 * 1. 将零散关键词组织成语义逻辑网络
 * 2. 检测用户输入中激活了哪些语义组
 * 3. 将查询向量与激活的组向量加权融合，生成增强查询向量
 *
 * 核心价值：解决传统向量检索无法处理的"逻辑串联/事件线/黑话"问题
 */

import { createHash, randomUUID } from 'node:crypto'
import type {
  SemanticGroup,
  SemanticGroupActivation,
  SemanticGroupCreateArgs,
  SemanticGroupLearnedWord,
  SemanticGroupSummary,
  SemanticGroupUpdateArgs,
} from './types'

type DatabaseHandle = import('better-sqlite3').Database

function now(): number {
  return Date.now()
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export type GetEmbeddingFn = (text: string) => Promise<number[] | null>

export class SemanticGroupManager {
  private db: DatabaseHandle
  private vectorCache = new Map<string, { vec: Float32Array; model: string }>()
  private getEmbedding: GetEmbeddingFn

  constructor(db: DatabaseHandle, getEmbedding: GetEmbeddingFn) {
    this.db = db
    this.getEmbedding = getEmbedding
    this.initTables()
  }

  /**
   * 更新 embedding 函数（用于配置变更时刷新）
   */
  updateEmbeddingFunction(getEmbedding: GetEmbeddingFn): void {
    this.getEmbedding = getEmbedding
  }

  // ========== 初始化 ==========

  private initTables(): void {
    this.db.exec(`
      -- 语义组主表
      CREATE TABLE IF NOT EXISTS semantic_group (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        words TEXT NOT NULL DEFAULT '[]',
        auto_learned TEXT NOT NULL DEFAULT '[]',
        weight REAL NOT NULL DEFAULT 1.0,
        vector_id TEXT,
        words_hash TEXT,
        last_activated_at INTEGER,
        activation_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 语义组向量缓存表
      CREATE TABLE IF NOT EXISTS semantic_group_vector (
        id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_semantic_group_name ON semantic_group(name);
      CREATE INDEX IF NOT EXISTS idx_semantic_group_vector_group ON semantic_group_vector(group_id);

      -- 语义组自学习：共现词元统计表
      CREATE TABLE IF NOT EXISTS semantic_group_learn_word (
        group_name TEXT NOT NULL,
        word TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER,
        PRIMARY KEY (group_name, word)
      );

      CREATE INDEX IF NOT EXISTS idx_sg_learn_group_count ON semantic_group_learn_word(group_name, count DESC);
    `)
  }

  // ========== 核心功能：组激活检测 ==========

  /**
   * 检测用户输入中激活了哪些语义组
   * @param text 用户输入文本
   * @returns 激活的语义组及其强度
   */
  detectActivatedGroups(text: string): SemanticGroupActivation[] {
    const lowerText = text.toLowerCase()
    const groups = this.getAllGroups()
    const activations: SemanticGroupActivation[] = []

    for (const group of groups) {
      const allWords = [...group.words, ...group.autoLearned]
      if (allWords.length === 0) continue

      const matchedWords = allWords.filter((word) => lowerText.includes(word.toLowerCase()))

      if (matchedWords.length > 0) {
        const strength = matchedWords.length / allWords.length
        activations.push({
          groupName: group.name,
          strength,
          matchedWords,
        })

        // 异步更新激活统计（不阻塞主流程）
        this.updateActivationStatsAsync(group.name)
      }
    }

    // 按激活强度降序排列
    activations.sort((a, b) => b.strength - a.strength)

    return activations
  }

  // ========== 核心功能：向量增强 ==========

  /**
   * 获取增强后的查询向量
   * 将原始查询向量与激活的语义组向量进行加权融合
   * @param queryVector 原始查询向量
   * @param activations 激活的语义组列表
   * @returns 增强后的查询向量
   */
  async getEnhancedVector(
    queryVector: Float32Array,
    activations: SemanticGroupActivation[],
    opts?: { model?: string }
  ): Promise<Float32Array> {
    if (activations.length === 0) {
      return queryVector
    }

    const expectedModel = opts?.model
    const vectors: Float32Array[] = [queryVector]
    const weights: number[] = [1.0] // 原始查询权重为 1.0

    for (const activation of activations) {
      const groupVector = await this.getGroupVector(activation.groupName, expectedModel)
      if (groupVector) {
        const group = this.getGroup(activation.groupName)
        // 组权重 × 激活强度
        const weight = (group?.weight ?? 1.0) * activation.strength
        vectors.push(groupVector)
        weights.push(weight)
      }
    }

    if (vectors.length === 1) {
      return queryVector
    }

    return this.weightedAverageVectors(vectors, weights)
  }

  /**
   * 加权平均融合多个向量
   */
  private weightedAverageVectors(vectors: Float32Array[], weights: number[]): Float32Array {
    const dim = vectors[0].length
    const result = new Float32Array(dim)
    let totalWeight = 0

    for (let i = 0; i < vectors.length; i++) {
      if (vectors[i].length !== dim) continue
      const w = weights[i]
      totalWeight += w
      for (let j = 0; j < dim; j++) {
        result[j] += vectors[i][j] * w
      }
    }

    if (totalWeight > 0) {
      for (let j = 0; j < dim; j++) {
        result[j] /= totalWeight
      }
    }

    // 归一化
    let norm = 0
    for (let j = 0; j < dim; j++) {
      norm += result[j] * result[j]
    }
    norm = Math.sqrt(norm) || 1
    for (let j = 0; j < dim; j++) {
      result[j] /= norm
    }

    return result
  }

  // ========== 预计算组向量 ==========

  /**
   * 预计算或更新所有语义组的向量
   * @param model embedding 模型名
   * @returns { updated, failed, errors } 更新数、失败数、错误信息
   */
  async precomputeGroupVectors(model: string): Promise<{ updated: number; failed: number; errors: string[] }> {
    const groups = this.getAllGroups()
    let updated = 0
    let failed = 0
    const errors: string[] = []

    for (const group of groups) {
      const allWords = [...group.words, ...group.autoLearned]
      if (allWords.length === 0) {
        if (group.vectorId) {
          this.deleteGroupVector(group.name)
        }
        continue
      }

      const currentHash = this.computeWordsHash(allWords)
      const needsUpdate = !group.vectorId || group.wordsHash !== currentHash

      if (needsUpdate) {
        const description = `${group.name}相关主题：${allWords.join(', ')}`
        try {
          const embedding = await this.getEmbedding(description)

          if (embedding && embedding.length >= 8) {
            await this.saveGroupVector(group.name, embedding, model, currentHash)
            updated++
          } else {
            failed++
            errors.push(`语义组 "${group.name}" 向量计算失败: Embedding API 返回空结果`)
          }
        } catch (err) {
          failed++
          errors.push(`语义组 "${group.name}" 向量计算失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    return { updated, failed, errors }
  }

  /**
   * 预计算单个语义组的向量
   */
  async precomputeSingleGroupVector(name: string, model: string): Promise<boolean> {
    const group = this.getGroup(name)
    if (!group) return false

    const allWords = [...group.words, ...group.autoLearned]
    if (allWords.length === 0) return false

    const description = `${group.name}相关主题：${allWords.join(', ')}`
    const embedding = await this.getEmbedding(description)

    if (embedding && embedding.length >= 8) {
      const currentHash = this.computeWordsHash(allWords)
      await this.saveGroupVector(name, embedding, model, currentHash)
      console.log(`[SemanticGroup] 已更新组向量: ${name}`)
      return true
    }

    return false
  }

  private computeWordsHash(words: string[]): string {
    const sorted = [...words].sort()
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
  }

  // ========== CRUD 操作 ==========

  /**
   * 获取所有语义组
   */
  getAllGroups(): SemanticGroup[] {
    const rows = this.db
      .prepare('SELECT * FROM semantic_group ORDER BY name')
      .all() as Array<{
      id: number
      name: string
      words: string
      auto_learned: string
      weight: number
      vector_id: string | null
      words_hash: string | null
      last_activated_at: number | null
      activation_count: number
      created_at: number
      updated_at: number
    }>

    return rows.map((r) => ({
      name: r.name,
      words: JSON.parse(r.words),
      autoLearned: JSON.parse(r.auto_learned),
      weight: r.weight,
      vectorId: r.vector_id,
      wordsHash: r.words_hash,
      lastActivatedAt: r.last_activated_at,
      activationCount: r.activation_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }

  /**
   * 获取所有语义组摘要（用于列表展示）
   */
  listGroups(): SemanticGroupSummary[] {
    const groups = this.getAllGroups()
    return groups.map((g) => ({
      name: g.name,
      wordCount: g.words.length,
      autoLearnedCount: g.autoLearned.length,
      weight: g.weight,
      hasVector: !!g.vectorId,
      activationCount: g.activationCount,
      lastActivatedAt: g.lastActivatedAt,
    }))
  }

  /**
   * 获取单个语义组
   */
  getGroup(name: string): SemanticGroup | null {
    const row = this.db.prepare('SELECT * FROM semantic_group WHERE name = ?').get(name) as
      | {
          name: string
          words: string
          auto_learned: string
          weight: number
          vector_id: string | null
          words_hash: string | null
          last_activated_at: number | null
          activation_count: number
          created_at: number
          updated_at: number
        }
      | undefined

    if (!row) return null

    return {
      name: row.name,
      words: JSON.parse(row.words),
      autoLearned: JSON.parse(row.auto_learned),
      weight: row.weight,
      vectorId: row.vector_id,
      wordsHash: row.words_hash,
      lastActivatedAt: row.last_activated_at,
      activationCount: row.activation_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * 创建语义组
   */
  createGroup(args: SemanticGroupCreateArgs): SemanticGroup {
    const { name, words, weight = 1.0 } = args
    const ts = now()

    // 去重和清理
    const cleanWords = [...new Set(words.map((w) => w.trim()).filter(Boolean))]

    this.db
      .prepare(
        `INSERT INTO semantic_group (name, words, weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(name.trim(), JSON.stringify(cleanWords), clampFloat(weight, 1.0, 0.1, 10.0), ts, ts)

    return this.getGroup(name.trim())!
  }

  /**
   * 更新语义组
   */
  updateGroup(args: SemanticGroupUpdateArgs): SemanticGroup | null {
    const { name, words, autoLearned, weight } = args
    const group = this.getGroup(name)
    if (!group) return null

    const ts = now()
    const newWords = words !== undefined ? [...new Set(words.map((w) => w.trim()).filter(Boolean))] : group.words
    const newAutoLearned =
      autoLearned !== undefined ? [...new Set(autoLearned.map((w) => w.trim()).filter(Boolean))] : group.autoLearned
    const newWeight = weight !== undefined ? clampFloat(weight, 1.0, 0.1, 10.0) : group.weight

    this.db
      .prepare(
        `UPDATE semantic_group
         SET words = ?, auto_learned = ?, weight = ?, updated_at = ?
         WHERE name = ?`
      )
      .run(JSON.stringify(newWords), JSON.stringify(newAutoLearned), newWeight, ts, name)

    // 清除向量缓存，下次预计算时会重新生成
    this.vectorCache.delete(name)

    return this.getGroup(name)
  }

  /**
   * 删除语义组
   */
  deleteGroup(name: string): boolean {
    // 先删除关联的向量
    this.deleteGroupVector(name)

    const result = this.db.prepare('DELETE FROM semantic_group WHERE name = ?').run(name)
    this.vectorCache.delete(name)
    return result.changes > 0
  }

  // ========== 激活统计 ==========

  private updateActivationStatsAsync(name: string): void {
    const ts = now()
    try {
      this.db
        .prepare(
          `UPDATE semantic_group
           SET last_activated_at = ?, activation_count = activation_count + 1
           WHERE name = ?`
        )
        .run(ts, name)
    } catch (err) {
      console.error('[SemanticGroup] 更新激活统计失败:', err)
    }
  }

  // ========== 向量存取 ==========

  private async getGroupVector(name: string, expectedModel?: string): Promise<Float32Array | null> {
    // 先查缓存
    const cached = this.vectorCache.get(name)
    if (cached) {
      if (expectedModel && cached.model !== expectedModel) return null
      return cached.vec
    }

    const group = this.getGroup(name)
    if (!group?.vectorId) return null

    const row = this.db.prepare('SELECT embedding, model FROM semantic_group_vector WHERE id = ?').get(group.vectorId) as
      | { embedding: Buffer; model: string }
      | undefined

    if (!row) return null
    if (expectedModel && row.model !== expectedModel) return null

    const dim = row.embedding.byteLength / 4
    const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dim)

    // 存入缓存
    this.vectorCache.set(name, { vec: vector, model: row.model })
    return vector
  }

  private async saveGroupVector(
    name: string,
    embedding: number[],
    model: string,
    wordsHash: string
  ): Promise<void> {
    const group = this.getGroup(name)
    if (!group) return

    const ts = now()
    const vectorId = randomUUID()
    const vec = new Float32Array(embedding.length)
    let norm = 0
    for (let i = 0; i < embedding.length; i++) {
      const v = Number(embedding[i])
      vec[i] = Number.isFinite(v) ? v : 0
      norm += vec[i] * vec[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm
    const buffer = Buffer.from(vec.buffer)

    // 删除旧向量
    if (group.vectorId) {
      this.db.prepare('DELETE FROM semantic_group_vector WHERE id = ?').run(group.vectorId)
    }

    // 获取 group_id
    const groupRow = this.db.prepare('SELECT id FROM semantic_group WHERE name = ?').get(name) as
      | { id: number }
      | undefined
    if (!groupRow) return

    // 插入新向量
    this.db
      .prepare(
        `INSERT INTO semantic_group_vector (id, group_id, embedding, model, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(vectorId, groupRow.id, buffer, model, ts)

    // 更新主表
    this.db
      .prepare(
        `UPDATE semantic_group
         SET vector_id = ?, words_hash = ?, updated_at = ?
         WHERE name = ?`
      )
      .run(vectorId, wordsHash, ts, name)

    // 更新缓存
    this.vectorCache.set(name, { vec, model })
  }

  private deleteGroupVector(name: string): void {
    const group = this.getGroup(name)
    if (!group?.vectorId) return

    this.db.prepare('DELETE FROM semantic_group_vector WHERE id = ?').run(group.vectorId)
    this.db
      .prepare(
        `UPDATE semantic_group
         SET vector_id = NULL, words_hash = NULL, updated_at = ?
         WHERE name = ?`
      )
      .run(now(), name)

    this.vectorCache.delete(name)
  }

  // ========== 自学习辅助 ==========

  /**
   * 添加自学习词元到指定组
   */
  addAutoLearnedWords(name: string, newWords: string[]): boolean {
    const group = this.getGroup(name)
    if (!group) return false

    const existingWords = new Set([...group.words, ...group.autoLearned])
    const toAdd = newWords.map((w) => w.trim()).filter((w) => w && !existingWords.has(w))

    if (toAdd.length === 0) return false

    const updated = this.updateGroup({
      name,
      autoLearned: [...group.autoLearned, ...toAdd],
    })

    return !!updated
  }

  // ========== 自学习：候选词元统计/建议 ==========

  private normalizeLearnWord(word: string): string {
    const raw = word.trim().replace(/\s+/g, ' ')
    if (!raw) return ''
    // 拉丁/数字统一小写；中文保持原样
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(raw)) return raw.toLowerCase()
    return raw
  }

  /**
   * 记录“语义组激活时 query 中出现的共现词元”
   * 注意：这里只做计数，不做词元提取与过滤（过滤在 memoryService 里完成）
   */
  learnWords(groupName: string, words: string[], ts?: number): number {
    const name = groupName.trim()
    if (!name) return 0
    if (!Array.isArray(words) || words.length === 0) return 0

    const uniq = Array.from(new Set(words.map((w) => this.normalizeLearnWord(w)).filter(Boolean))).slice(0, 40)
    if (uniq.length === 0) return 0

    const nowTs = typeof ts === 'number' && Number.isFinite(ts) ? Math.trunc(ts) : now()
    const stmt = this.db.prepare(
      `
      INSERT INTO semantic_group_learn_word (group_name, word, count, last_seen_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(group_name, word) DO UPDATE SET
        count = count + 1,
        last_seen_at = excluded.last_seen_at
      `,
    )
    const tx = this.db.transaction(() => {
      for (const w of uniq) stmt.run(name, w, nowTs)
    })
    tx()
    return uniq.length
  }

  /**
   * 获取语义组自学习建议词元
   */
  listLearnedWords(groupName: string, opts?: { minCount?: number; limit?: number }): SemanticGroupLearnedWord[] {
    const name = groupName.trim()
    if (!name) return []
    const minCount = Math.max(1, Math.min(1000000, Math.trunc(opts?.minCount ?? 3)))
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 12)))

    const rows = this.db
      .prepare(
        `
        SELECT word as word, count as count, last_seen_at as lastSeenAt
        FROM semantic_group_learn_word
        WHERE group_name = ?
          AND count >= ?
        ORDER BY count DESC, COALESCE(last_seen_at, 0) DESC, word ASC
        LIMIT ?
        `,
      )
      .all(name, minCount, limit) as Array<{ word: string; count: number; lastSeenAt: number | null }>

    return rows.map((r) => ({
      word: String(r.word ?? '').trim(),
      count: clampInt(r.count, 0, 0, 1_000_000),
      lastSeenAt: typeof r.lastSeenAt === 'number' && Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : null,
    }))
  }

  /**
   * 删除已应用的学习词元（可选，用于保持建议列表干净）
   */
  deleteLearnedWords(groupName: string, words: string[]): number {
    const name = groupName.trim()
    if (!name) return 0
    if (!Array.isArray(words) || words.length === 0) return 0

    const uniq = Array.from(new Set(words.map((w) => this.normalizeLearnWord(w)).filter(Boolean))).slice(0, 80)
    if (uniq.length === 0) return 0

    const stmt = this.db.prepare('DELETE FROM semantic_group_learn_word WHERE group_name = ? AND word = ?')
    let deleted = 0
    const tx = this.db.transaction(() => {
      for (const w of uniq) {
        const res = stmt.run(name, w)
        deleted += res.changes ?? 0
      }
    })
    tx()
    return deleted
  }

  /**
   * 清除向量缓存（用于内存管理）
   */
  clearVectorCache(): void {
    this.vectorCache.clear()
  }
}
