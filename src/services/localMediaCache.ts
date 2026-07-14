import type { LocalMediaReference } from '../../electron/types'
import type { NeoDeskPetApi } from '../neoDeskPetApi'

export type LocalMediaCacheApi = Pick<NeoDeskPetApi, 'readChatAttachmentDataUrl' | 'getChatAttachmentUrl'>

type CacheEntry = { value: string; expiresAt: number }
type CacheState = {
  urls: Map<string, CacheEntry>
  dataUrls: Map<string, CacheEntry>
  pendingUrls: Map<string, Promise<string>>
  pendingDataUrls: Map<string, Promise<string>>
}

const URL_CACHE_LIMIT = 256
const DATA_URL_CACHE_LIMIT = 32
const URL_EXPIRY_GUARD_MS = 5_000
const DEFAULT_URL_TTL_MS = 60_000
const DATA_URL_TTL_MS = 60_000
const cacheByApi = new WeakMap<object, CacheState>()

function getState(api: LocalMediaCacheApi): CacheState {
  const key = api as object
  const existing = cacheByApi.get(key)
  if (existing) return existing
  const created: CacheState = {
    urls: new Map(),
    dataUrls: new Map(),
    pendingUrls: new Map(),
    pendingDataUrls: new Map(),
  }
  cacheByApi.set(key, created)
  return created
}

function normalizeReference(reference: LocalMediaReference): LocalMediaReference {
  if (typeof reference === 'string') return reference.trim()
  const resourceId = String(reference?.resourceId ?? '').trim()
  const path = String(reference?.path ?? '').trim()
  return resourceId ? { resourceId, ...(path ? { path } : {}) } : path
}

function referenceKey(reference: LocalMediaReference): string {
  const normalized = normalizeReference(reference)
  if (typeof normalized === 'string') return `path:${normalized}`
  return `resource:${normalized.resourceId ?? ''}\npath:${normalized.path ?? ''}`
}

function directSource(reference: LocalMediaReference): string {
  const normalized = normalizeReference(reference)
  const value = typeof normalized === 'string' ? normalized : String(normalized.path ?? '').trim()
  return /^(?:https?:|data:|blob:)/i.test(value) ? value : ''
}

function readCache(cache: Map<string, CacheEntry>, key: string, now: number): string {
  const entry = cache.get(key)
  if (!entry) return ''
  if (entry.expiresAt <= now) {
    cache.delete(key)
    return ''
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function writeCache(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry, limit: number) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value
    if (typeof oldestKey !== 'string') break
    cache.delete(oldestKey)
  }
}

export function buildLocalMediaReference(path: string, resourceId?: string): LocalMediaReference {
  const normalizedPath = String(path ?? '').trim()
  const normalizedResourceId = String(resourceId ?? '').trim()
  return normalizedResourceId
    ? { resourceId: normalizedResourceId, ...(normalizedPath ? { path: normalizedPath } : {}) }
    : normalizedPath
}

export function peekLocalMediaUrl(api: LocalMediaCacheApi | null, reference: LocalMediaReference): string {
  const direct = directSource(reference)
  if (direct || !api) return direct
  const entry = getState(api).urls.get(referenceKey(reference))
  return entry && entry.expiresAt > Date.now() + URL_EXPIRY_GUARD_MS ? entry.value : ''
}

export function resolveLocalMediaUrl(
  api: LocalMediaCacheApi | null,
  reference: LocalMediaReference,
): Promise<string> {
  const direct = directSource(reference)
  if (direct || !api) return Promise.resolve(direct)
  const normalized = normalizeReference(reference)
  const key = referenceKey(normalized)
  const state = getState(api)
  const cached = readCache(state.urls, key, Date.now() + URL_EXPIRY_GUARD_MS)
  if (cached) return Promise.resolve(cached)
  const pending = state.pendingUrls.get(key)
  if (pending) return pending

  const request = api
    .getChatAttachmentUrl(normalized)
    .then((result) => {
      const value = result?.ok && typeof result.url === 'string' ? result.url.trim() : ''
      if (!value) return ''
      const now = Date.now()
      const expiresAt = Number.isFinite(result.expiresAt) ? result.expiresAt : now + DEFAULT_URL_TTL_MS
      if (expiresAt > now + URL_EXPIRY_GUARD_MS) {
        writeCache(state.urls, key, { value, expiresAt }, URL_CACHE_LIMIT)
      }
      return value
    })
    .catch(() => '')
    .finally(() => state.pendingUrls.delete(key))
  state.pendingUrls.set(key, request)
  return request
}

export function resolveLocalMediaDataUrl(
  api: LocalMediaCacheApi | null,
  reference: LocalMediaReference,
): Promise<string> {
  const direct = directSource(reference)
  if (direct || !api) return Promise.resolve(direct)
  const normalized = normalizeReference(reference)
  const key = referenceKey(normalized)
  const state = getState(api)
  const cached = readCache(state.dataUrls, key, Date.now())
  if (cached) return Promise.resolve(cached)
  const pending = state.pendingDataUrls.get(key)
  if (pending) return pending

  const request = api
    .readChatAttachmentDataUrl(normalized)
    .then((result) => {
      const value = result?.ok && typeof result.dataUrl === 'string' ? result.dataUrl.trim() : ''
      if (!value) return ''
      writeCache(
        state.dataUrls,
        key,
        { value, expiresAt: Date.now() + DATA_URL_TTL_MS },
        DATA_URL_CACHE_LIMIT,
      )
      return value
    })
    .catch(() => '')
    .finally(() => state.pendingDataUrls.delete(key))
  state.pendingDataUrls.set(key, request)
  return request
}
