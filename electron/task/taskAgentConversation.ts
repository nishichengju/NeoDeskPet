import { stripToolRequestBlocksForDisplay } from './taskAgentTools'
import type { LlmUsage } from './taskAgentLlmProtocol'

export type TaskAgentConversationSnapshot = {
  draftReply: string
  live2dExpression?: string
  live2dMotion?: string
  usage: LlmUsage
}

export type TaskAgentFinalValidationContext = {
  hasFinishedToolRun: boolean
  evidenceText: string
}

export type TaskAgentFinalDecision =
  | { kind: 'accept'; text: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'sanitize'; text: string; reason: string }

type DraftMode = 'native' | 'text'
type Live2dTagExtracted = { cleanedText: string; expression?: string; motion?: string }

export class TaskAgentConversation {
  private readonly maxTurns: number
  private draftReply = ''
  private live2dExpression: string | undefined
  private live2dMotion: string | undefined
  private readonly usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  constructor(maxTurns: number) {
    this.maxTurns = Math.max(1, Math.trunc(maxTurns))
  }

  beginTurn(mode: DraftMode): (raw: string) => boolean {
    const draftBase = this.draftReply
    return (raw: string) => {
      const display = mode === 'text' ? stripToolRequestBlocksForDisplay(raw) : raw
      const extracted = extractLive2dTags(display)
      let changed = false
      if (extracted.expression) {
        this.live2dExpression = extracted.expression
        changed = true
      }
      if (extracted.motion) {
        this.live2dMotion = extracted.motion
        changed = true
      }
      if (extracted.cleanedText) {
        this.draftReply = draftBase ? `${draftBase}\n${extracted.cleanedText}` : extracted.cleanedText
        changed = true
      }
      return changed
    }
  }

  addUsage(usage: LlmUsage | undefined): void {
    if (!usage) return
    this.usage.promptTokens += usage.promptTokens
    this.usage.completionTokens += usage.completionTokens
    this.usage.totalTokens += usage.totalTokens
  }

  decideFinal(
    candidateText: string,
    turn: number,
    context: TaskAgentFinalValidationContext,
  ): TaskAgentFinalDecision {
    const raw = String(candidateText ?? '').trim()
    const validation = validateFinalText(raw, context)
    if (validation.ok) return { kind: 'accept', text: raw }
    if (turn < this.maxTurns - 1) return { kind: 'retry', reason: validation.reason }
    return {
      kind: 'sanitize',
      text: sanitizeFinalText(candidateText),
      reason: validation.reason,
    }
  }

  finalize(finalText: string): string {
    const extracted = extractLive2dTags(String(finalText ?? '').trim())
    if (extracted.expression) this.live2dExpression = extracted.expression
    if (extracted.motion) this.live2dMotion = extracted.motion
    const output = extracted.cleanedText || this.draftReply || ''
    this.draftReply = output
    return output
  }

  snapshot(): TaskAgentConversationSnapshot {
    return {
      draftReply: this.draftReply,
      live2dExpression: this.live2dExpression,
      live2dMotion: this.live2dMotion,
      usage: { ...this.usage },
    }
  }
}

export function extractLive2dTags(text: string): Live2dTagExtracted {
  const raw = String(text ?? '')
  if (!raw.trim()) return { cleanedText: raw.trim() }

  let expression: string | undefined
  let motion: string | undefined
  let cleaned = raw
  const expressionMatch = cleaned.match(/\[表情[：:]\s*([^\]]+)\]/u)
  if (expressionMatch?.[1]) {
    expression = expressionMatch[1].trim()
    cleaned = cleaned.replace(/\[表情[：:]\s*[^\]]+\]/gu, '')
  }
  const motionMatch = cleaned.match(/\[动作[：:]\s*([^\]]+)\]/u)
  if (motionMatch?.[1]) {
    motion = motionMatch[1].trim()
    cleaned = cleaned.replace(/\[动作[：:]\s*[^\]]+\]/gu, '')
  }

  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanedText: cleaned, expression, motion }
}

function validateFinalText(
  finalText: string,
  context: TaskAgentFinalValidationContext,
): { ok: true } | { ok: false; reason: string } {
  const text = String(finalText ?? '').trim()
  if (!text) return { ok: true }
  if (/\b(?:mcp|cli|browser|file|llm|delay|vision|image)\.[A-Za-z0-9_:\-./]+/.test(text)) {
    return { ok: false, reason: '最终回复包含工具内部名（如 cli.exec/browser.open/mcp.*）' }
  }
  if (!context.hasFinishedToolRun && finalTextClaimsToolAction(text)) {
    return { ok: false, reason: '最终回复声称已调用/执行工具，但本轮没有任何工具执行记录' }
  }

  const urls = extractUrls(text)
  if (urls.length === 0) return { ok: true }
  const missing = urls.filter(
    (url) => !context.evidenceText.includes(url) && !context.evidenceText.includes(`${url}/`),
  )
  return missing.length > 0
    ? { ok: false, reason: `最终回复包含未在工具结果/用户输入出现的 URL：${missing[0]}` }
    : { ok: true }
}

function finalTextClaimsToolAction(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  const negated = /(?:没有|没|未|无法|不能|失败|没能).{0,12}(?:调用|使用|运行|执行|搜索|搜|查询|截图|截屏|打开|点击|读取|写入|保存|修改|修复|工具)/u.test(raw)
  if (negated) return false
  return /(?:调用了|使用了|运行了|执行了|搜索了|搜到了|查到了|找到了|截图了|截屏了|打开了|点击了|读取了|写入了|保存了|修改了|下载了|安装了|创建了|生成了|修好了|已调用|已搜索|已截图|已打开|已读取|已写入|已修改|已保存|工具返回|搜索结果|截图已经|已经帮你)/u.test(raw)
}

function extractUrls(text: string): string[] {
  const urls = String(text ?? '').match(/https?:\/\/[^\s<>()]+/g) ?? []
  return urls.map(normalizeUrl).filter(Boolean)
}

function normalizeUrl(raw: string): string {
  const url = String(raw ?? '').trim()
  if (!url) return ''
  return url.replace(/[)\]}>"'’”。，！？,.!?:;]+$/g, '').replace(/\/+$/g, '')
}

function sanitizeFinalText(text: string): string {
  return String(text ?? '')
    .replace(/\b(?:mcp|cli|browser|file|llm|delay|vision|image)\.[A-Za-z0-9_:\-./]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/https?:\/\/[^\s<>()]+/g, '[链接未验证]')
}
