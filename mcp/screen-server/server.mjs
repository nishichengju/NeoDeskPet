import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function nowIso() {
  return new Date().toISOString()
}

function nowBeijingIso() {
  const ms = Date.now() + 8 * 60 * 60 * 1000
  const d = new Date(ms)
  const pad2 = (n) => String(n).padStart(2, '0')
  const pad3 = (n) => String(n).padStart(3, '0')
  const yyyy = d.getUTCFullYear()
  const mm = pad2(d.getUTCMonth() + 1)
  const dd = pad2(d.getUTCDate())
  const hh = pad2(d.getUTCHours())
  const mi = pad2(d.getUTCMinutes())
  const ss = pad2(d.getUTCSeconds())
  const sss = pad3(d.getUTCMilliseconds())
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${sss}+08:00`
}

function psEscapeSingleQuoted(s) {
  return String(s ?? '').replace(/'/g, "''")
}

function encodePwshCommandUtf16leBase64(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
}

function dpiAwarePreludePs() {
  return `
# Try to make this PowerShell process DPI-aware (fixes scaled Screen.Bounds / CopyFromScreen on high DPI)
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
  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
  [void][DpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  try {
    # PROCESS_PER_MONITOR_DPI_AWARE = 2
    [void][DpiAwareness]::SetProcessDpiAwareness(2)
  } catch {
    try { [void][DpiAwareness]::SetProcessDPIAware() } catch { }
  }
}
`.trim()
}

async function runPowershell(script, timeoutMs = 30_000) {
  const encoded = encodePwshCommandUtf16leBase64(script)
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    )

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      reject(new Error(`PowerShell 执行超时（${timeoutMs}ms）`))
    }, Math.max(1, Math.trunc(timeoutMs)))

    child.stdout.on('data', (d) => {
      stdout += Buffer.isBuffer(d) ? d.toString('utf8') : String(d ?? '')
    })
    child.stderr.on('data', (d) => {
      stderr += Buffer.isBuffer(d) ? d.toString('utf8') : String(d ?? '')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      const msg = stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}`
      reject(new Error(msg))
    })
  })
}

async function listMonitors() {
  const script = `
${dpiAwarePreludePs()}

Add-Type -AssemblyName System.Windows.Forms
$items = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    deviceName = $_.DeviceName
    primary = $_.Primary
    x = $_.Bounds.X
    y = $_.Bounds.Y
    width = $_.Bounds.Width
    height = $_.Bounds.Height
  }
}
$items | ConvertTo-Json -Depth 4 -Compress
`.trim()

  const { stdout } = await runPowershell(script)
  const raw = stdout.trim()
  const parsed = raw ? JSON.parse(raw) : []
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr
    .map((m) => ({
      deviceName: String(m?.deviceName ?? ''),
      primary: Boolean(m?.primary),
      x: Number(m?.x ?? 0),
      y: Number(m?.y ?? 0),
      width: Number(m?.width ?? 0),
      height: Number(m?.height ?? 0),
    }))
    .filter((m) => m.deviceName && Number.isFinite(m.x) && Number.isFinite(m.y) && m.width > 0 && m.height > 0)
}

