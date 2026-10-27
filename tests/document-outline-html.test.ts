// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { htmlOutlineHeadings, observeHtmlOutline, visibleHeadingTarget } from '../src/readers/htmlOutline'
import { elementPath, resolveElementPath } from '../src/readers/htmlAnchors'
import { outlineAncestors, visibleOutlineEntries, type DocumentOutlineEntry } from '../shared/outline'

const rect = (top: number): DOMRect => ({ top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top, toJSON: () => ({}) })
let scrollTop = 0
beforeEach(() => {
  scrollTop = 0
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const hidden = this.closest('[hidden],[data-rp-hidden="true"],[style*="display:none"]') ||
      (document.documentElement.dataset.rpDisplayMode === 'translated' && this.getAttribute('data-rp-source') === 'true') ||
      (document.documentElement.dataset.rpDisplayMode === 'original' && this.classList.contains('rp-translation-block'))
    return (hidden ? [] : [rect(0)]) as unknown as DOMRectList
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rect(Number(this.getAttribute('data-top') ?? 0) - scrollTop) })
  document.body.innerHTML = `<h1>Document</h1>
    <h2 id="intro" data-top="100" data-rp-source="true" data-rp-segment-id="s1">Introduction</h2>
    <h2 class="rp-translation-block" data-top="130" data-rp-source-segment-id="s1">引言</h2>
    <section data-rp-hidden="true"><h2>Hidden heading</h2></section>
    <span class="rp-tex-math"><h3>Math artifact</h3></span>
    <nav><h2>Navigation</h2></nav><section hidden><h2>Hidden attribute</h2></section>
    <h2 id="methods" data-top="1400">Methods</h2>`
})
afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute('data-rp-display-mode'); document.body.replaceChildren() })

describe('HTML document outline', () => {
  it('skips synthetic, hidden and navigation headings and reuses stable note anchors', () => {
    const entries = htmlOutlineHeadings(document).map(({ entry }) => entry)
    expect(entries.map((entry) => entry.title)).toEqual(['Document', 'Introduction', 'Methods'])
    expect(entries[1].translation).toBe('引言')
    for (const entry of entries) expect(resolveElementPath(document, entry.anchor!)?.textContent).toBe(entry.title)
    const path = elementPath(document.getElementById('methods')!)
    document.getElementById('intro')!.insertAdjacentHTML('beforebegin', '<h2 class="rp-translation-block">新译文</h2><span data-rp-reader>Reader control</span>')
    expect(elementPath(document.getElementById('methods')!)).toBe(path)
    expect(htmlOutlineHeadings(document).map(({ entry }) => entry.anchor)).toEqual(entries.map((entry) => entry.anchor))
  })

  it('normalizes a document starting at h2 and navigates the visible translation in translated-only mode', () => {
    document.querySelector('h1')!.remove()
    document.documentElement.dataset.rpDisplayMode = 'translated'
    expect(htmlOutlineHeadings(document).map(({ entry }) => entry.level)).toEqual([1, 1])
    expect(visibleHeadingTarget(document.getElementById('intro')!)?.textContent).toBe('引言')
  })

  it('tracks scroll, translated heading updates, hidden region edits and display mode changes', async () => {
    const publish = vi.fn()
    const dispose = observeHtmlOutline(document, publish)
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalled())
      const methods = elementPath(document.getElementById('methods')!)
      scrollTop = 1400
      window.dispatchEvent(new Event('scroll'))
      await vi.waitFor(() => expect(publish.mock.lastCall?.[1]).toBe(methods))
      document.querySelector('.rp-translation-block')!.textContent = '新的引言'
      document.getElementById('methods')!.setAttribute('data-rp-hidden', 'true')
      await vi.waitFor(() => {
        const entries = publish.mock.lastCall?.[0] as DocumentOutlineEntry[]
        expect(entries).toHaveLength(2)
        expect(entries[1].translation).toBe('新的引言')
      })
      document.documentElement.dataset.rpDisplayMode = 'translated'
      await vi.waitFor(() => expect((publish.mock.lastCall?.[0] as DocumentOutlineEntry[]).map((entry) => entry.title)).toEqual(['Document', 'Introduction']))
    } finally { dispose() }
    const count = publish.mock.calls.length
    window.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publish).toHaveBeenCalledTimes(count)
  })

  it('builds the translation lookup once and does not rebuild for reader decoration classes', async () => {
    const queries = vi.spyOn(document, 'querySelectorAll')
    const dispose = observeHtmlOutline(document, vi.fn())
    try {
      await vi.waitFor(() => expect(queries.mock.calls.filter(([selector]) => selector === '.rp-translation-block[data-rp-source-segment-id]')).toHaveLength(1))
      const count = queries.mock.calls.length
      document.getElementById('intro')!.classList.add('rp-note-anchor-target')
      document.getElementById('methods')!.classList.add('rp-region-hover')
      await new Promise((resolve) => setTimeout(resolve, 160))
      expect(queries.mock.calls.length).toBe(count)
      document.getElementById('intro')!.style.display = 'none'
      await vi.waitFor(() => expect(queries.mock.calls.length).toBeGreaterThan(count))
      expect(queries.mock.calls.filter(([selector]) => selector === '.rp-translation-block[data-rp-source-segment-id]')).toHaveLength(2)
    } finally { dispose() }
  })

  it('publishes during continuous translation mutations instead of waiting for the stream to stop', async () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const dispose = observeHtmlOutline(document, publish)
    try {
      await vi.advanceTimersByTimeAsync(20)
      const initial = publish.mock.calls.length
      for (let i = 0; i < 13; i += 1) {
        document.querySelector('.rp-translation-block')!.textContent = `流式译文 ${i}`
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(publish.mock.calls.length).toBeGreaterThan(initial)
      expect((publish.mock.lastCall?.[0] as DocumentOutlineEntry[])[1].translation).toMatch(/^流式译文/)
    } finally { dispose(); vi.useRealTimers() }
  })

  it('filters original and translated titles, collapses descendants, and reveals the current section ancestors', () => {
    const entries: DocumentOutlineEntry[] = [
      { id: '1', title: 'Introduction', level: 1 }, { id: '2', title: 'Methods', translation: '方法', level: 2 },
      { id: '3', title: 'Setup', level: 3 }, { id: '4', title: 'Results', level: 1 }
    ]
    expect(visibleOutlineEntries(entries, new Set(), '').map((entry) => entry.id)).toEqual(['1', '4'])
    expect(visibleOutlineEntries(entries, new Set(['1']), '').map((entry) => entry.id)).toEqual(['1', '2', '4'])
    expect(visibleOutlineEntries(entries, new Set(), '方法').map((entry) => entry.id)).toEqual(['2'])
    expect(visibleOutlineEntries(entries, new Set(), 'setup').map((entry) => entry.id)).toEqual(['3'])
    expect(outlineAncestors(entries, '3')).toEqual(['2', '1'])
  })
})
