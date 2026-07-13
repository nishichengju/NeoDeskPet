import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrbBallView } from '../src/orb/OrbBallView'

describe('Orb ball view', () => {
  it('renders the fixed ball on the requested dock side', () => {
    const html = renderToStaticMarkup(
      createElement(OrbBallView, {
        dockSide: 'right',
        onMouseDown: vi.fn(),
        onDragStop: vi.fn(),
        onContextMenu: vi.fn(),
      }),
    )

    expect(html).toContain('ndp-orbapp-ball ndp-orbapp-ball-fixed')
    expect(html).toContain('align-self:flex-end')
    expect(html).toContain('单击：打开输入栏｜右键：菜单｜拖拽：移动并吸附')
    expect(html).toContain('ndp-orbapp-ball-icon')
  })

  it('forwards screen coordinates when the drag ends', () => {
    const onDragStop = vi.fn()
    const element = OrbBallView({
      dockSide: 'left',
      onMouseDown: vi.fn(),
      onDragStop,
      onContextMenu: vi.fn(),
    })

    element.props.onMouseUp({ screenX: 123, screenY: 456 })
    expect(onDragStop).toHaveBeenCalledWith({ x: 123, y: 456 })
  })
})
