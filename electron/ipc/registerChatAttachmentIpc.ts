import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  LocalMediaError,
  LocalMediaRegistry,
  localMediaTypeFromPath,
  type LocalMediaReference,
} from '../localMediaRegistry'
import { LocalMediaServer } from '../localMediaServer'
import type { IpcHandle } from './registration'

const MANAGED_MEDIA_DIRECTORIES = [
  'chat-attachments',
  'task-output',
  'screenshots',
  'browser-screenshots',
  'mcp-tool-images',
  'generated-images',
  'video-qa',
  'video-qa-cache',
] as const

function attachmentExtension(mimeType: string): string {
  const mime = String(mimeType ?? '').trim().toLowerCase()
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/bmp') return '.bmp'
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/webm') return '.webm'
  if (mime === 'video/quicktime') return '.mov'
  if (mime === 'video/x-msvideo') return '.avi'
  if (mime === 'video/x-matroska') return '.mkv'
  return ''
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const raw = String(dataUrl ?? '').trim()
  if (!raw.startsWith('data:')) return null
  const separator = raw.indexOf(',')
  if (separator < 0) return null
  const metadata = raw.slice(5, separator)
  const payload = raw.slice(separator + 1)
  const parts = metadata.split(';').map((part) => part.trim())
  const mimeType = parts[0] ?? ''
  if (!parts.includes('base64') || !mimeType || !payload) return null
  return { mimeType, base64: payload }
}

function publicMediaError(error: unknown): Error {
  if (!(error instanceof LocalMediaError)) return new Error('Local media request failed')
  if (error.code === 'forbidden_path') return new Error('Local media path is not allowed')
  if (error.code === 'file_too_large') return new Error('Local media file is too large')
  if (error.code === 'unsupported_type') return new Error('Local media type is not supported')
  return new Error('Local media resource is unavailable')
}

export class ChatAttachmentIpcService {
  private readonly registry: LocalMediaRegistry
  private readonly server: LocalMediaServer

  constructor(
    private readonly userDataDir: string,
    private readonly createStoredName: (extension: string) => string = (extension) => `${randomUUID()}${extension}`,
  ) {
    this.registry = new LocalMediaRegistry({
      allowedRoots: MANAGED_MEDIA_DIRECTORIES.map((directory) => path.join(userDataDir, directory)),
    })
    this.server = new LocalMediaServer(this.registry)
  }

  private parseReference(payload: unknown): LocalMediaReference {
    const normalizePath = (value: string): string => {
      const raw = value.trim()
      if (!raw || path.isAbsolute(raw) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw
      return path.resolve(this.userDataDir, raw)
    }
    if (typeof payload === 'string') return normalizePath(payload)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
    const value = payload as Record<string, unknown>
    return {
      resourceId: typeof value.resourceId === 'string' ? value.resourceId.trim() : '',
      path: typeof value.path === 'string' ? normalizePath(value.path) : '',
    }
  }

  register(handle: IpcHandle): void {
    handle('chat:saveAttachment', async (_event, payload: unknown) => {
      const value = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
      const kind = value.kind === 'image' || value.kind === 'video' ? value.kind : ''
      if (!kind) throw new Error('invalid kind')

      const sourcePath = typeof value.sourcePath === 'string' ? value.sourcePath.trim() : ''
      const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl.trim() : ''
      const filename = typeof value.filename === 'string' ? value.filename.trim() : ''
      if (!sourcePath && !dataUrl) throw new Error('missing sourcePath/dataUrl')

      const baseDir = path.join(this.userDataDir, 'chat-attachments')
      await fs.mkdir(baseDir, { recursive: true })

      let extension = ''
      let detectedMime = ''
      let contentBytes = 0
      if (sourcePath) {
        if (process.platform === 'win32' && /^\\\\/.test(sourcePath)) throw new Error('UNC attachments are not supported')
        const sourceType = localMediaTypeFromPath(sourcePath)
        if (!sourceType || sourceType.kind !== kind) throw new Error('unsupported attachment type')
        const sourceStat = await fs.stat(sourcePath)
        if (!sourceStat.isFile()) throw new Error('attachment source is not a file')
        contentBytes = sourceStat.size
        detectedMime = sourceType.mimeType
        extension = path.extname(sourcePath).toLowerCase()
      } else {
        const parsed = parseDataUrl(dataUrl)
        if (!parsed) throw new Error('invalid dataUrl')
        detectedMime = parsed.mimeType
        extension = attachmentExtension(detectedMime)
        const expectedKind = detectedMime.startsWith('image/') ? 'image' : detectedMime.startsWith('video/') ? 'video' : ''
        if (!extension || expectedKind !== kind) throw new Error('unsupported attachment type')
        contentBytes = Buffer.byteLength(parsed.base64, 'base64')
      }

      const maxBytes = kind === 'image' ? 32 * 1024 * 1024 : 4 * 1024 * 1024 * 1024
      if (contentBytes <= 0 || contentBytes > maxBytes) throw new Error('attachment file is too large')

      const storedName = this.createStoredName(extension)
      const storedPath = path.join(baseDir, storedName)
      if (sourcePath) {
        await fs.copyFile(sourcePath, storedPath)
      } else {
        const parsed = parseDataUrl(dataUrl)
        if (!parsed) throw new Error('invalid dataUrl')
        await fs.writeFile(storedPath, Buffer.from(parsed.base64, 'base64'))
        detectedMime = parsed.mimeType
      }

      const resource = await this.registry.registerFile(storedPath)
      return {
        ok: true as const,
        kind,
        path: storedPath,
        resourceId: resource.id,
        filename: filename || storedName,
        ...(detectedMime ? { mimeType: detectedMime } : {}),
      }
    })

    handle('chat:readAttachmentDataUrl', async (_event, payload: unknown) => {
      try {
        const result = await this.server.readDataUrl(this.parseReference(payload))
        return { ok: true as const, ...result }
      } catch (error) {
        throw publicMediaError(error)
      }
    })

    handle('chat:getAttachmentUrl', async (_event, payload: unknown) => {
      try {
        const result = await this.server.getUrl(this.parseReference(payload))
        return { ok: true as const, ...result }
      } catch (error) {
        throw publicMediaError(error)
      }
    })
  }

  close(): Promise<void> {
    return this.server.close()
  }
}
