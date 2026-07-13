import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'

const MANAGED_BROWSERS_DIR = 'playwright-browsers'
const require = createRequire(import.meta.url)
const installs = new Map<string, Promise<void>>()

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

export async function resolveManagedBrowsersPath(options: {
  configured?: string
  resourcesPath?: string
  cwd: string
  userDataDir: string
}): Promise<string> {
  const configured = String(options.configured ?? '').trim()
  if (configured) return path.resolve(configured)

  const candidates = [
    options.resourcesPath ? path.join(options.resourcesPath, MANAGED_BROWSERS_DIR) : '',
    path.join(options.cwd, MANAGED_BROWSERS_DIR),
    path.join(options.userDataDir, MANAGED_BROWSERS_DIR),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate
  }
  return path.join(options.userDataDir, MANAGED_BROWSERS_DIR)
}

export async function configureManagedBrowsersPath(userDataDir: string): Promise<string> {
  const selected = await resolveManagedBrowsersPath({
    configured: process.env.PLAYWRIGHT_BROWSERS_PATH,
    resourcesPath: String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '').trim(),
    cwd: process.cwd(),
    userDataDir,
  })
  await fs.mkdir(selected, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = selected
  return selected
}

export function isMissingPlaywrightBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Executable doesn't exist") || message.includes('playwright install')
}

function resolvePlaywrightCliPath(): string {
  const packagePath = require.resolve('playwright-core/package.json')
  const cliPath = path.join(path.dirname(packagePath), 'cli.js')
  return cliPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

export function installManagedPlaywrightBrowser(browsersPath: string): Promise<void> {
  const resolved = path.resolve(browsersPath)
  const existing = installs.get(resolved)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [resolvePlaywrightCliPath(), 'install', 'chromium-headless-shell'], {
      cwd: path.dirname(resolved),
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        PLAYWRIGHT_BROWSERS_PATH: resolved,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Playwright Chromium 安装失败（exit=${code ?? 'unknown'}）。${output.trim()}`))
    })
  }).finally(() => installs.delete(resolved))

  installs.set(resolved, promise)
  return promise
}
