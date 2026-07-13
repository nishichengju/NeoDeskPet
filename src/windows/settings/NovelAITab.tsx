import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, NovelAIPromptPreset } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'
import { SecretSettingInput } from './SecretSettingInput'

const MODEL_OPTIONS = ['nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3']
const SAMPLER_OPTIONS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3']
const NOISE_SCHEDULE_OPTIONS = ['karras', 'native', 'exponential', 'polyexponential']

const DEFAULT_ENDPOINT = 'https://image.novelai.net/ai/generate-image'
const DEFAULT_QUEUE_URL = 'https://st-chatu-novelai-queue.hf.space'
const EMPTY_PROMPT_PRESETS: NovelAIPromptPreset[] = []
const DEFAULT_RULES = [
  '把用户的画图需求整理成 NovelAI 可用的英文 tag，用逗号分隔；不要输出解释、Markdown 或 image### 包装。',
  '顺序：质量词 -> 人数/主体 -> 桌宠角色固定外观 -> 表情/动作 -> 服装 -> 场景/时间/光线 -> 构图/镜头 -> 风格。',
  '桌宠角色外观要稳定复用；只有用户明确要求变化时才改发色、耳朵、尾巴、体型、服装等核心特征。',
  '动作和视角要具体，避免只写 vague/cute；需要位置关系时写清 foreground/background、looking at viewer、standing/sitting 等。',
  '正面提示词尽量控制在 512 占用内；重要 tag 可用 {tag} 或 {{{tag}}} 加权，但不要堆太多重复权重。',
  '负面提示词只放质量问题、解剖错误、水印文字、额外肢体、错误角色数量等排除项；不要把想要的内容写进负面。',
  '如果用户没有指定画风，默认使用 anime style, clean lineart, soft lighting, detailed eyes。',
].join('\n')

function optionList(options: string[], current: string): string[] {
  const value = current.trim()
  return value && !options.includes(value) ? [value, ...options] : options
}

function numberValue(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function intValue(value: string, fallback: number): number {
  return Math.trunc(numberValue(value, fallback))
}

function promptLength(value: string): number {
  const text = value.trim()
  if (!text) return 0
  let asciiChars = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) asciiChars += 1
  }
  const nonAsciiChars = text.length - asciiChars
  return Math.ceil(asciiChars / 3.31 + nonAsciiChars)
}

