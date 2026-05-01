import { useCallback } from 'react'
import { getApi } from '../../neoDeskPetApi'
import type { Live2DModelInfo } from '../../live2d/live2dModels'

export function Live2DSettingsTab(props: {
  api: ReturnType<typeof getApi>
  petScale: number
  petOpacity: number
  live2dModelId: string
  live2dMouseTrackingEnabled: boolean
  live2dIdleSwayEnabled: boolean
  availableModels: Live2DModelInfo[]
  selectedModelInfo: Live2DModelInfo | null
  isLoadingModels: boolean
  refreshModels: (opts?: { force?: boolean }) => Promise<void>
}) {
  const {
    api,
    petScale,
    petOpacity,
    live2dModelId,
    live2dMouseTrackingEnabled,
    live2dIdleSwayEnabled,
    availableModels,
    selectedModelInfo,
    isLoadingModels,
    refreshModels,
  } = props
  const triggerRefresh = useCallback(() => {
    void refreshModels()
  }, [refreshModels])

  return (
    <div className="ndp-settings-section">
      <h3>Live2D 模型设置</h3>

      {/* Model Selection */}
      <div className="ndp-setting-item">
        <label>选择模型</label>
        <select
          className="ndp-select"
          value={live2dModelId}
          onMouseDown={triggerRefresh}
          onFocus={triggerRefresh}
          onChange={(e) => {
            const selectedModel = availableModels.find((m) => m.id === e.target.value)
            if (selectedModel) {
              api?.setLive2dModel(selectedModel.id, selectedModel.modelFile)
            }
          }}
          disabled={isLoadingModels}
        >
          {isLoadingModels ? (
            <option value="">扫描模型中...</option>
          ) : availableModels.length === 0 ? (
            <option value="">未找到模型</option>
          ) : (
            availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))
          )}
        </select>
        <p className="ndp-setting-hint">
          {isLoadingModels ? '正在扫描 live2d 目录...' : `共 ${availableModels.length} 个模型可用`}
        </p>
      </div>

      {/* Model Info */}
      {selectedModelInfo && (
        <div className="ndp-model-info">
          <p className="ndp-model-path">
            路径: <code>{selectedModelInfo.modelFile}</code>
          </p>
          <div className="ndp-model-features">
            {selectedModelInfo.hasPhysics && <span className="ndp-feature-tag">物理</span>}
            {selectedModelInfo.hasPose && <span className="ndp-feature-tag">姿势</span>}
            {selectedModelInfo.expressions && selectedModelInfo.expressions.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.expressions.length} 表情</span>
            )}
            {selectedModelInfo.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.motionGroups.length} 动作组</span>
            )}
          </div>
        </div>
      )}

      {/* Expression Test */}
      {selectedModelInfo?.expressions && selectedModelInfo.expressions.length > 0 && (
        <div className="ndp-setting-item">
          <label>表情测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.expressions.map((exp) => (
              <button
                key={exp.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerExpression(exp.name)}
              >
                {exp.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Motion Test */}
      {selectedModelInfo?.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
        <div className="ndp-setting-item">
          <label>动作测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.motionGroups.map((group) => (
              <button
                key={group.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerMotion(group.name, 0)}
              >
                {group.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={live2dMouseTrackingEnabled}
            onChange={(e) => api?.setLive2dMouseTrackingEnabled(e.target.checked)}
          />
          <span>鼠标跟随</span>
        </label>
        <p className="ndp-setting-hint">开启后模型会跟随鼠标方向。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={live2dIdleSwayEnabled}
            onChange={(e) => api?.setLive2dIdleSwayEnabled(e.target.checked)}
          />
          <span>物理摇摆</span>
        </label>
        <p className="ndp-setting-hint">关闭后禁用待机摇摆，模型姿态更稳定。</p>
      </div>

      <div className="ndp-setting-item">
        <label>模型大小</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="5"
            step="0.1"
            value={petScale}
            onChange={(e) => api?.setPetScale(parseFloat(e.target.value))}
          />
          <span>{petScale.toFixed(1)}x</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的显示大小（高分辨率模型可能需要更大的值）</p>
      </div>

      <div className="ndp-setting-item">
        <label>模型透明度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.3"
            max="1.0"
            step="0.1"
            value={petOpacity}
            onChange={(e) => api?.setPetOpacity(parseFloat(e.target.value))}
          />
          <span>{Math.round(petOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的透明度</p>
      </div>
    </div>
  )
}
