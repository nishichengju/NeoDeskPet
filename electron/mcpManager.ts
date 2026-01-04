import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpServerState, McpServerStatus, McpSettings, McpStateSnapshot, McpToolSummary } from './types'
import type { ToolCostLevel, ToolDefinition, ToolRiskLevel } from './toolRegistry'

type McpServerRuntime = {
  generation: number
  config: McpServerConfig
  status: McpServerStatus
  client: Client | null
  transport: StdioClientTransport | null
  tools: ToolDefinition[]
  toolSummaries: McpToolSummary[]
  lastError?: string
  stderrTail: string[]
  updatedAt: number
  startPromise?: Promise<void>
  stopPromise?: Promise<void>
}

function now(): number {
  return Date.now()
}

function clampText(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max) + '…'
}

function normalizeServerId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned
}

function stableHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 10)
}

function sanitizeCallNamePart(raw: string, maxLen: number): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return ''
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen)
}

function makeMcpCallName(serverId: string, toolName: string): string {
  const s = sanitizeCallNamePart(serverId, 18) || 'server'
  const t = sanitizeCallNamePart(toolName, 22) || 'tool'
  const base = `ndp_mcp_${s}_${t}`
  if (base.length <= 64) return base

  const hash = stableHash(`${serverId}:${toolName}`)
  const compact = `ndp_mcp_${s}_${hash}`
  if (compact.length <= 64) return compact
  return `ndp_mcp_${hash}`.slice(0, 64)
}

function toRiskAndCost(tool: {
  annotations?: { destructiveHint?: boolean; openWorldHint?: boolean; readOnlyHint?: boolean } | undefined
}): { risk: ToolRiskLevel; cost: ToolCostLevel } {
  const a = tool.annotations
  const risk: ToolRiskLevel = a?.destructiveHint ? 'high' : a?.openWorldHint ? 'medium' : 'low'
  const cost: ToolCostLevel = a?.openWorldHint ? 'high' : 'medium'
  return { risk, cost }
}

async function listAllTools(client: McpClient): Promise<
  Array<{
    name: string
    title?: string
    description?: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    annotations?: { destructiveHint?: boolean; openWorldHint?: boolean; readOnlyHint?: boolean } | undefined
  }>
> {
  const out: Array<{
    name: string
    title?: string
    description?: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    annotations?: { destructiveHint?: boolean; openWorldHint?: boolean; readOnlyHint?: boolean; idempotentHint?: boolean } | undefined
  }> = []

  let cursor: string | undefined = undefined
  for (let i = 0; i < 20; i += 1) {
    const res = await client.listTools(cursor ? { cursor } : undefined)
    const tools = Array.isArray(res.tools) ? res.tools : []
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue
      out.push({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        outputSchema: (t.outputSchema ?? undefined) as Record<string, unknown> | undefined,
        annotations: (t.annotations ?? undefined) as { destructiveHint?: boolean; openWorldHint?: boolean; readOnlyHint?: boolean } | undefined,
      })
    }
    cursor = res.nextCursor
    if (!cursor) break
  }

  return out
}

function parseMcpInternalToolName(toolName: string): { serverId: string; rawToolName: string } | null {
  const name = (toolName ?? '').trim()
  if (!name.startsWith('mcp.')) return null
  const parts = name.split('.').filter(Boolean)
  if (parts.length < 3) return null
  const serverId = parts[1]
  const rawToolName = parts.slice(2).join('.')
  if (!serverId || !rawToolName) return null
  return { serverId, rawToolName }
}

