import { Children, createElement, createRef, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrbBarView, type OrbBarViewProps, type OrbPendingAttachment } from '../src/orb/OrbBarView'

function props(overrides: Partial<OrbBarViewProps> = {}): OrbBarViewProps {
  return {
    api: null,
    inputRef: createRef<HTMLInputElement>(),
    input: '',
    pendingAttachments: [],
    sending: false,
    onBarMouseDown: vi.fn(),
    onBarMouseUp: vi.fn(),
    onNewConversation: vi.fn(),
    onToggleHistory: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onInputChange: vi.fn(),
    onMediaFiles: vi.fn(),
    onInvalidDrop: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement {
  if (isValidElement(node)) {
    if (predicate(node)) return node
    for (const child of Children.toArray(node.props.children)) {
      try {
        return findElement(child, predicate)
      } catch {
        // Keep searching sibling nodes.
      }
    }
  }
  throw new Error('element not found')
}

describe('Orb bar view', () => {
  it('renders pending media, overflow count, and send state', () => {
    const attachments: OrbPendingAttachment[] = [
      { id: '1', kind: 'image', path: 'one.png', filename: 'one.png', previewDataUrl: 'data:image/png;base64,one' },
      { id: '2', kind: 'video', path: 'two.mp4', filename: 'two.mp4' },
      { id: '3', kind: 'image', path: 'three.png', filename: 'three.png' },
      { id: '4', kind: 'image', path: 'four.png', filename: 'four.png' },
    ]
    const html = renderToStaticMarkup(createElement(OrbBarView, props({ pendingAttachments: attachments })))

    expect(html).toContain('已添加附件：4个')
    expect(html).toContain('data:image/png;base64,one')
    expect(html).toContain('ndp-orbapp-pending-video')
    expect(html).toContain('ndp-orbapp-pending-more">+1')
    expect(html).not.toContain('disabled=""')
  })

  it('forwards history anchors and keyboard commands', () => {
    const viewProps = props()
    const tree = OrbBarView(viewProps)
    const history = findElement(tree, (element) => element.props.title === '历史对话')
    history.props.onClick({
      stopPropagation: vi.fn(),
      currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 40 }) },
    })
    expect(viewProps.onToggleHistory).toHaveBeenCalledWith(30)

    const input = findElement(tree, (element) => element.props.className === 'ndp-orbapp-input')
    const preventDefault = vi.fn()
    input.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      repeat: false,
      nativeEvent: { isComposing: false },
      preventDefault,
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(viewProps.onSubmit).toHaveBeenCalledOnce()

    input.props.onKeyDown({ key: 'Escape', shiftKey: false, repeat: false, nativeEvent: { isComposing: false } })
    expect(viewProps.onClose).toHaveBeenCalledOnce()
  })

  it('filters dropped files and reports unsupported drops', () => {
    const onMediaFiles = vi.fn()
    const onInvalidDrop = vi.fn()
    const tree = OrbBarView(props({ onMediaFiles, onInvalidDrop }))
    const input = findElement(tree, (element) => element.props.className === 'ndp-orbapp-input')
    const image = { type: 'image/png', name: 'image.png' }
    const text = { type: 'text/plain', name: 'note.txt' }

    input.props.onDrop({ preventDefault: vi.fn(), dataTransfer: { files: [image, text] } })
    expect(onMediaFiles).toHaveBeenCalledWith([image])

    input.props.onDrop({ preventDefault: vi.fn(), dataTransfer: { files: [text] } })
    expect(onInvalidDrop).toHaveBeenCalledOnce()
  })
})
