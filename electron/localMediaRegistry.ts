import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isPathWithinRoot, type LocalMediaPathStyle } from './localMediaPolicy'

export type LocalMediaKind = 'image' | 'video'

export type LocalMediaReference = string | { resourceId?: string; path?: string }

export type LocalMediaResource = {
  id: string
  realPath: string
  kind: LocalMediaKind
  mimeType: string
  size: number
  createdAt: number
}

export type LocalMediaToken = {
  token: string
  resourceId: string
  expiresAt: number
}

export type LocalMediaErrorCode =
  | 'invalid_reference'
  | 'forbidden_path'
  | 'not_found'
  | 'unsupported_type'
  | 'file_too_large'
  | 'token_expired'

export class LocalMediaError extends Error {
  readonly code: LocalMediaErrorCode

  constructor(code: LocalMediaErrorCode, message: string) {
    super(message)
    this.name = 'LocalMediaError'
    this.code = code
  }
}

const MIME_BY_EXTENSION = new Map<string, { kind: LocalMediaKind; mimeType: string }>([
  ['.png', { kind: 'image', mimeType: 'image/png' }],
  ['.jpg', { kind: 'image', mimeType: 'image/jpeg' }],
  ['.jpeg', { kind: 'image', mimeType: 'image/jpeg' }],
  ['.webp', { kind: 'image', mimeType: 'image/webp' }],
  ['.gif', { kind: 'image', mimeType: 'image/gif' }],
  ['.bmp', { kind: 'image', mimeType: 'image/bmp' }],
  ['.mp4', { kind: 'video', mimeType: 'video/mp4' }],
  ['.webm', { kind: 'video', mimeType: 'video/webm' }],
  ['.mov', { kind: 'video', mimeType: 'video/quicktime' }],
  ['.avi', { kind: 'video', mimeType: 'video/x-msvideo' }],
  ['.mkv', { kind: 'video', mimeType: 'video/x-matroska' }],
])

export function localMediaTypeFromPath(filePath: string): { kind: LocalMediaKind; mimeType: string } | null {
  return MIME_BY_EXTENSION.get(path.extname(String(filePath ?? '')).toLowerCase()) ?? null
}

