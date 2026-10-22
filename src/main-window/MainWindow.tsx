import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ImportProgress, InspectorMode, Note, NoteNavigationRequest, NoteSelectionContext, Paper } from '../../shared/types'
import { emptyFilter, filterGrouping, groupLibrary, isFilterActive, matchesFilter, orderedPaperIds, resolveItemTypes, type LibraryFilter } from '../../shared/library'
import { citationFromSelection, citationLabel, escapeInlineMarkdown, inlineCitationMarkdown, parseCitation, quoteCitationMarkdown } from '../../shared/writing'
import { normalizeArxivIdentifier, arxivQueryId } from '../../shared/identifiers'
import { useApp } from '../app/context'
import { alertError, confirmDestructive, errorText, messageBox } from '../app/native'
import { Button, PromptSheet, Sheet } from '../ui/controls'
import { LibrarySidebar } from './LibrarySidebar'
import { ReaderPane } from './ReaderPane'
import { Inspector } from './Inspector'
import { AddPaperSheet, ImportProgressView } from './AddPaperSheet'
import { dispatchWritingCommand, insertCitationText } from '../writing/writingBus'

function storedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(key) ?? '')
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  } catch {
    return fallback
  }
}

function storeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // Widths are a convenience.
  }
}

type FolderPrompt = { kind: 'create'; paperId?: string } | { kind: 'rename'; folderId: string; name: string }

interface ArxivLinkImport {
  identifier: string
  operationId: string
  progress: ImportProgress | null
  importing: boolean
  error?: string
}

