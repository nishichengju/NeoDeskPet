// 系统提示词附加段构建：工具结果回灌 / 世界书（自 App.tsx 拆出，纯函数）

import type {
  AppSettings,
  TaskRecord,
  WorldBookEntry,
} from '../../electron/types'

export function buildToolResultSystemAddon(task: TaskRecord): string {
  const t = task
  const visualOutputTools = new Set(['image.generate', 'screen.capture', 'browser.screenshot'])
  const lines: string[] = []
  lines.push('【工具执行结果】')
  lines.push(`任务：${t.title}`)
  lines.push(`状态：${t.status}`)

  const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
  if (runs.length > 0) {
    lines.push('')
    for (const r of runs.slice(0, 12)) {
      lines.push(`- ${r.toolName} (${r.status})`)
      if (visualOutputTools.has(r.toolName)) {
        const count = Array.isArray(r.imagePaths) ? r.imagePaths.length : 0
        for (let index = 0; index < count; index += 1) {
          lines.push(`  artifactId: vis_${t.id}_${r.id}_${index + 1}`)
        }
        continue
      }
      if (r.inputPreview) lines.push(`  in: ${r.inputPreview}`)
      if (r.outputPreview) lines.push(`  out: ${r.outputPreview}`)
      if (r.error) lines.push(`  err: ${r.error}`)
    }
  } else {
    const steps = Array.isArray(t.steps) ? t.steps : []
    const useful = steps.filter((s) => s.tool || s.output || s.error)
    if (useful.length > 0) {
      lines.push('')
      for (const s of useful.slice(0, 12)) {
        const tool = typeof s.tool === 'string' ? s.tool : ''
        lines.push(`- ${tool || s.title} (${s.status})`)
        if (s.output) lines.push(`  out: ${String(s.output).slice(0, 800)}`)
        if (s.error) lines.push(`  err: ${String(s.error).slice(0, 800)}`)
      }
    }
  }

  if (t.lastError) {
    lines.push('')
    lines.push(`任务错误：${t.lastError}`)
  }

  lines.push('')
  lines.push('约束：以上为工具事实来源。最终回复只输出自然语言结果，不要提到工具内部名/执行日志。')
  return lines.join('\n')
}

export function buildWorldBookAddon(settings: AppSettings | null | undefined, activePersonaId: string): string {
  const worldBook = settings?.worldBook
  if (!worldBook || worldBook.enabled === false) return ''

  const activeTagKeys = new Set(
    (Array.isArray(worldBook.activeTagIds) ? worldBook.activeTagIds : [])
      .map((tag) => String(tag ?? '').trim().toLowerCase())
      .filter(Boolean),
  )
  const personaId = String(activePersonaId ?? '').trim() || 'default'
  const entriesRaw = Array.isArray(worldBook.entries) ? worldBook.entries : []
  const entries = entriesRaw
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!entry || entry.enabled === false) return false
      const content = String(entry.content ?? '').trim()
      if (!content) return false
      if (entry.scope === 'persona') {
        const entryPersonaId = String(entry.personaId ?? '').trim()
        if (entryPersonaId && entryPersonaId !== personaId) return false
      }
      const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag ?? '').trim()).filter(Boolean) : []
      if (tags.length === 0) return true
      return tags.some((tag) => activeTagKeys.has(tag.toLowerCase()))
    })
    .sort((a, b) => {
      const priorityA = Number.isFinite(a.entry.priority) ? a.entry.priority : 100
      const priorityB = Number.isFinite(b.entry.priority) ? b.entry.priority : 100
      if (priorityA !== priorityB) return priorityA - priorityB
      const updatedA = Number.isFinite(a.entry.updatedAt) ? a.entry.updatedAt : 0
      const updatedB = Number.isFinite(b.entry.updatedAt) ? b.entry.updatedAt : 0
      if (updatedA !== updatedB) return updatedB - updatedA
      return a.index - b.index
    })

  if (entries.length === 0) return ''

  const maxCharsRaw = Number.isFinite(worldBook.maxChars) ? Math.trunc(worldBook.maxChars) : 6000
  const maxChars = Math.max(500, Math.min(30000, maxCharsRaw))
  const lines: string[] = [
    '【设定库（世界书，当前启用）】',
    '规则：以下为用户手写的长期设定上下文；与更高优先级系统规则冲突时服从系统规则。',
  ]
  let current = lines.join('\n')

  const appendChunk = (chunk: string): boolean => {
    const sep = current ? '\n\n' : ''
    const next = `${current}${sep}${chunk}`
    if (next.length <= maxChars) {
      current = next
      return true
    }

    const suffix = '\n...（设定库已按最大字符数截断）'
    const remaining = maxChars - current.length - sep.length - suffix.length
    if (remaining > 80) {
      current = `${current}${sep}${chunk.slice(0, remaining).trimEnd()}${suffix}`
    } else if (!current.includes('设定库已按最大字符数截断')) {
      current = `${current.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
    }
    return false
  }

  for (const { entry } of entries) {
    const e = entry as WorldBookEntry
    const title = String(e.title ?? '').trim() || '未命名设定'
    const tags = Array.isArray(e.tags) ? e.tags.map((tag) => String(tag ?? '').trim()).filter(Boolean) : []
    const content = String(e.content ?? '').trim()
    const chunkLines = [`[${title}]`]
    if (tags.length > 0) chunkLines.push(`标签：${tags.join('、')}`)
    if (e.scope === 'persona') chunkLines.push(`作用域：当前角色（${String(e.personaId ?? personaId).trim() || personaId}）`)
    chunkLines.push(`内容：${content}`)
    if (!appendChunk(chunkLines.join('\n'))) break
  }

  return current.trim()
}
