import type { ToolInput } from '../toolExecutor'
import type { ToolDefinition } from '../toolRegistry'

export const TOOL_REQUEST_START = '<<<[TOOL_REQUEST]>>>'
export const TOOL_REQUEST_END = '<<<[END_TOOL_REQUEST]>>>'
export const TOOL_RESULT_START = '<<<[TOOL_RESULT]>>>'
export const TOOL_RESULT_END = '<<<[END_TOOL_RESULT]>>>'
export const VCP_VALUE_START = '「始」'
export const VCP_VALUE_END = '「末」'

const TOOL_REQUEST_START_RE = /<{2,}\[TOOL_REQUEST\]>{2,}/gi
const TOOL_REQUEST_END_RE = /<{2,}\[END_TOOL_REQUEST\]>{2,}/gi
const TEXT_TOOL_NAME_ALIASES: Record<string, string> = {
  'mcp.fetch.fetch': 'browser.fetch',
  'fetch.fetch': 'browser.fetch',
  'web.fetch': 'browser.fetch',
  'http.fetch': 'browser.fetch',
  'url.fetch': 'browser.fetch',
}

type ToolRequestMarker = { index: number; length: number }

export type ResolvedTextToolName = {
  requestedName: string
  cleanedName: string
  effectiveName: string
  def: ToolDefinition | null
  aliasApplied: boolean
}

export type TextToolRequest = {
  toolName: string
  input: ToolInput
  rawToolName?: string
  cleanedToolName?: string
  aliasApplied?: boolean
}

function findToolRequestMarker(text: string, from: number, kind: 'start' | 'end'): ToolRequestMarker | null {
  const re = kind === 'start' ? TOOL_REQUEST_START_RE : TOOL_REQUEST_END_RE
  re.lastIndex = Math.max(0, from)
  const match = re.exec(text)
  if (!match) return null
  return { index: match.index, length: match[0]?.length ?? 0 }
}

export function hasToolRequestMarker(text: string): boolean {
  return /<{2,}\[TOOL_REQUEST\]>{2,}/i.test(String(text ?? ''))
}

export function findLastCompleteToolRequestEnd(text: string): number {
  const raw = String(text ?? '')
  let cursor = 0
  let lastEnd = -1
  while (cursor < raw.length) {
    const start = findToolRequestMarker(raw, cursor, 'start')
    if (!start) break
    const end = findToolRequestMarker(raw, start.index + start.length, 'end')
    if (!end) break
    lastEnd = end.index + end.length
    cursor = lastEnd
  }
  return lastEnd
}

export function stripToolRequestBlocksForDisplay(text: string): string {
  const raw = String(text ?? '')
  if (!hasToolRequestMarker(raw)) return raw
  let out = ''
  let cursor = 0
  while (cursor < raw.length) {
    const start = findToolRequestMarker(raw, cursor, 'start')
    if (!start) {
      out += raw.slice(cursor)
      break
    }
    out += raw.slice(cursor, start.index)
    const end = findToolRequestMarker(raw, start.index + start.length, 'end')
    if (!end) break
    cursor = end.index + end.length
  }
  return out
}

function unwrapVcpValue(value: unknown): string {
  let out = String(value ?? '').trim()
  if (
    out.startsWith(VCP_VALUE_START) &&
    out.endsWith(VCP_VALUE_END) &&
    out.length >= VCP_VALUE_START.length + VCP_VALUE_END.length
  ) {
    out = out.slice(VCP_VALUE_START.length, out.length - VCP_VALUE_END.length).trim()
  }
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]
  for (const [left, right] of pairs) {
    if (out.startsWith(left) && out.endsWith(right) && out.length >= left.length + right.length) {
      out = out.slice(left.length, out.length - right.length).trim()
      break
    }
  }
  return out
}

