import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageRecord } from '../electron/types'
import {
  ChatMessageAttachments,
} from '../src/windows/chat/ChatMessageAttachments'
import { normalizeMessageAttachments } from '../src/windows/chat/messageAttachments'

function message(patch: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return { id: 'message-1', role: 'assistant', content: '', createdAt: 1, ...patch }
}

describe('ChatMessageAttachments', () => {
  it('normalizes persisted attachment records and ignores incomplete entries', () => {
    expect(normalizeMessageAttachments(message({
      attachments: [
        { kind: 'image', path: ' image.png ', resourceId: ' media-1 ', filename: ' image.png ' },
        { kind: 'video', path: 'video.mp4' },
        { kind: 'image', path: '' },
      ],
    }))).toEqual([
      { kind: 'image', path: 'image.png', resourceId: 'media-1', filename: 'image.png' },
      { kind: 'video', path: 'video.mp4' },
    ])
  })

  it('falls back to legacy image, imagePath, and videoPath fields', () => {
    expect(normalizeMessageAttachments(message({ imagePath: 'image.png', videoPath: 'video.mp4', image: 'ignored' }))).toEqual([
      { kind: 'image', path: 'image.png' },
      { kind: 'video', path: 'video.mp4' },
    ])
    expect(normalizeMessageAttachments(message({ image: 'data:image/png;base64,one' }))).toEqual([
      { kind: 'image', dataUrl: 'data:image/png;base64,one' },
    ])
  })

  it('renders data images and returns no markup when attachments are hidden', () => {
    const props = {
      message: message({ image: 'data:image/png;base64,one' }),
      api: null,
      onOpenImageViewer: vi.fn(),
    }
    const html = renderToStaticMarkup(createElement(ChatMessageAttachments, props))
    expect(html).toContain('ndp-msg-attachments')
    expect(html).toContain('data:image/png;base64,one')
    expect(html).toContain('查看')
    expect(renderToStaticMarkup(createElement(ChatMessageAttachments, { ...props, hidden: true }))).toBe('')
  })
})
