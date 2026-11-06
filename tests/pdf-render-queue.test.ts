import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfExclusive, PdfRenderQueue } from '../src/readers/pdfRenderQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('PDF render queue', () => {
  it('keeps both panes serial and lets visible pages overtake prefetch', async () => {
    const queue = new PdfRenderQueue()
    const running = deferred()
    const order: string[] = []
    queue.enqueue(async () => { order.push('original'); await running.promise }, 0)
    queue.enqueue(async () => { order.push('prefetch') }, 1)
    queue.enqueue(async () => { order.push('translated') }, 0)
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['original'])
    running.resolve()
    await vi.runAllTimersAsync()
    expect(order).toEqual(['original', 'translated', 'prefetch'])
  })

  it('cancels pages scrolled away before they start', async () => {
    const queue = new PdfRenderQueue()
    const run = vi.fn(async () => {})
    const job = queue.enqueue(run, 0)
    job.cancel()
    await job.promise
    await vi.runAllTimersAsync()
    expect(run).not.toHaveBeenCalled()
  })

  it('reprioritizes a newly visible page without starting it twice', async () => {
    const queue = new PdfRenderQueue()
    const order: number[] = []
    queue.enqueue(async () => { order.push(1) }, 1)
    const promoted = queue.enqueue(async () => { order.push(2) }, 1)
    promoted.setPriority(0)
    await vi.runAllTimersAsync()
    expect(order).toEqual([2, 1])
  })

  it('holds the slot until active cancellation settles and recovers after a failure', async () => {
    const queue = new PdfRenderQueue()
    const running = deferred()
    const first = queue.enqueue(() => running.promise, 0)
    await vi.advanceTimersByTimeAsync(1)
    first.cancel()
    const next = vi.fn(async () => { throw new Error('bad page') })
    const failed = queue.enqueue(next, 0)
    const rejected = expect(failed.promise).rejects.toThrow('bad page')
    const last = vi.fn(async () => {})
    queue.enqueue(last, 0)
    await vi.advanceTimersByTimeAsync(1)
    expect(next).not.toHaveBeenCalled()
    running.resolve()
    await vi.runAllTimersAsync()
    await rejected
    expect(last).toHaveBeenCalledOnce()
  })

  it('runs up to its concurrency, still in priority order', async () => {
    const queue = new PdfRenderQueue(2)
    const first = deferred(), second = deferred()
    const order: string[] = []
    queue.enqueue(async () => { order.push('prefetch') }, 1)
    queue.enqueue(async () => { order.push('original'); await first.promise }, 0)
    queue.enqueue(async () => { order.push('translated'); await second.promise }, 0)
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['original', 'translated'])
    second.resolve()
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['original', 'translated', 'prefetch'])
    first.resolve()
    await vi.runAllTimersAsync()
  })
})

describe('exclusive PDF drawing', () => {
  it('runs tasks one at a time in call order and continues after a failure', async () => {
    const exclusive = new PdfExclusive()
    const gate = deferred()
    const order: string[] = []
    const one = exclusive.run(async () => { order.push('one start'); await gate.promise; order.push('one end') })
    const two = exclusive.run(async () => { order.push('two'); throw new Error('bad page') })
    const three = exclusive.run(async () => { order.push('three'); return 3 })
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['one start'])
    gate.resolve()
    await one
    await expect(two).rejects.toThrow('bad page')
    await expect(three).resolves.toBe(3)
    expect(order).toEqual(['one start', 'one end', 'two', 'three'])
  })
})
