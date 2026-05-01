import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'
import {
  OPEN_TYPELESS_ASR_DEFAULT_WS_URL,
  isOpenTypelessAsrWsUrl,
} from '../../utils/settingsHelpers'

export function AsrSettingsTab(props: { api: ReturnType<typeof getApi>; asrSettings: AppSettings['asr'] | undefined }) {
  const { api, asrSettings } = props

  const enabled = asrSettings?.enabled ?? false
  const wsUrl = asrSettings?.wsUrl ?? OPEN_TYPELESS_ASR_DEFAULT_WS_URL
  const usingOpenTypelessWs = isOpenTypelessAsrWsUrl(wsUrl)
  const micDeviceId = asrSettings?.micDeviceId ?? ''
  const captureBackend = (asrSettings?.captureBackend ?? 'script') as 'auto' | 'script' | 'worklet'
  const replaceRules = asrSettings?.replaceRules ?? ''
  const fillerWords = asrSettings?.fillerWords ?? '嗯, 啊, 呃, 额, 唔'
  const stripFillers = asrSettings?.stripFillers ?? true
  const ignoreCaseReplace = asrSettings?.ignoreCaseReplace ?? true
  const processInterim = asrSettings?.processInterim ?? false
  const autoSend = asrSettings?.autoSend ?? false
  const mode = (asrSettings?.mode ?? 'continuous') as 'continuous' | 'hotkey'
  const hotkey = asrSettings?.hotkey ?? 'F8'
  const showSubtitle = asrSettings?.showSubtitle ?? true

  const [micDevices, setMicDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const [micLoading, setMicLoading] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const refreshMicDevices = useCallback(async () => {
    setMicLoading(true)
    setMicError(null)

    try {
      if (!navigator.mediaDevices) {
        setMicDevices([])
        setMicError('当前环境不支持枚举音频设备')
        return
      }

      // 先请求一次权限，否则 device.label 可能为空，且部分环境 enumerateDevices 不完整
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `麦克风（${d.deviceId.slice(0, 6)}…）` }))
        setMicDevices(mics)
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMicDevices([])
      setMicError(msg)
    } finally {
      setMicLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshMicDevices()
  }, [refreshMicDevices])

  return (
    <div className="ndp-settings-section">
      <h3>语音识别（ASR）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setAsrSettings({ enabled: e.target.checked })} />
          <span>启用语音识别（麦克风转文字）</span>
        </label>
        <p className="ndp-setting-hint">
          启用后会自动启动/关闭本地 OpenTypeless ASR API（<code>OpenTypeless-main/doubao_asr_api.py</code>），无需手动先开服务。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>WebSocket 地址</label>
        <input type="text" className="ndp-input" value={wsUrl} onChange={(e) => api?.setAsrSettings({ wsUrl: e.target.value })} />
        <p className="ndp-setting-hint">示例：{OPEN_TYPELESS_ASR_DEFAULT_WS_URL}（OpenTypeless 实时识别 ws）</p>
        <p className="ndp-setting-hint">端口不是固定的，可改成如 `ws://127.0.0.1:9000/demo/ws/realtime`；自动托管会按该端口启动本地 API。</p>
        {usingOpenTypelessWs ? (
          <p className="ndp-setting-hint">当前使用 OpenTypeless 实时 ws：下方 VAD/AGC 等旧 ASR 参数不会发送给服务端，保持默认即可。</p>
        ) : null}
      </div>

      <div className="ndp-setting-item">
        <label>采集方式</label>
        <select
          className="ndp-select"
          value={captureBackend}
          onChange={(e) => api?.setAsrSettings({ captureBackend: e.target.value as AppSettings['asr']['captureBackend'] })}
        >
          <option value="script">ScriptProcessor（更稳定，推荐）</option>
          <option value="worklet">AudioWorklet（更低延迟）</option>
          <option value="auto">自动（优先 worklet）</option>
        </select>
        <p className="ndp-setting-hint">如果识别结果出现大量“🎼”等富文本标记或明显异常，优先切到 ScriptProcessor</p>
      </div>

      <div className="ndp-setting-item">
        <label>选择麦克风</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            className="ndp-select"
            style={{ flex: 1 }}
            value={micDeviceId}
            onMouseDown={() => refreshMicDevices()}
            onFocus={() => refreshMicDevices()}
            onChange={(e) => api?.setAsrSettings({ micDeviceId: e.target.value })}
          >
            <option value="">系统默认</option>
            {micDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} title={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ndp-btn" onClick={() => refreshMicDevices()} disabled={micLoading} type="button">
            {micLoading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <p className="ndp-setting-hint">
          如果下拉框为空或无法选择，先点一次“刷新”并允许麦克风权限；设备名称只有在授权后才会显示
        </p>
        {micError ? <p className="ndp-setting-hint">刷新失败：{micError}</p> : null}
      </div>

      <h3>启动方式</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="radio" name="asrMode" checked={mode === 'continuous'} onChange={() => api?.setAsrSettings({ mode: 'continuous' })} />
          <span>持续录音（无需按键）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input type="radio" name="asrMode" checked={mode === 'hotkey'} onChange={() => api?.setAsrSettings({ mode: 'hotkey' })} />
          <span>按键录音（按一下开始，再按一下结束）</span>
        </label>

        {mode === 'hotkey' && (
          <div style={{ marginTop: 10 }}>
            <label>录音快捷键</label>
            <input type="text" className="ndp-input" value={hotkey} onChange={(e) => api?.setAsrSettings({ hotkey: e.target.value })} />
            <p className="ndp-setting-hint">示例：F8 / Ctrl+Alt+V / A（全局快捷键，可能和系统/软件冲突）</p>
          </div>
        )}
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={showSubtitle} onChange={(e) => api?.setAsrSettings({ showSubtitle: e.target.checked })} />
          <span>桌宠窗口显示识别字幕</span>
        </label>
        <p className="ndp-setting-hint">字幕会显示实时中间结果（INTERIM_RESULT）和最终结果（FINAL_RESULT）。</p>
      </div>

      <h3>识别结果处理</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="radio" name="asrSendMode" checked={autoSend} onChange={() => api?.setAsrSettings({ autoSend: true })} />
          <span>直接发送（识别完自动发给 LLM）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="radio"
            name="asrSendMode"
            checked={!autoSend}
            onChange={() => api?.setAsrSettings({ autoSend: false })}
          />
          <span>仅在输入框（识别完只填入输入框，手动发送）</span>
        </label>
        <p className="ndp-setting-hint">开启“直接发送”后，会把每次端点结束的一段识别结果作为一条用户消息发送</p>
      </div>

      <h3>本地文本规则（OpenTypeless 风格）</h3>

      <div className="ndp-setting-item">
        <label>热词替换规则（逐行）</label>
        <textarea
          className="ndp-textarea"
          rows={5}
          value={replaceRules}
          placeholder={'格式：错词 => 正确词\nDeep Sick R1 => DeepSeek-R1\nDeep Seat => DeepSeek'}
          onChange={(e) => api?.setAsrSettings({ replaceRules: e.target.value })}
        />
        <p className="ndp-setting-hint">本地前端规则，不增加 ASR 网络延迟；会作用于最终结果，中间结果也会应用热词替换。</p>
      </div>

      <div className="ndp-setting-item">
        <label>语气词列表（逗号/换行分隔）</label>
        <textarea
          className="ndp-textarea"
          rows={3}
          value={fillerWords}
          placeholder="例如：嗯, 啊, 呃, 额, 唔"
          onChange={(e) => api?.setAsrSettings({ fillerWords: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={stripFillers} onChange={(e) => api?.setAsrSettings({ stripFillers: e.target.checked })} />
          <span>去语气词（默认仅处理最终结果）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={ignoreCaseReplace}
            onChange={(e) => api?.setAsrSettings({ ignoreCaseReplace: e.target.checked })}
          />
          <span>热词替换忽略大小写（英文推荐开启）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={processInterim} onChange={(e) => api?.setAsrSettings({ processInterim: e.target.checked })} />
          <span>中间结果也去语气词（可能更抖动）</span>
        </label>
      </div>
    </div>
  )
}
