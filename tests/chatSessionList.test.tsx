import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSessionSummary } from '../electron/types'
import { ChatSessionList, type ChatSessionListProps } from '../src/windows/chat/ChatSessionList'

function session(id: string, name: string, messageCount: number): ChatSessionSummary {
  return {
    id,
    name,
    personaId: 'default',
    createdAt: 1,
    updatedAt: 2,
    messageCount,
  }
}

function renderList(patch: Partial<ChatSessionListProps> = {}): string {
  const props: ChatSessionListProps = {
    open: true,
    sessions: [session('one', 'First session', 3), session('two', 'Second session', 0)],
    currentSessionId: 'one',
    currentSessionName: 'First session',
    editingSessionId: null,
    editingSessionName: '',
    onNewSession: vi.fn(),
    onSwitchSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
    onStartRename: vi.fn(),
    onCancelRename: vi.fn(),
    onEditingSessionNameChange: vi.fn(),
    ...patch,
  }
  return renderToStaticMarkup(createElement(ChatSessionList, props))
}

describe('ChatSessionList', () => {
  it('renders nothing while closed', () => {
    expect(renderList({ open: false })).toBe('')
  })

  it('renders the current session, counts, active state, and accessible actions', () => {
    const html = renderList()
    expect(html).toContain('ndp-session-current">First session')
    expect(html).toContain('ndp-session-item active')
    expect(html).toContain('First session')
    expect(html).toContain('3 条')
    expect(html).toContain('Second session')
    expect(html).toContain('0 条')
    expect(html).toContain('aria-label="重命名 First session"')
    expect(html).toContain('aria-label="删除 Second session"')
  })

  it('renders the controlled rename input only for the edited session', () => {
    const html = renderList({ editingSessionId: 'two', editingSessionName: 'Renamed session' })
    expect(html).toContain('ndp-session-rename-input')
    expect(html).toContain('value="Renamed session"')
    expect(html).toContain('First session')
    expect(html).not.toContain('Second session</span>')
    expect(html).not.toContain('0 条')
  })
})
