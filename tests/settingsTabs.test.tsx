import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getApi } from '../src/neoDeskPetApi'
import { PersonaSettingsTab } from '../src/windows/settings/PersonaTab'
import { AsrSettingsTab } from '../src/windows/settings/AsrTab'
import { AISettingsTab } from '../src/windows/settings/AiTab'
import { getSettingsTabTargetIndex } from '../src/windows/settings/settingsTabs'
import { parseMcpImportText } from '../src/windows/settings/mcpImport'
import { ToolsSettingsTab } from '../src/windows/settings/ToolsTab'
import { TtsSettingsTab } from '../src/windows/settings/TtsTab'

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

  it('associates the ASR microphone label with its device selector', () => {
    const html = renderToStaticMarkup(createElement(AsrSettingsTab, { api, asrSettings: undefined }))

    expect(html).toContain('<label for="ndp-asr-mic-device">选择麦克风</label>')
    expect(html).toContain('id="ndp-asr-mic-device"')
    expect(html).toContain('aria-busy="false"')
  })

  it('associates the TTS installation directory label and initial validity', () => {
    const html = renderToStaticMarkup(createElement(TtsSettingsTab, { api, ttsSettings: undefined }))

    expect(html).toContain('<label for="ndp-tts-root">GPT-SoVITS 安装目录（绝对路径）</label>')
    expect(html).toContain('id="ndp-tts-root"')
    expect(html).toContain('aria-invalid="false"')
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

    expect(connectionHtml).toContain('<label for="ndp-ai-base-url">API Base URL</label>')
    expect(connectionHtml).toContain('<label for="ndp-ai-model">模型名称</label>')
    expect(connectionHtml).toContain('aria-busy="false"')
    expect(connectionHtml).toContain('aria-label="API Key"')
    expect(connectionHtml).toContain('aria-invalid="false"')
    expect(generationHtml).toContain('aria-label="压缩 API 来源"')
    expect(generationHtml).toContain('aria-label="压缩模型名称"')
  })
})
