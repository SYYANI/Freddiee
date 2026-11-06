// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfView, type PdfViewHandle, type PdfViewProps } from '../src/readers/PdfView'

const fixture = vi.hoisted(() => ({
  render: vi.fn(), textLayer: vi.fn(), cancel: vi.fn(),
  holdBitmap: false, canvases: [] as HTMLCanvasElement[],
  text: undefined as Promise<{ page: number }> | undefined
}))
vi.mock('../src/readers/pdfjs', () => ({
  openDocument: () => ({ promise: Promise.resolve({ numPages: 2000, getPage: async (page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, 800 - y / scale] }),
    render: ({ canvas }: { canvas: HTMLCanvasElement }) => {
      fixture.render(page); fixture.canvases.push(canvas)
      let reject!: (error: Error) => void
      const promise = page === 1 && fixture.holdBitmap ? new Promise<void>((_done, fail) => { reject = fail }) : Promise.resolve()
      return { promise, cancel() { fixture.cancel(page); reject?.(new Error('cancelled')) } }
    },
    getTextContent: async () => ({ ...(page === 1 && fixture.text ? await fixture.text : { page }), items: [{ str: `Page ${page}` }], styles: {} }),
    getAnnotations: async () => []
  }) }), release() {} }),
  pageTexts: async () => [],
  pdfjs: { TextLayer: class {
    constructor(private options: { container: HTMLElement; textContentSource: { page: number } | ReadableStream<{ page: number }> }) {}
    async render() {
      const source = this.options.textContentSource
      const reader = 'getReader' in source ? source.getReader() : undefined
      const content = reader ? (await reader.read()).value! : source as { page: number }
      fixture.textLayer(content.page)
      this.options.container.textContent = `Page ${content.page}`
      if (reader) while (!(await reader.read()).done) {}
    }
    cancel() {}
  } }
}))

let root: Root, container: HTMLDivElement, props: PdfViewProps
beforeEach(() => {
  vi.useFakeTimers()
  fixture.render.mockClear(); fixture.textLayer.mockClear(); fixture.cancel.mockClear()
  fixture.text = undefined; fixture.holdBitmap = false; fixture.canvases = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CSS', {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  Object.defineProperty(window, 'freddie', { configurable: true, value: { annotations: { list: vi.fn(async () => []), save: vi.fn() } } })
  props = { paperId: 'paper', attachmentId: 'pdf', url: 'pdf', pageIndex: 0, onPageChange: vi.fn(),
    appearance: 'default', onOutlineLocation: vi.fn(), onUserScroll: vi.fn() }
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  await vi.runAllTimersAsync()
  container.remove()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const render = async (patch: Partial<PdfViewProps> = {}) => {
  props = { ...props, ...patch }
  await act(async () => root.render(createElement(PdfView, props)))
}
const tick = async (milliseconds = 50) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5) })
}

describe('PDF viewport lifecycle', () => {
  it('mounts only nearby pages in a 2000-page document and releases old bitmaps on a jump', async () => {
    await render()
    await tick()
    expect(container.querySelectorAll('.pdf-page')).toHaveLength(2)
    expect(container.querySelectorAll('.annotation-layer')).toHaveLength(2)
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBeGreaterThan(0)
    await render({ pageIndex: 1000 })
    await tick()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(4)
    expect(container.querySelector('[data-page-index="1000"] .textLayer')?.textContent).toBe('Page 1001')
    expect(container.querySelector('[data-page-index="0"]')).toBeNull()
    expect((container.querySelector('.pdf-canvas-area') as HTMLElement).style.height).toBe('1620010px')
  })

  it('coalesces scroll bursts and navigates using absolute page indices', async () => {
    await render()
    await tick()
    vi.mocked(props.onOutlineLocation!).mockClear()
    vi.mocked(props.onPageChange).mockClear()
    const scroller = container.querySelector('.pdf-scroller')!
    await act(async () => {
      for (let index = 0; index < 10; index++) {
        scroller.scrollTop = 810_000 + index
        scroller.dispatchEvent(new Event('scroll'))
      }
    })
    expect(props.onOutlineLocation).not.toHaveBeenCalled()
    await tick(20)
    expect(props.onOutlineLocation).toHaveBeenCalledOnce()
    expect(props.onPageChange).toHaveBeenCalledExactlyOnceWith(1000)
    expect(props.onUserScroll).toHaveBeenCalledOnce()
    await tick()
    expect(container.querySelector('[data-page-index="1000"] .textLayer')?.textContent).toBe('Page 1001')
    expect(container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(4)
  })

  it('discards a stale text response after scrolling away and prioritizes the destination', async () => {
    let resolve!: (content: { page: number }) => void
    fixture.text = new Promise((done) => { resolve = done })
    await render()
    await tick()
    expect(fixture.render.mock.calls.map(([page]) => page)).toEqual([1, 2])
    await render({ pageIndex: 1000 })
    await tick()
    await act(async () => resolve({ page: 1 }))
    await tick()
    expect(fixture.textLayer).not.toHaveBeenCalledWith(1)
    expect(fixture.render.mock.calls[2][0]).toBe(1001)
    expect(container.querySelector('[data-page-index="1000"] .textLayer')?.textContent).toBe('Page 1001')
  })

  it('cancels in-flight rasterization and releases its canvas before rendering the destination', async () => {
    fixture.holdBitmap = true
    await render()
    await tick()
    const canvas = fixture.canvases[0]
    expect(canvas.width).toBeGreaterThan(0)
    await render({ pageIndex: 1000 })
    await tick()
    expect(fixture.cancel).toHaveBeenCalledWith(1)
    expect(canvas.width).toBe(0)
    expect(fixture.textLayer).not.toHaveBeenCalledWith(1)
    expect(container.querySelector('[data-page-index="1000"] .textLayer')?.textContent).toBe('Page 1001')
  })

  it('keeps annotations when their page unmounts and mounts again', async () => {
    const reader = createRef<PdfViewHandle>()
    await act(async () => root.render(createElement(PdfView, { ...props, ref: reader })))
    await tick()
    await act(async () => reader.current!.addTextNote(0, { x: 0.2, y: 0.3 }, 'Remember this'))
    expect(container.querySelector('.annotation-note')?.getAttribute('title')).toBe('Remember this')
    await render({ pageIndex: 1000 })
    expect(container.querySelector('.annotation-note')).toBeNull()
    await render({ pageIndex: 0 })
    await tick()
    expect(container.querySelector('.annotation-note')?.getAttribute('title')).toBe('Remember this')
    expect(window.freddie.annotations.save).toHaveBeenCalledOnce()
    expect(window.freddie.annotations.list).toHaveBeenCalledOnce()
  })

  it('does not change document styles while scrolling without search or history marks', async () => {
    vi.stubGlobal('CSS', { highlights: new Map() })
    vi.stubGlobal('Highlight', class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } })
    const append = vi.spyOn(document.head, 'appendChild')
    await render()
    await tick()
    await render({ pageIndex: 5 })
    await tick()
    await render({ pageIndex: 0 })
    await tick()
    const highlightStyles = append.mock.calls.filter(([node]) => node instanceof HTMLStyleElement && node.textContent?.includes('::highlight'))
    expect(highlightStyles).toHaveLength(0)
  })
})
