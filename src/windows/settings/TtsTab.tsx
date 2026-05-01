import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

export function TtsSettingsTab(props: { api: ReturnType<typeof getApi>; ttsSettings: AppSettings['tts'] | undefined }) {
  const { api, ttsSettings } = props

  const enabled = ttsSettings?.enabled ?? false
  const gptWeightsPath = ttsSettings?.gptWeightsPath ?? 'GPT_SoVITS/pretrained_models/s1v3.ckpt'
  const sovitsWeightsPath = ttsSettings?.sovitsWeightsPath ?? 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'
  const speedFactor = ttsSettings?.speedFactor ?? 1.0
  const refAudioPath = ttsSettings?.refAudioPath ?? ''
  const promptText = ttsSettings?.promptText ?? ''
  const streaming = ttsSettings?.streaming ?? true
  const segmented = ttsSettings?.segmented ?? false
  const pauseMs = Math.max(0, Math.min(60000, ttsSettings?.pauseMs ?? 280))
  const playbackTextMode = (ttsSettings?.playbackTextMode ?? 'full') as 'full' | 'quoted' | 'regex'
  const playbackRegex = ttsSettings?.playbackRegex ?? ''
  const playbackRegexFlags = ttsSettings?.playbackRegexFlags ?? 'g'

  const [options, setOptions] = useState<
    | {
        gptModels: Array<{ label: string; weightsPath: string }>
        sovitsModels: Array<{ label: string; weightsPath: string }>
        refAudios: Array<{ label: string; value: string; promptText: string }>
        ttsRoot: string
      }
    | null
  >(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const lastOptionsRefreshAtRef = useRef(0)

  const refreshOptions = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!api) return
      const now = Date.now()
      if (!opts?.force && now - lastOptionsRefreshAtRef.current < 800) return
      lastOptionsRefreshAtRef.current = now

      setOptionsError(null)
      try {
        const data = await api.listTtsOptions()
        setOptions(data)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setOptionsError(msg)
      }
    },
    [api],
  )

  useEffect(() => {
    void refreshOptions({ force: true })
  }, [refreshOptions])

  const ttsRoot = ttsSettings?.ttsRoot ?? ''

  const onSelectRefAudio = (value: string) => {
    const selected = options?.refAudios?.find((x) => x.value === value)
    api?.setTtsSettings({
      refAudioPath: value,
      promptText: selected?.promptText ?? promptText,
    })
  }

  return (
    <div className="ndp-settings-section">
      <h3>TTS 语音</h3>

      <div className="ndp-setting-item">
        <label>GPT-SoVITS 安装目录（绝对路径）</label>
        <input
          type="text"
          className="ndp-input"
          value={ttsRoot}
          placeholder="留空则使用 APP_ROOT/GPT-SoVITS-v2_ProPlus"
          onChange={(e) => api?.setTtsSettings({ ttsRoot: e.target.value })}
          onBlur={() => void refreshOptions({ force: true })}
        />
        <p className="ndp-setting-hint">
          修改后自动重新扫描模型列表。当前生效路径：<code>{options?.ttsRoot ?? '-'}</code>
        </p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setTtsSettings({ enabled: e.target.checked })} />
          <span>启用 TTS（助手消息自动播报）</span>
        </label>
        <p className="ndp-setting-hint">需要先启动 `GPT-SoVITS-v2_ProPlus` 的 API 服务（默认: http://127.0.0.1:9880）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>GPT 模型</label>
        <select
          className="ndp-select"
          value={gptWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ gptWeightsPath: e.target.value })}
        >
          {(options?.gptModels?.length ?? 0) > 0 ? (
            options!.gptModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={gptWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>SoVITS 模型</label>
        <select
          className="ndp-select"
          value={sovitsWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ sovitsWeightsPath: e.target.value })}
        >
          {(options?.sovitsModels?.length ?? 0) > 0 ? (
            options!.sovitsModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={sovitsWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
        <p className="ndp-setting-hint">默认“直接推底模”只需要设置参考音频即可。</p>
      </div>

      <div className="ndp-setting-item">
        <label>语速</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={speedFactor}
            onChange={(e) => api?.setTtsSettings({ speedFactor: parseFloat(e.target.value) })}
          />
          <span>{speedFactor.toFixed(2)}x</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频</label>
        <select
          className="ndp-select"
          value={refAudioPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => onSelectRefAudio(e.target.value)}
        >
          <option value="">请选择（从 `参考音频` 目录扫描）</option>
          {(options?.refAudios ?? []).map((a) => (
            <option key={a.value} value={a.value} title={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="ndp-setting-hint">下拉框仅显示文件名里 `[]` 内的内容（例如角色名）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频文本（自动从文件名解析，可编辑）</label>
        <textarea
          className="ndp-textarea"
          value={promptText}
          rows={3}
          placeholder="例如：该做的事都做完了么？好，别睡下了才想起来日常没做，拜拜。"
          onChange={(e) => api?.setTtsSettings({ promptText: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={streaming} onChange={(e) => api?.setTtsSettings({ streaming: e.target.checked })} />
          <span>流式处理（边生成边播放）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={segmented} onChange={(e) => api?.setTtsSettings({ segmented: e.target.checked })} />
          <span>分句同步显示（TTS 念一句，聊天/气泡显示一句）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label>TTS 播放文本</label>
        <select
          className="ndp-select"
          value={playbackTextMode}
          onChange={(e) =>
            api?.setTtsSettings({
              playbackTextMode: e.target.value as 'full' | 'quoted' | 'regex',
            })
          }
        >
          <option value="full">全文播报</option>
          <option value="quoted">仅播报引号内容（如 “这段话”）</option>
          <option value="regex">自定义正则提取</option>
        </select>
        <p className="ndp-setting-hint">只影响 TTS 读音，不影响聊天窗口和气泡显示文本。</p>
      </div>

      {playbackTextMode === 'regex' && (
        <>
          <div className="ndp-setting-item">
            <label>自定义提取正则</label>
            <input
              className="ndp-input"
              value={playbackRegex}
              placeholder={'例如："([^"]+)"|“([^”]+)”'}
              onChange={(e) => api?.setTtsSettings({ playbackRegex: e.target.value })}
            />
            <p className="ndp-setting-hint">有捕获组时优先播报第 1 组；无捕获组时播报整段匹配。</p>
          </div>

          <div className="ndp-setting-item">
            <label>正则 Flags</label>
            <input
              className="ndp-input"
              value={playbackRegexFlags}
              placeholder="g"
              onChange={(e) => api?.setTtsSettings({ playbackRegexFlags: e.target.value })}
            />
            <p className="ndp-setting-hint">常用：`g`（全局）、`i`（忽略大小写）。</p>
          </div>
        </>
      )}

      <div className="ndp-setting-item">
        <label>分句停顿（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="60000"
            step="20"
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0}
            max={60000}
            step={20}
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value || '0') })}
          />
        </div>
      </div>

      {options?.ttsRoot ? <p className="ndp-setting-hint">扫描目录: {options.ttsRoot}</p> : null}
      {optionsError ? <p className="ndp-setting-hint">扫描失败: {optionsError}</p> : null}
    </div>
  )
}