function resolveOutDir() {
  const fromEnv = String(process.env.NDP_SCREEN_OUT_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  return path.join(os.tmpdir(), 'ndp-screen-capture')
}

async function captureToFile({ x, y, width, height, outPath, timeoutMs }) {
  const script = `
${dpiAwarePreludePs()}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$x = ${Math.trunc(x)}
$y = ${Math.trunc(y)}
$w = ${Math.trunc(width)}
$h = ${Math.trunc(height)}
$out = '${psEscapeSingleQuoted(outPath)}'
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`.trim()

  await runPowershell(script, timeoutMs)
}

async function captureOnce(args) {
  const monitors = await listMonitors()
  if (monitors.length === 0) throw new Error('未找到显示器（AllScreens 为空）')

  const monitorIndex = typeof args.monitorIndex === 'number' ? args.monitorIndex : null
  const monitorDeviceName = typeof args.monitorDeviceName === 'string' ? args.monitorDeviceName.trim() : ''

  const primaryIdx = monitors.findIndex((m) => m.primary)
  const defaultIdx = primaryIdx >= 0 ? primaryIdx : 0

  const selectedMonitor = (() => {
    if (monitorDeviceName) return monitors.find((m) => m.deviceName === monitorDeviceName) ?? null
    if (monitorIndex === null) return monitors[defaultIdx] ?? null
    if (monitorIndex >= 0 && monitorIndex < monitors.length) return monitors[monitorIndex] ?? null
    return null
  })()
  if (!selectedMonitor) throw new Error('monitor 选择无效（monitorIndex/monitorDeviceName）')

  const region = args.region ?? null
  const target = region
    ? { x: region.x, y: region.y, width: region.width, height: region.height }
    : { x: selectedMonitor.x, y: selectedMonitor.y, width: selectedMonitor.width, height: selectedMonitor.height }

  if (![target.x, target.y, target.width, target.height].every(Number.isFinite)) throw new Error('region 数值非法')
  if (target.width <= 0 || target.height <= 0) throw new Error('region width/height 必须 > 0')

  const outDir = resolveOutDir()
  await fs.mkdir(outDir, { recursive: true })

  const fileName = `screen-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
  const outPath = path.join(outDir, fileName)

  await captureToFile({
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    outPath,
    timeoutMs: args.timeoutMs ?? 30_000,
  })

  const returnMode = (args.returnMode ?? 'path').trim()
  const base = {
    ok: true,
    capturedAt: nowBeijingIso(),
    monitor: { deviceName: selectedMonitor.deviceName, index: monitors.indexOf(selectedMonitor) },
    region: { x: target.x, y: target.y, width: target.width, height: target.height },
    path: outPath,
  }

  if (returnMode === 'dataUrl' || returnMode === 'base64') {
    const buf = await fs.readFile(outPath)
    const b64 = buf.toString('base64')
    return {
      ...base,
      base64: returnMode === 'base64' ? b64 : undefined,
      dataUrl: returnMode === 'dataUrl' ? `data:image/png;base64,${b64}` : undefined,
    }
  }

  return base
}

let watchTimer = null
let watchLast = null
let watchCfg = null

async function watchStart(args) {
  const fps = Math.max(0.1, Math.min(10, Number(args.fps ?? 1)))
  const intervalMs = Math.max(100, Math.trunc(1000 / fps))
  const cfg = { ...args, fps, intervalMs }

  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }

  watchCfg = cfg

  // 先立即抓一帧，避免 peek 时为空
  watchLast = await captureOnce(cfg)

  watchTimer = setInterval(() => {
    void captureOnce(cfg)
      .then((res) => {
        watchLast = res
      })
      .catch((err) => {
        watchLast = { ok: false, error: err instanceof Error ? err.message : String(err), at: nowBeijingIso() }
      })
  }, intervalMs)

  return { ok: true, startedAt: nowBeijingIso(), fps, intervalMs }
}

function watchStop() {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  watchCfg = null
  watchLast = null
  return { ok: true, stoppedAt: nowBeijingIso() }
}

function watchPeek() {
  if (!watchCfg) return { ok: false, error: 'watch 未启动' }
  if (!watchLast) return { ok: false, error: 'watch 尚未产出截图' }
  return watchLast
}

async function main() {
  if (process.argv.includes('--selftest')) {
    const res = await captureOnce({ returnMode: 'path' })
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    return
  }

  const server = new McpServer(
    { name: 'ndp-screen-capture', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.tool(
    'monitors',
    '列出当前显示器（虚拟桌面坐标）。',
    z.object({}),
    async () => {
      const monitors = await listMonitors()
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, monitors }, null, 2) }] }
    },
  )

  server.tool(
    'capture',
    '截图：默认截主屏；支持选择显示器、截取区域。返回本地文件路径（可选 dataUrl/base64）。',
    z.object({
      monitorIndex: z.number().int().min(0).optional().describe('按 AllScreens 下标选择显示器（0-based）'),
      monitorDeviceName: z.string().optional().describe('按 Screen.DeviceName 选择显示器（优先于 monitorIndex）'),
      region: z
        .object({
          x: z.number().int(),
          y: z.number().int(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional()
        .describe('虚拟桌面坐标（绝对坐标）。不填则截取整个显示器。'),
      returnMode: z.enum(['path', 'dataUrl', 'base64']).optional().describe('返回模式：默认 path'),
      timeoutMs: z.number().int().min(1000).max(120000).optional().describe('截图超时（毫秒）'),
    }),
    async (args) => {
      const res = await captureOnce(args)
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
    },
  )

  server.tool(
    'watch_start',
    '开始后台截图（轮询），并缓存最新一帧；配合 watch_peek 取最新截图。',
    z.object({
      fps: z.number().min(0.1).max(10).optional().describe('每秒截图次数（建议 0.5~2）'),
      monitorIndex: z.number().int().min(0).optional(),
      monitorDeviceName: z.string().optional(),
      region: z
        .object({
          x: z.number().int(),
          y: z.number().int(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
      returnMode: z.enum(['path', 'dataUrl', 'base64']).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
    }),
    async (args) => {
      const res = await watchStart(args)
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
    },
  )

  server.tool(
    'watch_peek',
    '获取 watch 的最新截图（不会主动截图）。',
    z.object({}),
    async () => ({ content: [{ type: 'text', text: JSON.stringify(watchPeek(), null, 2) }] }),
  )

  server.tool(
    'watch_stop',
    '停止后台截图 watch。',
    z.object({}),
    async () => ({ content: [{ type: 'text', text: JSON.stringify(watchStop(), null, 2) }] }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err)
  process.stderr.write(`[ndp-screen-capture] fatal: ${msg}\n`)
  process.exit(1)
})
