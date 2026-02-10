import type { Live2DModel } from 'pixi-live2d-display'

export type Live2dParameterInfo = {
  id: string
  min?: number
  max?: number
  def?: number
}

export type Live2dCapabilities = {
  modelJsonUrl: string
  updatedAt: number
  parameters: Live2dParameterInfo[]
}

function clampNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  return value
}

function normalizeParamId(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (!raw || typeof raw !== 'object') return ''

  const obj = raw as Record<string, unknown>
  const direct =
    (typeof obj.id === 'string' && obj.id) ||
    (typeof obj._id === 'string' && obj._id) ||
    (typeof obj.name === 'string' && obj.name) ||
    ''
  if (direct.trim()) return direct.trim()

  const getString = obj.getString
  if (typeof getString === 'function') {
    try {
      const s = getString.call(raw)
      if (typeof s === 'string' && s.trim()) return s.trim()
    } catch {
      // ignore
    }
  }

  const toString = obj.toString
  if (typeof toString === 'function' && toString !== Object.prototype.toString) {
    try {
      const s = toString.call(raw)
      if (typeof s === 'string' && s.trim() && !s.includes('[object')) return s.trim()
    } catch {
      // ignore
    }
  }

  return ''
}

function toCubism2ParamName(cubism4Id: string): string {
  return cubism4Id
    .replace('Param', 'PARAM_')
    .replace(/([A-Z])/g, '_$1')
    .toUpperCase()
}

export type Live2dParamAccessor = {
  set: (id: string, value: number) => void
  get: (id: string) => number
  listParameters: () => Live2dParameterInfo[]
}

export function createLive2dParamAccessor(model: Live2DModel): Live2dParamAccessor {
  const internalModel = model.internalModel as unknown as { coreModel?: Record<string, unknown> }
  const core = internalModel?.coreModel as Record<string, unknown> | undefined

  // 注意：Live2D Cubism Core 的方法很多是“绑定到 native/WASM 对象”的成员函数，直接取出来当普通函数调用会丢失 this
  // 这会导致 getParameterCount/getParameterId/setParameterValueById 等悄悄失败（从而参数列表为空、脚本无效）
  const safeCoreCall = <T>(fn: unknown, args: unknown[], fallback: T): T => {
    if (!core || typeof fn !== 'function') return fallback
    try {
      return (fn as (...xs: unknown[]) => T).apply(core, args)
    } catch {
      return fallback
    }
  }

  const set = (id: string, value: number) => {
    if (!core) return
    const paramId = String(id ?? '').trim()
    if (!paramId) return

    // Cubism4 (preferred)
    const setById = core.setParameterValueById
    if (typeof setById === 'function') {
      safeCoreCall<void>(setById, [paramId, value], undefined)
      return
    }

    // Cubism2 fallback
    const setParamFloat = core.setParamFloat
    if (typeof setParamFloat === 'function') safeCoreCall<void>(setParamFloat, [toCubism2ParamName(paramId), value], undefined)
  }

  const get = (id: string): number => {
    if (!core) return Number.NaN
    const paramId = String(id ?? '').trim()
    if (!paramId) return Number.NaN

    const getById = core.getParameterValueById
    if (typeof getById === 'function') {
      const v = safeCoreCall<unknown>(getById, [paramId], Number.NaN)
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN
    }

    const getParamFloat = core.getParamFloat
    if (typeof getParamFloat === 'function') {
      const v = safeCoreCall<unknown>(getParamFloat, [toCubism2ParamName(paramId)], Number.NaN)
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN
    }

    return Number.NaN
  }

  const listParameters = (): Live2dParameterInfo[] => {
    if (!core) return []

    // Cubism4: getters by index
    const getCount = core.getParameterCount
    const getIdAt = core.getParameterId
    const getMinAt = core.getParameterMinimumValue
    const getMaxAt = core.getParameterMaximumValue
    const getDefAt = core.getParameterDefaultValue

    if (typeof getCount === 'function' && typeof getIdAt === 'function') {
      const count = safeCoreCall<number>(getCount, [], 0)
      const out: Live2dParameterInfo[] = []
      for (let i = 0; i < (typeof count === 'number' ? count : 0); i += 1) {
        const rawId = safeCoreCall<unknown>(getIdAt, [i], '')
        const id = normalizeParamId(rawId)
        if (!id) continue
        out.push({
          id,
          min: clampNumber(safeCoreCall(getMinAt, [i], Number.NaN)),
          max: clampNumber(safeCoreCall(getMaxAt, [i], Number.NaN)),
          def: clampNumber(safeCoreCall(getDefAt, [i], Number.NaN)),
        })
      }
      if (out.length > 0) return out
    }

    // Cubism4 (pixi-live2d-display 0.4.x): no getParameterId(), but has internal arrays:
    // - core._parameterIds (string[] or id handles)
    // - core._model.parameters.ids (id handles)
    // 这里尽量用公开 getter 取 min/max/def，用内部 ids 仅作为“列举 ID”
    if (typeof getCount === 'function') {
      const count = safeCoreCall<number>(getCount, [], 0)
      const coreAny = core as unknown as {
        _parameterIds?: unknown
        _model?: { parameters?: { ids?: unknown; count?: unknown } }
      }

      const idsRaw =
        (Array.isArray(coreAny?._parameterIds) ? (coreAny._parameterIds as unknown[]) : null) ??
        (Array.isArray(coreAny?._model?.parameters?.ids) ? (coreAny._model!.parameters!.ids as unknown[]) : null) ??
        null

      if (idsRaw && idsRaw.length > 0) {
        const out: Live2dParameterInfo[] = []
        const lim = typeof count === 'number' && count > 0 ? Math.min(count, idsRaw.length) : idsRaw.length
        for (let i = 0; i < lim; i += 1) {
          const id = normalizeParamId(idsRaw[i])
          if (!id) continue
          out.push({
            id,
            min: clampNumber(safeCoreCall(getMinAt, [i], Number.NaN)),
            max: clampNumber(safeCoreCall(getMaxAt, [i], Number.NaN)),
            def: clampNumber(safeCoreCall(getDefAt, [i], Number.NaN)),
          })
        }
        if (out.length > 0) return out
      }
    }

    // Cubism4: parameters.* arrays (some builds)
    const params = core.parameters as unknown
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const p = params as Record<string, unknown>
      const ids = Array.isArray(p.ids) ? (p.ids as unknown[]) : []
      const mins = Array.isArray(p.minimumValues) ? (p.minimumValues as unknown[]) : []
      const maxs = Array.isArray(p.maximumValues) ? (p.maximumValues as unknown[]) : []
      const defs = Array.isArray(p.defaultValues)
        ? (p.defaultValues as unknown[])
        : Array.isArray(p.values)
          ? (p.values as unknown[])
          : []

      const out: Live2dParameterInfo[] = []
      for (let i = 0; i < ids.length; i += 1) {
        const id = normalizeParamId(ids[i])
        if (!id) continue
        out.push({
          id,
          min: clampNumber(mins[i]),
          max: clampNumber(maxs[i]),
          def: clampNumber(defs[i]),
        })
      }
      if (out.length > 0) return out
    }

    return []
  }

  return { set, get, listParameters }
}

