import './style.css'

import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'

type Cdi3Param = { Id?: unknown; Name?: unknown; GroupId?: unknown }
type Cdi3Json = { Parameters?: unknown }

type Model3Json = {
  Version?: unknown
  FileReferences?: {
    Moc?: unknown
    Textures?: unknown
    Physics?: unknown
    Pose?: unknown
    DisplayInfo?: unknown
    Expressions?: unknown
  }
}

type CubismCoreModel = {
  getParameterIndex?: (parameterId: string) => number
  getParameterMinimumValue?: (parameterIndex: number) => number
  getParameterMaximumValue?: (parameterIndex: number) => number
  getParameterDefaultValue?: (parameterIndex: number) => number
  getParameterValueById?: (parameterId: string) => number
  setParameterValueById?: (parameterId: string, value: number, weight?: number) => void
}

type Live2DInternalModel = {
  coreModel?: CubismCoreModel
}

type Live2DParamMeta = {
  id: string
  name: string
  group: string
  min?: number
  max?: number
  def?: number
  value?: number
}

type ParamPatch = Record<string, number>

function clampNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function safeText(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v : ''
  return s.trim() ? s : fallback
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseParamPatch(raw: string): { ok: true; patch: ParamPatch } | { ok: false; error: string } {
  const parsed = safeJsonParse(raw.trim())
  if (!parsed) return { ok: false, error: 'JSON 解析失败' }

  if (Array.isArray(parsed)) {
    const patch: ParamPatch = {}
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue
      const id = safeText((it as { id?: unknown }).id, '')
      if (!id) continue
      const value = clampNumber((it as { value?: unknown }).value, NaN)
      if (!Number.isFinite(value)) continue
      patch[id] = value
    }
    return { ok: true, patch }
  }

  if (typeof parsed === 'object') {
    const patch: ParamPatch = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = String(k ?? '').trim()
      if (!id) continue
      const value = clampNumber(v, NaN)
      if (!Number.isFinite(value)) continue
      patch[id] = value
    }
    return { ok: true, patch }
  }

  return { ok: false, error: '不支持的 JSON 结构（需要对象或数组）' }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      // 兼容性兜底：在不允许 clipboard 的环境下，使用 prompt 让用户手动复制
      window.prompt('复制以下内容：', text)
      return true
    } catch {
      return false
    }
  }
}

function joinUrl(base: string, rel: string): string {
  const u = new URL(rel, base)
  return u.toString()
}

async function probeUrlExists(url: string): Promise<boolean> {
  // 先 HEAD（不拉大文件）；某些 server 不支持 HEAD，再退回到 Range GET（只取 1 byte）
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (r.ok) return true
    if (r.status === 405) throw new Error('HEAD not allowed')
    return false
  } catch {
    try {
      const r = await fetch(url, { method: 'GET', cache: 'no-store', headers: { Range: 'bytes=0-0' } })
      return r.ok
    } catch {
      return false
    }
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim()).filter(Boolean)
}

type ModelFileCheck = { ok: true; modelJson: Model3Json } | { ok: false; error: string }

async function preflightModelFiles(modelJsonUrl: string): Promise<ModelFileCheck> {
  const raw = (await fetchJson(modelJsonUrl)) as Model3Json
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'model3.json 不是有效的 JSON 对象' }

  const version = clampNumber((raw as Model3Json).Version, NaN)
  if (!Number.isFinite(version)) return { ok: false, error: 'model3.json 缺少 Version 字段' }

  const fileRefs = raw.FileReferences ?? {}
  const mocRel = typeof fileRefs.Moc === 'string' ? fileRefs.Moc.trim() : ''
  const texturesRel = toStringArray(fileRefs.Textures)

  if (!mocRel) return { ok: false, error: 'model3.json 缺少 FileReferences.Moc' }
  if (texturesRel.length === 0) return { ok: false, error: 'model3.json 缺少 FileReferences.Textures' }

  const baseDir = dirnameUrl(modelJsonUrl)
  const missing: string[] = []

  const need = [
    mocRel,
    ...texturesRel,
    typeof fileRefs.Physics === 'string' ? fileRefs.Physics.trim() : '',
    typeof fileRefs.Pose === 'string' ? fileRefs.Pose.trim() : '',
    typeof fileRefs.DisplayInfo === 'string' ? fileRefs.DisplayInfo.trim() : '',
  ].filter(Boolean)

  // 表情文件（可选，但经常会被模型引用，提前检查方便定位问题）
  const expressions = fileRefs.Expressions
  if (Array.isArray(expressions)) {
    for (const e of expressions as Array<{ File?: unknown }>) {
      const rel = typeof e?.File === 'string' ? e.File.trim() : ''
      if (rel) need.push(rel)
    }
  }

  for (const rel of need) {
    const u = joinUrl(baseDir, rel)
    const ok = await probeUrlExists(u)
    if (!ok) missing.push(rel)
  }

  if (missing.length > 0) {
    const tip =
      '资源文件不存在（通常是：你改了文件夹名/文件名，但 model3.json 内引用没同步）。\n' +
      '请确保 model3.json 里引用的 moc3/纹理/physics/cdi3 等文件名与目录下实际文件名一致。'
    return { ok: false, error: `${tip}\n\n缺失：\n- ${missing.join('\n- ')}` }
  }

  return { ok: true, modelJson: raw }
}

