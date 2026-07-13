import { randomUUID } from 'node:crypto'
import type { ToolInput } from '../toolExecutor'
import { makeToolCallKey, stableStringify, type TaskAgentToolCatalog } from './taskAgentTools'
import type { ToolCall } from './taskAgentLlmProtocol'

export type TaskAgentToolExecution = {
  output: string
  modelOutput?: string
  imagePaths: string[]
  visionParts?: Array<Record<string, unknown>>
}

export type TaskAgentToolExecutionContext = {
  runId: string
  requestedName: string
  recordName: string
  source: 'native' | 'text'
}

export type TaskAgentToolRunPatch = {
  id: string
  toolName: string
  status: 'running' | 'done' | 'error'
  inputPreview?: string
  outputPreview?: string
  imagePaths?: string[]
  error?: string
  startedAt?: number
  endedAt?: number
}

export type TaskAgentToolCallResult = {
  runId: string
  requestedName: string
  toolName: string | null
  input: ToolInput
  output: string
  modelOutput: string
  toolMessage: string
  imagePaths: string[]
  visionParts: Array<Record<string, unknown>>
  unknown: boolean
}

export type TaskAgentExecutedCall = {
  toolName: string
  input: ToolInput
  output: string
}

export type TaskAgentToolSessionOptions = {
  catalog: TaskAgentToolCatalog
  executeTool: (
    toolName: string,
    input: ToolInput,
    context: TaskAgentToolExecutionContext,
  ) => Promise<TaskAgentToolExecution>
  recordToolUsed: (toolName: string) => void
  upsertToolRun: (patch: TaskAgentToolRunPatch) => void
  pushLog: (line: string, force?: boolean) => void
  inputPreview: (toolName: string, input: ToolInput) => string
  now?: () => number
  createId?: () => string
}

type PreparedToolCall = {
  runId: string
  requestedName: string
  resolvedName: string | null
  recordName: string
  input: ToolInput
  inputLog: string
  source: 'native' | 'text'
  normalizeLog?: string
  resolutionError?: string
  cacheLookupNames: string[]
  successCacheNames: string[]
  errorCacheNames: string[]
  recordUsedBeforeCache: boolean
}

export class TaskAgentToolSession {
  private readonly catalog: TaskAgentToolCatalog
  private readonly executeTool: TaskAgentToolSessionOptions['executeTool']
  private readonly recordToolUsed: TaskAgentToolSessionOptions['recordToolUsed']
  private readonly upsertToolRun: TaskAgentToolSessionOptions['upsertToolRun']
  private readonly pushLog: TaskAgentToolSessionOptions['pushLog']
  private readonly inputPreview: TaskAgentToolSessionOptions['inputPreview']
  private readonly now: () => number
  private readonly createId: () => string
  private readonly executedCalls = new Map<string, TaskAgentToolExecution>()
  private readonly executedCallOrder: TaskAgentExecutedCall[] = []

