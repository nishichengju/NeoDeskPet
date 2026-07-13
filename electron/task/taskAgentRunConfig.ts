import { buildOpenAICompatReasoningOptions } from '../reasoningConfig'
import type { SkillManagerRuntimeOptions } from '../skillRegistry'
import type { ToolInput } from '../toolExecutor'
import type { AppSettings } from '../types'
import { buildAgentEndpoint, buildAgentHeaders } from './taskAgentLlmProtocol'

export type TaskAgentRunMode = 'auto' | 'native' | 'text'

export function resolveTaskAgentRunConfig(input: ToolInput, settings: AppSettings) {
  const inputObject = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  const request = typeof inputObject?.request === 'string' ? inputObject.request : typeof input === 'string' ? input : ''
  if (!request.trim()) throw new Error('agent.run 需要 request 文本')

  const orchestrator = settings.orchestrator
  const configuredMaxTurns = clampInt(orchestrator?.toolAgentMaxTurns, 8, 1, 30)
  const maxTurns = clampInt(inputObject?.maxTurns, configuredMaxTurns, 1, configuredMaxTurns)
  const mode = normalizeMode(inputObject?.mode) ?? normalizeMode(orchestrator?.toolCallingMode) ?? 'text'
  const system = typeof settings.ai.systemPrompt === 'string' ? settings.ai.systemPrompt.trim() : ''
  const extraContext = typeof inputObject?.context === 'string' ? inputObject.context.trim() : ''
  const maxVisionImages = clampInt(settings.ai.visionMaxImagesPerLook, 4, 1, 8)
  const legacyVisionImagePaths = Array.isArray(inputObject?.imagePaths) ? (inputObject.imagePaths as unknown[]) : []
  const historyMessages = normalizeHistory(inputObject?.history)

  const skillAllowModelInvocation = orchestrator?.skillAllowModelInvocation !== false
  const skillRuntimeOptions: SkillManagerRuntimeOptions = {
    enabled: orchestrator?.skillEnabled !== false,
    allowModelInvocation: skillAllowModelInvocation,
    managedDir:
      typeof orchestrator?.skillManagedDir === 'string' && orchestrator.skillManagedDir.trim()
        ? orchestrator.skillManagedDir.trim()
        : undefined,
  }

  const baseAi = settings.ai
  const apiOverride =
    inputObject?.api && typeof inputObject.api === 'object' && !Array.isArray(inputObject.api)
      ? (inputObject.api as Record<string, unknown>)
      : inputObject
  const preferred = orchestrator.toolUseCustomAi
    ? {
        apiKey: String(orchestrator.toolAiApiKey ?? '').trim() || String(baseAi.apiKey ?? '').trim(),
        baseUrl: String(orchestrator.toolAiBaseUrl ?? '').trim() || String(baseAi.baseUrl ?? '').trim(),
        model: String(orchestrator.toolAiModel ?? '').trim() || String(baseAi.model ?? '').trim(),
        temperature:
          typeof orchestrator.toolAiTemperature === 'number' ? orchestrator.toolAiTemperature : baseAi.temperature ?? 0.2,
        maxTokens: typeof orchestrator.toolAiMaxTokens === 'number' ? orchestrator.toolAiMaxTokens : baseAi.maxTokens ?? 900,
        timeoutMs: typeof orchestrator.toolAiTimeoutMs === 'number' ? orchestrator.toolAiTimeoutMs : 60_000,
      }
    : {
        apiKey: String(baseAi.apiKey ?? '').trim(),
        baseUrl: String(baseAi.baseUrl ?? '').trim(),
        model: String(baseAi.model ?? '').trim(),
        temperature: typeof baseAi.temperature === 'number' ? baseAi.temperature : 0.2,
        maxTokens: typeof baseAi.maxTokens === 'number' ? baseAi.maxTokens : 900,
        timeoutMs: 60_000,
      }

  const baseUrl = readString(apiOverride, 'baseUrl') || preferred.baseUrl || ''
  const apiKey = readString(apiOverride, 'apiKey') || preferred.apiKey || ''
  const model = readString(apiOverride, 'model') || preferred.model || ''
  const apiMode: 'claude' | 'openai-compatible' =
    readString(apiOverride, 'apiMode') === 'claude' || baseAi.apiMode === 'claude' ? 'claude' : 'openai-compatible'
  const temperature = Math.max(0, Math.min(2, readNumber(apiOverride, 'temperature') ?? preferred.temperature))
  const maxTokensCandidate = readNumber(apiOverride, 'maxTokens') ?? preferred.maxTokens
  const maxTokensRaw = Number.isFinite(maxTokensCandidate) ? Math.trunc(maxTokensCandidate) : 900
  const reasoningOptions = buildOpenAICompatReasoningOptions({
    model,
    maxTokens: maxTokensRaw,
    settings: {
      thinkingEffort: readString(apiOverride, 'thinkingEffort') || baseAi.thinkingEffort,
      thinkingProvider:
        apiMode === 'claude'
          ? 'claude'
          : readString(apiOverride, 'thinkingProvider') || baseAi.thinkingProvider,
      openaiReasoningEffort: readString(apiOverride, 'openaiReasoningEffort') || baseAi.openaiReasoningEffort,
      claudeThinkingEffort: readString(apiOverride, 'claudeThinkingEffort') || baseAi.claudeThinkingEffort,
      geminiThinkingEffort: readString(apiOverride, 'geminiThinkingEffort') || baseAi.geminiThinkingEffort,
    },
    claudeDisabledMinMaxTokens: 2048,
  })
  const timeoutMs =
    typeof inputObject?.timeoutMs === 'number'
      ? clampInt(inputObject.timeoutMs, preferred.timeoutMs, 2_000, 180_000)
      : clampInt(preferred.timeoutMs, 60_000, 2_000, 180_000)
  if (!baseUrl || !model) throw new Error('未配置工具 LLM baseUrl/model（设置 → AI 设置 → 工具/Agent 或 AI 设置）')

  return {
    inputObject,
    request,
    maxTurns,
    mode: mode as TaskAgentRunMode,
    system,
    extraContext,
    maxVisionImages,
    legacyVisionImagePaths,
    historyMessages,
    skillRuntimeOptions,
    skillAllowModelInvocation,
    skillVerboseLogging: orchestrator?.skillVerboseLogging === true,
    mainVisionCapabilityKey: [baseAi.apiMode, baseAi.baseUrl, baseAi.model]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .join('|'),
    llm: {
      apiMode,
      endpoint: buildAgentEndpoint(baseUrl, apiMode),
      headers: buildAgentHeaders(apiMode, apiKey),
      model,
      temperature,
      maxTokens: reasoningOptions.maxTokens,
      reasoningExtra: reasoningOptions.extra,
      timeoutMs,
    },
  }
}

export type TaskAgentRunConfig = ReturnType<typeof resolveTaskAgentRunConfig>

function normalizeMode(value: unknown): TaskAgentRunMode | null {
  const mode = typeof value === 'string' ? value.trim() : ''
  return mode === 'auto' || mode === 'native' || mode === 'text' ? mode : null
}

function normalizeHistory(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(value)) return []
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role.trim() : ''
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if ((role === 'user' || role === 'assistant') && content) messages.push({ role, content })
  }
  return messages
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(source: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)))
}
