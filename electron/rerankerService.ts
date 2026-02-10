/**
 * Reranker 精排服务 (RerankerService)
 *
 * 调用外部 Reranker API 对候选文档进行重新排序：
 * 1. 超量召回（需要 N 条就先取 N*ratio 条）
 * 2. 调用 Reranker 模型评估每条候选与查询的语义相关性
 * 3. 按相关性分数重新排序，返回最相关的结果
 *
 * 支持的 API 格式：OpenAI-compatible /v1/rerank 接口
 * 常见提供商：SiliconFlow、Jina AI、Cohere 等
 */

import type { RerankResultItem, RerankDebugInfo } from './types'

export interface RerankerConfig {
  url: string // Reranker API 基础地址
  apiKey: string // API Key
  model: string // 模型名（如 BAAI/bge-reranker-v2-m3）
  timeoutMs?: number // 请求超时（默认 30000ms）
}

export class RerankerService {
  private url: string
  private apiKey: string
  private model: string
  private timeoutMs: number

  constructor(config: RerankerConfig) {
    this.url = config.url.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.model = config.model
    this.timeoutMs = config.timeoutMs ?? 30000
  }

  /**
   * 检查配置是否有效
   */
  isConfigured(): boolean {
    return !!(this.url && this.apiKey && this.model)
  }

  /**
   * 调用 Reranker API 对候选文档重新排序
   * @param query 查询文本
   * @param documents 候选文档列表
   * @returns 重排序后的索引和分数
   */
  async rerank(query: string, documents: string[]): Promise<RerankResultItem[]> {
    if (documents.length === 0) return []
    if (!this.isConfigured()) return []

    try {
      const endpoint = `${this.url}/rerank`

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        const errMsg = (errData as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}`
        console.error('[Reranker] API 错误:', errMsg)
        return []
      }

      const data = (await resp.json()) as {
        results?: Array<{ index: number; relevance_score: number }>
      }

      if (!data.results || !Array.isArray(data.results)) {
        console.error('[Reranker] 响应格式错误: 缺少 results 数组')
        return []
      }

      return data.results
        .map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[Reranker] 请求超时')
      } else {
        console.error('[Reranker] 请求失败:', err)
      }
      return []
    }
  }

  /**
   * 对候选记录进行精排并返回调试信息
   * @param query 查询文本
   * @param candidates 候选记录列表（需包含 content 字段）
   * @param limit 最终返回数量
   * @param minScore 最小分数阈值
   * @returns 精排后的记录和调试信息
   */
  async rerankWithDebug<T extends { content: string }>(
    query: string,
    candidates: T[],
    limit: number,
    minScore: number
  ): Promise<{ items: T[]; debug: RerankDebugInfo }> {
    const startedAt = Date.now()
    const debug: RerankDebugInfo = {
      enabled: true,
      attempted: false,
      candidateCount: candidates.length,
      rerankCount: 0,
      tookMs: 0,
    }

    if (candidates.length === 0 || !this.isConfigured()) {
      debug.tookMs = Date.now() - startedAt
      return { items: candidates.slice(0, limit), debug }
    }

    debug.attempted = true
    const documents = candidates.map((c) => c.content.trim())
    const results = await this.rerank(query, documents)

    if (results.length === 0) {
      debug.error = 'Reranker 返回空结果'
      debug.tookMs = Date.now() - startedAt
      return { items: candidates.slice(0, limit), debug }
    }

    // 按分数过滤和截取
    const filtered = results.filter((r) => r.relevanceScore >= minScore).slice(0, limit)

    const reranked = filtered.map((r) => candidates[r.index])
    debug.rerankCount = reranked.length
    debug.tookMs = Date.now() - startedAt

    return { items: reranked, debug }
  }
}

/**
 * 创建 Reranker 服务实例
 * 如果配置无效则返回 null
 */
export function createRerankerService(
  url: string | undefined,
  apiKey: string | undefined,
  model: string | undefined
): RerankerService | null {
  const trimmedUrl = url?.trim()
  const trimmedKey = apiKey?.trim()
  const trimmedModel = model?.trim()

  if (!trimmedUrl || !trimmedKey || !trimmedModel) {
    return null
  }

  return new RerankerService({
    url: trimmedUrl,
    apiKey: trimmedKey,
    model: trimmedModel,
  })
}