function uniquePresetName(presets: NovelAIPromptPreset[], baseName: string): string {
  const base = baseName.trim() || '新预设'
  const used = new Set(presets.map((preset) => preset.name))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

function createPresetId(): string {
  return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function makePresetFromCurrent(args: {
  id?: string
  name: string
  fixedPositivePrompt: string
  fixedNegativePrompt: string
  promptRules: string
  maxPromptChars: number
  existing?: NovelAIPromptPreset
}): NovelAIPromptPreset {
  const now = Date.now()
  return {
    id: args.id ?? createPresetId(),
    name: args.name.trim() || '未命名预设',
    fixedPositivePrompt: args.fixedPositivePrompt,
    fixedNegativePrompt: args.fixedNegativePrompt,
    promptRules: args.promptRules,
    maxPromptChars: args.maxPromptChars,
    createdAt: args.existing?.createdAt ?? now,
    updatedAt: now,
  }
}

function usageText(current: string, extra: string, max: number): string {
  const currentCount = promptLength(current)
  const total = promptLength([current.trim(), extra.trim()].filter(Boolean).join(', '))
  return `当前占用: ${currentCount} | 总占用: ${total} / ${max}`
}

export function NovelAISettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings['novelai'] | undefined }) {
  const { api, settings } = props
  const enabled = settings?.enabled ?? false
  const hasApiKey = settings?.hasApiKey ?? false
  const endpoint = settings?.endpoint ?? DEFAULT_ENDPOINT
  const cloudQueueEnabled = settings?.cloudQueueEnabled ?? false
  const cloudQueueUrl = settings?.cloudQueueUrl ?? DEFAULT_QUEUE_URL
  const cloudQueueUserId = settings?.cloudQueueUserId ?? ''
  const cloudQueueGreeting = settings?.cloudQueueGreeting ?? ''
  const cloudQueuePollIntervalMs = settings?.cloudQueuePollIntervalMs ?? 1500
  const cloudQueueTimeoutMs = settings?.cloudQueueTimeoutMs ?? 300000
  const model = settings?.model ?? 'nai-diffusion-4-5-curated'
  const sampler = settings?.sampler ?? 'k_euler_ancestral'
  const noiseSchedule = settings?.noiseSchedule ?? 'karras'
  const fixedPositivePrompt = settings?.fixedPositivePrompt ?? ''
  const fixedNegativePrompt = settings?.fixedNegativePrompt ?? ''
  const promptRules = settings?.promptRules ?? DEFAULT_RULES
  const maxPromptChars = settings?.maxPromptChars ?? 512
  const width = settings?.width ?? 1024
  const height = settings?.height ?? 1024
  const steps = settings?.steps ?? 28
  const scale = settings?.scale ?? 5
  const cfgRescale = settings?.cfgRescale ?? 0
  const nSamples = settings?.nSamples ?? 1
  const seed = settings?.seed ?? -1
  const outputDir = settings?.outputDir ?? 'generated-images'
  const promptPresets = settings?.promptPresets?.length ? settings.promptPresets : EMPTY_PROMPT_PRESETS
  const activePromptPresetId = settings?.activePromptPresetId || promptPresets[0]?.id || ''
  const activePreset = useMemo(
    () => promptPresets.find((preset) => preset.id === activePromptPresetId) ?? promptPresets[0],
    [activePromptPresetId, promptPresets],
  )
  const [presetNameDraft, setPresetNameDraft] = useState(activePreset?.name ?? '默认桌宠')

  useEffect(() => {
    setPresetNameDraft(activePreset?.name ?? '默认桌宠')
  }, [activePreset?.id, activePreset?.name])

  const patch = (next: Partial<AppSettings['novelai']>) => api?.setNovelAISettings(next)
  const positiveUsage = usageText(fixedPositivePrompt, '', maxPromptChars)
  const fixedNegativeUsage = usageText(fixedNegativePrompt, '', maxPromptChars)

  const applyPreset = (presetId: string) => {
    const preset = promptPresets.find((item) => item.id === presetId)
    if (!preset) return
    patch({
      activePromptPresetId: preset.id,
      fixedPositivePrompt: preset.fixedPositivePrompt,
      fixedNegativePrompt: preset.fixedNegativePrompt,
      promptRules: preset.promptRules,
      maxPromptChars: preset.maxPromptChars,
    })
  }

  const savePreset = () => {
    const current = activePreset
    if (!current) return
    const nextPreset = makePresetFromCurrent({
      id: current.id,
      name: presetNameDraft,
      fixedPositivePrompt,
      fixedNegativePrompt,
      promptRules,
      maxPromptChars,
      existing: current,
    })
    patch({
      activePromptPresetId: nextPreset.id,
      promptPresets: promptPresets.map((preset) => (preset.id === current.id ? nextPreset : preset)),
    })
  }

  const saveAsPreset = () => {
    const name = uniquePresetName(promptPresets, `${presetNameDraft || activePreset?.name || '新预设'} 副本`)
    const nextPreset = makePresetFromCurrent({
      name,
      fixedPositivePrompt,
      fixedNegativePrompt,
      promptRules,
      maxPromptChars,
    })
    patch({
      activePromptPresetId: nextPreset.id,
      promptPresets: [...promptPresets, nextPreset],
    })
    setPresetNameDraft(name)
  }

  const renamePreset = () => {
    if (!activePreset) return
    const name = presetNameDraft.trim()
    if (!name || name === activePreset.name) return
    patch({
      promptPresets: promptPresets.map((preset) =>
        preset.id === activePreset.id ? { ...preset, name, updatedAt: Date.now() } : preset,
      ),
    })
  }

  const deletePreset = () => {
    if (!activePreset || promptPresets.length <= 1) return
    const nextPresets = promptPresets.filter((preset) => preset.id !== activePreset.id)
    const nextActive = nextPresets[0]
    patch({
      activePromptPresetId: nextActive.id,
      promptPresets: nextPresets,
      fixedPositivePrompt: nextActive.fixedPositivePrompt,
      fixedNegativePrompt: nextActive.fixedNegativePrompt,
      promptRules: nextActive.promptRules,
      maxPromptChars: nextActive.maxPromptChars,
    })
  }

  return (
    <div className="ndp-settings-section">
      <h3>NovelAI 生图</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>启用 image.generate 工具</span>
        </label>
        <p className="ndp-setting-hint">生成请求会消耗 NovelAI 配额/Anlas；工具只应由用户明确的生图请求触发。</p>
      </div>

      <div className="ndp-setting-item">
        <label>API Key</label>
        <SecretSettingInput
          api={api}
          target="novelai"
          hasValue={hasApiKey}
          ariaLabel="NovelAI API Key"
          placeholder="NovelAI persistent API token"
        />
      </div>

      <div className="ndp-setting-item">
        <label>Endpoint</label>
        <input className="ndp-input" value={endpoint} onChange={(e) => patch({ endpoint: e.target.value })} />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={cloudQueueEnabled} onChange={(e) => patch({ cloudQueueEnabled: e.target.checked })} />
          <span>启用云端队列</span>
        </label>
        <p className="ndp-setting-hint">只发送 key_hash、user_id、task_id 和个性语；不发送 API Key、Prompt 或图片参数。</p>
      </div>

      {cloudQueueEnabled && (
        <>
          <div className="ndp-setting-item">
            <label>队列服务地址</label>
            <input className="ndp-input" value={cloudQueueUrl} onChange={(e) => patch({ cloudQueueUrl: e.target.value })} />
          </div>
          <div className="ndp-setting-item">
            <label>队列用户 ID</label>
            <input className="ndp-input" value={cloudQueueUserId} placeholder="留空自动生成" onChange={(e) => patch({ cloudQueueUserId: e.target.value })} />
          </div>
          <div className="ndp-setting-item">
            <label>队列个性语</label>
            <input className="ndp-input" value={cloudQueueGreeting} maxLength={15} placeholder="最多 15 字" onChange={(e) => patch({ cloudQueueGreeting: e.target.value })} />
          </div>
          <div className="ndp-setting-item">
            <label>队列轮询/等待</label>
            <div className="ndp-row">
              <input className="ndp-input" type="number" min={500} max={10000} step={100} value={cloudQueuePollIntervalMs} onChange={(e) => patch({ cloudQueuePollIntervalMs: intValue(e.target.value, cloudQueuePollIntervalMs) })} />
              <input className="ndp-input" type="number" min={15000} max={1800000} step={1000} value={cloudQueueTimeoutMs} onChange={(e) => patch({ cloudQueueTimeoutMs: intValue(e.target.value, cloudQueueTimeoutMs) })} />
            </div>
            <p className="ndp-setting-hint">左侧是轮询间隔 ms，右侧是最长排队等待 ms。</p>
          </div>
        </>
      )}

      <div className="ndp-setting-item">
        <label>提示词预设</label>
        <div className="ndp-row">
          <select className="ndp-select" value={activePromptPresetId} onChange={(e) => applyPreset(e.target.value)}>
            {promptPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <input className="ndp-input" value={presetNameDraft} onChange={(e) => setPresetNameDraft(e.target.value)} />
        </div>
        <div className="ndp-row">
          <button className="ndp-btn" type="button" onClick={savePreset}>保存</button>
          <button className="ndp-btn" type="button" onClick={renamePreset}>重命名</button>
          <button className="ndp-btn" type="button" onClick={saveAsPreset}>另存为</button>
          <button className="ndp-btn" type="button" disabled={promptPresets.length <= 1} onClick={deletePreset}>删除</button>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>固定正面提示词</label>
        <textarea className="ndp-textarea" rows={4} value={fixedPositivePrompt} onChange={(e) => patch({ fixedPositivePrompt: e.target.value })} />
        <p className="ndp-setting-hint">{positiveUsage}</p>
      </div>

      <div className="ndp-setting-item">
        <label>固定负面提示词</label>
        <textarea className="ndp-textarea" rows={4} value={fixedNegativePrompt} onChange={(e) => patch({ fixedNegativePrompt: e.target.value })} />
        <p className="ndp-setting-hint">{fixedNegativeUsage}</p>
      </div>

      <div className="ndp-setting-item">
        <label>文生图规则</label>
        <textarea className="ndp-textarea" rows={8} value={promptRules} onChange={(e) => patch({ promptRules: e.target.value })} />
      </div>

      <div className="ndp-setting-item">
        <label>占用上限</label>
        <input className="ndp-input" type="number" min={128} max={12000} step={64} value={maxPromptChars} onChange={(e) => patch({ maxPromptChars: intValue(e.target.value, maxPromptChars) })} />
      </div>

      <div className="ndp-setting-item">
        <label>模型</label>
        <select className="ndp-select" value={model} onChange={(e) => patch({ model: e.target.value })}>
          {optionList(MODEL_OPTIONS, model).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>采样器</label>
        <select className="ndp-select" value={sampler} onChange={(e) => patch({ sampler: e.target.value })}>
          {optionList(SAMPLER_OPTIONS, sampler).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>噪点表</label>
        <select className="ndp-select" value={noiseSchedule} onChange={(e) => patch({ noiseSchedule: e.target.value })}>
          {optionList(NOISE_SCHEDULE_OPTIONS, noiseSchedule).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>尺寸</label>
        <div className="ndp-row">
          <input className="ndp-input" type="number" min={64} max={4096} step={64} value={width} onChange={(e) => patch({ width: intValue(e.target.value, width) })} />
          <input className="ndp-input" type="number" min={64} max={4096} step={64} value={height} onChange={(e) => patch({ height: intValue(e.target.value, height) })} />
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>步数</label>
        <div className="ndp-range-input">
          <input type="range" min="1" max="80" step="1" value={steps} onChange={(e) => patch({ steps: intValue(e.target.value, steps) })} />
          <span>{steps}</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>Prompt Guidance</label>
        <div className="ndp-range-input">
          <input type="range" min="0" max="30" step="0.1" value={scale} onChange={(e) => patch({ scale: numberValue(e.target.value, scale) })} />
          <span>{scale.toFixed(1)}</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>Prompt Guidance Rescale</label>
        <div className="ndp-range-input">
          <input type="range" min="0" max="1" step="0.01" value={cfgRescale} onChange={(e) => patch({ cfgRescale: numberValue(e.target.value, cfgRescale) })} />
          <span>{cfgRescale.toFixed(2)}</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>张数 / 种子</label>
        <div className="ndp-row">
          <input className="ndp-input" type="number" min={1} max={8} value={nSamples} onChange={(e) => patch({ nSamples: intValue(e.target.value, nSamples) })} />
          <input className="ndp-input" type="number" min={-1} max={4294967295} value={seed} onChange={(e) => patch({ seed: intValue(e.target.value, seed) })} />
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>输出目录</label>
        <input className="ndp-input" value={outputDir} onChange={(e) => patch({ outputDir: e.target.value })} />
        <p className="ndp-setting-hint">相对应用数据目录，默认 generated-images。</p>
      </div>
    </div>
  )
}
