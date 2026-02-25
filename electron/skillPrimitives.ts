import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

export type SkillSource = 'managed' | 'workspace'

export type Skill = {
  name: string
  description: string
  filePath: string
  baseDir: string
  source: SkillSource
  disableModelInvocation: boolean
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  return fallback
}

function extractFrontmatter(content: string): Record<string, string> {
  const match = String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const out: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/)
    if (!kv) continue
    out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}

async function loadSkillFromFile(filePath: string, baseDir: string, source: SkillSource): Promise<Skill | null> {
  let content = ''
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const fm = extractFrontmatter(content)
  const name =
    (fm.name ?? '').trim() ||
    path.basename(baseDir).toLowerCase() ||
    path.basename(filePath, path.extname(filePath)).toLowerCase()
  const description = (fm.description ?? '').trim()
  if (!name || !description) return null

  return {
    name,
    description,
    filePath: path.resolve(filePath),
    baseDir: path.resolve(baseDir),
    source,
    disableModelInvocation: parseBool(fm['disable-model-invocation'], false),
  }
}

async function scanSubdirs(dir: string, source: SkillSource): Promise<Skill[]> {
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: Skill[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (!entry.isDirectory()) continue
    const subdir = path.join(dir, entry.name)

    const fromSkillMd = await loadSkillFromFile(path.join(subdir, 'SKILL.md'), subdir, source)
    if (fromSkillMd) out.push(fromSkillMd)

    const nested = await scanSubdirs(subdir, source)
    if (nested.length) out.push(...nested)
  }
  return out
}

export async function loadSkillsFromDir(params: { dir: string; source: SkillSource }): Promise<Skill[]> {
  const { dir, source } = params
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: Skill[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      const fromSkillMd = await loadSkillFromFile(path.join(fullPath, 'SKILL.md'), fullPath, source)
      if (fromSkillMd) out.push(fromSkillMd)
      const nested = await scanSubdirs(fullPath, source)
      if (nested.length) out.push(...nested)
      continue
    }

    if (!entry.name.toLowerCase().endsWith('.md')) continue
    const skill = await loadSkillFromFile(fullPath, dir, source)
    if (skill) out.push(skill)
  }
  return out
}

const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeXml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] ?? ch)
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = (Array.isArray(skills) ? skills : []).filter((s) => s && !s.disableModelInvocation)
  if (visible.length === 0) return ''

  const lines = ['<available_skills>']
  for (const s of visible) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(s.name)}</name>`)
    lines.push(`    <description>${escapeXml(s.description)}</description>`)
    lines.push(`    <location>${escapeXml(s.filePath)}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

