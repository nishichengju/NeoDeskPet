export type MemoryIndexKind = 'tag' | 'embedding' | 'kg'

export class MemoryIndexQueue {
  private readonly queues: Record<MemoryIndexKind, Set<number>> = {
    tag: new Set<number>(),
    embedding: new Set<number>(),
    kg: new Set<number>(),
  }
  private kick: (() => void) | null = null

  setKick(callback: (() => void) | null): void {
    this.kick = callback
  }

  enqueue(kind: MemoryIndexKind, rowidRaw: number): void {
    const numeric = Number(rowidRaw)
    if (!Number.isFinite(numeric)) return
    const rowid = Math.min(2_000_000_000, Math.trunc(numeric))
    if (rowid <= 0) return
    this.queues[kind].add(rowid)
    this.kick?.()
  }

  enqueueAll(rowid: number): void {
    this.enqueue('tag', rowid)
    this.enqueue('embedding', rowid)
    this.enqueue('kg', rowid)
  }

  take(kind: MemoryIndexKind, limitRaw: number): number[] {
    const numeric = Number(limitRaw)
    if (!Number.isFinite(numeric)) return []
    const limit = Math.max(0, Math.trunc(numeric))
    if (limit === 0) return []

    const queue = this.queues[kind]
    const rowids: number[] = []
    for (const rowid of queue) {
      rowids.push(rowid)
      queue.delete(rowid)
      if (rowids.length >= limit) break
    }
    return rowids
  }
}
