import { describe, expect, it } from 'vitest'
import type { ChatMessageRecord } from '../electron/types'
import {
  collapseAssistantRuns,
  mergeLeadingPunctuationAcrossToolBoundary,
  normalizeMessageBlocks,
} from '../src/utils/chatMessages'

function message(id: string, role: 'user' | 'assistant', content: string, createdAt: number): ChatMessageRecord {
  return { id, role, content, createdAt }
}

describe('chat message normalization', () => {
  it('collapses consecutive assistant chunks while preserving user boundaries', () => {
    expect(
      collapseAssistantRuns([
        message('u1', 'user', '问题', 1),
        message('a1', 'assistant', '第一句', 2),
        message('a2', 'assistant', '第二句', 3),
        message('u2', 'user', '继续', 4),
      ]),
    ).toEqual([
      { role: 'user', content: '问题', createdAt: 1 },
      { role: 'assistant', content: '第一句\n第二句', createdAt: 2 },
      { role: 'user', content: '继续', createdAt: 4 },
    ])
  })

  it('normalizes structured blocks and falls back to legacy task fields', () => {
    const structured = normalizeMessageBlocks({
      ...message('a1', 'assistant', 'ignored', 1),
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', taskId: 'task-1', runId: 'run-1' },
      ],
    })
    expect(structured).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', taskId: 'task-1', runId: 'run-1' },
    ])

    expect(normalizeMessageBlocks({ ...message('a2', 'assistant', 'legacy', 2), taskId: 'task-2' })).toEqual([
      { type: 'text', text: 'legacy' },
      { type: 'tool_use', taskId: 'task-2' },
    ])
  })

  it('moves short leading punctuation back across a tool boundary', () => {
    expect(mergeLeadingPunctuationAcrossToolBoundary(['要继续', '吗？下一步'], ['run-1'])).toEqual([
      '要继续吗？',
      '下一步',
    ])
  })
})