function stripToolNameProtocolNoise(value: unknown): string {
  let out = unwrapVcpValue(value)
    .replace(/```[a-zA-Z0-9_-]*|```/g, '')
    .replace(/^tool_name\s*[:：]\s*/i, '')
    .trim()

  out = out.replace(/[「」]/g, '').replace(/^(?:始|末)+/g, '').replace(/(?:始|末)+$/g, '').trim()
  out = out.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim()

  const token = out.match(/[A-Za-z][A-Za-z0-9_.:-]*/)?.[0]
  return (token ?? out).trim()
}

export class TaskAgentToolCatalog {
  private readonly definitions: ToolDefinition[]
  private readonly byName = new Map<string, ToolDefinition>()
  private readonly byCallName = new Map<string, ToolDefinition>()

  constructor(definitions: ToolDefinition[]) {
    this.definitions = [...definitions]
    for (const definition of this.definitions) {
      this.byName.set(definition.name, definition)
      this.byCallName.set(definition.callName, definition)
    }
  }

  resolveCallName(callNameRaw: string): ToolDefinition | null {
    const needle = String(callNameRaw ?? '').trim()
    if (!needle) return null

    const exact = this.byCallName.get(needle) ?? null
    if (exact) return exact

    if (needle.includes(':')) {
      const tail = needle.split(':').pop()?.trim() ?? ''
      if (tail && tail !== needle) return this.byCallName.get(tail) ?? null
    }

    return this.byName.get(needle) ?? null
  }

  resolveTextName(toolNameRaw: string): ResolvedTextToolName {
    const requestedName = String(toolNameRaw ?? '').trim()
    const cleanedName = stripToolNameProtocolNoise(requestedName)

    const direct = this.byName.get(cleanedName) ?? this.resolveCallName(cleanedName)
    if (direct) {
      return { requestedName, cleanedName, effectiveName: direct.name, def: direct, aliasApplied: false }
    }

    const aliasTarget = TEXT_TOOL_NAME_ALIASES[cleanedName] ?? TEXT_TOOL_NAME_ALIASES[cleanedName.toLowerCase()]
    if (aliasTarget) {
      const aliased = this.byName.get(aliasTarget) ?? this.resolveCallName(aliasTarget)
      return { requestedName, cleanedName, effectiveName: aliasTarget, def: aliased, aliasApplied: Boolean(aliased) }
    }

    return { requestedName, cleanedName, effectiveName: cleanedName, def: null, aliasApplied: false }
  }

