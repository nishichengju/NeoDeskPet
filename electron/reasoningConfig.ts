import type {
  AIReasoningProvider,
  AIThinkingEffort,
  ClaudeThinkingEffort,
  GeminiThinkingEffort,
  OpenAIReasoningEffort,
} from './types'

type ReasoningSettingsLike = {
  thinkingEffort?: unknown
  thinkingProvider?: unknown
  openaiReasoningEffort?: unknown
  claudeThinkingEffort?: unknown
  geminiThinkingEffort?: unknown
}

export type OpenAICompatReasoningBuildResult = {
  provider: AIReasoningProvider
  maxTokens: number
  extra: Record<string, unknown>
}

export function normalizeThinkingEffortLegacy(value: unknown): AIThinkingEffort {
  if (value === 'disabled' || value === 'low' || value === 'medium' || value === 'high') return value
  return 'disabled'
}

export function normalizeReasoningProvider(value: unknown): AIReasoningProvider {
  if (value === 'openai' || value === 'claude' || value === 'gemini' || value === 'auto') return value
  return 'auto'
}

export function normalizeOpenAIReasoningEffort(value: unknown): OpenAIReasoningEffort {
  if (value === 'disabled' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  return 'disabled'
}

export function normalizeClaudeThinkingEffort(value: unknown): ClaudeThinkingEffort {
  if (value === 'disabled' || value === 'low' || value === 'medium' || value === 'high') return value
  return 'disabled'
}

export function normalizeGeminiThinkingEffort(value: unknown): GeminiThinkingEffort {
  if (value === 'disabled' || value === 'low' || value === 'medium' || value === 'high') return value
  return 'disabled'
}

export function inferReasoningProviderFromModel(model: string): Exclude<AIReasoningProvider, 'auto'> | null {
  const modelId = String(model ?? '').trim().toLowerCase()
  if (!modelId) return null
  if (modelId.includes('claude')) return 'claude'
  if (modelId.includes('gemini')) return 'gemini'
  if (
    /^(o1|o3|o4)(?:[-_.].*)?$/i.test(modelId) ||
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex')
  ) {
    return 'openai'
  }
  return null
}

export function toLegacyThinkingEffortFromProviderLevel(
  provider: Exclude<AIReasoningProvider, 'auto'> | null,
  level: unknown,
): AIThinkingEffort {
  if (!provider) return 'disabled'
  if (provider === 'openai') {
    const v = normalizeOpenAIReasoningEffort(level)
    if (v === 'xhigh') return 'high'
    if (v === 'minimal') return 'low'
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'disabled') return v
    return 'disabled'
  }
  if (provider === 'claude') return normalizeClaudeThinkingEffort(level)
  return normalizeGeminiThinkingEffort(level)
}

function legacyToOpenAIReasoningEffort(value: unknown): OpenAIReasoningEffort {
  const legacy = normalizeThinkingEffortLegacy(value)
  if (legacy === 'disabled') return 'disabled'
  return legacy
}

function legacyToClaudeThinkingEffort(value: unknown): ClaudeThinkingEffort {
  return normalizeClaudeThinkingEffort(value)
}

function legacyToGeminiThinkingEffort(value: unknown): GeminiThinkingEffort {
  return normalizeGeminiThinkingEffort(value)
}

function mapClaudeBudgetTokens(effort: ClaudeThinkingEffort, maxTokens: number): number {
  const cap = Math.max(1024, Math.trunc(maxTokens) - 1)
  if (effort === 'high') return Math.max(1024, Math.min(8192, cap))
  if (effort === 'medium') return Math.max(1024, Math.min(4096, cap))
  return Math.max(1024, Math.min(2048, cap))
}

export function resolveReasoningUiState(model: string, settings: ReasoningSettingsLike): {
  providerChoice: AIReasoningProvider
  providerEffective: Exclude<AIReasoningProvider, 'auto'> | null
  openaiReasoningEffort: OpenAIReasoningEffort
  claudeThinkingEffort: ClaudeThinkingEffort
  geminiThinkingEffort: GeminiThinkingEffort
  legacyThinkingEffort: AIThinkingEffort
} {
  const providerChoice = normalizeReasoningProvider(settings.thinkingProvider)
  const providerEffective = providerChoice === 'auto' ? inferReasoningProviderFromModel(model) : providerChoice
  const legacyThinkingEffort = normalizeThinkingEffortLegacy(settings.thinkingEffort)

  return {
    providerChoice,
    providerEffective,
    legacyThinkingEffort,
    openaiReasoningEffort: normalizeOpenAIReasoningEffort(
      settings.openaiReasoningEffort ?? legacyToOpenAIReasoningEffort(settings.thinkingEffort),
    ),
    claudeThinkingEffort: normalizeClaudeThinkingEffort(
      settings.claudeThinkingEffort ?? legacyToClaudeThinkingEffort(settings.thinkingEffort),
    ),
    geminiThinkingEffort: normalizeGeminiThinkingEffort(
      settings.geminiThinkingEffort ?? legacyToGeminiThinkingEffort(settings.thinkingEffort),
    ),
  }
}

export function buildOpenAICompatReasoningOptions(args: {
  model: string
  maxTokens: number
  settings: ReasoningSettingsLike
  claudeDisabledMinMaxTokens?: number
}): OpenAICompatReasoningBuildResult {
  const requestedMaxTokens = Math.max(64, Math.min(262144, Math.trunc(args.maxTokens)))
  const resolved = resolveReasoningUiState(args.model, args.settings)
  const provider = resolved.providerEffective ?? 'auto'

  if (provider === 'claude') {
    const effort = resolved.claudeThinkingEffort
    if (effort === 'disabled') {
      const minMax = Math.max(0, Math.trunc(args.claudeDisabledMinMaxTokens ?? 0))
      return {
        provider,
        maxTokens: Math.max(requestedMaxTokens, minMax),
        extra: { thinking: { type: 'disabled' } },
      }
    }
    const budgetTokens = mapClaudeBudgetTokens(effort, requestedMaxTokens)
    return {
      provider,
      maxTokens: Math.max(requestedMaxTokens, budgetTokens + 1),
      extra: { thinking: { type: 'enabled', budget_tokens: budgetTokens } },
    }
  }

  if (provider === 'openai') {
    const effort = resolved.openaiReasoningEffort
    if (effort === 'disabled') return { provider, maxTokens: requestedMaxTokens, extra: {} }
    return { provider, maxTokens: requestedMaxTokens, extra: { reasoning_effort: effort } }
  }

  if (provider === 'gemini') {
    const effort = resolved.geminiThinkingEffort
    if (effort === 'disabled') return { provider, maxTokens: requestedMaxTokens, extra: {} }
    // 这里走 OpenAI 兼容 chat/completions 链路，使用兼容字段 reasoning_effort。
    return { provider, maxTokens: requestedMaxTokens, extra: { reasoning_effort: effort } }
  }

  // 未识别提供商：保持兼容，不注入额外参数。
  return { provider: 'auto', maxTokens: requestedMaxTokens, extra: {} }
}
