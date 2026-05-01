import { useEffect, useState } from 'react'
import type {
  AIReasoningProvider,
  AppSettings,
  ClaudeThinkingEffort,
  GeminiThinkingEffort,
  OpenAIReasoningEffort,
} from '../../../electron/types'
import {
  resolveReasoningUiState,
  toLegacyThinkingEffortFromProviderLevel,
} from '../../../electron/reasoningConfig'
import { getApi } from '../../neoDeskPetApi'
import { clampIntValue } from '../../utils/settingsHelpers'

export function AISettingsTab(props: {
  api: ReturnType<typeof getApi>
  aiSettings: AppSettings['ai'] | undefined
  orchestrator: AppSettings['orchestrator'] | undefined
  aiProfiles: AppSettings['aiProfiles'] | undefined
  activeAiProfileId: string | undefined
}) {
  const { api, aiSettings, orchestrator, aiProfiles, activeAiProfileId } = props

  const apiKey = aiSettings?.apiKey ?? ''
  const baseUrl = aiSettings?.baseUrl ?? 'https://api.openai.com/v1'
  const model = aiSettings?.model ?? 'gpt-4o-mini'
  const temperature = aiSettings?.temperature ?? 0.7
  const maxTokens = aiSettings?.maxTokens ?? 64000
  const maxContextTokens = aiSettings?.maxContextTokens ?? 128000
  const autoContextCompressionEnabled = aiSettings?.autoContextCompressionEnabled ?? true
  const autoContextCompressionApiSource = aiSettings?.autoContextCompressionApiSource === 'profile' ? 'profile' : 'main'
  const autoContextCompressionProfileId = String(aiSettings?.autoContextCompressionProfileId ?? '').trim()
  const autoContextCompressionModel = String(aiSettings?.autoContextCompressionModel ?? '').trim()
  const autoContextCompressionThresholdPct = clampIntValue(aiSettings?.autoContextCompressionThresholdPct, 85, 50, 99)
  const autoContextCompressionTargetPct = clampIntValue(aiSettings?.autoContextCompressionTargetPct, 65, 35, 95)
  const autoContextCompressionTargetMaxAllowed = Math.max(35, autoContextCompressionThresholdPct - 5)
  const autoContextCompressionTargetPctEffective = Math.max(
    35,
    Math.min(autoContextCompressionTargetPct, autoContextCompressionTargetMaxAllowed),
  )
  const reasoningUi = resolveReasoningUiState(model, aiSettings ?? {})
  const thinkingProvider = reasoningUi.providerChoice
  const thinkingProviderEffective = reasoningUi.providerEffective
  const openaiReasoningEffort = reasoningUi.openaiReasoningEffort
  const claudeThinkingEffort = reasoningUi.claudeThinkingEffort
  const geminiThinkingEffort = reasoningUi.geminiThinkingEffort
  const systemPrompt = aiSettings?.systemPrompt ?? ''
  const enableVision = aiSettings?.enableVision ?? false
  const enableChatStreaming = aiSettings?.enableChatStreaming ?? false

  const profiles = Array.isArray(aiProfiles) ? aiProfiles : []
  const activeProfile = profiles.find((p) => p.id === (activeAiProfileId ?? '')) ?? null
  const compressionProfile =
    autoContextCompressionApiSource === 'profile'
      ? profiles.find((p) => p.id === autoContextCompressionProfileId) ?? null
      : null
  const compressionSourceModel = (
    autoContextCompressionApiSource === 'profile' ? compressionProfile?.model : model
  )
    ?.trim?.() || model
  const compressionEffectiveModelPreview = autoContextCompressionModel || compressionSourceModel || ''
  const [profileName, setProfileName] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [compressionModelOptions, setCompressionModelOptions] = useState<string[]>([])
  const [compressionModelsLoading, setCompressionModelsLoading] = useState(false)
  const [compressionModelsError, setCompressionModelsError] = useState('')

  useEffect(() => {
    setProfileName(activeProfile?.name ?? '')
  }, [activeProfile?.id, activeProfile?.name])

  const saveApiProfile = async (opts?: { overwrite?: boolean }) => {
    if (!api) return
    const overwrite = opts?.overwrite ?? false
    const id = overwrite ? activeProfile?.id : undefined
    const fallbackName = `${baseUrl || '接口'} ${model || ''}`.trim() || '新配置'
    const name = profileName.trim() || fallbackName
    await api.saveAIProfile({ id, name, apiKey, baseUrl, model })
  }

  const deleteApiProfile = async () => {
    if (!api || !activeProfile?.id) return
    await api.deleteAIProfile(activeProfile.id)
  }

  const applyApiProfile = async (id: string) => {
    if (!api || !id) return
    await api.applyAIProfile(id)
  }

  const fetchModelList = async () => {
    if (!api) return
    setModelsLoading(true)
    setModelsError('')
    try {
      const res = await api.listAIModels({ apiKey, baseUrl })
      if (!res.ok) {
        setModelOptions([])
        setModelsError(res.error || '拉取模型列表失败')
        return
      }
      const incoming = Array.isArray(res.models) ? res.models : []
      const merged = Array.from(
        new Set([model, autoContextCompressionModel, ...incoming].map((x) => String(x ?? '').trim()).filter(Boolean)),
      )
      setModelOptions(merged)
      setModelsError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setModelOptions([])
      setModelsError(msg || '拉取模型列表失败')
    } finally {
      setModelsLoading(false)
    }
  }

  const fetchCompressionModelList = async () => {
    if (!api) return
    const sourceProfile = compressionProfile
    const requestApiKey = autoContextCompressionApiSource === 'profile' ? sourceProfile?.apiKey ?? '' : apiKey
    const requestBaseUrl = autoContextCompressionApiSource === 'profile' ? sourceProfile?.baseUrl ?? '' : baseUrl
    const fallbackModel = autoContextCompressionApiSource === 'profile' ? sourceProfile?.model ?? '' : model

    if (!requestBaseUrl.trim()) {
      setCompressionModelOptions([])
      setCompressionModelsError('压缩 API Base URL 为空，无法拉取模型列表')
      return
    }

    setCompressionModelsLoading(true)
    setCompressionModelsError('')
    try {
      const res = await api.listAIModels({ apiKey: requestApiKey, baseUrl: requestBaseUrl })
      if (!res.ok) {
        setCompressionModelOptions([])
        setCompressionModelsError(res.error || '拉取压缩模型列表失败')
        return
      }
      const incoming = Array.isArray(res.models) ? res.models : []
      const merged = Array.from(
        new Set([autoContextCompressionModel, fallbackModel, model, ...incoming].map((x) => String(x ?? '').trim()).filter(Boolean)),
      )
      setCompressionModelOptions(merged)
      setCompressionModelsError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setCompressionModelOptions([])
      setCompressionModelsError(msg || '拉取压缩模型列表失败')
    } finally {
      setCompressionModelsLoading(false)
    }
  }

  const toolMode = orchestrator?.toolCallingMode ?? 'auto'
  const toolUseCustomAi = orchestrator?.toolUseCustomAi ?? false
  const toolAiApiKey = orchestrator?.toolAiApiKey ?? ''
  const toolAiBaseUrl = orchestrator?.toolAiBaseUrl ?? ''
  const toolAiModel = orchestrator?.toolAiModel ?? ''
  const toolAiTemperature = orchestrator?.toolAiTemperature ?? 0.2
  const toolAiMaxTokens = orchestrator?.toolAiMaxTokens ?? 900
  const toolAiTimeoutMs = orchestrator?.toolAiTimeoutMs ?? 60000
  const toolAgentMaxTurns = orchestrator?.toolAgentMaxTurns ?? 8
  const skillEnabled = orchestrator?.skillEnabled ?? true
  const skillAllowModelInvocation = orchestrator?.skillAllowModelInvocation ?? true
  const skillManagedDir = orchestrator?.skillManagedDir ?? ''
  const skillVerboseLogging = orchestrator?.skillVerboseLogging ?? false

  const selectedReasoningProvider: Exclude<AIReasoningProvider, 'auto'> =
    thinkingProvider === 'auto' ? (thinkingProviderEffective ?? 'openai') : thinkingProvider
  const providerDisplayName =
    selectedReasoningProvider === 'openai' ? 'OpenAI' : selectedReasoningProvider === 'claude' ? 'Claude' : 'Gemini'
  const inferredProviderText =
    thinkingProvider === 'auto'
      ? thinkingProviderEffective == null
        ? '自动模式：当前模型名未识别，默认按 OpenAI 兼容参数处理。'
        : `自动模式：当前按 ${providerDisplayName} 规则映射。`
      : `手动模式：固定按 ${providerDisplayName} 规则映射。`

  const applyProviderThinkingLevel = (
    provider: Exclude<AIReasoningProvider, 'auto'>,
    level: OpenAIReasoningEffort | ClaudeThinkingEffort | GeminiThinkingEffort,
  ) => {
    if (!api) return
    const legacy = toLegacyThinkingEffortFromProviderLevel(provider, level)
    if (provider === 'openai') {
      void api.setAISettings({ openaiReasoningEffort: level as OpenAIReasoningEffort, thinkingEffort: legacy })
      return
    }
    if (provider === 'claude') {
      void api.setAISettings({ claudeThinkingEffort: level as ClaudeThinkingEffort, thinkingEffort: legacy })
      return
    }
    void api.setAISettings({ geminiThinkingEffort: level as GeminiThinkingEffort, thinkingEffort: legacy })
  }

  // Format large numbers for display
  const formatTokens = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}K`
    return String(n)
  }

  return (
    <div className="ndp-settings-section">
      <h3>API 设置</h3>

      <div className="ndp-setting-item">
        <label>已保存的 API 配置</label>
        <div className="ndp-row">
          <select className="ndp-select" value={activeAiProfileId ?? ''} onChange={(e) => void applyApiProfile(e.target.value)}>
            <option value="">（无）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ndp-setting-actions">
          <input
            type="text"
            className="ndp-input"
            value={profileName}
            placeholder="配置名称"
            onChange={(e) => setProfileName(e.target.value)}
          />
          <button className="ndp-btn" onClick={() => void saveApiProfile()}>
            保存新配置
          </button>
          <button className="ndp-btn" disabled={!activeProfile?.id} onClick={() => void saveApiProfile({ overwrite: true })}>
            覆盖当前配置
          </button>
          <button className="ndp-btn ndp-btn-danger" disabled={!activeProfile?.id} onClick={() => void deleteApiProfile()}>
            删除配置
          </button>
        </div>
        <p className="ndp-setting-hint">可在多个 API 之间快速切换，不需要重复输入 Key / Base URL / 模型。</p>
      </div>

      {/* API Key */}
      <div className="ndp-setting-item">
        <label>API Key</label>
        <input
          type="password"
          className="ndp-input"
          value={apiKey}
          placeholder="sk-..."
          onChange={(e) => api?.setAISettings({ apiKey: e.target.value })}
        />
        <p className="ndp-setting-hint">支持 OpenAI 兼容的 API</p>
      </div>

      {/* Base URL */}
      <div className="ndp-setting-item">
        <label>API Base URL</label>
        <input
          type="text"
          className="ndp-input"
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => api?.setAISettings({ baseUrl: e.target.value })}
        />
        <p className="ndp-setting-hint">可配置代理或其他兼容 API 地址</p>
      </div>

      {/* Model */}
      <div className="ndp-setting-item">
        <label>模型名称</label>
        <input
          type="text"
          className="ndp-input"
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(e) => api?.setAISettings({ model: e.target.value })}
        />
        <div className="ndp-setting-actions">
          <button className="ndp-btn" onClick={() => void fetchModelList()} disabled={modelsLoading}>
            {modelsLoading ? '加载中...' : '拉取模型列表'}
          </button>
          {modelOptions.length > 0 ? (
            <select className="ndp-select" value={model} onChange={(e) => api?.setAISettings({ model: e.target.value })}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {modelsError ? <p className="ndp-setting-hint">{modelsError}</p> : null}
        <p className="ndp-setting-hint">可手动输入模型 ID，也可以先拉取后选择。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableVision}
            onChange={(e) => api?.setAISettings({ enableVision: e.target.checked })}
          />
          <span>启用识图能力（发送图片）</span>
        </label>
        <p className="ndp-setting-hint">部分模型不支持图片输入，关闭后聊天窗口将禁用“图片”按钮</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableChatStreaming}
            onChange={(e) => api?.setAISettings({ enableChatStreaming: e.target.checked })}
          />
          <span>聊天流式生成（逐步输出）</span>
        </label>
        <p className="ndp-setting-hint">开启后会以 SSE 方式逐步生成文本；若同时开启 TTS 分句同步，会按句子分段出现</p>
      </div>

      <h3>生成设置</h3>

      <div className="ndp-setting-item">
        <label>思考提供商</label>
        <select
          className="ndp-select"
          value={thinkingProvider}
          onChange={(e) => api?.setAISettings({ thinkingProvider: e.target.value as AIReasoningProvider })}
        >
          <option value="auto">自动（按模型名推断）</option>
          <option value="openai">OpenAI（含 GPT-5 / Codex 系列）</option>
          <option value="claude">Claude（4.6 系列等）</option>
          <option value="gemini">Gemini（3.1 Pro 等）</option>
        </select>
        <p className="ndp-setting-hint">{inferredProviderText}</p>
      </div>

      <div className="ndp-setting-item">
        <label>思考强度（{providerDisplayName}）</label>
        {selectedReasoningProvider === 'openai' ? (
          <>
            <select
              className="ndp-select"
              value={openaiReasoningEffort}
              onChange={(e) => applyProviderThinkingLevel('openai', e.target.value as OpenAIReasoningEffort)}
            >
              <option value="disabled">禁用（本地不下发）</option>
              <option value="minimal">极低（minimal）</option>
              <option value="low">低（low）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high）</option>
              <option value="xhigh">超高（xhigh）</option>
            </select>
            <p className="ndp-setting-hint">
              通过 OpenAI 兼容参数 `reasoning_effort` 下发；`minimal/xhigh` 主要用于 GPT-5 / Codex 推理模型（网关需支持）。
            </p>
          </>
        ) : null}
        {selectedReasoningProvider === 'claude' ? (
          <>
            <select
              className="ndp-select"
              value={claudeThinkingEffort}
              onChange={(e) => applyProviderThinkingLevel('claude', e.target.value as ClaudeThinkingEffort)}
            >
              <option value="disabled">禁用（disabled）</option>
              <option value="low">低（low）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high）</option>
            </select>
            <p className="ndp-setting-hint">
              当前程序走 OpenAI 兼容 `chat/completions`，会映射为 Claude 的 `thinking.budget_tokens`（兼容网关更稳）。
            </p>
          </>
        ) : null}
        {selectedReasoningProvider === 'gemini' ? (
          <>
            <select
              className="ndp-select"
              value={geminiThinkingEffort}
              onChange={(e) => applyProviderThinkingLevel('gemini', e.target.value as GeminiThinkingEffort)}
            >
              <option value="disabled">禁用（本地不下发）</option>
              <option value="low">低（low）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high）</option>
            </select>
            <p className="ndp-setting-hint">
              当前程序走 OpenAI 兼容 `chat/completions`，Gemini 将映射为兼容字段 `reasoning_effort`；Gemini 3.1 Pro 建议使用低/中/高。
            </p>
          </>
        ) : null}
        <p className="ndp-setting-hint">兼容旧配置：会自动同步一个旧版统一强度字段，避免历史逻辑失效。</p>
      </div>

      {/* Temperature */}
      <div className="ndp-setting-item">
        <label>温度 (Temperature)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => api?.setAISettings({ temperature: parseFloat(e.target.value) })}
          />
          <span>{temperature.toFixed(1)}</span>
        </div>
        <p className="ndp-setting-hint">较低值更确定，较高值更有创意</p>
      </div>

      {/* Max Tokens */}
      <div className="ndp-setting-item">
        <label>最大回复长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="1000"
            max="128000"
            step="1000"
            value={maxTokens}
            onChange={(e) => api?.setAISettings({ maxTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxTokens)}</span>
        </div>
        <p className="ndp-setting-hint">AI 单次回复的最大 token 数量</p>
      </div>

      {/* Max Context Tokens */}
      <div className="ndp-setting-item">
        <label>最大上下文长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="4000"
            max="1000000"
            step="4000"
            value={maxContextTokens}
            onChange={(e) => api?.setAISettings({ maxContextTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxContextTokens)}</span>
        </div>
        <p className="ndp-setting-hint">对话历史的最大 token 数量</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoContextCompressionEnabled}
            onChange={(e) => api?.setAISettings({ autoContextCompressionEnabled: e.target.checked })}
          />
          <span>自动压缩上下文（超过阈值先摘要旧对话）</span>
        </label>
        <p className="ndp-setting-hint">
          类似 Claude Code / Codex 的上下文压缩思路：触发后先把较早对话压缩成摘要，再保留最近几轮原文，减少“直接截断导致失忆”。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>压缩模型（可选，留空跟随所选压缩配置模型）</label>
        <div className="ndp-setting-actions">
          <select
            className="ndp-select"
            value={autoContextCompressionApiSource}
            disabled={!autoContextCompressionEnabled}
            onChange={(e) =>
              api?.setAISettings({
                autoContextCompressionApiSource: e.target.value === 'profile' ? 'profile' : 'main',
              })
            }
          >
            <option value="main">跟随主 API 配置</option>
            <option value="profile">使用已保存 API 配置</option>
          </select>
          {autoContextCompressionApiSource === 'profile' ? (
            <select
              className="ndp-select"
              value={autoContextCompressionProfileId}
              disabled={!autoContextCompressionEnabled || profiles.length === 0}
              onChange={(e) => api?.setAISettings({ autoContextCompressionProfileId: e.target.value })}
            >
              <option value="">请选择已保存配置</option>
              {profiles.map((p) => (
                <option key={`compress-profile-${p.id}`} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <input
          type="text"
          className="ndp-input"
          value={autoContextCompressionModel}
          disabled={!autoContextCompressionEnabled}
          placeholder={compressionSourceModel || '留空=跟随所选压缩配置模型'}
          onChange={(e) => api?.setAISettings({ autoContextCompressionModel: e.target.value })}
        />
        <div className="ndp-setting-actions">
          <button className="ndp-btn" onClick={() => void fetchCompressionModelList()} disabled={compressionModelsLoading || !autoContextCompressionEnabled}>
            {compressionModelsLoading ? '加载中...' : '拉取压缩模型列表'}
          </button>
          {compressionModelOptions.length > 0 ? (
            <select
              className="ndp-select"
              value={autoContextCompressionModel}
              disabled={!autoContextCompressionEnabled}
              onChange={(e) => api?.setAISettings({ autoContextCompressionModel: e.target.value })}
            >
              <option value="">
                跟随所选压缩配置模型（{compressionSourceModel || '未设置'}）
              </option>
              {compressionModelOptions.map((m) => (
                <option key={`compress-${m}`} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {compressionModelsError ? <p className="ndp-setting-hint">{compressionModelsError}</p> : null}
        {autoContextCompressionApiSource === 'profile' && !compressionProfile ? (
          <p className="ndp-setting-hint">请选择一个已保存 API 配置，压缩才会使用该配置的 Key/Base URL/默认模型。</p>
        ) : null}
        <p className="ndp-setting-hint">当前生效压缩模型：{compressionEffectiveModelPreview || '未设置'}</p>
        <p className="ndp-setting-hint">
          压缩时可选择“跟随主 API”或“使用已保存 API 配置”；这里的“压缩模型”仅覆盖模型名，Key/Base URL 来自所选压缩配置。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>上下文压缩触发阈值（占最大上下文百分比）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="50"
            max="99"
            step="1"
            value={autoContextCompressionThresholdPct}
            disabled={!autoContextCompressionEnabled}
            onChange={(e) => api?.setAISettings({ autoContextCompressionThresholdPct: parseInt(e.target.value) })}
          />
          <span>{autoContextCompressionThresholdPct}%</span>
        </div>
        <p className="ndp-setting-hint">估算上下文使用量超过该阈值时，会先尝试自动压缩旧对话，再继续发送。</p>
      </div>

      <div className="ndp-setting-item">
        <label>上下文压缩目标占比（压缩后尽量降到）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="35"
            max="95"
            step="1"
            value={autoContextCompressionTargetPct}
            disabled={!autoContextCompressionEnabled}
            onChange={(e) => api?.setAISettings({ autoContextCompressionTargetPct: parseInt(e.target.value) })}
          />
          <span>{autoContextCompressionTargetPct}%</span>
        </div>
        {autoContextCompressionTargetPctEffective !== autoContextCompressionTargetPct ? (
          <p className="ndp-setting-hint">
            当前生效目标会按阈值修正为 {autoContextCompressionTargetPctEffective}%（需至少比触发阈值低 5%）。
          </p>
        ) : null}
        <p className="ndp-setting-hint">这是压缩器的“尽量目标”，并非严格保证；如果历史太长仍可能再做一次普通截断。</p>
      </div>

      <h3>工具(Agent) 设置</h3>

      <div className="ndp-setting-item">
        <label>工具执行模式</label>
        <select
          className="ndp-select"
          value={toolMode}
          onChange={(e) => api?.setOrchestratorSettings({ toolCallingMode: e.target.value as 'auto' | 'native' | 'text' })}
        >
          <option value="auto">auto（优先原生工具调用，失败自动降级兼容模式）</option>
          <option value="native">native（仅使用原生工具调用）</option>
          <option value="text">text（兼容模式：文本工具调用）</option>
        </select>
        <p className="ndp-setting-hint">
          部分模型或代理的原生工具调用兼容性不稳定时，可改用 text 兼容模式绕开。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>Agent 最大回合数 (maxTurns)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            value={toolAgentMaxTurns}
            onChange={(e) => api?.setOrchestratorSettings({ toolAgentMaxTurns: parseInt(e.target.value) })}
          />
          <span>{toolAgentMaxTurns}</span>
        </div>
        <p className="ndp-setting-hint">命中“已达到最大回合”时可调大；建议 6~12，过大会更慢且更耗工具调用。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={skillEnabled}
            onChange={(e) => api?.setOrchestratorSettings({ skillEnabled: e.target.checked })}
          />
          <span>启用 Skill（技能提示与 /skill 命令）</span>
        </label>
        <p className="ndp-setting-hint">关闭后将禁用 Skills 提示注入与显式 `/skill` 指令匹配，便于排查 Agent 行为。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={skillAllowModelInvocation}
            disabled={!skillEnabled}
            onChange={(e) => api?.setOrchestratorSettings({ skillAllowModelInvocation: e.target.checked })}
          />
          <span>允许模型自动选用 Skill（注入 available_skills）</span>
        </label>
        <p className="ndp-setting-hint">
          关闭后仅保留手动 `/skill xxx ...` 触发；模型不会自动看到技能列表。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>托管 Skill 目录（可选）</label>
        <input
          type="text"
          className="ndp-input"
          value={skillManagedDir}
          placeholder="%USERPROFILE%\\.neodeskpet\\skills（留空使用默认）"
          onChange={(e) => api?.setOrchestratorSettings({ skillManagedDir: e.target.value })}
        />
        <p className="ndp-setting-hint">
          工作区 Skills 固定读取当前项目 <code>skills/</code>；这里用于配置全局托管目录（留空走默认路径）。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={skillVerboseLogging}
            onChange={(e) => api?.setOrchestratorSettings({ skillVerboseLogging: e.target.checked })}
          />
          <span>记录 Skill 调试日志（任务日志里可见）</span>
        </label>
        <p className="ndp-setting-hint">会记录 Skill 加载统计、冲突处理与命中详情，便于定位“为什么选了某个 skill”。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={toolUseCustomAi}
            onChange={(e) => api?.setOrchestratorSettings({ toolUseCustomAi: e.target.checked })}
          />
          <span>工具/Agent 使用单独的 API</span>
        </label>
        <p className="ndp-setting-hint">开启后，工具任务会优先使用下面的 API 配置；否则沿用上面的“API 设置”。</p>
      </div>

      {toolUseCustomAi && (
        <>
          <div className="ndp-setting-item">
            <label>工具 API Key</label>
            <input
              type="password"
              className="ndp-input"
              value={toolAiApiKey}
              placeholder="(可留空，沿用主 API Key)"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiApiKey: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>工具 API Base URL</label>
            <input
              type="text"
              className="ndp-input"
              value={toolAiBaseUrl}
              placeholder="例如 https://generativelanguage.googleapis.com/v1beta/openai/"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiBaseUrl: e.target.value })}
            />
            <p className="ndp-setting-hint">
              Gemini 官方 OpenAI 兼容基址：<code>https://generativelanguage.googleapis.com/v1beta/openai/</code>
            </p>
          </div>

          <div className="ndp-setting-item">
            <label>工具模型名称</label>
            <input
              type="text"
              className="ndp-input"
              value={toolAiModel}
              placeholder="例如 gemini-2.5-flash / gpt-4o-mini"
              onChange={(e) => api?.setOrchestratorSettings({ toolAiModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>工具温度 (Temperature)</label>
            <div className="ndp-range-input">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={toolAiTemperature}
                onChange={(e) => api?.setOrchestratorSettings({ toolAiTemperature: parseFloat(e.target.value) })}
              />
              <span>{toolAiTemperature.toFixed(1)}</span>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>工具最大输出 (maxTokens)</label>
            <div className="ndp-range-input">
              <input
                type="range"
                min="128"
                max="8192"
                step="64"
                value={toolAiMaxTokens}
                onChange={(e) => api?.setOrchestratorSettings({ toolAiMaxTokens: parseInt(e.target.value) })}
              />
              <span>{toolAiMaxTokens}</span>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>工具超时 (ms)</label>
            <input
              type="number"
              className="ndp-input"
              value={toolAiTimeoutMs}
              min={2000}
              max={180000}
              step={500}
              onChange={(e) => api?.setOrchestratorSettings({ toolAiTimeoutMs: parseInt(e.target.value) })}
            />
          </div>
        </>
      )}

      {/* System Prompt */}
      <div className="ndp-setting-item">
        <label>系统提示词</label>
        <textarea
          className="ndp-textarea"
          value={systemPrompt}
          placeholder="在这里填写桌宠的人设（system prompt）"
          rows={4}
          onChange={(e) => api?.setAISettings({ systemPrompt: e.target.value })}
        />
        <p className="ndp-setting-hint">定义 AI 的角色和行为</p>
      </div>
    </div>
  )
}
