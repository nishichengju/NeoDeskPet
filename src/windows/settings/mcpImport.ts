import type { McpServerConfig } from '../../../electron/types'

export function parseMcpImportText(text: string): { servers: McpServerConfig[] } {
  const raw = (text ?? '').trim()
  if (!raw) throw new Error('请输入 JSON')

  const obj = JSON.parse(raw) as unknown

  const acceptObjectServers = (value: unknown): McpServerConfig[] => {
    const serversObj = typeof value === 'object' && value && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    if (!serversObj) return []

    const out: McpServerConfig[] = []
    for (const [idRaw, cfgRaw] of Object.entries(serversObj)) {
      const id = String(idRaw ?? '').trim()
      if (!id) continue
      const cfg = typeof cfgRaw === 'object' && cfgRaw && !Array.isArray(cfgRaw) ? (cfgRaw as Record<string, unknown>) : null
      if (!cfg) continue

      const command = typeof cfg.command === 'string' ? cfg.command : ''
      const args = Array.isArray(cfg.args) ? cfg.args.filter((x) => typeof x === 'string') : []
      const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
      const env =
        typeof cfg.env === 'object' && cfg.env && !Array.isArray(cfg.env)
          ? Object.fromEntries(Object.entries(cfg.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
          : {}

      out.push({
        id,
        enabled: cfg.enabled === false ? false : true,
        label: typeof cfg.label === 'string' ? cfg.label : id,
        transport: 'stdio',
        command,
        args,
        cwd,
        env,
      })
    }
    return out
  }

  const acceptArrayServers = (value: unknown): McpServerConfig[] => {
    if (!Array.isArray(value)) return []
    const out: McpServerConfig[] = []
    for (const it of value) {
      const cfg = typeof it === 'object' && it && !Array.isArray(it) ? (it as Record<string, unknown>) : null
      if (!cfg) continue
      const id = typeof cfg.id === 'string' ? cfg.id.trim() : ''
      if (!id) continue
      const command = typeof cfg.command === 'string' ? cfg.command : ''
      const args = Array.isArray(cfg.args) ? cfg.args.filter((x) => typeof x === 'string') : []
      const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
      const env =
        typeof cfg.env === 'object' && cfg.env && !Array.isArray(cfg.env)
          ? Object.fromEntries(Object.entries(cfg.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
          : {}

      out.push({
        id,
        enabled: cfg.enabled === false ? false : true,
        label: typeof cfg.label === 'string' ? cfg.label : id,
        transport: 'stdio',
        command,
        args,
        cwd,
        env,
      })
    }
    return out
  }

  // Support common Claude/Codex object exports, the app's array export, and direct arrays.
  const fromObject = acceptObjectServers((obj as { mcpServers?: unknown }).mcpServers)
  const fromServersArray = acceptArrayServers((obj as { servers?: unknown }).servers)
  const fromDirectArray = acceptArrayServers(obj)
  const servers = fromObject.length ? fromObject : fromServersArray.length ? fromServersArray : fromDirectArray

  if (!servers.length) throw new Error('未解析到任何 MCP Server（支持 {mcpServers:{...}} 或 {servers:[...]}）')
  return { servers }
}
