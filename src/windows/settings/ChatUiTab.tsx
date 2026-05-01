import { useRef } from 'react'
import type { AppSettings } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

export function ChatUiSettingsTab(props: { api: ReturnType<typeof getApi>; chatUi: AppSettings['chatUi'] | undefined }) {
  const { api, chatUi } = props

  const background = chatUi?.background ?? 'rgba(20, 20, 24, 0.45)'
  const userBubbleBackground = chatUi?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)'
  const assistantBubbleBackground = chatUi?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)'
  const bubbleRadius = chatUi?.bubbleRadius ?? 14
  const backgroundImage = chatUi?.backgroundImage ?? ''
  const backgroundImageOpacity = chatUi?.backgroundImageOpacity ?? 0.6
  const contextOrbEnabled = chatUi?.contextOrbEnabled ?? false
  const contextOrbX = chatUi?.contextOrbX ?? 6
  const contextOrbY = chatUi?.contextOrbY ?? 14
  const backgroundImageInputRef = useRef<HTMLInputElement>(null)

  const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))
  const clampFloat = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const parseRgba = (
    value: string,
    fallback: { r: number; g: number; b: number; a: number },
  ): { r: number; g: number; b: number; a: number } => {
    const m = value
      .trim()
      .match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i)
    if (!m) return fallback
    const r = clampInt(parseInt(m[1] || '0'), 0, 255)
    const g = clampInt(parseInt(m[2] || '0'), 0, 255)
    const b = clampInt(parseInt(m[3] || '0'), 0, 255)
    const a = clampFloat(m[4] == null ? 1 : parseFloat(m[4]), 0, 1)
    return { r, g, b, a }
  }

  const toRgba = (rgba: { r: number; g: number; b: number; a: number }) =>
    `rgba(${clampInt(rgba.r, 0, 255)}, ${clampInt(rgba.g, 0, 255)}, ${clampInt(rgba.b, 0, 255)}, ${clampFloat(
      rgba.a,
      0,
      1,
    ).toFixed(2)})`

  const renderRgbaEditor = (opts: {
    label: string
    value: string
    onChange: (next: string) => void
  }) => {
    const rgba = parseRgba(opts.value, { r: 20, g: 20, b: 24, a: 0.45 })

    const set = (next: Partial<typeof rgba>) => {
      const safe: Partial<typeof rgba> = {}
      if (typeof next.r === 'number' && Number.isFinite(next.r)) safe.r = next.r
      if (typeof next.g === 'number' && Number.isFinite(next.g)) safe.g = next.g
      if (typeof next.b === 'number' && Number.isFinite(next.b)) safe.b = next.b
      if (typeof next.a === 'number' && Number.isFinite(next.a)) safe.a = next.a

      const merged = { ...rgba, ...safe }
      opts.onChange(toRgba(merged))
    }

    return (
      <div className="ndp-setting-item">
        <label>{opts.label}</label>
        <div className="ndp-rgba-editor">
          <div className="ndp-rgba-preview" style={{ background: opts.value }} />

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">R</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">G</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">B</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">A</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
    )
  }

  const readBackgroundFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 5 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => api?.setChatUiSettings({ backgroundImage: String(reader.result || '') })
    reader.readAsDataURL(file)
  }

  return (
    <div className="ndp-settings-section">
      <h3>聊天界面美化</h3>
      <p className="ndp-setting-hint">头像在聊天窗口中点击头像即可更换（不在设置里）。</p>

      {renderRgbaEditor({
        label: '聊天背景 RGBA',
        value: background,
        onChange: (next) => api?.setChatUiSettings({ background: next }),
      })}

      <div className="ndp-setting-item">
        <label>背景图片</label>
        <div className="ndp-bgimg-row">
          <div className="ndp-bgimg-preview">{backgroundImage ? <img src={backgroundImage} alt="bg" /> : <span>无</span>}</div>
          <div className="ndp-bgimg-actions">
            <button className="ndp-btn" onClick={() => backgroundImageInputRef.current?.click()}>
              选择图片
            </button>
            <button
              className="ndp-btn"
              onClick={() => api?.setChatUiSettings({ backgroundImage: '' })}
              disabled={!backgroundImage}
            >
              清除
            </button>
          </div>
        </div>
        <input
          ref={backgroundImageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            readBackgroundFile(file)
            e.currentTarget.value = ''
          }}
        />
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={backgroundImageOpacity}
            onChange={(e) => api?.setChatUiSettings({ backgroundImageOpacity: parseFloat(e.target.value) })}
          />
          <span>{Math.round(backgroundImageOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">拖动调整背景图片透明度（建议图片小于 5MB）</p>
      </div>

      {renderRgbaEditor({
        label: '用户气泡 RGBA',
        value: userBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ userBubbleBackground: next }),
      })}

      {renderRgbaEditor({
        label: '助手气泡 RGBA',
        value: assistantBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ assistantBubbleBackground: next }),
      })}

      <div className="ndp-setting-item">
        <label>气泡圆角</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="6"
            max="24"
            step="1"
            value={bubbleRadius}
            onChange={(e) => api?.setChatUiSettings({ bubbleRadius: parseInt(e.target.value) })}
          />
          <span>{bubbleRadius}px</span>
        </div>
      </div>

      <h3>上下文情况</h3>
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={contextOrbEnabled}
            onChange={(e) => api?.setChatUiSettings({ contextOrbEnabled: e.target.checked })}
          />
          <span>显示上下文小球</span>
        </label>
        <p className="ndp-setting-hint">在聊天窗口显示一个可拖动的小球，鼠标悬停可查看上下文占用。</p>
        <div className="ndp-setting-actions">
          <button
            className="ndp-btn"
            onClick={() => api?.setChatUiSettings({ contextOrbX: 6, contextOrbY: 14 })}
            disabled={!contextOrbEnabled}
            title="重置到默认位置"
          >
            重置位置
          </button>
          <span className="ndp-setting-hint" style={{ marginLeft: 10 }}>
            当前位置：{Math.round(contextOrbX)}% / {Math.round(contextOrbY)}%
          </span>
        </div>
      </div>
    </div>
  )
}
