import { createReadStream } from 'node:fs'
import http from 'node:http'
import { LocalMediaError, LocalMediaRegistry, type LocalMediaReference, type LocalMediaResource } from './localMediaRegistry'

export type ByteRange = { start: number; end: number }

export function parseSingleByteRange(value: string, size: number, maxRangeBytes = 16 * 1024 * 1024): ByteRange | null {
  const raw = String(value ?? '').trim()
  if (!raw || !Number.isSafeInteger(size) || size <= 0 || raw.includes(',')) return null
  const match = raw.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null

  const limit = Math.max(1, Math.trunc(maxRangeBytes))
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    const length = Math.min(size, suffixLength, limit)
    return { start: size - length, end: size - 1 }
  }

  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null
  return { start, end: Math.min(size - 1, requestedEnd, start + limit - 1) }
}

function statusForMediaError(error: LocalMediaError): number {
  if (error.code === 'token_expired') return 410
  if (error.code === 'file_too_large') return 413
  if (error.code === 'unsupported_type') return 415
  if (error.code === 'forbidden_path') return 403
  return 404
}

export class LocalMediaServer {
  private server: http.Server | null = null
  private port: number | null = null

  constructor(
    private readonly registry: LocalMediaRegistry,
    private readonly options: { maxRangeBytes?: number } = {},
  ) {}

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end('method not allowed')
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(/^\/media\/([A-Za-z0-9_-]{16,128})$/)
    if (!match) {
      res.statusCode = 404
      res.end('not found')
      return
    }

    let resource: LocalMediaResource
    try {
      resource = await this.registry.resolveToken(match[1])
    } catch (error) {
      res.statusCode = error instanceof LocalMediaError ? statusForMediaError(error) : 404
      res.end('media unavailable')
      return
    }

    res.setHeader('Content-Type', resource.mimeType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Accept-Ranges', 'bytes')

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : ''
    if (rangeHeader) {
      const range = parseSingleByteRange(rangeHeader, resource.size, this.options.maxRangeBytes)
      if (!range) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${resource.size}`)
        res.end('range not satisfiable')
        return
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${resource.size}`)
      res.setHeader('Content-Length', String(range.end - range.start + 1))
      if (method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(resource.realPath, { start: range.start, end: range.end })
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 404
        res.destroy()
      })
      stream.pipe(res)
      return
    }

    res.setHeader('Content-Length', String(resource.size))
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(resource.realPath)
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 404
      res.destroy()
    })
    stream.pipe(res)
  }

  private async ensureListening(): Promise<number> {
    if (this.server && this.port !== null) return this.port
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        res.end('media unavailable')
      })
    })
    const port = await new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject)
        const address = this.server!.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Local media server failed to bind'))
      })
    })
    this.port = port
    return port
  }

  async getUrl(reference: LocalMediaReference): Promise<{
    resourceId: string
    url: string
    expiresAt: number
    mimeType: string
    size: number
  }> {
    const resource = await this.registry.resolveReference(reference)
    const token = this.registry.issueToken(resource.id)
    const port = await this.ensureListening()
    return {
      resourceId: resource.id,
      url: `http://127.0.0.1:${port}/media/${token.token}`,
      expiresAt: token.expiresAt,
      mimeType: resource.mimeType,
      size: resource.size,
    }
  }

  readDataUrl(reference: LocalMediaReference): ReturnType<LocalMediaRegistry['readDataUrl']> {
    return this.registry.readDataUrl(reference)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.registry.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
