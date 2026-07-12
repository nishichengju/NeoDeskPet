export type VisionRoutingMode = 'off' | 'auto' | 'main-only' | 'fallback-only'

export type VisionCapability = 'auto' | 'supported' | 'unsupported'

export type VisionRoute = 'off' | 'main' | 'fallback' | 'unavailable'

export type VisionRouteReason =
  | 'routing-disabled'
  | 'main-selected'
  | 'main-probe-selected'
  | 'fallback-selected'
  | 'main-unavailable'
  | 'main-unsupported'
  | 'fallback-unavailable'
  | 'no-vision-provider'

export type VisionErrorKind =
  | 'vision-unsupported'
  | 'invalid-image'
  | 'transient'
  | 'rate-limit'
  | 'auth'
  | 'cancelled'
  | 'unknown'

export type VisionFailureKind = 'unsupported' | 'transient' | 'other'

export type VisionFailureAction = 'retry-current' | 'use-fallback' | 'stop'

export type VisionApiMode = 'openai-compatible' | 'claude'

export type VisionProfileLike = {
  id?: unknown
  name?: unknown
  apiMode?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  model?: unknown
}

export type ResolvedVisionProfile = {
  id: string
  name: string
  apiMode: VisionApiMode
  apiKey: string
  baseUrl: string
  model: string
}

export type ResolveVisionFallbackProfileResult =
  | { ok: true; profile: ResolvedVisionProfile }
  | {
      ok: false
      reason: 'not-selected' | 'not-found' | 'incomplete'
      profileId: string
      missing?: Array<'baseUrl' | 'model'>
    }

export type VisionRouteDecision = {
  route: VisionRoute
  reason: VisionRouteReason
  mode: VisionRoutingMode
  mainCapability: VisionCapability
  mainAvailable: boolean
  fallbackAvailable: boolean
  shouldProbeMain: boolean
}

export type VisionErrorClassification = {
  kind: VisionErrorKind
  message: string
  status?: number
  code?: string
  retryable: boolean
  marksMainUnsupported: boolean
}

export type VisionFailureDecision = {
  action: VisionFailureAction
  reason: 'explicitly-unsupported' | 'transient-retry' | 'transient-fallback' | 'not-retryable' | 'no-fallback'
  cacheMainCapability?: 'unsupported'
}

export function normalizeVisionRoutingMode(value: unknown): VisionRoutingMode {
  if (value === 'off' || value === 'main-only' || value === 'fallback-only') return value
  return 'auto'
}

export function normalizeVisionCapability(value: unknown): VisionCapability {
  if (value === 'supported' || value === 'unsupported') return value
  return 'auto'
}

export function getVisionRouteDecision(input: {
  mode?: unknown
  mainCapability?: unknown
  mainAvailable?: boolean
  fallbackAvailable?: boolean
}): VisionRouteDecision {
  const mode = normalizeVisionRoutingMode(input.mode)
  const mainCapability = normalizeVisionCapability(input.mainCapability)
  const mainAvailable = input.mainAvailable !== false
  const fallbackAvailable = input.fallbackAvailable === true

  const result = (route: VisionRoute, reason: VisionRouteReason, shouldProbeMain = false): VisionRouteDecision => ({
    route,
    reason,
    mode,
    mainCapability,
    mainAvailable,
    fallbackAvailable,
    shouldProbeMain,
  })

  if (mode === 'off') return result('off', 'routing-disabled')

  if (mode === 'fallback-only') {
    return fallbackAvailable ? result('fallback', 'fallback-selected') : result('unavailable', 'fallback-unavailable')
  }

  if (mode === 'main-only') {
    if (!mainAvailable) return result('unavailable', 'main-unavailable')
    if (mainCapability === 'unsupported') return result('unavailable', 'main-unsupported')
    return result('main', mainCapability === 'auto' ? 'main-probe-selected' : 'main-selected', mainCapability === 'auto')
  }

  if (mainAvailable && mainCapability !== 'unsupported') {
    return result('main', mainCapability === 'auto' ? 'main-probe-selected' : 'main-selected', mainCapability === 'auto')
  }
  if (fallbackAvailable) return result('fallback', 'fallback-selected')
  if (!mainAvailable) return result('unavailable', 'no-vision-provider')
  return result('unavailable', 'main-unsupported')
}

export function decideVisionRoute(input: {
  routingMode?: unknown
  capability?: unknown
  hasFallback?: boolean
  mainFailedKind?: VisionFailureKind | null
  mainAvailable?: boolean
  fallbackOnTransient?: boolean
  // Compatibility aliases for callers that already use the detailed vocabulary.
  mode?: unknown
  mainCapability?: unknown
  fallbackAvailable?: boolean
}): VisionRoute {
  const mode = normalizeVisionRoutingMode(input.routingMode ?? input.mode)
  const fallbackAvailable = input.hasFallback ?? input.fallbackAvailable ?? false
  const failedKind = input.mainFailedKind ?? null

  if (mode === 'off') return 'off'
  if (mode === 'fallback-only') return fallbackAvailable ? 'fallback' : 'unavailable'
  if (failedKind === 'unsupported') {
    return mode === 'auto' && fallbackAvailable ? 'fallback' : 'unavailable'
  }
  if (failedKind === 'transient') {
    return mode === 'auto' && fallbackAvailable && input.fallbackOnTransient !== false ? 'fallback' : 'unavailable'
  }
  if (failedKind === 'other') return 'unavailable'

  return getVisionRouteDecision({
    mode,
    mainCapability: input.capability ?? input.mainCapability,
    mainAvailable: input.mainAvailable,
    fallbackAvailable,
  }).route
}

