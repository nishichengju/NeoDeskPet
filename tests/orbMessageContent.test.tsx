import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageRecord, TaskRecord } from '../electron/types'
import { OrbAssistantMessageContent } from '../src/orb/OrbAssistantMessageContent'
import { OrbMessageAttachments } from '../src/orb/OrbMessageAttachments'
import { OrbToolCard } from '../src/orb/OrbToolCard'
import {
  buildOrbAttachmentImageItems,
  normalizeOrbMessageAttachments,
  resolveOrbMessageBlocks,
} from '../src/orb/orbMessageContentUtils'

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return { id: 'message-1', role: 'assistant', content: 'answer', createdAt: 1, ...overrides }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    queue: 'chat',
    title: 'Task',
    why: 'Test',
    status: 'done',
    createdAt: 1,
    updatedAt: 2,
    steps: [],
    currentStepIndex: 0,
    toolsUsed: [],
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

describe('Orb message content', () => {
  it('normalizes structured and legacy attachments without changing legacy order', () => {
    const structured = normalizeOrbMessageAttachments(
      message({
        attachments: [
          { kind: 'image', path: ' image.png ', resourceId: ' image-id ', filename: ' Image ' },
          { kind: 'video', path: '' },
        ],
      }),
    )
    expect(structured).toEqual([
      { kind: 'image', path: 'image.png', resourceId: 'image-id', filename: 'Image' },
    ])

    const legacy = normalizeOrbMessageAttachments(
      message({ videoPath: 'legacy.mp4', imagePath: 'legacy.png', image: 'data:image/png;base64,ignored' }),
    )
    expect(legacy).toEqual([
      { kind: 'video', path: 'legacy.mp4' },
      { kind: 'image', path: 'legacy.png' },
    ])
    expect(buildOrbAttachmentImageItems(legacy)).toEqual([{ source: 'legacy.png', title: '图片 1' }])
  })

  it('adds a legacy tool block only when a visible run exists', () => {
    const legacyMessage = message({ taskId: 'task-1' })
    const shellOnly = task({
      toolRuns: [{ id: 'shell', toolName: 'agent.run', status: 'done', startedAt: 1, endedAt: 2 }],
    })
    expect(resolveOrbMessageBlocks(legacyMessage, shellOnly)).toEqual([{ type: 'text', text: 'answer' }])

    const visible = task({
      toolRuns: [{ id: 'run-1', toolName: 'delay.sleep', status: 'done', startedAt: 1, endedAt: 2 }],
    })
    expect(resolveOrbMessageBlocks(legacyMessage, visible)).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool_use', taskId: 'task-1' },
    ])
  })

  it('renders visible tool runs with progress and a complete missing-task error', () => {
    const missing = renderToStaticMarkup(
      createElement(OrbToolCard, {
        api: null,
        taskId: 'missing',
        task: null,
        onOpenImageViewer: vi.fn(),
      }),
    )
    expect(missing).toContain('err: ToolUse（任务未加载）')

    const html = renderToStaticMarkup(
      createElement(OrbToolCard, {
        api: null,
        taskId: 'task-1',
        task: task({
          toolRuns: [
            { id: 'shell', toolName: 'agent.run', status: 'done', startedAt: 1, endedAt: 2 },
            {
              id: 'run-1',
              toolName: 'delay.sleep',
              status: 'done',
              inputPreview: 'one',
              imagePaths: ['data:image/png;base64,tool'],
              startedAt: 1,
              endedAt: 1_001,
            },
            { id: 'run-2', toolName: 'screen.capture', status: 'error', error: 'failed', startedAt: 1, endedAt: 2_001 },
          ],
        }),
        onOpenImageViewer: vi.fn(),
      }),
    )
    expect(html).not.toContain('agent.run')
    expect(html).toContain('delay.sleep')
    expect(html).toContain('screen.capture')
    expect(html).toContain('1/2')
    expect(html).toContain('2/2')
    expect(html).toContain('ndp-tooluse-pill-failed')
    expect(html).toContain('aria-label="查看工具图片 1"')
  })

  it('renders text, status, and exact tool blocks for assistant messages', () => {
    const taskRecord = task({
      toolRuns: [{ id: 'run-1', toolName: 'delay.sleep', status: 'done', startedAt: 1, endedAt: 1_001 }],
    })
    const html = renderToStaticMarkup(
      createElement(OrbAssistantMessageContent, {
        api: null,
        message: message({
          blocks: [
            { type: 'text', text: '**answer**' },
            { type: 'status', text: 'working' },
            { type: 'tool_use', taskId: 'task-1', runId: 'run-1' },
          ],
        }),
        tasksById: new Map([['task-1', taskRecord]]),
        onOpenImageViewer: vi.fn(),
      }),
    )
    expect(html).toContain('data-markdown-pending="true"')
    expect(html).toContain('**answer**')
    expect(html).toContain('ndp-orbpanel-status')
    expect(html).toContain('working')
    expect(html).toContain('delay.sleep')
  })

  it('delegates video opening and image viewer navigation', () => {
    const onOpenAttachment = vi.fn()
    const onOpenImageViewer = vi.fn()
    const tree = OrbMessageAttachments({
      api: null,
      message: message({ videoPath: 'legacy.mp4', image: 'data:image/png;base64,legacy' }),
      onOpenAttachment,
      onOpenImageViewer,
    })
    const video = findElement(tree, (element) => element.props['aria-label'] === '打开视频 1')
    const image = findElement(tree, (element) => element.props['aria-label'] === '查看图片 1')

    video.props.onClick()
    image.props.onClick()
    expect(video.type).toBe('button')
    expect(image.type).toBe('button')
    expect(onOpenAttachment).toHaveBeenCalledWith('legacy.mp4', undefined)
    expect(onOpenImageViewer).toHaveBeenCalledWith(
      [{ source: 'data:image/png;base64,legacy', title: '图片 1' }],
      0,
    )
  })
})
