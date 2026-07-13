import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { VectorSearchHit, VectorSearchRequest, VectorSearchResponse } from '../vectorSearchWorker'

export type MemoryVectorSearchArgs = Omit<VectorSearchRequest, 'id'>

export type MemoryVectorWorker = {
  unref: () => void
  on: {
    (event: 'message', listener: (message: VectorSearchResponse) => void): MemoryVectorWorker
    (event: 'error', listener: (error: Error) => void): MemoryVectorWorker
    (event: 'exit', listener: (code: number) => void): MemoryVectorWorker
  }
  postMessage: (message: VectorSearchRequest) => void
  terminate: () => Promise<number>
}

export type MemoryVectorWorkerFactory = (
  filename: string,
  options: { workerData: { dbPath: string } },
) => MemoryVectorWorker

export type MemoryVectorSearchClientOptions = {
  timeoutMs?: number
  workerPath?: string
  workerFactory?: MemoryVectorWorkerFactory
}

type PendingSearch = {
  resolve: (hits: VectorSearchHit[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class MemoryVectorSearchClient {
  private readonly dbPath: string
  private readonly timeoutMs: number
  private readonly workerPath: string
  private readonly workerFactory: MemoryVectorWorkerFactory
  private worker: MemoryVectorWorker | null = null
  private sequence = 0
  private readonly pending = new Map<number, PendingSearch>()

  constructor(dbPath: string, options: MemoryVectorSearchClientOptions = {}) {
    this.dbPath = dbPath
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 15_000))
    this.workerPath = options.workerPath ?? path.join(__dirname, 'vectorSearchWorker.js')
    this.workerFactory =
      options.workerFactory ??
      ((filename, workerOptions) => new Worker(filename, workerOptions) as unknown as MemoryVectorWorker)
  }

  close(reason: Error = new Error('memory service closed')): void {
    this.disposeWorker(reason)
  }

  search(args: MemoryVectorSearchArgs): Promise<VectorSearchHit[]> {
    const worker = this.getWorker()
    const id = ++this.sequence
    return new Promise<VectorSearchHit[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.worker === worker) this.disposeWorker(new Error('vector search timeout'))
        const duration = this.timeoutMs % 1000 === 0 ? `${this.timeoutMs / 1000}s` : `${this.timeoutMs}ms`
        reject(new Error(`向量检索超时（${duration}）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      try {
        worker.postMessage({ id, ...args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        const normalized = error instanceof Error ? error : new Error(String(error))
        if (this.worker === worker) this.disposeWorker(normalized)
        reject(normalized)
      }
    })
  }

  private getWorker(): MemoryVectorWorker {
    if (this.worker) return this.worker
    const worker = this.workerFactory(this.workerPath, { workerData: { dbPath: this.dbPath } })
    worker.unref()
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if ('error' in message) pending.reject(new Error(message.error))
      else pending.resolve(message.hits)
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.disposeWorker(error instanceof Error ? error : new Error(String(error)))
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.disposeWorker(new Error(`vector worker exited (code ${code})`))
    })
    this.worker = worker
    return worker
  }

  private disposeWorker(reason: Error): void {
    const worker = this.worker
    this.worker = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
    if (worker) void worker.terminate().catch(() => undefined)
  }
}
