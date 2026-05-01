import { useEffect, useState } from 'react'
import type { AppSettings, BubbleStyle, TailDirection } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

export function BubbleSettingsTab(props: {
  api: ReturnType<typeof getApi>
  bubbleSettings: AppSettings['bubble'] | undefined
}) {
  const { api, bubbleSettings } = props
  const [phrasesText, setPhrasesText] = useState('')

  const style = bubbleSettings?.style ?? 'cute'
  const positionX = bubbleSettings?.positionX ?? 75
  const positionY = bubbleSettings?.positionY ?? 10
  const tailDirection = bubbleSettings?.tailDirection ?? 'down'
  const showOnClick = bubbleSettings?.showOnClick ?? true
  const showOnChat = bubbleSettings?.showOnChat ?? true
  const autoHideDelay = bubbleSettings?.autoHideDelay ?? 5000
  const clickPhrases = bubbleSettings?.clickPhrases ?? []
  const clickPhrasesText = clickPhrases.join('\n')
  const contextOrbEnabled = bubbleSettings?.contextOrbEnabled ?? false
  const contextOrbX = bubbleSettings?.contextOrbX ?? 12
  const contextOrbY = bubbleSettings?.contextOrbY ?? 16

  // Sync phrases text with settings
  useEffect(() => {
    setPhrasesText(clickPhrasesText)
  }, [clickPhrasesText])

  const styleOptions: { value: BubbleStyle; label: string; desc: string }[] = [
    { value: 'cute', label: '可爱粉', desc: '粉色渐变，带爱心装饰' },
    { value: 'pixel', label: '像素风', desc: '复古像素游戏风格' },
    { value: 'minimal', label: '简约白', desc: '简洁现代风格' },
    { value: 'cloud', label: '云朵蓝', desc: '蓝色云朵造型' },
  ]

  const tailOptions: { value: TailDirection; label: string; icon: string }[] = [
    { value: 'up', label: '上', icon: '↑' },
    { value: 'down', label: '下', icon: '↓' },
    { value: 'left', label: '左', icon: '←' },
    { value: 'right', label: '右', icon: '→' },
  ]

  const handlePhrasesChange = (text: string) => {
    setPhrasesText(text)
  }

  const handlePhrasesSave = () => {
    const phrases = phrasesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    api?.setBubbleSettings({ clickPhrases: phrases })
  }

  return (
    <div className="ndp-settings-section">
      <h3>气泡样式</h3>

      {/* Style Selection */}
      <div className="ndp-setting-item">
        <label>气泡风格</label>
        <div className="ndp-style-grid">
          {styleOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-style-btn ${style === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ style: opt.value })}
            >
              <span className="ndp-style-label">{opt.label}</span>
              <span className="ndp-style-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Position X */}
      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionX}
            onChange={(e) => api?.setBubbleSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      {/* Position Y */}
      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionY}
            onChange={(e) => api?.setBubbleSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>

      {/* Tail Direction */}
      <div className="ndp-setting-item">
        <label>尾巴方向</label>
        <div className="ndp-tail-grid">
          {tailOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-tail-btn ${tailDirection === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ tailDirection: opt.value })}
            >
              <span className="ndp-tail-icon">{opt.icon}</span>
              <span className="ndp-tail-label">{opt.label}</span>
            </button>
          ))}
        </div>
        <p className="ndp-setting-hint">气泡尾巴指向的方向</p>
      </div>

      <h3>显示设置</h3>

      {/* Show on Click */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnClick}
            onChange={(e) => api?.setBubbleSettings({ showOnClick: e.target.checked })}
          />
          <span>点击宠物时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">点击桌宠时随机显示可爱的台词</p>
      </div>

      {/* Show on Chat */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnChat}
            onChange={(e) => api?.setBubbleSettings({ showOnChat: e.target.checked })}
          />
          <span>AI 回复时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">AI 回复消息时在桌宠旁边显示气泡</p>
      </div>

      {/* Auto Hide Delay */}
      <div className="ndp-setting-item">
        <label>自动隐藏延迟</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="15000"
            step="1000"
            value={autoHideDelay}
            onChange={(e) => api?.setBubbleSettings({ autoHideDelay: parseInt(e.target.value) })}
          />
          <span>{autoHideDelay === 0 ? '手动关闭' : `${autoHideDelay / 1000}秒`}</span>
        </div>
        <p className="ndp-setting-hint">气泡显示后自动消失的时间，0 表示需要手动关闭</p>
      </div>

      <h3>上下文情况</h3>
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={contextOrbEnabled}
            onChange={(e) => api?.setBubbleSettings({ contextOrbEnabled: e.target.checked })}
          />
          <span>显示上下文小球</span>
        </label>
        <p className="ndp-setting-hint">在桌宠窗口显示一个可拖动的小球，鼠标悬停可查看上下文占用。</p>
        <div className="ndp-setting-actions">
          <button
            className="ndp-btn"
            onClick={() => api?.setBubbleSettings({ contextOrbX: 12, contextOrbY: 16 })}
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

      <h3>自定义台词</h3>

      {/* Custom Click Phrases */}
      <div className="ndp-setting-item">
        <label>点击台词</label>
        <textarea
          className="ndp-textarea"
          value={phrasesText}
          placeholder="每行一句台词..."
          rows={6}
          onChange={(e) => handlePhrasesChange(e.target.value)}
          onBlur={handlePhrasesSave}
        />
        <p className="ndp-setting-hint">每行一句，点击桌宠时随机显示（共 {clickPhrases.length} 句）</p>
      </div>
    </div>
  )
}
