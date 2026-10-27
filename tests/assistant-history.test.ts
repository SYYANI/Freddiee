// @vitest-environment jsdom
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation, AssistantHistoryAnchor, AssistantStreamEvent } from '../shared/types'
import { bindAssistantHistory, historyQuoteRange, htmlHistoryRange } from '../src/readers/assistantHistory'
import { useAssistantHistory } from '../src/readers/useAssistantHistory'
import { HtmlView } from '../src/readers/HtmlView'
import { SelectionAssistant } from '../src/overlays/SelectionAssistant'
import { elementPath } from '../src/readers/htmlAnchors'

vi.mock('../src/app/context', () => ({ useT: () => (key: string) => key }))
vi.mock('../src/app/native', () => ({ errorText: (error: unknown) => String(error), popupMenu: vi.fn() }))

class TestHighlight extends Set<Range> {
  constructor(...ranges: Range[]) { super(ranges) }
}
const rect = { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20, toJSON: () => ({}) }
const anchor = (id = 'saved', attachmentId = 'html'): AssistantHistoryAnchor => ({
  selectionIdentity: id, selection: { attachmentId, quote: 'Saved passage.', htmlSelector: 'rp-path:0' }
})
const snapshot = (id = 'saved'): AssistantConversation => ({ ...anchor(id), action: 'explain',
  turns: [{ question: '', answer: 'Previously generated explanation.', sources: [] }], modifiedAt: '2026-01-01' })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let root: Root
let container: HTMLDivElement
let highlights: Map<string, TestHighlight>
let listener: (event: AssistantStreamEvent) => void
let api: ReturnType<typeof assistantAPI>
function assistantAPI() {
  return {
    conversation: vi.fn(async (_paper: string, _identity: string): Promise<AssistantConversation | null> => null),
    historyAnchors: vi.fn(async (_paper: string): Promise<AssistantHistoryAnchor[]> => []),
    saveConversation: vi.fn(async (_paper: string, _conversation: AssistantConversation) => {}),
    run: vi.fn(async (_request: unknown) => {}), stop: vi.fn(async () => {}),
    onEvent: vi.fn((callback: typeof listener) => { listener = callback; return () => {} })
  }
}
function geometry(view: Window) {
  const prototype = (view as unknown as { Range: typeof Range }).Range.prototype
  Object.defineProperties(prototype, {
    getClientRects: { configurable: true, value: () => [rect] },
    getBoundingClientRect: { configurable: true, value: () => rect }
  })
}
beforeEach(() => {
  const contentDocument = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')!.get!
  vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function (this: HTMLIFrameElement) {
    const document = contentDocument.call(this) as Document | null
    if (document && !document.scrollingElement) Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
    return document
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  highlights = new Map()
  vi.stubGlobal('CSS', { highlights })
  vi.stubGlobal('Highlight', TestHighlight)
  geometry(window)
  Element.prototype.scrollIntoView = vi.fn()
  api = assistantAPI()
  Object.defineProperty(window, 'freddie', { configurable: true, value: {
    assistant: api, library: { readHTML: vi.fn(async () => ''), saveHiddenRegions: vi.fn(async () => {}) }, shell: { paperBaseURL: () => 'freddie://paper/test/' }
  } })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
function mouse(target: Element, type: string, x = 20, y = 30) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1 }))
}
function clickHistory(target: Element) { mouse(target, 'pointerdown'); mouse(target, 'mouseup'); mouse(target, 'click') }

async function renderHtml(html: string, overrides: Partial<ComponentProps<typeof HtmlView>> = {}) {
  const props: ComponentProps<typeof HtmlView> = {
    paperId: 'paper', attachmentId: 'html', reloadToken: 0, displayMode: 'bilingual', appearance: 'default',
    fontSize: 17, initialScrollRatio: 0, onScrollRatio: vi.fn(), sidenotes: [], renderSidenotes: () => null,
    regionEditing: false, onLinkActivated: vi.fn(), ...overrides
  }
  await act(async () => root.render(createElement(HtmlView, props)))
  const frame = container.querySelector('iframe')!, doc = frame.contentDocument!, view = frame.contentWindow!
  doc.body.innerHTML = html
  Object.defineProperty(view, 'CSS', { configurable: true, value: { highlights } })
  Object.defineProperty(view, 'Highlight', { configurable: true, value: TestHighlight })
  geometry(view)
  // jsdom has already emitted the initial load; refresh the marks after installing the fixture.
  await act(async () => root.render(createElement(HtmlView, { ...props, assistantHistory: [...(props.assistantHistory ?? [])] })))
  return { props, doc }
}

