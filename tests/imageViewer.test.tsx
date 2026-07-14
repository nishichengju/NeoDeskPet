import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImageViewer } from '../src/windows/chat/ImageViewer'

describe('ImageViewer', () => {
  it('renders the selected image, position, zoom, and navigation boundaries', () => {
    const html = renderToStaticMarkup(createElement(ImageViewer, {
      items: [
        { src: 'data:image/png;base64,one', title: 'First image' },
        { src: 'data:image/png;base64,two', title: 'Second image' },
      ],
      index: 0,
      onIndexChange: vi.fn(),
      onClose: vi.fn(),
    }))

    expect(html).toContain('First image')
    expect(html).toContain('1 / 2')
    expect(html).toContain('100%')
    expect(html).toContain('data:image/png;base64,one')
    expect(html).toContain('disabled="')
    expect(html).toContain('滚轮缩放')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="ndp-image-viewer-title"')
    expect(html).toContain('aria-label="缩小图片"')
    expect(html).toContain('aria-label="放大图片"')
    expect(html).toContain('aria-label="上一张图片"')
    expect(html).toContain('aria-label="下一张图片"')
  })

  it('renders nothing when the selected index has no item', () => {
    expect(renderToStaticMarkup(createElement(ImageViewer, {
      items: [],
      index: 0,
      onIndexChange: vi.fn(),
      onClose: vi.fn(),
    }))).toBe('')
  })
})
