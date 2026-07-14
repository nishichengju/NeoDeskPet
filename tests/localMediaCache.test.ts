import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLocalMediaReference,
  peekLocalMediaUrl,
  resolveLocalMediaDataUrl,
  resolveLocalMediaUrl,
  type LocalMediaCacheApi,
} from '../src/services/localMediaCache'

function createApi(overrides: Partial<LocalMediaCacheApi> = {}): LocalMediaCacheApi {
  return {
    getChatAttachmentUrl: vi.fn(async () => ({
      ok: true as const,
      resourceId: 'resource-1',
      url: 'http://127.0.0.1/media/token-1',
      expiresAt: Date.now() + 60_000,
      mimeType: 'image/png',
      size: 10,
    })),
    readChatAttachmentDataUrl: vi.fn(async () => ({
      ok: true as const,
      resourceId: 'resource-1',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,cache',
    })),
    ...overrides,
  }
}

describe('local media cache', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates concurrent URL requests and exposes a synchronous cached value', async () => {
    const api = createApi()
    const reference = buildLocalMediaReference('C:\\media\\image.png', 'resource-1')

    const [first, second] = await Promise.all([
      resolveLocalMediaUrl(api, reference),
      resolveLocalMediaUrl(api, reference),
    ])

    expect(first).toBe('http://127.0.0.1/media/token-1')
    expect(second).toBe(first)
    expect(api.getChatAttachmentUrl).toHaveBeenCalledOnce()
    expect(peekLocalMediaUrl(api, reference)).toBe(first)
  })

  it('refreshes URLs that enter the expiry guard window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const getChatAttachmentUrl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        resourceId: 'resource-1',
        url: 'http://127.0.0.1/media/token-1',
        expiresAt: 11_000,
        mimeType: 'image/png',
        size: 10,
      })
      .mockResolvedValueOnce({
        ok: true,
        resourceId: 'resource-1',
        url: 'http://127.0.0.1/media/token-2',
        expiresAt: 70_000,
        mimeType: 'image/png',
        size: 10,
      })
    const api = createApi({ getChatAttachmentUrl })

    expect(await resolveLocalMediaUrl(api, 'C:\\media\\image.png')).toContain('token-1')
    vi.setSystemTime(7_000)
    expect(await resolveLocalMediaUrl(api, 'C:\\media\\image.png')).toContain('token-2')
    expect(getChatAttachmentUrl).toHaveBeenCalledTimes(2)
  })

  it('deduplicates data URL reads and bypasses IPC for direct sources', async () => {
    const api = createApi()
    const [first, second] = await Promise.all([
      resolveLocalMediaDataUrl(api, 'C:\\media\\image.png'),
      resolveLocalMediaDataUrl(api, 'C:\\media\\image.png'),
    ])

    expect(first).toBe('data:image/png;base64,cache')
    expect(second).toBe(first)
    expect(api.readChatAttachmentDataUrl).toHaveBeenCalledOnce()
    expect(await resolveLocalMediaUrl(api, 'https://example.test/image.png')).toBe('https://example.test/image.png')
    expect(api.getChatAttachmentUrl).not.toHaveBeenCalled()
  })

  it('does not cache failed requests', async () => {
    const getChatAttachmentUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        ok: true,
        resourceId: 'resource-1',
        url: 'http://127.0.0.1/media/recovered',
        expiresAt: Date.now() + 60_000,
        mimeType: 'image/png',
        size: 10,
      })
    const api = createApi({ getChatAttachmentUrl })

    await expect(resolveLocalMediaUrl(api, 'C:\\media\\retry.png')).resolves.toBe('')
    await expect(resolveLocalMediaUrl(api, 'C:\\media\\retry.png')).resolves.toContain('recovered')
    expect(getChatAttachmentUrl).toHaveBeenCalledTimes(2)
  })
})