describe('history ranges and gestures', () => {
  it('finds complete selections across inline nodes and paragraphs without changing stable paths', () => {
    container.innerHTML = '<p>Before <em>selected</em> text.</p><div class="rp-translation-block">译文</div><p>Next paragraph.</p>'
    const second = container.lastElementChild!
    const path = elementPath(second)
    const html = container.innerHTML
    const range = historyQuoteRange(container, 'selected text. Next paragraph.')!
    expect(range.startContainer.textContent).toBe('selected')
    expect(range.endContainer.textContent).toBe('Next paragraph.')
    expect(historyQuoteRange(container, '译文')).toBeNull()
    expect(elementPath(second)).toBe(path)
    expect(container.innerHTML).toBe(html)
  })

  it('tolerates PDF span spacing, line breaks, ligatures and soft hyphens', () => {
    container.innerHTML = '<span>Efﬁcient</span><br><span> context\u00ad</span><span>learning.</span>'
    const range = historyQuoteRange(container, 'Efficient context learning.', true)!
    expect(range).not.toBeNull()
    expect(range.startOffset).toBe(0)
    expect(range.endOffset).toBe('learning.'.length)
    expect(historyQuoteRange(container, 'An unrelated sentence.', true)).toBeNull()
    container.innerHTML = '<span>another</span><span> an other </span>'
    expect(historyQuoteRange(container, 'an other', true)?.startContainer.parentElement).toBe(container.lastElementChild)
  })

  it('maps supplementary Unicode and NFKC expansions back to UTF-16 PDF offsets', () => {
    container.innerHTML = '<span>Let 𝑥 be</span><br><span>the input.</span>'
    const range = historyQuoteRange(container, 'Let 𝑥 be the input.', true)!
    expect(range?.toString()).toBe('Let 𝑥 bethe input.')
    expect(range.endOffset).toBe('the input.'.length)
    const symbol = historyQuoteRange(container, 'x', true)!
    expect(symbol?.toString()).toBe('𝑥')
    expect(symbol.startOffset).toBe(4)
    expect(symbol.endOffset).toBe(6)
    container.innerHTML = '<span>😀 𝑥</span><br><span>ﬁnish 😀!</span>'
    expect(historyQuoteRange(container, '😀 x finish 😀!', true)?.toString()).toBe('😀 𝑥ﬁnish 😀!')
    expect(historyQuoteRange(container, '😀!', true)?.toString()).toBe('😀!')
  })

  it('matches decomposed accents across PDF line breaks with the original DOM offsets', () => {
    container.innerHTML = '<span>cafe\u0301 au</span><br><span>lait</span>'
    const range = historyQuoteRange(container, 'cafe\u0301 au lait', true)!
    expect(range?.toString()).toBe('cafe\u0301 aulait')
    expect(range.startContainer).toBe(container.firstElementChild!.firstChild)
    expect(range.startOffset).toBe(0)
    expect(range.endContainer).toBe(container.lastElementChild!.firstChild)
    expect(range.endOffset).toBe(4)
  })

  it('matches nearby source and translated paragraphs without mixing their text', () => {
    container.innerHTML = '<p>First source.</p><div class="rp-translation-block">第一段。</div><p>Next source.</p><div class="rp-translation-block">第二段。</div>'
    const target = container.firstElementChild!, translation = target.nextElementSibling!
    expect(htmlHistoryRange(target, 'source. Next', translation).toString()).toContain('Next')
    const translated = htmlHistoryRange(target, '第一段。 第二段。', translation)
    expect(translated.startContainer.parentElement).toBe(translation)
    expect(translated.endContainer.parentElement).toBe(container.lastElementChild)
    expect(historyQuoteRange(target, '第一段。')).toBeNull()
  })

  it('limits failed HTML lookups to nearby blocks and falls back to the anchor paragraph', () => {
    container.innerHTML = '<p>Saved paragraph.</p>' + '<p>Unrelated.</p>'.repeat(100)
    const walker = vi.spyOn(document, 'createTreeWalker')
    const target = container.firstElementChild!
    expect(htmlHistoryRange(target, 'An old quote.', null).toString()).toBe('Saved paragraph.')
    const searched = new Set(walker.mock.calls.map(([root]) => root))
    expect(searched.size).toBe(9)
    expect(searched.has(document.body)).toBe(false)
    expect(searched.has(container)).toBe(false)
    expect(searched.has(container.children[9])).toBe(false)
  })

  it('uses a visible translated paragraph for fallback in translated-only mode', () => {
    container.innerHTML = '<p>Updated source.</p><div class="rp-translation-block">更新后的译文。</div>'
    const target = container.firstElementChild!, translation = container.lastElementChild!
    document.documentElement.setAttribute('data-rp-display-mode', 'translated')
    try {
      expect(htmlHistoryRange(target, 'Old quote.', translation).toString()).toBe('更新后的译文。')
      translation.setAttribute('data-rp-hidden', 'true')
      expect(htmlHistoryRange(target, 'Old quote.', translation).toString()).toBe('Updated source.')
    } finally {
      document.documentElement.removeAttribute('data-rp-display-mode')
    }
  })

  it('opens the stored identity on click, leaves drags alone, and removes decorations on cleanup', () => {
    container.innerHTML = '<p>Saved passage.</p>'
    const saved = anchor('archive-specific-identity')
    const range = historyQuoteRange(container, saved.selection.quote)!
    const activate = vi.fn(), grace = { current: 0 }
    const cleanup = bindAssistantHistory(container, [{ anchor: saved, range }], { name: 'rp-test-history', selectionGraceUntil: grace, activate })
    expect(highlights.get('rp-test-history')?.size).toBe(1)
    clickHistory(container.firstElementChild!)
    expect(activate).toHaveBeenCalledExactlyOnceWith(saved, range)
    expect(grace.current).toBeGreaterThan(Date.now())
    mouse(container, 'pointerdown', 200)
    expect(grace.current).toBe(0)
    mouse(container, 'pointerdown'); mouse(container, 'pointermove', 60); mouse(container, 'click')
    expect(activate).toHaveBeenCalledTimes(1)
    expect(grace.current).toBe(0)
    cleanup()
    expect(highlights.has('rp-test-history')).toBe(false)
    expect(document.querySelector('style[data-rp-reader]')).toBeNull()
    clickHistory(container)
    expect(activate).toHaveBeenCalledTimes(1)
  })
})

