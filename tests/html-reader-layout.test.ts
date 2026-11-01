import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { readabilityCSS, readableProseLayoutCSS } from '../electron/main/localizer'
import { readerCSS } from '../src/readers/htmlReaderCSS'
import { elementPath, resolveElementPath } from '../src/readers/htmlAnchors'

const pages: JSDOM[] = []
afterEach(() => { pages.splice(0).forEach((page) => page.window.close()) })

// The inner article-body wrapper has been collapsed by Readability, so its
// ancestor-scoped column spans no longer apply to paragraphs in the outer grid.
const savedPage = `<html><head><style>
.content-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-flow: column; }
.article-body .reading-column { grid-column: 4 / span 6; }
.content-grid .wide { grid-column: 3 / span 8; grid-row: 1; }
.hidden-block { display: none; }
.diagram-grid { display: grid; grid-template-columns: 100px 100px; }
.diagram-grid p { grid-column: 2; grid-row: 1; }
</style></head><body class="rp-readability-body"><article class="rp-readability-content content-grid">
<div id="prose" class="content-grid">
<p id="opening" class="reading-column wide" data-rp-source="true">Opening paragraph.</p>
<p class="rp-translation-block">译文。</p>
<h2 class="reading-column">Next section</h2><p class="reading-column">Following paragraph.</p>
<div class="hidden-block">Hidden content</div>
<div data-rp-preserve-layout="true"><div class="diagram-grid"><p>Chart label</p></div></div>
<svg><foreignObject><div class="diagram-grid"><p>SVG label</p></div></foreignObject></svg>
</div></article></body></html>`

function pageWithStyle(css: string, html = savedPage): JSDOM {
  const page = new JSDOM(html)
  pages.push(page)
  const style = page.window.document.createElement('style')
  style.textContent = css
  page.window.document.head.appendChild(style)
  return page
}

describe('readable article grid layout', () => {
  it.each([
    ['imports', readabilityCSS],
    ['PDF export', readableProseLayoutCSS],
    ['default reader', readerCSS(16, 'default')],
    ['paper reader', readerCSS(16, 'paper')]
  ])('repairs root and nested grids in %s without changing note anchors or graphics', (_, css) => {
    const page = pageWithStyle('')
    const document = page.window.document
    const opening = document.getElementById('opening')!
    const anchor = elementPath(opening)!
    const body = document.body.innerHTML
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)

    for (const grid of document.querySelectorAll('.content-grid')) {
      const computed = page.window.getComputedStyle(grid)
      expect(computed.gridTemplateColumns).toBe('minmax(0, 1fr)')
      expect(computed.gridAutoFlow).toBe('row')
    }
    for (const block of document.querySelector('#prose')!.children) {
      if (block.tagName.toLowerCase() === 'svg') continue
      const computed = page.window.getComputedStyle(block)
      expect(computed.gridColumn).toBe('1 / -1')
      expect(computed.gridRow).toBe('auto')
    }
    expect(page.window.getComputedStyle(document.querySelector('.hidden-block')!).display).toBe('none')
    for (const diagram of document.querySelectorAll('.diagram-grid')) {
      expect(page.window.getComputedStyle(diagram).gridTemplateColumns).toBe('100px 100px')
      expect(page.window.getComputedStyle(diagram.firstElementChild!).gridColumn).toBe('2')
    }
    expect(document.body.innerHTML).toBe(body)
    expect(resolveElementPath(document, anchor)).toBe(opening)
    expect(elementPath(opening)).toBe(anchor)
  })

  it('leaves full-page clips in their source grid layout', () => {
    const page = pageWithStyle(readerCSS(16, 'default'), savedPage.replace('class="rp-readability-body"', ''))
    const computed = page.window.getComputedStyle(page.window.document.getElementById('prose')!)
    expect(computed.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))')
    expect(computed.gridAutoFlow).toBe('column')
    expect(page.window.getComputedStyle(page.window.document.getElementById('opening')!).gridColumn).toBe('3 / span 8')
  })
})
