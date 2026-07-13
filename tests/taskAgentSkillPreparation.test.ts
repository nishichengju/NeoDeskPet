import { describe, expect, it, vi } from 'vitest'
import {
  prepareTaskAgentSkills,
  type TaskAgentSkillManager,
} from '../electron/task/taskAgentSkillPreparation'
import type {
  SkillLoadDiagnostics,
  SkillManagerRuntimeOptions,
  SkillMatchResult,
} from '../electron/skillRegistry'

const runtimeOptions: SkillManagerRuntimeOptions = {
  enabled: true,
  managedDir: 'C:\\managed-skills',
  allowModelInvocation: true,
}

function diagnostics(overrides: Partial<SkillLoadDiagnostics> = {}): SkillLoadDiagnostics {
  return {
    enabled: true,
    workspaceDir: 'C:\\workspace',
    managedDir: 'C:\\managed-skills',
    totalSkills: 3,
    modelVisibleSkills: 2,
    totalCommands: 4,
    sourceCounts: { managed: 2, workspace: 1 },
    conflicts: [],
    ...overrides,
  }
}

function noMatch(input = 'request'): SkillMatchResult {
  return {
    match: null,
    trace: {
      rawInput: input,
      mode: input.startsWith('/') ? 'slash-command' : 'not-slash',
      candidates: [],
    },
  }
}