export function resolveVisionFallbackProfileDetailed(input: {
  profileId?: unknown
  profiles?: readonly VisionProfileLike[] | null
  modelOverride?: unknown
}): ResolveVisionFallbackProfileResult {
  const profileId = String(input.profileId ?? '').trim()
  if (!profileId) return { ok: false, reason: 'not-selected', profileId }

  const profile = (Array.isArray(input.profiles) ? input.profiles : []).find(
    (item) => String(item?.id ?? '').trim() === profileId,
  )
  if (!profile) return { ok: false, reason: 'not-found', profileId }

  const baseUrl = String(profile.baseUrl ?? '').trim()
  const modelOverride = String(input.modelOverride ?? '').trim()
  const model = modelOverride || String(profile.model ?? '').trim()
  const missing: Array<'baseUrl' | 'model'> = []
  if (!baseUrl) missing.push('baseUrl')
  if (!model) missing.push('model')
  if (missing.length > 0) return { ok: false, reason: 'incomplete', profileId, missing }

  return {
    ok: true,
    profile: {
      id: profileId,
      name: String(profile.name ?? '').trim() || profileId,
      apiMode: profile.apiMode === 'claude' ? 'claude' : 'openai-compatible',
      apiKey: String(profile.apiKey ?? '').trim(),
      baseUrl,
      model,
    },
  }
}

export function resolveVisionFallbackProfile(settings: unknown): ResolvedVisionProfile | null {
  const root = errorRecord(settings)
  if (!root) return null
  const ai = errorRecord(root.ai) ?? root
  const profilesRaw = Array.isArray(root.aiProfiles)
    ? root.aiProfiles
    : Array.isArray(ai.profiles)
      ? ai.profiles
      : Array.isArray(root.profiles)
        ? root.profiles
        : []
  const profileId =
    ai.visionFallbackProfileId ?? ai.fallbackVisionProfileId ?? root.visionFallbackProfileId ?? root.fallbackVisionProfileId
  const modelOverride = ai.visionFallbackModel ?? ai.fallbackVisionModel ?? root.visionFallbackModel ?? root.fallbackVisionModel
  const resolved = resolveVisionFallbackProfileDetailed({
    profileId,
    profiles: profilesRaw as VisionProfileLike[],
    modelOverride,
  })
  return resolved.ok ? resolved.profile : null
}

