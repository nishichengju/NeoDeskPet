import path from 'node:path'

export type LocalMediaPathStyle = 'win32' | 'posix'

export type LocalMediaPathPolicy = {
  allowedRoots: readonly string[]
  pathStyle?: LocalMediaPathStyle
  allowUnc?: boolean
}

function pathApi(style: LocalMediaPathStyle): typeof path.win32 | typeof path.posix {
  return style === 'posix' ? path.posix : path.win32
}

function isUncPath(value: string): boolean {
  return /^\\\\/.test(String(value ?? '').trim())
}

export function normalizeLocalMediaPath(rawPath: string, style: LocalMediaPathStyle = 'win32'): string {
  const api = pathApi(style)
  const resolved = api.resolve(String(rawPath ?? '').trim())
  const normalized = api.normalize(resolved).replace(/[\\/]+$/, '')
  return style === 'win32' ? normalized.toLowerCase() : normalized
}

export function isPathWithinRoot(candidatePath: string, rootPath: string, style: LocalMediaPathStyle = 'win32'): boolean {
  const api = pathApi(style)
  const candidate = normalizeLocalMediaPath(candidatePath, style)
  const root = normalizeLocalMediaPath(rootPath, style)
  const relative = api.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
}

export function isAllowedLocalMediaPath(candidatePath: string, policy: LocalMediaPathPolicy): boolean {
  const style = policy.pathStyle ?? 'win32'
  const candidate = String(candidatePath ?? '').trim()
  if (!candidate) return false
  if (style === 'win32' && isUncPath(candidate) && policy.allowUnc !== true) return false
  return policy.allowedRoots.some((root) => isPathWithinRoot(candidate, root, style))
}
