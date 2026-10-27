// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentOutlinePanel } from '../src/readers/DocumentOutlinePanel'
import { HtmlView } from '../src/readers/HtmlView'
import { useDocumentOutline } from '../src/readers/useDocumentOutline'
import type { DocumentOutlineCache } from '../shared/outline'

vi.mock('../src/app/context', () => ({ useApp: () => ({ t: (key: string) => key }) }))
const box = vi.hoisted(() => ({ messageBox: vi.fn(async () => 0) }))
vi.mock('../src/app/native', () => ({ messageBox: box.messageBox, errorText: (error: unknown) => String(error) }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })
const key = async (target: Element, value: string): Promise<void> => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })) }) }
const click = async (target: Element): Promise<void> => { await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const type = async (target: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })) })
}
const cache: DocumentOutlineCache = { algorithmVersion: 2, fingerprint: 'f', selectedSource: 'automatic', variants: [], candidates: [] }

describe('outline panel interactions', () => {
  it('supports keyboard navigation, translated-title filtering, pinning and Escape', async () => {
    const navigate = vi.fn(), close = vi.fn(), pin = vi.fn()
    const entries = ['Introduction', 'Methods', 'Experiments'].map((title, index) => ({ id: String(index), title, level: 1, anchor: `rp-path:${index}`, translation: index === 2 ? '实验' : undefined }))
    const props = { entries, currentID: '0', isHTML: true, pinned: false, translatedOnly: false, onPin: pin, onClose: close, onNavigate: navigate, onSelect: vi.fn(), onOrganize: vi.fn(), onCancel: vi.fn() }
    await act(async () => root.render(createElement(DocumentOutlinePanel, props)))
    const input = container.querySelector('input')!
    expect(document.activeElement).toBe(input)
    await key(input, 'ArrowDown'); await key(input, 'Enter')
    expect(navigate.mock.lastCall?.[0].id).toBe('1')
    expect(close).toHaveBeenCalledOnce()
    await click(container.querySelector('[aria-label="Pin Contents"]')!)
    expect(pin).toHaveBeenCalledOnce()
    await act(async () => root.render(createElement(DocumentOutlinePanel, { ...props, pinned: true })))
    await type(input, '实验')
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    await key(input, 'Enter')
    expect(navigate.mock.lastCall?.[0].id).toBe('2')
    expect(close).toHaveBeenCalledOnce()
    await key(input, 'Escape')
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('preserves manual expansion and keyboard selection while translations stream', async () => {
    const entries = [{ id: '1', title: 'Methods', level: 1, anchor: 'rp-path:1' }, { id: '2', title: 'Setup', level: 2, anchor: 'rp-path:2' },
      { id: '3', title: 'Details', level: 3, anchor: 'rp-path:3' }, { id: '4', title: 'Results', level: 1, anchor: 'rp-path:4' }]
    const props = { entries, currentID: '1', isHTML: true, pinned: true, translatedOnly: false, onPin: vi.fn(), onClose: vi.fn(), onNavigate: vi.fn(), onSelect: vi.fn(), onOrganize: vi.fn(), onCancel: vi.fn() }
    await act(async () => root.render(createElement(DocumentOutlinePanel, props)))
    await click(container.querySelector('[data-outline-id="2"] .outline-disclosure')!)
    await key(container.querySelector('input')!, 'ArrowDown')
    await act(async () => root.render(createElement(DocumentOutlinePanel, { ...props, entries: entries.map((entry) => ({ ...entry, translation: '译文' })) })))
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(4)
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('data-outline-id')).toBe('2')
    await click(container.querySelector('[data-outline-id="1"] .outline-disclosure')!)
    await act(async () => root.render(createElement(DocumentOutlinePanel, { ...props, entries: entries.map((entry) => ({ ...entry, translation: '更新译文' })) })))
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    await act(async () => root.render(createElement(DocumentOutlinePanel, { ...props, currentID: '3' })))
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(4)
  })

  it('explains why a translated-only attachment cannot supply the original outline', async () => {
    await act(async () => root.render(createElement(DocumentOutlinePanel, {
      entries: [], isHTML: false, pinned: false, translatedOnly: true, unavailableReason: 'The original PDF is required to read its contents.',
      onPin: vi.fn(), onClose: vi.fn(), onNavigate: vi.fn(), onSelect: vi.fn(), onOrganize: vi.fn(), onCancel: vi.fn()
    })))
    expect(container.querySelector('.outline-empty')?.textContent).toBe('The original PDF is required to read its contents.')
  })

  it('reveals current ancestors, marks untranslated destinations, and requires the explicit AI send action', async () => {
    const organize = vi.fn()
    const entries = [{ id: '1', title: 'Methods', level: 1, pageIndex: 1 }, { id: '2', title: 'Setup', level: 2, pageIndex: 1 }, { id: '3', title: 'Details', level: 3, pageIndex: 3 }]
    const props = { entries, currentID: '3', isHTML: false, pinned: true, translatedOnly: true, translatedLastPage: 3, cache: { ...cache, candidates: entries }, onPin: vi.fn(), onClose: vi.fn(), onNavigate: vi.fn(), onSelect: vi.fn(), onOrganize: organize, onCancel: vi.fn() }
    await act(async () => root.render(createElement(DocumentOutlinePanel, props)))
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
    expect(container.querySelector('[aria-current="location"]')?.textContent).toContain('Not translated')
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Details')
    expect(organize).not.toHaveBeenCalled()
    const select = container.querySelector('select')!
    await act(async () => { select.value = 'organize'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(box.messageBox).toHaveBeenCalledOnce()
    expect(organize).toHaveBeenCalledOnce()
  })
})

describe('outline request lifecycle', () => {
  it('extracts only when shown, drops old-paper results and cancels pending work on unmount', async () => {
    let resolve!: (value: DocumentOutlineCache) => void
    const load = vi.fn(() => new Promise<DocumentOutlineCache>((done) => { resolve = done }))
    const cancel = vi.fn(async () => {})
    Object.defineProperty(window, 'freddie', { configurable: true, value: { outline: { load, cancel } } })
    let model!: ReturnType<typeof useDocumentOutline>
    function Harness({ paper }: { paper: string }) { model = useDocumentOutline(paper, `${paper}-pdf`, '', false); return null }
    await act(async () => root.render(createElement(Harness, { paper: 'first' })))
    expect(load).not.toHaveBeenCalled()
    await act(async () => model.setPresented(true))
    expect(load).toHaveBeenCalledOnce()
    const resolveFirst = resolve
    await act(async () => root.render(createElement(Harness, { paper: 'second' })))
    await act(async () => resolveFirst(cache))
    expect(model.cache).toBeUndefined()
    expect(model.presented).toBe(false)
    expect(cancel).toHaveBeenCalled()
    await act(async () => root.render(createElement(Harness, { paper: 'first' })))
    expect(model.presented).toBe(false)
    await act(async () => model.setPresented(true))
    expect(model.busy).toBe('load')
    await act(async () => root.unmount())
    expect(cancel).toHaveBeenCalledTimes(load.mock.calls.length)
    root = createRoot(container)
  })
})

describe('HTML reader layout changes', () => {
  it('keeps the selected display mode when pinning Contents resizes an already loaded frame', async () => {
    Object.defineProperty(window, 'freddie', { configurable: true, value: {
      library: { readHTML: vi.fn(async () => '<html><head></head><body><h2>Methods</h2></body></html>') },
      shell: { paperBaseURL: () => 'freddie://paper/test/' }
    } })
    const contentDocument = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')!.get!
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function (this: HTMLIFrameElement) {
      const document = contentDocument.call(this) as Document | null
      if (document && !document.scrollingElement) Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
      return document
    })
    const props = { paperId: 'paper', attachmentId: 'html', reloadToken: 0, displayMode: 'bilingual' as const,
      appearance: 'default' as const, fontSize: 17, initialScrollRatio: 0, onScrollRatio: vi.fn(), sidenotes: [],
      renderSidenotes: () => null, regionEditing: false, onLinkActivated: vi.fn() }
    await act(async () => root.render(createElement(HtmlView, props)))
    const frame = container.querySelector('iframe')!
    const document = frame.contentDocument!
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(document.documentElement.dataset.rpDisplayMode).toBe('bilingual')
    await act(async () => root.render(createElement(HtmlView, { ...props, displayMode: 'translated' })))
    expect(document.documentElement.dataset.rpDisplayMode).toBe('translated')
    await act(async () => { frame.contentWindow!.dispatchEvent(new Event('resize')) })
    expect(document.documentElement.dataset.rpDisplayMode).toBe('translated')
  })
})