describe('HTML history integration', () => {
  it('keeps source histories clickable on the translation when switching to translated-only mode', async () => {
    const saved = anchor(), activate = vi.fn()
    const { props, doc } = await renderHtml('<p data-rp-segment-id="s1" data-rp-source="true">Saved passage.</p><p class="rp-translation-block" data-rp-source-segment-id="s1">已保存的段落。</p>', {
      assistantHistory: [saved], onAssistantHistoryActivated: activate
    })
    expect([...highlights.get('rp-assistant-history')!][0].toString()).toBe('Saved passage.')
    await act(async () => root.render(createElement(HtmlView, { ...props, displayMode: 'translated' })))
    const translatedRange = [...highlights.get('rp-assistant-history')!][0]
    expect(translatedRange.toString()).toBe('已保存的段落。')
    expect(translatedRange.startContainer).toBe(doc.querySelector('.rp-translation-block'))
    await act(async () => { clickHistory(doc.querySelector('.rp-translation-block')!) })
    expect(activate.mock.lastCall?.[0]).toEqual(saved)
    expect(activate.mock.lastCall?.[1].quote).toBe('Saved passage.')
    await act(async () => root.render(createElement(HtmlView, { ...props, displayMode: 'original' })))
    expect([...highlights.get('rp-assistant-history')!][0].toString()).toBe('Saved passage.')
    await act(async () => root.render(createElement(HtmlView, props)))
    expect([...highlights.get('rp-assistant-history')!][0].toString()).toBe('Saved passage.')
  })

  it('filters by attachment, opens the saved selection, updates marks, and respects region editing', async () => {
    const activated = vi.fn(), selection = vi.fn()
    const saved = anchor('long-original-identity')
    const props = { paperId: 'paper', attachmentId: 'html', reloadToken: 0, displayMode: 'bilingual' as const,
      appearance: 'default' as const, fontSize: 17, initialScrollRatio: 0, onScrollRatio: vi.fn(), sidenotes: [],
      renderSidenotes: () => null, regionEditing: false, onLinkActivated: vi.fn(), onSelection: selection,
      onAssistantHistoryActivated: activated, assistantHistory: [saved, anchor('other', 'different-attachment')] }
    await act(async () => root.render(createElement(HtmlView, props)))
    const frame = container.querySelector('iframe')!, doc = frame.contentDocument!, view = frame.contentWindow!
    doc.body.innerHTML = '<p>Saved <em>passage.</em></p>'
    Object.defineProperty(doc, 'scrollingElement', { configurable: true, value: doc.documentElement })
    Object.defineProperty(view, 'CSS', { configurable: true, value: { highlights } })
    Object.defineProperty(view, 'Highlight', { configurable: true, value: TestHighlight })
    geometry(view)
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(highlights.get('rp-assistant-history')?.size).toBe(1)
    const originalPath = elementPath(doc.querySelector('p')!)
    await act(async () => { clickHistory(doc.querySelector('em')!) })
    expect(activated.mock.lastCall?.[0]).toEqual(saved)
    expect(activated.mock.lastCall?.[1].quote).toBe('Saved passage.')
    expect(elementPath(doc.querySelector('p')!)).toBe(originalPath)
    doc.dispatchEvent(new Event('selectionchange'))
    expect(selection).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(HtmlView, { ...props, regionEditing: true })))
    await act(async () => { clickHistory(doc.querySelector('em')!) })
    expect(activated).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(HtmlView, { ...props, assistantHistory: [] })))
    expect(highlights.get('rp-assistant-history')?.size).toBe(0)
  })

  it('anchors nested translated selections to their source and marks live replacement translations', async () => {
    const select = vi.fn(), activate = vi.fn()
    const { props, doc } = await renderHtml('<p data-rp-segment-id="s1">Source passage.</p><div class="rp-translation-block" data-rp-source-segment-id="s1"><p>已保存的<em>译文</em>。</p></div>', {
      onSelection: select, onAssistantHistoryActivated: activate
    })
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('em')!)
    doc.getSelection()!.addRange(range)
    await act(async () => { mouse(doc.querySelector('em')!, 'mouseup'); await new Promise((resolve) => setTimeout(resolve, 1)) })
    expect(select.mock.lastCall?.[0]).toMatchObject({ quote: '译文', htmlSelector: elementPath(doc.querySelector('p')!) })
    const saved = { selectionIdentity: 'translated-history', selection: select.mock.lastCall![0] } as AssistantHistoryAnchor
    await act(async () => root.render(createElement(HtmlView, { ...props, assistantHistory: [saved] })))
    expect([...highlights.get('rp-assistant-history')!][0].toString()).toBe('译文')
    doc.getSelection()!.removeAllRanges()
    await act(async () => { clickHistory(doc.querySelector('em')!) })
    expect(activate.mock.lastCall?.[0]).toEqual(saved)
    await act(async () => root.render(createElement(HtmlView, { ...props, assistantHistory: [saved], segmentUpdate: {
      segmentId: 's1', sequence: 1, translatedHTML: '<div class="rp-translation-block" data-rp-source-segment-id="s1">新的译文。</div>'
    } })))
    const updated = [...highlights.get('rp-assistant-history')!][0]
    expect(updated.toString()).toBe('译文')
    expect(updated.startContainer.parentElement).toBe(doc.querySelector('.rp-translation-block'))
  })

  it.each([2, 3])('reports a new HTML selection on click %i during history grace', async (detail) => {
    const select = vi.fn(), activate = vi.fn()
    const { doc } = await renderHtml('<p>Saved passage.</p>', { assistantHistory: [anchor()], onSelection: select, onAssistantHistoryActivated: activate })
    const target = doc.querySelector('p')!
    await act(async () => { clickHistory(target); await new Promise((resolve) => setTimeout(resolve, 1)) })
    expect(activate).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, detail, clientX: 20, clientY: 30 }))
      const range = doc.createRange()
      range.setStart(target.firstChild!, 0); range.setEnd(target.firstChild!, detail === 2 ? 5 : 14)
      doc.getSelection()!.addRange(range)
      mouse(target, 'mouseup')
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail, clientX: 20, clientY: 30 }))
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
    expect(select.mock.lastCall?.[0].quote).toBe(detail === 2 ? 'Saved' : 'Saved passage.')
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('marks legacy anchors and rebuilds after hiding, undoing and restoring regions', async () => {
    const saved = anchor()
    delete saved.selection.attachmentId
    const { props, doc } = await renderHtml('<p>Saved passage.</p>', { assistantHistory: [saved], regionEditing: true })
    expect(highlights.get('rp-assistant-history')?.size).toBe(1)
    await act(async () => { clickHistory(doc.querySelector('p')!) })
    expect(highlights.get('rp-assistant-history')?.size).toBe(0)
    await act(async () => root.render(createElement(HtmlView, { ...props, regionCommand: { action: 'undo', token: 1 } })))
    expect(highlights.get('rp-assistant-history')?.size).toBe(1)
    await act(async () => root.render(createElement(HtmlView, { ...props, regionCommand: { action: 'redo', token: 2 } })))
    expect(highlights.get('rp-assistant-history')?.size).toBe(0)
    await act(async () => root.render(createElement(HtmlView, { ...props, regionCommand: { action: 'restoreAll', token: 3 } })))
    expect(highlights.get('rp-assistant-history')?.size).toBe(1)
  })
})

