// 设置窗口外壳：各设置 Tab 的容器与导航（自 App.tsx 拆出）

import type { AppSettings } from '../../electron/types'
import { getAvailableModels, parseModelMetadata, scanAvailableModels, type Live2DModelInfo } from '../live2d/live2dModels'
import { getApi } from '../neoDeskPetApi'
import { AISettingsTab } from './settings/AiTab'
import { AsrSettingsTab } from './settings/AsrTab'
import { BubbleSettingsTab } from './settings/BubbleTab'
import { ChatUiSettingsTab } from './settings/ChatUiTab'
import { Live2DSettingsTab } from './settings/Live2DTab'
import { NovelAISettingsTab } from './settings/NovelAITab'
import { PersonaSettingsTab } from './settings/PersonaTab'
import { TaskPanelSettingsTab } from './settings/TaskPanelTab'
import { ToolsSettingsTab } from './settings/ToolsTab'
import { TtsSettingsTab } from './settings/TtsTab'
import { WorldBookSettingsTab } from './settings/WorldBookTab'
import { useCallback, useEffect, useRef, useState } from 'react'

export function SettingsWindow(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const [activeTab, setActiveTab] = useState<
    'live2d' | 'bubble' | 'taskPanel' | 'ai' | 'novelai' | 'tools' | 'persona' | 'worldBook' | 'chat' | 'tts' | 'asr'
  >('live2d')
  const [availableModels, setAvailableModels] = useState<Live2DModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(true)
  const lastModelScanAtRef = useRef(0)

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dModelId = settings?.live2dModelId ?? 'haru'
  const live2dMouseTrackingEnabled = settings?.live2dMouseTrackingEnabled !== false
  const live2dIdleSwayEnabled = settings?.live2dIdleSwayEnabled !== false
  const aiSettings = settings?.ai
  const novelAISettings = settings?.novelai
  const bubbleSettings = settings?.bubble
  const chatUi = settings?.chatUi
  const ttsSettings = settings?.tts
  const asrSettings = settings?.asr

  const refreshModels = useCallback(
    async (opts?: { force?: boolean }) => {
      const now = Date.now()
      if (!opts?.force && now - lastModelScanAtRef.current < 800) return
      lastModelScanAtRef.current = now

      setIsLoadingModels(true)
      try {
        const models = await scanAvailableModels()
        setAvailableModels(models)
      } catch (err) {
        console.error('[Settings] Failed to scan models:', err)
        // Fallback to cached models
        setAvailableModels(getAvailableModels())
      } finally {
        setIsLoadingModels(false)
      }
    },
    [setAvailableModels, setIsLoadingModels],
  )

  // Scan models on mount
  useEffect(() => {
    void refreshModels({ force: true })
  }, [refreshModels])
  const [selectedModelInfo, setSelectedModelInfo] = useState<Live2DModelInfo | null>(null)

  // Load model metadata when model changes or models are loaded
  useEffect(() => {
    const model = availableModels.find((m) => m.id === live2dModelId)
    if (!model) {
      setSelectedModelInfo(null)
      return
    }

    // Start with basic info
    setSelectedModelInfo(model)

    // Then load full metadata
    parseModelMetadata(model.modelFile).then((metadata) => {
      setSelectedModelInfo({
        ...model,
        ...metadata,
      })
    })
  }, [live2dModelId, availableModels])

  return (
    <div className="ndp-settings-root">
      {/* Header */}
      <header className="ndp-settings-header">
        <div className="ndp-settings-title">
          <span className="ndp-settings-icon">⚙️</span>
          <span>设置</span>
        </div>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={() => api?.openMemory()}>
            记忆控制台
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="ndp-settings-tabs">
        <button
          className={`ndp-tab-btn ${activeTab === 'live2d' ? 'active' : ''}`}
          onClick={() => setActiveTab('live2d')}
        >
          Live2D 模型
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'bubble' ? 'active' : ''}`}
          onClick={() => setActiveTab('bubble')}
        >
          气泡设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'taskPanel' ? 'active' : ''}`}
          onClick={() => setActiveTab('taskPanel')}
        >
          任务面板
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI 设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'novelai' ? 'active' : ''}`}
          onClick={() => setActiveTab('novelai')}
        >
          生图
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'tools' ? 'active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          工具中心
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'persona' ? 'active' : ''}`}
          onClick={() => setActiveTab('persona')}
        >
          角色/记忆
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'worldBook' ? 'active' : ''}`}
          onClick={() => setActiveTab('worldBook')}
        >
          设定库
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          聊天界面
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveTab('tts')}
        >
          TTS
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'asr' ? 'active' : ''}`}
          onClick={() => setActiveTab('asr')}
        >
          语音识别
        </button>
      </div>

      {/* Content */}
      <main className="ndp-settings-content">
        {activeTab === 'live2d' && (
          <Live2DSettingsTab
            api={api}
            petScale={petScale}
            petOpacity={petOpacity}
            live2dModelId={live2dModelId}
            live2dMouseTrackingEnabled={live2dMouseTrackingEnabled}
            live2dIdleSwayEnabled={live2dIdleSwayEnabled}
            availableModels={availableModels}
            selectedModelInfo={selectedModelInfo}
            isLoadingModels={isLoadingModels}
            refreshModels={refreshModels}
          />
        )}
        {activeTab === 'bubble' && <BubbleSettingsTab api={api} bubbleSettings={bubbleSettings} />}
        {activeTab === 'taskPanel' && <TaskPanelSettingsTab api={api} taskPanelSettings={settings?.taskPanel} />}
        {activeTab === 'ai' && (
          <AISettingsTab
            api={api}
            aiSettings={aiSettings}
            orchestrator={settings?.orchestrator}
            aiProfiles={settings?.aiProfiles}
            activeAiProfileId={settings?.activeAiProfileId}
          />
        )}
        {activeTab === 'novelai' && <NovelAISettingsTab api={api} settings={novelAISettings} />}
        {activeTab === 'tools' && <ToolsSettingsTab api={api} settings={settings} />}
        {activeTab === 'persona' && <PersonaSettingsTab api={api} settings={settings} />}
        {activeTab === 'worldBook' && <WorldBookSettingsTab api={api} settings={settings} />}
        {activeTab === 'chat' && <ChatUiSettingsTab api={api} chatUi={chatUi} />}
        {activeTab === 'tts' && <TtsSettingsTab api={api} ttsSettings={ttsSettings} />}
        {activeTab === 'asr' && <AsrSettingsTab api={api} asrSettings={asrSettings} />}
      </main>

      {/* Footer */}
      <footer className="ndp-settings-footer">
        <button className="ndp-reset-btn" disabled>
          重置默认
        </button>
      </footer>
    </div>
  )
}
