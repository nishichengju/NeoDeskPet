import { getSettings } from '../store'
import { executeBuiltinTool, type ToolExecutionContext, type ToolInput } from '../toolExecutor'
import { isToolEnabled } from '../toolRegistry'
import type { McpManager } from '../mcpManager'
import type { TaskRecord } from '../types'
import type { TaskToolMediaStore } from './taskToolMedia'

export type TaskToolExecutionResult = {
  output: string
  imagePaths: string[]
}

export type TaskToolExecutionRuntime = {
  waitIfPaused: () => Promise<void>
  isCanceled: () => boolean
  setCancelCurrent: (cancel: (() => void) | undefined) => void
}

export type TaskMmvectorVideoQaRunner = (
  input: ToolInput,
  task: TaskRecord,
  runtime: TaskToolExecutionRuntime,
  executeChildTool: (toolName: string, input: ToolInput) => Promise<TaskToolExecutionResult>,
) => Promise<string>

type McpToolClient = Pick<McpManager, 'callToolDetailed'>

export type TaskToolExecutionAdapterOptions = {
  userDataDir: string
  mediaStore: Pick<TaskToolMediaStore, 'resolveImagePaths'>
  mcpManager?: McpToolClient | null
  refreshSkillRegistry?: (managedDir?: string) => Promise<void>
  runMmvectorVideoQa?: TaskMmvectorVideoQaRunner
  readSettings?: typeof getSettings
  toolEnabled?: typeof isToolEnabled
  executeBuiltin?: typeof executeBuiltinTool
}

export class TaskToolExecutionAdapter {
  private readonly userDataDir: string
  private readonly mediaStore: TaskToolExecutionAdapterOptions['mediaStore']
  private readonly mcpManager: McpToolClient | null
  private readonly refreshSkillRegistry?: TaskToolExecutionAdapterOptions['refreshSkillRegistry']
  private readonly runMmvectorVideoQa?: TaskMmvectorVideoQaRunner
  private readonly readSettings: typeof getSettings
  private readonly toolEnabled: typeof isToolEnabled
  private readonly executeBuiltin: typeof executeBuiltinTool

  constructor(options: TaskToolExecutionAdapterOptions) {
    this.userDataDir = options.userDataDir
    this.mediaStore = options.mediaStore
    this.mcpManager = options.mcpManager ?? null
    this.refreshSkillRegistry = options.refreshSkillRegistry
    this.runMmvectorVideoQa = options.runMmvectorVideoQa
    this.readSettings = options.readSettings ?? getSettings
    this.toolEnabled = options.toolEnabled ?? isToolEnabled
    this.executeBuiltin = options.executeBuiltin ?? executeBuiltinTool
  }

  async execute(
    toolName: string,
    input: ToolInput,
    task: TaskRecord,
    runtime: TaskToolExecutionRuntime,
  ): Promise<TaskToolExecutionResult> {
    const normalizedName = String(toolName ?? '').trim()
    if (!normalizedName) throw new Error('tool name is required')

    if (normalizedName === 'workflow.mmvector_video_qa') {
      this.assertToolEnabled(normalizedName)
      if (!this.runMmvectorVideoQa) throw new Error('workflow.mmvector_video_qa runner not initialized')
      const output = await this.runMmvectorVideoQa(input, task, runtime, (childName, childInput) =>
        this.executeDirect(childName, childInput, task, runtime),
      )
      return this.resultFromOutput(task.id, output, [])
    }

    return this.executeDirect(normalizedName, input, task, runtime)
  }

  private async executeDirect(
    toolName: string,
    input: ToolInput,
    task: TaskRecord,
    runtime: TaskToolExecutionRuntime,
  ): Promise<TaskToolExecutionResult> {
    const settings = this.assertToolEnabled(toolName)

    if (toolName.startsWith('mcp.')) {
      if (!this.mcpManager) throw new Error('MCP manager not initialized')
      const result = await this.mcpManager.callToolDetailed(toolName, input)
      return this.resultFromOutput(task.id, result.text, result.images)
    }

    const context: ToolExecutionContext = {
      task,
      userDataDir: this.userDataDir,
      waitIfPaused: runtime.waitIfPaused,
      isCanceled: runtime.isCanceled,
      setCancelCurrent: runtime.setCancelCurrent,
    }
    if (this.refreshSkillRegistry) {
      const managedDirRaw =
        typeof settings.orchestrator?.skillManagedDir === 'string' ? settings.orchestrator.skillManagedDir.trim() : ''
      context.refreshSkillRegistry = () => this.refreshSkillRegistry?.(managedDirRaw || undefined) ?? Promise.resolve()
    }

    const output = await this.executeBuiltin(toolName, input, context, { maxStepOutputChars: 5000 })
    return this.resultFromOutput(task.id, output, [])
  }

  private assertToolEnabled(toolName: string): ReturnType<typeof getSettings> {
    const settings = this.readSettings()
    if (!this.toolEnabled(toolName, settings.tools)) throw new Error(`tool disabled: ${toolName}`)
    return settings
  }

  private async resultFromOutput(
    taskId: string,
    output: string,
    images: Array<{ mimeType: string; data: string }>,
  ): Promise<TaskToolExecutionResult> {
    const text = String(output ?? '')
    const imagePaths = await this.mediaStore.resolveImagePaths(taskId, text, images)
    return { output: text, imagePaths }
  }
}
