import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  McpServerConfig,
  McpStateSnapshot,
  TaskRecord,
} from '../../../electron/types'
import { getBuiltinToolDefinitions, getToolGroupId, isToolEnabled } from '../../../electron/toolRegistry'
import { getApi } from '../../neoDeskPetApi'

export function ToolsSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const toolSettings = settings?.tools
  const mcpSettings = settings?.mcp

  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [subTab, setSubTab] = useState<'builtin' | 'mcp'>('builtin')
  const [mcpState, setMcpState] = useState<McpStateSnapshot | null>(null)

  useEffect(() => {
    if (!api) return
    let disposed = false

    api
      .listTasks()
      .then((res) => {
        if (disposed) return
        setTasks(Array.isArray(res.items) ? res.items : [])
      })
      .catch((err) => console.error('[Tools] listTasks failed:', err))

    const off = api.onTasksChanged((payload) => setTasks(Array.isArray(payload.items) ? payload.items : []))
    return () => {
      disposed = true
      off()
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    let disposed = false

    api
      .getMcpState()
      .then((snap) => {
        if (disposed) return
        setMcpState(snap)
      })
      .catch((err) => console.error('[MCP] getMcpState failed:', err))

    const off = api.onMcpChanged((snap) => setMcpState(snap))
    return () => {
      disposed = true
      off()
    }
  }, [api])

  const allDefs = useMemo(() => getBuiltinToolDefinitions(), [])
  const effectiveToolSettings = useMemo(() => {
    return toolSettings ?? { enabled: true, groups: {}, tools: {} }
  }, [toolSettings])

  const latestRunByTool = useMemo(() => {
    const out = new Map<
      string,
      { status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number; error?: string; taskId: string; taskTitle: string }
    >()

    for (const t of tasks) {
      const runs = Array.isArray(t.toolRuns) ? t.toolRuns : []
      for (const r of runs) {
        const toolName = typeof r?.toolName === 'string' ? r.toolName : ''
        if (!toolName) continue
        const startedAt = typeof r.startedAt === 'number' ? r.startedAt : 0
        const prev = out.get(toolName)
        if (!prev || startedAt > prev.startedAt) {
          out.set(toolName, {
            status: r.status,
            startedAt,
            endedAt: r.endedAt,
            error: r.error,
            taskId: t.id,
            taskTitle: t.title,
          })
        }
      }
    }
    return out
  }, [tasks])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleDefs = useMemo(() => {
    if (!normalizedQuery) return allDefs
    return allDefs.filter((d) => {
      const hay = `${d.name}\n${d.callName}\n${d.description}\n${d.tags?.join(' ') ?? ''}`.toLowerCase()
      return hay.includes(normalizedQuery)
    })
  }, [allDefs, normalizedQuery])

  const groups = useMemo(() => {
    const map = new Map<string, typeof visibleDefs>()
    for (const d of visibleDefs) {
      const g = getToolGroupId(d.name)
      const arr = map.get(g)
      if (arr) arr.push(d)
      else map.set(g, [d])
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [visibleDefs])

  const totalCount = allDefs.length
  const enabledCount = allDefs.filter((d) => isToolEnabled(d.name, effectiveToolSettings)).length

  const updateToolSettings = useCallback(
    async (patch: Partial<AppSettings['tools']>) => {
      if (!api) return
      try {
        await api.setToolSettings(patch)
      } catch (err) {
        console.error('[Tools] setToolSettings failed:', err)
      }
    },
    [api],
  )

  const updateMcpSettings = useCallback(
    async (patch: Partial<AppSettings['mcp']>) => {
      if (!api) return
      try {
        await api.setMcpSettings(patch)
      } catch (err) {
        console.error('[MCP] setMcpSettings failed:', err)
      }
    },
    [api],
  )

  const onToggleGlobal = useCallback(
    (next: boolean) => {
      void updateToolSettings({ enabled: next })
    },
    [updateToolSettings],
  )

  const onToggleGroup = useCallback(
    (groupId: string, next: boolean) => {
      const nextGroups = { ...(effectiveToolSettings.groups ?? {}) }
      nextGroups[groupId] = next
      void updateToolSettings({ groups: nextGroups })
    },
    [effectiveToolSettings.groups, updateToolSettings],
  )

  const onResetGroup = useCallback(
    (groupId: string) => {
      const nextGroups = { ...(effectiveToolSettings.groups ?? {}) }
      delete nextGroups[groupId]
      void updateToolSettings({ groups: nextGroups })
    },
    [effectiveToolSettings.groups, updateToolSettings],
  )

  const onToggleTool = useCallback(
    (toolName: string, next: boolean) => {
      const nextTools = { ...(effectiveToolSettings.tools ?? {}) }
      nextTools[toolName] = next
      void updateToolSettings({ tools: nextTools })
    },
    [effectiveToolSettings.tools, updateToolSettings],
  )

  const onResetTool = useCallback(
    (toolName: string) => {
      const nextTools = { ...(effectiveToolSettings.tools ?? {}) }
      delete nextTools[toolName]
      void updateToolSettings({ tools: nextTools })
    },
    [effectiveToolSettings.tools, updateToolSettings],
  )

  const mcpEnabled = mcpSettings?.enabled ?? false
  const mcpServersRaw = mcpSettings?.servers
  const mcpServers = useMemo(() => {
    return Array.isArray(mcpServersRaw) ? mcpServersRaw : []
  }, [mcpServersRaw])
  const mcpStateById = useMemo(() => {
    const map = new Map<string, (McpStateSnapshot['servers'][number] | null)>()
    const servers = Array.isArray(mcpState?.servers) ? mcpState!.servers : []
    for (const s of servers) {
      if (!s || typeof s.id !== 'string') continue
      map.set(s.id, s)
    }
    return map
  }, [mcpState])

  const parseArgsText = useCallback((text: string): string[] => {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  }, [])

  const formatArgsText = useCallback((args: string[] | undefined | null): string => {
    return Array.isArray(args) ? args.filter((v) => typeof v === 'string' && v.trim()).join('\n') : ''
  }, [])

  const parseEnvText = useCallback((text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (!key) continue
      out[key] = value
    }
    return out
  }, [])

  const formatEnvText = useCallback((env: Record<string, string> | undefined | null): string => {
    if (!env) return ''
    return Object.entries(env)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  }, [])

  const updateMcpServer = useCallback(
    (idx: number, patch: Partial<McpServerConfig>) => {
      const next = mcpServers.map((s, i) => (i === idx ? { ...s, ...patch } : s))
      void updateMcpSettings({ servers: next })
    },
    [mcpServers, updateMcpSettings],
  )

  const removeMcpServer = useCallback(
    (idx: number) => {
      const next = mcpServers.filter((_, i) => i !== idx)
      void updateMcpSettings({ servers: next })
    },
    [mcpServers, updateMcpSettings],
  )

  const addMcpServer = useCallback(() => {
    const used = new Set(mcpServers.map((s) => (s?.id ?? '').trim()).filter(Boolean))
    let id = 'server'
    if (used.has(id)) {
      for (let i = 2; i < 9999; i += 1) {
        const candidate = `server-${i}`
        if (!used.has(candidate)) {
          id = candidate
          break
        }
      }
    }

    const next: McpServerConfig = {
      id,
      enabled: true,
      label: '',
      transport: 'stdio',
      command: '',
      args: [],
      cwd: '',
      env: {},
    }
    void updateMcpSettings({ servers: [...mcpServers, next] })
  }, [mcpServers, updateMcpSettings])

  const [mcpImportText, setMcpImportText] = useState('')
  const [mcpImportError, setMcpImportError] = useState<string | null>(null)

  const buildMcpExportText = useCallback((servers: McpServerConfig[]) => {
    const mcpServers: Record<
      string,
      { command: string; args: string[]; cwd?: string; env?: Record<string, string> }
    > = {}

    for (const s of servers) {
      const id = (s?.id ?? '').trim()
      if (!id) continue
      mcpServers[id] = {
        command: s.command ?? '',
        args: Array.isArray(s.args) ? s.args : [],
        cwd: s.cwd || undefined,
        env: s.env && Object.keys(s.env).length ? s.env : undefined,
      }
    }

    return JSON.stringify({ mcpServers }, null, 2)
  }, [])

  const parseMcpImport = useCallback((text: string): { servers: McpServerConfig[] } => {
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

    // 支持两种格式：
    // 1) { "mcpServers": { "id": { command,args,cwd,env } } }
    // 2) { "servers": [ {id,enabled,label,transport,command,args,cwd,env} ] } / 直接 array
    const fromObject = acceptObjectServers((obj as { mcpServers?: unknown }).mcpServers)
    const fromServersArray = acceptArrayServers((obj as { servers?: unknown }).servers)
    const fromDirectArray = acceptArrayServers(obj)

    const servers = fromObject.length ? fromObject : fromServersArray.length ? fromServersArray : fromDirectArray

    if (!servers.length) throw new Error('未解析到任何 MCP Server（支持 {mcpServers:{...}} 或 {servers:[...]}）')
    return { servers }
  }, [])

  const onMcpImportReplace = useCallback(() => {
    try {
      const parsed = parseMcpImport(mcpImportText)
      setMcpImportError(null)
      void updateMcpSettings({ servers: parsed.servers })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMcpImportError(msg)
    }
  }, [mcpImportText, parseMcpImport, updateMcpSettings])

  const onMcpImportMerge = useCallback(() => {
    try {
      const parsed = parseMcpImport(mcpImportText)
      const map = new Map(mcpServers.map((s) => [String(s.id), s] as const))
      for (const s of parsed.servers) map.set(String(s.id), s)
      const next = Array.from(map.values())
      setMcpImportError(null)
      void updateMcpSettings({ servers: next })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMcpImportError(msg)
    }
  }, [mcpImportText, mcpServers, parseMcpImport, updateMcpSettings])

  const onMcpExportToTextarea = useCallback(() => {
    setMcpImportError(null)
    setMcpImportText(buildMcpExportText(mcpServers))
  }, [buildMcpExportText, mcpServers])

  return (
    <div className="ndp-settings-section">
      <h3>工具中心</h3>

      <div className="ndp-setting-item">
        <label>工具总开关</label>
        <div className="ndp-row">
          <input
            type="checkbox"
            checked={effectiveToolSettings.enabled}
            onChange={(e) => onToggleGlobal(e.currentTarget.checked)}
            disabled={!api}
          />
          <div className="ndp-setting-hint">关闭后：Planner/Agent/执行器都不会使用任何工具</div>
        </div>
      </div>

      <div className="ndp-toolcenter-subtabs">
        <button className={`ndp-btn ${subTab === 'builtin' ? 'active' : ''}`} onClick={() => setSubTab('builtin')}>
          内置工具
        </button>
        <button className={`ndp-btn ${subTab === 'mcp' ? 'active' : ''}`} onClick={() => setSubTab('mcp')}>
          MCP
        </button>
      </div>

      {subTab === 'builtin' ? (
        <>
          <div className="ndp-setting-item">
            <label>搜索</label>
            <div className="ndp-row">
              <input
                className="ndp-input"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="按名称/描述/tags 搜索…"
              />
              <div className="ndp-setting-hint">
                启用：{enabledCount}/{totalCount}
              </div>
            </div>
          </div>

          <div className="ndp-toolcenter-list">
            {groups.map(([groupId, defs]) => {
              const groupOverride = (effectiveToolSettings.groups ?? {})[groupId]
              const groupEffective = effectiveToolSettings.enabled && (typeof groupOverride === 'boolean' ? groupOverride : true)
              const groupEnabledCount = defs.filter((d) => isToolEnabled(d.name, effectiveToolSettings)).length

              return (
                <details key={groupId} className="ndp-toolcenter-group" open={normalizedQuery ? true : undefined}>
                  <summary className="ndp-toolcenter-group-summary">
                    <div className="ndp-toolcenter-group-left">
                      <span className="ndp-toolcenter-group-name">{groupId}</span>
                      <span className="ndp-setting-hint">
                        {groupEnabledCount}/{defs.length}
                      </span>
                    </div>

                    <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                      <label className="ndp-toolcenter-toggle" title="分组开关（可覆盖总开关以外的默认）">
                        <input
                          type="checkbox"
                          checked={groupEffective}
                          onChange={(e) => onToggleGroup(groupId, e.currentTarget.checked)}
                          disabled={!api || !effectiveToolSettings.enabled}
                        />
                        <span>启用</span>
                      </label>
                      {typeof groupOverride === 'boolean' ? (
                        <button className="ndp-btn ndp-btn-mini" onClick={() => onResetGroup(groupId)} disabled={!api}>
                          重置
                        </button>
                      ) : null}
                    </div>
                  </summary>

                  <div className="ndp-toolcenter-group-body">
                    {defs
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((d) => {
                        const toolOverride = (effectiveToolSettings.tools ?? {})[d.name]
                        const toolEnabled = isToolEnabled(d.name, effectiveToolSettings)
                        const last = latestRunByTool.get(d.name) ?? null

                        return (
                          <details key={d.name} className={`ndp-toolcenter-tool ${toolEnabled ? '' : 'ndp-toolcenter-tool-disabled'}`}>
                            <summary className="ndp-toolcenter-tool-summary">
                              <div className="ndp-toolcenter-tool-left">
                                <span className="ndp-toolcenter-tool-name">{d.name}</span>
                                <span className="ndp-setting-hint">{d.risk}/{d.cost}</span>
                                {last ? (
                                  <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${last.status}`}>
                                    {last.status}
                                  </span>
                                ) : (
                                  <span className="ndp-setting-hint">未调用</span>
                                )}
                              </div>

                              <div className="ndp-toolcenter-tool-actions" onClick={(e) => e.stopPropagation()}>
                                <label className="ndp-toolcenter-toggle">
                                  <input
                                    type="checkbox"
                                    checked={toolEnabled}
                                    onChange={(e) => onToggleTool(d.name, e.currentTarget.checked)}
                                    disabled={!api || !effectiveToolSettings.enabled}
                                  />
                                  <span>启用</span>
                                </label>
                                {typeof toolOverride === 'boolean' ? (
                                  <button className="ndp-btn ndp-btn-mini" onClick={() => onResetTool(d.name)} disabled={!api}>
                                    重置
                                  </button>
                                ) : null}
                              </div>
                            </summary>

                            <div className="ndp-toolcenter-tool-body">
                              <div className="ndp-toolcenter-desc">{d.description}</div>
                              {Array.isArray(d.tags) && d.tags.length ? (
                                <div className="ndp-setting-hint">tags: {d.tags.join(', ')}</div>
                              ) : null}

                              <div className="ndp-toolcenter-meta">
                                <div className="ndp-setting-hint">callName: {d.callName}</div>
                                <div className="ndp-setting-hint">version: {d.version}</div>
                              </div>

                              {last ? (
                                <div className="ndp-toolcenter-last">
                                  <div className="ndp-setting-hint">
                                    最近一次：{new Date(last.startedAt).toLocaleString()}（任务：{last.taskTitle}）
                                  </div>
                                  {last.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {last.error}</div> : null}
                                </div>
                              ) : null}

                              <details className="ndp-toolcenter-sub">
                                <summary className="ndp-toolcenter-sub-summary">inputSchema</summary>
                                <pre className="ndp-toolcenter-pre">{JSON.stringify(d.inputSchema ?? {}, null, 2)}</pre>
                              </details>

                              <details className="ndp-toolcenter-sub">
                                <summary className="ndp-toolcenter-sub-summary">examples</summary>
                                <div className="ndp-toolcenter-examples">
                                  {(Array.isArray(d.examples) ? d.examples : []).map((ex, idx) => (
                                    <div key={`${d.name}-ex-${idx}`} className="ndp-toolcenter-example">
                                      <div className="ndp-toolcenter-example-title">{ex.title}</div>
                                      <pre className="ndp-toolcenter-pre">{JSON.stringify(ex.input ?? {}, null, 2)}</pre>
                                    </div>
                                  ))}
                                  {!d.examples?.length ? <div className="ndp-setting-hint">无</div> : null}
                                </div>
                              </details>
                            </div>
                          </details>
                        )
                      })}
                  </div>
                </details>
              )
            })}
          </div>
        </>
      ) : (
        <>
          <div className="ndp-setting-item">
            <label>MCP 总开关</label>
            <div className="ndp-row">
              <input
                type="checkbox"
                checked={mcpEnabled}
                onChange={(e) => void updateMcpSettings({ enabled: e.currentTarget.checked })}
                disabled={!api}
              />
              <div className="ndp-setting-hint">
                开启后：连接成功的 MCP Server 会把工具暴露到 Agent（仍受“工具总开关/分组/单工具”影响）
              </div>
            </div>
          </div>

          <details className="ndp-toolcenter-group" open={false}>
            <summary className="ndp-toolcenter-group-summary">
              <div className="ndp-toolcenter-group-left">
                <span className="ndp-toolcenter-group-name">一键导入/导出（JSON）</span>
                <span className="ndp-setting-hint">兼容 {`{ "mcpServers": { ... } }`}</span>
              </div>
              <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                <button className="ndp-btn ndp-btn-mini" onClick={onMcpExportToTextarea} disabled={!api}>
                  导出到文本框
                </button>
              </div>
            </summary>

            <div className="ndp-toolcenter-group-body">
              <textarea
                className="ndp-input ndp-textarea"
                value={mcpImportText}
                onChange={(e) => setMcpImportText(e.currentTarget.value)}
                placeholder={`{
  "mcpServers": {
    "exa": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "exa-mcp-server@latest"],
      "env": { "EXA_API_KEY": "..." }
    }
  }
}`}
              />
              {mcpImportError ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {mcpImportError}</div> : null}
              <div className="ndp-row">
                <button className="ndp-btn" onClick={onMcpImportReplace} disabled={!api}>
                  覆盖导入
                </button>
                <button className="ndp-btn" onClick={onMcpImportMerge} disabled={!api}>
                  合并导入（按 id 更新/新增）
                </button>
                <div className="ndp-setting-hint">导入后会触发自动重连；server id 会在保存时自动规范化并去重。</div>
              </div>
            </div>
          </details>

          <div className="ndp-setting-item">
            <div className="ndp-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>MCP Servers</div>
                <div className="ndp-setting-hint">仅支持 stdio；修改 command/args/cwd/env 后会自动重连。</div>
              </div>
              <button className="ndp-btn" onClick={addMcpServer} disabled={!api}>
                + 添加
              </button>
            </div>
          </div>

          <div className="ndp-toolcenter-list">
            {mcpServers.length ? null : <div className="ndp-setting-hint">暂无 MCP Server，点击“+ 添加”创建一个。</div>}

            {mcpServers.map((cfg, idx) => {
              const cfgId = (cfg?.id ?? '').trim() || `server-${idx + 1}`
              const state = mcpStateById.get(cfgId) ?? null
              const status = state?.status ?? 'disconnected'
              const tools = Array.isArray(state?.tools) ? state!.tools : []
              const enabledToolCount = tools.filter((t) => isToolEnabled(t.toolName, effectiveToolSettings)).length
              const groupId = `mcp.${cfgId}`
              const groupOverride = (effectiveToolSettings.groups ?? {})[groupId]
              const groupEffective = effectiveToolSettings.enabled && (typeof groupOverride === 'boolean' ? groupOverride : true)

              return (
                <details key={`${cfgId}-${idx}`} className="ndp-toolcenter-group">
                  <summary className="ndp-toolcenter-group-summary">
                    <div className="ndp-toolcenter-group-left">
                      <span className="ndp-toolcenter-group-name">{cfg.label?.trim() || cfgId}</span>
                      <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${status}`}>{status}</span>
                      <span className="ndp-setting-hint">
                        工具：{enabledToolCount}/{tools.length}
                      </span>
                    </div>

                    <div className="ndp-toolcenter-group-actions" onClick={(e) => e.stopPropagation()}>
                      <label className="ndp-toolcenter-toggle" title="MCP Server 开关（关闭会断开连接并隐藏工具）">
                        <input
                          type="checkbox"
                          checked={cfg.enabled !== false}
                          onChange={(e) => updateMcpServer(idx, { enabled: e.currentTarget.checked })}
                          disabled={!api}
                        />
                        <span>启用</span>
                      </label>
                      <button className="ndp-btn ndp-btn-mini" onClick={() => removeMcpServer(idx)} disabled={!api}>
                        删除
                      </button>
                    </div>
                  </summary>

                  <div className="ndp-toolcenter-group-body">
                    <div className="ndp-setting-item">
                      <label>Server ID（mcp.&lt;serverId&gt;.*）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfgId}
                          placeholder="例如：local-tools"
                          onBlur={(e) => updateMcpServer(idx, { id: e.currentTarget.value.trim() || cfgId })}
                          disabled={!api}
                        />
                        <div className="ndp-setting-hint">仅允许字母/数字/_/-；变更会自动规范化。</div>
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>label（可选）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.label ?? ''}
                          placeholder="显示名称"
                          onBlur={(e) => updateMcpServer(idx, { label: e.currentTarget.value })}
                          disabled={!api}
                        />
                        <div className="ndp-setting-hint">用于工具中心显示，不影响 toolName。</div>
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>command</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.command ?? ''}
                          placeholder="例如：node"
                          onBlur={(e) => updateMcpServer(idx, { command: e.currentTarget.value })}
                          disabled={!api}
                        />
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>args（每行一个）</label>
                      <textarea
                        className="ndp-input ndp-textarea"
                        defaultValue={formatArgsText(cfg.args)}
                        placeholder="例如：path/to/server.js"
                        onBlur={(e) => updateMcpServer(idx, { args: parseArgsText(e.currentTarget.value) })}
                        disabled={!api}
                      />
                    </div>

                    <div className="ndp-setting-item">
                      <label>cwd（可选）</label>
                      <div className="ndp-row">
                        <input
                          className="ndp-input"
                          defaultValue={cfg.cwd ?? ''}
                          placeholder="工作目录（空=默认）"
                          onBlur={(e) => updateMcpServer(idx, { cwd: e.currentTarget.value })}
                          disabled={!api}
                        />
                      </div>
                    </div>

                    <div className="ndp-setting-item">
                      <label>env（KEY=VALUE，每行一个，可选）</label>
                      <textarea
                        className="ndp-input ndp-textarea"
                        defaultValue={formatEnvText(cfg.env)}
                        placeholder={'# 例如：\nOPENAI_API_KEY=xxxx\nHTTP_PROXY=http://127.0.0.1:7890'}
                        onBlur={(e) => updateMcpServer(idx, { env: parseEnvText(e.currentTarget.value) })}
                        disabled={!api}
                      />
                    </div>

                    <div className="ndp-setting-item">
                      <label>工具分组开关：{groupId}</label>
                      <div className="ndp-row">
                        <label className="ndp-toolcenter-toggle" title="分组开关（可覆盖总开关以外的默认）">
                          <input
                            type="checkbox"
                            checked={groupEffective}
                            onChange={(e) => onToggleGroup(groupId, e.currentTarget.checked)}
                            disabled={!api || !effectiveToolSettings.enabled}
                          />
                          <span>启用</span>
                        </label>
                        {typeof groupOverride === 'boolean' ? (
                          <button className="ndp-btn ndp-btn-mini" onClick={() => onResetGroup(groupId)} disabled={!api}>
                            重置
                          </button>
                        ) : null}
                        <div className="ndp-setting-hint">关闭分组会隐藏该 server 下所有工具。</div>
                      </div>
                    </div>

                    {state?.lastError ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {state.lastError}</div> : null}

                    {Array.isArray(state?.stderrTail) && state.stderrTail.length ? (
                      <details className="ndp-toolcenter-sub">
                        <summary className="ndp-toolcenter-sub-summary">stderr（最近 {state.stderrTail.length} 行）</summary>
                        <pre className="ndp-toolcenter-pre">{state.stderrTail.join('\n')}</pre>
                      </details>
                    ) : null}

                    <details className="ndp-toolcenter-sub" open={tools.length ? undefined : false}>
                      <summary className="ndp-toolcenter-sub-summary">
                        tools（{enabledToolCount}/{tools.length}）
                      </summary>
                      <div className="ndp-toolcenter-list">
                        {tools
                          .slice()
                          .sort((a, b) => a.toolName.localeCompare(b.toolName))
                          .map((t) => {
                            const toolOverride = (effectiveToolSettings.tools ?? {})[t.toolName]
                            const toolEnabled = isToolEnabled(t.toolName, effectiveToolSettings)

                            return (
                              <details
                                key={t.toolName}
                                className={`ndp-toolcenter-tool ${toolEnabled ? '' : 'ndp-toolcenter-tool-disabled'}`}
                              >
                                <summary className="ndp-toolcenter-tool-summary">
                                  <div className="ndp-toolcenter-tool-left">
                                    <span className="ndp-toolcenter-tool-name">{t.toolName}</span>
                                    <span className="ndp-setting-hint">{t.callName}</span>
                                  </div>
                                  <div className="ndp-toolcenter-tool-actions" onClick={(e) => e.stopPropagation()}>
                                    <label className="ndp-toolcenter-toggle">
                                      <input
                                        type="checkbox"
                                        checked={toolEnabled}
                                        onChange={(e) => onToggleTool(t.toolName, e.currentTarget.checked)}
                                        disabled={!api || !effectiveToolSettings.enabled}
                                      />
                                      <span>启用</span>
                                    </label>
                                    {typeof toolOverride === 'boolean' ? (
                                      <button className="ndp-btn ndp-btn-mini" onClick={() => onResetTool(t.toolName)} disabled={!api}>
                                        重置
                                      </button>
                                    ) : null}
                                  </div>
                                </summary>

                                <div className="ndp-toolcenter-tool-body">
                                  {t.description ? <div className="ndp-toolcenter-desc">{t.description}</div> : null}
                                  <div className="ndp-toolcenter-meta">
                                    <div className="ndp-setting-hint">callName: {t.callName}</div>
                                    <div className="ndp-setting-hint">name: {t.name}</div>
                                  </div>

                                  <details className="ndp-toolcenter-sub">
                                    <summary className="ndp-toolcenter-sub-summary">inputSchema</summary>
                                    <pre className="ndp-toolcenter-pre">{JSON.stringify(t.inputSchema ?? {}, null, 2)}</pre>
                                  </details>
                                  {t.outputSchema ? (
                                    <details className="ndp-toolcenter-sub">
                                      <summary className="ndp-toolcenter-sub-summary">outputSchema</summary>
                                      <pre className="ndp-toolcenter-pre">{JSON.stringify(t.outputSchema ?? {}, null, 2)}</pre>
                                    </details>
                                  ) : null}
                                </div>
                              </details>
                            )
                          })}
                      </div>
                    </details>
                  </div>
                </details>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
