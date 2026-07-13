import { describe, expect, it, vi } from 'vitest'
import {
  MemoryEmbeddingClient,
  buildMemoryEmbeddingsEndpoint,
  hashMemoryEmbeddingInput,
  normalizeMemoryEmbeddingVector,
  resolveMemoryEmbeddingConfig,
} from '../electron/memory/memoryEmbeddingClient'
import type { AISettings, MemorySettings } from '../electron/types'

const config = {
  model: 'embedding-smoke',
  apiKey: 'secret',
  endpoint: 'http://127.0.0.1:1234/v1/embeddings',
}

function vector(a: number, b = 0): number[] {
  return [a, b, 0, 0, 0, 0, 0, 0]
}

describe('MemoryEmbeddingClient', () => {
  it('resolves main/custom settings and normalizes embeddings endpoints', () => {
    const ai = { apiKey: ' main-key ', baseUrl: ' https://api.example/v1/ ' } as AISettings
    expect(resolveMemoryEmbeddingConfig({} as MemorySettings, ai)).toEqual({
      model: 'text-embedding-3-small',
      apiKey: 'main-key',
      endpoint: 'https://api.example/v1/embeddings',
    })
    expect(resolveMemoryEmbeddingConfig({} as MemorySettings, ai, { requireExplicitModel: true })).toBeNull()
    expect(
      resolveMemoryEmbeddingConfig(
        {
          vectorEmbeddingModel: ' custom-model ',
          vectorUseCustomAi: true,
          vectorAiApiKey: ' custom-key ',
          vectorAiBaseUrl: 'https://custom.example/v1/embeddings',
        } as MemorySettings,
        ai,
        { requireExplicitModel: true },
      ),
    ).toEqual({
      model: 'custom-model',
      apiKey: 'custom-key',
      endpoint: 'https://custom.example/v1/embeddings',
    })
    expect(buildMemoryEmbeddingsEndpoint('')).toBe('/embeddings')
  })

  it('deduplicates batch inputs and reuses the LRU cache across requests', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'embedding-smoke',
        input: ['alpha text', 'beta'],
        encoding_format: 'float',
      })
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: vector(3, 4) },
            { index: 1, embedding: vector(1) },
          ],
        }),
        { status: 200 },
      )
    })
    const client = new MemoryEmbeddingClient({ fetchImpl, maxCacheEntries: 2 })

    const first = await client.embedTexts(config, [' alpha\ntext ', 'alpha text', 'beta'])
    const second = await client.embedTexts(config, ['beta', 'alpha text'])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(Array.from(first[0].vec)).toEqual(Array.from(first[1].vec))
    expect(first[0].vec[0]).toBeCloseTo(0.6)
    expect(first[0].vec[1]).toBeCloseTo(0.8)
    expect(second.map((item) => item.hash)).toEqual([
      hashMemoryEmbeddingInput(config.model, 'beta'),
      hashMemoryEmbeddingInput(config.model, 'alpha text'),
    ])
  })

  it('honors response indexes and rejects malformed provider payloads', async () => {
    const fetchImpl = vi
      .fn<[string | URL | Request, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: vector(0, 2) },
              { index: 0, embedding: vector(1) },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), {
          status: 503,
          statusText: 'Unavailable',
        }),
      )
    const client = new MemoryEmbeddingClient({ fetchImpl })

    const embedded = await client.embedTexts(config, ['first', 'second'])
    expect(embedded[0].vec[0]).toBeCloseTo(1)
    expect(embedded[1].vec[1]).toBeCloseTo(1)
    await expect(client.embedTexts(config, ['third'])).rejects.toThrow('provider unavailable')
    expect(() => normalizeMemoryEmbeddingVector(vector(0))).toThrow('embeddings 返回向量无效')
  })
})