function finiteStatus(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  const status = Math.trunc(n)
  return status >= 100 && status <= 599 ? status : undefined
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function collectErrorInfo(error: unknown): { message: string; status?: number; code?: string } {
  if (typeof error === 'string') return { message: error.trim() }
  const top = errorRecord(error)
  if (!top) return { message: String(error ?? '').trim() }

  const response = errorRecord(top.response)
  const nestedError = errorRecord(top.error)
  const cause = errorRecord(top.cause)
  const message = [top.message, nestedError?.message, response?.statusText, cause?.message]
    .find((value) => typeof value === 'string' && value.trim().length > 0)
  const status =
    finiteStatus(top.status) ??
    finiteStatus(top.statusCode) ??
    finiteStatus(response?.status) ??
    finiteStatus(nestedError?.status)
  const codeValue = [top.code, nestedError?.code, cause?.code].find(
    (value) => typeof value === 'string' || typeof value === 'number',
  )

  return {
    message: typeof message === 'string' ? message.trim() : String(error),
    ...(status ? { status } : {}),
    ...(codeValue !== undefined ? { code: String(codeValue).trim() } : {}),
  }
}

const VISION_UNSUPPORTED_PATTERNS = [
  /(?:model|endpoint|deployment).{0,80}(?:does not|doesn't|do not|not|cannot|can't).{0,30}(?:support|accept|handle).{0,30}(?:image|vision|multimodal)/iu,
  /(?:image|vision|multimodal).{0,50}(?:is |are )?(?:not supported|unsupported|not available|disabled for (?:this|the) model)/iu,
  /(?:only|text[- ]only).{0,30}(?:text|text input).{0,30}(?:supported|accepted)/iu,
  /(?:image_url|input_image|image input).{0,50}(?:unknown|unsupported|not permitted|not allowed).{0,30}(?:field|type|content)?/iu,
  /(?:image_url|input_image).{0,50}(?:only supported by|supported values? (?:are|include).{0,20}text)/iu,
  /(?:不支持|无法接收|不能处理).{0,24}(?:图片|图像|视觉|多模态)/u,
  /(?:图片|图像|视觉|多模态).{0,24}(?:不支持|不可用|未启用)/u,
]

const INVALID_IMAGE_PATTERNS = [
  /(?:invalid|malformed|corrupt|unreadable).{0,40}(?:image|image_url|base64)/iu,
  /(?:image|image_url|base64).{0,40}(?:invalid|malformed|corrupt|unreadable)/iu,
  /(?:image|request|payload).{0,40}(?:too large|exceeds?.{0,16}(?:limit|maximum)|maximum.{0,16}bytes)/iu,
  /(?:unsupported|invalid).{0,20}(?:image|media).{0,20}(?:format|mime|type)/iu,
  /(?:图片|图像).{0,24}(?:格式错误|格式不支持|损坏|过大|无法读取)/u,
]

const TRANSIENT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

export function classifyVisionErrorDetailed(error: unknown, statusOverride?: unknown): VisionErrorClassification {
  const info = collectErrorInfo(error)
  const message = info.message
  const status = finiteStatus(statusOverride) ?? info.status
  const code = info.code
  const searchable = `${message}\n${code ?? ''}`.trim()
  const base = { message, ...(status ? { status } : {}), ...(code ? { code } : {}) }

  if (INVALID_IMAGE_PATTERNS.some((pattern) => pattern.test(searchable))) {
    return { ...base, kind: 'invalid-image', retryable: false, marksMainUnsupported: false }
  }
  if (VISION_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(searchable))) {
    return { ...base, kind: 'vision-unsupported', retryable: false, marksMainUnsupported: true }
  }
  if (status === 413 || status === 415 || status === 422) {
    return { ...base, kind: 'invalid-image', retryable: false, marksMainUnsupported: false }
  }
  if (/\b(?:aborterror|aborted by user|cancelled|canceled)\b/iu.test(searchable)) {
    return { ...base, kind: 'cancelled', retryable: false, marksMainUnsupported: false }
  }
  if (status === 401 || status === 403 || /\b(?:unauthorized|forbidden|invalid api key|authentication failed)\b/iu.test(searchable)) {
    return { ...base, kind: 'auth', retryable: false, marksMainUnsupported: false }
  }
  if (status === 429 || /\b(?:rate limit|too many requests|quota exceeded)\b/iu.test(searchable)) {
    return { ...base, kind: 'rate-limit', retryable: true, marksMainUnsupported: false }
  }

  const normalizedCode = String(code ?? '').trim().toUpperCase()
  const transientStatus = status === 408 || status === 425 || (typeof status === 'number' && status >= 500)
  const transientMessage = /(?:fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|timed?\s*out|timeout|temporarily unavailable|bad gateway|service unavailable|gateway timeout|网络错误|连接(?:重置|中断|失败)|超时|服务不可用|网关错误)/iu.test(
    searchable,
  )
  if (transientStatus || TRANSIENT_CODES.has(normalizedCode) || transientMessage) {
    return { ...base, kind: 'transient', retryable: true, marksMainUnsupported: false }
  }

  return { ...base, kind: 'unknown', retryable: false, marksMainUnsupported: false }
}

export function classifyVisionError(error: unknown, status?: unknown): VisionFailureKind {
  const detailed = classifyVisionErrorDetailed(error, status)
  if (detailed.kind === 'vision-unsupported') return 'unsupported'
  if (detailed.kind === 'transient' || detailed.kind === 'rate-limit') return 'transient'
  return 'other'
}

export function decideVisionFailure(input: {
  mode?: unknown
  currentRoute: 'main' | 'fallback'
  error: VisionErrorClassification | unknown
  fallbackAvailable?: boolean
  retryCount?: number
  maxTransientRetries?: number
}): VisionFailureDecision {
  const mode = normalizeVisionRoutingMode(input.mode)
  const classification =
    errorRecord(input.error) && typeof (input.error as { kind?: unknown }).kind === 'string'
      ? (input.error as VisionErrorClassification)
      : classifyVisionErrorDetailed(input.error)
  const fallbackAllowed = input.currentRoute === 'main' && mode === 'auto' && input.fallbackAvailable === true
  const retryCount = Math.max(0, Math.trunc(Number(input.retryCount) || 0))
  const maxTransientRetries = Math.max(0, Math.trunc(Number(input.maxTransientRetries) || 0))

  if (classification.kind === 'vision-unsupported') {
    if (fallbackAllowed) {
      return { action: 'use-fallback', reason: 'explicitly-unsupported', cacheMainCapability: 'unsupported' }
    }
    return { action: 'stop', reason: 'no-fallback', cacheMainCapability: input.currentRoute === 'main' ? 'unsupported' : undefined }
  }

  if (classification.retryable) {
    if (retryCount < maxTransientRetries) return { action: 'retry-current', reason: 'transient-retry' }
    if (fallbackAllowed) return { action: 'use-fallback', reason: 'transient-fallback' }
    return { action: 'stop', reason: 'no-fallback' }
  }

  return { action: 'stop', reason: 'not-retryable' }
}
