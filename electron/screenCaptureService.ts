import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type ScreenCaptureRegion = {
  x: number
  y: number
  width: number
  height: number
  absolute?: boolean
}

export type ScreenCaptureOptions = {
  userDataDir: string
  taskId?: string
  target?: 'primary' | 'cursor' | 'all' | 'display'
  displayIndex?: number
  displayId?: string | number
  region?: ScreenCaptureRegion | null
  path?: string
  returnDataUrl?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

type ScreenDisplay = {
  deviceName: string
  index: number
  primary: boolean
  x: number
  y: number
  width: number
  height: number
}

type ScreenPoint = { x: number; y: number }
type ScreenRect = ScreenPoint & { width: number; height: number }

type ScreenSnapshot = {
  displays: ScreenDisplay[]
  cursor: ScreenPoint
}

export type ScreenCaptureResult = {
  ok: true
  capturedAt: string
  target: 'primary' | 'cursor' | 'all' | 'display'
  display?: ScreenDisplay
  displays: ScreenDisplay[]
  region: ScreenRect
  path: string
  mimeType: 'image/png'
  bytes: number
  dataUrl?: string
}

function clampInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.trunc(n)
}

function psEscapeSingleQuoted(value: string): string {
  return String(value ?? '').replace(/'/g, "''")
}

function encodePowerShell(script: string): string {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
}

function dpiAwarePreludePs(): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiAwareness {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int value);
}
'@
try {
  [void][DpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  try { [void][DpiAwareness]::SetProcessDpiAwareness(2) } catch {
    try { [void][DpiAwareness]::SetProcessDPIAware() } catch { }
  }
}
`.trim()
}

async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(Math.trunc(pid)), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
      return
    }
    try {
      process.kill(Math.trunc(pid), 'SIGTERM')
    } catch {
      // ignore
    }
    resolve()
  })
}

async function runPowerShell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== 'win32') {
    throw new Error('screen.capture 目前仅支持 Windows 内置截图')
  }

  const encoded = encodePowerShell(script)
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
  )

  let stdout = ''
  let stderr = ''
  let settled = false

  return await new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const failAndKill = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void killProcessTree(child.pid ?? 0).finally(() => reject(err))
    }

    const onAbort = () => failAndKill(new Error('screen.capture canceled'))
    const timer = setTimeout(() => failAndKill(new Error(`screen.capture timeout (${timeoutMs}ms)`)), Math.max(1, timeoutMs))

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d) => {
      stdout += Buffer.isBuffer(d) ? d.toString('utf8') : String(d ?? '')
    })
    child.stderr?.on('data', (d) => {
      stderr += Buffer.isBuffer(d) ? d.toString('utf8') : String(d ?? '')
    })
    child.once('error', (err) => finish(() => reject(err)))
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code ?? 'null'}`))
      })
    })
  })
}

