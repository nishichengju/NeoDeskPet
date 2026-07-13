import { readLive2dModelMetadata } from '../live2dModelMetadata'
import { getLive2dCapabilities } from '../live2dToolState'
import type { TaskAgentExecutedCall } from './taskAgentToolSession'
import { buildToolResultBlock } from './taskAgentTools'
import type { TaskAgentVisionSession } from './taskAgentVisionSession'

const LIVE2D_TAG_MAX_LIST = { expressions: 20, motions: 10 }

const TOOL_FACT_SYSTEM_PROMPT =
  '重要：工具输出是事实来源。严禁编造/猜测工具执行结果。若工具输出为空、乱码或无法解析，必须明确说明失败，并优先重试或改用更稳的命令（例如 PowerShell 加 -NoProfile）。browser.open 打开的是系统浏览器，不能后续自动化；凡是需要搜索、点击、打开结果、截图或提取页面状态的网页任务，必须使用可控浏览器工具链。若工具返回新活动页或 newTabs，说明页面已跳转/打开新标签，不要误判没反应；单页任务完成后可清理非活动旧标签。最终回复不要出现工具内部名（如 cli.exec/browser.open/mcp.*）；需要链接/日期等事实时，只能引用工具输出或用户提供。若用户请求截图、搜索、打开并操作、读写文件、运行命令、下载/安装/修改程序等实际行动，必须先调用工具，禁止只用自然语言声称已经完成。'

export type TaskAgentMessage = Record<string, unknown>

export type TaskAgentMessageVisionSession = Pick<
  TaskAgentVisionSession,
  | 'buildCatalogMessage'
  | 'appendInitialSystemMessages'
  | 'hasInitialImageParts'
  | 'buildInitialUserContent'
  | 'appendTextFallbackSystemMessages'
  | 'buildTextFallbackUserContent'
>

export type TaskAgentMessageSessionOptions = {
  system: string
  extraContext: string
  effectiveRequest: string
  historyMessages: TaskAgentMessage[]
  skillSystemMessages: TaskAgentMessage[]
  visionSession: TaskAgentMessageVisionSession
  getLive2dSystemMessages: () => TaskAgentMessage[]
}

export class TaskAgentMessageSession {
  readonly messages: TaskAgentMessage[] = []

  private readonly system: string
  private readonly extraContext: string
  private readonly effectiveRequest: string
  private readonly historyMessages: TaskAgentMessage[]
  private readonly skillSystemMessages: TaskAgentMessage[]
  private readonly visionSession: TaskAgentMessageVisionSession
  private readonly getLive2dSystemMessages: () => TaskAgentMessage[]

  constructor(options: TaskAgentMessageSessionOptions) {
    this.system = options.system
    this.extraContext = options.extraContext
    this.effectiveRequest = options.effectiveRequest
    this.historyMessages = options.historyMessages
    this.skillSystemMessages = options.skillSystemMessages
    this.visionSession = options.visionSession
    this.getLive2dSystemMessages = options.getLive2dSystemMessages
  }

  buildInitialMessages(): TaskAgentMessage[] {
    this.messages.splice(0, this.messages.length)
    this.appendBaseSystemMessages(false)

    const visualCatalogMessage = this.visionSession.buildCatalogMessage()
    if (visualCatalogMessage) this.messages.push(visualCatalogMessage)
    this.visionSession.appendInitialSystemMessages(this.messages)
    this.messages.push(...this.skillSystemMessages)
    this.messages.push(...this.historyMessages)

    const requestText = this.effectiveRequest.trim()
    const lastHistoryMessage = [...this.messages]
      .reverse()
      .find((message) => message.role === 'user' || message.role === 'assistant')
    const lastHistoryUserText =
      lastHistoryMessage?.role === 'user' && typeof lastHistoryMessage.content === 'string'
        ? lastHistoryMessage.content.trim()
        : ''
    const hasSameTailUserRequest = Boolean(requestText) && lastHistoryUserText === requestText

    if (this.visionSession.hasInitialImageParts()) {
      this.messages.push({
        role: 'user',
        content: this.visionSession.buildInitialUserContent(this.effectiveRequest),
      })
    } else if (!hasSameTailUserRequest) {
      this.messages.push({ role: 'user', content: this.effectiveRequest })
    }

    return this.messages
  }

