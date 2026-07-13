import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageRecord } from '../electron/types'
import { OrbMessageMenu } from '../src/orb/OrbMessageMenu'
import { getOrbMessageMenuPosition } from '../src/orb/orbMessageMenuUtils'

function message(role: 'user' | 'assistant'): ChatMessageRecord {
  return { id: `${role}-message`, role, content: role, createdAt: 1 }
}

function findButtons(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return []
  const current = node.type === 'button' ? [node] : []
  return [...current, ...Children.toArray(node.props.children).flatMap(findButtons)]
}

describe('OrbMessageMenu', () => {
  it('keeps assistant and user menus inside the root bounds', () => {
    const rootBounds = { left: 100, top: 50, width: 560, height: 720 }
    expect(getOrbMessageMenuPosition({ clientX: 650, clientY: 760, rootBounds, role: 'assistant' })).toEqual({
      left: 362,
      top: 514,
    })
    expect(getOrbMessageMenuPosition({ clientX: 650, clientY: 760, rootBounds, role: 'user' })).toEqual({
      left: 362,
      top: 550,
    })
    expect(getOrbMessageMenuPosition({
      clientX: -20,
      clientY: -30,
      rootBounds: null,
      role: 'user',
      viewportWidth: 560,
      viewportHeight: 720,
    })).toEqual({
      left: 10,
      top: 10,
    })
    expect(getOrbMessageMenuPosition({
      clientX: Number.NaN,
      clientY: Number.POSITIVE_INFINITY,
      rootBounds: null,
      role: 'assistant',
      viewportWidth: 560,
      viewportHeight: 720,
    })).toEqual({ left: 10, top: 10 })
  })

  it('renders the assistant-only copy action and stable menu geometry', () => {
    const html = renderToStaticMarkup(
      createElement(OrbMessageMenu, {
        message: message('assistant'),
        left: 12,
        top: 34,
        onCopyAssistantText: vi.fn(),
        onEdit: vi.fn(),
        onResend: vi.fn(),
        onDeleteMessage: vi.fn(),
        onDeleteTurn: vi.fn(),
      }),
    )

    expect(html).toContain('data-orb-msgmenu="true"')
    expect(html).toContain('left:12px')
    expect(html).toContain('top:34px')
    expect(html).toContain('width:188px')
    expect(html).toContain('复制正文')
    expect(html.match(/ndp-orbapp-msgmenu-item/g)).toHaveLength(5)
  })

  it('omits copy for users and delegates the remaining actions in order', () => {
    const callbacks = {
      copy: vi.fn(),
      edit: vi.fn(),
      resend: vi.fn(),
      deleteMessage: vi.fn(),
      deleteTurn: vi.fn(),
    }
    const tree = OrbMessageMenu({
      message: message('user'),
      left: 0,
      top: 0,
      onCopyAssistantText: callbacks.copy,
      onEdit: callbacks.edit,
      onResend: callbacks.resend,
      onDeleteMessage: callbacks.deleteMessage,
      onDeleteTurn: callbacks.deleteTurn,
    })
    const buttons = findButtons(tree)
    expect(buttons.map((button) => button.props.children)).toEqual(['编辑', '重新生成', '删除此条', '删除本轮'])

    buttons.forEach((button) => button.props.onClick())
    expect(callbacks.copy).not.toHaveBeenCalled()
    expect(callbacks.edit).toHaveBeenCalledOnce()
    expect(callbacks.resend).toHaveBeenCalledOnce()
    expect(callbacks.deleteMessage).toHaveBeenCalledOnce()
    expect(callbacks.deleteTurn).toHaveBeenCalledOnce()
  })
})
