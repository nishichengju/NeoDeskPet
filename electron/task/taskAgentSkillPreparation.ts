import type {
  SkillManager,
  SkillManagerRuntimeOptions,
} from '../skillRegistry'

export type TaskAgentSkillManager = Pick<
  SkillManager,
  'getDiagnostics' | 'buildSkillsPrompt' | 'matchWithTrace' | 'readSkillContent'
>

export type TaskAgentSkillPreparationOptions = {
  manager: TaskAgentSkillManager
  request: string
  runtimeOptions: SkillManagerRuntimeOptions
  allowModelInvocation: boolean
  verboseLogging: boolean
}

export type TaskAgentSkillPreparation = {
  effectiveRequest: string
  systemMessages: Array<Record<string, unknown>>
  logs: string[]
}

export async function prepareTaskAgentSkills(
  options: TaskAgentSkillPreparationOptions,
): Promise<TaskAgentSkillPreparation> {
  const systemMessages: Array<Record<string, unknown>> = []
  const logs: string[] = []
  let effectiveRequest = options.request

  try {
    const diagnostics = await options.manager.getDiagnostics(options.runtimeOptions)
    if (options.verboseLogging) {
      if (!diagnostics.enabled) {
        logs.push('[Skill] disabled by settings')
      } else {
        logs.push(
          `[Skill] loaded: total=${diagnostics.totalSkills}, visible=${diagnostics.modelVisibleSkills}, commands=${diagnostics.totalCommands}, source(managed/workspace)=${diagnostics.sourceCounts.managed}/${diagnostics.sourceCounts.workspace}`,
        )
        logs.push(`[Skill] managedDir: ${diagnostics.managedDir}`)
        if (!options.allowModelInvocation) {
          logs.push('[Skill] model auto invocation disabled (skip available_skills prompt)')
        }
        if (diagnostics.conflicts.length > 0) {
          logs.push(`[Skill] conflicts: ${diagnostics.conflicts.length}`)
          for (const conflict of diagnostics.conflicts.slice(0, 5)) {
            logs.push(
              `[Skill] conflict/${conflict.type}: key=${conflict.key}, kept=${conflict.kept}${conflict.replaced ? `, replaced=${conflict.replaced}` : ''}${conflict.note ? `, note=${conflict.note}` : ''}`,
            )
          }
          if (diagnostics.conflicts.length > 5) {
            logs.push(`[Skill] conflicts truncated: +${diagnostics.conflicts.length - 5}`)
          }
        }
      }
    }

    const skillsPrompt = await options.manager.buildSkillsPrompt(options.runtimeOptions)
    if (skillsPrompt) {
      systemMessages.push({
        role: 'system',
        content:
          '## Skills（技能）\n' +
          '在回答前先浏览 <available_skills> 的描述；如果某个技能与任务高度匹配，优先使用该技能。\n' +
          '可用辅助工具：skill.list（查看已加载技能）、skill.install（从 Git 仓库安装到托管目录）、skill.refresh（刷新缓存）。\n' +
          '若用户点名某个技能/搜索渠道（例如“用 grok 搜索”），必须先用 skill.read 读取对应技能并按技能步骤执行，不要先改用 browser.fetch/mcp.fetch.fetch 等通用网页抓取。\n' +
          '若需要技能详细步骤，优先使用 skill.read 按技能名读取（更稳、更省上下文）；示例：skill.read {name:"技能名"}。\n' +
          '运行本地命令一律优先使用 cli.exec_stream（start/poll/stop）；对会先输出提示/二维码路径再长时间等待的脚本，必须用流式方式，不要长时间阻塞等待。Windows 运行 .py 脚本必须写 python "脚本.py"，不要用 & "脚本.py" 直接执行。\n' +
          '一次最多先读取 1 个技能，避免无关技能占用上下文。\n' +
          skillsPrompt,
      })
    }

    const trimmedRequest = options.request.trim()
    if (trimmedRequest) {
      const matchResult = await options.manager.matchWithTrace(trimmedRequest, options.runtimeOptions)
      const match = matchResult.match
      if (options.verboseLogging && trimmedRequest.startsWith('/')) {
        const trace = matchResult.trace
        const selectedText = trace.selected
          ? `${trace.selected.skillName} (/${trace.selected.commandName}, score=${trace.selected.score})`
          : 'none'
        logs.push(
          `[Skill] match trace: mode=${trace.mode}, reason=${trace.reason ?? 'n/a'}, query=${trace.query ?? '-'}, selected=${selectedText}`,
        )
        if (trace.candidates.length > 1) {
          const top = trace.candidates
            .slice(0, 3)
            .map((candidate) => `${candidate.skillName}/${candidate.commandName}@${candidate.score}`)
            .join(', ')
          logs.push(`[Skill] match candidates: ${top}${trace.candidates.length > 3 ? ' ...' : ''}`)
        }
      }

      if (match) {
        const skillName = match.command.skillName
        logs.push(`[Skill] matched: ${skillName} (/${match.command.name})`)

        const loaded = await options.manager.readSkillContent(skillName, options.runtimeOptions)
        if (loaded) {
          const skillBody = clampText(loaded.content, 24_000)
          systemMessages.push({
            role: 'system',
            content:
              `本轮请求已显式指定技能：${loaded.skill.name}。\n` +
              '请严格优先遵循该技能步骤；若技能与系统安全/工具事实冲突，以系统规则与工具输出为准。',
          })
          systemMessages.push({
            role: 'system',
            content: `【SKILL: ${loaded.skill.name}】\n来源：${loaded.skill.filePath}\n\n${skillBody}`,
          })
        } else {
          logs.push(`[Skill] read failed: ${skillName}`)
          systemMessages.push({
            role: 'system',
            content:
              `本轮请求已显式指定技能：${skillName}，但系统读取技能文件失败。` +
              '请根据用户请求继续执行；如需要可尝试用 skill.read 读取技能文件。',
          })
        }

        const argsText = (match.args ?? '').trim()
        effectiveRequest = argsText || `请按已指定技能「${skillName}」完成本次请求。`
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logs.push(`[Skill] setup skipped: ${clampText(message, 160)}`)
  }

  return { effectiveRequest, systemMessages, logs }
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}