describe('history loading', () => {
  it('ignores a late response from another paper and refreshes after a save', async () => {
    const first = deferred<AssistantHistoryAnchor[]>()
    api.historyAnchors.mockImplementation((paper) => paper === 'first' ? first.promise : Promise.resolve([anchor(paper)]))
    let history!: ReturnType<typeof useAssistantHistory>
    function Harness({ paper }: { paper: string }) { history = useAssistantHistory(paper); return null }
    await act(async () => root.render(createElement(Harness, { paper: 'first' })))
    await act(async () => root.render(createElement(Harness, { paper: 'second' })))
    expect(history.anchors[0].selectionIdentity).toBe('second')
    await act(async () => first.resolve([anchor('first')]))
    expect(history.anchors[0].selectionIdentity).toBe('second')
    api.historyAnchors.mockResolvedValue([anchor('newly-saved')])
    await act(async () => history.refresh())
    expect(history.anchors[0].selectionIdentity).toBe('newly-saved')
  })
})

const overlayProps = () => ({ paperId: 'paper', selection: anchor().selection, onInteraction: vi.fn(), onDismiss: vi.fn(), onSaveNote: vi.fn(), onSourceActivated: vi.fn() })
describe('restoring and saving conversations', () => {
  it('restores the archive identity without calling AI, including after closing and reopening', async () => {
    api.conversation.mockResolvedValue(snapshot('stored-id'))
    const props = { ...overlayProps(), conversationIdentity: 'stored-id' }
    await act(async () => root.render(createElement(SelectionAssistant, { ...props, key: 'first-open' })))
    expect(api.conversation).toHaveBeenCalledWith('paper', 'stored-id')
    expect(container.textContent).toContain('Previously generated explanation.')
    expect(api.run).not.toHaveBeenCalled()
    await act(async () => { container.querySelector('.assistant-header [aria-label="Close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('.assistant-card')).toBeNull()
    await act(async () => root.render(createElement(SelectionAssistant, { ...props, key: 'second-open' })))
    expect(container.textContent).toContain('Previously generated explanation.')
    expect(api.run).not.toHaveBeenCalled()
  })

  it('refreshes marks only after a successful save and persists once under StrictMode', async () => {
    const saved = deferred<void>(), refreshed = vi.fn()
    api.saveConversation.mockReturnValue(saved.promise)
    await act(async () => root.render(createElement(StrictMode, null, createElement(SelectionAssistant, { ...overlayProps(), onConversationSaved: refreshed }))))
    await act(async () => { container.querySelector('[title="Explain Selected Text"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const request = api.run.mock.calls[0][0] as { requestId: string }
    await act(async () => listener({ requestId: request.requestId, type: 'done', text: 'A new explanation.' }))
    expect(api.saveConversation).toHaveBeenCalledTimes(1)
    expect(refreshed).not.toHaveBeenCalled()
    await act(async () => saved.resolve())
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(api.saveConversation.mock.calls[0][1].selection.rect).toBeUndefined()
  })

  it('does not replace a new generation with a late historical load', async () => {
    const loaded = deferred<AssistantConversation | null>()
    api.conversation.mockReturnValue(loaded.promise)
    await act(async () => root.render(createElement(SelectionAssistant, overlayProps())))
    await act(async () => { container.querySelector('[title="Explain Selected Text"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => loaded.resolve(snapshot()))
    expect(container.textContent).not.toContain('Previously generated explanation.')
    const request = api.run.mock.calls[0][0] as { requestId: string }
    await act(async () => listener({ requestId: request.requestId, type: 'done', text: 'Current explanation.' }))
    expect(container.textContent).toContain('Current explanation.')
  })
})