function nowLocalIso(): string {
  const d = new Date()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad3 = (n: number) => String(n).padStart(3, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

async function readScreenSnapshot(timeoutMs: number, signal?: AbortSignal): Promise<ScreenSnapshot> {
  const script = `
${dpiAwarePreludePs()}
Add-Type -AssemblyName System.Windows.Forms
$items = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    deviceName = $_.DeviceName
    primary = $_.Primary
    x = $_.Bounds.X
    y = $_.Bounds.Y
    width = $_.Bounds.Width
    height = $_.Bounds.Height
  }
})
$cursor = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{
  displays = $items
  cursor = [pscustomobject]@{ x = $cursor.X; y = $cursor.Y }
} | ConvertTo-Json -Depth 6 -Compress
`.trim()

  const { stdout } = await runPowerShell(script, timeoutMs, signal)
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
  const displaysRaw = Array.isArray(parsed.displays) ? parsed.displays : []
  const displays = displaysRaw
    .map((m, index) => {
      const obj = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null
      return {
        deviceName: String(obj?.deviceName ?? ''),
        index,
        primary: Boolean(obj?.primary),
        x: Number(obj?.x ?? 0),
        y: Number(obj?.y ?? 0),
        width: Number(obj?.width ?? 0),
        height: Number(obj?.height ?? 0),
      }
    })
    .filter((d) => d.deviceName && Number.isFinite(d.x) && Number.isFinite(d.y) && d.width > 0 && d.height > 0)

  const cursorObj = parsed.cursor && typeof parsed.cursor === 'object' && !Array.isArray(parsed.cursor) ? (parsed.cursor as Record<string, unknown>) : null
  const cursor = { x: Number(cursorObj?.x ?? 0), y: Number(cursorObj?.y ?? 0) }

  if (displays.length === 0) throw new Error('screen.capture 未找到显示器')
  return { displays, cursor }
}

function containsPoint(rect: ScreenRect, point: ScreenPoint): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
}

function unionDisplays(displays: ScreenDisplay[]): ScreenRect {
  const left = Math.min(...displays.map((d) => d.x))
  const top = Math.min(...displays.map((d) => d.y))
  const right = Math.max(...displays.map((d) => d.x + d.width))
  const bottom = Math.max(...displays.map((d) => d.y + d.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function resolveDisplay(snapshot: ScreenSnapshot, opts: ScreenCaptureOptions): ScreenDisplay {
  const displays = snapshot.displays
  const byIndex = typeof opts.displayIndex === 'number' ? displays[opts.displayIndex] : null
  if (byIndex) return byIndex

  const idRaw = opts.displayId
  const id = typeof idRaw === 'number' ? String(Math.trunc(idRaw)) : typeof idRaw === 'string' ? idRaw.trim() : ''
  if (id) {
    const index = Number(id)
    if (Number.isInteger(index) && displays[index]) return displays[index]
    const byName = displays.find((d) => d.deviceName.toLowerCase() === id.toLowerCase())
    if (byName) return byName
  }

  if (opts.target === 'cursor') {
    const hit = displays.find((d) => containsPoint(d, snapshot.cursor))
    if (hit) return hit
  }

  return displays.find((d) => d.primary) ?? displays[0]
}

function resolveCaptureRect(snapshot: ScreenSnapshot, opts: ScreenCaptureOptions): { target: ScreenCaptureResult['target']; display?: ScreenDisplay; rect: ScreenRect } {
  const hasDisplaySelector = typeof opts.displayIndex === 'number' || opts.displayId !== undefined
  const target = opts.target ?? (hasDisplaySelector ? 'display' : 'primary')

  const display = target === 'all' ? undefined : resolveDisplay(snapshot, { ...opts, target })
  const base =
    target === 'all'
      ? unionDisplays(snapshot.displays)
      : {
          x: display!.x,
          y: display!.y,
          width: display!.width,
          height: display!.height,
        }

  const region = opts.region
  if (!region) return { target, display, rect: base }

  const width = clampInt(region.width, 0)
  const height = clampInt(region.height, 0)
  const rx = clampInt(region.x, 0)
  const ry = clampInt(region.y, 0)
  const x = region.absolute === true ? rx : base.x + rx
  const y = region.absolute === true ? ry : base.y + ry
  return { target, display, rect: { x, y, width, height } }
}

function validateRect(rect: ScreenRect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error('screen.capture region 数值非法')
  if (rect.width <= 0 || rect.height <= 0) throw new Error('screen.capture region width/height 必须大于 0')
  if (rect.width > 20000 || rect.height > 20000 || rect.width * rect.height > 100_000_000) {
    throw new Error(`screen.capture region 过大：${rect.width}x${rect.height}`)
  }
}

function normalizeOutputPath(opts: ScreenCaptureOptions): string {
  const safeTaskId = String(opts.taskId ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'screen'
  const raw = String(opts.path ?? '').trim() || path.join('screenshots', `${safeTaskId}-${Date.now().toString(36)}.png`)
  const withExt = path.extname(raw) ? raw : `${raw}.png`
  return path.resolve(path.isAbsolute(withExt) ? withExt : path.join(opts.userDataDir, withExt))
}

async function captureRectToPng(rect: ScreenRect, outPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const script = `
${dpiAwarePreludePs()}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$x = ${Math.trunc(rect.x)}
$y = ${Math.trunc(rect.y)}
$w = ${Math.trunc(rect.width)}
$h = ${Math.trunc(rect.height)}
$out = '${psEscapeSingleQuoted(outPath)}'
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
`.trim()

  await runPowerShell(script, timeoutMs, signal)
}

export async function captureScreenToFile(opts: ScreenCaptureOptions): Promise<ScreenCaptureResult> {
  const timeoutMs = Math.max(1000, Math.min(120000, clampInt(opts.timeoutMs, 30000)))
  const snapshot = await readScreenSnapshot(Math.min(timeoutMs, 15000), opts.signal)
  const { target, display, rect } = resolveCaptureRect(snapshot, opts)
  validateRect(rect)

  const outPath = normalizeOutputPath(opts)
  await captureRectToPng(rect, outPath, timeoutMs, opts.signal)
  const stat = await fs.stat(outPath)
  const result: ScreenCaptureResult = {
    ok: true,
    capturedAt: nowLocalIso(),
    target,
    display,
    displays: snapshot.displays,
    region: rect,
    path: outPath,
    mimeType: 'image/png',
    bytes: stat.size,
  }

  if (opts.returnDataUrl === true) {
    const buf = await fs.readFile(outPath)
    result.dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  }

  return result
}
