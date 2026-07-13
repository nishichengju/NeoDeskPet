import { describe, expect, it } from 'vitest'
import { resolveTaskAgentRunConfig } from '../electron/task/taskAgentRunConfig'
import type { AppSettings } from '../electron/types'

function settings(overrides: {
  ai?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
} = {}): AppSettings {
  return {
    ai: {
      apiMode: 'openai-compatible',
      apiKey: 'main-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'main-model',
      systemPrompt: ' Main persona ',
      temperature: 0.4,
      maxTokens: 900,
      visionMaxImagesPerLook: 4,
      ...overrides.ai,
    },
    orchestrator: {
      toolAgentMaxTurns: 8,
      toolCallingMode: 'text',
      toolUseCustomAi: false,
      toolAiApiKey: '',
      toolAiBaseUrl: '',
      toolAiModel: '',
      toolAiTemperature: 0.2,
      toolAiMaxTokens: 900,
      toolAiTimeoutMs: 60_000,
      skillEnabled: true,
      skillAllowModelInvocation: true,
      skillManagedDir: '',
      skillVerboseLogging: false,
      ...overrides.orchestrator,
    },
  } as AppSettings
}

describe('Task agent run config', () => {
  it('resolves defaults from the main AI profile', () => {
    const config = resolveTaskAgentRunConfig('  inspect the workspace  ', settings())

    expect(config).toMatchObject({
      request: '  inspect the workspace  ',
      maxTurns: 8,
      mode: 'text',
      system: 'Main persona',
      extraContext: '',
      maxVisionImages: 4,
      historyMessages: [],
      skillRuntimeOptions: { enabled: true, allowModelInvocation: true, managedDir: undefined },
      llm: {
        apiMode: 'openai-compatible',
        model: 'main-model',
        temperature: 0.4,
        maxTokens: 900,
        timeoutMs: 60_000,
      },
    })
    expect(config.llm.endpoint).toBe('https://api.example.com/v1/chat/completions')
    expect(config.llm.headers.authorization).toBe('Bearer main-key')
  })

  it('normalizes request options, history, vision inputs, and nested API overrides', () => {
    const config = resolveTaskAgentRunConfig(
      {
        request: 'run it',
        context: ' extra facts ',
        mode: 'native',
        maxTurns: '99',
        timeoutMs: 500,
        imagePaths: ['one.png', 42],
        history: [
          { role: 'user', content: ' first ' },
          { role: 'assistant', content: ' second ' },
          { role: 'system', content: 'ignored' },
          { role: 'user', content: '' },
        ],
        api: {
          baseUrl: ' https://override.example/v1 ',
          apiKey: ' override-key ',
          model: ' override-model ',
          temperature: 9,
          maxTokens: 1200,
        },
      },
      settings({
        ai: { visionMaxImagesPerLook: 99 },
        orchestrator: { toolAgentMaxTurns: 5, toolCallingMode: 'auto' },
      }),
    )

    expect(config.maxTurns).toBe(5)
    expect(config.mode).toBe('native')
    expect(config.extraContext).toBe('extra facts')
    expect(config.maxVisionImages).toBe(8)
    expect(config.legacyVisionImagePaths).toEqual(['one.png', 42])
    expect(config.historyMessages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ])
    expect(config.llm).toMatchObject({
      endpoint: 'https://override.example/v1/chat/completions',
      model: 'override-model',
      temperature: 2,
      maxTokens: 1200,
      timeoutMs: 2_000,
    })
    expect(config.llm.headers.authorization).toBe('Bearer override-key')
  })

  it('uses the dedicated tool profile and skill runtime settings when enabled', () => {
    const config = resolveTaskAgentRunConfig(
      { request: 'use a skill' },
      settings({
        orchestrator: {
          toolUseCustomAi: true,
          toolAiApiKey: 'tool-key',
          toolAiBaseUrl: 'https://tool.example/v1',
          toolAiModel: 'tool-model',
          toolAiTemperature: 0.7,
          toolAiMaxTokens: 1500,
          toolAiTimeoutMs: 240_000,
          skillEnabled: false,
          skillAllowModelInvocation: false,
          skillManagedDir: ' C:\\skills ',
          skillVerboseLogging: true,
        },
      }),
    )

    expect(config.skillRuntimeOptions).toEqual({
      enabled: false,
      allowModelInvocation: false,
      managedDir: 'C:\\skills',
    })
    expect(config.skillAllowModelInvocation).toBe(false)
    expect(config.skillVerboseLogging).toBe(true)
    expect(config.llm).toMatchObject({
      model: 'tool-model',
      temperature: 0.7,
      maxTokens: 1500,
      timeoutMs: 180_000,
    })
    expect(config.llm.headers.authorization).toBe('Bearer tool-key')
  })

  it('keeps Claude transport selection and builds a stable vision capability cache key', () => {
    const config = resolveTaskAgentRunConfig(
      { request: 'claude request', api: { apiMode: 'openai-compatible' } },
      settings({
        ai: {
          apiMode: 'claude',
          baseUrl: ' HTTPS://Claude.Example/V1 ',
          model: ' Claude-Model ',
          apiKey: 'claude-key',
        },
      }),
    )

    expect(config.llm.apiMode).toBe('claude')
    expect(config.llm.endpoint).toBe('HTTPS://Claude.Example/V1/messages')
    expect(config.llm.headers['x-api-key']).toBe('claude-key')
    expect(config.mainVisionCapabilityKey).toBe('claude|https://claude.example/v1|claude-model')
  })

  it('rejects empty requests and missing LLM endpoints', () => {
    expect(() => resolveTaskAgentRunConfig({ request: '   ' }, settings())).toThrow('agent.run 需要 request 文本')
    expect(() =>
      resolveTaskAgentRunConfig(
        { request: 'run' },
        settings({ ai: { baseUrl: '', model: '' } }),
      ),
    ).toThrow('未配置工具 LLM baseUrl/model')
  })
})
