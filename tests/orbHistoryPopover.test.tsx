import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSessionSummary } from '../electron/types'
import { OrbHistoryPopover } from '../src/orb/OrbHistoryPopover'
import { buildOrbHistoryItems, getOrbHistoryPopoverPosition } from '../src/orb/orbHistoryUtils'

function findButtons(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return []
  const current = node.type === 'button' ? [node] : []
  return [...current, ...Children.toArray(node.props.children).flatMap(findButtons)]
}

describe('OrbHistoryPopover', () => {
  it('positions the popover and arrow within the bar bounds', () => {
    expect(getOrbHistoryPopoverPosition(20, 560)).toEqual({ left: 10, top: 90, arrowX: 16 })
    expect(getOrbHistoryPopoverPosition(540, 560)).toEqual({ left: 230, top: 90, arrowX: 304 })
    expect(getOrbHistoryPopoverPosition(Number.NaN, 560)).toEqual({ left: 120, top: 90, arrowX: 160 })
  })

  it('filters by persona, sorts by update time, limits items, and fills display defaults', () => {
    const sessions: ChatSessionSummary[] = Array.from({ length: 10 }, (_, index) => ({
      id: `default-${index}`,
      name: index === 9 ? '' : `Session ${index}`,
      personaId: 'default',
      createdAt: index,
      updatedAt: index,
      messageCount: index === 9 ? 0 : index,
    }))
    sessions.push({
      id: 'other-persona',
      name: 'Other',
      personaId: 'other',
      createdAt: 100,
      updatedAt: 100,
      messageCount: 99,
    })

    const items = buildOrbHistoryItems(sessions, 'default')
    expect(items).toHaveLength(8)
    expect(items[0]).toEqual({ id: 'default-9', name: '未命名会话', messageCount: 0 })
    expect(items.at(-1)?.id).toBe('default-2')
    expect(items.some((item) => item.id === 'other-persona')).toBe(false)
  })

  it('renders list, loading, and empty states while delegating actions', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const onOpenAll = vi.fn()
    const tree = OrbHistoryPopover({
      left: 10,
      top: 90,
      arrowX: 16,
      loading: false,
      sessions: [
        { id: 'one', name: 'One', messageCount: 2 },
        { id: 'empty', name: 'Empty', messageCount: 0 },
      ],
      onSelect,
      onDelete,
      onOpenAll,
    })
    const buttons = findButtons(tree)
    const selectOne = buttons.find((button) => button.props.title === 'One')
    const deleteOne = buttons.find((button) => button.props.title === '删除该会话')
    const openAll = buttons.at(-1)
    selectOne?.props.onClick()
    deleteOne?.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
    openAll?.props.onClick()

    expect(onSelect).toHaveBeenCalledWith('one')
    expect(onDelete).toHaveBeenCalledWith('one')
    expect(onOpenAll).toHaveBeenCalledOnce()

    const html = renderToStaticMarkup(tree)
    expect(html).toContain('One')
    expect(html).toContain('>2<')
    expect(html).toContain('>空<')
    expect(html).toContain('aria-label="删除该会话"')
    expect(renderToStaticMarkup(createElement(OrbHistoryPopover, {
      left: 0,
      top: 0,
      arrowX: 0,
      loading: true,
      sessions: [],
      onSelect,
      onDelete,
      onOpenAll,
    }))).toContain('加载中')
    expect(renderToStaticMarkup(createElement(OrbHistoryPopover, {
      left: 0,
      top: 0,
      arrowX: 0,
      loading: false,
      sessions: [],
      onSelect,
      onDelete,
      onOpenAll,
    }))).toContain('暂无历史对话')
  })
})