function dirnameUrl(url: string): string {
  const u = new URL(url, window.location.href)
  const p = u.pathname
  const idx = p.lastIndexOf('/')
  const basePath = idx >= 0 ? p.slice(0, idx + 1) : '/'
  u.pathname = basePath
  u.search = ''
  u.hash = ''
  return u.toString()
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return await res.json()
}

async function loadCdi3Params(modelJsonUrl: string): Promise<Live2DParamMeta[]> {
  const modelJson = (await fetchJson(modelJsonUrl)) as Model3Json
  const displayInfo = modelJson?.FileReferences?.DisplayInfo
  const displayInfoRel = typeof displayInfo === 'string' ? displayInfo.trim() : ''
  if (!displayInfoRel) return []

  const modelDir = dirnameUrl(modelJsonUrl)
  const cdi3Url = joinUrl(modelDir, displayInfoRel)
  const cdi3 = (await fetchJson(cdi3Url)) as Cdi3Json

  const paramsRaw = cdi3?.Parameters
  if (!Array.isArray(paramsRaw)) return []

  const out: Live2DParamMeta[] = []
  for (const p of paramsRaw as Cdi3Param[]) {
    const id = safeText(p?.Id, '')
    if (!id) continue
    out.push({
      id,
      name: safeText(p?.Name, id),
      group: safeText(p?.GroupId, 'default'),
    })
  }
  return out
}

function readCoreModel(model: Live2DModel): CubismCoreModel | null {
  const internal = model.internalModel as unknown as Live2DInternalModel
  const core = internal?.coreModel
  return core && typeof core === 'object' ? core : null
}

function enrichParamRanges(core: CubismCoreModel | null, metas: Live2DParamMeta[]): Live2DParamMeta[] {
  if (!core) return metas
  const getIndex = core.getParameterIndex
  const getMin = core.getParameterMinimumValue
  const getMax = core.getParameterMaximumValue
  const getDef = core.getParameterDefaultValue
  const getV = core.getParameterValueById

  return metas.map((m) => {
    const idx = getIndex ? getIndex(m.id) : -1
    const min = idx >= 0 && getMin ? getMin(idx) : undefined
    const max = idx >= 0 && getMax ? getMax(idx) : undefined
    const def = idx >= 0 && getDef ? getDef(idx) : undefined
    const value = getV ? getV(m.id) : undefined
    return { ...m, min, max, def, value }
  })
}

function groupParams(params: Live2DParamMeta[]): { groups: string[]; byGroup: Map<string, Live2DParamMeta[]> } {
  const byGroup = new Map<string, Live2DParamMeta[]>()
  for (const p of params) {
    const key = p.group || 'default'
    const arr = byGroup.get(key) ?? []
    arr.push(p)
    byGroup.set(key, arr)
  }
  const groups = Array.from(byGroup.keys()).sort((a, b) => a.localeCompare(b))
  for (const g of groups) {
    const arr = byGroup.get(g) ?? []
    arr.sort((a, b) => a.id.localeCompare(b.id))
    byGroup.set(g, arr)
  }
  return { groups, byGroup }
}

function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  return el
}

function iconCopySvg(): string {
  return `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M6 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`
}

type UiState = {
  modelUrl: string
  loadedUrl: string
  status: string
  error: string
  tab: 'controls' | 'script'
  query: string
  selectedGroup: string
  lockOverride: boolean
  manualIds: string
  scriptText: string
}

const DEFAULT_MODEL_URL = ''