export type Live2dParamScriptOp =
  | { op: 'patch'; to: Record<string, number>; holdMs?: number }
  | { op: 'tween'; to: Record<string, number>; durationMs: number; ease?: 'linear' | 'in' | 'out' | 'inOut'; holdMs?: number }
  | { op: 'wait'; durationMs: number }
  | { op: 'sequence'; steps: Live2dParamScriptOp[] }
  | { op: 'reset' }

export type Live2dParamScriptPayload = {
  mode?: 'queue' | 'replace'
  script: Live2dParamScriptOp | Live2dParamScriptOp[]
}

type CompiledSegment =
  | { kind: 'wait'; durationMs: number }
  | { kind: 'patch' | 'tween'; to: Record<string, number>; durationMs: number; holdMs: number; ease: 'linear' | 'in' | 'out' | 'inOut' }

type ActiveSegment = {
  seg: CompiledSegment
  elapsedMs: number
  holdElapsedMs: number
  from: Record<string, number>
}

function easeValue(t: number, ease: 'linear' | 'in' | 'out' | 'inOut'): number {
  const x = Math.max(0, Math.min(1, t))
  if (ease === 'in') return x * x
  if (ease === 'out') return 1 - (1 - x) * (1 - x)
  if (ease === 'inOut') return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
  return x
}

function toFiniteIntMs(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(600000, Math.trunc(n)))
}

function toNumberRecord(value: unknown): Record<string, number> {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  if (!obj) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== 'string' || !k.trim()) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[k.trim()] = v
  }
  return out
}

function normalizeOp(raw: unknown): Live2dParamScriptOp | null {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!obj) return null
  const op = typeof obj.op === 'string' ? obj.op.trim() : ''
  if (op === 'reset') return { op: 'reset' }
  if (op === 'wait') return { op: 'wait', durationMs: toFiniteIntMs(obj.durationMs, 0) }
  if (op === 'patch') return { op: 'patch', to: toNumberRecord(obj.to), holdMs: toFiniteIntMs(obj.holdMs, 0) }
  if (op === 'tween') {
    const easeRaw = typeof obj.ease === 'string' ? obj.ease : ''
    const ease: 'linear' | 'in' | 'out' | 'inOut' =
      easeRaw === 'in' || easeRaw === 'out' || easeRaw === 'inOut' || easeRaw === 'linear' ? easeRaw : 'inOut'
    return {
      op: 'tween',
      to: toNumberRecord(obj.to),
      durationMs: toFiniteIntMs(obj.durationMs, 0),
      holdMs: toFiniteIntMs(obj.holdMs, 0),
      ease,
    }
  }
  if (op === 'sequence') {
    const stepsRaw = Array.isArray(obj.steps) ? obj.steps : []
    const steps = stepsRaw.map(normalizeOp).filter((x): x is Live2dParamScriptOp => Boolean(x))
    return { op: 'sequence', steps }
  }
  return null
}

