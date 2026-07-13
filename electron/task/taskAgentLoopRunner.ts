import { buildToolResultBlock, hasToolRequestMarker, type TaskAgentToolCatalog } from './taskAgentTools'
import type { TaskAgentConversation } from './taskAgentConversation'
import type { TaskAgentLlmClient } from './taskAgentLlmClient'
import { isAbortLikeError, type TaskAgentApiMode } from './taskAgentLlmProtocol'
import type { TaskAgentToolSession } from './taskAgentToolSession'

export type TaskAgentLoopMode = 'auto' | 'native' | 'text'

export type TaskAgentLoopRunnerOptions = {
  apiMode: TaskAgentApiMode
  mode: TaskAgentLoopMode
  maxTurns: number
  messages: Array<Record<string, unknown>>
  textGuide: string
  llmClient: Pick<TaskAgentLlmClient, 'callNative' | 'callText'>
  toolCatalog: Pick<TaskAgentToolCatalog, 'parseTextRequests'>
  toolSession: Pick<TaskAgentToolSession, 'executeNative' | 'executeText'>
  conversation: TaskAgentConversation
  waitIfPaused: () => Promise<void>
  isCanceled: () => boolean
  pushLog: (line: string, force?: boolean) => void
  updateProgress: (force?: boolean) => void
  tryFinalize: (candidateText: string, turn: number) => { done: boolean; text: string }
  finalize: (text: string) => string
  prepareTextFallback: (error: unknown) => Promise<void> | void
}

export class TaskAgentLoopRunner {
  private readonly apiMode: TaskAgentApiMode
  private readonly mode: TaskAgentLoopMode
  private readonly maxTurns: number
  private readonly messages: Array<Record<string, unknown>>
  private readonly textGuide: string
  private readonly llmClient: TaskAgentLoopRunnerOptions['llmClient']
  private readonly toolCatalog: TaskAgentLoopRunnerOptions['toolCatalog']
  private readonly toolSession: TaskAgentLoopRunnerOptions['toolSession']
  private readonly conversation: TaskAgentConversation
  private readonly waitIfPaused: () => Promise<void>
  private readonly isCanceled: () => boolean
  private readonly pushLog: TaskAgentLoopRunnerOptions['pushLog']
  private readonly updateProgress: TaskAgentLoopRunnerOptions['updateProgress']
  private readonly tryFinalize: TaskAgentLoopRunnerOptions['tryFinalize']
  private readonly finalize: TaskAgentLoopRunnerOptions['finalize']
  private readonly prepareTextFallback: TaskAgentLoopRunnerOptions['prepareTextFallback']

  constructor(options: TaskAgentLoopRunnerOptions) {
    this.apiMode = options.apiMode
    this.mode = options.mode
    this.maxTurns = Math.max(1, Math.trunc(options.maxTurns))
    this.messages = options.messages
    this.textGuide = options.textGuide
    this.llmClient = options.llmClient
    this.toolCatalog = options.toolCatalog
    this.toolSession = options.toolSession
    this.conversation = options.conversation
    this.waitIfPaused = options.waitIfPaused
    this.isCanceled = options.isCanceled
    this.pushLog = options.pushLog
    this.updateProgress = options.updateProgress
    this.tryFinalize = options.tryFinalize
    this.finalize = options.finalize
    this.prepareTextFallback = options.prepareTextFallback
  }

