import fs from 'node:fs/promises'
import path from 'node:path'
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from './skillPrimitives'

export type { Skill }

export type ParsedSkillFrontmatter = Record<string, string>

export type SkillInvocationPolicy = {
  userInvocable: boolean
  disableModelInvocation: boolean
}

export type SkillEntry = {
  skill: Skill
  frontmatter: ParsedSkillFrontmatter
  invocation: SkillInvocationPolicy
}

export type SkillCommandSpec = {
  name: string
  skillName: string
  description: string
  source: Skill['source']
}

export type SkillMatch = {
  command: SkillCommandSpec
  args?: string
}

export type SkillManagerRuntimeOptions = {
  enabled?: boolean
  managedDir?: string
  allowModelInvocation?: boolean
}

export type SkillConflictRecord = {
  type: 'skill-name-override' | 'command-rename'
  key: string
  kept: string
  replaced?: string
  note?: string
}

export type SkillLoadDiagnostics = {
  enabled: boolean
  workspaceDir: string
  managedDir: string
  totalSkills: number
  modelVisibleSkills: number
  totalCommands: number
  sourceCounts: { managed: number; workspace: number }
  conflicts: SkillConflictRecord[]
}

export type SkillMatchTraceCandidate = {
  commandName: string
  skillName: string
  source: Skill['source']
  score: number
  reasons: string[]
}

export type SkillMatchTrace = {
  rawInput: string
  mode: 'not-slash' | 'slash-command' | 'slash-skill'
  query?: string
  args?: string
  reason?: string
  candidates: SkillMatchTraceCandidate[]
  selected?: SkillMatchTraceCandidate
}

export type SkillMatchResult = {
  match: SkillMatch | null
  trace: SkillMatchTrace
}

function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: ParsedSkillFrontmatter = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/)
    if (!kv) continue
    out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  return fallback
}

function resolveInvocationPolicy(frontmatter: ParsedSkillFrontmatter): SkillInvocationPolicy {
  return {
    userInvocable: parseBool(frontmatter['user-invocable'], true),
    disableModelInvocation: parseBool(frontmatter['disable-model-invocation'], false),
  }
}

function compareSkills(a: Skill, b: Skill): number {
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN')
  if (byName !== 0) return byName
  if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1
  return a.filePath.localeCompare(b.filePath)
}

type LoadSkillEntriesResult = {
  entries: SkillEntry[]
  conflicts: SkillConflictRecord[]
}

async function loadSkillEntries(workspaceDir: string, managedDir: string): Promise<LoadSkillEntriesResult> {
  const conflicts: SkillConflictRecord[] = []
  const merged = new Map<string, Skill>()

  const managedSkills = await loadSkillsFromDir({ dir: managedDir, source: 'managed' })
  for (const s of managedSkills) merged.set(s.name, s)

  const workspaceSkillsDir = path.join(workspaceDir, 'skills')
  const workspaceSkills = await loadSkillsFromDir({ dir: workspaceSkillsDir, source: 'workspace' })
  for (const s of workspaceSkills) {
    const prev = merged.get(s.name)
    if (prev && prev.filePath !== s.filePath) {
      conflicts.push({
        type: 'skill-name-override',
        key: s.name,
        kept: `${s.name} (${s.source})`,
        replaced: `${prev.name} (${prev.source})`,
        note: `workspace 覆盖同名 skill：${prev.filePath}`,
      })
    }
    merged.set(s.name, s)
  }

  const mergedSkills = Array.from(merged.values()).sort(compareSkills)
  const out: SkillEntry[] = []
  for (const skill of mergedSkills) {
    let frontmatter: ParsedSkillFrontmatter = {}
    try {
      const raw = await fs.readFile(skill.filePath, 'utf-8')
      frontmatter = parseFrontmatter(raw)
    } catch {
      // 忽略读取失败，保留基础 skill 信息
    }
    out.push({
      skill,
      frontmatter,
      invocation: resolveInvocationPolicy(frontmatter),
    })
  }
  return { entries: out, conflicts }
}

const COMMAND_MAX_LENGTH = 32
const COMMAND_FALLBACK = 'skill'
const DESC_MAX_LENGTH = 120

