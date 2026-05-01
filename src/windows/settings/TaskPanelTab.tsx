import type { AppSettings } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

export function TaskPanelSettingsTab(props: {
  api: ReturnType<typeof getApi>
  taskPanelSettings: AppSettings['taskPanel'] | undefined
}) {
  const { api, taskPanelSettings } = props
  const positionX = taskPanelSettings?.positionX ?? 50
  const positionY = taskPanelSettings?.positionY ?? 78

  return (
    <div className="ndp-settings-section">
      <h3>任务面板</h3>
      <p className="ndp-setting-hint">仅在有任务进行中时出现，用于查看进度与暂停/终止。</p>

      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionX}
            onChange={(e) => api?.setTaskPanelSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionY}
            onChange={(e) => api?.setTaskPanelSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>
    </div>
  )
}