  async run(): Promise<string> {
    if (this.apiMode === 'claude') {
      if (this.mode !== 'text') this.pushLog('[Agent] Claude Messages API uses text tool protocol for compatibility', true)
      return this.runText()
    }
    if (this.mode === 'text') return this.runText()
    if (this.mode === 'native') return this.runNative()

    try {
      return await this.runNative()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.isCanceled() || isAbortLikeError(error) || /^cancell?ed$/i.test(message.trim())) throw error
      if (/thought[_ ]?signature/i.test(message)) {
        this.pushLog('[Agent] auto detected native tools incompatibility, fallback to text', true)
      }
      this.pushLog(`[Agent] native tools failed, fallback to text: ${previewText(message, 240)}`, true)
      await this.prepareTextFallback(error)
      return this.runText()
    }
  }

  private async runNative(): Promise<string> {
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      await this.waitForResume()
      this.pushLog(`[Agent] turn ${turn + 1}/${this.maxTurns}`)
      let turnRaw = ''
      const applyTurnDraft = this.conversation.beginTurn('native')
      const { contentText, toolCalls, assistantMsgRaw } = await this.llmClient.callNative({
        onDelta: (delta) => {
          this.throwIfCanceled()
          turnRaw += delta
          if (applyTurnDraft(turnRaw)) this.updateProgress()
        },
      })
      this.messages.push(assistantMsgRaw)
      if (applyTurnDraft(contentText)) this.updateProgress(true)

      if (toolCalls.length === 0) {
        if (hasToolRequestMarker(contentText)) {
          throw new Error('native response used text TOOL_REQUEST protocol without tool_calls')
        }
        this.pushLog('[Agent] done', true)
        const finalResult = this.tryFinalize(contentText, turn)
        if (finalResult.done) return finalResult.text
        continue
      }

      this.pushLog(`[Agent] tool_calls: ${toolCalls.map((call) => call.function.name).join(', ')}`)
      const pendingVisionMessages: Array<Record<string, unknown>> = []
      for (const call of toolCalls) {
        await this.waitForResume()
        const result = await this.toolSession.executeNative(call)
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: result.toolMessage,
        })
        if (result.visionParts.length > 0) {
          pendingVisionMessages.push({
            role: 'user',
            content: [{ type: 'text', text: result.toolMessage }, ...result.visionParts],
          })
        }
      }
      if (pendingVisionMessages.length > 0) this.messages.push(...pendingVisionMessages)
    }

    this.pushLog('[Agent] reach maxTurns, stop', true)
    return this.finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
  }

  private async runText(): Promise<string> {
    const userIndex = this.messages.findIndex((message) => message.role === 'user')
    if (userIndex > 0) this.messages.splice(userIndex, 0, { role: 'system', content: this.textGuide })
    else this.messages.push({ role: 'system', content: this.textGuide })

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      await this.waitForResume()
      this.pushLog(`[Agent] turn ${turn + 1}/${this.maxTurns}`)
      let turnRaw = ''
      const applyTurnDraft = this.conversation.beginTurn('text')
      const { contentText, assistantMsgRaw, usage } = await this.llmClient.callText({
        stopOnToolRequest: true,
        onDelta: (delta) => {
          this.throwIfCanceled()
          turnRaw += delta
          if (applyTurnDraft(turnRaw)) this.updateProgress()
        },
      })
      this.messages.push(assistantMsgRaw)
      this.conversation.addUsage(usage)

      const { cleaned, calls } = this.toolCatalog.parseTextRequests(contentText)
      if (applyTurnDraft(cleaned)) this.updateProgress(true)
      if (calls.length === 0) {
        this.pushLog('[Agent] done', true)
        const finalResult = this.tryFinalize(cleaned, turn)
        if (finalResult.done) return finalResult.text
        continue
      }

      this.pushLog(`[Agent] tool_requests: ${calls.map((call) => call.toolName).join(', ')}`)
      for (const call of calls) {
        await this.waitForResume()
        const result = await this.toolSession.executeText(call.toolName, call.input ?? {})
        const toolResultBlock = buildToolResultBlock(call.toolName, result.toolMessage)
        this.messages.push(
          result.visionParts.length > 0
            ? { role: 'user', content: [{ type: 'text', text: toolResultBlock }, ...result.visionParts] }
            : { role: 'user', content: toolResultBlock },
        )
      }
    }

    this.pushLog('[Agent] reach maxTurns, stop', true)
    return this.finalize('已达到最大回合，停止执行（可能需要你补充信息或换一种说法）。')
  }

  private async waitForResume(): Promise<void> {
    await this.waitIfPaused()
    this.throwIfCanceled()
  }

  private throwIfCanceled(): void {
    if (this.isCanceled()) throw new Error('canceled')
  }
}

function previewText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}
