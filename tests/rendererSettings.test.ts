import { describe, expect, it } from 'vitest'
import { createRendererSettings } from '../electron/rendererSettings'
import { createDefaultSettings } from '../electron/store'

describe('renderer settings projection', () => {
  it('removes every managed API key while preserving configuration status', () => {
    const settings = createDefaultSettings()
    settings.ai.apiKey = 'main-key'
    settings.aiProfiles = [
      {
        id: 'profile-1',
        name: 'Profile',
        apiMode: 'openai-compatible',
        apiKey: 'profile-key',
        baseUrl: 'https://example.test/v1',
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    settings.novelai.apiKey = 'novel-key'
    settings.orchestrator.toolAiApiKey = 'tool-key'
    settings.memory.autoExtractAiApiKey = 'extract-key'
    settings.memory.vectorAiApiKey = 'vector-key'
    settings.memory.mmVectorAiApiKey = 'mm-key'
    settings.memory.kgAiApiKey = 'kg-key'

    const safe = createRendererSettings(settings)
    expect(safe.ai).toMatchObject({ apiKey: '', hasApiKey: true })
    expect(safe.aiProfiles[0]).toMatchObject({ apiKey: '', hasApiKey: true })
    expect(safe.novelai).toMatchObject({ apiKey: '', hasApiKey: true })
    expect(safe.orchestrator).toMatchObject({ toolAiApiKey: '', hasToolAiApiKey: true })
    expect(safe.memory).toMatchObject({
      autoExtractAiApiKey: '',
      hasAutoExtractAiApiKey: true,
      vectorAiApiKey: '',
      hasVectorAiApiKey: true,
      mmVectorAiApiKey: '',
      hasMmVectorAiApiKey: true,
      kgAiApiKey: '',
      hasKgAiApiKey: true,
    })
    expect(settings.ai.apiKey).toBe('main-key')
  })
})
