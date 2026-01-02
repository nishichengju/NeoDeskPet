import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getSettings } from './store'
import type { TaskCreateArgs, TaskListResult, TaskRecord, TaskStepRecord, TaskStatus } from './types'

type TaskStoreState = {
  version: 1
  tasks: TaskRecord[]
}

type TaskRuntime = {
  paused: boolean
  canceled: boolean
  waiters: Array<() => void>
  cancelCurrent?: () => void
}

const MAX_TASKS = 200
const MAX_STEP_OUTPUT_CHARS = 5000

function now(): number {
  return Date.now()
}

function clampText(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

function normalizeTaskRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<TaskRecord>
  if (typeof v.id !== 'string' || !v.id.trim()) return null
  if (typeof v.title !== 'string' || !v.title.trim()) return null
  const status = v.status
  const allowedStatus: TaskStatus[] = ['pending', 'running', 'paused', 'failed', 'done', 'canceled']
  if (!allowedStatus.includes(status as TaskStatus)) return null

  const steps = Array.isArray(v.steps) ? (v.steps as TaskStepRecord[]) : []
  const safeSteps = steps
    .filter((s) => s && typeof s === 'object' && typeof (s as TaskStepRecord).title === 'string')
    .slice(0, 120)
    .map((s) => ({
      id: typeof s.id === 'string' && s.id.trim() ? s.id : randomUUID(),
      title: clampText(s.title, 80),
      status: (s.status ?? 'pending') as TaskStepRecord['status'],
      tool: typeof s.tool === 'string' ? clampText(s.tool, 80) : undefined,
      input: typeof s.input === 'string' ? clampText(s.input, 800) : undefined,
      output: typeof s.output === 'string' ? clampText(s.output, 1200) : undefined,
      error: typeof s.error === 'string' ? clampText(s.error, 1200) : undefined,
      startedAt: typeof s.startedAt === 'number' ? s.startedAt : undefined,
      endedAt: typeof s.endedAt === 'number' ? s.endedAt : undefined,
    }))

  const toolsUsed = Array.isArray(v.toolsUsed) ? v.toolsUsed.filter((x) => typeof x === 'string').slice(0, 80) : []

  return {
    id: v.id,
    queue: (v.queue ?? 'other') as TaskRecord['queue'],
    title: clampText(v.title, 120),
    why: typeof v.why === 'string' ? clampText(v.why, 240) : '',
    status: status as TaskStatus,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : now(),
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : undefined,
    endedAt: typeof v.endedAt === 'number' ? v.endedAt : undefined,
    steps: safeSteps,
    currentStepIndex: typeof v.currentStepIndex === 'number' ? Math.max(0, Math.trunc(v.currentStepIndex)) : 0,
    toolsUsed,
    lastError: typeof v.lastError === 'string' ? clampText(v.lastError, 1600) : undefined,
  }
}

function normalizeState(state: TaskStoreState | undefined): TaskStoreState {
  const s = state ?? ({ version: 1, tasks: [] } as TaskStoreState)
  const rawTasks = Array.isArray(s.tasks) ? s.tasks : []
  const tasks = rawTasks.map(normalizeTaskRecord).filter(Boolean) as TaskRecord[]

  const next: TaskStoreState = { version: 1, tasks: tasks.slice(0, MAX_TASKS) }
  return next
}

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

type ToolInput = string | Record<string, unknown> | Array<unknown> | null

function parseToolInput(input: string | undefined): ToolInput {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as ToolInput
    } catch {
      return raw
    }
  }
  return raw
}

function resolveTemplateString(template: string, task: TaskRecord): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_m, exprRaw: string) => {
    const expr = String(exprRaw || '').trim()
    if (!expr) return ''

    if (expr === 'task.id') return task.id
    if (expr === 'task.title') return task.title
    if (expr === 'task.why') return task.why
    if (expr === 'task.queue') return task.queue
    if (expr === 'task.status') return task.status

    const stepMatch = expr.match(/^steps\[(\d+)\]\.(output|input|title)$/)
    if (stepMatch) {
      const idx = Number(stepMatch[1])
      const key = stepMatch[2] as 'output' | 'input' | 'title'
      const s = task.steps[idx]
      if (!s) return ''
      const v = (s as Record<string, unknown>)[key]
      return typeof v === 'string' ? v : ''
    }

    return ''
  })
}