function formatMcpToolResult(result: unknown): string {
  type McpToolCallResult = {
    content?: unknown
    structuredContent?: unknown
    toolResult?: unknown
  }

  type McpContentItem = {
    type?: unknown
    text?: unknown
    mimeType?: unknown
    resource?: unknown
    uri?: unknown
    name?: unknown
  } & Record<string, unknown>

  const r: McpToolCallResult | null = typeof result === 'object' && result ? (result as McpToolCallResult) : null
  if (!r) return clampText(result, 5000) || '(空)'

  const lines: string[] = []

  const content = Array.isArray(r.content) ? (r.content as McpContentItem[]) : null
  if (content) {
    for (const item of content) {
      const type = typeof item?.type === 'string' ? item.type : ''
      if (type === 'text') {
        const text = typeof item.text === 'string' ? item.text : ''
        if (text.trim()) lines.push(text.trim())
        continue
      }
      if (type === 'image') {
        const mimeType = typeof item.mimeType === 'string' ? item.mimeType : ''
        lines.push(`[image${mimeType ? ` ${mimeType}` : ''}]`)
        continue
      }
      if (type === 'audio') {
        const mimeType = typeof item.mimeType === 'string' ? item.mimeType : ''
        lines.push(`[audio${mimeType ? ` ${mimeType}` : ''}]`)
        continue
      }
      if (type === 'resource') {
        const resource = typeof item.resource === 'object' && item.resource ? (item.resource as Record<string, unknown>) : null
        const uri = typeof resource?.uri === 'string' ? resource.uri : ''
        const text = typeof resource?.text === 'string' ? resource.text : ''
        if (uri) lines.push(`resource: ${uri}`)
        if (text.trim()) lines.push(text.trim())
        continue
      }
      if (type === 'resource_link') {
        const uri = typeof item.uri === 'string' ? item.uri : ''
        const nm = typeof item.name === 'string' ? item.name : ''
        if (uri) lines.push(`resource_link: ${nm || uri} (${uri})`)
        continue
      }
    }
  }

  const structured = r.structuredContent
  if (structured && typeof structured === 'object') {
    try {
      lines.push(`structured: ${JSON.stringify(structured)}`)
    } catch {
      // ignore
    }
  }

  const toolResult = r.toolResult
  if (toolResult != null) {
    try {
      lines.push(`toolResult: ${JSON.stringify(toolResult)}`)
    } catch {
      lines.push(`toolResult: ${String(toolResult)}`)
    }
  }

  const text = lines.join('\n').trim()
  return clampText(text, 5000) || '(空)'
}

export class McpManager {
  private currentSettings: McpSettings = { enabled: false, servers: [] }
  private readonly runtimes = new Map<string, McpServerRuntime>()
  private readonly listeners = new Set<(snapshot: McpStateSnapshot) => void>()

  onChanged(listener: (snapshot: McpStateSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    const snap = this.getSnapshot()
    for (const fn of this.listeners) {
      try {
        fn(snap)
      } catch {
        // ignore
      }
    }
  }

  getSnapshot(): McpStateSnapshot {
    const servers: McpServerState[] = []
    const ts = now()
    const ordered = Array.isArray(this.currentSettings.servers) ? this.currentSettings.servers : []

    for (const cfg of ordered) {
      const rid = normalizeServerId(cfg.id) || cfg.id
      const rt = this.runtimes.get(rid) ?? null
      const pid =
        typeof (rt?.transport as unknown as { pid?: unknown })?.pid === 'number'
          ? ((rt!.transport as unknown as { pid: number }).pid as number)
          : typeof (rt?.transport as unknown as { process?: { pid?: unknown } })?.process?.pid === 'number'
            ? ((rt!.transport as unknown as { process: { pid: number } }).process.pid as number)
            : null
      servers.push({
        id: rid,
        enabled: cfg.enabled !== false,
        label: cfg.label,
        transport: cfg.transport,
        command: cfg.command,
        args: cfg.args ?? [],
        cwd: cfg.cwd,
        status: rt?.status ?? 'disconnected',
        pid,
        lastError: rt?.lastError,
        stderrTail: rt?.stderrTail?.slice(-30) ?? [],
        tools: rt?.toolSummaries ?? [],
        updatedAt: rt?.updatedAt ?? ts,
      })
    }

    return { enabled: this.currentSettings.enabled !== false, servers, updatedAt: ts }
  }

  getToolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = []
    const ordered = Array.isArray(this.currentSettings.servers) ? this.currentSettings.servers : []
    for (const cfg of ordered) {
      const id = normalizeServerId(cfg.id) || cfg.id
      const rt = this.runtimes.get(id)
      if (!rt) continue
      if (rt.status !== 'connected') continue
      out.push(...(rt.tools ?? []))
    }
    return out
  }

