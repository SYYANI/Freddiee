// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { renderDensePdfText } from '../src/readers/pdfDenseText'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type TextItem = Extract<TextContent['items'][number], { str: string }>

const viewport = { width: 200, height: 300, scale: 2, transform: [2, 0, 0, -2, 0, 300] } as ReturnType<PDFPageProxy['getViewport']>
function content(): TextContent {
  return { items: Array.from({ length: 1500 }, (_, i) => ({ str: i % 2 ? '文' : 'AB', dir: 'ltr', width: 7, height: 10,
    transform: [10, 0, 0, 10, 5, 10], fontName: 'f', hasEOL: i % 20 === 0 })),
  styles: { f: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
}

describe('dense PDF selectable text', () => {
  it('preserves all text and exact PDF coordinates in bounded SVG batches', async () => {
    const source = content(), layer = document.createElement('div')
    layer.className = 'textLayer'
    expect(await renderDensePdfText(source, viewport, layer, () => false)).toBe(true)
    expect(layer.textContent).toBe(source.items.map(item => (item as TextItem).str).join(''))
    expect(layer.querySelectorAll('tspan')).toHaveLength(1500)
    expect(layer.querySelectorAll('svg').length).toBeGreaterThan(5)
    let offset = 0
    const batches = [...layer.querySelectorAll('svg')]
    for (const svg of batches) {
      const length = svg.querySelectorAll('tspan').length
      expect(length).toBeLessThanOrEqual(256)
      offset += length
      if (svg !== batches.at(-1)) expect((source.items[offset - 1] as TextItem).hasEOL || length === 256).toBe(true)
    }
    const [run, glyph] = layer.querySelectorAll('tspan')
    expect(run.getAttribute('x')).toBe('10')
    expect(run.getAttribute('y')).toBe('280')
    expect(run.getAttribute('textLength')).toBe('14')
    expect(glyph.hasAttribute('textLength')).toBe(false)
    expect(run.parentElement!.style.fontSize).toBe('20px')
    expect(layer.querySelector('.pdf-text-loading')).toBeNull()
    expect(layer.hasAttribute('aria-busy')).toBe(false)
  })

  it('keeps the standard PDF.js layer for small, RTL, vertical and marked-content text', async () => {
    const small = content(); small.items.length = 10
    const rtl = content(); (rtl.items[0] as TextItem).dir = 'rtl'
    const vertical = content(); vertical.styles.f.vertical = true
    const marked = content(); marked.items[0] = { type: 'beginMarkedContent', id: 'figure' }
    for (const source of [small, rtl, vertical, marked]) {
      const layer = document.createElement('div'); layer.textContent = 'existing text'
      expect(await renderDensePdfText(source, viewport, layer, () => false)).toBe(false)
      expect(layer.textContent).toBe('existing text')
    }
  })

  it('yields to cancellation before committing a whole dense page and resumes cleanly', async () => {
    const layer = document.createElement('div'), source = content()
    let stopped = false
    const rendering = renderDensePdfText(source, viewport, layer, () => stopped)
    stopped = true
    await rendering
    expect(layer.querySelectorAll('tspan').length).toBeLessThan(1500)
    expect(layer.getAttribute('aria-busy')).toBe('true')
    expect(layer.querySelector('.pdf-text-loading')).not.toBeNull()
    await renderDensePdfText(source, viewport, layer, () => false)
    expect(layer.querySelectorAll('tspan')).toHaveLength(1500)
    expect(layer.hasAttribute('aria-busy')).toBe(false)
  })
})
