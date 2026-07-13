import type { AISettings, AppSettings, ChatMessageRecord, ContextUsageSnapshot, McpStateSnapshot } from '../electron/types'
import type { ChatMessage } from '../src/services/aiService'
import { describe, expect, it, vi } from 'vitest'
import {
  buildChatToolDirectoryAddon,
  computeChatContextUsage,
  createContextUsagePublisher,
  estimateTokensForChatMessage,
  estimateTokensFromText,
  prepareChatHistoryToMaxContext,
  trimChatHistoryToMaxContext,
} from '../src/windows/chat/useChatContext'

function createAiSettings(patch: Partial<AISettings> = {}): AISettings {
  return {
    apiMode: 'openai-compatible',
    apiKey: '',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    temperature: 0.7,
    maxTokens: 512,
    maxContextTokens: 4096,
    thinkingEffort: 'disabled',
    thinkingProvider: 'auto',
    openaiReasoningEffort: 'disabled',
    claudeThinkingEffort: 'disabled',
    geminiThinkingEffort: 'disabled',
    systemPrompt: '',
    enableVision: true,
    visionRoutingMode: 'auto',
    visionCapability: 'auto',
    visionFallbackProfileId: '',
    visionFallbackModel: '',
    visionFallbackOnTransient: true,
    visionMaxImagesPerLook: 4,
    enableChatStreaming: true,
    ...patch,
  }
}

function createSettings(ai: AISettings): AppSettings {
  return { ai, aiProfiles: [] } as unknown as AppSettings
}

function createRecord(patch: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: patch.id ?? 'message-1',
    role: patch.role ?? 'user',
    content: patch.content ?? '',
    createdAt: patch.createdAt ?? 1,
    ...patch,
  }
}

function createLongHistory(count = 12): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${index}:`.padEnd(400, String(index % 10)),
  }))
}

describe('Chat context token budgeting', () => {
  it('estimates trimmed text and multimodal image costs', () => {
    expect(estimateTokensFromText('')).toBe(0)
    expect(estimateTokensFromText('  abcdefgh  ')).toBe(2)
    expect(
      estimateTokensForChatMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'abcdefgh' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' } },
        ],
      }),
    ).toBe(802)
  })

  it('drops oldest messages while retaining the newest messages in order', () => {
    const history: ChatMessage[] = Array.from({ length: 4 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index}`.padEnd(400, 'x'),
    }))
    const result = trimChatHistoryToMaxContext(
      history,
      'a'.repeat(4000),
      createAiSettings({ maxContextTokens: 2048, systemPrompt: 's'.repeat(4000) }),
    )

    expect(result.trimmedCount).toBe(2)
    expect(result.history).toEqual(history.slice(-2))
  })

  it('builds the authoritative directory from builtin and MCP tools', () => {
    const mcpSnapshot: McpStateSnapshot = {
      enabled: true,
      updatedAt: 1,
      servers: [
        {
          id: 'demo',
          enabled: true,
          transport: 'stdio',
          command: 'node',
          args: [],
          status: 'connected',
          updatedAt: 1,
          tools: [
            {
              serverId: 'demo',
              toolName: 'mcp.demo.search',
              callName: 'search',
              name: 'search',
              description: 'Search docs',
              inputSchema: {},
            },
          ],
        },
      ],
    }

    const addon = buildChatToolDirectoryAddon({
      mcpSnapshot,
      plannerEnabled: true,
      plannerMode: 'auto',
      toolCallingEnabled: false,
      toolCallingMode: 'native',
    })

    expect(addon).toContain('【可用工具（权威，本地注册表）】')
    expect(addon).toContain('- mcp.demo.search：Search docs')
    expect(addon).toContain('任务规划器已启用（mode=auto）')
    expect(addon).toContain('工具执行已关闭')
  })

  it('estimates the next request including visible and pending images', () => {
    const usage = computeChatContextUsage({
      ai: createAiSettings({ systemPrompt: 'abcdefgh' }),
      canUseVision: true,
      input: 'wxyz',
      lastApiUsage: null,
      messages: [
        createRecord({ content: 'abcdefgh', attachments: [{ kind: 'image', path: 'first.png' }] }),
        createRecord({ id: 'message-2', role: 'assistant', content: 'abcd' }),
      ],
      now: () => 42,
      pendingAttachments: [{ kind: 'image' }],
      systemAddon: 'abcd',
    })

    expect(usage).toEqual({
      usedTokens: 2119,
      maxContextTokens: 4096,
      outputReserveTokens: 512,
      systemPromptTokens: 2,
      addonTokens: 1,
      historyTokens: 1604,
      trimmedCount: 0,
      updatedAt: 42,
    })
  })

  it('prefers provider usage over local estimates', () => {
    const usage = computeChatContextUsage({
      ai: createAiSettings(),
      canUseVision: false,
      input: 'ignored',
      lastApiUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      messages: [createRecord({ content: 'ignored' })],
      now: () => 99,
      pendingAttachments: [],
      systemAddon: 'ignored',
    })

    expect(usage).toMatchObject({
      usedTokens: 30,
      historyTokens: 20,
      maxContextTokens: 4096,
      outputReserveTokens: 512,
      isRealUsage: true,
      updatedAt: 99,
    })
  })
})

