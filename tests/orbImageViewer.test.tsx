import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrbImageViewer } from '../src/orb/OrbImageViewer'
import { applyOrbImageViewerWheelScale, moveOrbImageViewerIndex } from '../src/orb/orbImageViewerUtils'

describe('OrbImageViewer', () => {
  it('wraps navigation and clamps wheel scaling', () => {
    expect(moveOrbImageViewerIndex(0, -1, 3)).toBe(2)
    expect(moveOrbImageViewerIndex(2, 1, 3)).toBe(0)
    expect(moveOrbImageViewerIndex(99, -1, 3)).toBe(1)
    expect(moveOrbImageViewerIndex(0, -4, 3)).toBe(2)
    expect(moveOrbImageViewerIndex(0, 1, 0)).toBe(0)

    expect(applyOrbImageViewerWheelScale(1, -1)).toBeCloseTo(1.1)
    expect(applyOrbImageViewerWheelScale(1, 1)).toBeCloseTo(0.9)
    expect(applyOrbImageViewerWheelScale(6, -1)).toBe(6)
    expect(applyOrbImageViewerWheelScale(0.2, 1)).toBe(0.2)
  })

  it('renders a single image without navigation controls', () => {
    const html = renderToStaticMarkup(
      createElement(OrbImageViewer, {
        items: [{ src: 'data:image/png;base64,one', title: 'One' }],
        index: 0,
        onIndexChange: vi.fn(),
        onClose: vi.fn(),
      }),
    )

    expect(html).toContain('ndp-orbimg-viewer')
    expect(html).toContain('ndp-orbimg-viewer-title')
    expect(html).toContain('One')
    expect(html).toContain('1/1')
    expect(html).toContain('scale(1)')
    expect(html).not.toContain('ndp-orbimg-viewer-nav')
  })

  it('renders the selected item with previous and next controls', () => {
    const html = renderToStaticMarkup(
      createElement(OrbImageViewer, {
        items: [
          { src: 'data:image/png;base64,one', title: 'One' },
          { src: 'data:image/png;base64,two', title: 'Two' },
          { src: 'data:image/png;base64,three', title: 'Three' },
        ],
        index: 1,
        onIndexChange: vi.fn(),
        onClose: vi.fn(),
      }),
    )

    expect(html).toContain('Two')
    expect(html).toContain('2/3')
    expect(html.match(/ndp-orbimg-viewer-nav/g)).toHaveLength(2)
    expect(html).toContain('title="上一张"')
    expect(html).toContain('title="下一张"')
  })
})