  async rebuildTextFallback(executedCalls: TaskAgentExecutedCall[]): Promise<void> {
    this.messages.splice(0, this.messages.length)
    this.appendBaseSystemMessages(true)
    this.visionSession.appendTextFallbackSystemMessages(this.messages)
    this.messages.push(...this.skillSystemMessages)
    this.messages.push({
      role: 'user',
      content: await this.visionSession.buildTextFallbackUserContent(this.effectiveRequest),
    })

    if (executedCalls.length === 0) return
    this.messages.push({
      role: 'system',
      content:
        '注意：以下工具已执行完成（或已得到错误结果）。除非需要不同参数，否则不要重复调用同名同参工具；请基于 TOOL_RESULT 直接给出最终答复。',
    })
    for (const call of executedCalls) {
      const toolMessage = clampText(call.output, 4_000) || '(空)'
      this.messages.push({
        role: 'user',
        content: buildToolResultBlock(call.toolName, toolMessage),
      })
    }
  }

  private appendBaseSystemMessages(includeEmptySystem: boolean): void {
    if (includeEmptySystem || this.system) {
      this.messages.push({ role: 'system', content: this.system })
    }
    if (this.extraContext) {
      this.messages.push({ role: 'system', content: this.extraContext })
    }
    this.messages.push(...this.getLive2dSystemMessages())
    this.messages.push({ role: 'system', content: TOOL_FACT_SYSTEM_PROMPT })
  }
}

export function buildTaskAgentLive2dSystemMessages(modelFileUrl: string): TaskAgentMessage[] {
  const messages: TaskAgentMessage[] = []
  const tagAddon = buildLive2dTagSystemAddon(readLive2dTagHintsFromModelFile(modelFileUrl))
  if (tagAddon) messages.push({ role: 'system', content: tagAddon })
  const paramAddon = buildLive2dParamSystemAddon(modelFileUrl)
  if (paramAddon) messages.push({ role: 'system', content: paramAddon })
  return messages
}

type Live2dModelTagHints = { expressions: string[]; motions: string[] }

function readLive2dTagHintsFromModelFile(modelFileUrl: string): Live2dModelTagHints {
  const metadata = readLive2dModelMetadata(modelFileUrl)
  return {
    expressions: (metadata?.expressions ?? [])
      .map((expression) => expression.name)
      .filter(Boolean)
      .slice(0, 200),
    motions: (metadata?.motions ?? []).slice(0, 200),
  }
}

function buildLive2dTagSystemAddon(hints: Live2dModelTagHints): string {
  const expressions = (hints.expressions ?? []).slice(0, LIVE2D_TAG_MAX_LIST.expressions)
  const motions = (hints.motions ?? []).slice(0, LIVE2D_TAG_MAX_LIST.motions)
  if (expressions.length === 0 && motions.length === 0) return ''

  const lines: string[] = []
  if (expressions.length) {
    lines.push(
      `【表情系统】可用表情：${expressions.join('、')}\n` +
        '说明：这是“可选标签”，用于在不调用 live2d.applyParamScript 时快速触发表情。' +
        '当你已经用 live2d.applyParamScript 完成表情/动作时，不要再额外追加标签，避免覆盖脚本效果。' +
        '格式：[表情:表情名]（只放在自然语言文本末尾，不要放进工具参数/JSON）。',
    )
  }
  if (motions.length) {
    lines.push(
      `【动作系统】可用动作组：${motions.join('、')}\n` +
        '说明：这是“可选标签”，用于在不调用 live2d.applyParamScript 时快速触发动作。' +
        '当你已经用 live2d.applyParamScript 完成表情/动作时，不要再额外追加标签，避免覆盖脚本效果。' +
        '格式：[动作:动作组名]（只放在自然语言文本末尾，不要放进工具参数/JSON）。',
    )
  }
  return lines.join('\n\n')
}

