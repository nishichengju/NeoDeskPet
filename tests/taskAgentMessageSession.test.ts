import { describe, expect, it, vi } from 'vitest'
import {
  TaskAgentMessageSession,
  type TaskAgentMessage,
  type TaskAgentMessageVisionSession,
} from '../electron/task/taskAgentMessageSession'
import { buildToolResultBlock } from '../electron/task/taskAgentTools'

function visionSession(
  overrides: Partial<TaskAgentMessageVisionSession> = {},
): TaskAgentMessageVisionSession {
  return {
    buildCatalogMessage: vi.fn(() => ({ role: 'system', content: 'vision-catalog' })),
    appendInitialSystemMessages: vi.fn((messages: TaskAgentMessage[]) => {
      messages.push({ role: 'system', content: 'vision-initial' })
    }),
    hasInitialImageParts: vi.fn(() => false),
    buildInitialUserContent: vi.fn((request: string) => request),
    appendTextFallbackSystemMessages: vi.fn((messages: TaskAgentMessage[]) => {
      messages.push({ role: 'system', content: 'vision-fallback' })
    }),
    buildTextFallbackUserContent: vi.fn(async (request: string) => `fallback:${request}`),
    ...overrides,
  } as TaskAgentMessageVisionSession
}

function contentList(messages: TaskAgentMessage[]): unknown[] {
  return messages.map((message) => message.content)
}

describe('Task agent message session', () => {
  it('assembles initial persona, Live2D, tool facts, vision, skills, history, and request in order', () => {
    const vision = visionSession()
    const session = new TaskAgentMessageSession({
      system: 'persona',
      extraContext: 'extra-context',
      effectiveRequest: 'current-request',
      historyMessages: [
        { role: 'user', content: 'history-user' },
        { role: 'assistant', content: 'history-assistant' },
      ],
      skillSystemMessages: [{ role: 'system', content: 'skill-system' }],
      visionSession: vision,
      getLive2dSystemMessages: () => [
        { role: 'system', content: 'live2d-tags' },
        { role: 'system', content: 'live2d-params' },
      ],
    })

    const messages = session.buildInitialMessages()

    expect(contentList(messages)).toEqual([
      'persona',
      'extra-context',
      'live2d-tags',
      'live2d-params',
      expect.stringContaining('重要：工具输出是事实来源'),
      'vision-catalog',
      'vision-initial',
      'skill-system',
      'history-user',
      'history-assistant',
      'current-request',
    ])
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'system',
      'system',
      'system',
      'system',
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ])
    expect(vision.appendInitialSystemMessages).toHaveBeenCalledWith(messages)
  })

  it('suppresses a duplicate trailing history request when no image parts are attached', () => {
    const vision = visionSession({
      buildCatalogMessage: vi.fn(() => null),
      appendInitialSystemMessages: vi.fn(),
      buildInitialUserContent: vi.fn(),
    })
    const session = new TaskAgentMessageSession({
      system: '',
      extraContext: '',
      effectiveRequest: 'same request',
      historyMessages: [
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'same request' },
      ],
      skillSystemMessages: [],
      visionSession: vision,
      getLive2dSystemMessages: () => [],
    })

    const messages = session.buildInitialMessages()

    expect(messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'same request' },
    ])
    expect(vision.buildInitialUserContent).not.toHaveBeenCalled()
  })

  it('always appends the visual user payload even when history ends with the same request', () => {
    const visualContent = [
      { type: 'text', text: 'same request' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ]
    const vision = visionSession({
      buildCatalogMessage: vi.fn(() => null),
      appendInitialSystemMessages: vi.fn(),
      hasInitialImageParts: vi.fn(() => true),
      buildInitialUserContent: vi.fn(() => visualContent),
    })
    const session = new TaskAgentMessageSession({
      system: '',
      extraContext: '',
      effectiveRequest: 'same request',
      historyMessages: [{ role: 'user', content: 'same request' }],
      skillSystemMessages: [],
      visionSession: vision,
      getLive2dSystemMessages: () => [],
    })

    const messages = session.buildInitialMessages()

    expect(messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'same request' },
      { role: 'user', content: visualContent },
    ])
  })

  it('rebuilds text fallback in place and replays completed tool results in execution order', async () => {
    let live2dBuilds = 0
    const vision = visionSession({
      buildCatalogMessage: vi.fn(() => null),
      appendInitialSystemMessages: vi.fn(),
      buildTextFallbackUserContent: vi.fn(async () => 'fallback-user'),
    })
    const session = new TaskAgentMessageSession({
      system: '',
      extraContext: '',
      effectiveRequest: 'request',
      historyMessages: [{ role: 'assistant', content: 'history-must-not-replay' }],
      skillSystemMessages: [{ role: 'system', content: 'skill-system' }],
      visionSession: vision,
      getLive2dSystemMessages: () => {
        live2dBuilds += 1
        return [{ role: 'system', content: `live2d-${live2dBuilds}` }]
      },
    })
    const messages = session.buildInitialMessages()
    const longOutput = 'x'.repeat(4_010)

    await session.rebuildTextFallback([
      { toolName: 'first.tool', input: {}, output: 'done' },
      { toolName: 'empty.tool', input: {}, output: '   ' },
      { toolName: 'long.tool', input: {}, output: longOutput },
    ])

    expect(session.messages).toBe(messages)
    expect(live2dBuilds).toBe(2)
    expect(contentList(messages)).toEqual([
      '',
      'live2d-2',
      expect.stringContaining('重要：工具输出是事实来源'),
      'vision-fallback',
      'skill-system',
      'fallback-user',
      expect.stringContaining('以下工具已执行完成'),
      buildToolResultBlock('first.tool', 'done'),
      buildToolResultBlock('empty.tool', '(空)'),
      buildToolResultBlock('long.tool', `${'x'.repeat(4_000)}…`),
    ])
    expect(contentList(messages)).not.toContain('history-must-not-replay')
  })
})