  constructor(options: TaskAgentToolSessionOptions) {
    this.catalog = options.catalog
    this.executeTool = options.executeTool
    this.recordToolUsed = options.recordToolUsed
    this.upsertToolRun = options.upsertToolRun
    this.pushLog = options.pushLog
    this.inputPreview = options.inputPreview
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async executeNative(call: ToolCall): Promise<TaskAgentToolCallResult> {
    const requestedName = String(call.function.name ?? '').trim()
    const definition = this.catalog.resolveCallName(requestedName)
    if (!definition) {
      const errorText = `未知工具：${requestedName}`
      this.pushLog(`[Tool] ${errorText}`)
      return {
        runId: call.id,
        requestedName,
        toolName: null,
        input: {},
        output: errorText,
        modelOutput: errorText,
        toolMessage: errorText,
        imagePaths: [],
        visionParts: [],
        unknown: true,
      }
    }

    const input = parseNativeToolInput(call.function.arguments)
    return this.executePrepared({
      runId: call.id,
      requestedName,
      resolvedName: definition.name,
      recordName: definition.name,
      input,
      inputLog: String(call.function.arguments ?? ''),
      source: 'native',
      cacheLookupNames: [definition.name],
      successCacheNames: [definition.name],
      errorCacheNames: [definition.name],
      recordUsedBeforeCache: true,
    })
  }

  async executeText(toolNameRaw: string, input: ToolInput): Promise<TaskAgentToolCallResult> {
    const requestedName = String(toolNameRaw ?? '').trim()
    const resolved = this.catalog.resolveTextName(requestedName)
    const definition = resolved.def
    const resolvedName = definition?.name ?? null
    const normalizeLog =
      definition && (resolved.requestedName !== definition.name || resolved.aliasApplied)
        ? `[Tool] normalize${resolved.aliasApplied ? ' alias' : ''}: ${resolved.requestedName || requestedName} -> ${definition.name}`
        : undefined
    const resolutionError = definition
      ? undefined
      : buildUnknownTextToolError(requestedName, resolved.cleanedName, this.catalog.suggestNames(resolved.cleanedName || requestedName))
    const cacheNames = uniqueNames([requestedName, resolvedName])

    return this.executePrepared({
      runId: this.createId(),
      requestedName,
      resolvedName,
      recordName: requestedName,
      input,
      inputLog: JSON.stringify(input ?? {}),
      source: 'text',
      normalizeLog,
      resolutionError,
      cacheLookupNames: cacheNames,
      successCacheNames: cacheNames,
      errorCacheNames: [requestedName],
      recordUsedBeforeCache: false,
    })
  }

  buildEvidenceText(request: string): string {
    const parts: string[] = []
    if (request.trim()) parts.push(request.trim())
    for (const call of this.executedCallOrder) {
      if (call.output.trim()) parts.push(call.output)
    }
    return parts.join('\n\n')
  }

  listExecutedCallOrder(): TaskAgentExecutedCall[] {
    return this.executedCallOrder.map((call) => ({ ...call }))
  }

  private async executePrepared(call: PreparedToolCall): Promise<TaskAgentToolCallResult> {
    this.pushLog(`[Tool] ${call.recordName} input: ${previewText(call.inputLog, 240)}`)
    this.upsertToolRun({
      id: call.runId,
      toolName: call.recordName,
      status: 'running',
      inputPreview: this.inputPreview(call.recordName, call.input),
      startedAt: this.now(),
    })
    if (call.normalizeLog) this.pushLog(call.normalizeLog, true)

    if (call.recordUsedBeforeCache && call.resolvedName) this.recordToolUsed(call.resolvedName)

    let execution = this.findCached(call.cacheLookupNames, call.input)
    let errorMessage = ''
    if (execution) {
      this.pushLog(`[Tool] ${call.resolvedName ?? call.recordName} skip duplicate`, true)
    } else if (call.resolutionError) {
      errorMessage = call.resolutionError
      execution = errorExecution(errorMessage)
    } else if (call.resolvedName) {
      if (!call.recordUsedBeforeCache) this.recordToolUsed(call.resolvedName)
      try {
        execution = await this.executeTool(call.resolvedName, call.input, {
          runId: call.runId,
          requestedName: call.requestedName,
          recordName: call.recordName,
          source: call.source,
        })
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
        execution = errorExecution(errorMessage)
      }
      this.cacheExecution(errorMessage ? call.errorCacheNames : call.successCacheNames, call.input, execution)
    } else {
      errorMessage = `未知工具：${call.requestedName}`
      execution = errorExecution(errorMessage)
      this.cacheExecution(call.errorCacheNames, call.input, execution)
    }

    if (call.resolutionError) this.cacheExecution(call.errorCacheNames, call.input, execution)
    if (errorMessage) {
      this.upsertToolRun({
        id: call.runId,
        toolName: call.recordName,
        status: 'error',
        error: previewText(errorMessage, 800),
        outputPreview: previewText(execution.output, 800),
        imagePaths: [],
        endedAt: this.now(),
      })
    }

    const modelOutput = execution.modelOutput ?? execution.output
    this.recordExecution(call.recordName, call.input, modelOutput)
    const toolMessage = previewText(modelOutput, 4000) || '(空)'
    const imagePaths = Array.isArray(execution.imagePaths) ? execution.imagePaths : []
    const failed = Boolean(errorMessage) || execution.output.startsWith('[error]')
    this.pushLog(`[Tool] ${call.recordName} done`)
    this.upsertToolRun({
      id: call.runId,
      toolName: call.recordName,
      status: failed ? 'error' : 'done',
      outputPreview: previewText(execution.output, 800),
      imagePaths,
      endedAt: this.now(),
    })

    return {
      runId: call.runId,
      requestedName: call.requestedName,
      toolName: call.resolvedName,
      input: call.input,
      output: execution.output,
      modelOutput,
      toolMessage,
      imagePaths,
      visionParts: execution.visionParts ?? [],
      unknown: Boolean(call.resolutionError),
    }
  }

  private findCached(names: string[], input: ToolInput): TaskAgentToolExecution | null {
    for (const name of names) {
      const cached = this.executedCalls.get(makeToolCallKey(name, input))
      if (cached) return cached
    }
    return null
  }

  private cacheExecution(names: string[], input: ToolInput, execution: TaskAgentToolExecution): void {
    for (const name of uniqueNames(names)) {
      this.executedCalls.set(makeToolCallKey(name, input), execution)
    }
  }

  private recordExecution(toolName: string, input: ToolInput, output: string): void {
    const exists = this.executedCallOrder.some(
      (entry) => entry.toolName === toolName && stableStringify(entry.input) === stableStringify(input),
    )
    if (!exists) this.executedCallOrder.push({ toolName, input, output })
  }
}

function parseNativeToolInput(rawArguments: string): ToolInput {
  const raw = String(rawArguments ?? '')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as ToolInput
  } catch {
    return raw
  }
}

function buildUnknownTextToolError(requestedName: string, cleanedName: string, suggestions: string[]): string {
  const suffix = suggestions.length ? `；相近可用工具：${suggestions.join('、')}` : ''
  const cleaned = cleanedName && cleanedName !== requestedName ? `（清洗后：${cleanedName}）` : ''
  return `未知工具：${requestedName}${cleaned}${suffix}`
}

function errorExecution(message: string): TaskAgentToolExecution {
  return { output: `[error] ${message}`, imagePaths: [] }
}

function uniqueNames(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean)))
}

function previewText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}
