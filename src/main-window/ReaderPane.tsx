import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, AssistantSource, Note, NoteNavigationRequest, NoteSelectionContext, Paper, ReaderMode, TranslationDisplayMode, TranslationEvent } from '../../shared/types'
import { firstAttachment, isPartialTranslation, latestAttachment, resolvedReaderMode } from '../../shared/library'
import { sourceMetadata } from '../../shared/digest'
import { useApp } from '../app/context'
import { alertError, errorText, messageBox, popupMenu } from '../app/native'
import { Button, IconButton, PromptSheet, SegmentedPicker, Toast, ToolbarGroup, UnavailableView } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { PdfView, type AnnotationState, type AnnotationTool, type PdfViewHandle } from '../readers/PdfView'
import { DualPdfView, type DualSide } from '../readers/DualPdfView'
import { HtmlView, type RegionEditState } from '../readers/HtmlView'
import type { FindOptions, FindRequest, FindStatus } from '../readers/find'
import { FindBar } from '../overlays/FindBar'
import { TranslationCapsule, type CapsulePhase } from '../overlays/TranslationCapsule'
import { SelectionAssistant } from '../overlays/SelectionAssistant'
import { HtmlSidenotes } from './HtmlSidenotes'

interface TranslationRun {
  working: boolean
  cancelling: boolean
  message?: string
  completed?: number
  total?: number
  summary?: string
  outcome?: CapsulePhase
  needsSetup?: boolean
  logPath?: string
  kind?: 'html' | 'pdf' | 'latex' | 'scan'
}

const annotationColors: Array<{ id: string; title: string; color: string }> = [
  { id: 'yellow', title: 'Yellow', color: '#ffd60a' },
  { id: 'green', title: 'Green', color: '#34c759' },
  { id: 'blue', title: 'Blue', color: '#0a84ff' },
  { id: 'red', title: 'Red', color: '#ff3b30' },
  { id: 'purple', title: 'Purple', color: '#af52de' }
]

export interface ReaderPaneProps {
  paper?: Paper
  attachments: Attachment[]
  notes: Note[]
  inspectorCollapsed: boolean
  onToggleInspector: () => void
  selection: NoteSelectionContext | null
  onSelection: (selection: NoteSelectionContext | null) => void
  onCreateNote: (asSidenote: boolean) => void
  onSaveAssistantNote: (selection: NoteSelectionContext, markdown: string, existingNoteId?: string) => Promise<string>
  onQuoteInWriting: (selection: NoteSelectionContext, citeOnly: boolean) => void
  navigation: NoteNavigationRequest | null
  onNavigationHandled: () => void
  sidenoteFocusId: string | null
  onSidenoteFocusHandled: () => void
  onAddPaper: () => void
  onArxivLink: (url: string) => void
  findToken: number
  toast: string | null
  showToast: (message: string) => void
  libraryEmpty: boolean
}