function resolveTemplates(value: ToolInput, task: TaskRecord): ToolInput {
  if (typeof value === 'string') return resolveTemplateString(value, task)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v as ToolInput, task))

  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveTemplates(v as ToolInput, task)
  }
  return out as ToolInput
}

function clampStepOutput(text: string): string {
  return clampText(text, MAX_STEP_OUTPUT_CHARS)
}

function ensureStringArray(value: unknown, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const it of value) {
    if (typeof it !== 'string') continue
    const s = it.trim()
    if (!s) continue
    out.push(s)
    if (out.length >= maxLen) break
  }
  return out
}

async function readResponseText(res: Response, maxChars: number): Promise<string> {
  const text = await res.text()
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '…'
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, '')
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, ' ')
  return withoutTags.replace(/\s+/g, ' ').trim()
}

function joinUrl(baseUrl: string, pathname: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  const p = pathname.trim().replace(/^\/+/, '')
  return `${b}/${p}`
}

export class TaskService {
  private readonly store: Store<TaskStoreState>
  private readonly runtime = new Map<string, TaskRuntime>()
  private readonly onChanged: () => void
  private readonly userDataDir: string
  private schedulerTimer: NodeJS.Timeout | null = null

  constructor(opts: { onChanged: () => void; userDataDir: string }) {
    this.store = new Store<TaskStoreState>({
      name: 'neodeskpet-tasks',
      defaults: { version: 1, tasks: [] },
    })
    this.onChanged = opts.onChanged
    this.userDataDir = opts.userDataDir

    // 如果上次异常退出，running 状态会悬挂；这里统一标记为 failed（便于用户看见原因）
    this.writeState((draft) => {
      const ts = now()
      for (const t of draft.tasks) {
        if (t.status === 'running') {
          t.status = 'failed'
          t.updatedAt = ts
          t.endedAt = ts
          t.lastError = t.lastError || '任务在上次运行时中断（应用被重启/崩溃）'
        }
      }
    })
  }

  listTasks(): TaskListResult {
    const state = normalizeState(this.store.store)
    const items = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    return { items }
  }

  getTask(id: string): TaskRecord | null {
    const tid = (id ?? '').trim()
    if (!tid) return null
    const state = normalizeState(this.store.store)
    return state.tasks.find((t) => t.id === tid) ?? null
  }

  createTask(args: TaskCreateArgs): TaskRecord {
    const title = clampText(args.title, 120)
    if (!title) throw new Error('任务标题不能为空')

    const id = randomUUID()
    const ts = now()
    const stepsInput = Array.isArray(args.steps) ? args.steps : []
    const steps: TaskStepRecord[] =
      stepsInput.length > 0
        ? stepsInput.slice(0, 20).map((s) => ({
            id: randomUUID(),
            title: clampText(s.title, 80),
            status: 'pending',
            tool: typeof s.tool === 'string' ? clampText(s.tool, 80) : undefined,
            input: typeof s.input === 'string' ? clampText(s.input, 800) : undefined,
          }))
        : [
            { id: randomUUID(), title: '准备', status: 'pending' },
            { id: randomUUID(), title: '执行', status: 'pending' },
            { id: randomUUID(), title: '收尾', status: 'pending' },
          ]

    const record: TaskRecord = {
      id,
      queue: args.queue ?? 'other',
      title,
      why: typeof args.why === 'string' ? clampText(args.why, 240) : '',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      steps,
      currentStepIndex: 0,
      toolsUsed: [],
    }

    this.writeState((draft) => {
      draft.tasks.unshift(record)
      draft.tasks = draft.tasks.slice(0, MAX_TASKS)
    })

    this.kickScheduler()
    return record
  }

  pauseTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status !== 'running') return t
    const rt = this.ensureRuntime(t.id)
    rt.paused = true
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'paused'
      it.updatedAt = now()
    })
    return this.getTask(t.id)
  }

  resumeTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status !== 'paused') return t
    const rt = this.ensureRuntime(t.id)
    rt.paused = false
    for (const w of rt.waiters.splice(0)) w()
    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'running'
      it.updatedAt = now()
    })
    this.kickScheduler()
    return this.getTask(t.id)
  }

  cancelTask(id: string): TaskRecord | null {
    const t = this.getTask(id)
    if (!t) return null
    if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') return t

    const rt = this.ensureRuntime(t.id)
    rt.canceled = true
    rt.paused = false
    try {
      rt.cancelCurrent?.()
    } catch {
      // ignore
    }
    for (const w of rt.waiters.splice(0)) w()

    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === t.id)
      if (!it) return
      it.status = 'canceled'
      it.updatedAt = now()
      it.endedAt = now()
    })

    return this.getTask(t.id)
  }

  // =====================
  // Internal runner logic
  // =====================

  private ensureRuntime(id: string): TaskRuntime {
    const existing = this.runtime.get(id)
    if (existing) return existing
    const rt: TaskRuntime = { paused: false, canceled: false, waiters: [] }
    this.runtime.set(id, rt)
    return rt
  }

  private kickScheduler(): void {
    if (this.schedulerTimer) return
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null
      this.runScheduler()
    }, 30)
  }

  private runScheduler(): void {
    const state = normalizeState(this.store.store)
    const running = state.tasks.filter((t) => t.status === 'running').length
    const capacity = Math.max(0, 3 - running)
    if (capacity <= 0) return

    const pending = state.tasks.filter((t) => t.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
    const toStart = pending.slice(0, capacity)
    for (const task of toStart) {
      this.startTask(task.id)
    }
  }

  private startTask(id: string): void {
    const t = this.getTask(id)
    if (!t) return
    if (t.status !== 'pending') return

    this.writeState((draft) => {
      const it = draft.tasks.find((x) => x.id === id)
      if (!it) return
      it.status = 'running'
      it.startedAt = it.startedAt ?? now()
      it.updatedAt = now()
    })

    void this.runTask(id)
  }

  private async waitIfPaused(id: string): Promise<void> {
    const rt = this.ensureRuntime(id)
    if (!rt.paused) return
    await new Promise<void>((resolve) => {
      rt.waiters.push(resolve)
    })
  }

  private async runTool(tool: string | undefined, input: ToolInput, task: TaskRecord, rt: TaskRuntime): Promise<string> {
    const toolName = typeof tool === 'string' ? tool.trim() : ''
    const resolved = resolveTemplates(input, task)

    if (!toolName) {
      // 没有工具：作为“备注/占位 step”，直接通过
      await sleep(60)
      return '跳过（无 tool）'
    }

    if (toolName === 'browser.fetch') {
      const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
      const url = typeof obj?.url === 'string' ? obj.url : typeof resolved === 'string' ? resolved : ''
      const maxChars = typeof obj?.maxChars === 'number' ? Math.max(200, Math.min(20000, Math.trunc(obj.maxChars))) : 5000
      const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(120000, Math.trunc(obj.timeoutMs))) : 15000
      const wantStrip = obj?.stripHtml === true
      const headers = typeof obj?.headers === 'object' && obj.headers ? (obj.headers as Record<string, unknown>) : {}

      if (!url || !/^https?:\/\//i.test(url)) throw new Error(`browser.fetch 需要有效 URL（http/https），当前：${url || '(空)'}`)

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('fetch timeout')), timeoutMs)
      rt.cancelCurrent = () => ac.abort(new Error('canceled'))

      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: ac.signal,
          headers: {
            'user-agent': 'NeoDeskPet/0.1 (task-runner)',
            ...Object.fromEntries(Object.entries(headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
          },
        })
        const raw = await readResponseText(res, maxChars * 2)
        const body = wantStrip ? stripHtml(raw) : raw
        const preview = clampStepOutput(body.slice(0, maxChars))
        return `HTTP ${res.status}\n${preview}`
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
      }
    }

    if (toolName === 'browser.playwright') {
      const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
      const url = typeof obj?.url === 'string' ? obj.url : typeof resolved === 'string' ? resolved : ''
      const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(180000, Math.trunc(obj.timeoutMs))) : 45000
      const headless = obj?.headless !== false
      const channelRaw = typeof obj?.channel === 'string' ? obj.channel.trim() : ''
      const channel = channelRaw || (process.platform === 'win32' ? 'msedge' : '')

      const extractObj =
        typeof obj?.extract === 'object' && obj.extract && !Array.isArray(obj.extract)
          ? (obj.extract as Record<string, unknown>)
          : null
      const shouldExtract = !!extractObj
      const extractSelector = shouldExtract && typeof extractObj?.selector === 'string' ? String(extractObj.selector) : 'body'
      const extractFormatRaw = shouldExtract && typeof extractObj?.format === 'string' ? String(extractObj.format) : 'innerText'
      const extractFormat = ['innerText', 'text', 'html'].includes(extractFormatRaw) ? extractFormatRaw : 'innerText'
      const extractOptional = shouldExtract && extractObj?.optional === true
      const extractMaxChars =
        shouldExtract && typeof extractObj?.maxChars === 'number'
          ? Math.max(80, Math.min(10000, Math.trunc(extractObj.maxChars)))
          : 2000

      const screenshotObj =
        typeof obj?.screenshot === 'object' && obj.screenshot && !Array.isArray(obj.screenshot)
          ? (obj.screenshot as Record<string, unknown>)
          : null
      const screenshotPathRaw = typeof screenshotObj?.path === 'string' ? screenshotObj.path.trim() : ''
      const screenshotFullPage = screenshotObj?.fullPage === true

      const actions = Array.isArray(obj?.actions) ? (obj?.actions as Array<Record<string, unknown>>) : []

      if (!url || !/^https?:\/\//i.test(url)) throw new Error(`browser.playwright 需要有效 URL（http/https），当前：${url || '(空)'}`)

      const pw = (await import('playwright-core')) as unknown as {
        chromium: {
          launchPersistentContext: (
            userDataDir: string,
            options: {
              headless: boolean
              channel?: string
              viewport?: { width: number; height: number }
              ignoreHTTPSErrors?: boolean
            },
          ) => Promise<{
            newPage: () => Promise<{
              goto: (u: string, opts: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number }) => Promise<void>
              waitForTimeout: (ms: number) => Promise<void>
              waitForLoadState: (state: 'load' | 'domcontentloaded' | 'networkidle', opts: { timeout: number }) => Promise<void>
              title: () => Promise<string>
              locator: (selector: string) => {
                first: () => {
                  innerText: (opts: { timeout: number }) => Promise<string>
                  textContent: (opts: { timeout: number }) => Promise<string | null>
                  innerHTML: (opts: { timeout: number }) => Promise<string>
                  click: (opts: { timeout: number }) => Promise<void>
                  fill: (value: string, opts: { timeout: number }) => Promise<void>
                  press: (key: string, opts: { timeout: number }) => Promise<void>
                }
              }
              screenshot: (opts: { path: string; fullPage: boolean; timeout: number }) => Promise<void>
            }>
            close: () => Promise<void>
          }>
        }
      }

      const profileName = typeof obj?.profile === 'string' && obj.profile.trim() ? obj.profile.trim() : 'default'
      const safeProfile = profileName.replace(/[<>:"/\\|?*]+/g, '_')
      const profileDir = path.join(this.userDataDir, 'playwright', safeProfile)
      await fs.mkdir(profileDir, { recursive: true })

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('playwright timeout')), timeoutMs)

      const context = await pw.chromium.launchPersistentContext(profileDir, {
        headless,
        channel: channel || undefined,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      })

      rt.cancelCurrent = () => {
        try {
          ac.abort(new Error('canceled'))
        } catch {
          // ignore
        }
        void context.close().catch(() => undefined)
      }

      try {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

        for (const action of actions.slice(0, 30)) {
          if (rt.canceled) break
          await this.waitIfPaused(task.id)
          if (rt.canceled) break

          const type = typeof action?.type === 'string' ? action.type : ''
          if (type === 'waitMs') {
            const ms = typeof action?.ms === 'number' ? Math.max(0, Math.min(60000, Math.trunc(action.ms))) : 500
            await page.waitForTimeout(ms)
            continue
          }
          if (type === 'waitForLoad') {
            const state = (typeof action?.state === 'string' ? action.state : 'networkidle') as
              | 'load'
              | 'domcontentloaded'
              | 'networkidle'
            await page.waitForLoadState(state, { timeout: timeoutMs })
            continue
          }

          const selector = typeof action?.selector === 'string' ? action.selector : ''
          if (!selector) continue
          const loc = page.locator(selector).first()
          if (type === 'click') {
            await loc.click({ timeout: timeoutMs })
            continue
          }
          if (type === 'fill') {
            const text = typeof action?.text === 'string' ? action.text : ''
            await loc.fill(text, { timeout: timeoutMs })
            continue
          }
          if (type === 'press') {
            const key = typeof action?.key === 'string' ? action.key : 'Enter'
            await loc.press(key, { timeout: timeoutMs })
            continue
          }
          if (type === 'waitFor') {
            // 最简单实现：尝试读取 innerText 来触发等待
            await loc.innerText({ timeout: timeoutMs })
            continue
          }
        }

        const title = await page.title().catch(() => '')

        let extractPreview = ''
        if (shouldExtract) {
          let extracted = ''
          try {
            const loc = page.locator(extractSelector).first()
            if (extractFormat === 'html') extracted = await loc.innerHTML({ timeout: timeoutMs })
            else if (extractFormat === 'text') extracted = (await loc.textContent({ timeout: timeoutMs })) ?? ''
            else extracted = await loc.innerText({ timeout: timeoutMs })
          } catch (err) {
            if (!extractOptional) throw err
          }
          extractPreview = extracted ? clampStepOutput(extracted.slice(0, extractMaxChars)) : ''
        }

        let shotPath = ''
        if (screenshotObj) {
          const rel = screenshotPathRaw || `task-output/${task.id}-shot.png`
          const fullPath = path.isAbsolute(rel) ? rel : path.join(this.userDataDir, rel)
          await fs.mkdir(path.dirname(fullPath), { recursive: true })
          await page.screenshot({ path: fullPath, fullPage: screenshotFullPage, timeout: timeoutMs })
          shotPath = fullPath
        }

        const lines: string[] = []
        if (title) lines.push(`title: ${title}`)
        lines.push(`url: ${url}`)
        if (shotPath) lines.push(`screenshot: ${shotPath}`)
        if (extractPreview) lines.push(`extract(${extractSelector}): ${extractPreview}`)
        return clampStepOutput(lines.join('\n'))
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
        await context.close().catch(() => undefined)
      }
    }

    if (toolName === 'file.write') {
      const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
      const relPath = typeof obj?.path === 'string' ? obj.path.trim() : ''
      const filename = typeof obj?.filename === 'string' ? obj.filename.trim() : ''
      const content = typeof obj?.content === 'string' ? obj.content : typeof resolved === 'string' ? resolved : ''
      const append = obj?.append === true
      const encoding = typeof obj?.encoding === 'string' ? obj.encoding : 'utf8'

      const safeName = filename ? filename.replace(/[<>:"/\\|?*]+/g, '_') : ''
      const fallbackName = `${task.id}-${now()}.txt`
      const baseName = safeName || fallbackName
      const baseDir = path.join(this.userDataDir, 'task-output')
      const fullPath = relPath
        ? path.isAbsolute(relPath)
          ? relPath
          : path.join(this.userDataDir, relPath)
        : path.join(baseDir, baseName)

      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      if (append) await fs.appendFile(fullPath, content ?? '', { encoding: encoding as BufferEncoding })
      else await fs.writeFile(fullPath, content ?? '', { encoding: encoding as BufferEncoding })
      return `已写入：${fullPath}`
    }

    if (toolName === 'cli.exec') {
      const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
      const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(10 * 60_000, Math.trunc(obj.timeoutMs))) : 90_000
      const cwd = typeof obj?.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : process.cwd()
      const envObj = typeof obj?.env === 'object' && obj.env ? (obj.env as Record<string, unknown>) : null
      const env = envObj
        ? ({
            ...process.env,
            ...Object.fromEntries(Object.entries(envObj).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
          } as NodeJS.ProcessEnv)
        : process.env

      let cmd = ''
      let args: string[] = []
      if (obj && typeof obj.cmd === 'string' && obj.cmd.trim()) {
        cmd = obj.cmd.trim()
        args = ensureStringArray(obj.args, 80)
      } else if (typeof resolved === 'string') {
        const line = resolved.trim()
        if (!line) throw new Error('cli.exec 需要命令行字符串')
        if (process.platform === 'win32') {
          cmd = 'cmd.exe'
          args = ['/d', '/s', '/c', line]
        } else {
          cmd = 'sh'
          args = ['-lc', line]
        }
      } else {
        throw new Error('cli.exec 输入格式不正确')
      }

      const child = spawn(cmd, args, {
        cwd,
        env,
        windowsHide: true,
      })
      rt.cancelCurrent = () => {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }

      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []
      const pushChunk = (arr: string[], chunk: Buffer) => {
        const s = chunk.toString('utf8')
        if (!s) return
        arr.push(s)
        const joinedLen = arr.reduce((acc, it) => acc + it.length, 0)
        if (joinedLen > 20000) arr.splice(0, Math.max(0, arr.length - 20))
      }

      child.stdout?.on('data', (c) => pushChunk(stdoutChunks, c as Buffer))
      child.stderr?.on('data', (c) => pushChunk(stderrChunks, c as Buffer))

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // ignore
          }
          reject(new Error(`cli.exec timeout (${timeoutMs}ms)`))
        }, timeoutMs)

        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })

      rt.cancelCurrent = undefined

      const out = clampStepOutput(stdoutChunks.join(''))
      const err = clampStepOutput(stderrChunks.join(''))
      const header = `cmd: ${cmd} ${args.join(' ')}\ncode: ${exit.code ?? 'null'} signal: ${exit.signal ?? 'null'}`
      if (err) return `${header}\n\n[stderr]\n${err}\n\n[stdout]\n${out}`
      return `${header}\n\n[stdout]\n${out}`
    }

    if (toolName === 'delay.sleep') {
      const ms =
        typeof resolved === 'string'
          ? Math.max(0, Math.min(300000, Math.trunc(Number(resolved))))
          : typeof (resolved as Record<string, unknown>)?.ms === 'number'
            ? Math.max(0, Math.min(300000, Math.trunc((resolved as Record<string, unknown>).ms as number)))
            : 200
      await sleep(ms)
      return `sleep ${ms}ms`
    }

    if (toolName === 'llm.summarize' || toolName === 'llm.chat') {
      const obj = typeof resolved === 'object' && resolved && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : null
      const prompt = typeof obj?.prompt === 'string' ? obj.prompt : typeof resolved === 'string' ? resolved : ''
      if (!prompt.trim()) throw new Error(`${toolName} 需要 prompt`)

      const appSettings = getSettings()
      const baseUrl = (typeof obj?.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl.trim() : appSettings.ai.baseUrl).trim()
      const apiKey = typeof obj?.apiKey === 'string' ? obj.apiKey : appSettings.ai.apiKey
      const model = (typeof obj?.model === 'string' && obj.model.trim() ? obj.model.trim() : appSettings.ai.model).trim()
      const temperature =
        typeof obj?.temperature === 'number'
          ? Math.max(0, Math.min(2, obj.temperature))
          : Math.max(0, Math.min(2, appSettings.ai.temperature))
      const maxTokens = typeof obj?.maxTokens === 'number' ? Math.max(64, Math.min(8192, Math.trunc(obj.maxTokens))) : 1200
      const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(2000, Math.min(180000, Math.trunc(obj.timeoutMs))) : 60000

      const system =
        typeof obj?.system === 'string'
          ? obj.system
          : toolName === 'llm.summarize'
            ? '你是一个信息整理助手。请把输入内容总结成：标题（1行）+ 要点列表（<=8条）。'
            : '你是一个可爱的桌面宠物助手，请用友好、活泼的语气回复用户。'

      if (!baseUrl || !model) throw new Error('未配置 LLM baseUrl/model（设置 → AI 设置）')

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs)
      rt.cancelCurrent = () => ac.abort(new Error('canceled'))

      try {
        const url = joinUrl(baseUrl, 'chat/completions')
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        const token = (apiKey ?? '').trim()
        if (token) headers.authorization = `Bearer ${token}`

        const res = await fetch(url, {
          method: 'POST',
          signal: ac.signal,
          headers,
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
          }),
        })
        const data = (await res.json()) as {
          error?: { message?: string }
          choices?: Array<{ message?: { content?: string } }>
        }
        if (!res.ok) {
          const errMsg = data?.error?.message || `HTTP ${res.status}`
          throw new Error(errMsg)
        }
        const content = data?.choices?.[0]?.message?.content ?? ''
        return clampStepOutput(content || '(空)')
      } finally {
        clearTimeout(timer)
        rt.cancelCurrent = undefined
      }
    }

    throw new Error(`未知 tool：${toolName}`)
  }

  private async runTask(id: string): Promise<void> {
    const rt = this.ensureRuntime(id)
    try {
      while (!rt.canceled) {
        const t = this.getTask(id)
        if (!t) return
        if (t.status !== 'running' && t.status !== 'paused') return

        if (t.status === 'paused') {
          await this.waitIfPaused(id)
          continue
        }

        const idx = t.currentStepIndex
        const step = t.steps[idx]
        if (!step) {
          this.writeState((draft) => {
            const it = draft.tasks.find((x) => x.id === id)
            if (!it) return
            it.status = 'done'
            it.updatedAt = now()
            it.endedAt = now()
          })
          this.runtime.delete(id)
          this.kickScheduler()
          return
        }

        // 标记 step running
        this.writeState((draft) => {
          const it = draft.tasks.find((x) => x.id === id)
          if (!it) return
          const s = it.steps[it.currentStepIndex]
          if (!s) return
          s.status = 'running'
          s.startedAt = s.startedAt ?? now()
          it.updatedAt = now()
          if (s.tool && !it.toolsUsed.includes(s.tool)) {
            it.toolsUsed = [...it.toolsUsed, s.tool].slice(0, 80)
          }
        })

        await this.waitIfPaused(id)
        if (rt.canceled) return

        const toolInput = parseToolInput(step.input)
        const output = await this.runTool(step.tool, toolInput, t, rt)

        await this.waitIfPaused(id)
        if (rt.canceled) return

        this.writeState((draft) => {
          const it = draft.tasks.find((x) => x.id === id)
          if (!it) return
          const s = it.steps[it.currentStepIndex]
          if (!s) return
          s.status = 'done'
          s.endedAt = now()
          s.output = clampStepOutput(output || '完成')
          it.currentStepIndex += 1
          it.updatedAt = now()
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.writeState((draft) => {
        const it = draft.tasks.find((x) => x.id === id)
        if (!it) return
        it.status = 'failed'
        it.lastError = clampText(msg, 1600) || '任务失败'
        it.updatedAt = now()
        it.endedAt = now()
        const s = it.steps[it.currentStepIndex]
        if (s && s.status === 'running') {
          s.status = 'failed'
          s.error = it.lastError
          s.endedAt = now()
        }
      })
    } finally {
      rt.cancelCurrent = undefined
      this.runtime.delete(id)
      this.kickScheduler()
    }
  }

  private writeState(mutator: (draft: TaskStoreState) => void): void {
    const draft = normalizeState(this.store.store)
    mutator(draft)
    this.store.store = draft
    this.onChanged()
  }
}
