import { describe, expect, it, vi } from 'vitest'
import { MemoryIndexQueue } from '../electron/memory/memoryIndexQueue'

describe('MemoryIndexQueue', () => {
  it('deduplicates rowids, preserves insertion order, and kicks for each valid enqueue', () => {
    const queue = new MemoryIndexQueue()
    const kick = vi.fn()
    queue.setKick(kick)

    queue.enqueue('tag', 3)
    queue.enqueue('tag', 1)
    queue.enqueue('tag', 3)

    expect(kick).toHaveBeenCalledTimes(3)
    expect(queue.take('tag', 1)).toEqual([3])
    expect(queue.take('tag', 10)).toEqual([1])
    expect(queue.take('tag', 10)).toEqual([])
  })

  it('keeps tag, embedding, and KG queues independent', () => {
    const queue = new MemoryIndexQueue()
    queue.enqueueAll(7)
    queue.enqueue('kg', 9)

    expect(queue.take('embedding', 10)).toEqual([7])
    expect(queue.take('tag', 10)).toEqual([7])
    expect(queue.take('kg', 10)).toEqual([7, 9])
  })

  it('ignores invalid rowids and supports disabling the kick callback', () => {
    const queue = new MemoryIndexQueue()
    const kick = vi.fn()
    queue.setKick(kick)
    queue.enqueue('tag', 0)
    queue.enqueue('tag', -1)
    queue.enqueue('tag', Number.NaN)
    expect(queue.take('tag', 10)).toEqual([])
    expect(kick).not.toHaveBeenCalled()

    queue.setKick(null)
    queue.enqueue('tag', 5)
    expect(queue.take('tag', 0)).toEqual([])
    expect(queue.take('tag', 10)).toEqual([5])
  })
})
