import type { AppSettings } from './types'

export function createRendererSettings(settings: AppSettings): AppSettings {
  const safe = structuredClone(settings)

  safe.ai.hasApiKey = Boolean(settings.ai.apiKey?.trim())
  safe.ai.apiKey = ''
  safe.aiProfiles = settings.aiProfiles.map((profile) => ({
    ...profile,
    apiKey: '',
    hasApiKey: Boolean(profile.apiKey?.trim()),
  }))

  safe.novelai.hasApiKey = Boolean(settings.novelai.apiKey?.trim())
  safe.novelai.apiKey = ''

  safe.orchestrator.hasToolAiApiKey = Boolean(settings.orchestrator.toolAiApiKey?.trim())
  safe.orchestrator.toolAiApiKey = ''

  safe.memory.hasAutoExtractAiApiKey = Boolean(settings.memory.autoExtractAiApiKey?.trim())
  safe.memory.autoExtractAiApiKey = ''
  safe.memory.hasVectorAiApiKey = Boolean(settings.memory.vectorAiApiKey?.trim())
  safe.memory.vectorAiApiKey = ''
  safe.memory.hasMmVectorAiApiKey = Boolean(settings.memory.mmVectorAiApiKey?.trim())
  safe.memory.mmVectorAiApiKey = ''
  safe.memory.hasKgAiApiKey = Boolean(settings.memory.kgAiApiKey?.trim())
  safe.memory.kgAiApiKey = ''

  return safe
}