function sanitizeCommandName(raw: string): string {
  const normalized = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized.slice(0, COMMAND_MAX_LENGTH) || COMMAND_FALLBACK
}

function resolveUniqueCommandName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `_${i}`
    const keep = Math.max(1, COMMAND_MAX_LENGTH - suffix.length)
    const candidate = `${base.slice(0, keep)}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base.slice(0, Math.max(1, COMMAND_MAX_LENGTH - 2))}_x`
}

type BuildCommandSpecsResult = {
  commands: SkillCommandSpec[]
  conflicts: SkillConflictRecord[]
}

function buildSkillCommandSpecs(entries: SkillEntry[]): BuildCommandSpecsResult {
  const used = new Set<string>()
  const firstOwnerByBase = new Map<string, SkillEntry>()
  const out: SkillCommandSpec[] = []
  const conflicts: SkillConflictRecord[] = []

  for (const entry of entries) {
    if (!entry.invocation.userInvocable) continue

    const base = sanitizeCommandName(entry.skill.name)
    const baseKey = base.toLowerCase()
    const unique = resolveUniqueCommandName(base, used)

    const owner = firstOwnerByBase.get(baseKey)
    if (owner) {
      conflicts.push({
        type: 'command-rename',
        key: `/${base}`,
        kept: `${owner.skill.name} -> /${out.find((x) => x.skillName === owner.skill.name)?.name ?? base}`,
        replaced: `${entry.skill.name} -> /${unique}`,
        note: '命令名冲突，后出现的 skill 自动追加后缀',
      })
    } else {
      firstOwnerByBase.set(baseKey, entry)
    }

    used.add(unique.toLowerCase())
    const descRaw = entry.skill.description.trim() || entry.skill.name
    out.push({
      name: unique,
      skillName: entry.skill.name,
      description: descRaw.length > DESC_MAX_LENGTH ? `${descRaw.slice(0, DESC_MAX_LENGTH - 1)}…` : descRaw,
      source: entry.skill.source,
    })
  }

  out.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, 'en')
    if (byName !== 0) return byName
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1
    return a.skillName.localeCompare(b.skillName, 'zh-Hans-CN')
  })

  return { commands: out, conflicts }
}

function normalizeForLookup(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

function rankSkillCommandCandidates(commands: SkillCommandSpec[], rawName: string): SkillMatchTraceCandidate[] {
  const trimmed = String(rawName ?? '').trim()
  if (!trimmed) return []
  const lowered = trimmed.toLowerCase()
  const normalized = normalizeForLookup(trimmed)

  const ranked: SkillMatchTraceCandidate[] = []
  for (const entry of commands) {
    let score = 0
    const reasons: string[] = []

    if (entry.name.toLowerCase() === lowered) {
      score += 120
      reasons.push('command-exact')
    }
    if (entry.skillName.toLowerCase() === lowered) {
      score += 110
      reasons.push('skill-exact')
    }
    if (normalizeForLookup(entry.name) === normalized) {
      score += 80
      reasons.push('command-normalized')
    }
    if (normalizeForLookup(entry.skillName) === normalized) {
      score += 70
      reasons.push('skill-normalized')
    }
    if (score <= 0) continue

    if (entry.source === 'workspace') {
      score += 5
      reasons.push('workspace-priority')
    }

    ranked.push({
      commandName: entry.name,
      skillName: entry.skillName,
      source: entry.source,
      score,
      reasons,
    })
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1
    const bySkill = a.skillName.localeCompare(b.skillName, 'zh-Hans-CN')
    if (bySkill !== 0) return bySkill
    return a.commandName.localeCompare(b.commandName, 'en')
  })

  return ranked
}