function buildLive2dParamSystemAddon(modelJsonUrlFallback?: string): string {
  const capabilities = getLive2dCapabilities()
  const modelJsonUrl = String(capabilities?.modelJsonUrl ?? modelJsonUrlFallback ?? '').trim()
  if (!modelJsonUrl) return ''

  const metadata = readLive2dModelMetadata(modelJsonUrl)
  const nameMap = metadata?.parameterDisplayNames ?? {}
  const maxList = 80
  const items = (() => {
    const fromCapabilities = Array.isArray(capabilities?.parameters) ? capabilities.parameters : []
    const mapped = fromCapabilities
      .filter((parameter) => parameter && typeof (parameter as { id?: unknown }).id === 'string')
      .slice(0, 800)
      .map((parameter) => ({
        id: String((parameter as { id: string }).id).trim(),
        min:
          typeof (parameter as { min?: unknown }).min === 'number'
            ? (parameter as { min: number }).min
            : undefined,
        max:
          typeof (parameter as { max?: unknown }).max === 'number'
            ? (parameter as { max: number }).max
            : undefined,
        def:
          typeof (parameter as { def?: unknown }).def === 'number'
            ? (parameter as { def: number }).def
            : undefined,
      }))
      .filter((parameter) => parameter.id.length > 0)
      .sort((left, right) => left.id.localeCompare(right.id))

    const idPool = mapped.length > 0
      ? mapped.map((parameter) => parameter.id)
      : Object.keys(nameMap).filter((key) => key.trim().length > 0)

    const expressionIds = (() => {
      const ids: string[] = []
      for (const expression of metadata?.expressions ?? []) {
        for (const parameter of expression.params ?? []) {
          const id = String(parameter.id ?? '').trim()
          if (id) ids.push(id)
          if (ids.length >= 120) break
        }
        if (ids.length >= 120) break
      }
      return ids
    })()

    const commonIds = [
      'ParamEyeLOpen',
      'ParamEyeROpen',
      'ParamEyeLSmile',
      'ParamEyeRSmile',
      'ParamBrowLAngle',
      'ParamBrowRAngle',
      'ParamCheek',
      'ParamMouthForm',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamBodyAngleX',
      'ParamBodyAngleY',
      'ParamBodyAngleZ',
      'Param13',
    ]

    const pick = (ids: string[]) => ids.map((id) => id.trim()).filter(Boolean)
    const unique = (ids: string[]) => Array.from(new Set(ids))
    const prioritized = unique([...pick(commonIds), ...pick(expressionIds)])
    const rest = unique(pick(idPool))
      .filter((id) => !prioritized.includes(id))
      .sort((left, right) => left.localeCompare(right))
    const finalIds = [...prioritized, ...rest].slice(0, maxList)

    const byId = new Map<string, { min?: number; max?: number; def?: number }>()
    for (const parameter of mapped) {
      byId.set(parameter.id, { min: parameter.min, max: parameter.max, def: parameter.def })
    }

    return finalIds.map((id) => {
      const range = byId.get(id) ?? {}
      return { id, min: range.min, max: range.max, def: range.def }
    })
  })()

  const formatNumber = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const hasParameter = (id: string): boolean =>
    Boolean(items.some((parameter) => parameter.id === id) || typeof nameMap[id] === 'string')

  const lines: string[] = []
  lines.push('【Live2D 参数系统】')
  lines.push('你可以通过工具 live2d.applyParamScript 控制模型参数。')
  lines.push(
    '当前系统提示已包含“当前模型参数清单”，通常不需要每次再调用 live2d.getCapabilities。仅当参数清单为空/明显不匹配当前模型时，再调用 live2d.getCapabilities。',
  )
  lines.push(
    '硬规则：当用户明确要求“眨眼/wink/单眼眨眼”时，你的参数脚本必须包含 ParamEyeLOpen 或 ParamEyeROpen 的变化（否则视为没完成 wink）。',
  )
  lines.push('常见意图提示（优先改这些“语义参数”，不要用 ArtMesh 旋转类参数去硬凑表情）：')
  if (hasParameter('ParamEyeLOpen') || hasParameter('ParamEyeROpen')) {
    lines.push('- 眨眼/单眼 wink：用 ParamEyeLOpen / ParamEyeROpen 把其中一只眼睛从 1 → 0 → 1（另一只保持 1）')
  }
  if (hasParameter('ParamEyeLSmile') || hasParameter('ParamEyeRSmile')) {
    lines.push('- 眯眼/笑眼：用 ParamEyeLSmile / ParamEyeRSmile（可与 EyeOpen 联动）')
  }
  if (hasParameter('Param13') && (nameMap.Param13?.includes('脸红') ?? false)) {
    lines.push('- 脸红：Param13（脸红）')
  }
  if (hasParameter('ParamBodyAngleX') || hasParameter('ParamBodyAngleZ')) {
    lines.push('- 扭扭捏捏/身体摆动：ParamBodyAngleX / ParamBodyAngleZ / ParamAngleX / ParamAngleZ')
  }
  lines.push('脚本格式（推荐）：')
  lines.push('- tween: {op:"tween", to:{ParamId: number}, durationMs:number, ease:"linear|in|out|inOut", holdMs?:number}')
  lines.push('- patch: {op:"patch", to:{ParamId: number}, holdMs?:number}')
  lines.push('- wait: {op:"wait", durationMs:number}')
  lines.push('- sequence: {op:"sequence", steps:[...] }')
  lines.push(
    '- pulse(宏): {op:"pulse", id:"ParamId", down:0, up:1, downMs:100, holdMs:150, upMs:100}（等价于 tween+wait+tween）',
  )
  lines.push('注意：口型/呼吸/鼠标追踪等桌宠内置效果可能会覆盖同名参数，避免被 LLM 控制。')
  lines.push(
    '例如：若用户开启了“鼠标追踪”，可能会持续写入 ParamAngleX/Y、ParamBodyAngleX/Y、ParamEyeBallX/Y 等；此时尽量避免用这些参数做动作，或提示用户先关闭鼠标追踪。',
  )
  const totalCount = Array.isArray(capabilities?.parameters) ? capabilities.parameters.length : 0
  lines.push(`当前模型参数（展示前 ${items.length}/${totalCount || items.length} 个，model=${modelJsonUrl}）：`)
  for (const parameter of items) {
    const display = nameMap[parameter.id]
    const nameSuffix = display ? ` (${display})` : ''
    const suffix = [
      formatNumber(parameter.min) && `min=${formatNumber(parameter.min)}`,
      formatNumber(parameter.max) && `max=${formatNumber(parameter.max)}`,
      formatNumber(parameter.def) && `def=${formatNumber(parameter.def)}`,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`- ${parameter.id}${nameSuffix}${suffix ? ` ${suffix}` : ''}`)
  }

  const expressions = metadata?.expressions ?? []
  if (expressions.length > 0) {
    lines.push('')
    lines.push('【Live2D 表情速查（来自模型 Expressions/*.exp3.json）】')
    lines.push('说明：表情本质上也是一组参数变化；你可以直接用 applyParamScript 复现，不必盲猜 ParamXX。')
    for (const expression of expressions.slice(0, 16)) {
      const parameters = (expression.params ?? []).slice(0, 5).map((parameter) => {
        const displayName = nameMap[parameter.id]
        const displayNameSuffix = displayName ? `(${displayName})` : ''
        const blend = parameter.blend ? parameter.blend : 'Set'
        return `${parameter.id}${displayNameSuffix} ${blend} ${parameter.value}`
      })
      lines.push(`- ${expression.name}${parameters.length ? `: ${parameters.join(', ')}` : ''}`)
    }
  }

  return lines.join('\n')
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}
