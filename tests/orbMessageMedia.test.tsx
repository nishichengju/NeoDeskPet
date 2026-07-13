import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NeoDeskPetApi } from '../src/neoDeskPetApi'
import {
  OrbImagePreview,
  OrbLocalVideo,
  ToolUseDuration,
} from '../src/orb/OrbMessageMedia'
import {
  formatDurationMs,
  resolveOrbImageSource,
  resolveOrbVideoSource,
} from '../src/orb/orbMessageMediaUtils'

function createMediaApi() {
  return {
    readChatAttachmentDataUrl: vi.fn(async () => ({ ok: true as const, dataUrl: 'data:image/png;base64,orb' })),
    getChatAttachmentUrl: vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1/orb-video' })),
  }
}

describe('Orb message media', () => {
  it('formats durations with explicit hour, minute, and second units', () => {
    expect(formatDurationMs(Number.NaN)).toBe('0秒')
    expect(formatDurationMs(999)).toBe('0秒')
    expect(formatDurationMs(61_000)).toBe('1分1秒')
    expect(formatDurationMs(3_723_000)).toBe('1小时2分3秒')

    const html = renderToStaticMarkup(
      createElement(ToolUseDuration, { startedAt: 1_000, endedAt: 3_724_000 }),
    )
    expect(html).toContain('执行时间 1小时2分3秒')
  })

  it('resolves local image and video references through the media API', async () => {
    const api = createMediaApi()

    await expect(
      resolveOrbImageSource(api as unknown as NeoDeskPetApi, {
        imagePath: 'attachments/orb.png',
        resourceId: 'image-resource',
      }),
    ).resolves.toBe('data:image/png;base64,orb')
    expect(api.readChatAttachmentDataUrl).toHaveBeenCalledWith({
      resourceId: 'image-resource',
      path: 'attachments/orb.png',
    })

    await expect(
      resolveOrbVideoSource(api as unknown as NeoDeskPetApi, {
        videoPath: 'attachments/orb.mp4',
        resourceId: 'video-resource',
      }),
    ).resolves.toBe('http://127.0.0.1/orb-video')
    expect(api.getChatAttachmentUrl).toHaveBeenCalledWith({
      resourceId: 'video-resource',
      path: 'attachments/orb.mp4',
    })
  })

  it('uses direct media sources immediately and clears failed local resolutions', async () => {
    const api = createMediaApi()
    const imageUrl = 'https://example.com/orb.png'
    const videoUrl = 'blob:orb-video'

    await expect(resolveOrbImageSource(api as unknown as NeoDeskPetApi, { imagePath: imageUrl })).resolves.toBe(imageUrl)
    await expect(resolveOrbVideoSource(api as unknown as NeoDeskPetApi, { videoPath: videoUrl })).resolves.toBe(videoUrl)
    expect(api.readChatAttachmentDataUrl).not.toHaveBeenCalled()
    expect(api.getChatAttachmentUrl).not.toHaveBeenCalled()

    const failedApi = {
      readChatAttachmentDataUrl: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
      getChatAttachmentUrl: vi.fn(async () => {
        throw new Error('missing')
      }),
    }
    await expect(
      resolveOrbImageSource(failedApi as unknown as NeoDeskPetApi, { imagePath: 'missing.png' }),
    ).resolves.toBe('')
    await expect(
      resolveOrbVideoSource(failedApi as unknown as NeoDeskPetApi, { videoPath: 'missing.mp4' }),
    ).resolves.toBe('')

    const imageHtml = renderToStaticMarkup(
      createElement(OrbImagePreview, { api: null, imagePath: imageUrl, alt: 'Orb preview' }),
    )
    const videoHtml = renderToStaticMarkup(
      createElement(OrbLocalVideo, { api: null, videoPath: videoUrl, controls: true, playsInline: true }),
    )
    expect(imageHtml).toContain(`src="${imageUrl}"`)
    expect(videoHtml).toContain(`src="${videoUrl}"`)
  })
})