async function main() {
  const root = document.getElementById('app')
  if (!root) throw new Error('#app not found')

  const state: UiState = {
    modelUrl: new URLSearchParams(location.search).get('model') || DEFAULT_MODEL_URL,
    loadedUrl: '',
    status: '未加载模型',
    error: '',
    tab: 'controls',
    query: '',
    selectedGroup: 'all',
    lockOverride: true,
    manualIds: '',
    scriptText: '{\n  "ParamAngleX": 10,\n  "ParamAngleY": -5\n}\n',
  }

  const rootEl = createEl('div', 'ndp-demo-root')
  const stageEl = createEl('div', 'ndp-demo-stage')
  const panelEl = createEl('div', 'ndp-demo-panel')

  root.appendChild(rootEl)
  rootEl.appendChild(stageEl)
  rootEl.appendChild(panelEl)

  // PIXI 舞台
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    width: Math.max(1, stageEl.clientWidth || 800),
    height: Math.max(1, stageEl.clientHeight || 600),
  })
  stageEl.appendChild(app.view as unknown as Node)

  // 顶部浮层：状态
  const overlay = createEl('div', 'ndp-demo-stage-overlay')
  const statusPill = createEl('div', 'ndp-demo-pill')
  statusPill.textContent = state.status
  const hintPill = createEl('div', 'ndp-demo-pill')
  hintPill.textContent = '拖动右侧滑条，观察模型变化'
  overlay.appendChild(statusPill)
  overlay.appendChild(hintPill)
  stageEl.appendChild(overlay)

  // 右侧：顶部输入栏（模型 URL）
  const topbar = createEl('div', 'ndp-demo-topbar')
  const urlInput = createEl('input', 'ndp-demo-input')
  urlInput.placeholder = '输入 model3.json URL（例如 /live2d/艾玛/艾玛.model3.json）'
  urlInput.value = state.modelUrl
  const loadBtn = createEl('button', 'ndp-demo-btn ndp-demo-btn-primary')
  loadBtn.textContent = 'Load'
  topbar.appendChild(urlInput)
  topbar.appendChild(loadBtn)
  panelEl.appendChild(topbar)

  // 右侧：Tabs
  const tabs = createEl('div', 'ndp-demo-tabs')
  const tabControls = createEl('div', 'ndp-demo-tab active')
  tabControls.textContent = 'CONTROLS'
  const tabScript = createEl('div', 'ndp-demo-tab')
  tabScript.textContent = 'SCRIPT'
  tabs.appendChild(tabControls)
  tabs.appendChild(tabScript)
  panelEl.appendChild(tabs)

  const body = createEl('div', 'ndp-demo-body')
  panelEl.appendChild(body)

  // Live2D 模型相关引用
  let live2d: Live2DModel | null = null
  let core: CubismCoreModel | null = null
  let params: Live2DParamMeta[] = []
  let groups: string[] = []
  let byGroup = new Map<string, Live2DParamMeta[]>()
  const overrides = new Map<string, number>()

  const resize = () => {
    const w = Math.max(1, stageEl.clientWidth)
    const h = Math.max(1, stageEl.clientHeight)
    app.renderer.resize(w, h)
    if (live2d) {
      live2d.position.set(w / 2, h / 2 + h * 0.06)
    }
  }
  new ResizeObserver(() => resize()).observe(stageEl)
  window.addEventListener('resize', resize)

  const setStatus = (s: string) => {
    state.status = s
    statusPill.textContent = s
  }

  const setError = (e: string) => {
    state.error = e
    render()
  }

  // 捕获运行时异常，尽量在 UI 上显示可读信息（避免只看 console）
  window.addEventListener('error', (ev) => {
    const msg = ev.error instanceof Error ? ev.error.message : String(ev.message ?? '')
    if (msg) setError(msg)
  })
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason
    const msg = reason instanceof Error ? reason.message : String(reason ?? '')
    if (msg) setError(msg)
  })

  const setTab = (t: UiState['tab']) => {
    state.tab = t
    tabControls.classList.toggle('active', t === 'controls')
    tabScript.classList.toggle('active', t === 'script')
    render()
  }

  tabControls.addEventListener('click', () => setTab('controls'))
  tabScript.addEventListener('click', () => setTab('script'))

  const loadModel = async (url: string) => {
    setError('')
    setStatus('加载中...')
    state.loadedUrl = ''
    params = []
    groups = []
    byGroup = new Map()
    overrides.clear()

    try {
      // 预检查：先把“文件找不到/路径不一致”的问题变成可读错误
      const checked = await preflightModelFiles(url)
      if (!checked.ok) {
        setStatus('加载失败')
        setError(checked.error)
        return
      }

      if (live2d) {
        try {
          live2d.destroy({ children: true, texture: true, baseTexture: true })
        } catch {
          // ignore
        }
        live2d = null
        core = null
      }

      // pixi-live2d-display 依赖全局 PIXI（保持兼容）
      const win = window as unknown as { PIXI?: unknown }
      win.PIXI = PIXI

      const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: true })
      live2d = model
      core = readCoreModel(model)

      app.stage.removeChildren()
      app.stage.addChild(model)

      // 居中摆放
      const w = Math.max(1, stageEl.clientWidth)
      const h = Math.max(1, stageEl.clientHeight)
      model.anchor.set(0.5, 0.5)
      model.position.set(w / 2, h / 2 + h * 0.06)

      // 元数据：优先从 DisplayInfo(cdi3) 枚举参数
      const metas = await loadCdi3Params(url)
      params = enrichParamRanges(core, metas)
      ;({ groups, byGroup } = groupParams(params))

      state.loadedUrl = url
      setStatus(`已加载：${url}`)
      render()
    } catch (err) {
      setStatus('加载失败')
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown error')
      setError(msg)
    }
  }

  // 每帧应用覆盖值（锁定时）
  app.ticker.add(() => {
    if (!live2d) return
    if (!state.lockOverride) return
    const c = core
    if (!c?.setParameterValueById) return
    for (const [id, v] of overrides.entries()) {
      try {
        c.setParameterValueById(id, v, 1)
      } catch {
        // ignore
      }
    }
  })

  const applyPatch = (patch: ParamPatch) => {
    if (!patch || typeof patch !== 'object') return
    for (const [id, v] of Object.entries(patch)) {
      if (!id) continue
      if (!Number.isFinite(v)) continue
      overrides.set(id, v)
      try {
        core?.setParameterValueById?.(id, v, 1)
      } catch {
        // ignore
      }
    }
    render()
  }

  const renderControls = () => {
    body.textContent = ''

    const sectionStatus = createEl('div', 'ndp-demo-section')
    const header = createEl('div', 'ndp-demo-section-title')
    const h3 = createEl('h3')
    h3.textContent = '状态'
    const kv = createEl('div', 'ndp-demo-kv')
    kv.textContent = state.loadedUrl ? `参数：${params.length} 个` : '尚未加载模型'
    header.appendChild(h3)
    header.appendChild(kv)
    sectionStatus.appendChild(header)

    const hint = createEl('div', 'ndp-demo-hint')
    hint.textContent =
      '如果列表为空：请确认 model3.json 中包含 FileReferences.DisplayInfo（*.cdi3.json），或在下方“手动参数 ID 列表”里粘贴参数 ID（每行一个）。'
    sectionStatus.appendChild(hint)
    body.appendChild(sectionStatus)

    const sectionFilter = createEl('div', 'ndp-demo-section')
    const header2 = createEl('div', 'ndp-demo-section-title')
    const h32 = createEl('h3')
    h32.textContent = '筛选'
    header2.appendChild(h32)
    sectionFilter.appendChild(header2)

    const row1 = createEl('div', 'ndp-demo-row')
    const query = createEl('input', 'ndp-demo-input')
    query.placeholder = '搜索参数（按 id/name）'
    query.value = state.query
    query.addEventListener('input', () => {
      state.query = query.value
      render()
    })

    const groupSel = createEl('select', 'ndp-demo-input') as HTMLSelectElement
    groupSel.style.maxWidth = '220px'
    const groupsAll = ['all', ...groups]
    groupSel.innerHTML = groupsAll.map((g) => `<option value="${g}">${g}</option>`).join('')
    groupSel.value = state.selectedGroup
    groupSel.addEventListener('change', () => {
      state.selectedGroup = groupSel.value
      render()
    })

    row1.appendChild(query)
    row1.appendChild(groupSel)
    sectionFilter.appendChild(row1)

    const row2 = createEl('div', 'ndp-demo-row')
    const lockBtn = createEl('button', 'ndp-demo-btn')
    const syncLockText = () => {
      lockBtn.textContent = state.lockOverride ? '锁定覆盖：ON' : '锁定覆盖：OFF'
    }
    syncLockText()
    lockBtn.addEventListener('click', () => {
      state.lockOverride = !state.lockOverride
      syncLockText()
    })

    const exportBtn = createEl('button', 'ndp-demo-btn')
    exportBtn.textContent = '导出覆盖 JSON'
    exportBtn.addEventListener('click', async () => {
      const obj: Record<string, number> = {}
      for (const [k, v] of overrides.entries()) obj[k] = v
      await copyText(JSON.stringify(obj, null, 2))
    })

    const clearBtn = createEl('button', 'ndp-demo-btn ndp-demo-btn-danger')
    clearBtn.textContent = '清空覆盖'
    clearBtn.addEventListener('click', () => {
      overrides.clear()
      render()
    })

    row2.appendChild(lockBtn)
    row2.appendChild(exportBtn)
    row2.appendChild(clearBtn)
    sectionFilter.appendChild(row2)

    body.appendChild(sectionFilter)

    // 手动参数 ID 列表（兜底）
    const sectionManual = createEl('div', 'ndp-demo-section')
    const header3 = createEl('div', 'ndp-demo-section-title')
    const h33 = createEl('h3')
    h33.textContent = '手动参数 ID 列表（兜底）'
    header3.appendChild(h33)
    sectionManual.appendChild(header3)

    const manual = createEl('textarea', 'ndp-demo-textarea')
    manual.placeholder = '每行一个参数 ID，例如：\nParamAngleX\nParamAngleY\nParamBodyAngleZ'
    manual.value = state.manualIds
    manual.addEventListener('input', () => {
      state.manualIds = manual.value
    })
    sectionManual.appendChild(manual)

    const applyManualBtn = createEl('button', 'ndp-demo-btn ndp-demo-btn-primary')
    applyManualBtn.textContent = '用手动列表生成参数面板'
    applyManualBtn.addEventListener('click', () => {
      const ids = state.manualIds
        .split(/\r?\n/g)
        .map((s) => s.trim())
        .filter(Boolean)
      const metas: Live2DParamMeta[] = ids.map((id) => ({ id, name: id, group: 'manual' }))
      params = enrichParamRanges(core, metas)
      ;({ groups, byGroup } = groupParams(params))
      state.selectedGroup = 'all'
      state.query = ''
      render()
    })
    sectionManual.appendChild(createEl('div', 'ndp-demo-row')).appendChild(applyManualBtn)
    body.appendChild(sectionManual)

    // 参数列表
    const sectionParams = createEl('div', 'ndp-demo-section')
    const header4 = createEl('div', 'ndp-demo-section-title')
    const h34 = createEl('h3')
    h34.textContent = '参数'
    const kv2 = createEl('div', 'ndp-demo-kv')
    kv2.textContent = `覆盖：${overrides.size} 个`
    header4.appendChild(h34)
    header4.appendChild(kv2)
    sectionParams.appendChild(header4)

    const q = state.query.trim().toLowerCase()
    const pick = (list: Live2DParamMeta[]) =>
      list.filter((p) => {
        if (!q) return true
        return p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      })

    const lists: Live2DParamMeta[] = []
    if (state.selectedGroup === 'all') {
      for (const g of groups) lists.push(...pick(byGroup.get(g) ?? []))
      // 没有 cdi3 时 groups 为空：直接展示 params
      if (groups.length === 0) lists.push(...pick(params))
    } else {
      lists.push(...pick(byGroup.get(state.selectedGroup) ?? []))
    }

    if (!state.loadedUrl) {
      const empty = createEl('div', 'ndp-demo-hint')
      empty.textContent = '请先 Load 一个模型。'
      sectionParams.appendChild(empty)
      body.appendChild(sectionParams)
      return
    }

    if (!core?.setParameterValueById) {
      const warn = createEl('div', 'ndp-demo-error')
      warn.textContent = '当前模型未暴露 coreModel.setParameterValueById，无法写入参数（可能不是 Cubism 3+ 模型）。'
      sectionParams.appendChild(warn)
    }

    for (const p of lists) {
      const item = createEl('div', 'ndp-demo-param')
      const head = createEl('div', 'ndp-demo-param-head')
      const left = createEl('div')
      const idEl = createEl('div', 'ndp-demo-param-id')
      idEl.textContent = p.id
      const nameEl = createEl('div', 'ndp-demo-param-name')
      nameEl.textContent = `${p.name}${p.group ? ` · ${p.group}` : ''}`
      left.appendChild(idEl)
      left.appendChild(nameEl)
      const valEl = createEl('div', 'ndp-demo-param-value')
      const current = overrides.has(p.id) ? overrides.get(p.id)! : (p.value ?? core?.getParameterValueById?.(p.id) ?? 0)
      valEl.textContent = Number.isFinite(current) ? current.toFixed(3) : 'n/a'
      head.appendChild(left)
      head.appendChild(valEl)
      item.appendChild(head)

      const sliderRow = createEl('div', 'ndp-demo-slider-row')
      const minEl = createEl('div', 'ndp-demo-mini')
      const maxEl = createEl('div', 'ndp-demo-mini')
      const min = Number.isFinite(p.min as number) ? (p.min as number) : -30
      const max = Number.isFinite(p.max as number) ? (p.max as number) : 30
      minEl.textContent = String(min)
      maxEl.textContent = String(max)

      const range = createEl('input') as HTMLInputElement
      range.type = 'range'
      range.min = String(min)
      range.max = String(max)
      range.step = '0.01'
      range.value = String(clampNumber(current, clampNumber(p.def, 0)))

      const copyBtn = createEl('button', 'ndp-demo-icon-btn')
      copyBtn.innerHTML = iconCopySvg()
      copyBtn.title = '复制该参数的 JSON 片段'
      copyBtn.addEventListener('click', async () => {
        const v = clampNumber(range.value, 0)
        await copyText(JSON.stringify({ [p.id]: v }, null, 2))
      })

      const onSet = (value: number) => {
        overrides.set(p.id, value)
        try {
          core?.setParameterValueById?.(p.id, value, 1)
        } catch {
          // ignore
        }
        valEl.textContent = Number.isFinite(value) ? value.toFixed(3) : 'n/a'
      }

      range.addEventListener('input', () => onSet(clampNumber(range.value, 0)))
      sliderRow.appendChild(minEl)
      sliderRow.appendChild(range)
      sliderRow.appendChild(maxEl)
      sliderRow.appendChild(copyBtn)
      item.appendChild(sliderRow)

      sectionParams.appendChild(item)
    }

    body.appendChild(sectionParams)
  }

  const renderScript = () => {
    body.textContent = ''

    const section = createEl('div', 'ndp-demo-section')
    const header = createEl('div', 'ndp-demo-section-title')
    const h3 = createEl('h3')
    h3.textContent = 'Script（批量设置参数）'
    header.appendChild(h3)
    section.appendChild(header)

    const hint = createEl('div', 'ndp-demo-hint')
    hint.textContent =
      '粘贴 JSON 后点击 Apply。支持对象（id->value）或数组（[{id,value}]）。该功能适合让 LLM 直接输出参数 patch。'
    section.appendChild(hint)

    const ta = createEl('textarea', 'ndp-demo-textarea')
    ta.value = state.scriptText
    ta.addEventListener('input', () => {
      state.scriptText = ta.value
    })
    section.appendChild(ta)

    const row = createEl('div', 'ndp-demo-row')
    const applyBtn = createEl('button', 'ndp-demo-btn ndp-demo-btn-primary')
    applyBtn.textContent = 'Apply'
    const copyBtn = createEl('button', 'ndp-demo-btn')
    copyBtn.textContent = '复制当前覆盖为 JSON'
    const clearBtn = createEl('button', 'ndp-demo-btn ndp-demo-btn-danger')
    clearBtn.textContent = '清空覆盖'

    applyBtn.addEventListener('click', () => {
      const parsed = parseParamPatch(ta.value)
      if (!parsed.ok) {
        setError(parsed.error)
        return
      }
      setError('')
      applyPatch(parsed.patch)
    })
    copyBtn.addEventListener('click', async () => {
      const obj: Record<string, number> = {}
      for (const [k, v] of overrides.entries()) obj[k] = v
      await copyText(JSON.stringify(obj, null, 2))
    })
    clearBtn.addEventListener('click', () => {
      overrides.clear()
      render()
    })

    row.appendChild(applyBtn)
    row.appendChild(copyBtn)
    row.appendChild(clearBtn)
    section.appendChild(row)

    if (state.error) {
      const err = createEl('div', 'ndp-demo-error')
      err.textContent = state.error
      section.appendChild(err)
    }

    body.appendChild(section)
  }

  const render = () => {
    if (state.tab === 'controls') renderControls()
    else renderScript()
  }

  loadBtn.addEventListener('click', () => {
    state.modelUrl = urlInput.value.trim()
    void loadModel(state.modelUrl)
  })
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.modelUrl = urlInput.value.trim()
      void loadModel(state.modelUrl)
    }
  })

  // 初次默认不自动加载，避免默认路径导致“加载失败”噪声；如果通过 ?model= 传入则自动加载
  if (state.modelUrl) void loadModel(state.modelUrl)
}

void main()
