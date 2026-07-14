import { Children, createElement, createRef, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageRecord, ChatSessionSummary } from '../electron/types'
import { OrbPanelView, type OrbPanelViewProps } from '../src/orb/OrbPanelView'

const summary: ChatSessionSummary = {
  id: 'session-1',
  name: 'Panel session',
  personaId: 'default',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
}

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessageRecord {
  return { id, role, content, createdAt: 1 }
}

function props(overrides: Partial<OrbPanelViewProps> = {}): OrbPanelViewProps {
  return {
    sessionName: 'Panel session',
    summary,
    loading: false,
    error: null,
    messages: [],
    hiddenMessageCount: 0,
    listRef: createRef<HTMLDivElement>(),
    endRef: createRef<HTMLDivElement>(),
    editingMessageId: null,
    editingMessageContent: '',
    renderAssistantMessage: (item) => createElement('span', { className: 'assistant-body' }, item.content),
    renderAttachments: () => null,
    onOpenFullChat: vi.fn(),
    onLoadEarlierMessages: vi.fn(),
    onMessageContextMenu: vi.fn(),
    onEditingMessageContentChange: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
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

describe('Orb panel view', () => {
  it('renders the session header and empty state', () => {
    const html = renderToStaticMarkup(createElement(OrbPanelView, props()))
    expect(html).toContain('Panel session')
    expect(html).toContain('2条')
    expect(html).toContain('还没有消息')
    expect(html).toContain('打开完整聊天窗口')
  })

  it('announces loading politely and errors assertively', () => {
    const loadingHtml = renderToStaticMarkup(createElement(OrbPanelView, props({ loading: true })))
    const errorHtml = renderToStaticMarkup(createElement(OrbPanelView, props({ error: '加载失败' })))

    expect(loadingHtml).toContain('role="status"')
    expect(loadingHtml).toContain('aria-live="polite"')
    expect(errorHtml).toContain('role="alert"')
    expect(errorHtml).toContain('aria-live="assertive"')
    expect(errorHtml).toContain('aria-atomic="true"')
  })

  it('renders user markdown, assistant content, and attachments in message order', () => {
    const messages = [message('user-1', 'user', '**hello**'), message('assistant-1', 'assistant', 'answer')]
    const html = renderToStaticMarkup(
      createElement(
        OrbPanelView,
        props({
          messages,
          renderAttachments: (item) => createElement('span', { className: `attachment-${item.id}` }, 'attachment'),
        }),
      ),
    )

    expect(html).toContain('ndp-orbpanel-msg-user')
    expect(html).toContain('data-markdown-pending="true"')
    expect(html).toContain('**hello**')
    expect(html).toContain('assistant-body')
    expect(html).toContain('attachment-user-1')
    expect(html).toContain('attachment-assistant-1')
  })

  it('shows the hidden message count and delegates loading earlier messages', () => {
    const onLoadEarlierMessages = vi.fn()
    const tree = OrbPanelView(props({ hiddenMessageCount: 120, onLoadEarlierMessages }))
    const button = findElement(
      tree,
      (element) => element.type === 'button' && String(element.props.children).includes('120'),
    )

    button.props.onClick()
    expect(onLoadEarlierMessages).toHaveBeenCalledOnce()
  })

  it('shows resend only for user edits and delegates edit actions', () => {
    const onSaveEdit = vi.fn()
    const onCancelEdit = vi.fn()
    const tree = OrbPanelView(
      props({
        messages: [message('user-1', 'user', 'draft')],
        editingMessageId: 'user-1',
        editingMessageContent: 'edited',
        onSaveEdit,
        onCancelEdit,
      }),
    )
    const save = findElement(tree, (element) => element.type === 'button' && element.props.children === '保存')
    const resend = findElement(tree, (element) => element.type === 'button' && element.props.children === '保存并重发')
    const cancel = findElement(tree, (element) => element.type === 'button' && element.props.children === '取消')

    save.props.onClick()
    resend.props.onClick()
    cancel.props.onClick()
    expect(onSaveEdit).toHaveBeenNthCalledWith(1, false)
    expect(onSaveEdit).toHaveBeenNthCalledWith(2, true)
    expect(onCancelEdit).toHaveBeenCalledOnce()

    const assistantHtml = renderToStaticMarkup(
      createElement(
        OrbPanelView,
        props({ messages: [message('assistant-1', 'assistant', 'answer')], editingMessageId: 'assistant-1' }),
      ),
    )
    expect(assistantHtml).not.toContain('保存并重发')
  })
})