describe('Chat context compression', () => {
  it('compresses older turns with the configured model and preserves recent turns', async () => {
    const history = createLongHistory()
    const chat = vi.fn(async () => ({ content: 'Earlier facts and decisions.' }))
    const createCompactor = vi.fn(() => ({ chat }))
    const debugLog = vi.fn()
    const settings = createSettings(
      createAiSettings({
        autoContextCompressionEnabled: true,
        autoContextCompressionModel: 'summary-model',
        autoContextCompressionTargetPct: 35,
        autoContextCompressionThresholdPct: 50,
        maxContextTokens: 2048,
      }),
    )

    const result = await prepareChatHistoryToMaxContext({
      createCompactor,
      debugLog,
      history,
      reason: 'test',
      settings,
      systemAddon: '',
    })

    expect(result.compressed).toBe(true)
    expect(result.history[0].content).toContain('【自动压缩上下文摘要（系统生成）】')
    expect(result.history.slice(-4)).toEqual(history.slice(-4))
    expect(createCompactor).toHaveBeenCalledWith(
      expect.objectContaining({ enableChatStreaming: false, enableVision: false, model: 'summary-model' }),
      { kind: 'main' },
    )
    expect(chat).toHaveBeenCalledOnce()
    expect(debugLog).toHaveBeenCalledWith('chat:context.compress.done', expect.objectContaining({ compressed: true, reason: 'test' }))
  })

  it('falls back to ordinary trimming when the compactor fails', async () => {
    const history = createLongHistory()
    const notices: string[] = []
    const debugLog = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await prepareChatHistoryToMaxContext({
      createCompactor: () => ({ chat: vi.fn(async () => ({ content: '', error: 'offline' })) }),
      debugLog,
      history,
      notify: true,
      onNotice: (message) => notices.push(message),
      settings: createSettings(
        createAiSettings({
          autoContextCompressionEnabled: true,
          autoContextCompressionThresholdPct: 50,
          maxContextTokens: 2048,
        }),
      ),
      systemAddon: '',
    })

    warn.mockRestore()
    expect(result.compressed).toBe(false)
    expect(result.history).toEqual(history)
    expect(notices).toContain('提示：自动压缩上下文失败，已回退为普通截断。')
    expect(debugLog).toHaveBeenCalledWith('chat:context.compress.fail', expect.objectContaining({ error: 'offline' }))
  })
})

describe('Chat context usage publisher', () => {
  it('sends immediately, throttles bursts, and flushes only the latest snapshot', () => {
    let now = 1000
    let scheduled: (() => void) | null = null
    const delays: number[] = []
    const sent: ContextUsageSnapshot[] = []
    const publisher = createContextUsagePublisher((snapshot) => sent.push(snapshot), {
      now: () => now,
      setTimer: (callback, delayMs) => {
        scheduled = callback
        delays.push(delayMs)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {
        scheduled = null
      },
    })
    const first = { usedTokens: 1, maxContextTokens: 100 }
    const second = { usedTokens: 2, maxContextTokens: 100 }
    const latest = { usedTokens: 3, maxContextTokens: 100 }

    publisher.publish(first)
    now = 1100
    publisher.publish(second)
    now = 1200
    publisher.publish(latest)

    expect(sent).toEqual([first])
    expect(delays).toEqual([150])
    now = 1250
    const flush = scheduled as (() => void) | null
    expect(flush).not.toBeNull()
    flush?.()
    expect(sent).toEqual([first, latest])
  })
})
