import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

type ServerRuntime = {
  origin: string
  serverDir: string
  child: ChildProcess | null
  starting: Promise<void> | null
  lastStderr: string[]
  startedAt: number
  lastSpawn?: { command: string; args: string[]; cwd: string } | undefined
}

let runtime: ServerRuntime | null = null
let registeredExitHooks = false

function clampLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines
  return lines.slice(lines.length - max)
}

function pushStderrLine(line: string): void {
  if (!runtime) return
  const s = String(line ?? '').trimEnd()
  if (!s) return
  runtime.lastStderr = clampLines([...runtime.lastStderr, s], 80)
}

function normalizeOrigin(raw: string): string {
  const t = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!t) return ''
  // 兼容用户把 baseUrl 填成 http://127.0.0.1:3000/v1
  if (t.endsWith('/v1')) return t.slice(0, -3).replace(/\/+$/, '')
  return t
}

async function isHealthy(origin: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/+$/, '')}/health`, { method: 'GET', signal })
    return res.ok
  } catch {
    return false
  }
}

async function existsFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

async function existsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

function tryKillTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      // Windows：kill npm/tsx 这类父进程时，建议 taskkill /T
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
  } catch {
    // ignore
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // ignore
  }
}

export function stopDeepThinkServer(): void {
  if (!runtime?.child) return
  const pid = runtime.child.pid ?? 0
  runtime.child = null
  runtime.starting = null
  tryKillTree(pid)
}

function registerExitHooksOnce(): void {
  if (registeredExitHooks) return
  registeredExitHooks = true

  process.on('exit', () => stopDeepThinkServer())
  process.on('SIGINT', () => {
    stopDeepThinkServer()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stopDeepThinkServer()
    process.exit(0)
  })
}

export type EnsureDeepThinkServerArgs = {
  origin: string
  serverDir: string
  host?: string
  port?: number
  timeoutMs?: number
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  signal: AbortSignal
}

export async function ensureDeepThinkServerRunning(args: EnsureDeepThinkServerArgs): Promise<void> {
  const origin = normalizeOrigin(args.origin)
  if (!origin) throw new Error('deepthink server origin 不能为空')

  const url = new URL(origin)
  const host = typeof args.host === 'string' && args.host.trim() ? args.host.trim() : url.hostname || '127.0.0.1'
  const port = typeof args.port === 'number' && Number.isFinite(args.port) && args.port > 0 ? Math.trunc(args.port) : Number(url.port || 3000)
  const timeoutMs = typeof args.timeoutMs === 'number' ? Math.max(3000, Math.min(600000, Math.trunc(args.timeoutMs))) : 20000

  const serverDir = path.resolve(String(args.serverDir ?? '').trim() || path.resolve(process.cwd(), 'Prisma-main/server'))
  if (!(await existsDir(serverDir))) {
    throw new Error(`未找到 Prisma server 目录：${serverDir}`)
  }

  // 已经健康：直接返回（允许用户手动启动的 server）
  if (await isHealthy(origin, args.signal)) return

  if (runtime && runtime.origin === origin && runtime.serverDir === serverDir) {
    if (runtime.starting) {
      await runtime.starting
      return
    }
    if (runtime.child && (await isHealthy(origin, args.signal))) return
  }

  // 重新创建 runtime（本进程拥有）
  runtime = { origin, serverDir, child: null, starting: null, lastStderr: [], startedAt: Date.now(), lastSpawn: undefined }
  registerExitHooksOnce()

  runtime.starting = (async () => {
    const distEntry = path.join(serverDir, 'dist', 'index.js')
    const hasDist = await existsFile(distEntry)
    const hasPkg = await existsFile(path.join(serverDir, 'package.json'))
    if (!hasPkg) throw new Error(`Prisma server 缺少 package.json：${serverDir}`)

    const env: NodeJS.ProcessEnv = { ...process.env }
    env.PORT = String(port)
    env.HOST = String(host ?? '')
    if (typeof args.provider === 'string' && args.provider.trim()) env.PROVIDER = args.provider.trim()
    if (typeof args.baseUrl === 'string' && args.baseUrl.trim()) env.BASE_URL = args.baseUrl.trim()
    if (typeof args.apiKey === 'string' && args.apiKey.trim()) env.API_KEY = args.apiKey.trim()
    if (typeof args.model === 'string' && args.model.trim()) env.MODEL = args.model.trim()

    const isWin = process.platform === 'win32'
    // 注意：在 Electron 主进程里 process.execPath 通常是 Electron 可执行文件，不是 node.exe。
    // 因此这里不要用 process.execPath 跑 dist/index.js，而是显式调用 node（要求环境已安装 Node.js）。
    const command = hasDist ? (isWin ? 'node.exe' : 'node') : isWin ? (process.env.ComSpec || 'cmd.exe') : 'npm'
    const cmdArgs = hasDist ? [distEntry] : isWin ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev']
    runtime!.lastSpawn = { command, args: [...cmdArgs], cwd: serverDir }

    const child = spawn(command, cmdArgs, {
      cwd: serverDir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    runtime!.child = child
    runtime!.startedAt = Date.now()

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      // 只留 stderr 方便定位；stdout 太多的话会干扰
      if (text?.trim()) pushStderrLine(`[stdout] ${text.trim()}`)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) pushStderrLine(line)
      }
    })

    const exitPromise = new Promise<void>((_resolve, reject) => {
      child.once('exit', (code: number | null, sig: NodeJS.Signals | null) => {
        reject(new Error(`Prisma server exited (code=${code ?? 'null'} signal=${sig ?? 'null'})`))
      })
      child.once('error', (err: unknown) => {
        const detail = runtime?.lastSpawn
          ? `\n\n[spawn]\ncmd: ${runtime.lastSpawn.command} ${runtime.lastSpawn.args.join(' ')}\ncwd: ${runtime.lastSpawn.cwd}`
          : ''
        reject(new Error(`${err instanceof Error ? err.message : String(err)}${detail}`))
      })
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (args.signal.aborted) throw new Error('canceled')
      if (await isHealthy(origin, args.signal)) return
      await Promise.race([sleep(300), exitPromise])
    }

    const tail = runtime?.lastStderr?.slice(-20).join('\n') || ''
    const spawnInfo = runtime?.lastSpawn ? `\n\n[spawn]\ncmd: ${runtime.lastSpawn.command} ${runtime.lastSpawn.args.join(' ')}\ncwd: ${runtime.lastSpawn.cwd}` : ''
    throw new Error(`Prisma server 启动超时（${timeoutMs}ms）。${spawnInfo}${tail ? `\n\n[stderr tail]\n${tail}` : ''}`)
  })()

  try {
    await runtime.starting
  } finally {
    if (runtime) runtime.starting = null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.trunc(ms))))
}
