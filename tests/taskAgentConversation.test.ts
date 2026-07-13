import { describe, expect, it } from 'vitest'
import { TaskAgentConversation, extractLive2dTags } from '../electron/task/taskAgentConversation'
import { TOOL_REQUEST_END, TOOL_REQUEST_START } from '../electron/task/taskAgentTools'

describe('Task agent conversation', () => {
  it('extracts Live2D tags while normalizing surrounding text', () => {
    expect(extractLive2dTags('  hello  \n[表情:smile]\n[动作：wave]  ')).toEqual({
      cleanedText: 'hello',
      expression: 'smile',
      motion: 'wave',
    })
  })

  it('keeps each streamed turn anchored to its starting draft', () => {
    const conversation = new TaskAgentConversation(3)
    const firstTurn = conversation.beginTurn('native')
    firstTurn('first')
    firstTurn('first expanded')
    const secondTurn = conversation.beginTurn('native')
    secondTurn('second')

    expect(conversation.snapshot().draftReply).toBe('first expanded\nsecond')
  })

  it('hides text tool protocol blocks from the visible draft', () => {
    const conversation = new TaskAgentConversation(2)
    const apply = conversation.beginTurn('text')
    apply(
      [
        'visible',
        TOOL_REQUEST_START,
        'tool_name:「始」delay.sleep「末」',
        'input_json:「始」{"ms":1}「末」',
        TOOL_REQUEST_END,
      ].join('\n'),
    )

    expect(conversation.snapshot().draftReply).toBe('visible')
  })

  it('accumulates usage across multiple model turns', () => {
    const conversation = new TaskAgentConversation(2)
    conversation.addUsage({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    conversation.addUsage({ promptTokens: 5, completionTokens: 6, totalTokens: 11 })

    expect(conversation.snapshot().usage).toEqual({ promptTokens: 8, completionTokens: 10, totalTokens: 18 })
  })

  it('requests another turn for unsupported action claims and internal tool names', () => {
    const conversation = new TaskAgentConversation(2)

    expect(
      conversation.decideFinal('已经帮你截图了', 0, { hasFinishedToolRun: false, evidenceText: '' }),
    ).toMatchObject({ kind: 'retry' })
    expect(
      conversation.decideFinal('结果来自 browser.open', 0, { hasFinishedToolRun: true, evidenceText: '' }),
    ).toMatchObject({ kind: 'retry' })
    expect(
      conversation.decideFinal('没有调用工具。', 0, { hasFinishedToolRun: false, evidenceText: '' }),
    ).toEqual({ kind: 'accept', text: '没有调用工具。' })
  })

  it('accepts evidenced URLs and sanitizes an unverified URL on the last turn', () => {
    const conversation = new TaskAgentConversation(2)

    expect(
      conversation.decideFinal('链接：https://example.com/', 0, {
        hasFinishedToolRun: true,
        evidenceText: 'tool returned https://example.com',
      }),
    ).toEqual({ kind: 'accept', text: '链接：https://example.com/' })
    expect(
      conversation.decideFinal('查看 https://unverified.example/path', 1, {
        hasFinishedToolRun: true,
        evidenceText: '',
      }),
    ).toMatchObject({ kind: 'sanitize', text: '查看 [链接未验证]' })
  })

  it('finalizes with cleaned tags and falls back to the current draft for an empty answer', () => {
    const conversation = new TaskAgentConversation(2)
    conversation.beginTurn('native')('draft')

    expect(conversation.finalize('[表情:happy]')).toBe('draft')
    expect(conversation.snapshot()).toMatchObject({
      draftReply: 'draft',
      live2dExpression: 'happy',
    })
  })
})
