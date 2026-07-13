import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageBlock, ChatMessageRecord } from '../electron/types'
import { ChatMessageBody, type ChatMessageBodyProps } from '../src/windows/chat/ChatMessageBody'

function message(patch: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return { id: 'message-1', role: 'assistant', content: '', createdAt: 1, ...patch }
}

function renderBody(patch: Partial<ChatMessageBodyProps> = {}): string {
  const props: ChatMessageBodyProps = {
    message: message(),
    blocks: [],
    segmentedActive: false,
    isEditing: false,
    editingContent: '',
    editingTextareaRef: createRef<HTMLTextAreaElement>(),
    renderToolUse: (taskId, runId) => createElement('span', { 'data-tool': `${taskId}:${runId ?? ''}` }, 'tool-card'),
    onEditingContentChange: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onContextMenu: vi.fn(),
    onPickAvatar: vi.fn(),
    ...patch,
  }
  return renderToStaticMarkup(createElement(ChatMessageBody, props))
}

describe('ChatMessageBody', () => {
  it('renders assistant text, status, and tool blocks in their original order', () => {
    const blocks: ChatMessageBlock[] = [
      { type: 'text', text: '**Before**' },
      { type: 'status', text: 'Running' },
      { type: 'tool_use', taskId: 'task-1', runId: 'run-1' },
      { type: 'text', text: 'After' },
    ]
    const html = renderBody({
      message: message({ content: 'fallback' }),
      blocks,
      attachments: createElement('span', { 'data-attachment': true }, 'attachment'),
    })

    expect(html).toContain('data-markdown-pending="true"')
    expect(html).toContain('**Before**')
    expect(html).toContain('ndp-muted')
    expect(html).toContain('data-tool="task-1:run-1"')
    expect(html).toContain('data-attachment="true"')
    expect(html.indexOf('Before')).toBeLessThan(html.indexOf('Running'))
    expect(html.indexOf('Running')).toBeLessThan(html.indexOf('tool-card'))
    expect(html.indexOf('tool-card')).toBeLessThan(html.indexOf('After'))
  })

  it('renders normalized assistant fallback content, avatar, and overlay', () => {
    const html = renderBody({
      message: message({ content: '\nHello\n\n\nWorld\n' }),
      avatar: 'data:image/png;base64,assistant',
      overlay: createElement('div', { 'data-overlay': true }, 'viewer'),
    })
    expect(html).toContain('ndp-msg-row-pet')
    expect(html).toContain('data:image/png;base64,assistant')
    expect(html).toContain('Hello')
    expect(html).toContain('World')
    expect(html).toContain('data-overlay="true"')
  })

  it('renders the inline editor without normal content or attachments', () => {
    const html = renderBody({
      message: message({ role: 'user', content: 'Original' }),
      isEditing: true,
      editingContent: 'Changed',
      attachments: createElement('span', { 'data-attachment': true }, 'attachment'),
    })
    expect(html).toContain('ndp-msg-row-user')
    expect(html).toContain('ndp-msg-edit')
    expect(html).toContain('Changed')
    expect(html).toContain('保存')
    expect(html).toContain('取消')
    expect(html).toContain('>我<')
    expect(html).not.toContain('Original')
    expect(html).not.toContain('data-attachment')
  })

  it('reveals segmented assistant bubbles incrementally and hides an unrevealed message', () => {
    const segmentedMessage = message({ content: '这是第一段完整内容。这里是第二段完整内容。' })
    const html = renderBody({
      message: segmentedMessage,
      segmentedActive: true,
      revealCount: 1,
      attachments: createElement('span', { 'data-attachment': true }, 'attachment'),
    })
    expect(html).toContain('这是第一段完整内容')
    expect(html).not.toContain('这里是第二段完整内容')
    expect(html).toContain('data-attachment="true"')
    expect(renderBody({ message: segmentedMessage, segmentedActive: true, revealCount: 0 })).toBe('')
  })
})