function pathStyleForCurrentPlatform(): LocalMediaPathStyle {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function isUncPath(value: string): boolean {
  return /^\\\\/.test(String(value ?? '').trim())
}

function samePath(left: string, right: string, style: LocalMediaPathStyle): boolean {
  return style === 'win32'
    ? path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
    : path.posix.normalize(left) === path.posix.normalize(right)
}

export class LocalMediaRegistry {
  private readonly allowedRoots: string[]
  private readonly tokenTtlMs: number
  private readonly maxImageBytes: number
  private readonly maxVideoBytes: number
  private readonly now: () => number
  private readonly createResourceId: () => string
  private readonly createToken: () => string
  private readonly pathStyle: LocalMediaPathStyle
  private readonly resources = new Map<string, LocalMediaResource>()
  private readonly resourceIdByPath = new Map<string, string>()
  private readonly tokens = new Map<string, LocalMediaToken>()

  constructor(options: {
    allowedRoots: readonly string[]
    tokenTtlMs?: number
    maxImageBytes?: number
    maxVideoBytes?: number
    now?: () => number
    createResourceId?: () => string
    createToken?: () => string
    pathStyle?: LocalMediaPathStyle
  }) {
    this.pathStyle = options.pathStyle ?? pathStyleForCurrentPlatform()
    this.allowedRoots = Array.from(
      new Set(
        options.allowedRoots
          .map((root) => String(root ?? '').trim())
          .filter(Boolean)
          .map((root) => path.resolve(root)),
      ),
    )
    this.tokenTtlMs = Math.max(1000, Math.trunc(options.tokenTtlMs ?? 30 * 60_000))
    this.maxImageBytes = Math.max(1, Math.trunc(options.maxImageBytes ?? 32 * 1024 * 1024))
    this.maxVideoBytes = Math.max(1, Math.trunc(options.maxVideoBytes ?? 4 * 1024 * 1024 * 1024))
    this.now = options.now ?? Date.now
    this.createResourceId = options.createResourceId ?? (() => `media_${randomUUID()}`)
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))
  }

  private normalizedPathKey(filePath: string): string {
    const normalized = path.normalize(filePath)
    return this.pathStyle === 'win32' ? normalized.toLowerCase() : normalized
  }

  private matchingLexicalRoots(candidatePath: string): string[] {
    return this.allowedRoots.filter((root) => isPathWithinRoot(candidatePath, root, this.pathStyle))
  }

  private async assertManagedRealPath(candidatePath: string): Promise<string> {
    const raw = String(candidatePath ?? '').trim()
    if (!raw || !path.isAbsolute(raw) || (this.pathStyle === 'win32' && isUncPath(raw))) {
      throw new LocalMediaError('forbidden_path', 'Local media path is not allowed')
    }

    const lexicalPath = path.resolve(raw)
    const lexicalRoots = this.matchingLexicalRoots(lexicalPath)
    if (lexicalRoots.length === 0) throw new LocalMediaError('forbidden_path', 'Local media path is not allowed')

    let realPath: string
    try {
      realPath = await fs.realpath(lexicalPath)
    } catch {
      throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }

    let allowed = false
    for (const root of lexicalRoots) {
      try {
        const realRoot = await fs.realpath(root)
        if (isPathWithinRoot(realPath, realRoot, this.pathStyle)) {
          allowed = true
          break
        }
      } catch {
        // A root that does not exist cannot authorize a resource.
      }
    }
    if (!allowed) throw new LocalMediaError('forbidden_path', 'Local media path is not allowed')
    return realPath
  }

  private async inspectFile(realPath: string): Promise<Omit<LocalMediaResource, 'id' | 'createdAt' | 'realPath'>> {
    let stat
    try {
      stat = await fs.stat(realPath)
    } catch {
      throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }
    if (!stat.isFile()) throw new LocalMediaError('not_found', 'Local media resource is unavailable')

    const type = localMediaTypeFromPath(realPath)
    if (!type) throw new LocalMediaError('unsupported_type', 'Local media type is not supported')
    const maxBytes = type.kind === 'image' ? this.maxImageBytes : this.maxVideoBytes
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw new LocalMediaError('file_too_large', 'Local media resource exceeds the size limit')
    }
    return { ...type, size: stat.size }
  }

  async registerFile(candidatePath: string): Promise<LocalMediaResource> {
    const realPath = await this.assertManagedRealPath(candidatePath)
    const inspected = await this.inspectFile(realPath)
    const pathKey = this.normalizedPathKey(realPath)
    const existingId = this.resourceIdByPath.get(pathKey)
    if (existingId) {
      const existing = this.resources.get(existingId)
      if (existing) {
        const updated = { ...existing, ...inspected, realPath }
        this.resources.set(existingId, updated)
        return updated
      }
    }

    const resource: LocalMediaResource = {
      id: this.createResourceId(),
      realPath,
      ...inspected,
      createdAt: this.now(),
    }
    this.resources.set(resource.id, resource)
    this.resourceIdByPath.set(pathKey, resource.id)
    return resource
  }

  private revokeResource(resourceId: string): void {
    const resource = this.resources.get(resourceId)
    if (resource) this.resourceIdByPath.delete(this.normalizedPathKey(resource.realPath))
    this.resources.delete(resourceId)
    for (const [token, entry] of this.tokens) {
      if (entry.resourceId === resourceId) this.tokens.delete(token)
    }
  }

  private async validateRegisteredResource(resource: LocalMediaResource): Promise<LocalMediaResource> {
    let currentRealPath: string
    try {
      currentRealPath = await fs.realpath(resource.realPath)
    } catch {
      this.revokeResource(resource.id)
      throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }
    if (!samePath(currentRealPath, resource.realPath, this.pathStyle)) {
      this.revokeResource(resource.id)
      throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }
    const inspected = await this.inspectFile(currentRealPath)
    const updated = { ...resource, ...inspected }
    this.resources.set(resource.id, updated)
    return updated
  }

  async resolveReference(reference: LocalMediaReference): Promise<LocalMediaResource> {
    const resourceId =
      reference && typeof reference === 'object' && !Array.isArray(reference)
        ? String(reference.resourceId ?? '').trim()
        : ''
    const candidatePath =
      typeof reference === 'string'
        ? reference.trim()
        : reference && typeof reference === 'object' && !Array.isArray(reference)
          ? String(reference.path ?? '').trim()
          : ''

    if (resourceId) {
      const resource = this.resources.get(resourceId)
      if (resource) return this.validateRegisteredResource(resource)
      if (!candidatePath) throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }
    if (candidatePath) return this.registerFile(candidatePath)
    throw new LocalMediaError('invalid_reference', 'Local media reference is invalid')
  }

  issueToken(resourceId: string): LocalMediaToken {
    if (!this.resources.has(resourceId)) throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    this.pruneExpiredTokens()
    const entry = {
      token: this.createToken(),
      resourceId,
      expiresAt: this.now() + this.tokenTtlMs,
    }
    this.tokens.set(entry.token, entry)
    return entry
  }

  async resolveToken(token: string): Promise<LocalMediaResource> {
    const key = String(token ?? '').trim()
    const entry = this.tokens.get(key)
    if (!entry) throw new LocalMediaError('not_found', 'Local media token is invalid')
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(key)
      throw new LocalMediaError('token_expired', 'Local media token has expired')
    }
    const resource = this.resources.get(entry.resourceId)
    if (!resource) {
      this.tokens.delete(key)
      throw new LocalMediaError('not_found', 'Local media resource is unavailable')
    }
    return this.validateRegisteredResource(resource)
  }

  async readDataUrl(reference: LocalMediaReference, maxBytes = 8 * 1024 * 1024): Promise<{
    resourceId: string
    mimeType: string
    dataUrl: string
  }> {
    const resource = await this.resolveReference(reference)
    if (resource.kind !== 'image') throw new LocalMediaError('unsupported_type', 'Only images can be read as data URLs')
    if (resource.size > Math.max(1, Math.trunc(maxBytes))) {
      throw new LocalMediaError('file_too_large', 'Local media resource exceeds the data URL limit')
    }
    const data = await fs.readFile(resource.realPath)
    return {
      resourceId: resource.id,
      mimeType: resource.mimeType,
      dataUrl: `data:${resource.mimeType};base64,${data.toString('base64')}`,
    }
  }

  private pruneExpiredTokens(): void {
    const now = this.now()
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token)
    }
  }

  clear(): void {
    this.tokens.clear()
    this.resources.clear()
    this.resourceIdByPath.clear()
  }
}