function resolveCommandInvocationWithTrace(input: string, commands: SkillCommandSpec[]): SkillMatchResult {
  const trimmed = String(input ?? '').trim()
  if (!trimmed.startsWith('/')) {
    return {
      match: null,
      trace: { rawInput: trimmed, mode: 'not-slash', reason: 'not-slash', candidates: [] },
    }
  }

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/)
  if (!match) {
    return {
      match: null,
      trace: { rawInput: trimmed, mode: 'slash-command', reason: 'invalid-slash-syntax', candidates: [] },
    }
  }

  const commandName = (match[1] ?? '').trim().toLowerCase()
  const trailingArgs = match[2]?.trim() || undefined
  if (!commandName) {
    return {
      match: null,
      trace: { rawInput: trimmed, mode: 'slash-command', reason: 'empty-command', candidates: [] },
    }
  }

  if (commandName === 'skill') {
    const remainder = (match[2] ?? '').trim()
    if (!remainder) {
      return {
        match: null,
        trace: { rawInput: trimmed, mode: 'slash-skill', reason: 'missing-skill-name', candidates: [] },
      }
    }
    const nested = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/)
    if (!nested) {
      return {
        match: null,
        trace: { rawInput: trimmed, mode: 'slash-skill', reason: 'invalid-skill-args', candidates: [] },
      }
    }
    const query = (nested[1] ?? '').trim()
    const ranked = rankSkillCommandCandidates(commands, query)
    const selected = ranked[0]
    const cmd = selected ? commands.find((c) => c.name === selected.commandName && c.skillName === selected.skillName) : undefined
    return {
      match: cmd ? { command: cmd, args: nested[2]?.trim() || undefined } : null,
      trace: {
        rawInput: trimmed,
        mode: 'slash-skill',
        query,
        args: nested[2]?.trim() || undefined,
        reason: cmd ? (ranked.length > 1 ? 'selected-best-candidate' : 'matched') : 'no-skill-match',
        candidates: ranked.slice(0, 8),
        selected,
      },
    }
  }

  const cmd = commands.find((entry) => entry.name.toLowerCase() === commandName)
  const candidate: SkillMatchTraceCandidate | undefined = cmd
    ? {
        commandName: cmd.name,
        skillName: cmd.skillName,
        source: cmd.source,
        score: 120,
        reasons: ['command-exact'],
      }
    : undefined

  return {
    match: cmd ? { command: cmd, args: trailingArgs } : null,
    trace: {
      rawInput: trimmed,
      mode: 'slash-command',
      query: commandName,
      args: trailingArgs,
      reason: cmd ? 'matched' : 'unknown-command',
      candidates: candidate ? [candidate] : [],
      selected: candidate,
    },
  }
}

function stripFrontmatter(raw: string): string {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? text.slice(m[0].length) : text
}

export class SkillManager {
  private readonly workspaceDir: string
  private readonly defaultManagedDir: string
  private entries: SkillEntry[] = []
  private commands: SkillCommandSpec[] = []
  private loaded = false
  private loadedManagedDir = ''
  private cacheKey = ''
  private lastConflicts: SkillConflictRecord[] = []

  constructor(opts: { workspaceDir: string; managedDir?: string }) {
    this.workspaceDir = path.resolve(String(opts.workspaceDir ?? '.'))
    const home = process.env.HOME || process.env.USERPROFILE || '.'
    this.defaultManagedDir = path.resolve(String(opts.managedDir ?? path.join(home, '.neodeskpet', 'skills')))
  }

  private resolveManagedDir(override?: string): string {
    const raw = typeof override === 'string' ? override.trim() : ''
    return path.resolve(raw || this.defaultManagedDir)
  }

  private cacheKeyForManagedDir(managedDir: string): string {
    return `${this.workspaceDir}@@${managedDir}`.toLowerCase()
  }

  private async ensureLoaded(opts?: SkillManagerRuntimeOptions): Promise<void> {
    const managedDir = this.resolveManagedDir(opts?.managedDir)
    const key = this.cacheKeyForManagedDir(managedDir)
    if (this.loaded && this.cacheKey === key) return

    const loaded = await loadSkillEntries(this.workspaceDir, managedDir)
    const commandBuild = buildSkillCommandSpecs(loaded.entries)

    this.entries = loaded.entries
    this.commands = commandBuild.commands
    this.lastConflicts = [...loaded.conflicts, ...commandBuild.conflicts]
    this.loadedManagedDir = managedDir
    this.cacheKey = key
    this.loaded = true
  }