  async sync(settings: McpSettings): Promise<void> {
    this.currentSettings = settings

    const enabled = settings.enabled !== false
    const servers = Array.isArray(settings.servers) ? settings.servers : []
    const desiredIds = new Set<string>()
    for (const s of servers) desiredIds.add(normalizeServerId(s.id) || s.id)

    // stop removed
    for (const [id] of this.runtimes) {
      if (!desiredIds.has(id)) {
        await this.stopServer(id)
        this.runtimes.delete(id)
      }
    }

    if (!enabled) {
      // stop all
      for (const [id] of this.runtimes) {
        await this.stopServer(id)
      }
      this.emitChanged()
      return
    }

    // apply per-server
    for (const cfg of servers) {
      const id = normalizeServerId(cfg.id) || cfg.id
      if (cfg.enabled === false) {
        await this.stopServer(id)
        continue
      }
      await this.startServer({ ...cfg, id })
    }

    this.emitChanged()
  }

  private sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
    if (a.transport !== b.transport) return false
    if ((a.command ?? '') !== (b.command ?? '')) return false
    if ((a.cwd ?? '') !== (b.cwd ?? '')) return false
    const argsA = Array.isArray(a.args) ? a.args : []
    const argsB = Array.isArray(b.args) ? b.args : []
    if (argsA.length !== argsB.length) return false
    for (let i = 0; i < argsA.length; i += 1) if (argsA[i] !== argsB[i]) return false
    const envA = a.env ?? {}
    const envB = b.env ?? {}
    const keysA = Object.keys(envA).sort()
    const keysB = Object.keys(envB).sort()
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i += 1) {
      if (keysA[i] !== keysB[i]) return false
      const k = keysA[i]
      if (envA[k] !== envB[k]) return false
    }
    return true
  }

  private ensureRuntime(id: string, cfg: McpServerConfig): McpServerRuntime {
    const existing = this.runtimes.get(id)
    if (existing) return existing

    const rt: McpServerRuntime = {
      generation: 0,
      config: cfg,
      status: 'disconnected',
      client: null,
      transport: null,
      tools: [],
      toolSummaries: [],
      stderrTail: [],
      updatedAt: now(),
    }
    this.runtimes.set(id, rt)
    return rt
  }

  async startServer(cfg: McpServerConfig): Promise<void> {
    const id = normalizeServerId(cfg.id) || cfg.id
    const rt = this.ensureRuntime(id, cfg)

    if (rt.status === 'connected' && this.sameConfig(rt.config, cfg)) return
    if (rt.status === 'connecting') return rt.startPromise
    if (rt.status !== 'disconnected') {
      await this.stopServer(id)
    }

    rt.config = cfg
    rt.generation += 1
    const gen = rt.generation
    rt.status = 'connecting'
    rt.lastError = undefined
    rt.updatedAt = now()
    rt.tools = []
    rt.toolSummaries = []
    rt.stderrTail = []
    this.emitChanged()

    rt.startPromise = (async () => {
      const command = (cfg.command ?? '').trim()
      if (!command) throw new Error('MCP server command 不能为空')

      const env = { ...getDefaultEnvironment(), ...(cfg.env ?? {}) }
      const transport = new StdioClientTransport({
        command,
        args: cfg.args ?? [],
        cwd: cfg.cwd || undefined,
        env,
        stderr: 'pipe',
      })

      const stderr = transport.stderr
      if (stderr) {
        stderr.on('data', (chunk: unknown) => {
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : chunk instanceof Uint8Array
                  ? Buffer.from(chunk).toString('utf8')
                  : String(chunk ?? '')
          for (const line of text.split(/\r?\n/)) {
            const cleaned = line.trimEnd()
            if (!cleaned) continue
            rt.stderrTail.push(clampText(cleaned, 300))
            if (rt.stderrTail.length > 60) rt.stderrTail.splice(0, rt.stderrTail.length - 60)
          }
          rt.updatedAt = now()
          this.emitChanged()
        })
      }

      const client = new McpClient({ name: 'DeskPet', version: '0.1.0' }, { capabilities: {} })

      await client.connect(transport)

      // 可能在 connect 期间被 stop/restart
      if (rt.generation !== gen) {
        await transport.close().catch(() => undefined)
        return
      }

      const toolItems = await listAllTools(client)

      const versionInfo = client.getServerVersion()
      const version = versionInfo?.version ? `mcp/${versionInfo.version}` : 'mcp'

      const toolSummaries: McpToolSummary[] = []
      const toolDefs: ToolDefinition[] = []

      for (const t of toolItems) {
        const internalName = `mcp.${id}.${t.name}`
        const callName = makeMcpCallName(id, t.name)
        const desc = (t.description ?? t.title ?? '').trim() || `MCP tool: ${t.name}`
        const schema = (t.inputSchema ?? {}) as Record<string, unknown>
        const { risk, cost } = toRiskAndCost(t)

        toolSummaries.push({
          serverId: id,
          toolName: internalName,
          callName,
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: schema,
          outputSchema: (t.outputSchema ?? undefined) as Record<string, unknown> | undefined,
        })

        toolDefs.push({
          name: internalName,
          callName,
          description: desc,
          inputSchema: schema,
          examples: [],
          risk: risk as ToolRiskLevel,
          cost: cost as ToolCostLevel,
          tags: ['mcp', `mcp:${id}`],
          version,
        })
      }

      rt.client = client
      rt.transport = transport
      rt.tools = toolDefs
      rt.toolSummaries = toolSummaries
      rt.status = 'connected'
      rt.updatedAt = now()
      this.emitChanged()
    })()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        rt.lastError = clampText(msg, 800)
        rt.status = 'error'
        rt.updatedAt = now()
        this.emitChanged()
      })
      .finally(() => {
        rt.startPromise = undefined
      })

    return rt.startPromise
  }

  async stopServer(serverId: string): Promise<void> {
    const id = normalizeServerId(serverId) || serverId
    const rt = this.runtimes.get(id)
    if (!rt) return

    if (rt.status === 'disconnected') return
    if (rt.stopPromise) return rt.stopPromise

    rt.generation += 1
    rt.status = 'disconnected'
    rt.tools = []
    rt.toolSummaries = []
    rt.updatedAt = now()
    this.emitChanged()

    rt.stopPromise = (async () => {
      const transport = rt.transport
      rt.transport = null
      rt.client = null
      try {
        if (transport) await transport.close()
      } catch {
        // ignore
      }
    })().finally(() => {
      rt.stopPromise = undefined
    })

    return rt.stopPromise
  }

  async callTool(internalToolName: string, input: unknown): Promise<string> {
    const parsed = parseMcpInternalToolName(internalToolName)
    if (!parsed) throw new Error(`not an MCP tool: ${internalToolName}`)

    if (this.currentSettings.enabled === false) throw new Error('MCP disabled')

    const serverId = normalizeServerId(parsed.serverId) || parsed.serverId
    const rt = this.runtimes.get(serverId)
    if (!rt || rt.status !== 'connected' || !rt.client) throw new Error(`MCP server not connected: ${serverId}`)

    const args = typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input }
    const res = await (rt.client as McpClient).callTool({ name: parsed.rawToolName, arguments: args })

    const isError =
      typeof res === 'object' &&
      !!res &&
      'isError' in (res as Record<string, unknown>) &&
      (res as { isError?: unknown }).isError === true
    const text = formatMcpToolResult(res)
    if (isError) throw new Error(text)
    return text
  }
}
