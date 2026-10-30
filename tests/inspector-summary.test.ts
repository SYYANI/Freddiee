// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot, Paper, PaperAbstractContent } from '../shared/types'
import { resolveItemTypes } from '../shared/library'
import { Inspector } from '../src/main-window/Inspector'

let snapshot: LibrarySnapshot
vi.mock('../src/app/context', () => ({ useApp: () => ({ snapshot, t: (key: string) => key, language: 'en' }) }))
vi.mock('../src/writing/WritingPane', () => ({ WritingPane: () => null }))
vi.mock('../src/ui/NoteMarkdown', () => ({ NoteMarkdown: () => null }))

let root: Root
let container: HTMLDivElement
let abstractContent: ReturnType<typeof vi.fn<(paperId: string, operationId: string) => Promise<PaperAbstractContent>>>
let cancelAbstractContent: ReturnType<typeof vi.fn<(operationId: string) => Promise<void>>>
const paper = (id: string): Paper => ({ id, title: id, abstract: 'Original long abstract.', authors: [], categories: [], tags: [], isFavorite: false, createdAt: '', modifiedAt: '' })
const papers = [paper('first'), paper('second')]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  snapshot = {
    attachments: papers.map((item) => ({ id: `pdf-${item.id}`, paperId: item.id, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: '' })),
    models: [], providers: [], writings: [], settings: { targetLanguage: 'zh-CN' }
  } as unknown as LibrarySnapshot
  abstractContent = vi.fn(async () => ({ kind: 'summary', text: 'A short summary.' }))
  cancelAbstractContent = vi.fn(async () => {})
  Object.defineProperty(window, 'freddie', { configurable: true, value: { translation: { abstractContent, cancelAbstractContent }, sync: { setReaderActivity: vi.fn(), setNoteEditing: vi.fn() } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(overrides: Partial<ComponentProps<typeof Inspector>> = {}) {
  const props: ComponentProps<typeof Inspector> = {
    collapsed: false, paper: papers[0], itemTypes: resolveItemTypes(papers, snapshot.attachments, []), notes: [], mode: 'paper',
    selection: null, focusedNoteId: null, onMode: vi.fn(), onFocusHandled: vi.fn(), onCreateNote: vi.fn(), onOpenNoteAnchor: vi.fn(),
    onOpenWriting: vi.fn(), onCreateWritingAbout: vi.fn(), onOpenCitation: vi.fn(), ...overrides
  }
  await act(async () => root.render(createElement(Inspector, props)))
}

describe('inspector summary visibility and lifecycle', () => {
  it('does not request summaries while collapsed, including when selecting different PDFs', async () => {
    await render({ collapsed: true })
    await render({ collapsed: true, paper: papers[1] })
    expect(abstractContent).not.toHaveBeenCalled()
    await render({ paper: papers[1] })
    expect(abstractContent).toHaveBeenCalledOnce()
    expect(abstractContent.mock.calls[0][0]).toBe('second')
    expect(container.querySelector('.abstract-text')?.textContent).toBe('A short summary.')
  })

  it('cancels when collapsing or changing tabs and resumes only when visible', async () => {
    await render()
    const firstId = abstractContent.mock.calls[0][1]
    await render({ collapsed: true })
    expect(cancelAbstractContent).toHaveBeenCalledWith(firstId)
    expect(abstractContent).toHaveBeenCalledOnce()
    await render({ mode: 'writing' })
    expect(abstractContent).toHaveBeenCalledOnce()
    await render()
    const secondId = abstractContent.mock.calls[1][1]
    expect(secondId).not.toBe(firstId)
    await render({ mode: 'writing' })
    expect(cancelAbstractContent).toHaveBeenCalledWith(secondId)
  })

  it('cancels old settings requests and ignores their late responses', async () => {
    let finishOld!: (content: PaperAbstractContent) => void
    abstractContent.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    await render()
    const firstId = abstractContent.mock.calls[0][1]
    snapshot.settings.targetLanguage = 'EN'
    abstractContent.mockResolvedValue({ kind: 'summary', text: 'English summary.' })
    await render()
    expect(cancelAbstractContent).toHaveBeenCalledWith(firstId)
    expect(abstractContent).toHaveBeenCalledTimes(2)
    await act(async () => finishOld({ kind: 'summary', text: 'Stale Chinese summary.' }))
    expect(container.querySelector('.abstract-text')?.textContent).toBe('English summary.')
    await render({ paper: papers[1] })
    expect(cancelAbstractContent).toHaveBeenCalledWith(abstractContent.mock.calls[1][1])
    expect(abstractContent.mock.calls[2][0]).toBe('second')
  })
})