  async loadAll(opts?: SkillManagerRuntimeOptions): Promise<void> {
    await this.ensureLoaded(opts)
  }

  async refresh(opts?: SkillManagerRuntimeOptions): Promise<void> {
    this.loaded = false
    this.entries = []
    this.commands = []
    this.lastConflicts = []
    this.loadedManagedDir = ''
    this.cacheKey = ''
    await this.ensureLoaded(opts)
  }

  async list(opts?: SkillManagerRuntimeOptions): Promise<Skill[]> {
    await this.ensureLoaded(opts)
    return this.entries.map((e) => e.skill)
  }

  async listCommands(opts?: SkillManagerRuntimeOptions): Promise<SkillCommandSpec[]> {
    await this.ensureLoaded(opts)
    return [...this.commands]
  }

  async get(name: string, opts?: SkillManagerRuntimeOptions): Promise<Skill | null> {
    await this.ensureLoaded(opts)
    const needle = String(name ?? '').trim()
    if (!needle) return null
    return this.entries.find((e) => e.skill.name === needle)?.skill ?? null
  }

  async getEntry(name: string, opts?: SkillManagerRuntimeOptions): Promise<SkillEntry | null> {
    await this.ensureLoaded(opts)
    const needle = String(name ?? '').trim()
    if (!needle) return null
    return this.entries.find((e) => e.skill.name === needle) ?? null
  }

  async getDiagnostics(opts?: SkillManagerRuntimeOptions): Promise<SkillLoadDiagnostics> {
    const enabled = opts?.enabled !== false
    const managedDir = this.resolveManagedDir(opts?.managedDir)
    if (!enabled) {
      return {
        enabled: false,
        workspaceDir: this.workspaceDir,
        managedDir,
        totalSkills: 0,
        modelVisibleSkills: 0,
        totalCommands: 0,
        sourceCounts: { managed: 0, workspace: 0 },
        conflicts: [],
      }
    }

    await this.ensureLoaded(opts)
    const visible = this.entries.filter((e) => !e.invocation.disableModelInvocation).length
    const sourceCounts = { managed: 0, workspace: 0 }
    for (const e of this.entries) sourceCounts[e.skill.source] += 1
    return {
      enabled: true,
      workspaceDir: this.workspaceDir,
      managedDir: this.loadedManagedDir || managedDir,
      totalSkills: this.entries.length,
      modelVisibleSkills: visible,
      totalCommands: this.commands.length,
      sourceCounts,
      conflicts: [...this.lastConflicts],
    }
  }

  async matchWithTrace(input: string, opts?: SkillManagerRuntimeOptions): Promise<SkillMatchResult> {
    if (opts?.enabled === false) {
      return {
        match: null,
        trace: {
          rawInput: String(input ?? '').trim(),
          mode: String(input ?? '').trim().startsWith('/') ? 'slash-command' : 'not-slash',
          reason: 'skills-disabled',
          candidates: [],
        },
      }
    }
    await this.ensureLoaded(opts)
    return resolveCommandInvocationWithTrace(input, this.commands)
  }

  async match(input: string, opts?: SkillManagerRuntimeOptions): Promise<SkillMatch | null> {
    const result = await this.matchWithTrace(input, opts)
    return result.match
  }

  async buildSkillsPrompt(opts?: SkillManagerRuntimeOptions): Promise<string> {
    if (opts?.enabled === false) return ''
    if (opts?.allowModelInvocation === false) return ''
    await this.ensureLoaded(opts)
    const visible = this.entries.filter((e) => !e.invocation.disableModelInvocation).map((e) => e.skill)
    return formatSkillsForPrompt(visible)
  }

  async readSkillContent(name: string, opts?: SkillManagerRuntimeOptions): Promise<{ skill: Skill; content: string } | null> {
    const entry = await this.getEntry(name, opts)
    if (!entry) return null
    try {
      const raw = await fs.readFile(entry.skill.filePath, 'utf-8')
      const content = stripFrontmatter(raw).trim()
      if (!content) return null
      return { skill: entry.skill, content }
    } catch {
      return null
    }
  }
}
