// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfView, type PdfViewProps } from '../src/readers/PdfView'
import { DualPdfView } from '../src/readers/DualPdfView'
import type { AssistantHistoryAnchor } from '../shared/types'

// Exercise the actual reader wiring and lazy text-layer lifecycle without a PDF worker or canvas rasterizer.
vi.mock('../src/readers/pdfjs', () => ({
  openDocument: () => ({ promise: Promise.resolve({ numPages: 6, getPage: async (page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => ({ text: `Saved passage on page ${page}.` }), getAnnotations: async () => []
  }) }), release: () => {} }),
  pageTexts: async () => [],
  pdfjs: { TextLayer: class {
    constructor(private options: { container: HTMLElement; textContentSource: { text: string } }) {}
    async render() {
      const span = document.createElement('span')
      span.textContent = this.options.textContentSource.text
      this.options.container.append(span)
    }
    cancel() {}
  } }
}))
class TestHighlight extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } }
let root: Root, container: HTMLDivElement, highlights: Map<string, TestHighlight>
const rect = { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20, toJSON: () => ({}) }
const anchor = (id: string, attachmentId = 'pdf', pageIndex = 0): AssistantHistoryAnchor => ({
  selectionIdentity: id, selection: { attachmentId, pageIndex, quote: `Saved passage on page ${pageIndex + 1}.` }
})
beforeEach(() => {
  window.getSelection()?.removeAllRanges()
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  highlights = new Map()
  vi.stubGlobal('CSS', { highlights })
  vi.stubGlobal('Highlight', TestHighlight)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [rect] },
    getBoundingClientRect: { configurable: true, value: () => rect }
  })
  Object.defineProperty(window, 'freddie', { configurable: true, value: { annotations: { list: vi.fn(async () => []), save: vi.fn() } } })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50) }) }
const click = async (target: Element) => {
  await act(async () => {
    for (const type of ['pointerdown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: 20, clientY: 30 }))
    await vi.advanceTimersByTimeAsync(1)
  })
}

describe('PDF assistant history', () => {
  it.each([2, 3])('reports a new PDF selection on click %i during history grace', async (detail) => {
    const activate = vi.fn(), select = vi.fn()
    await act(async () => root.render(createElement(PdfView, { paperId: 'paper', attachmentId: 'pdf', url: 'pdf', pageIndex: 0,
      onPageChange: vi.fn(), appearance: 'default', onSelection: select, onAssistantHistoryActivated: activate, assistantHistory: [anchor('saved')] })))
    await tick()
    const target = container.querySelector('.textLayer span')!
    // Ignore selectionchange queued when the preceding fixture was removed.
    select.mockClear()
    await click(target)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, detail, clientX: 20, clientY: 30 }))
      const range = document.createRange()
      range.setStart(target.firstChild!, 0); range.setEnd(target.firstChild!, detail === 2 ? 5 : target.textContent!.length)
      window.getSelection()!.addRange(range)
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail, clientX: 20, clientY: 30 }))
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(select.mock.lastCall?.[0]).toMatchObject({ attachmentId: 'pdf', pageIndex: 0, quote: detail === 2 ? 'Saved' : target.textContent })
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('matches legacy PDF anchors without an attachment ID', async () => {
    const saved = anchor('legacy')
    delete saved.selection.attachmentId
    const activate = vi.fn()
    await act(async () => root.render(createElement(PdfView, { paperId: 'paper', attachmentId: 'pdf', url: 'pdf', pageIndex: 0,
      onPageChange: vi.fn(), appearance: 'default', onAssistantHistoryActivated: activate, assistantHistory: [saved] })))
    await tick()
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(1)
    await click(container.querySelector('.textLayer span')!)
    expect(activate.mock.lastCall?.[0]).toEqual(saved)
  })

  it('marks the matching attachment on rendered pages, opens saved selections and respects annotation tools', async () => {
    const activate = vi.fn(), select = vi.fn()
    const saved = anchor('saved-pdf')
    const props: PdfViewProps = { paperId: 'paper', attachmentId: 'pdf', url: 'freddie://test.pdf', pageIndex: 0,
      onPageChange: vi.fn(), appearance: 'default', onSelection: select, onAssistantHistoryActivated: activate,
      assistantHistory: [saved, anchor('other-attachment', 'translated'), anchor('offscreen-page', 'pdf', 5)] }
    await act(async () => root.render(createElement(PdfView, props)))
    await tick()
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(1)
    const text = container.querySelector('.textLayer span')!
    await click(text)
    expect(activate.mock.lastCall?.[0]).toEqual(saved)
    expect(activate.mock.lastCall?.[1]).toMatchObject(saved.selection)
    expect(select).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(PdfView, { ...props, tool: { mode: 'erase', color: 'blue', lineWidth: 1 } })))
    await click(text)
    expect(activate).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(PdfView, { ...props, assistantHistory: [] })))
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(0)
  })

  it('restores independent histories from both panes of a bilingual PDF', async () => {
    const activate = vi.fn()
    const original = anchor('original-history', 'original'), translated = anchor('translated-history', 'translated')
    await act(async () => root.render(createElement(DualPdfView, {
      paperId: 'paper', original: { url: 'original', attachmentId: 'original', label: 'Original' },
      translated: { url: 'translated', attachmentId: 'translated', label: 'Translated' },
      pageIndex: 0, onPageChange: vi.fn(), appearance: 'default', findTarget: 'original',
      assistantHistory: [original, translated], onAssistantHistoryActivated: activate
    })))
    await tick()
    expect(highlights.get('rp-assistant-history-original')?.size).toBe(1)
    expect(highlights.get('rp-assistant-history-translated')?.size).toBe(1)
    const panes = container.querySelectorAll('.dual-pane')
    await click(panes[0].querySelector('.textLayer span')!)
    await click(panes[1].querySelector('.textLayer span')!)
    expect(activate.mock.calls.map(([item]) => item.selectionIdentity)).toEqual(['original-history', 'translated-history'])
  })

  it('rebuilds marks when lazy pages arrive or a PDF is reloaded', async () => {
    const props: PdfViewProps = { paperId: 'paper', attachmentId: 'pdf', url: 'v1', pageIndex: 0,
      onPageChange: vi.fn(), appearance: 'default', assistantHistory: [anchor('late-page', 'pdf', 5)] }
    await act(async () => root.render(createElement(PdfView, props)))
    await tick()
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(0)
    await act(async () => root.render(createElement(PdfView, { ...props, pageIndex: 5 })))
    // A browser emits scroll after scrollTop changes; jsdom does not.
    await act(async () => { container.querySelector('.pdf-scroller')!.dispatchEvent(new Event('scroll')) })
    await tick()
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(1)
    await act(async () => root.render(createElement(PdfView, { ...props, pageIndex: 5, url: 'v2' })))
    await act(async () => { container.querySelector('.pdf-scroller')!.dispatchEvent(new Event('scroll')) })
    await tick()
    expect(highlights.get('rp-assistant-history-pdf')?.size).toBe(1)
  })
})