function manager(overrides: Partial<TaskAgentSkillManager> = {}): TaskAgentSkillManager {
  return {
    getDiagnostics: vi.fn().mockResolvedValue(diagnostics()),
    buildSkillsPrompt: vi.fn().mockResolvedValue(''),
    matchWithTrace: vi.fn().mockResolvedValue(noMatch()),
    readSkillContent: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as TaskAgentSkillManager
}

describe('Task agent skill preparation', () => {
  it('builds the model prompt, traces an explicit match, and caps loaded skill content', async () => {
    const conflicts = Array.from({ length: 6 }, (_, index) => ({
      type: index % 2 === 0 ? ('skill-name-override' as const) : ('command-rename' as const),
      key: `key-${index}`,
      kept: `kept-${index}`,
      replaced: `replaced-${index}`,
      note: `note-${index}`,
    }))
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      commandName: `search-${index}`,
      skillName: `skill-${index}`,
      source: 'workspace' as const,
      score: 100 - index,
      reasons: ['exact'],
    }))
    const matchResult: SkillMatchResult = {
      match: {
        command: {
          name: 'grok',
          skillName: 'grok-search',
          description: 'Search with Grok',
          source: 'managed',
        },
        args: '  search cats  ',
      },
      trace: {
        rawInput: '/grok search cats',
        mode: 'slash-command',
        query: 'grok',
        candidates,
        selected: candidates[0],
      },
    }
    const skillManager = manager({
      getDiagnostics: vi.fn().mockResolvedValue(diagnostics({ conflicts })),
      buildSkillsPrompt: vi.fn().mockResolvedValue('<available_skills>catalog</available_skills>'),
      matchWithTrace: vi.fn().mockResolvedValue(matchResult),
      readSkillContent: vi.fn().mockResolvedValue({
        skill: {
          name: 'grok-search',
          description: 'Search with Grok',
          filePath: 'C:\\managed-skills\\grok-search\\SKILL.md',
          baseDir: 'C:\\managed-skills\\grok-search',
          source: 'managed',
          disableModelInvocation: false,
        },
        content: 'x'.repeat(24_010),
      }),
    })

    const result = await prepareTaskAgentSkills({
      manager: skillManager,
      request: '/grok search cats',
      runtimeOptions,
      allowModelInvocation: false,
      verboseLogging: true,
    })

    expect(result.effectiveRequest).toBe('search cats')
    expect(result.systemMessages).toHaveLength(3)
    expect(result.systemMessages[0].content).toContain('## Skills（技能）')
    expect(result.systemMessages[0].content).toContain('<available_skills>catalog</available_skills>')
    expect(result.systemMessages[1].content).toContain('本轮请求已显式指定技能：grok-search')
    const skillBodyMessage = String(result.systemMessages[2].content)
    expect(skillBodyMessage).toContain('来源：C:\\managed-skills\\grok-search\\SKILL.md')
    expect(skillBodyMessage.endsWith('…')).toBe(true)
    expect(skillBodyMessage.split('\n\n')[1]).toHaveLength(24_001)
    expect(result.logs).toContain(
      '[Skill] loaded: total=3, visible=2, commands=4, source(managed/workspace)=2/1',
    )
    expect(result.logs).toContain('[Skill] model auto invocation disabled (skip available_skills prompt)')
    expect(result.logs.filter((line) => line.startsWith('[Skill] conflict/'))).toHaveLength(5)
    expect(result.logs).toContain('[Skill] conflicts truncated: +1')
    expect(result.logs).toContain(
      '[Skill] match candidates: skill-0/search-0@100, skill-1/search-1@99, skill-2/search-2@98 ...',
    )
    expect(result.logs).toContain('[Skill] matched: grok-search (/grok)')
  })

  it('keeps a normal request unchanged when no skill matches', async () => {
    const skillManager = manager({
      buildSkillsPrompt: vi.fn().mockResolvedValue('<available_skills />'),
      matchWithTrace: vi.fn().mockResolvedValue(noMatch('plain request')),
    })

    const result = await prepareTaskAgentSkills({
      manager: skillManager,
      request: 'plain request',
      runtimeOptions,
      allowModelInvocation: true,
      verboseLogging: false,
    })

    expect(result.effectiveRequest).toBe('plain request')
    expect(result.systemMessages).toHaveLength(1)
    expect(result.logs).toEqual([])
  })

  it('records a failed explicit skill read and creates a fallback request without arguments', async () => {
    const matchResult: SkillMatchResult = {
      match: {
        command: {
          name: 'broken',
          skillName: 'broken-skill',
          description: 'Broken skill',
          source: 'workspace',
        },
        args: '   ',
      },
      trace: {
        rawInput: '/broken',
        mode: 'slash-command',
        query: 'broken',
        candidates: [],
      },
    }
    const skillManager = manager({
      matchWithTrace: vi.fn().mockResolvedValue(matchResult),
    })

    const result = await prepareTaskAgentSkills({
      manager: skillManager,
      request: '/broken',
      runtimeOptions,
      allowModelInvocation: true,
      verboseLogging: false,
    })

    expect(result.effectiveRequest).toBe('请按已指定技能「broken-skill」完成本次请求。')
    expect(result.logs).toEqual([
      '[Skill] matched: broken-skill (/broken)',
      '[Skill] read failed: broken-skill',
    ])
    expect(result.systemMessages).toEqual([
      {
        role: 'system',
        content:
          '本轮请求已显式指定技能：broken-skill，但系统读取技能文件失败。请根据用户请求继续执行；如需要可尝试用 skill.read 读取技能文件。',
      },
    ])
  })

  it('preserves disabled diagnostics and slash trace logging', async () => {
    const skillManager = manager({
      getDiagnostics: vi.fn().mockResolvedValue(
        diagnostics({
          enabled: false,
          totalSkills: 0,
          modelVisibleSkills: 0,
          totalCommands: 0,
          sourceCounts: { managed: 0, workspace: 0 },
        }),
      ),
      matchWithTrace: vi.fn().mockResolvedValue({
        match: null,
        trace: {
          rawInput: '/missing',
          mode: 'slash-command',
          reason: 'skills-disabled',
          candidates: [],
        },
      }),
    })

    const result = await prepareTaskAgentSkills({
      manager: skillManager,
      request: '/missing',
      runtimeOptions: { enabled: false },
      allowModelInvocation: false,
      verboseLogging: true,
    })

    expect(result.logs).toEqual([
      '[Skill] disabled by settings',
      '[Skill] match trace: mode=slash-command, reason=skills-disabled, query=-, selected=none',
    ])
  })

  it('isolates setup failures and clamps their diagnostic text', async () => {
    const buildSkillsPrompt = vi.fn()
    const skillManager = manager({
      getDiagnostics: vi.fn().mockRejectedValue(new Error(`failure-${'z'.repeat(200)}`)),
      buildSkillsPrompt,
    })

    const result = await prepareTaskAgentSkills({
      manager: skillManager,
      request: 'keep working',
      runtimeOptions,
      allowModelInvocation: true,
      verboseLogging: true,
    })

    expect(result.effectiveRequest).toBe('keep working')
    expect(result.systemMessages).toEqual([])
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]).toMatch(/^\[Skill\] setup skipped: failure-z+/)
    expect(result.logs[0].endsWith('…')).toBe(true)
    expect(result.logs[0].length).toBe('[Skill] setup skipped: '.length + 161)
    expect(buildSkillsPrompt).not.toHaveBeenCalled()
  })
})
