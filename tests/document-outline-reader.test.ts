// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderPane, type ReaderPaneProps } from '../src/main-window/ReaderPane'
import { defaultSettings } from '../electron/main/store'
import { createTranslator } from '../shared/i18n'
import type { LibrarySnapshot } from '../shared/types'

const app = vi.hoisted(() => ({ snapshot: {} as LibrarySnapshot }))
vi.mock('../src/app/context', () => ({ useApp: () => ({ snapshot: app.snapshot, t: createTranslator('en'), language: 'en' }) }))
vi.mock('../src/readers/PdfView', async () => ({ PdfView: (await import('react')).forwardRef(() => null) }))
vi.mock('../src/readers/DualPdfView', async () => ({ DualPdfView: (await import('react')).forwardRef(() => null) }))
vi.mock('../src/readers/HtmlView', async () => ({ HtmlView: (await import('react')).forwardRef(() => null) }))

let root: Root, container: HTMLDivElement
const observers: Array<{ element?: Element; notify(): void }> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    registration = { element: undefined as Element | undefined, notify: () => this.callback([], this as unknown as ResizeObserver) }
    constructor(private callback: ResizeObserverCallback) { observers.push(this.registration) }
    observe(element: Element) { this.registration.element = element }
    disconnect() {}
  })
  Element.prototype.scrollIntoView = vi.fn()
  const settings = { ...defaultSettings(), translationSetupNoticeHandled: true }
  app.snapshot = { settings, readingStates: [], models: [], providers: [] } as unknown as LibrarySnapshot
  Object.defineProperty(window, 'freddie', { configurable: true, value: {
    library: { pageCount: vi.fn(async () => ({ pageCount: 4, hasText: true })), saveReadingState: vi.fn(async () => {}) },
    translation: { onEvent: () => () => {} },
    sync: { onApplied: () => () => {}, setReaderActivity: vi.fn(), setNoteEditing: vi.fn() },
    assistant: { historyAnchors: vi.fn(async () => []) },
    outline: { load: vi.fn(async () => ({ algorithmVersion: 2, fingerprint: 'f', variants: [], candidates: [] })), cancel: vi.fn(async () => {}) },
    shell: { assetURL: () => 'freddie://paper/test/a/pdf' }
  } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); observers.splice(0); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function props(): ReaderPaneProps {
  const timestamp = '2026-10-27T00:00:00Z'
  return {
    paper: { id: 'paper', title: 'Test', authors: [], abstract: '', categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp },
    attachments: [{ id: 'pdf', paperId: 'paper', kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: timestamp }],
    notes: [], inspectorCollapsed: false, onToggleInspector: vi.fn(), selection: { quote: 'Selected text', pageIndex: 0 }, onSelection: vi.fn(),
    onCreateNote: vi.fn(), onSaveAssistantNote: vi.fn(async () => ''), onQuoteInWriting: vi.fn(), navigation: null, onNavigationHandled: vi.fn(),
    sidenoteFocusId: null, onSidenoteFocusHandled: vi.fn(), onAddPaper: vi.fn(), onArxivLink: vi.fn(), findToken: 0, toast: null, showToast: vi.fn(), libraryEmpty: false
  }
}
const click = async (selector: string): Promise<void> => { await act(async () => (container.querySelector(selector)! as HTMLButtonElement).click()) }

describe('reader outline integration', () => {
  it('uses the narrower document width for note placement after pinning Contents', async () => {
    const input = props()
    await act(async () => root.render(createElement(ReaderPane, input)))
    await click('[aria-label="Contents"]')
    await click('[aria-label="Pin Contents"]')
    Object.defineProperty(container.querySelector('.reader-content'), 'clientWidth', { configurable: true, value: 1000 })
    Object.defineProperty(container.querySelector('.reader-document'), 'clientWidth', { configurable: true, value: 684 })
    await act(async () => observers.forEach((observer) => observer.notify()))
    await click('[aria-label="Add Note to Current Selection"]')
    expect(input.onCreateNote).toHaveBeenLastCalledWith(false)
    Object.defineProperty(container.querySelector('.reader-document'), 'clientWidth', { configurable: true, value: 800 })
    await act(async () => observers.forEach((observer) => observer.notify()))
    await click('[aria-label="Add Note to Current Selection"]')
    expect(input.onCreateNote).toHaveBeenLastCalledWith(true)
  })

  it('shows the missing-original explanation without attempting extraction for a translated-only paper', async () => {
    const input = props()
    input.attachments = input.attachments.map((attachment) => ({ ...attachment, kind: 'translatedPDF' }))
    await act(async () => root.render(createElement(ReaderPane, input)))
    await click('[aria-label="Contents"]')
    expect(container.querySelector('.outline-empty')?.textContent).toBe('The original PDF is required to read its contents.')
    expect(window.freddie.outline.load).not.toHaveBeenCalled()
  })
})
