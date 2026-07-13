import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizeImageRef, normalizeImagePathList } from './taskAgentVisionSession'

const DEFAULT_MAX_IMAGES = 8
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_REF_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[?#][^\s"')\]]*)?$/i

export type TaskToolImagePayload = {
  mimeType: string
  data: string
}

export type TaskToolMediaStoreOptions = {
  userDataDir: string
  maxImages?: number
  maxImageBytes?: number
  createId?: () => string
}

export type ImagePartOptions = {
  maxImageBytes?: number
}

export class TaskToolMediaStore {
  private readonly userDataDir: string
  private readonly maxImages: number
  private readonly maxImageBytes: number
  private readonly createId: () => string

  constructor(options: TaskToolMediaStoreOptions) {
    this.userDataDir = options.userDataDir
    this.maxImages = positiveInt(options.maxImages, DEFAULT_MAX_IMAGES)
    this.maxImageBytes = positiveInt(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
    this.createId = options.createId ?? randomUUID
  }

  async persistImages(taskId: string, images: TaskToolImagePayload[]): Promise<string[]> {
    if (!Array.isArray(images) || images.length === 0) return []

    const candidates = images.slice(0, this.maxImages)
    const decoded: Array<{ mimeType: SupportedImageMime; buffer: Buffer }> = []
    const seenHashes = new Set<string>()
    for (const item of candidates) {
      const parsed = parseImagePayload(item, this.maxImageBytes)
      if (!parsed) continue
      const hash = createHash('sha256').update(parsed.buffer).digest('hex')
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      decoded.push(parsed)
    }
    if (decoded.length === 0) return []

    const baseDir = path.join(this.userDataDir, 'chat-attachments')
    await fs.promises.mkdir(baseDir, { recursive: true })
    const safeTaskId = String(taskId ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24) || 'task'
    const output: string[] = []
    for (const image of decoded) {
      const filePath = path.join(baseDir, `${safeTaskId}-${this.createId()}${extensionForMime(image.mimeType)}`)
      await fs.promises.writeFile(filePath, image.buffer)
      output.push(filePath)
    }
    return output
  }

  async resolveImagePaths(taskId: string, toolText: string, images: TaskToolImagePayload[]): Promise<string[]> {
    const persisted = await this.persistImages(taskId, images)
    if (persisted.length > 0) return normalizeImagePathList(persisted, this.maxImages)
    return normalizeImagePathList(extractImageRefsFromToolText(toolText), this.maxImages)
  }
}

export function extractImageRefsFromToolText(text: string): string[] {
  const raw = String(text ?? '')
  if (!raw.trim()) return []

  const output = new Set<string>()
  const add = (value: unknown) => {
    const imageRef = canonicalizeImageRef(value)
    if (!imageRef || !isLikelyImageRef(imageRef)) return
    output.add(imageRef)
  }
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const item of Object.values(value as Record<string, unknown>)) walk(item)
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const preferred = collectPreferredImageRefs(parsed)
    if (preferred.length > 0) return preferred
    walk(parsed)
  } catch {
    // Free-form tool output is handled by the patterns below.
  }

  for (const match of raw.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) add(match[1])
  for (const match of raw.matchAll(/https?:\/\/[^\s<>()"'`]+/g)) add(match[0])
  for (const match of raw.matchAll(/(?:[a-zA-Z]:\\|\\\\|\/)[^\r\n"'`<>|?*]+?\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?[^\s"'`<>]*)?/g)) {
    add(match[0])
  }
  return Array.from(output).slice(0, DEFAULT_MAX_IMAGES)
}

export async function imageUrlPartsFromPaths(
  paths: string[],
  limit = 4,
  options: ImagePartOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const maxImages = positiveInt(limit, 4)
  const maxImageBytes = positiveInt(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  const parts: Array<Record<string, unknown>> = []
  for (const imageRef of normalizeImagePathList(paths, maxImages)) {
    const url = await imageRefToDataUrl(imageRef, maxImageBytes)
    if (!url) continue
    parts.push({ type: 'image_url', image_url: { url } })
    if (parts.length >= maxImages) break
  }
  return parts
}

function isLikelyImageRef(raw: string): boolean {
  const value = String(raw ?? '').trim()
  if (!value) return false
  if (/^data:image\//i.test(value)) return true
  if (/^blob:/i.test(value)) return true
  if (/^file:\/\//i.test(value)) return IMAGE_REF_RE.test(value)
  if (/^https?:\/\//i.test(value)) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(value) && IMAGE_REF_RE.test(value)
  }
  if (/^\/\//.test(value)) return false
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(value)) return false
  return IMAGE_REF_RE.test(value)
}

function collectPreferredImageRefs(value: unknown): string[] {
  const preferred = new Set<string>()
  const add = (candidate: unknown) => {
    const imageRef = canonicalizeImageRef(candidate)
    if (imageRef && isLikelyImageRef(imageRef)) preferred.add(imageRef)
  }
  const object = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  if (!object) return []
  add(object.path)
  if (Array.isArray(object.paths)) {
    for (const item of object.paths) add(item)
  }
  if (Array.isArray(object.images)) {
    for (const item of object.images) {
      const image = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
      add(image?.path)
    }
  }
  return Array.from(preferred).slice(0, DEFAULT_MAX_IMAGES)
}

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/bmp'

function parseImagePayload(
  item: TaskToolImagePayload,
  maxImageBytes: number,
): { mimeType: SupportedImageMime; buffer: Buffer } | null {
  const rawData = typeof item?.data === 'string' ? item.data.trim() : ''
  if (!rawData) return null

  let mimeType = normalizeSupportedMime(item?.mimeType, true)
  let base64 = rawData
  const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
  if (dataUrlMatch) {
    mimeType = normalizeSupportedMime(dataUrlMatch[1], false)
    base64 = dataUrlMatch[2] ?? ''
  }
  if (!mimeType) return null

  const buffer = decodeBase64(base64, maxImageBytes)
  return buffer ? { mimeType, buffer } : null
}

function normalizeSupportedMime(value: unknown, allowDefault: boolean): SupportedImageMime | null {
  const mimeType = String(value ?? '').trim().toLowerCase().split(';', 1)[0]
  if (!mimeType && allowDefault) return 'image/png'
  if (mimeType === 'image/jpg') return 'image/jpeg'
  if (
    mimeType === 'image/png' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/webp' ||
    mimeType === 'image/gif' ||
    mimeType === 'image/bmp'
  ) {
    return mimeType
  }
  return null
}

function decodeBase64(value: string, maxImageBytes: number): Buffer | null {
  const compact = String(value ?? '').replace(/\s+/g, '')
  if (!compact || compact.length % 4 === 1) return null
  if (compact.length > Math.ceil(maxImageBytes / 3) * 4 + 4) return null
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(compact)) return null
  const buffer = Buffer.from(compact, 'base64')
  if (!buffer.length || buffer.length > maxImageBytes) return null
  const normalizedInput = compact.replace(/=+$/g, '')
  const normalizedOutput = buffer.toString('base64').replace(/=+$/g, '')
  return normalizedInput === normalizedOutput ? buffer : null
}

function extensionForMime(mimeType: SupportedImageMime): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/bmp') return '.bmp'
  return '.png'
}

async function imageRefToDataUrl(imageRef: string, maxImageBytes: number): Promise<string | null> {
  const raw = String(imageRef ?? '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^data:image\//i.test(raw)) {
    const parsed = parseImagePayload({ mimeType: '', data: raw }, maxImageBytes)
    return parsed ? `data:${parsed.mimeType};base64,${parsed.buffer.toString('base64')}` : null
  }

  let filePath = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      filePath = fileURLToPath(raw)
    } catch {
      return null
    }
  }
  if (!path.isAbsolute(filePath)) return null

  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxImageBytes) return null
    const mimeType = imageMimeFromPath(filePath)
    if (!mimeType) return null
    const buffer = await fs.promises.readFile(filePath)
    if (!buffer.length || buffer.length > maxImageBytes) return null
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function imageMimeFromPath(filePath: string): SupportedImageMime | null {
  const extension = path.extname(String(filePath ?? '')).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'
  return null
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(1, number)
}