export function MainWindow(): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const [selectedId, setSelectedId] = useState<string | undefined>(() => settings.lastOpenedPaperId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => storedWidth('freddie.sidebarWidth', 260, 240, 340))
  const [inspectorWidth, setInspectorWidth] = useState(() => storedWidth('freddie.inspectorWidth', 340, 280, 640))
  const [adding, setAdding] = useState(false)
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt | null>(null)
  const [filter, setFilter] = useState<LibraryFilter>(emptyFilter)
  const [selection, setSelection] = useState<NoteSelectionContext | null>(null)
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null)
  const [sidenoteFocusId, setSidenoteFocusId] = useState<string | null>(null)
  const [navigation, setNavigation] = useState<NoteNavigationRequest | null>(null)
  const [findToken, setFindToken] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [arxivImport, setArxivImport] = useState<ArxivLinkImport | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const papers = snapshot.papers
  const itemTypes = useMemo(() => resolveItemTypes(papers, snapshot.attachments, snapshot.itemTypeAssignments), [papers, snapshot.attachments, snapshot.itemTypeAssignments])
  const grouping = useMemo(() => groupLibrary(papers, snapshot.folders, snapshot.memberships), [papers, snapshot.folders, snapshot.memberships])
  const selectedPaper: Paper | undefined = papers.find((paper) => paper.id === selectedId) ?? papers[0]

  const visibleGrouping = useMemo(() => {
    if (!isFilterActive(filter)) return grouping
    const translated = new Set([...snapshot.htmlTranslatedPaperIds, ...snapshot.attachments.filter((item) => item.kind === 'translatedPDF').map((item) => item.paperId)])
    const noted = new Set(snapshot.notes.map((note) => note.paperId))
    // The open paper stays listed even when it stops matching.
    return filterGrouping(grouping, (paper) => paper.id === selectedPaper?.id || matchesFilter(paper, filter, { translatedPaperIds: translated, notedPaperIds: noted, itemTypes }))
  }, [grouping, filter, snapshot.htmlTranslatedPaperIds, snapshot.attachments, snapshot.notes, itemTypes, selectedPaper?.id])
  const visibleIds = orderedPaperIds(visibleGrouping)

  const notes = useMemo(() => snapshot.notes.filter((note) => note.paperId === selectedPaper?.id), [snapshot.notes, selectedPaper?.id])
  const attachments = useMemo(() => snapshot.attachments.filter((item) => item.paperId === selectedPaper?.id), [snapshot.attachments, selectedPaper?.id])

  const showToast = useCallback((message: string) => {
    clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), 2000)
  }, [])

  // MARK: Selection

  const select = useCallback((paperId?: string) => {
    setSelectedId(paperId)
    setSelection(null)
    setFocusedNoteId(null)
    setSidenoteFocusId(null)
    void window.freddie.library.selectPaper(paperId)
  }, [])

  useEffect(() => {
    if (selectedId && !papers.some((paper) => paper.id === selectedId)) setSelectedId(papers[0]?.id)
  }, [papers.map((paper) => paper.id).join('|')])

  useEffect(() => {
    window.freddie.shell.setWindowTitle(selectedPaper ? `${selectedPaper.title} — Freddie` : 'Freddie')
  }, [selectedPaper?.title])

  // Arrow keys move through the library in display order.
  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.sidebar-list') || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
      event.preventDefault()
      const index = visibleIds.indexOf(selectedPaper?.id ?? '')
      const next = visibleIds[Math.min(visibleIds.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        select(next)
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-paper-row="${next}"]`)?.focus())
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [visibleIds, selectedPaper?.id, select])

  // MARK: Papers and folders

  const deletePaper = async (paper: Paper): Promise<void> => {
    let detail = t('“%@” and all of its local files, notes, reading state, and translation cache will be removed.', paper.title)
    const citing = snapshot.writings.filter((writing) => writing.citedPaperIds.includes(paper.id)).length
    if (citing > 0) detail += `\n\n${t('Writings citing this paper: %lld. Their text stays, but its citations will no longer open the paper.', citing)}`
    if (!(await confirmDestructive(t('Delete Paper?'), detail, t('Delete'), t('Cancel')))) return
    const remaining = visibleIds.filter((id) => id !== paper.id)
    const index = visibleIds.indexOf(paper.id)
    const next = remaining.length ? remaining[Math.min(Math.max(index, 0), remaining.length - 1)] : undefined
    try {
      await window.freddie.library.deletePaper(paper.id)
      select(next)
    } catch (error) {
      await alertError(t('Unable to Delete Paper'), errorText(error), t('OK'))
    }
  }

  const commitFolder = async (prompt: FolderPrompt, name: string): Promise<void> => {
    setFolderPrompt(null)
    try {
      if (prompt.kind === 'create') await window.freddie.folders.create(name, prompt.paperId)
      else await window.freddie.folders.rename(prompt.folderId, name)
    } catch (error) {
      await alertError(t('Unable to Update Folder'), errorText(error), t('OK'))
    }
  }

  const deleteFolder = async (folderId: string, name: string): Promise<void> => {
    if (await confirmDestructive(t('Delete Folder?'), t('Papers in “%@” will move to Unfiled. No papers are deleted.', name), t('Delete'), t('Cancel'))) {
      await window.freddie.folders.remove(folderId)
    }
  }

  // MARK: Inspector

  const setInspectorCollapsed = (collapsed: boolean): void => void window.freddie.settings.save({ inspectorCollapsed: collapsed })
  const setInspectorMode = (mode: InspectorMode): void => void window.freddie.settings.save({ inspectorMode: mode })

  const createNote = async (asSidenote: boolean): Promise<void> => {
    if (!selectedPaper) return
    const note = await window.freddie.notes.create(selectedPaper.id, selection ? { ...selection, rect: undefined, context: undefined } : undefined)
    if (asSidenote && (note.htmlSelector || note.pageIndex !== undefined)) {
      setSidenoteFocusId(note.id)
      return
    }
    if (settings.inspectorCollapsed) setInspectorCollapsed(false)
    if (settings.inspectorMode !== 'paper') setInspectorMode('paper')
    setFocusedNoteId(note.id)
  }

  const saveAssistantNote = async (noteSelection: NoteSelectionContext, markdown: string, existingNoteId?: string): Promise<string> => {
    if (!selectedPaper) throw new Error(t('No Paper Selected'))
    if (existingNoteId && snapshot.notes.some((note) => note.id === existingNoteId)) {
      await window.freddie.notes.update(existingNoteId, markdown)
      return existingNoteId
    }
    const note = await window.freddie.notes.create(selectedPaper.id, { ...noteSelection, rect: undefined, context: undefined }, markdown)
    return note.id
  }

  const openNoteAnchor = (note: Note): void => {
    setNavigation({ id: crypto.randomUUID(), paperId: note.paperId, attachmentId: note.attachmentId, pageIndex: note.pageIndex, htmlSelector: note.htmlSelector, quote: note.quote })
  }

  // MARK: Writing

  const showWritingPane = async (): Promise<void> => {
    if (await window.freddie.writings.isWindowOpen()) {
      await window.freddie.writings.openWindow()
      return
    }
    setInspectorMode('writing')
    if (settings.inspectorCollapsed) setInspectorCollapsed(false)
  }

  const createWritingAbout = async (paper: Paper): Promise<void> => {
    const year = paper.publishedAt ? new Date(paper.publishedAt).getFullYear() : undefined
    const label = citationLabel(paper.authors, paper.title, year, undefined)
    const heading = paper.title.split(/\s+/).filter(Boolean).join(' ')
    const markdown = `# ${escapeInlineMarkdown(heading)}\n\n${inlineCitationMarkdown(label, citationFromSelection(paper.id))}\n\n`
    try {
      await window.freddie.writings.create(markdown, true)
    } catch (error) {
      await alertError(t('Unable to Update Writing'), errorText(error), t('OK'))
    }
  }

  const quoteInWriting = async (quoteSelection: NoteSelectionContext, citeOnly: boolean): Promise<void> => {
    if (!selectedPaper || !quoteSelection.quote.trim()) return
    const year = selectedPaper.publishedAt ? new Date(selectedPaper.publishedAt).getFullYear() : undefined
    const label = citationLabel(selectedPaper.authors, selectedPaper.title, year, quoteSelection.pageIndex)
    const citation = citationFromSelection(selectedPaper.id, quoteSelection)
    const markdown = citeOnly ? inlineCitationMarkdown(label, citation) : quoteCitationMarkdown(quoteSelection.quote, label, citation)
    try {
      let writing = snapshot.writings.find((item) => item.id === settings.currentWritingId) ?? snapshot.writings[0]
      if (!writing) writing = await window.freddie.writings.create('', false)
      if (await window.freddie.writings.isWindowOpen()) {
        await window.freddie.writings.sendCommand({ type: 'insert-citation', markdown })
      } else if (!dispatchWritingCommand({ type: 'insert-citation', markdown })) {
        const current = await window.freddie.writings.load(writing.id)
        await window.freddie.writings.save(writing.id, insertCitationText(current, markdown, current.length).text)
      }
      const title = writing.title || t('Untitled Writing')
      showToast(citeOnly ? t('Cited in “%@”.', title) : t('Quoted in “%@”.', title))
    } catch (error) {
      await alertError(t('Unable to Quote in Writing'), errorText(error), t('OK'))
    }
  }

  const openCitation = (destination: string, title?: string, quote?: string): void => {
    const citation = parseCitation(destination, title)
    if (!citation) return
    if (!papers.some((paper) => paper.id === citation.paperId)) {
      void alertError(t('Unable to Open Citation'), t('The cited paper is no longer in your library.'), t('OK'))
      return
    }
    if (selectedPaper?.id !== citation.paperId) select(citation.paperId)
    setNavigation({ id: crypto.randomUUID(), paperId: citation.paperId, attachmentId: citation.attachmentId, pageIndex: citation.pageIndex, htmlSelector: citation.htmlSelector, quote: quote ?? citation.quotePrefix })
  }

  useEffect(() => window.freddie.shell.onOpenCitation((request) => {
    if (request.paperId && papers.some((paper) => paper.id === request.paperId)) {
      if (selectedPaper?.id !== request.paperId) select(request.paperId)
      setNavigation({ ...request, id: crypto.randomUUID() })
    }
  }), [papers, selectedPaper?.id])

  // Commands for the writing that arrive while no editor is mounted here.
  useEffect(() => window.freddie.writings.onCommand((command) => {
    if (command.type !== 'insert-citation' || dispatchWritingCommand(command)) return
    const writing = snapshot.writings.find((item) => item.id === settings.currentWritingId) ?? snapshot.writings[0]
    if (!writing) return
    void window.freddie.writings.load(writing.id).then((current) => window.freddie.writings.save(writing.id, insertCitationText(current, command.markdown, current.length).text))
  }), [snapshot.writings, settings.currentWritingId])

  // MARK: arXiv links in papers

  const handleLink = async (url: string): Promise<void> => {
    let identifier: string | undefined
    try {
      const parsed = new URL(url)
      if (parsed.hostname === 'arxiv.org' || parsed.hostname.endsWith('.arxiv.org')) identifier = arxivQueryId(normalizeArxivIdentifier(url))
    } catch {
      identifier = undefined
    }
    if (!identifier) {
      if (/^https?:/i.test(url)) void window.freddie.shell.openExternal(url)
      return
    }
    const response = await messageBox({
      type: 'question',
      message: t('Import arXiv Paper?'),
      detail: t('This PDF links to arXiv %@. Would you like to import it into your library?', identifier),
      buttons: [t('Import'), t('Open in Browser'), t('Cancel')],
      defaultId: 0,
      cancelId: 2
    })
    if (response === 1) void window.freddie.shell.openExternal(url)
    if (response !== 0) return
    const operationId = crypto.randomUUID()
    setArxivImport({ identifier, operationId, progress: null, importing: true })
    try {
      const paper = await window.freddie.library.importPaper({ type: 'arxiv', value: identifier, includeHTML: false, operationId })
      if (paper) select(paper.id)
      setArxivImport(null)
    } catch (error) {
      setArxivImport((current) => current && { ...current, importing: false, error: errorText(error) })
    }
  }

  useEffect(() => window.freddie.library.onImportProgress((progress) => {
    setArxivImport((current) => (current && current.operationId === progress.operationId ? { ...current, progress } : current))
  }), [])

  // MARK: Menu commands

  useEffect(() => window.freddie.shell.onMenuAction((action) => {
    if (action === 'add-paper') setAdding(true)
    if (action === 'new-folder' && papers.length) setFolderPrompt({ kind: 'create' })
    if (action === 'new-writing') void window.freddie.writings.create('', true)
    if (action === 'find') setFindToken((value) => value + 1)
    if (action === 'toggle-inspector') setInspectorCollapsed(!settings.inspectorCollapsed)
    if (action === 'toggle-sidebar') setSidebarOpen((value) => !value)
    if (action === 'quote-in-writing' && selection) void quoteInWriting(selection, false)
  }), [papers.length, settings.inspectorCollapsed, selection, selectedPaper?.id, snapshot.writings])

  // MARK: Dropping PDFs

  const dragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const drop = async (event: DragEvent): Promise<void> => {
    setDropActive(false)
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files).filter((file) => file.name.toLowerCase().endsWith('.pdf')).map((file) => window.freddie.shell.pathForFile(file)).filter(Boolean)
    if (!paths.length) return
    try {
      const paper = await window.freddie.library.importPaper({ type: 'pdf', paths, operationId: crypto.randomUUID() })
      if (paper) select(paper.id)
    } catch (error) {
      await alertError(t('Unable to Import Paper'), errorText(error), t('OK'))
    }
  }

  // MARK: Column resizing

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, column: 'sidebar' | 'inspector'): void => {
    event.preventDefault()
    const startX = event.clientX
    const initial = column === 'sidebar' ? sidebarWidth : inspectorWidth
    const move = (pointer: PointerEvent): void => {
      const delta = pointer.clientX - startX
      if (column === 'sidebar') {
        const next = Math.min(340, Math.max(240, initial + delta))
        setSidebarWidth(next)
        storeWidth('freddie.sidebarWidth', next)
      } else {
        const next = Math.min(640, Math.max(280, initial - delta, 0), window.innerWidth - (sidebarOpen ? sidebarWidth : 0) - 520)
        setInspectorWidth(Math.max(280, next))
        storeWidth('freddie.inspectorWidth', Math.max(280, next))
      }
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('resizing-columns')
    }
    document.body.classList.add('resizing-columns')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const inspectorOpen = !settings.inspectorCollapsed
  const style = {
    '--sidebar-width': `${sidebarOpen ? sidebarWidth : 0}px`,
    '--inspector-width': `${inspectorOpen ? inspectorWidth : 0}px`
  } as CSSProperties

  return (
    <div
      className={`main-window appearance-${settings.readerAppearance} ${sidebarOpen ? '' : 'sidebar-hidden'} ${inspectorOpen ? '' : 'inspector-hidden'}`}
      style={style}
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false)
      }}
      onDrop={(event) => void drop(event)}
    >
      {sidebarOpen && (
        <LibrarySidebar
          grouping={visibleGrouping}
          itemTypes={itemTypes}
          filter={filter}
          onFilterChange={setFilter}
          selectedPaper={selectedPaper}
          visibleCount={visibleIds.length}
          actions={{
            onSelect: select,
            onAddPaper: () => setAdding(true),
            onDeletePaper: (paper) => void deletePaper(paper),
            onToggleSidebar: () => setSidebarOpen(false),
            onNewFolder: (paperId) => setFolderPrompt({ kind: 'create', paperId }),
            onRenameFolder: (folderId, name) => setFolderPrompt({ kind: 'rename', folderId, name }),
            onDeleteFolder: (folderId, name) => void deleteFolder(folderId, name)
          }}
        />
      )}
      {sidebarOpen && <div className="column-resizer sidebar-resizer" onPointerDown={(event) => beginResize(event, 'sidebar')} />}
      <main className="reader-column">
        <ReaderPane
          paper={selectedPaper}
          attachments={attachments}
          notes={notes}
          inspectorCollapsed={!inspectorOpen}
          onToggleInspector={() => setInspectorCollapsed(inspectorOpen)}
          sidebarOpen={sidebarOpen}
          onShowSidebar={() => setSidebarOpen(true)}
          selection={selection}
          onSelection={setSelection}
          onCreateNote={(asSidenote) => void createNote(asSidenote)}
          onSaveAssistantNote={saveAssistantNote}
          onQuoteInWriting={(quoteSelection, citeOnly) => void quoteInWriting(quoteSelection, citeOnly)}
          navigation={navigation}
          onNavigationHandled={() => undefined}
          sidenoteFocusId={sidenoteFocusId}
          onSidenoteFocusHandled={() => setSidenoteFocusId(null)}
          onAddPaper={() => setAdding(true)}
          onArxivLink={(url) => void handleLink(url)}
          findToken={findToken}
          toast={toast}
          showToast={showToast}
          libraryEmpty={papers.length === 0}
        />
      </main>
      {inspectorOpen && <div className="column-resizer inspector-resizer" onPointerDown={(event) => beginResize(event, 'inspector')} />}
      {inspectorOpen && (
        <Inspector
          paper={selectedPaper}
          itemTypes={itemTypes}
          notes={notes}
          mode={settings.inspectorMode}
          onMode={setInspectorMode}
          selection={selection}
          focusedNoteId={focusedNoteId}
          onFocusHandled={() => setFocusedNoteId(null)}
          onCreateNote={() => void createNote(false)}
          onOpenNoteAnchor={openNoteAnchor}
          onOpenWriting={(id) => {
            void window.freddie.writings.select(id)
            void showWritingPane()
          }}
          onCreateWritingAbout={(paper) => void createWritingAbout(paper)}
          onOpenCitation={openCitation}
        />
      )}
      {dropActive && <div className="drop-highlight" />}
      {adding && <AddPaperSheet onClose={() => setAdding(false)} onImported={(paper) => { setAdding(false); select(paper.id) }} />}
      {folderPrompt && (
        <PromptSheet
          title={folderPrompt.kind === 'create' ? t('New Folder') : t('Rename Folder')}
          placeholder={t('Folder Name')}
          initialValue={folderPrompt.kind === 'rename' ? folderPrompt.name : ''}
          confirmTitle={folderPrompt.kind === 'create' ? t('Create') : t('Rename')}
          cancelTitle={t('Cancel')}
          onCancel={() => setFolderPrompt(null)}
          onConfirm={(name) => void commitFolder(folderPrompt, name)}
        />
      )}
      {arxivImport && (
        <Sheet width={460} label={t('Importing from arXiv')} onCancel={arxivImport.importing ? undefined : () => setArxivImport(null)}>
          <div className="arxiv-import">
            <h1>{t('Importing from arXiv')}</h1>
            <div className="secondary">{t('arXiv %@', arxivImport.identifier)}</div>
            {arxivImport.progress && <ImportProgressView progress={arxivImport.progress} />}
            {arxivImport.error && (
              <div className="arxiv-import-error">
                <strong>{t('Unable to Import Paper')}</strong>
                <div className="import-error selectable">{arxivImport.error}</div>
              </div>
            )}
            <div className="sheet-buttons">
              <Button disabled={arxivImport.importing} onClick={() => setArxivImport(null)}>{t('Close')}</Button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  )
}
