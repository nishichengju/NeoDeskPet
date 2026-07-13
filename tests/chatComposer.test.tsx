import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../src/windows/chat/ChatComposer'
import { getComposerMediaKind } from '../src/windows/chat/composerMedia'

function renderComposer(patch: Partial<ChatComposerProps> = {}): string {
  const props: ChatComposerProps = {
    api: null,
    input: '',
    pendingAttachments: [],
    attachmentMenuOpen: false,
    isAssistantOutputting: false,
    onInputChange: vi.fn(),
    onAttachmentMenuOpenChange: vi.fn(),
    onReadImageFile: vi.fn(),
    onReadVideoFile: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onInvalidDrop: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...patch,
  }
  return renderToStaticMarkup(createElement(ChatComposer, props))
}

describe('ChatComposer', () => {
  it('classifies supported media MIME types', () => {
    expect(getComposerMediaKind('image/png')).toBe('image')
    expect(getComposerMediaKind(' VIDEO/MP4 ')).toBe('video')
    expect(getComposerMediaKind('text/plain')).toBeNull()
    expect(getComposerMediaKind(null)).toBeNull()
  })

  it('renders an empty composer with a disabled send button and hidden media inputs', () => {
    const html = renderComposer()
    expect(html).toContain('aria-label="消息输入"')
    expect(html).toContain('aria-label="添加附件"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="发送"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('accept="image/*"')
    expect(html).toContain('accept="video/*"')
    expect(html).toContain('accept="image/*,video/*"')
  })

  it('renders the attachment menu and pending image/video previews', () => {
    const html = renderComposer({
      input: 'Message',
      attachmentMenuOpen: true,
      pendingAttachments: [
        {
          id: 'image-1',
          kind: 'image',
          path: 'image.png',
          filename: 'image.png',
          previewDataUrl: 'data:image/png;base64,one',
        },
        { id: 'video-1', kind: 'video', path: 'video.mp4', filename: 'video.mp4' },
      ],
    })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('role="menu"')
    expect(html).toContain('>图片<')
    expect(html).toContain('>视频<')
    expect(html).toContain('>图片或视频<')
    expect(html).toContain('data:image/png;base64,one')
    expect(html).toContain('image.png')
    expect(html).toContain('video.mp4')
    expect(html).toContain('aria-label="移除 image.png"')
    expect(html).toContain('aria-label="移除 video.mp4"')
    expect(html).not.toContain('disabled=""')
  })

  it('switches the primary action to an enabled stop button while output is active', () => {
    const html = renderComposer({ isAssistantOutputting: true })
    expect(html).toContain('ndp-btn-stop')
    expect(html).toContain('aria-label="停止当前输出"')
    expect(html).toContain('■')
    expect(html).not.toContain('disabled=""')
  })
})