function compileOps(ops: Live2dParamScriptOp[], out: CompiledSegment[]): void {
  for (const op of ops) {
    if (op.op === 'sequence') {
      compileOps(op.steps, out)
      continue
    }
    if (op.op === 'wait') {
      out.push({ kind: 'wait', durationMs: Math.max(0, op.durationMs) })
      continue
    }
    if (op.op === 'patch') {
      out.push({
        kind: 'patch',
        to: op.to ?? {},
        durationMs: 0,
        holdMs: Math.max(0, op.holdMs ?? 0),
        ease: 'linear',
      })
      continue
    }
    if (op.op === 'tween') {
      out.push({
        kind: 'tween',
        to: op.to ?? {},
        durationMs: Math.max(0, op.durationMs),
        holdMs: Math.max(0, op.holdMs ?? 0),
        ease: op.ease ?? 'inOut',
      })
      continue
    }
    if (op.op === 'reset') {
      out.push({ kind: 'patch', to: {}, durationMs: 0, holdMs: 0, ease: 'linear' })
      continue
    }
  }
}

export type Live2dParamScriptEngine = {
  enqueue: (payload: unknown) => { ok: boolean; queuedSegments: number; mode: 'queue' | 'replace'; error?: string }
  tick: (dtMs: number) => void
  reset: () => void
  isRunning: () => boolean
}

export function createLive2dParamScriptEngine(accessor: Pick<Live2dParamAccessor, 'set' | 'get'>): Live2dParamScriptEngine {
  const overrides: Record<string, number> = {}
  let active: ActiveSegment | null = null
  const queue: CompiledSegment[] = []

  const reset = () => {
    active = null
    queue.length = 0
    for (const k of Object.keys(overrides)) delete overrides[k]
  }

  const enqueue = (payloadRaw: unknown) => {
    const obj = payloadRaw && typeof payloadRaw === 'object' && !Array.isArray(payloadRaw) ? (payloadRaw as Record<string, unknown>) : null
    const mode: 'queue' | 'replace' = obj?.mode === 'replace' ? 'replace' : 'queue'
    const scriptRaw = obj && 'script' in obj ? obj.script : payloadRaw

    const opsRaw = Array.isArray(scriptRaw) ? scriptRaw : [scriptRaw]
    const ops = opsRaw.map(normalizeOp).filter((x): x is Live2dParamScriptOp => Boolean(x))
    if (ops.length === 0) return { ok: false, queuedSegments: 0, mode, error: 'empty script' }

    if (mode === 'replace') {
      active = null
      queue.length = 0
    }

    // reset 是“立即清空”的强指令
    if (ops.some((x) => x.op === 'reset')) reset()

    const compiled: CompiledSegment[] = []
    compileOps(ops.filter((x) => x.op !== 'reset'), compiled)
    for (const s of compiled) queue.push(s)

    return { ok: true, queuedSegments: compiled.length, mode }
  }

  const startNext = () => {
    if (active || queue.length === 0) return
    const seg = queue.shift()!
    if (seg.kind === 'wait') {
      active = { seg, elapsedMs: 0, holdElapsedMs: 0, from: {} }
      return
    }

    const from: Record<string, number> = {}
    for (const id of Object.keys(seg.to ?? {})) {
      const v0 = overrides[id]
      if (typeof v0 === 'number' && Number.isFinite(v0)) {
        from[id] = v0
        continue
      }
      const v = accessor.get(id)
      from[id] = Number.isFinite(v) ? v : 0
    }
    active = { seg, elapsedMs: 0, holdElapsedMs: 0, from }
  }

  const applyOverrides = () => {
    for (const [id, v] of Object.entries(overrides)) accessor.set(id, v)
  }

  const tick = (dtMsRaw: number) => {
    const dtMs = Math.max(0, Math.min(1000, Math.trunc(dtMsRaw)))
    if (dtMs <= 0) {
      applyOverrides()
      return
    }

    startNext()
    if (!active) {
      applyOverrides()
      return
    }

    const seg = active.seg
    active.elapsedMs += dtMs

    if (seg.kind === 'wait') {
      if (active.elapsedMs >= seg.durationMs) active = null
      applyOverrides()
      return
    }

    const to = seg.to ?? {}
    const duration = Math.max(0, seg.durationMs)

    if (duration <= 0) {
      for (const [id, v] of Object.entries(to)) overrides[id] = v
      if (seg.holdMs > 0) {
        active.holdElapsedMs += dtMs
        if (active.holdElapsedMs >= seg.holdMs) active = null
      } else {
        active = null
      }
      applyOverrides()
      return
    }

    const t = Math.min(1, active.elapsedMs / duration)
    const e = easeValue(t, seg.ease)
    for (const [id, v1] of Object.entries(to)) {
      const v0 = active.from[id] ?? 0
      overrides[id] = v0 + (v1 - v0) * e
    }

    if (t >= 1) {
      if (seg.holdMs > 0) {
        active.holdElapsedMs += dtMs
        if (active.holdElapsedMs >= seg.holdMs) active = null
      } else {
        active = null
      }
    }

    applyOverrides()
  }

  const isRunning = () => Boolean(active || queue.length > 0)

  return { enqueue, tick, reset, isRunning }
}