  suggestNames(toolNameRaw: string): string[] {
    const needle = stripToolNameProtocolNoise(toolNameRaw).toLowerCase()
    if (!needle) return []

    const parts = needle.split(/[.:_-]+/).filter(Boolean)
    const tail = parts.at(-1) ?? needle
    const scored = this.definitions
      .map((definition) => {
        const name = definition.name.toLowerCase()
        const callName = definition.callName.toLowerCase()
        let score = 0
        if (name === needle || callName === needle) score += 100
        if (name.includes(needle) || callName.includes(needle)) score += 30
        if (tail && (name.includes(tail) || callName.includes(tail))) score += 10
        return { name: definition.name, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 5)
      .map((entry) => entry.name)

    return Array.from(new Set(scored))
  }

  parseTextRequests(text: string): { cleaned: string; calls: TextToolRequest[] } {
    const raw = String(text ?? '')
    if (!hasToolRequestMarker(raw)) return { cleaned: raw.trim(), calls: [] }

    const calls: TextToolRequest[] = []
    let cleaned = ''
    let cursor = 0
    while (cursor < raw.length) {
      const start = findToolRequestMarker(raw, cursor, 'start')
      if (!start) {
        cleaned += raw.slice(cursor)
        break
      }
      cleaned += raw.slice(cursor, start.index)
      const end = findToolRequestMarker(raw, start.index + start.length, 'end')
      if (!end) {
        cleaned += raw.slice(start.index)
        break
      }
      const block = raw.slice(start.index + start.length, end.index).trim()
      cursor = end.index + end.length

      const paramRegex = /([\w_]+)\s*[:：]\s*「始」([\s\S]*?)「末」\s*(?:,)?/g
      let match: RegExpExecArray | null
      let toolName = ''
      let inputJson = ''
      const values: Record<string, unknown> = {}
      while ((match = paramRegex.exec(block)) !== null) {
        const key = match[1]
        const value = match[2]?.trim() ?? ''
        if (key === 'tool_name') toolName = value
        else if (key === 'input_json') inputJson = value
        else values[key] = value
      }

      if (!toolName) {
        const fallback = block.match(/tool_name\s*[:：]\s*([^\r\n]+)/i)
        if (fallback?.[1]) toolName = fallback[1]
      }
      if (!inputJson) {
        const fallback = block.match(/input_json\s*[:：]\s*([\s\S]*)$/i)
        if (fallback?.[1]) inputJson = fallback[1]
      }

      const rawToolName = unwrapVcpValue(toolName).trim()
      const resolvedTool = this.resolveTextName(rawToolName)
      toolName = resolvedTool.effectiveName
      inputJson = unwrapVcpValue(inputJson)
      if (!toolName) continue

      let input: ToolInput = {}
      if (inputJson.trim()) {
        try {
          input = JSON.parse(inputJson) as ToolInput
        } catch {
          input = inputJson
        }
      } else {
        input = values as ToolInput
      }

      calls.push({
        toolName,
        rawToolName: resolvedTool.requestedName && resolvedTool.requestedName !== toolName ? resolvedTool.requestedName : undefined,
        cleanedToolName: resolvedTool.cleanedName && resolvedTool.cleanedName !== toolName ? resolvedTool.cleanedName : undefined,
        aliasApplied: resolvedTool.aliasApplied,
        input,
      })
    }

    return { cleaned: cleaned.trim(), calls }
  }

  buildTextModeGuide(novelAiPromptRules?: string): string {
    const lines: string[] = []
    lines.push('重要：工具输出是事实来源。严禁编造/猜测工具执行结果。')
    lines.push('如果工具结果块（TOOL_RESULT）为空、乱码、或与你需要的答案不一致：必须明确说明“工具输出不可用/无法解析”，并优先选择重试（可换更简单/更稳的命令或加 -NoProfile）。')
    lines.push('只有当不需要工具时，才直接给最终回答。')
    lines.push('重要：用户要求截图、识图、搜索/查询最新信息、打开并操作网页、读写/修改文件、运行命令、下载/安装/执行程序时，必须先调用工具；没有工具结果时禁止声称已经做过。')
    lines.push('当你需要调用工具时：不要输出任何自然语言前置话术，直接输出一个或多个工具调用块（TOOL_REQUEST）。')
    lines.push('')
    lines.push('你可以通过下面的兼容工具调用格式来调用工具。')
    lines.push('重要：用户仅说“打开/进入某网站”且不需要后续搜索、点击、截图、提取时，才用 browser.open。browser.open 打开的是系统浏览器，不能继续自动化；只要任务包含搜索、点击、打开结果、截图或读取页面状态，必须使用 browser.playwright/browser.scan/browser.exec_js/browser.screenshot。')
    lines.push('重要：连续操作同一动态网页时，先用 browser.tabs/browser.scan 获取 tabId，后续 browser.scan/browser.exec_js/browser.screenshot 都绑定同一个 tabId；不要为了“当前页提取/截图”重复调用带 url 的 browser.playwright。')
    lines.push('重要：无头浏览器默认不要传 channel，使用与 Playwright 版本匹配的内置 Chromium；只有明确需要用户手动登录/观察时才传 headless=false，并可在 Windows 使用 channel=msedge。')
    lines.push('重要：screen.capture 才是系统桌面/显示器截图；browser.screenshot 只截桌宠内置 Playwright 标签页，不等于用户当前前台屏幕。')
    lines.push('重要：点击或搜索后如果工具结果显示 activePageChanged/newTabs，说明页面已跳转或新标签已打开，不要误判“没反应”；继续使用返回的 tabId/活动页操作。')
    lines.push('重要：单页目标任务完成并确认目标页已打开后，可用 browser.close_tabs 关闭非活动旧标签，避免 persistent profile 下历史标签反复恢复。')
    lines.push('重要：一次性无头网页任务完成且不再需要后续操作时，调用 browser.close 关闭对应 profile 的浏览器进程；浏览器服务也会自动回收长期空闲上下文。')
    lines.push('重要：screen.capture/browser.screenshot/image.generate 产出的图片只会登记为视觉产物，不会自动查看。工具结果会给出安全 artifact ID；确实需要依据画面回答时才调用 vision.look。')
    lines.push('重要：用户只是称赞、闲聊、要求继续或明确说不要看图时，不要调用 vision.look；需要看第几张或比较多张时，仅选择对应 artifactIds 并保持用户指定顺序。')
    lines.push('重要：只有用户明确要求生图/画图/NovelAI 生成图片时，才调用 image.generate；不要后台循环或批量自动生图。')
    const promptRules = String(novelAiPromptRules ?? '').trim()
    if (promptRules) {
      lines.push('NovelAI 文生图规则：')
      lines.push(promptRules.slice(0, 2400))
    }
    lines.push('重要：这里的“当前页”仅指桌宠内置 Playwright profile 的活动标签页，不等于系统浏览器前台页；若返回 about:blank，先用 browser.tabs 确认实际 tabId。')
    lines.push('重要：Windows 下执行带空格/引号/管道的命令时，优先用 cmd+args 形式调用 powershell -NoProfile -Command；运行 .py 必须写 python "脚本.py"，不要用 & "脚本.py" 直接执行；不要用 cmd.exe line 字符串拼接复杂路径。修改 UTF-8 文件时优先用 file.write 或 PowerShell 明确 -Encoding UTF8，不要用 sed 盲替换。')
    lines.push('重要：如果用户点名“用 grok 搜索/查”，先用 skill.read 读取 grok-x-search-skill 并按技能运行脚本；不要先用 browser.fetch/mcp.fetch.fetch 抓搜索引擎页面。')
    lines.push('重要：抓取网页文本用 browser.fetch；不要使用 mcp.fetch.fetch、fetch.fetch 这类其他框架里的工具名。读取技能步骤用 skill.read。')
    lines.push('')
    lines.push('格式（必须严格匹配，不要放在代码块里）：')
    lines.push(TOOL_REQUEST_START)
    lines.push(`tool_name:${VCP_VALUE_START}browser.fetch${VCP_VALUE_END}`)
    lines.push(`input_json:${VCP_VALUE_START}{"url":"https://example.com","stripHtml":true}${VCP_VALUE_END}`)
    lines.push(TOOL_REQUEST_END)
    lines.push('')
    lines.push('工具返回后，你会收到工具结果块（TOOL_RESULT）；然后继续下一步或给出最终答复。')
    lines.push('')
    lines.push('可用工具（tool_name 必须使用下面的内部名，不要编造）：')
    for (const definition of this.definitions) {
      const schema = (() => {
        try {
          const serialized = JSON.stringify(definition.inputSchema)
          return serialized.length > 800 ? serialized.slice(0, 800) + '…' : serialized
        } catch {
          return '{}'
        }
      })()
      lines.push(`- ${definition.name}：${definition.description}`)
      lines.push(`  input_schema: ${schema}`)
    }
    return lines.join('\n')
  }
}

export function stableStringify(value: unknown): string {
  if (value == null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'number' || type === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (type !== 'object') return JSON.stringify(String(value))

  const objectValue = value as Record<string, unknown>
  const keys = Object.keys(objectValue).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`
}

export function makeToolCallKey(toolName: string, input: ToolInput): string {
  return `${toolName}::${stableStringify(input)}`
}

export function buildToolResultBlock(toolName: string, toolMessage: string): string {
  return [
    TOOL_RESULT_START,
    `tool_name:${VCP_VALUE_START}${toolName}${VCP_VALUE_END}`,
    `result:${VCP_VALUE_START}${toolMessage}${VCP_VALUE_END}`,
    TOOL_RESULT_END,
  ].join('\n')
}
