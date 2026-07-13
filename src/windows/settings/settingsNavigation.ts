import type { SettingsNavigationTarget } from '../../../electron/types'

export type SettingsViewId = SettingsNavigationTarget

export type SettingsNavItem = {
  id: SettingsViewId
  label: string
  summary: string
}

export type SettingsNavGroup = {
  id: string
  label: string
  items: readonly SettingsNavItem[]
}

export type SettingsSearchEntry = {
  id: string
  view: SettingsViewId
  label: string
  path: string
  anchor: string
  keywords: readonly string[]
  personaSubTab?: 'persona' | 'memory' | 'recall' | 'textVector' | 'mmVector' | 'manage'
}

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: 'appearance',
    label: '外观',
    items: [
      { id: 'live2d', label: 'Live2D', summary: '模型、大小、透明度与跟踪' },
      { id: 'bubble', label: '气泡', summary: '对话气泡样式与显示规则' },
      { id: 'taskPanel', label: '任务面板', summary: '桌宠任务面板位置与行为' },
    ],
  },
  {
    id: 'ai',
    label: 'AI 与能力',
    items: [
      { id: 'aiConnection', label: 'API 连接', summary: '接口、密钥、地址与模型' },
      { id: 'aiGeneration', label: '模型与生成', summary: '温度、上下文与思考参数' },
      { id: 'aiVision', label: '视觉', summary: '主模型和外部视觉路由' },
      { id: 'aiAgent', label: 'Agent', summary: '规划器、工具调用与专用模型' },
      { id: 'tools', label: '工具中心', summary: '工具、MCP 与浏览器能力' },
      { id: 'novelai', label: '生图', summary: 'NovelAI 连接与生成参数' },
    ],
  },
  {
    id: 'knowledge',
    label: '角色与知识',
    items: [
      { id: 'persona', label: '角色与长期记忆', summary: '人设、召回、向量与提炼' },
      { id: 'worldBook', label: '设定库', summary: '世界书条目、标签与注入规则' },
    ],
  },
  {
    id: 'voice',
    label: '语音',
    items: [
      { id: 'tts', label: '语音合成', summary: 'TTS 服务与播放方式' },
      { id: 'asr', label: '语音识别', summary: '麦克风、热键与识别规则' },
    ],
  },
  {
    id: 'application',
    label: '应用',
    items: [{ id: 'chat', label: '聊天界面', summary: '背景、气泡、头像与上下文显示' }],
  },
]

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  { id: 'live2d-model', view: 'live2d', label: 'Live2D 模型', path: '外观 / Live2D', anchor: '选择模型', keywords: ['桌宠', '模型文件', '皮肤'] },
  { id: 'pet-size', view: 'live2d', label: '桌宠大小', path: '外观 / Live2D', anchor: '模型大小', keywords: ['缩放', '尺寸', 'scale'] },
  { id: 'pet-opacity', view: 'live2d', label: '桌宠透明度', path: '外观 / Live2D', anchor: '透明度', keywords: ['opacity'] },
  { id: 'bubble-style', view: 'bubble', label: '气泡样式', path: '外观 / 气泡', anchor: '气泡样式', keywords: ['对话框', '台词', '文字'] },
  { id: 'task-panel', view: 'taskPanel', label: '任务面板', path: '外观 / 任务面板', anchor: '任务面板', keywords: ['悬浮', '任务列表'] },
  { id: 'api-key', view: 'aiConnection', label: 'API Key', path: 'AI 与能力 / API 连接', anchor: 'API Key', keywords: ['密钥', 'token', '秘钥', 'sk'] },
  { id: 'api-base-url', view: 'aiConnection', label: 'API Base URL', path: 'AI 与能力 / API 连接', anchor: 'API Base URL', keywords: ['接口地址', 'endpoint', '网关', '代理'] },
  { id: 'api-model', view: 'aiConnection', label: '模型名称', path: 'AI 与能力 / API 连接', anchor: '模型名称', keywords: ['model', '模型 id'] },
  { id: 'api-profile', view: 'aiConnection', label: '已保存的 API 配置', path: 'AI 与能力 / API 连接', anchor: '已保存的 API 配置', keywords: ['profile', '预设', '切换接口'] },
  { id: 'temperature', view: 'aiGeneration', label: '温度', path: 'AI 与能力 / 模型与生成', anchor: '温度', keywords: ['temperature', '随机性'] },
  { id: 'max-tokens', view: 'aiGeneration', label: '最大输出 Tokens', path: 'AI 与能力 / 模型与生成', anchor: '最大输出 Tokens', keywords: ['max tokens', '输出长度'] },
  { id: 'context', view: 'aiGeneration', label: '上下文长度', path: 'AI 与能力 / 模型与生成', anchor: '上下文', keywords: ['context', '压缩', '窗口'] },
  { id: 'reasoning', view: 'aiGeneration', label: '思考强度', path: 'AI 与能力 / 模型与生成', anchor: '思考强度', keywords: ['推理', 'reasoning', 'thinking'] },
  { id: 'streaming', view: 'aiGeneration', label: '聊天流式生成', path: 'AI 与能力 / 模型与生成', anchor: '聊天流式生成', keywords: ['sse', '逐字', '流式'] },
  { id: 'vision-route', view: 'aiVision', label: '视觉处理方式', path: 'AI 与能力 / 视觉', anchor: '视觉处理方式', keywords: ['看图', '图片识别', 'vision'] },
  { id: 'vision-profile', view: 'aiVision', label: '外部视觉 API 配置', path: 'AI 与能力 / 视觉', anchor: '外部视觉 API 配置', keywords: ['视觉模型', 'fallback', '备用模型'] },
  { id: 'agent-mode', view: 'aiAgent', label: '工具调用模式', path: 'AI 与能力 / Agent', anchor: '工具调用模式', keywords: ['agent', 'function calling', '规划器'] },
  { id: 'tool-key', view: 'aiAgent', label: '工具 API Key', path: 'AI 与能力 / Agent', anchor: '工具 API Key', keywords: ['agent 密钥', '工具模型'] },
  { id: 'mcp', view: 'tools', label: 'MCP 服务', path: 'AI 与能力 / 工具中心', anchor: 'MCP', keywords: ['model context protocol', '外部工具', '服务器'] },
  { id: 'novelai-key', view: 'novelai', label: 'NovelAI API Key', path: 'AI 与能力 / 生图', anchor: 'API Key', keywords: ['绘图', '生图密钥', 'nai'] },
  { id: 'persona', view: 'persona', label: '角色人设', path: '角色与知识 / 角色与长期记忆', anchor: '角色', keywords: ['人物', 'persona', '系统提示词'], personaSubTab: 'persona' },
  { id: 'memory-recall', view: 'persona', label: '长期记忆召回', path: '角色与知识 / 角色与长期记忆', anchor: '召回增强', keywords: ['记忆检索', '召回', 'reranker'], personaSubTab: 'recall' },
  { id: 'memory-vector', view: 'persona', label: '文本向量召回', path: '角色与知识 / 角色与长期记忆', anchor: '文本向量召回', keywords: ['向量', 'embedding', '嵌入模型'], personaSubTab: 'textVector' },
  { id: 'memory-extract', view: 'persona', label: '自动提炼', path: '角色与知识 / 角色与长期记忆', anchor: '自动提炼', keywords: ['总结记忆', '抽取'], personaSubTab: 'memory' },
  { id: 'world-book', view: 'worldBook', label: '设定库', path: '角色与知识 / 设定库', anchor: '设定库', keywords: ['世界书', '知识库', 'world book'] },
  { id: 'tts', view: 'tts', label: 'TTS 语音合成', path: '语音 / 语音合成', anchor: 'TTS 语音', keywords: ['朗读', '发声', '语音播放'] },
  { id: 'asr', view: 'asr', label: 'ASR 语音识别', path: '语音 / 语音识别', anchor: '语音识别', keywords: ['麦克风', '录音', 'speech to text'] },
  { id: 'asr-hotkey', view: 'asr', label: '语音识别热键', path: '语音 / 语音识别', anchor: '启动方式', keywords: ['快捷键', '按键说话'] },
  { id: 'chat-background', view: 'chat', label: '聊天背景', path: '应用 / 聊天界面', anchor: '聊天界面美化', keywords: ['背景图', 'background', '透明度'] },
  { id: 'chat-avatar', view: 'chat', label: '聊天头像', path: '应用 / 聊天界面', anchor: '头像', keywords: ['用户头像', '助手头像'] },
]

function normalizedSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function searchSettings(query: string, limit = 8): SettingsSearchEntry[] {
  const normalized = normalizedSearchText(query)
  if (!normalized) return []
  const terms = normalized.split(' ')

  return SETTINGS_SEARCH_ENTRIES.map((entry) => {
    const label = normalizedSearchText(entry.label)
    const path = normalizedSearchText(entry.path)
    const keywords = entry.keywords.map(normalizedSearchText)
    const haystack = [label, path, ...keywords]
    if (!terms.every((term) => haystack.some((value) => value.includes(term)))) return null
    const score = terms.reduce((total, term) => {
      if (label === term) return total + 100
      if (label.startsWith(term)) return total + 40
      if (label.includes(term)) return total + 20
      if (keywords.some((value) => value === term)) return total + 15
      return total + 5
    }, 0)
    return { entry, score }
  })
    .filter((item): item is { entry: SettingsSearchEntry; score: number } => item != null)
    .sort((left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label, 'zh-CN'))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry)
}
