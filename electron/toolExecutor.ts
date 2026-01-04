import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getSettings } from './store'
import { isToolEnabled } from './toolRegistry'
import type { TaskRecord } from './types'

export type ToolInput = string | Record<string, unknown> | Array<unknown> | null

export type ToolExecutionContext = {
  task: TaskRecord
  userDataDir: string
  waitIfPaused: () => Promise<void>
  isCanceled: () => boolean
  setCancelCurrent: (fn: (() => void) | undefined) => void
}

function clampText(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

function clampStepOutput(text: string, maxChars: number): string {
  return clampText(text, maxChars)
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

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

export async function executeBuiltinTool(
  toolNameRaw: string,
  input: ToolInput,
  ctx: ToolExecutionContext,
  opts?: { maxStepOutputChars?: number },
): Promise<string> {
  const toolName = (toolNameRaw ?? '').trim()
  const maxStepOutputChars = typeof opts?.maxStepOutputChars === 'number' ? opts.maxStepOutputChars : 5000

  const settings = getSettings()
  if (!isToolEnabled(toolName, settings.tools)) {
    throw new Error(`tool disabled: ${toolName}`)
  }

  if (toolName === 'browser.open') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const url = typeof obj?.url === 'string' ? obj.url : typeof input === 'string' ? input : ''
    const appPath = typeof obj?.appPath === 'string' ? obj.appPath.trim() : ''
    const args = ensureStringArray(obj?.args, 60)

    if (!url || !/^https?:\/\//i.test(url)) throw new Error(`browser.open 需要有效 URL（http/https），当前：${url || '(空)'}`)

    if (appPath) {
      // 注意：ChildProcess 'error' 事件若无人监听会导致进程崩溃闪退。
      // 这里等待一次 'spawn' 或 'error'，确保 appPath 无效时不会把整个程序带崩。
      const child = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
        try {
          const cp = spawn(appPath, [...args, url], { windowsHide: true, detached: true, stdio: 'ignore' })
          cp.once('error', reject)
          cp.once('spawn', () => resolve(cp))
        } catch (err) {
          reject(err)
        }
      })
      child.unref()
      return `opened: ${url}\napp: ${appPath}`
    }

    const { shell } = await import('electron')
    await shell.openExternal(url)
    return `opened: ${url}`
  }

  if (toolName === 'browser.fetch') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const url = typeof obj?.url === 'string' ? obj.url : typeof input === 'string' ? input : ''
    const maxChars = typeof obj?.maxChars === 'number' ? Math.max(200, Math.min(20000, Math.trunc(obj.maxChars))) : 5000
    const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(120000, Math.trunc(obj.timeoutMs))) : 15000
    const wantStrip = obj?.stripHtml === true
    const headers = typeof obj?.headers === 'object' && obj.headers ? (obj.headers as Record<string, unknown>) : {}

    if (!url || !/^https?:\/\//i.test(url)) throw new Error(`browser.fetch 需要有效 URL（http/https），当前：${url || '(空)'}`)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('fetch timeout')), timeoutMs)
    ctx.setCancelCurrent(() => ac.abort(new Error('canceled')))

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
      const preview = clampStepOutput(body.slice(0, maxChars), maxStepOutputChars)
      return `HTTP ${res.status}\n${preview}`
    } finally {
      clearTimeout(timer)
      ctx.setCancelCurrent(undefined)
    }
  }

  if (toolName === 'browser.playwright') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const url = typeof obj?.url === 'string' ? obj.url : typeof input === 'string' ? input : ''
    const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(180000, Math.trunc(obj.timeoutMs))) : 45000
    const headless = obj?.headless !== false
    const channelRaw = typeof obj?.channel === 'string' ? obj.channel.trim() : ''
    const channel = channelRaw || (process.platform === 'win32' ? 'msedge' : '')

    const extractObj =
      typeof obj?.extract === 'object' && obj.extract && !Array.isArray(obj.extract) ? (obj.extract as Record<string, unknown>) : null
    const shouldExtract = !!extractObj
    const extractSelector = shouldExtract && typeof extractObj?.selector === 'string' ? String(extractObj.selector) : 'body'
    const extractFormatRaw = shouldExtract && typeof extractObj?.format === 'string' ? String(extractObj.format) : 'innerText'
    const extractFormat = ['innerText', 'text', 'html'].includes(extractFormatRaw) ? extractFormatRaw : 'innerText'
    const extractOptional = shouldExtract && extractObj?.optional === true
    const extractMaxChars =
      shouldExtract && typeof extractObj?.maxChars === 'number' ? Math.max(80, Math.min(10000, Math.trunc(extractObj.maxChars))) : 2000

    const screenshotObj =
      typeof obj?.screenshot === 'object' && obj.screenshot && !Array.isArray(obj.screenshot) ? (obj.screenshot as Record<string, unknown>) : null
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
    const profileDir = path.join(ctx.userDataDir, 'playwright', safeProfile)
    await fs.mkdir(profileDir, { recursive: true })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('playwright timeout')), timeoutMs)

    const context = await pw.chromium.launchPersistentContext(profileDir, {
      headless,
      channel: channel || undefined,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    })

    ctx.setCancelCurrent(() => {
      try {
        ac.abort(new Error('canceled'))
      } catch {
        // ignore
      }
      void context.close().catch(() => undefined)
    })

    try {
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

      for (const action of actions.slice(0, 30)) {
        if (ctx.isCanceled()) break
        await ctx.waitIfPaused()

        const type = typeof action?.type === 'string' ? action.type : ''
        if (!type) continue

        if (type === 'waitMs') {
          const ms = typeof action?.ms === 'number' ? Math.max(0, Math.min(60000, Math.trunc(action.ms))) : 500
          await page.waitForTimeout(ms)
          continue
        }

        if (type === 'waitForLoad') {
          const stateRaw = typeof action?.state === 'string' ? action.state : 'networkidle'
          const state = (['load', 'domcontentloaded', 'networkidle'].includes(stateRaw) ? stateRaw : 'networkidle') as
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
        extractPreview = extracted ? clampStepOutput(extracted.slice(0, extractMaxChars), maxStepOutputChars) : ''
      }

      let shotPath = ''
      if (screenshotObj) {
        const rel = screenshotPathRaw || `task-output/${ctx.task.id}-shot.png`
        const fullPath = path.isAbsolute(rel) ? rel : path.join(ctx.userDataDir, rel)
        await fs.mkdir(path.dirname(fullPath), { recursive: true })
        await page.screenshot({ path: fullPath, fullPage: screenshotFullPage, timeout: timeoutMs })
        shotPath = fullPath
      }

      const lines: string[] = []
      if (title) lines.push(`title: ${title}`)
      lines.push(`url: ${url}`)
      if (shotPath) lines.push(`screenshot: ${shotPath}`)
      if (extractPreview) lines.push(`extract(${extractSelector}): ${extractPreview}`)
      return clampStepOutput(lines.join('\n'), maxStepOutputChars)
    } finally {
      clearTimeout(timer)
      ctx.setCancelCurrent(undefined)
      await context.close().catch(() => undefined)
    }
  }

  if (toolName === 'file.write') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const relPath = typeof obj?.path === 'string' ? obj.path.trim() : ''
    const filename = typeof obj?.filename === 'string' ? obj.filename.trim() : ''
    const content = typeof obj?.content === 'string' ? obj.content : typeof input === 'string' ? input : ''
    const append = obj?.append === true
    const encoding = typeof obj?.encoding === 'string' ? obj.encoding : 'utf8'

    const safeName = filename ? filename.replace(/[<>:"/\\|?*]+/g, '_') : ''
    const fallbackName = `${ctx.task.id}-${Date.now()}.txt`
    const baseName = safeName || fallbackName
    const baseDir = path.join(ctx.userDataDir, 'task-output')
    const fullPath = relPath ? (path.isAbsolute(relPath) ? relPath : path.join(ctx.userDataDir, relPath)) : path.join(baseDir, baseName)

    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    if (append) await fs.appendFile(fullPath, content ?? '', { encoding: encoding as BufferEncoding })
    else await fs.writeFile(fullPath, content ?? '', { encoding: encoding as BufferEncoding })
    return `已写入：${fullPath}`
  }

  if (toolName === 'cli.exec') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(1000, Math.min(10 * 60_000, Math.trunc(obj.timeoutMs))) : 90_000
    const cwd = typeof obj?.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : process.cwd()
    const envObj = typeof obj?.env === 'object' && obj.env ? (obj.env as Record<string, unknown>) : null
    const encodingRaw = typeof obj?.encoding === 'string' ? obj.encoding.trim().toLowerCase() : ''
    const env = envObj
      ? (({
          ...process.env,
          ...Object.fromEntries(Object.entries(envObj).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
        } as unknown) as NodeJS.ProcessEnv)
      : process.env

    let cmd = ''
    let args: string[] = []

    if (obj && typeof obj.cmd === 'string' && obj.cmd.trim()) {
      cmd = obj.cmd.trim()
      args = ensureStringArray(obj.args, 80)
    } else if (obj && typeof obj.line === 'string' && obj.line.trim()) {
      const line = obj.line.trim()
      if (process.platform === 'win32') {
        // Windows 下对 PowerShell 的 `-Command "..."` 做特殊处理：
        // 避免 cmd.exe 的复杂转义导致 command 被当作“字符串字面量”输出，从而出现“只回显命令，不执行”的现象。
        const psMatch = line.match(/^(powershell|pwsh)(?:\.exe)?\b/i)
        const cmdMatch = psMatch ? line.match(/-(?:Command|c)\s+(.+)$/i) : null
        if (psMatch && cmdMatch) {
          const shell = psMatch[1].toLowerCase() === 'pwsh' ? 'pwsh' : 'powershell'
          let commandArg = String(cmdMatch[1] ?? '').trim()
          if (
            (commandArg.startsWith('"') && commandArg.endsWith('"') && commandArg.length >= 2) ||
            (commandArg.startsWith("'") && commandArg.endsWith("'") && commandArg.length >= 2)
          ) {
            commandArg = commandArg.slice(1, -1)
          }

          cmd = shell
          args = []
          if (/\s-(?:NoProfile|NoP)\b/i.test(line)) args.push('-NoProfile')
          args.push('-Command', commandArg)
        } else {
          cmd = 'cmd.exe'
          args = ['/d', '/s', '/c', line]
        }
      } else {
        cmd = 'sh'
        args = ['-lc', line]
      }
    } else if (typeof input === 'string') {
      const line = input.trim()
      if (!line) throw new Error('cli.exec 需要命令行字符串')
      if (process.platform === 'win32') {
        const psMatch = line.match(/^(powershell|pwsh)(?:\.exe)?\b/i)
        const cmdMatch = psMatch ? line.match(/-(?:Command|c)\s+(.+)$/i) : null
        if (psMatch && cmdMatch) {
          const shell = psMatch[1].toLowerCase() === 'pwsh' ? 'pwsh' : 'powershell'
          let commandArg = String(cmdMatch[1] ?? '').trim()
          if (
            (commandArg.startsWith('"') && commandArg.endsWith('"') && commandArg.length >= 2) ||
            (commandArg.startsWith("'") && commandArg.endsWith("'") && commandArg.length >= 2)
          ) {
            commandArg = commandArg.slice(1, -1)
          }

          cmd = shell
          args = []
          if (/\s-(?:NoProfile|NoP)\b/i.test(line)) args.push('-NoProfile')
          args.push('-Command', commandArg)
        } else {
          cmd = 'cmd.exe'
          args = ['/d', '/s', '/c', line]
        }
      } else {
        cmd = 'sh'
        args = ['-lc', line]
      }
    } else {
      throw new Error('cli.exec 输入格式不正确')
    }

    const child = spawn(cmd, args, { cwd, env, windowsHide: true })
    ctx.setCancelCurrent(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const pushChunk = (arr: Buffer[], chunk: Buffer) => {
      if (!chunk || chunk.length === 0) return
      arr.push(Buffer.from(chunk))
      let total = 0
      for (let i = arr.length - 1; i >= 0; i--) {
        total += arr[i].length
        if (total > 20000) {
          arr.splice(0, Math.max(0, i))
          break
        }
      }
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

    ctx.setCancelCurrent(undefined)

    const normalizeEncoding = (enc: string): 'auto' | 'utf8' | 'gbk' | 'utf16le' => {
      const e = (enc ?? '').trim().toLowerCase()
      if (!e || e === 'auto') return 'auto'
      if (e === 'utf-8' || e === 'utf8') return 'utf8'
      if (e === 'utf-16le' || e === 'utf16le' || e === 'utf16') return 'utf16le'
      if (e === 'gbk' || e === 'cp936' || e === 'gb2312') return 'gbk'
      return 'auto'
    }

    const decodeBytes = (buf: Buffer, enc: 'utf8' | 'gbk' | 'utf16le'): string => {
      if (!buf || buf.length === 0) return ''
      if (enc === 'utf16le') return buf.toString('utf16le')
      try {
        return new TextDecoder(enc).decode(buf)
      } catch {
        return buf.toString('utf8')
      }
    }

    const decodeAuto = (buf: Buffer): string => {
      if (!buf || buf.length === 0) return ''
      const utf8 = decodeBytes(buf, 'utf8')
      const nulRatio = utf8 ? (utf8.split('\u0000').length - 1) / utf8.length : 0
      if (nulRatio > 0.02) return decodeBytes(buf, 'utf16le')

      const replacementRatio = utf8 ? (utf8.split('\uFFFD').length - 1) / utf8.length : 0
      if (process.platform === 'win32' && replacementRatio > 0.01) {
        return decodeBytes(buf, 'gbk')
      }
      return utf8
    }

    const decode = (chunks: Buffer[]): string => {
      const buf = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
      const mode = normalizeEncoding(encodingRaw)
      if (mode === 'utf8') return decodeBytes(buf, 'utf8')
      if (mode === 'gbk') return decodeBytes(buf, 'gbk')
      if (mode === 'utf16le') return decodeBytes(buf, 'utf16le')
      return decodeAuto(buf)
    }

    const out = clampStepOutput(decode(stdoutChunks), maxStepOutputChars)
    const err = clampStepOutput(decode(stderrChunks), maxStepOutputChars)
    const header = `cmd: ${cmd} ${args.join(' ')}\ncode: ${exit.code ?? 'null'} signal: ${exit.signal ?? 'null'}`
    if (err) return `${header}\n\n[stderr]\n${err}\n\n[stdout]\n${out}`
    return `${header}\n\n[stdout]\n${out}`
  }

  if (toolName === 'delay.sleep') {
    const ms =
      typeof input === 'string'
        ? Math.max(0, Math.min(300000, Math.trunc(Number(input))))
        : typeof (input as Record<string, unknown>)?.ms === 'number'
          ? Math.max(0, Math.min(300000, Math.trunc((input as Record<string, unknown>).ms as number)))
          : 200
    await sleep(ms)
    return `sleep ${ms}ms`
  }

  if (toolName === 'llm.summarize' || toolName === 'llm.chat') {
    const obj = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const prompt = typeof obj?.prompt === 'string' ? obj.prompt : typeof input === 'string' ? input : ''
    if (!prompt.trim()) throw new Error(`${toolName} 需要 prompt`)

    const appSettings = settings
    const baseUrl = (typeof obj?.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl.trim() : appSettings.ai.baseUrl).trim()
    const apiKey = typeof obj?.apiKey === 'string' ? obj.apiKey : appSettings.ai.apiKey
    const model = (typeof obj?.model === 'string' && obj.model.trim() ? obj.model.trim() : appSettings.ai.model).trim()
    const temperature =
      typeof obj?.temperature === 'number'
        ? Math.max(0, Math.min(2, obj.temperature))
        : Math.max(0, Math.min(2, appSettings.ai.temperature))
    const maxTokens = typeof obj?.maxTokens === 'number' ? Math.max(64, Math.min(8192, Math.trunc(obj.maxTokens))) : 1200
    const timeoutMs = typeof obj?.timeoutMs === 'number' ? Math.max(2000, Math.min(180000, Math.trunc(obj.timeoutMs))) : 60000

    // 只有一个“人设”来源：AI 设置里的 systemPrompt（除非调用方显式传入 system 覆盖）
    const system = typeof obj?.system === 'string' ? obj.system : String(appSettings.ai.systemPrompt ?? '').trim()
    const userPrompt =
      toolName === 'llm.summarize'
        ? `请把下面内容总结成：标题（1行）+ 要点列表（<=8条）。\n\n${prompt}`
        : prompt

    if (!baseUrl || !model) throw new Error('未配置 LLM baseUrl/model（设置 → AI 设置）')

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs)
    ctx.setCancelCurrent(() => ac.abort(new Error('canceled')))

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
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: userPrompt },
          ],
        }),
      })

      const data = (await res.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> }
      if (!res.ok) {
        const errMsg = data?.error?.message || `HTTP ${res.status}`
        throw new Error(errMsg)
      }

      const content = data?.choices?.[0]?.message?.content ?? ''
      return clampStepOutput(content || '(空)', maxStepOutputChars)
    } finally {
      clearTimeout(timer)
      ctx.setCancelCurrent(undefined)
    }
  }

  throw new Error(`未知 tool：${toolName}`)
}