export function ReaderPane(props: ReaderPaneProps): JSX.Element {
  const { snapshot, t, language } = useApp()
  const { paper, attachments } = props
  const settings = snapshot.settings
  const appearance = settings.readerAppearance
  const pdf = firstAttachment(attachments, 'pdf')
  const html = firstAttachment(attachments, 'html')
  const translated = latestAttachment(attachments, 'translatedPDF')
  const readingState = snapshot.readingStates.find((state) => state.paperId === paper?.id)

  const [readerMode, setReaderMode] = useState<ReaderMode>('pdf')
  const [lastPDFMode, setLastPDFMode] = useState<ReaderMode>('pdf')
  const [displayMode, setDisplayMode] = useState<TranslationDisplayMode>('bilingual')
  const [pageIndex, setPageIndex] = useState(0)
  const [restoredFor, setRestoredFor] = useState<string>()
  const [htmlReload, setHtmlReload] = useState(0)
  const [pdfReload, setPdfReload] = useState(0)
  const [segmentUpdate, setSegmentUpdate] = useState<{ segmentId: string; translatedHTML: string; sequence: number } | null>(null)
  const [runs, setRuns] = useState<Record<string, TranslationRun>>({})
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [originalPageCount, setOriginalPageCount] = useState<number>()
  const [findVisible, setFindVisible] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [findOptions, setFindOptions] = useState<FindOptions>({ matchCase: false, wholeWords: false })
  const [findToken, setFindToken] = useState(0)
  const [findDirection, setFindDirection] = useState<'forward' | 'backward'>('forward')
  const [findStatus, setFindStatus] = useState<FindStatus | null>(null)
  const [findFocus, setFindFocus] = useState(0)
  const [findTarget, setFindTarget] = useState<DualSide>('original')
  const [tool, setTool] = useState<AnnotationTool>({ mode: 'browse', color: '#ffd60a', lineWidth: 2 })
  const [annotationState, setAnnotationState] = useState<AnnotationState>({ canUndo: false, canRedo: false, hasTextSelection: false })
  const [pendingTextNote, setPendingTextNote] = useState<{ side?: DualSide; pageIndex: number; point: { x: number; y: number } } | null>(null)
  const [assistantSelection, setAssistantSelection] = useState<NoteSelectionContext | null>(null)
  const assistantPinned = useRef(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>()
  const [regionEditing, setRegionEditing] = useState(false)
  const [regionState, setRegionState] = useState<RegionEditState>({ hiddenCount: 0, canUndo: false, canRedo: false })
  const [regionCommand, setRegionCommand] = useState<{ action: 'undo' | 'redo' | 'restoreAll'; token: number } | null>(null)
  const [exportingPDF, setExportingPDF] = useState(false)
  const pdfRef = useRef<PdfViewHandle>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentWidth, setContentWidth] = useState(0)
  const dualRef = useRef<{ active(): PdfViewHandle | null }>(null)
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const run = paper ? runs[paper.id] : undefined
  const isWorking = Boolean(run?.working)

  // MARK: Reading state

  useEffect(() => {
    if (!paper) return
    const mode = resolvedReaderMode(readingState?.readerMode, Boolean(html), Boolean(pdf), Boolean(translated))
    setReaderMode(mode)
    if (mode !== 'html') setLastPDFMode(mode)
    setPageIndex(Math.max(0, readingState?.pageIndex ?? 0))
    setRestoredFor(paper.id)
    setStatusMessage(null)
    setRegionEditing(false)
    setAssistantSelection(null)
    setFindStatus(null)
    setTool((current) => ({ ...current, mode: 'browse' }))
  }, [paper?.id])

  // Keep the mode valid when attachments come and go, such as a finished translation.
  useEffect(() => {
    if (!paper || restoredFor !== paper.id) return
    const resolved = resolvedReaderMode(readerMode, Boolean(html), Boolean(pdf), Boolean(translated))
    if (resolved !== readerMode) {
      setReaderMode(resolved)
      if (resolved !== 'html') setLastPDFMode(resolved)
    }
  }, [Boolean(html), Boolean(pdf), Boolean(translated)])

  const attachmentFor = (mode: ReaderMode): string | undefined => mode === 'html' ? html?.id : mode === 'translatedPDF' ? translated?.id : pdf?.id

  const persistState = useCallback((mode: ReaderMode, page: number, scrollRatio: number) => {
    if (!paper || restoredFor !== paper.id) return
    clearTimeout(scrollSaveTimer.current)
    scrollSaveTimer.current = setTimeout(() => {
      void window.freddie.library.saveReadingState({ paperId: paper.id, attachmentId: attachmentFor(mode), readerMode: mode, pageIndex: page, scrollRatio: mode === 'html' ? scrollRatio : 0, zoomScale: 1 })
    }, 600)
  }, [paper?.id, restoredFor, html?.id, pdf?.id, translated?.id])

  useEffect(() => {
    if (paper && restoredFor === paper.id) persistState(readerMode, pageIndex, readingState?.scrollRatio ?? 0)
  }, [readerMode, pageIndex])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setContentWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** Anchored notes appear in the reader's margin, so they are edited there instead of the inspector. */
  const createNote = (): void => {
    const selection = props.selection
    const asSidenote = readerMode === 'html'
      ? Boolean(selection?.htmlSelector) && contentWidth >= 720
      : (readerMode === 'pdf' || readerMode === 'translatedPDF') && selection?.pageIndex !== undefined && contentWidth >= 760
    props.onCreateNote(asSidenote)
  }

  // MARK: Page count for partial translations

  useEffect(() => {
    setOriginalPageCount(undefined)
    if (!paper || !pdf) return
    let cancelled = false
    void window.freddie.library.pageCount(paper.id, pdf.id).then((result) => {
      if (!cancelled) setOriginalPageCount(result.pageCount)
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [paper?.id, pdf?.id])

  const partial = isPartialTranslation(translated, originalPageCount)
  const fullComplete = Boolean(translated) && (!translated?.translatedLastPage || !originalPageCount || translated.translatedLastPage >= originalPageCount)
  const nearEdge = partial && translated?.translatedLastPage !== undefined && pageIndex >= Math.max(0, translated.translatedLastPage - 2)

  // MARK: Translation events

  useEffect(() => window.freddie.translation.onEvent((event: TranslationEvent) => {
    setRuns((current) => {
      const previous = current[event.paperId] ?? { working: false, cancelling: false }
      let next: TranslationRun = { ...previous, kind: event.kind === 'abstract' ? previous.kind : event.kind }
      if (event.type === 'status') next = { ...next, working: true, message: event.message, cancelling: event.message === t('Cancelling translation...') || previous.cancelling }
      if (event.type === 'progress') next = { ...next, working: true, message: event.message, completed: event.completed, total: event.total, summary: event.summary }
      if (event.type === 'finished') next = { working: false, cancelling: false, message: event.message, outcome: { kind: 'completed' }, kind: next.kind }
      if (event.type === 'cancelled') next = { working: false, cancelling: false, message: event.message, outcome: { kind: 'cancelled' }, kind: next.kind }
      if (event.type === 'failed') next = { working: false, cancelling: false, message: event.message, needsSetup: event.needsSetup, logPath: event.logPath, kind: next.kind }
      return { ...current, [event.paperId]: next }
    })
    if (event.paperId !== paper?.id) return
    if (event.type === 'prepared') {
      setDisplayMode('bilingual')
      setHtmlReload((value) => value + 1)
    }
    if (event.type === 'segment' && event.segmentId && event.translatedHTML) {
      setDisplayMode('bilingual')
      setSegmentUpdate((current) => ({ segmentId: event.segmentId!, translatedHTML: event.translatedHTML!, sequence: (current?.sequence ?? 0) + 1 }))
    }
    if (event.type === 'finished') {
      const plain = [t('HTML translation completed.'), t('PDF translation completed.')].includes(event.message ?? '')
      setStatusMessage(plain ? null : event.message ?? null)
      // Show the saved page, including segments that arrived while it was reloading.
      if (event.kind === 'html') setHtmlReload((value) => value + 1)
      if (event.kind === 'pdf' || event.kind === 'latex' || event.kind === 'scan') {
        setPdfReload((value) => value + 1)
        setReaderMode('bilingualPDF')
        setLastPDFMode('bilingualPDF')
      }
    }
    if (event.type === 'failed') setStatusMessage(event.message ?? null)
    if (event.type === 'finished' || event.type === 'cancelled') {
      const paperId = event.paperId
      setTimeout(() => setRuns((current) => (current[paperId]?.working ? current : { ...current, [paperId]: { ...current[paperId], outcome: undefined } })), event.type === 'finished' ? 2000 : 1400)
    }
  }), [paper?.id, t])

  // MARK: Find

  useEffect(() => {
    if (props.findToken > 0 && paper) {
      setFindVisible(true)
      setFindFocus((value) => value + 1)
    }
  }, [props.findToken])

  useEffect(() => {
    if (committedQuery === findQuery) return
    const timer = setTimeout(() => setCommittedQuery(findQuery), findQuery ? 200 : 0)
    return () => clearTimeout(timer)
  }, [findQuery])

  useEffect(() => setFindStatus(null), [readerMode, findTarget])

  const findRequest: FindRequest | null = findVisible && committedQuery.trim() ? { query: committedQuery, options: findOptions, navigationToken: findToken, direction: findDirection } : null
  const visibleStatus = findRequest ? (findStatus && findStatus.query === findRequest.query && findStatus.options.matchCase === findOptions.matchCase && findStatus.options.wholeWords === findOptions.wholeWords ? findStatus : { query: findRequest.query, options: findOptions, isSearching: true, matchCount: 0 }) : null
  const moveFind = (direction: 'forward' | 'backward'): void => {
    if (committedQuery !== findQuery) {
      setCommittedQuery(findQuery)
      return
    }
    setFindDirection(direction)
    setFindToken((value) => value + 1)
  }

  // MARK: Selection and assistant

  const handleSelection = (selection: NoteSelectionContext | null): void => {
    props.onSelection(selection)
    clearTimeout(dismissTimer.current)
    if (selection) {
      assistantPinned.current = false
      setAssistantSelection(selection)
      return
    }
    if (assistantPinned.current) return
    dismissTimer.current = setTimeout(() => {
      if (!assistantPinned.current) setAssistantSelection(null)
    }, 350)
  }

  const activateSource = (source: AssistantSource): void => {
    assistantPinned.current = true
    if (source.urlString) {
      void window.freddie.shell.openExternal(source.urlString)
      return
    }
    if (source.pageIndex !== undefined) {
      setReaderMode(readerMode === 'html' ? 'pdf' : readerMode)
      setPageIndex(source.pageIndex)
    }
  }

  // MARK: Navigation from notes and citations

  const [readerNavigation, setReaderNavigation] = useState<{ id: string; pageIndex?: number; htmlSelector?: string; quote?: string; attachmentId?: string } | null>(null)
  useEffect(() => {
    const request = props.navigation
    if (!request || !paper || (request.paperId && request.paperId !== paper.id) || restoredFor !== paper.id) return
    if (request.htmlSelector && html) {
      setReaderMode('html')
      setDisplayMode('bilingual')
    } else if (request.pageIndex !== undefined) {
      const mode = request.attachmentId && request.attachmentId === translated?.id ? (pdf ? 'bilingualPDF' : 'translatedPDF') : pdf ? 'pdf' : translated ? 'translatedPDF' : readerMode
      setReaderMode(mode)
      if (mode !== 'html') setLastPDFMode(mode)
      setPageIndex(request.pageIndex)
    }
    setReaderNavigation({ ...request })
    props.onNavigationHandled()
  }, [props.navigation?.id, restoredFor])

  // MARK: Actions

  const primaryMode: 'html' | 'pdf' = readerMode === 'html' ? 'html' : 'pdf'
  const pdfDisplay: TranslationDisplayMode = (readerMode === 'html' ? lastPDFMode : readerMode) === 'bilingualPDF' ? 'bilingual' : (readerMode === 'html' ? lastPDFMode : readerMode) === 'translatedPDF' ? 'translated' : 'original'
  const displayChoice = readerMode === 'html' ? displayMode : pdfDisplay

  const setPrimaryMode = (value: 'html' | 'pdf'): void => {
    if (value === 'html') {
      if (readerMode !== 'html') setLastPDFMode(readerMode)
      setReaderMode('html')
    } else {
      setReaderMode(lastPDFMode === 'html' ? 'pdf' : lastPDFMode)
    }
    props.onSelection(null)
    setAssistantSelection(null)
  }

  const setDisplayChoice = (value: TranslationDisplayMode): void => {
    if (readerMode === 'html') {
      setDisplayMode(value)
      return
    }
    const mode: ReaderMode = value === 'original' ? 'pdf' : value === 'bilingual' ? 'bilingualPDF' : 'translatedPDF'
    setLastPDFMode(mode)
    setReaderMode(mode)
    props.onSelection(null)
    setAssistantSelection(null)
  }

  const fontSize = settings.htmlFontSize
  const setFontSize = (value: number): void => void window.freddie.settings.save({ htmlFontSize: Math.min(28, Math.max(13, Math.round(value))) })

  const activePdf = (): PdfViewHandle | null => readerMode === 'bilingualPDF' ? dualRef.current?.active() ?? null : pdfRef.current

  const showToolsMenu = async (anchor: HTMLElement): Promise<void> => {
    if (readerMode === 'html') {
      const choice = await popupMenu([
        { id: 'smaller', label: t('Decrease Font Size'), enabled: fontSize > 13 },
        { id: 'larger', label: t('Increase Font Size'), enabled: fontSize < 28 },
        { type: 'separator' },
        { id: 'reset', label: t('Reset Font Size'), enabled: fontSize !== 17 }
      ], anchor)
      if (choice === 'smaller') setFontSize(fontSize - 1)
      if (choice === 'larger') setFontSize(fontSize + 1)
      if (choice === 'reset') setFontSize(17)
      return
    }
    const modeItem = (mode: AnnotationTool['mode'], label: string) => ({ id: `mode:${mode}`, label, type: 'checkbox' as const, checked: tool.mode === mode })
    const choice = await popupMenu([
      modeItem('browse', t('Browse')),
      modeItem('ink', t('Freehand Draw')),
      modeItem('textNote', t('Place PDF Note')),
      modeItem('erase', t('Erase Annotation')),
      { type: 'separator' },
      { id: 'markup:highlight', label: t('Highlight Selection'), enabled: annotationState.hasTextSelection },
      { id: 'markup:underline', label: t('Underline Selection'), enabled: annotationState.hasTextSelection },
      { id: 'markup:strikeOut', label: t('Strike Through Selection'), enabled: annotationState.hasTextSelection },
      { type: 'separator' },
      { label: t('Annotation Color'), submenu: annotationColors.map((color) => ({ id: `color:${color.color}`, label: t(color.title), type: 'checkbox' as const, checked: tool.color === color.color })) },
      { label: t('Drawing Width'), submenu: [[1, 'Thin'], [2, 'Medium'], [5, 'Thick']].map(([width, title]) => ({ id: `width:${width}`, label: t(String(title)), type: 'checkbox' as const, checked: tool.lineWidth === width })) },
      { type: 'separator' },
      { id: 'undo', label: t('Undo PDF Annotation'), enabled: annotationState.canUndo },
      { id: 'redo', label: t('Redo PDF Annotation'), enabled: annotationState.canRedo }
    ], anchor)
    if (!choice) return
    const [kind, value] = choice.split(':')
    if (kind === 'mode') setTool({ ...tool, mode: value as AnnotationTool['mode'] })
    if (kind === 'markup') activePdf()?.applyMarkup(value as 'highlight' | 'underline' | 'strikeOut')
    if (kind === 'color') setTool({ ...tool, color: value })
    if (kind === 'width') setTool({ ...tool, lineWidth: Number(value) })
    if (choice === 'undo') activePdf()?.undo()
    if (choice === 'redo') activePdf()?.redo()
  }

  const translateHTML = async (): Promise<void> => {
    if (!paper) return
    setStatusMessage(null)
    setRuns((current) => ({ ...current, [paper.id]: { working: true, cancelling: false, message: t('Translating HTML...'), kind: 'html' } }))
    try {
      await window.freddie.translation.translateHTML(paper.id)
    } catch (error) {
      setRuns((current) => ({ ...current, [paper.id]: { working: false, cancelling: false } }))
      setStatusMessage(errorText(error))
    }
  }

  const startPDF = async (lastPage?: number, firstPage?: number): Promise<void> => {
    if (!paper) return
    setStatusMessage(null)
    setRuns((current) => ({ ...current, [paper.id]: { working: true, cancelling: false, message: t('Running BabelDOC...'), kind: 'pdf' } }))
    try {
      await window.freddie.translation.translatePDF(paper.id, lastPage, firstPage)
    } catch (error) {
      setRuns((current) => ({ ...current, [paper.id]: { working: false, cancelling: false } }))
      setStatusMessage(errorText(error))
    }
  }

  const startLatex = async (): Promise<void> => {
    if (!paper) return
    setStatusMessage(null)
    setRuns((current) => ({ ...current, [paper.id]: { working: true, cancelling: false, message: t('Preparing arXiv LaTeX source...'), kind: 'latex' } }))
    try {
      await window.freddie.translation.translateLatex(paper.id)
    } catch (error) {
      setRuns((current) => ({ ...current, [paper.id]: { working: false, cancelling: false } }))
      setStatusMessage(errorText(error))
    }
  }

  const startScan = async (lastPage?: number): Promise<void> => {
    if (!paper) return
    setStatusMessage(null)
    setRuns((current) => ({ ...current, [paper.id]: { working: true, cancelling: false, message: t('Preparing scanned PDF translation...'), kind: 'scan' } }))
    try {
      await window.freddie.translation.translateScannedPDF(paper.id, lastPage)
    } catch (error) {
      setRuns((current) => ({ ...current, [paper.id]: { working: false, cancelling: false } }))
      setStatusMessage(errorText(error))
    }
  }

  const batch = settings.pdfTranslationBatchSize
  const continuePDF = (lastPage?: number): void => {
    if (!translated?.translatedLastPage || !originalPageCount) return
    const last = Math.min(lastPage ?? translated.translatedLastPage + batch, originalPageCount)
    if (translated.source === 'scanRebuild') void startScan(last)
    else void startPDF(last, translated.translatedLastPage + 1)
  }

  const translatePDF = async (): Promise<void> => {
    if (partial) return continuePDF()
    const total = originalPageCount ?? 0
    if (total > batch) {
      const response = await messageBox({
        type: 'question',
        message: t('Choose Translation Scope'),
        detail: t('This PDF has %d pages. Translating the first %d pages is faster.', total, batch),
        buttons: [t('First %d Pages', batch), t('All Pages'), t('Cancel')],
        defaultId: 0,
        cancelId: 2
      })
      if (response === 0) void startPDF(batch)
      if (response === 1) void startPDF()
      return
    }
    void startPDF()
  }

  const translateScan = async (): Promise<void> => {
    if (!paper || !originalPageCount) return
    const response = await messageBox({
      type: 'question',
      message: t('Translate Scanned PDF'),
      detail: t('Page images go to the model chosen for scanned pages in Settings > Reader, which must accept images. Expect about a minute and 50,000 tokens per page (%d pages). Finished pages are saved, so running it again only pays for new pages. XeLaTeX (MacTeX) is required.', originalPageCount),
      buttons: originalPageCount > batch ? [t('First %d Pages', batch), t('All Pages'), t('Cancel')] : [t('Translate'), t('Cancel')],
      defaultId: 0,
      cancelId: originalPageCount > batch ? 2 : 1
    })
    if (response === 0) void startScan(originalPageCount > batch ? batch : undefined)
    if (response === 1 && originalPageCount > batch) void startScan()
  }

  const showTranslateMenu = async (anchor: HTMLElement): Promise<void> => {
    const choice = await popupMenu([
      { id: 'html', label: t('Translate HTML'), enabled: Boolean(html) },
      { id: 'pdf', label: partial ? t('Translate More PDF Pages') : fullComplete ? t('Retranslate PDF') : t('Translate PDF'), enabled: Boolean(pdf) },
      { id: 'latex', label: t('Translate arXiv LaTeX'), enabled: Boolean(paper?.arxivId && settings.latexTranslationEnabled) },
      { id: 'scan', label: t('Translate Scanned PDF…'), enabled: Boolean(pdf) }
    ], anchor)
    if (choice === 'html') void translateHTML()
    if (choice === 'pdf') void translatePDF()
    if (choice === 'latex') void startLatex()
    if (choice === 'scan') void translateScan()
  }

  const showShareMenu = async (anchor: HTMLElement): Promise<void> => {
    if (!paper) return
    const sourceURL = sourceMetadata(paper).url
    const exportAttachment = readerMode === 'translatedPDF' ? translated : pdf
    const choice = await popupMenu([
      { id: 'link', label: t('Copy Link'), enabled: Boolean(sourceURL) },
      { id: 'digest', label: t('Copy Digest') },
      { id: 'markdown', label: t('Export Markdown') },
      { type: 'separator' },
      readerMode === 'html'
        ? { id: 'html-pdf', label: t('Export HTML as PDF'), enabled: Boolean(html) && !exportingPDF }
        : { id: 'annotated', label: t('Export Annotated PDF'), enabled: Boolean(exportAttachment) }
    ], anchor)
    try {
      if (choice === 'link' && sourceURL) {
        await window.freddie.shell.copyText(sourceURL)
        props.showToast(t('Link copied to the clipboard.'))
      }
      if (choice === 'digest') {
        await window.freddie.digest.copyMarkdown(paper.id)
        props.showToast(t('Digest copied to the clipboard.'))
      }
      if (choice === 'markdown') {
        const name = await window.freddie.digest.export(paper.id)
        await messageBox({ type: 'info', message: t('Digest Ready'), detail: t('Digest exported to %@.', name), buttons: [t('OK')] })
      }
      if (choice === 'html-pdf') {
        setExportingPDF(true)
        const name = await window.freddie.digest.exportHTMLAsPDF(paper.id, displayMode, fontSize).finally(() => setExportingPDF(false))
        if (name) props.showToast(t('PDF exported to %@.', name))
      }
      if (choice === 'annotated' && exportAttachment) {
        const count = await window.freddie.annotations.exportAnnotated(paper.id, exportAttachment.id)
        if (count !== null) await messageBox({ type: 'info', message: t('PDF Exported'), detail: t('%d PDF annotations exported to %@.', count, ''), buttons: [t('OK')] })
      }
    } catch (error) {
      await alertError(choice === 'markdown' || choice === 'digest' ? t('Unable to Create Digest') : t('Unable to Export PDF'), errorText(error), t('OK'))
    }
  }

  const hasTranslatableContent = Boolean(html || pdf)
  const translateHelp = isWorking ? t('Translation in Progress') : html && pdf ? t('Translate HTML or PDF') : html ? t('Translate HTML') : pdf ? t('Translate PDF') : t('Translation Unavailable')
  const findAvailable = readerMode === 'html' ? Boolean(html) : readerMode === 'pdf' ? Boolean(pdf) : Boolean(translated)

  // MARK: Setup notice

  const needsSetup = !settings.translationSetupNoticeHandled && !snapshot.models.some((model) =>
    (model.id === settings.htmlModelId || model.id === settings.pdfModelId) && model.isEnabled && snapshot.providers.some((provider) => provider.id === model.providerId && provider.isEnabled && provider.apiKeyConfigured))

  const capsulePhase: CapsulePhase | undefined = run?.working ? { kind: 'running', cancelling: run.cancelling } : run?.outcome

  // MARK: Rendering

  const readerLabel = (text: string): JSX.Element => <span className="reader-label glass">{text}</span>
  const sidenotesFor = (attachmentId: string | undefined, includeUnattributed: boolean): Note[] =>
    props.notes.filter((note) => note.pageIndex !== undefined && (note.attachmentId === attachmentId || (includeUnattributed && !note.attachmentId)))

  const content = (): JSX.Element => {
    if (!paper) {
      return (
        <div className="empty-reader">
          <Icon name={props.libraryEmpty ? 'doc.badge.plus' : 'doc.text'} size={40} weight={1.2} className="tertiary" />
          <div className="empty-reader-text">
            <h2>{props.libraryEmpty ? t('Add Your First Paper') : t('No Paper Selected')}</h2>
            <p>{props.libraryEmpty ? t('Import from an arXiv ID or a web page URL, or drop a PDF here.') : t('Select a paper in the library, or add another one.')}</p>
          </div>
          <Button glass prominent={props.libraryEmpty} large onClick={props.onAddPaper}><Icon name="plus" size={15} /> {t('Add Paper')}</Button>
        </div>
      )
    }
    if (readerMode === 'html') {
      if (!html) return <UnavailableView icon="doc.text" title={t('No HTML available')} description={t('Import an arXiv paper or web page with HTML content to read it here.')} />
      return (
        <HtmlView
          paperId={paper.id}
          attachmentId={html.id}
          reloadToken={htmlReload}
          displayMode={displayMode}
          appearance={appearance}
          fontSize={fontSize}
          initialScrollRatio={readingState?.readerMode === 'html' ? readingState.scrollRatio : 0}
          onScrollRatio={(ratio) => persistState('html', pageIndex, ratio)}
          segmentUpdate={segmentUpdate}
          find={findRequest}
          onFindStatus={setFindStatus}
          navigation={readerNavigation}
          onSelection={handleSelection}
          sidenotes={props.notes.filter((note) => note.htmlSelector && (!note.attachmentId || note.attachmentId === html.id))}
          renderSidenotes={(positions, layout) => <HtmlSidenotes positions={positions} layout={layout} focusNoteId={props.sidenoteFocusId} onFocusHandled={props.onSidenoteFocusHandled} />}
          regionEditing={regionEditing}
          onRegionEditingExit={() => setRegionEditing(false)}
          regionCommand={regionCommand}
          onRegionState={setRegionState}
          onLinkActivated={props.onArxivLink}
        />
      )
    }
    if (readerMode === 'bilingualPDF') {
      if (!translated || !pdf) return <UnavailableView icon="character.book.closed" title={t('No translated PDF')} description={t('Run PDF translation first to compare the original and translated versions side by side.')} />
      return (
        <DualPdfView
          ref={dualRef}
          paperId={paper.id}
          original={{ url: `${window.freddie.shell.assetURL(paper.id, pdf.id)}?v=${pdfReload}`, attachmentId: pdf.id, label: readerLabel(t('Original')) }}
          translated={{
            url: `${window.freddie.shell.assetURL(paper.id, translated.id)}?v=${encodeURIComponent(translated.createdAt)}-${pdfReload}`,
            attachmentId: translated.id,
            label: readerLabel(partial ? t('Translation (partial)') : t('Translation')),
            maxPage: partial ? translated.translatedLastPage : undefined
          }}
          pageIndex={pageIndex}
          onPageChange={setPageIndex}
          appearance={appearance}
          find={findRequest}
          findTarget={findTarget}
          onFindStatus={setFindStatus}
          navigation={readerNavigation}
          onSelection={handleSelection}
          heldSelection={assistantSelection}
          tool={tool}
          onAnnotationState={setAnnotationState}
          onRequestTextNote={(side, page, point) => setPendingTextNote({ side, pageIndex: page, point })}
          onLinkActivated={props.onArxivLink}
        />
      )
    }
    const attachment = readerMode === 'translatedPDF' ? translated : pdf
    if (!attachment) {
      return readerMode === 'translatedPDF'
        ? <UnavailableView icon="doc.richtext" title={t('No translated PDF')} description={t('Run PDF translation first to read the translated PDF on its own.')} />
        : <UnavailableView icon="doc.richtext" title={t('No PDF available')} description={t('Import a PDF or fetch one from arXiv to read it here.')} />
    }
    return (
      <PdfView
        ref={pdfRef}
        key={attachment.id}
        paperId={paper.id}
        attachmentId={attachment.id}
        url={`${window.freddie.shell.assetURL(paper.id, attachment.id)}?v=${encodeURIComponent(attachment.createdAt)}-${pdfReload}`}
        pageIndex={pageIndex}
        onPageChange={setPageIndex}
        appearance={appearance}
        find={findRequest}
        onFindStatus={setFindStatus}
        navigation={readerNavigation}
        onSelection={handleSelection}
        heldSelection={assistantSelection}
        tool={tool}
        onAnnotationState={setAnnotationState}
        onRequestTextNote={(page, point) => setPendingTextNote({ pageIndex: page, point })}
        sidenotes={sidenotesFor(attachment.id, readerMode === 'pdf')}
        focusNoteId={props.sidenoteFocusId}
        onSidenoteFocusHandled={props.onSidenoteFocusHandled}
        onLinkActivated={props.onArxivLink}
        label={readerLabel(readerMode === 'translatedPDF' ? t('Translation') : t('Original'))}
        maxPage={readerMode === 'translatedPDF' && partial ? translated?.translatedLastPage : undefined}
      />
    )
  }

  const titleBarTitle = 'Freddie'

  return (
    <div className={`reader-pane appearance-${appearance}`}>
      <div className="reader-toolbar drag-region">
        <div className="window-title">{titleBarTitle}</div>
        <div className="toolbar-trailing no-drag">
          {paper && (
            <>
              <SegmentedPicker
                label={t('Reader')}
                title={t('Switch between HTML and PDF reading')}
                placement="toolbar"
                value={primaryMode}
                onChange={setPrimaryMode}
                options={[{ value: 'html', title: t('HTML') }, { value: 'pdf', title: t('PDF') }]}
              />
              <SegmentedPicker
                label={readerMode === 'html' ? t('Display') : t('PDF Display')}
                title={readerMode === 'html' ? t('HTML Display Mode') : t('PDF Display Mode')}
                placement="toolbar"
                value={displayChoice}
                onChange={setDisplayChoice}
                options={[{ value: 'original', title: t('Original') }, { value: 'bilingual', title: t('Bilingual') }, { value: 'translated', title: t('Translated') }]}
              />
              {readerMode === 'html' ? (
                <ToolbarGroup>
                  <IconButton icon="textformat.size" text={language === 'zh-Hans' ? '大小' : 'Aa'} indicator label={t('HTML Font Size: %d', fontSize)} onClick={(event) => void showToolsMenu(event.currentTarget)} />
                </ToolbarGroup>
              ) : null}
              <ToolbarGroup>
                {readerMode === 'html' ? (
                  <IconButton
                    icon="rectangle.and.pencil.and.ellipsis"
                    size={20}
                    label={regionEditing ? t('Finish Editing Regions') : isWorking ? t("Regions can't be edited while a translation is running.") : regionState.hiddenCount > 0 ? t('Hide or restore parts of this page (%lld hidden)', regionState.hiddenCount) : t('Hide or restore parts of this page')}
                    active={regionEditing}
                    disabled={!html || (isWorking && !regionEditing)}
                    onClick={() => setRegionEditing((value) => !value)}
                  />
                ) : (
                  <IconButton icon={tool.mode === 'browse' ? 'pencil.tip.crop.circle' : tool.mode === 'ink' ? 'pencil.tip' : tool.mode === 'textNote' ? 'note.text.badge.plus' : 'eraser'} size={19} label={t('PDF Annotations')} active={tool.mode !== 'browse'} onClick={(event) => void showToolsMenu(event.currentTarget)} />
                )}
                <IconButton icon="magnifyingglass" size={18} label={t('Find in Document')} disabled={!findAvailable} onClick={() => { setFindVisible(true); setFindFocus((value) => value + 1) }} />
                <IconButton icon="plus.circle" size={18} label={props.selection ? t('Add Note to Current Selection') : t('Select text in PDF or HTML to attach a note.')} disabled={!props.selection} onClick={createNote} />
                <IconButton icon="translate" size={19} label={translateHelp} disabled={isWorking || regionEditing || !hasTranslatableContent} onClick={(event) => void showTranslateMenu(event.currentTarget)} />
                <IconButton icon="square.and.arrow.up" size={18} label={exportingPDF ? t('Exporting PDF…') : t('Share Paper')} onClick={(event) => void showShareMenu(event.currentTarget)} />
              </ToolbarGroup>
            </>
          )}
          <ToolbarGroup className="circle">
            <IconButton icon="sidebar.trailing" size={19} label={props.inspectorCollapsed ? t('Show Inspector') : t('Hide Inspector')} onClick={props.onToggleInspector} />
          </ToolbarGroup>
        </div>
      </div>

      <div className="reader-body">
        {paper && (
          <div className="pane-header">
            <span className="pane-title">{paper.title}</span>
          </div>
        )}
        {paper && findVisible && (
          <FindBar
            query={findQuery}
            onQuery={setFindQuery}
            options={findOptions}
            onOptions={setFindOptions}
            bilingualTarget={readerMode === 'bilingualPDF' ? findTarget : undefined}
            onBilingualTarget={setFindTarget}
            status={visibleStatus}
            focusToken={findFocus}
            onNext={() => moveFind('forward')}
            onPrevious={() => moveFind('backward')}
            onClose={() => {
              setFindVisible(false)
              setFindStatus(null)
            }}
          />
        )}
        {paper && regionEditing && (
          <div className="region-bar">
            <Icon name="rectangle.and.pencil.and.ellipsis" size={17} className="secondary" />
            <div className="key-hints" title={t('Click a region to hide it, or a faded region to restore it. Shift-click another region to make the same change to everything in between. Press ↑ or ↓ to resize the outline and Esc to finish.')}>
              <span className="key-hint"><kbd>{t('Click')}</kbd>{t('Hide/Restore')}</span>
              <span className="key-hint"><kbd>⌘Z</kbd>{t('Undo')}</span>
              <span className="key-hint"><kbd>Esc</kbd>{t('Done')}</span>
            </div>
            <span className="spacer" />
            <span className="region-count">{t('Hidden: %lld', regionState.hiddenCount)}</span>
            <div className="control-group">
              <button type="button" title={t('Undo Region Change')} aria-label={t('Undo Region Change')} disabled={!regionState.canUndo} onClick={() => setRegionCommand({ action: 'undo', token: Date.now() })}><Icon name="arrow.uturn.backward" size={13} /></button>
              <button type="button" title={t('Redo Region Change')} aria-label={t('Redo Region Change')} disabled={!regionState.canRedo} onClick={() => setRegionCommand({ action: 'redo', token: Date.now() })}><Icon name="arrow.uturn.forward" size={13} /></button>
            </div>
            <Button small disabled={regionState.hiddenCount === 0} onClick={() => setRegionCommand({ action: 'restoreAll', token: Date.now() })}>{t('Restore All')}</Button>
            <Button small onClick={() => setRegionEditing(false)}>{t('Done')}</Button>
          </div>
        )}
        {!isWorking && statusMessage && (
          <div className="status-row">
            <span className={`status-message ${run?.logPath || run?.needsSetup || /error|错误|failed|失败|无法|Unable/i.test(statusMessage) ? 'error' : ''}`}>{statusMessage}</span>
            <span className="spacer" />
            {run?.needsSetup && <button type="button" className="link-button" onClick={() => void window.freddie.settings.openSettings('general')}>{t('Set Up Translation…')}</button>}
            {run?.logPath && <IconButton icon="doc.text" size={14} label={t('Show BabelDOC Log')} onClick={() => void window.freddie.translation.revealLog(run.logPath!)} />}
            <IconButton icon="doc.on.doc" size={14} label={t('Copy Message')} onClick={() => void window.freddie.shell.copyText(statusMessage)} />
            <IconButton icon="xmark" size={13} label={t('Close')} onClick={() => setStatusMessage(null)} />
          </div>
        )}
        <div className={`reader-content ${capsulePhase || props.toast ? 'has-bottom-overlay' : ''}`} ref={contentRef}>
          {content()}
          {paper && assistantSelection && assistantSelection.quote.trim() && (
            <SelectionAssistant
              paperId={paper.id}
              selection={assistantSelection}
              onInteraction={() => {
                clearTimeout(dismissTimer.current)
                assistantPinned.current = true
              }}
              onDismiss={() => setAssistantSelection(null)}
              onSaveNote={props.onSaveAssistantNote}
              onQuoteInWriting={(selection, citeOnly) => {
                props.onQuoteInWriting(selection, citeOnly)
                setAssistantSelection(null)
              }}
              onSourceActivated={activateSource}
            />
          )}
        </div>
        {paper && nearEdge && !isWorking && translated?.translatedLastPage !== undefined && originalPageCount !== undefined && (
          <div className="translate-more">
            <span>{t('Translated pages 1–%@ of %@.', String(translated.translatedLastPage), String(originalPageCount))}</span>
            <span className="spacer" />
            <Button small prominent glass onClick={() => continuePDF()}>{t('Translate pages %@–%@', String(translated.translatedLastPage + 1), String(Math.min(translated.translatedLastPage + batch, originalPageCount)))}</Button>
            {translated.translatedLastPage + batch < originalPageCount && <Button small glass onClick={() => continuePDF(originalPageCount)}>{t('Translate All')}</Button>}
          </div>
        )}
        <div className="bottom-overlays">
          {needsSetup && paper && !assistantSelection && (
            <div className="setup-notice glass">
              <Icon name="translate" size={16} className="secondary" />
              <span>{t('Connect a translation service to translate papers.')}</span>
              <Button small prominent onClick={() => {
                void window.freddie.settings.save({ translationSetupNoticeHandled: true })
                void window.freddie.settings.openSettings('general')
              }}>{t('Set Up…')}</Button>
              <IconButton icon="xmark" size={13} label={t('Close')} onClick={() => void window.freddie.settings.save({ translationSetupNoticeHandled: true })} />
            </div>
          )}
          {props.toast && <Toast message={props.toast} />}
          {capsulePhase && (
            <TranslationCapsule
              phase={capsulePhase}
              detail={run?.message}
              fraction={run?.total ? (run.completed ?? 0) / run.total : undefined}
              summary={run?.summary}
              onCancel={() => paper && void window.freddie.translation.cancel(paper.id)}
            />
          )}
        </div>
      </div>
      {pendingTextNote && (
        <PromptSheet
          title={t('Add PDF Note')}
          message={t('Enter the note to attach at this PDF position.')}
          placeholder={t('Note')}
          confirmTitle={t('Save')}
          cancelTitle={t('Cancel')}
          onCancel={() => setPendingTextNote(null)}
          onConfirm={(value) => {
            if (value.trim()) {
              const view = pendingTextNote.side ? dualRef.current?.active() : pdfRef.current
              view?.addTextNote(pendingTextNote.pageIndex, pendingTextNote.point, value.trim())
            }
            setPendingTextNote(null)
          }}
        />
      )}
    </div>
  )
}

export function useStableNotes(notes: Note[]): Note[] {
  return useMemo(() => notes, [notes.map((note) => `${note.id}:${note.modifiedAt}`).join('|')])
}
