import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getApi } from '../src/neoDeskPetApi'
import { BubbleSettingsTab } from '../src/windows/settings/BubbleTab'
import { ChatUiSettingsTab } from '../src/windows/settings/ChatUiTab'
import { Live2DSettingsTab } from '../src/windows/settings/Live2DTab'
import { NovelAISettingsTab } from '../src/windows/settings/NovelAITab'
import { PersonaSettingsTab } from '../src/windows/settings/PersonaTab'
import { AsrSettingsTab } from '../src/windows/settings/AsrTab'
import { AISettingsTab } from '../src/windows/settings/AiTab'
import { getSettingsTabTargetIndex } from '../src/windows/settings/settingsTabs'
import { parseMcpImportText } from '../src/windows/settings/mcpImport'
import { ToolsSettingsTab } from '../src/windows/settings/ToolsTab'
import { TtsSettingsTab } from '../src/windows/settings/TtsTab'
import { TaskPanelSettingsTab } from '../src/windows/settings/TaskPanelTab'

const api = {} as ReturnType<typeof getApi>

describe('settings tabs', () => {
  it('wraps horizontal navigation and supports Home and End', () => {
    expect(getSettingsTabTargetIndex(0, 3, 'ArrowLeft')).toBe(2)
    expect(getSettingsTabTargetIndex(2, 3, 'ArrowRight')).toBe(0)
    expect(getSettingsTabTargetIndex(1, 3, 'Home')).toBe(0)
    expect(getSettingsTabTargetIndex(1, 3, 'End')).toBe(2)
    expect(getSettingsTabTargetIndex(1, 3, 'Enter')).toBeNull()
    expect(getSettingsTabTargetIndex(-1, 3, 'ArrowRight')).toBeNull()
  })

  it('renders persona settings as an associated roving tab set', () => {
    const html = renderToStaticMarkup(createElement(PersonaSettingsTab, { api, settings: null }))

    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(6)
    expect(html).toContain('id="ndp-persona-tab-persona"')
    expect(html).toContain('aria-controls="ndp-persona-tabpanel"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-labelledby="ndp-persona-tab-persona"')
  })

  it('renders tool settings as an associated roving tab set', () => {
    const html = renderToStaticMarkup(createElement(ToolsSettingsTab, { api, settings: null }))

    expect(html).toContain('aria-label="工具中心设置"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html).toContain('id="ndp-tools-tab-builtin"')
    expect(html).toContain('aria-controls="ndp-tools-tabpanel"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-labelledby="ndp-tools-tab-builtin"')
  })

  it('associates Live2D model and appearance controls with their labels', () => {
    const html = renderToStaticMarkup(createElement(Live2DSettingsTab, {
      api,
      petScale: 1,
      petOpacity: 1,
      live2dModelId: '',
      live2dMouseTrackingEnabled: true,
      live2dIdleSwayEnabled: true,
      availableModels: [],
      selectedModelInfo: null,
      isLoadingModels: false,
      refreshModels: async () => {},
    }))

    expect(html).toContain('<label for="ndp-live2d-model">选择模型</label>')
    expect(html).toContain('id="ndp-live2d-model"')
    expect(html).toContain('<label for="ndp-live2d-scale">模型大小</label>')
    expect(html).toContain('id="ndp-live2d-scale"')
    expect(html).toContain('<label for="ndp-live2d-opacity">模型透明度</label>')
    expect(html).toContain('id="ndp-live2d-opacity"')
  })

  it('associates bubble position, timing, and phrase controls with their labels', () => {
    const html = renderToStaticMarkup(createElement(BubbleSettingsTab, { api, bubbleSettings: undefined }))

    expect(html).toContain('<label for="ndp-bubble-position-x">水平位置 (X)</label>')
    expect(html).toContain('id="ndp-bubble-position-x"')
    expect(html).toContain('<label for="ndp-bubble-position-y">垂直位置 (Y)</label>')
    expect(html).toContain('id="ndp-bubble-position-y"')
    expect(html).toContain('<label for="ndp-bubble-auto-hide-delay">自动隐藏延迟</label>')
    expect(html).toContain('id="ndp-bubble-auto-hide-delay"')
    expect(html).toContain('<label for="ndp-bubble-click-phrases">点击台词</label>')
    expect(html).toContain('id="ndp-bubble-click-phrases"')
  })

  it('associates task panel position controls with their labels', () => {
    const html = renderToStaticMarkup(createElement(TaskPanelSettingsTab, { api, taskPanelSettings: undefined }))

    expect(html).toContain('<label for="ndp-task-panel-position-x">水平位置 (X)</label>')
    expect(html).toContain('id="ndp-task-panel-position-x"')
    expect(html).toContain('<label for="ndp-task-panel-position-y">垂直位置 (Y)</label>')
    expect(html).toContain('id="ndp-task-panel-position-y"')
  })

  it('names NovelAI prompt and generation controls', () => {
    const html = renderToStaticMarkup(createElement(NovelAISettingsTab, { api, settings: undefined }))

    expect(html).toContain('<label for="ndp-novelai-endpoint">Endpoint</label>')
    expect(html).toContain('id="ndp-novelai-endpoint"')
    expect(html).toContain('<label for="ndp-novelai-prompt-preset">提示词预设</label>')
    expect(html).toContain('id="ndp-novelai-prompt-preset"')
    expect(html).toContain('aria-label="预设名称"')
    expect(html).toContain('id="ndp-novelai-fixed-positive-prompt"')
    expect(html).toContain('id="ndp-novelai-fixed-negative-prompt"')
    expect(html).toContain('id="ndp-novelai-prompt-rules"')
    expect(html).toContain('id="ndp-novelai-max-prompt-chars"')
    expect(html).toContain('id="ndp-novelai-model"')
    expect(html).toContain('id="ndp-novelai-sampler"')
    expect(html).toContain('id="ndp-novelai-noise-schedule"')
    expect(html).toContain('aria-label="图片宽度"')
    expect(html).toContain('aria-label="图片高度"')
    expect(html).toContain('id="ndp-novelai-steps"')
    expect(html).toContain('id="ndp-novelai-guidance"')
    expect(html).toContain('id="ndp-novelai-guidance-rescale"')
    expect(html).toContain('aria-label="生成张数"')
    expect(html).toContain('aria-label="随机种子"')
    expect(html).toContain('id="ndp-novelai-output-dir"')
  })

  it('distinguishes chat RGBA sliders and numeric inputs', () => {
    const html = renderToStaticMarkup(createElement(ChatUiSettingsTab, { api, chatUi: undefined }))
    const groups = ['聊天背景', '用户气泡', '助手气泡']
    const channels = ['红色', '绿色', '蓝色', '透明度']

    for (const group of groups) {
      for (const channel of channels) {
        expect(html).toContain(`aria-label="${group}${channel}滑块"`)
        expect(html).toContain(`aria-label="${group}${channel}数值"`)
      }
    }
    expect(html).toContain('aria-label="背景图片透明度"')
    expect(html).toContain('<label for="ndp-chat-ui-bubble-radius">气泡圆角</label>')
    expect(html).toContain('id="ndp-chat-ui-bubble-radius"')
  })

  it('parses supported MCP import formats and rejects empty server sets', () => {
    expect(parseMcpImportText('{"mcpServers":{"exa":{"command":"npx","args":["-y","exa"]}}}')).toEqual({
      servers: [{
        id: 'exa',
        enabled: true,
        label: 'exa',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'exa'],
        cwd: '',
        env: {},
      }],
    })
    expect(parseMcpImportText('[{"id":"local","enabled":false,"command":"node"}]').servers[0]).toMatchObject({
      id: 'local',
      enabled: false,
      command: 'node',
    })
    expect(() => parseMcpImportText('{"mcpServers":{}}')).toThrow('未解析到任何 MCP Server')
  })

  it('associates ASR field labels with their controls', () => {
    const html = renderToStaticMarkup(createElement(AsrSettingsTab, { api, asrSettings: undefined }))

    expect(html).toContain('<label for="ndp-asr-ws-url">WebSocket 地址</label>')
    expect(html).toContain('id="ndp-asr-ws-url"')
    expect(html).toContain('<label for="ndp-asr-capture-backend">采集方式</label>')
    expect(html).toContain('id="ndp-asr-capture-backend"')
    expect(html).toContain('<label for="ndp-asr-mic-device">选择麦克风</label>')
    expect(html).toContain('id="ndp-asr-mic-device"')
    expect(html).toContain('aria-busy="false"')
    expect(html).toContain('<label for="ndp-asr-replace-rules">热词替换规则（逐行）</label>')
    expect(html).toContain('id="ndp-asr-replace-rules"')
    expect(html).toContain('<label for="ndp-asr-filler-words">语气词列表（逗号/换行分隔）</label>')
    expect(html).toContain('id="ndp-asr-filler-words"')
  })

  it('names TTS fields and paired pause controls', () => {
    const html = renderToStaticMarkup(createElement(TtsSettingsTab, { api, ttsSettings: undefined }))

    expect(html).toContain('<label for="ndp-tts-root">GPT-SoVITS 安装目录（绝对路径）</label>')
    expect(html).toContain('id="ndp-tts-root"')
    expect(html).toContain('aria-invalid="false"')
    expect(html).toContain('<label for="ndp-tts-gpt-model">GPT 模型</label>')
    expect(html).toContain('id="ndp-tts-gpt-model"')
    expect(html).toContain('<label for="ndp-tts-sovits-model">SoVITS 模型</label>')
    expect(html).toContain('id="ndp-tts-sovits-model"')
    expect(html).toContain('<label for="ndp-tts-speed">语速</label>')
    expect(html).toContain('id="ndp-tts-speed"')
    expect(html).toContain('<label for="ndp-tts-ref-audio">参考音频</label>')
    expect(html).toContain('id="ndp-tts-ref-audio"')
    expect(html).toContain('<label for="ndp-tts-prompt-text">参考音频文本（自动从文件名解析，可编辑）</label>')
    expect(html).toContain('id="ndp-tts-prompt-text"')
    expect(html).toContain('<label for="ndp-tts-playback-text-mode">TTS 播放文本</label>')
    expect(html).toContain('id="ndp-tts-playback-text-mode"')
    expect(html).toContain('aria-label="分句停顿滑块"')
    expect(html).toContain('aria-label="分句停顿毫秒"')
  })

  it('names the AI model-list controls without marking joint errors as field validity', () => {
    const connectionHtml = renderToStaticMarkup(createElement(AISettingsTab, {
      api,
      aiSettings: undefined,
      orchestrator: undefined,
      aiProfiles: undefined,
      activeAiProfileId: undefined,
      view: 'connection',
    }))
    const generationHtml = renderToStaticMarkup(createElement(AISettingsTab, {
      api,
      aiSettings: undefined,
      orchestrator: undefined,
      aiProfiles: undefined,
      activeAiProfileId: undefined,
      view: 'generation',
    }))
    const visionHtml = renderToStaticMarkup(createElement(AISettingsTab, {
      api,
      aiSettings: undefined,
      orchestrator: undefined,
      aiProfiles: undefined,
      activeAiProfileId: undefined,
      view: 'vision',
    }))
    const agentHtml = renderToStaticMarkup(createElement(AISettingsTab, {
      api,
      aiSettings: undefined,
      orchestrator: undefined,
      aiProfiles: undefined,
      activeAiProfileId: undefined,
      view: 'agent',
    }))

    expect(connectionHtml).toContain('<label for="ndp-ai-profile">已保存的 API 配置</label>')
    expect(connectionHtml).toContain('id="ndp-ai-profile"')
    expect(connectionHtml).toContain('aria-label="新配置名称"')
    expect(connectionHtml).toContain('<label for="ndp-ai-api-mode">接口格式</label>')
    expect(connectionHtml).toContain('id="ndp-ai-api-mode"')
    expect(connectionHtml).toContain('<label for="ndp-ai-base-url">API Base URL</label>')
    expect(connectionHtml).toContain('<label for="ndp-ai-model">模型名称</label>')
    expect(connectionHtml).toContain('aria-busy="false"')
    expect(connectionHtml).toContain('aria-label="API Key"')
    expect(connectionHtml).toContain('aria-invalid="false"')
    expect(generationHtml).toContain('aria-label="压缩 API 来源"')
    expect(generationHtml).toContain('aria-label="压缩模型名称"')
    expect(generationHtml).toContain('<label for="ndp-ai-thinking-provider">思考提供商</label>')
    expect(generationHtml).toContain('id="ndp-ai-thinking-provider"')
    expect(generationHtml).toContain('for="ndp-ai-thinking-effort"')
    expect(generationHtml).toContain('id="ndp-ai-thinking-effort"')
    expect(generationHtml).toContain('<label for="ndp-ai-temperature">温度 (Temperature)</label>')
    expect(generationHtml).toContain('id="ndp-ai-temperature"')
    expect(generationHtml).toContain('<label for="ndp-ai-max-tokens">最大回复长度</label>')
    expect(generationHtml).toContain('id="ndp-ai-max-tokens"')
    expect(generationHtml).toContain('<label for="ndp-ai-max-context-tokens">最大上下文长度</label>')
    expect(generationHtml).toContain('id="ndp-ai-max-context-tokens"')
    expect(visionHtml).toContain('<label for="ndp-ai-vision-routing-mode">视觉处理方式</label>')
    expect(visionHtml).toContain('id="ndp-ai-vision-routing-mode"')
    expect(visionHtml).toContain('<label for="ndp-ai-vision-capability">当前主模型的视觉能力</label>')
    expect(visionHtml).toContain('id="ndp-ai-vision-capability"')
    expect(visionHtml).toContain('<label for="ndp-ai-vision-profile">外挂视觉 API 配置</label>')
    expect(visionHtml).toContain('id="ndp-ai-vision-profile"')
    expect(visionHtml).toContain('<label for="ndp-ai-vision-model">外挂视觉模型覆盖</label>')
    expect(visionHtml).toContain('id="ndp-ai-vision-model"')
    expect(visionHtml).toContain('for="ndp-ai-vision-max-images"')
    expect(visionHtml).toContain('id="ndp-ai-vision-max-images"')
    expect(agentHtml).toContain('<label for="ndp-ai-tool-mode">工具执行模式</label>')
    expect(agentHtml).toContain('id="ndp-ai-tool-mode"')
    expect(agentHtml).toContain('<label for="ndp-ai-agent-max-turns">Agent 最大回合数 (maxTurns)</label>')
    expect(agentHtml).toContain('id="ndp-ai-agent-max-turns"')
    expect(agentHtml).toContain('<label for="ndp-ai-skill-managed-dir">托管 Skill 目录（可选）</label>')
    expect(agentHtml).toContain('id="ndp-ai-skill-managed-dir"')
    expect(agentHtml).toContain('<label for="ndp-ai-system-prompt">系统提示词</label>')
    expect(agentHtml).toContain('id="ndp-ai-system-prompt"')
  })
})
