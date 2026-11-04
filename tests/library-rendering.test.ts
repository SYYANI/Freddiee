// @vitest-environment jsdom
import { act, createElement, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../src/app/context'
import { LibrarySidebar, type SidebarActions } from '../src/main-window/LibrarySidebar'
import { emptyFilter, groupLibrary, resolveItemTypes } from '../shared/library'
import { defaultSettings } from '../electron/main/store'
import { LibrarySnapshotCache } from '../electron/main/librarySnapshot'
import type { LibrarySnapshot, Paper } from '../shared/types'

const rowRender = vi.hoisted(() => vi.fn())
vi.mock('../shared/library', async (original) => {
  const actual = await original<typeof import('../shared/library')>()
  return { ...actual, sidebarIdentifierText: (...args: Parameters<typeof actual.sidebarIdentifierText>) => {
    rowRender(args[0].id)
    return actual.sidebarIdentifierText(...args)
  } }
})

const noop = () => {}
const actions: SidebarActions = { onSelect: noop, onDeletePaper: noop, onNewFolder: noop, onRenameFolder: noop, onDeleteFolder: noop }
function SidebarHost() {
  const { snapshot } = useApp()
  const grouping = useMemo(() => groupLibrary(snapshot.papers, snapshot.folders, snapshot.memberships), [snapshot.papers, snapshot.folders, snapshot.memberships])
  const itemTypes = useMemo(() => resolveItemTypes(snapshot.papers, snapshot.attachments, snapshot.itemTypeAssignments), [snapshot.papers, snapshot.attachments, snapshot.itemTypeAssignments])
  return createElement(LibrarySidebar, { papers: snapshot.papers, folders: snapshot.folders, collapsedFolderIds: snapshot.settings.collapsedFolderIds, grouping, itemTypes, filter: emptyFilter, onFilterChange: noop, visibleCount: snapshot.papers.length, selectedPaper: snapshot.papers[0], actions })
}
let state: LibrarySnapshot, version: number, changed: () => void, root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  state = {
    papers: ['a', 'b', 'c'].map((id): Paper => ({ id, title: id, authors: [], abstract: '', categories: [], tags: [], isFavorite: false, createdAt: '', modifiedAt: '' })),
    notes: [], attachments: [], folders: [], memberships: [], itemTypeAssignments: [], readingStates: [], providers: [], models: [], writings: [], htmlTranslatedPaperIds: [],
    settings: { ...defaultSettings(), appLanguage: 'en' }, platform: 'darwin', systemDarkMode: false
  }
  version = 0
  const cache = new LibrarySnapshotCache(async () => structuredClone(state), () => String(version))
  Object.defineProperty(window, 'freddie', { configurable: true, value: { platform: 'darwin', backdrop: 'none', library: {
    snapshot: async (since?: number) => structuredClone(await cache.read(since)),
    onChanged: (listener: () => void) => { changed = listener; return noop }
  } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  rowRender.mockClear()
  await act(async () => root.render(createElement(AppProvider, { children: createElement(SidebarHost) })))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function refresh() {
  version++
  await act(async () => { changed(); await vi.advanceTimersByTimeAsync(40) })
}

describe('library row rendering', () => {
  it('skips every row on unrelated settings and note edits, and renders only an edited paper', async () => {
    expect(rowRender).toHaveBeenCalledTimes(3)
    rowRender.mockClear()
    state.settings.inspectorCollapsed = !state.settings.inspectorCollapsed
    await refresh()
    expect(rowRender).not.toHaveBeenCalled()
    state.notes.push({ id: 'note', paperId: 'a', body: 'Edited note', quote: '', createdAt: '', modifiedAt: '' })
    await refresh()
    expect(rowRender).not.toHaveBeenCalled()
    state.papers[1].title = 'Updated paper'
    await refresh()
    expect(rowRender.mock.calls).toEqual([['b']])
    expect(container.textContent).toContain('Updated paper')
  })

  it('still updates every row when the language changes', async () => {
    rowRender.mockClear()
    state.settings.appLanguage = 'zh-Hans'
    await refresh()
    expect(rowRender.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(container.querySelectorAll('.paper-row')).toHaveLength(3)
  })
})
