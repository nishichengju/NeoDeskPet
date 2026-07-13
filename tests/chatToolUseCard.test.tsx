import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../electron/types'
import { ChatToolUseCard } from '../src/windows/chat/ChatToolUseCard'
import { parseMmvectorResults } from '../src/windows/chat/toolUseMedia'

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
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
    ...patch,
  }
}

function renderCard(record: TaskRecord | null, runId?: string): string {
  return renderToStaticMarkup(createElement(ChatToolUseCard, {
    task: record,
    runId,
    api: null,
    messageId: 'message-1',
    onOpenImageViewer: vi.fn(),
    onRerollImageGenerate: vi.fn(async () => []),
  }))
}

describe('ChatToolUseCard', () => {
  it('parses clean and log-wrapped mmvector output', () => {
    expect(parseMmvectorResults('{"ok":true,"count":1,"results":[{"type":"image","imagePath":"image.png"}]}')).toEqual({
      count: 1,
      results: [{ type: 'image', imagePath: 'image.png' }],
    })
    expect(parseMmvectorResults('log: {"ok":true,"results":[]} done')).toEqual({ count: undefined, results: [] })
    expect(parseMmvectorResults('{"ok":false,"results":[]}')).toBeNull()
  })

  it('renders only the run selected by runId and ignores agent shell runs', () => {
    const record = task({
      toolRuns: [
        { id: 'shell', toolName: 'agent.run', status: 'done', startedAt: 1 },
        { id: 'search', toolName: 'web.search', status: 'done', inputPreview: 'cats', startedAt: 2 },
        { id: 'file', toolName: 'file.read', status: 'error', error: 'missing', startedAt: 3 },
      ],
    })
    const html = renderCard(record, 'search')
    expect(html).toContain('DeskPet · ToolUse: web.search')
    expect(html).toContain('in: cats')
    expect(html).not.toContain('agent.run')
    expect(html).not.toContain('file.read')
    expect(renderCard(record, 'shell')).toBe('')
  })

  it('renders generated images and multimodal image/video results', () => {
    const outputPreview = [
      'tool log',
      JSON.stringify({
        ok: true,
        results: [
          { id: 1, type: 'image', imagePath: 'result.png', filename: 'result.png', score: 0.9 },
          { id: 2, type: 'video', videoUrl: 'http://localhost:17777/video.mp4', filename: 'video.mp4' },
        ],
      }),
      'done',
    ].join('\n')
    const html = renderCard(task({
      toolRuns: [{
        id: 'image-run',
        toolName: 'image.generate',
        status: 'done',
        inputPreview: 'draw a desk pet',
        outputPreview,
        imagePaths: ['generated.png', 'https://example.com/not-local.png'],
        startedAt: 1,
      }],
    }))

    expect(html).toContain('工具输出图片（可预览）')
    expect(html).toContain('generated.png')
    expect(html).not.toContain('not-local.png')
    expect(html).toContain('重新生成')
    expect(html).toContain('多模态结果（可预览/播放）')
    expect(html).toContain('result.png · 0.9000')
    expect(html).toContain('video.mp4')
  })

  it('falls back to visible legacy task steps when no real runs exist', () => {
    const html = renderCard(task({
      toolRuns: [{ id: 'shell', toolName: 'agent.run', status: 'done', startedAt: 1 }],
      steps: [
        { id: 'shell-step', title: 'Agent', tool: 'agent.run', status: 'done' },
        { id: 'file-step', title: 'Read file', tool: 'file.read', status: 'failed', input: 'a.txt', error: 'missing' },
      ],
    }))
    expect(html).toContain('DeskPet · ToolUse: file.read')
    expect(html).toContain('in: a.txt')
    expect(html).toContain('err: missing')
    expect(html).not.toContain('agent.run')
    expect(renderCard(null)).toBe('')
  })
})
