import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkTextContent } from '../src/readers/pdfTextContent'

type TextContent = Parameters<typeof chunkTextContent>[0]
function content(): TextContent {
  const word = (str: string) => ({ str, dir: 'ltr', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 0], fontName: 'f1', hasEOL: false })
  return { lang: 'zh-Hans', items: [
    { type: 'beginMarkedContentProps', id: 'paragraph' }, word('中文'), word('English'),
    { type: 'endMarkedContent', id: 'paragraph' }, word('最后一行')
  ], styles: { f1: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } } }
}
afterEach(() => vi.useRealTimers())

describe('cooperative PDF text layout', () => {
  it('preserves every item, marked-content boundary, font and language in order', async () => {
    const source = content()
    const reader = chunkTextContent(source, () => false, 2).getReader()
    const chunks: TextContent[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    expect(chunks.map((chunk) => chunk.items.length)).toEqual([2, 2, 1])
    expect(chunks.flatMap((chunk) => chunk.items)).toEqual(source.items)
    expect(chunks[0].styles).toEqual(source.styles)
    expect(chunks.slice(1).every((chunk) => Object.keys(chunk.styles).length === 0)).toBe(true)
    expect(chunks.every((chunk) => chunk.lang === source.lang)).toBe(true)
  })

  it('yields an input turn before the next batch without preloading ahead of its consumer', async () => {
    vi.useFakeTimers()
    const reader = chunkTextContent(content(), () => false, 2).getReader()
    await reader.read()
    expect(vi.getTimerCount()).toBe(0)
    let received = false
    const pending = reader.read().then((chunk) => { received = true; return chunk })
    await Promise.resolve()
    expect(received).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).value?.items).toHaveLength(2)
    await reader.cancel()
  })

  it('cancels while a batch is waiting without emitting more items or rejecting later', async () => {
    vi.useFakeTimers()
    const reader = chunkTextContent(content(), () => false, 2).getReader()
    await reader.read()
    const pending = reader.read()
    await Promise.resolve()
    await reader.cancel()
    await vi.runAllTimersAsync()
    expect((await pending).done).toBe(true)
  })

  it('stops stale work and still supplies metadata for an empty page', async () => {
    let cancelled = false
    const reader = chunkTextContent(content(), () => cancelled, 2).getReader()
    await reader.read()
    cancelled = true
    expect((await reader.read()).done).toBe(true)
    const empty = chunkTextContent({ ...content(), items: [] }, () => false).getReader()
    expect((await empty.read()).value).toMatchObject({ items: [], lang: 'zh-Hans', styles: content().styles })
    expect((await empty.read()).done).toBe(true)
  })
})
