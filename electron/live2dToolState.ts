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

let cachedCapabilities: Live2dCapabilities | null = null

function clampText(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = s.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen)
}

function clampNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  return value
}

export function getLive2dCapabilities(): Live2dCapabilities | null {
  return cachedCapabilities
}

export function clearLive2dCapabilities(): void {
  cachedCapabilities = null
}

export function setLive2dCapabilitiesFromRenderer(payload: unknown): { ok: true; value: Live2dCapabilities } | { ok: false; error: string } {
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  if (!obj) return { ok: false, error: 'payload not object' }

  const modelJsonUrl = clampText(obj.modelJsonUrl, 500)
  if (!modelJsonUrl) return { ok: false, error: 'missing modelJsonUrl' }

  const updatedAt = (() => {
    const t = typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now()
    return Number.isFinite(t) ? Math.trunc(t) : Date.now()
  })()

  const paramsRaw = Array.isArray(obj.parameters) ? obj.parameters : []
  const parameters: Live2dParameterInfo[] = []
  for (const it of paramsRaw.slice(0, 800)) {
    const p = it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null
    if (!p) continue
    const id = clampText(p.id, 200)
    if (!id) continue
    parameters.push({
      id,
      min: clampNumber(p.min),
      max: clampNumber(p.max),
      def: clampNumber(p.def),
    })
  }

  const value: Live2dCapabilities = { modelJsonUrl, updatedAt, parameters }
  cachedCapabilities = value
  return { ok: true, value }
}

