import { createHash } from 'node:crypto'
import type { AISettings, MemorySettings } from '../types'

export type MemoryEmbeddingConfig = {
  model: string
  apiKey: string
  endpoint: string
}

export type MemoryEmbeddedText = {
  text: string
  hash: string
  vec: Float32Array
}

export type MemoryEmbeddingClientOptions = {
  fetchImpl?: typeof fetch
  maxCacheEntries?: number
}

export function normalizeMemoryEmbeddingText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildMemoryEmbeddingsEndpoint(baseUrl: string): string {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return '/embeddings'
  const base = raw.replace(/\/+$/, '').replace(/\/embeddings$/i, '')
  return `${base}/embeddings`
}

export function hashMemoryEmbeddingInput(model: string, text: string): string {
  return createHash('sha1')
    .update(`${model}\n${normalizeMemoryEmbeddingText(text)}`)
    .digest('hex')
}

export function resolveMemoryEmbeddingConfig(
  memSettings: MemorySettings | undefined,
  aiSettings: AISettings,
  options: { requireExplicitModel?: boolean } = {},
): MemoryEmbeddingConfig | null {
  const configuredModel = (memSettings?.vectorEmbeddingModel ?? '').trim()
  const model = configuredModel || (options.requireExplicitModel ? '' : 'text-embedding-3-small')
  const useCustom = memSettings?.vectorUseCustomAi ?? false
  const apiKey = ((useCustom ? memSettings?.vectorAiApiKey : aiSettings.apiKey) ?? '').trim()
  const baseUrl = ((useCustom ? memSettings?.vectorAiBaseUrl : aiSettings.baseUrl) ?? '').trim()
  if (!model || !apiKey || !baseUrl) return null
  return { model, apiKey, endpoint: buildMemoryEmbeddingsEndpoint(baseUrl) }
}

export function normalizeMemoryEmbeddingVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || value.length < 8) {
    throw new Error('embeddings 返回为空或维度过小')
  }

  const out = new Float32Array(value.length)
  let squaredNorm = 0
  for (let i = 0; i < value.length; i++) {
    const numeric = Number(value[i])
    out[i] = Number.isFinite(numeric) ? numeric : 0
    squaredNorm += out[i] * out[i]
  }

  const norm = Math.sqrt(squaredNorm)
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('embeddings 返回向量无效')
  for (let i = 0; i < out.length; i++) out[i] = out[i] / norm
  return out
}

export class MemoryEmbeddingClient {
  private readonly fetchImpl: typeof fetch
  private readonly maxCacheEntries: number
  private readonly cache = new Map<string, Float32Array>()

  constructor(options: MemoryEmbeddingClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxCacheEntries = Math.max(1, Math.floor(options.maxCacheEntries ?? 1200))
  }

  clearCache(): void {
    this.cache.clear()
  }

  async embedTexts(config: MemoryEmbeddingConfig, texts: string[]): Promise<MemoryEmbeddedText[]> {
    const inputs = texts.map((text) => normalizeMemoryEmbeddingText(text).slice(0, 2000))
    if (inputs.length === 0) return []

    const hashes = inputs.map((text) => hashMemoryEmbeddingInput(config.model, text))
    const results = new Array<MemoryEmbeddedText>(inputs.length)
    const missingIndices = new Map<string, number[]>()
    const requestTexts: string[] = []
    const requestHashes: string[] = []

    for (let i = 0; i < inputs.length; i++) {
      const hash = hashes[i]
      const cached = this.readCache(hash)
      if (cached) {
        results[i] = { text: inputs[i], hash, vec: cached }
        continue
      }

      const indices = missingIndices.get(hash)
      if (indices) {
        indices.push(i)
        continue
      }
      missingIndices.set(hash, [i])
      requestTexts.push(inputs[i])
      requestHashes.push(hash)
    }

    if (requestTexts.length > 0) {
      const response = await this.fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: requestTexts, encoding_format: 'float' }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({} as unknown))
        const message =
          (errorData as { error?: { message?: string } }).error?.message ??
          `HTTP ${response.status}: ${response.statusText}`
        throw new Error(message)
      }

      const data = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>
      }
      const responseItems = Array.isArray(data.data) ? data.data : []
      if (responseItems.length !== requestTexts.length) {
        throw new Error(`embeddings 返回数量不匹配：expect=${requestTexts.length} got=${responseItems.length}`)
      }

      const ordered = new Array<number[] | undefined>(requestTexts.length)
      for (let i = 0; i < responseItems.length; i++) {
        const item = responseItems[i]
        const index = Number.isInteger(item.index) ? Number(item.index) : i
        if (index < 0 || index >= ordered.length || ordered[index]) {
          throw new Error('embeddings 返回索引无效')
        }
        ordered[index] = item.embedding
      }

      for (let i = 0; i < requestHashes.length; i++) {
        const hash = requestHashes[i]
        const vec = normalizeMemoryEmbeddingVector(ordered[i])
        this.remember(hash, vec)
        for (const resultIndex of missingIndices.get(hash) ?? []) {
          results[resultIndex] = { text: inputs[resultIndex], hash, vec }
        }
      }
    }

    return results
  }

  private readCache(hash: string): Float32Array | undefined {
    const cached = this.cache.get(hash)
    if (!cached) return undefined
    this.cache.delete(hash)
    this.cache.set(hash, cached)
    return cached
  }

  private remember(hash: string, vec: Float32Array): void {
    if (!hash || vec.length < 8) return
    this.cache.delete(hash)
    this.cache.set(hash, vec)
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (!oldest) break
      this.cache.delete(oldest)
    }
  }
}
