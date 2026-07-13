import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryVectorSearchClient,
  type MemoryVectorWorker,
  type MemoryVectorWorkerFactory,
} from '../electron/memory/memoryVectorSearchClient'
import type { VectorSearchRequest, VectorSearchResponse } from '../electron/vectorSearchWorker'

class FakeWorker extends EventEmitter implements MemoryVectorWorker {
  readonly messages: VectorSearchRequest[] = []
  unrefCount = 0
  terminateCount = 0
  postError: Error | null = null

  unref(): void {
    this.unrefCount += 1
  }

  postMessage(message: VectorSearchRequest): void {
    if (this.postError) throw this.postError
    this.messages.push(message)
  }

  terminate(): Promise<number> {
    this.terminateCount += 1
    return Promise.resolve(0)
  }

  respond(message: VectorSearchResponse): void {
    this.emit('message', message)
  }
}

function createHarness(options: { timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = []
  const factory: MemoryVectorWorkerFactory = vi.fn((filename, workerOptions) => {
    expect(filename).toBe('vector-worker.js')
    expect(workerOptions).toEqual({ workerData: { dbPath: 'memory.sqlite3' } })
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  const client = new MemoryVectorSearchClient('memory.sqlite3', {
    timeoutMs: options.timeoutMs,
    workerPath: 'vector-worker.js',
    workerFactory: factory,
  })
  const args = {
    model: 'embedding-model',
    personaId: 'persona-1',
    includeShared: true,
    scanLimit: 200,
    minScore: 0.4,
    topK: 5,
    query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
  }
  return { client, factory, workers, args }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MemoryVectorSearchClient', () => {
  it('lazily reuses one worker and resolves responses by request id', async () => {
    const harness = createHarness()
    const first = harness.client.search(harness.args)
    const second = harness.client.search({ ...harness.args, topK: 2 })
    const worker = harness.workers[0]

    expect(harness.factory).toHaveBeenCalledTimes(1)
    expect(worker.unrefCount).toBe(1)
    expect(worker.messages.map((message) => message.id)).toEqual([1, 2])
    worker.respond({ id: 2, hits: [{ rowid: 22, sim: 0.8 }] })
    worker.respond({ id: 1, hits: [{ rowid: 11, sim: 0.9 }] })

    await expect(first).resolves.toEqual([{ rowid: 11, sim: 0.9 }])
    await expect(second).resolves.toEqual([{ rowid: 22, sim: 0.8 }])
    harness.client.close()
    expect(worker.terminateCount).toBe(1)
  })

  it('rejects all pending searches after a worker error and restarts lazily', async () => {
    const harness = createHarness()
    const first = harness.client.search(harness.args)
    const second = harness.client.search(harness.args)
    harness.workers[0].emit('error', new Error('worker failed'))

    await expect(first).rejects.toThrow('worker failed')
    await expect(second).rejects.toThrow('worker failed')
    expect(harness.workers[0].terminateCount).toBe(1)

    const restarted = harness.client.search(harness.args)
    expect(harness.factory).toHaveBeenCalledTimes(2)
    harness.workers[1].respond({ id: 3, hits: [] })
    await expect(restarted).resolves.toEqual([])
    harness.client.close()
  })

  it('disposes a timed-out worker and rejects with the configured duration', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ timeoutMs: 25 })
    const pending = harness.client.search(harness.args)
    const timedOut = expect(pending).rejects.toThrow('向量检索超时（25ms）')

    await vi.advanceTimersByTimeAsync(25)
    await timedOut
    expect(harness.workers[0].terminateCount).toBe(1)

    const restarted = harness.client.search(harness.args)
    expect(harness.factory).toHaveBeenCalledTimes(2)
    harness.workers[1].respond({ id: 2, hits: [] })
    await expect(restarted).resolves.toEqual([])
    harness.client.close()
  })

  it('cleans up when postMessage throws and when the client closes', async () => {
    const directWorker = new FakeWorker()
    directWorker.postError = new Error('message clone failed')
    const directClient = new MemoryVectorSearchClient('memory.sqlite3', {
      workerPath: 'vector-worker.js',
      workerFactory: () => directWorker,
    })
    const args = createHarness().args
    await expect(directClient.search(args)).rejects.toThrow('message clone failed')
    expect(directWorker.terminateCount).toBe(1)

    const harness = createHarness()
    const pending = harness.client.search(harness.args)
    const closed = expect(pending).rejects.toThrow('closed for test')
    harness.client.close(new Error('closed for test'))
    await closed
    expect(harness.workers[0].terminateCount).toBe(1)
  })
})
