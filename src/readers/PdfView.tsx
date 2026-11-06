import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { AssistantHistoryAnchor, Note, NoteSelectionContext, PdfAnnotation, PdfAnnotationRecord } from '../../shared/types'
import { annotationToRecord, recordToAnnotation, type PageGeometry } from '../../shared/pdfAnnotationGeometry'
import { openDocument, pageTexts, pdfjs } from './pdfjs'
import { buildMatcher, type FindRequest, type FindStatus } from './find'
import { SidenoteRail } from './SidenoteRail'
import { clampScale, fittedScale, pageSideMargin, resolvedScale, scalingAfterDividerGrab, wheelZoomFactor, type PdfScaling } from './pdfScaling'
import { bindAssistantHistory, historyQuoteRange, type HistoryRange } from './assistantHistory'
import { pdfBrowserRaster, pdfRenderQueue, pdfTextQueue, type QueuedPdfRender } from './pdfRenderQueue'
import { chunkTextContent } from './pdfTextContent'
import { rasterPdfPage, releasePageCanvas } from './pdfRaster'
import textLayerCSS from './pdfTextLayer.css?inline'
import { pdfContains, pdfEventTarget, pdfSelection } from './pdfSelection'
import { renderDensePdfText } from './pdfDenseText'

export type AnnotationMode = 'browse' | 'ink' | 'textNote' | 'erase'

export interface AnnotationTool {
  mode: AnnotationMode
  color: string
  lineWidth: number
}

export interface ScrollAnchor {
  pageIndex: number
  fraction: number
}

export interface PdfViewHandle {
  scrollAnchor(): ScrollAnchor | null
  scrollToAnchor(anchor: ScrollAnchor): void
  zoomIn(): void
  zoomOut(): void
  applyMarkup(type: 'highlight' | 'underline' | 'strikeOut'): boolean
  undo(): void
  redo(): void
  addTextNote(pageIndex: number, point: { x: number; y: number }, contents: string): void
}

export interface AnnotationState {
  canUndo: boolean
  canRedo: boolean
  hasTextSelection: boolean
}

interface PageSize {
  width: number
  height: number
}

const pageGap = 10
const railWidth = 280
const minimumReaderWidth = 480

export interface PdfViewProps {
  paperId: string
  attachmentId: string
  url: string
  pageIndex: number
  onPageChange: (pageIndex: number) => void
  appearance: 'default' | 'paper'
  find?: FindRequest | null
  onFindStatus?: (status: FindStatus) => void
  navigation?: { id: string; pageIndex?: number; quote?: string; outlineFraction?: number } | null
  onSelection?: (selection: NoteSelectionContext | null) => void
  assistantHistory?: AssistantHistoryAnchor[]
  onAssistantHistoryActivated?: (anchor: AssistantHistoryAnchor, selection: NoteSelectionContext) => void
  /** A selection the reader still acts on, such as the assistant's; it stays painted after focus moves away. */
  heldSelection?: NoteSelectionContext | null
  tool?: AnnotationTool
  onAnnotationState?: (state: AnnotationState) => void
  onRequestTextNote?: (pageIndex: number, point: { x: number; y: number }) => void
  sidenotes?: Note[]
  focusNoteId?: string | null
  onSidenoteFocusHandled?: () => void
  onOutlineLocation?: (page: number, fraction: number) => void
  onUserScroll?: () => void
  onLinkActivated?: (url: string) => void
  label?: ReactNode
  /** The last page a partial translation covers; later pages are shown as missing. */
  maxPage?: number
  /** Fit pages to the pane's width until the reader zooms, like the native dual-pane reader. */
  automaticScaling?: boolean
  /** Each change returns a zoomed pane to fitting when its scale is close to the fitted one, or caps a smaller one at fit. */
  scalingRestoreToken?: number
  /** Turns non-text PDF areas into a contextual drag-to-pan hand tool. */
  handToolEnabled?: boolean
}

function pageIndexAt(tops: number[], count: number, offset: number): number {
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (tops[mid] <= offset) low = mid
    else high = mid - 1
  }
  return Math.max(0, low)
}

function pageLeft(pageWidth: number, readerWidth: number): number {
  return Math.max(pageSideMargin, (readerWidth - pageWidth) / 2)
}

export const PdfView = forwardRef<PdfViewHandle, PdfViewProps>(function PdfView(props, ref) {
  const { url, attachmentId, paperId, appearance, onPageChange } = props
  const scroller = useRef<HTMLDivElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const textRoot = useRef<ShadowRoot>()
  const [textPortal, setTextPortal] = useState<ShadowRoot>()
  useLayoutEffect(() => {
    const host = textHost.current!
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    if (!root.querySelector('style[data-pdf-text]')) {
      const style = window.document.createElement('style')
      style.dataset.pdfText = 'true'
      style.textContent = textLayerCSS
      root.append(style, window.document.createElement('slot'))
    }
    textRoot.current = root
    setTextPortal(root)
    return () => { textRoot.current = undefined }
  }, [])
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [containerWidth, setContainerWidth] = useState(0)
  const initialScaling = (): PdfScaling => (props.automaticScaling ? { mode: 'fit' } : { mode: 'manual', scale: 1 })
  const [scaling, setScaling] = useState<PdfScaling>(initialScaling)
  // Render window followed by the actual viewport, so prefetch never outranks visible pages.
  const [visible, setVisible] = useState<[number, number, number, number]>([0, 2, 0, 0])
  const [error, setError] = useState<string>()
  const currentPage = useRef(props.pageIndex)
  const restoredFor = useRef<string>()
  const programmatic = useRef(0)
  const texts = useRef<string[]>()
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  // Stored records are in PDF page space; each page's PDF.js transform converts them.
  const [records, setRecords] = useState<PdfAnnotationRecord[] | null>(null)
  const geometries = useRef<PageGeometry[]>([])
  const unplacedRecords = useRef<PdfAnnotationRecord[]>([])
  const history = useRef<{ undo: PdfAnnotation[][]; redo: PdfAnnotation[][] }>({ undo: [], redo: [] })
  const [renderedPages, setRenderedPages] = useState(0)
  const panDrag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>()
  const [panning, setPanning] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout>>()
  const historySelectionGraceUntil = useRef(0)
  const historyInteraction = useRef({ activate: props.onAssistantHistoryActivated, mode: props.tool?.mode })
  historyInteraction.current = { activate: props.onAssistantHistoryActivated, mode: props.tool?.mode }

  // Load the document and every page's size.
  useEffect(() => {
    setDocument(undefined)
    setSizes([])
    setError(undefined)
    texts.current = undefined
    const handle = openDocument(url)
    let cancelled = false
    handle.promise.then(async (loaded) => {
      const loadedSizes: PageSize[] = []
      const loadedGeometries: PageGeometry[] = []
      // Ask for every page at once; awaiting them one by one serializes a worker round trip per page.
      const pages = await Promise.all(Array.from({ length: loaded.numPages }, (_, index) => loaded.getPage(index + 1)))
      for (const page of pages) {
        const viewport = page.getViewport({ scale: 1 })
        loadedSizes.push({ width: viewport.width, height: viewport.height })
        loadedGeometries.push({
          toNormalized: (x, y) => {
            const [left, top] = viewport.convertToViewportPoint(x, y) as [number, number]
            return [left / viewport.width, top / viewport.height]
          },
          toPDF: (x, y) => viewport.convertToPdfPoint(x * viewport.width, y * viewport.height) as [number, number]
        })
      }
      if (!cancelled) {
        geometries.current = loadedGeometries
        setDocument(loaded)
        setSizes(loadedSizes)
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
      handle.release()
    }
  }, [url])

  useEffect(() => {
    let cancelled = false
    history.current = { undo: [], redo: [] }
    setRecords(null)
    void window.freddie.annotations.list(paperId, attachmentId).then((list) => {
      if (!cancelled) setRecords(list)
    })
    return () => {
      cancelled = true
    }
    // A new URL is a reloaded file, possibly with synced annotations.
  }, [paperId, attachmentId, url])

  useEffect(() => {
    if (!records || !sizes.length) return
    const placed: PdfAnnotation[] = []
    const unplaced: PdfAnnotationRecord[] = []
    for (const record of records) {
      const geometry = geometries.current[record.pageIndex]
      if (geometry) placed.push(recordToAnnotation(record, attachmentId, geometry))
      else unplaced.push(record)
    }
    // Records for pages this file lacks (a partial translation) are kept, not shown.
    unplacedRecords.current = unplaced
    setAnnotations(placed)
  }, [records, sizes, attachmentId])

  const saveAnnotations = useCallback((list: PdfAnnotation[]) => {
    const stored = list.flatMap((annotation) => {
      const geometry = geometries.current[annotation.pageIndex]
      return geometry ? [annotationToRecord(annotation, geometry)] : annotation.record ? [annotation.record] : []
    })
    void window.freddie.annotations.save(paperId, attachmentId, [...stored, ...unplacedRecords.current])
  }, [paperId, attachmentId])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth))
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  // Another document starts over; reloading the same one, such as a translation update, keeps the zoom.
  const scaledAttachment = useRef(attachmentId)
  useEffect(() => {
    if (scaledAttachment.current === attachmentId) return
    scaledAttachment.current = attachmentId
    setScaling(initialScaling())
  }, [attachmentId])

  const showsRail = Boolean(props.sidenotes?.length) && containerWidth >= railWidth + minimumReaderWidth
  const readerWidth = containerWidth - (showsRail ? railWidth : 0)
  const widestPage = useMemo(() => sizes.reduce((widest, size) => Math.max(widest, size.width), 0), [sizes])
  const fitted = fittedScale(readerWidth, widestPage)
  // A single reader opens at the native “Actual Size”, one PDF point per CSS pixel; a dual pane fits its width.
  const scale = resolvedScale(scaling, fitted)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const restoreToken = useRef(props.scalingRestoreToken)
  useEffect(() => {
    if (restoreToken.current === props.scalingRestoreToken) return
    restoreToken.current = props.scalingRestoreToken
    if (!props.automaticScaling) return
    setScaling((current) => scalingAfterDividerGrab(current, fitted))
  }, [props.scalingRestoreToken])

  const tops = useMemo(() => {
    const result: number[] = []
    let top = pageGap
    for (const size of sizes) {
      result.push(top)
      top += size.height * scale + pageGap
    }
    result.push(top)
    return result
  }, [sizes, scale])

  const pageAt = useCallback((offset: number): number => pageIndexAt(tops, sizes.length, offset), [sizes.length, tops])

  // The last scroll position the reader saw; layout changes may clamp `scrollTop` before effects run.
  const scrollPosition = useRef({ top: 0, left: 0 })
  const rememberScrollPosition = (element: HTMLElement): void => {
    scrollPosition.current = { top: element.scrollTop, left: element.scrollLeft }
  }
  const scrollToPage = useCallback((pageIndex: number, fraction = 0, topOffset?: number) => {
    const element = scroller.current
    if (!element || !sizes.length) return
    const index = Math.min(Math.max(pageIndex, 0), sizes.length - 1)
    programmatic.current += 1
    element.scrollTop = tops[index] + sizes[index].height * scale * fraction - (topOffset ?? (fraction === 0 ? pageGap : element.clientHeight / 2))
    rememberScrollPosition(element)
    requestAnimationFrame(() => {
      programmatic.current = Math.max(0, programmatic.current - 1)
    })
  }, [sizes, tops, scale])

  const updateVisible = useCallback(() => {
    const element = scroller.current
    if (!element || !sizes.length) return
    const trackingY = element.scrollTop + Math.min(100, element.clientHeight * 0.22)
    const trackingPage = pageAt(trackingY)
    props.onOutlineLocation?.(trackingPage, Math.max(0, Math.min(1, (trackingY - tops[trackingPage]) / (sizes[trackingPage].height * scale))))
    const first = pageAt(element.scrollTop - element.clientHeight)
    const last = pageAt(element.scrollTop + element.clientHeight * 2)
    let viewportFirst = pageAt(element.scrollTop)
    // A page ending at the top edge (or above it, in the gap) is prefetch, not visible.
    if (viewportFirst < sizes.length - 1 && tops[viewportFirst] + sizes[viewportFirst].height * scale <= element.scrollTop) viewportFirst += 1
    const viewportLast = pageAt(element.scrollTop + element.clientHeight)
    setVisible((current) => (current[0] === first && current[1] === last && current[2] === viewportFirst && current[3] === viewportLast
      ? current : [first, last, viewportFirst, viewportLast]))
    const center = pageAt(element.scrollTop + element.clientHeight / 3)
    if (center !== currentPage.current) {
      currentPage.current = center
      onPageChange(center)
    }
  }, [pageAt, sizes, tops, scale, onPageChange, props.onOutlineLocation])

  // Restore the reading position once per document, then follow outside navigation.
  useLayoutEffect(() => {
    if (!sizes.length || !containerWidth) return
    if (restoredFor.current !== url) {
      restoredFor.current = url
      currentPage.current = props.pageIndex
      scrollToPage(props.pageIndex)
      updateVisible()
      return
    }
    if (props.pageIndex !== currentPage.current) {
      currentPage.current = props.pageIndex
      scrollToPage(props.pageIndex)
      updateVisible()
    }
  }, [props.pageIndex, sizes.length, containerWidth, url])

  // Keep the same place on the page when the scale changes: the point under the pointer while
  // zooming, otherwise the top of the view.
  const committedLayout = useRef({ scale, sizes, tops, readerWidth })
  const zoomFocus = useRef<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const element = scroller.current
    const previous = committedLayout.current
    committedLayout.current = { scale, sizes, tops, readerWidth }
    const focus = zoomFocus.current
    zoomFocus.current = null
    if (!element || !sizes.length || previous.sizes !== sizes || previous.scale === scale) return
    const viewX = focus?.x ?? element.clientWidth / 2
    const viewY = focus?.y ?? 0
    const { top, left } = scrollPosition.current
    const index = pageIndexAt(previous.tops, sizes.length, top + viewY)
    const size = sizes[index]
    const fractionY = (top + viewY - previous.tops[index]) / (size.height * previous.scale)
    const fractionX = (left + viewX - pageLeft(size.width * previous.scale, previous.readerWidth)) / (size.width * previous.scale)
    programmatic.current += 1
    element.scrollTop = tops[index] + fractionY * size.height * scale - viewY
    element.scrollLeft = pageLeft(size.width * scale, readerWidth) + fractionX * size.width * scale - viewX
    rememberScrollPosition(element)
    requestAnimationFrame(() => {
      programmatic.current = Math.max(0, programmatic.current - 1)
    })
    updateVisible()
  }, [scale, sizes, tops, readerWidth])

  useEffect(() => {
    updateVisible()
  }, [tops])

  const scrollFrame = useRef<number>()
  const userScrolled = useRef(false)
  const flushScroll = useRef(() => {})
  flushScroll.current = () => {
    scrollFrame.current = undefined
    updateVisible()
    const notify = userScrolled.current
    userScrolled.current = false
    if (notify) props.onUserScroll?.()
  }
  const onScroll = (): void => {
    if (scroller.current) rememberScrollPosition(scroller.current)
    setScrolling(true)
    clearTimeout(scrollIdleTimer.current)
    scrollIdleTimer.current = setTimeout(() => setScrolling(false), 180)
    userScrolled.current ||= programmatic.current === 0
    scrollFrame.current ??= requestAnimationFrame(() => flushScroll.current())
  }
  useEffect(() => () => {
    clearTimeout(scrollIdleTimer.current)
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
  }, [])

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!props.handToolEnabled || (props.tool?.mode ?? 'browse') !== 'browse' || event.button !== 0) return
    const target = pdfEventTarget(event.nativeEvent)
    if (target instanceof Element && target.closest('.textLayer span, .textLayer br, .pdf-dense-text, .pdf-link, .annotation-note, .sidenote-rail, button, input, textarea, a')) return
    const box = event.currentTarget.getBoundingClientRect()
    // Keep native scrollbars draggable, especially on Windows where they are usually always visible.
    if (event.clientX - box.left >= event.currentTarget.clientWidth || event.clientY - box.top >= event.currentTarget.clientHeight) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panDrag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop
    }
    setPanning(true)
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = panDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x)
    event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y)
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panDrag.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    panDrag.current = undefined
    setPanning(false)
  }

  // Zoom around the pointer with pinch or Command/Control and the wheel; zooming stops fitting the width.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const next = clampScale(scaleRef.current * wheelZoomFactor(event))
      if (next === scaleRef.current) return
      const box = element.getBoundingClientRect()
      zoomFocus.current = { x: event.clientX - box.left, y: event.clientY - box.top }
      scaleRef.current = next
      setScaling({ mode: 'manual', scale: next })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  // MARK: Find

  const [matches, setMatches] = useState<Array<{ page: number; start: number; end: number }>>([])
  const [currentMatch, setCurrentMatch] = useState(-1)
  const findKey = props.find ? `${props.find.query}|${props.find.options.matchCase}|${props.find.options.wholeWords}` : ''

  useEffect(() => {
    if (!props.find || !document) {
      setMatches([])
      setCurrentMatch(-1)
      return
    }
    let cancelled = false
    const request = props.find
    props.onFindStatus?.({ query: request.query, options: request.options, isSearching: true, matchCount: 0 })
    void (async () => {
      texts.current ??= await pageTexts(document)
      if (cancelled) return
      const matcher = buildMatcher(request.query, request.options)
      const found: Array<{ page: number; start: number; end: number }> = []
      texts.current.forEach((text, page) => {
        if (props.maxPage && page >= props.maxPage) return
        for (const match of text.matchAll(matcher)) found.push({ page, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
      })
      setMatches(found)
      const start = found.findIndex((match) => match.page >= currentPage.current)
      const index = found.length ? (start >= 0 ? start : 0) : -1
      setCurrentMatch(index)
      props.onFindStatus?.({ query: request.query, options: request.options, isSearching: false, matchCount: found.length, currentIndex: index >= 0 ? index : undefined })
      if (index >= 0) scrollToPage(found[index].page, 0.3)
    })()
    return () => {
      cancelled = true
    }
  }, [findKey, document])

  const lastNavigationToken = useRef(props.find?.navigationToken ?? 0)
  useEffect(() => {
    if (!props.find || props.find.navigationToken === lastNavigationToken.current) return
    lastNavigationToken.current = props.find.navigationToken
    if (!matches.length) return
    const delta = props.find.direction === 'backward' ? -1 : 1
    const next = (currentMatch + delta + matches.length) % matches.length
    setCurrentMatch(next)
    props.onFindStatus?.({ query: props.find.query, options: props.find.options, isSearching: false, matchCount: matches.length, currentIndex: next })
    scrollToPage(matches[next].page, 0.3)
  }, [props.find?.navigationToken])

  // Paint matches in the rendered text layers with the CSS Custom Highlight API.
  useEffect(() => {
    const element = scroller.current
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    if (!element || !registry || !matches.length) return
    const all: Range[] = []
    const current: Range[] = []
    matches.forEach((match, index) => {
      const layer = textRoot.current?.querySelector<HTMLElement>(`[data-page-index="${match.page}"] .textLayer`)
      if (!layer) return
      const range = rangeForOffsets(layer, match.start, match.end)
      if (!range) return
      ;(index === currentMatch ? current : all).push(range)
      if (index === currentMatch) {
        const rect = range.getBoundingClientRect()
        const box = element.getBoundingClientRect()
        if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
          programmatic.current += 1
          element.scrollTop += rect.top - box.top - box.height / 3
          requestAnimationFrame(() => {
            programmatic.current = Math.max(0, programmatic.current - 1)
          })
        }
      }
    })
    const HighlightConstructor = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
    registry.set(`rp-find-${attachmentId}`, new HighlightConstructor(...all))
    registry.set(`rp-find-current-${attachmentId}`, new HighlightConstructor(...current))
    ensureHighlightStyle(attachmentId, textRoot.current)
    return () => {
      registry.delete(`rp-find-${attachmentId}`)
      registry.delete(`rp-find-current-${attachmentId}`)
    }
  }, [matches, currentMatch, renderedPages, attachmentId])

  // MARK: Navigation to notes and citations

  const [targetHighlight, setTargetHighlight] = useState<{ page: number; quote: string } | null>(null)
  useEffect(() => {
    const navigation = props.navigation
    if (!navigation || navigation.pageIndex === undefined || !sizes.length) return
    currentPage.current = navigation.pageIndex
    const fraction = navigation.outlineFraction
    scrollToPage(navigation.pageIndex, fraction === undefined ? 0 : Math.min(1, Math.max(0, fraction)),
      fraction === undefined ? undefined : Math.min(100, (scroller.current?.clientHeight ?? 0) * 0.22))
    if (fraction !== undefined) updateVisible()
    if (navigation.quote) setTargetHighlight({ page: navigation.pageIndex, quote: navigation.quote })
    const timer = setTimeout(() => setTargetHighlight(null), 4000)
    return () => clearTimeout(timer)
  }, [props.navigation?.id, sizes.length])

  useEffect(() => {
    const element = scroller.current
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    if (!element || !registry || !targetHighlight) return
    const layer = textRoot.current?.querySelector<HTMLElement>(`[data-page-index="${targetHighlight.page}"] .textLayer`)
    if (!layer) return
    const text = layer.textContent ?? ''
    const normalizedQuote = targetHighlight.quote.replace(/\s+/g, ' ').trim().slice(0, 120)
    const pattern = new RegExp(normalizedQuote.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i')
    const match = text.match(pattern)
    if (!match || match.index === undefined) return
    const range = rangeForOffsets(layer, match.index, match.index + match[0].length)
    if (!range) return
    const HighlightConstructor = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
    registry.set('rp-note-target', new HighlightConstructor(range))
    const rect = range.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    element.scrollTop += rect.top - box.top - box.height / 3
    return () => {
      registry.delete('rp-note-target')
    }
  }, [targetHighlight, renderedPages])

  // MARK: Selection

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const entries: HistoryRange[] = []
    for (const anchor of props.assistantHistory ?? []) {
      const selection = anchor.selection
      if ((selection.attachmentId != null && selection.attachmentId !== attachmentId) || selection.pageIndex === undefined) continue
      const layer = textRoot.current?.querySelector(`[data-page-index="${selection.pageIndex}"] .textLayer`)
      if (!layer) continue
      const range = historyQuoteRange(layer, selection.quote, true)
      if (range) entries.push({ anchor, range })
    }
    return bindAssistantHistory(element, entries, {
      name: `rp-assistant-history-${attachmentId}`,
      styleRoot: textRoot.current,
      selectionGraceUntil: historySelectionGraceUntil,
      enabled: () => !historyInteraction.current.mode || historyInteraction.current.mode === 'browse',
      activate: (anchor, range) => {
        const rect = range.getBoundingClientRect()
        historyInteraction.current.activate?.(anchor, { ...anchor.selection, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
      }
    })
  }, [props.assistantHistory, attachmentId, renderedPages, visible, document])

  const lastSelection = useRef<{ range: Range; quote: string } | null>(null)
  const [hasNativeSelection, setHasNativeSelection] = useState(false)

  useEffect(() => {
    const element = scroller.current
    if (!element || !props.onSelection) return
    const report = (): void => {
      const selection = pdfSelection(textRoot.current)
      const quote = selection?.toString().replace(/\s+/g, ' ').trim() ?? ''
      if (!selection || selection.isCollapsed || !selection.rangeCount || !quote) {
        if (Date.now() < historySelectionGraceUntil.current) return
        props.onSelection?.(null)
        props.onAnnotationState?.({ ...annotationState(), hasTextSelection: false })
        return
      }
      const range = selection.getRangeAt(0)
      const pageElement = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[data-page-index]')
        ?? (range.startContainer.parentElement?.closest<HTMLElement>('[data-page-index]'))
      if (!pageElement || !pdfContains(element, textRoot.current, pageElement)) return
      const pageIndex = Number(pageElement.dataset.pageIndex)
      const pageText = texts.current?.[pageIndex] ?? pageElement.querySelector('.textLayer')?.textContent ?? ''
      const at = pageText.indexOf(quote.slice(0, 40))
      const context = at >= 0 ? pageText.slice(Math.max(0, at - 600), at + quote.length + 600) : pageText.slice(0, 1600)
      lastSelection.current = { range: range.cloneRange(), quote }
      const rect = range.getBoundingClientRect()
      props.onSelection?.({ attachmentId, quote, pageIndex, context, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
      props.onAnnotationState?.({ ...annotationState(), hasTextSelection: true })
    }
    const mouseUp = (): void => {
      setTimeout(report, 0)
    }
    const selectionChange = (): void => {
      const selection = pdfSelection(textRoot.current)
      setHasNativeSelection(Boolean(selection && !selection.isCollapsed && pdfContains(element, textRoot.current, selection.anchorNode)))
      if (!selection || selection.isCollapsed) report()
    }
    // The app is `user-select: none`, and Chromium keeps a selection when a click lands on
    // unselectable content, so clicks on blank page areas or elsewhere must clear it here.
    // Controls and the selection assistant keep it, since they act on the selection.
    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const selection = pdfSelection(textRoot.current)
      if (!selection || selection.isCollapsed || !pdfContains(element, textRoot.current, selection.anchorNode)) return
      const target = pdfEventTarget(event)
      if (target?.closest('.textLayer :is(span, br), .pdf-dense-text')) return
      if (target === element && (event.offsetX >= element.clientWidth || event.offsetY >= element.clientHeight)) return
      if (target && !pdfContains(element, textRoot.current, target) && target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable], .selection-assistant')) return
      selection.removeAllRanges()
    }
    element.addEventListener('mouseup', mouseUp)
    element.addEventListener('keyup', mouseUp)
    window.document.addEventListener('selectionchange', selectionChange)
    window.document.addEventListener('pointerdown', pointerDown, true)
    return () => {
      element.removeEventListener('mouseup', mouseUp)
      element.removeEventListener('keyup', mouseUp)
      window.document.removeEventListener('selectionchange', selectionChange)
      window.document.removeEventListener('pointerdown', pointerDown, true)
    }
  }, [attachmentId, props.onSelection])

  // Focusing a field, like the assistant's question box, moves the one native selection there,
  // so paint the held selection's range until the reader lets go of it.
  useEffect(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const last = lastSelection.current
    const held = props.heldSelection
    // Compare the quotes taken from the selection; a range's own text drops the text layer's line breaks.
    if (!registry || !last || hasNativeSelection || !held || held.attachmentId !== attachmentId || held.quote !== last.quote) return
    const HighlightConstructor = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
    registry.set(`rp-held-selection-${attachmentId}`, new HighlightConstructor(last.range))
    ensureHighlightStyle(attachmentId, textRoot.current)
    return () => {
      registry.delete(`rp-held-selection-${attachmentId}`)
    }
  }, [props.heldSelection, hasNativeSelection, attachmentId])

  // MARK: Annotations

  const annotationState = (): Omit<AnnotationState, 'hasTextSelection'> => ({
    canUndo: history.current.undo.length > 0,
    canRedo: history.current.redo.length > 0
  })

  const commitAnnotations = useCallback((next: PdfAnnotation[]) => {
    setAnnotations((previous) => {
      history.current.undo.push(previous)
      history.current.redo = []
      saveAnnotations(next)
      return next
    })
    requestAnimationFrame(() => props.onAnnotationState?.({ ...annotationState(), hasTextSelection: Boolean(pdfSelection(textRoot.current)?.toString()) }))
  }, [saveAnnotations])

  // PdfPage is memoized: give it stable callbacks and per-page annotation lists, so scrolling or a
  // page finishing its render re-renders only the pages whose props changed, not every page.
  const pageActions = useRef({ annotations, attachmentId, tool: props.tool, commitAnnotations, onRequestTextNote: props.onRequestTextNote, onLinkActivated: props.onLinkActivated })
  pageActions.current = { annotations, attachmentId, tool: props.tool, commitAnnotations, onRequestTextNote: props.onRequestTextNote, onLinkActivated: props.onLinkActivated }
  const onPageRendered = useCallback(() => setRenderedPages((value) => value + 1), [])
  const onCommitInk = useCallback((pageIndex: number, path: Array<{ x: number; y: number }>) => {
    const { annotations: current, attachmentId: attachment, tool, commitAnnotations: commit } = pageActions.current
    commit([...current, {
      id: crypto.randomUUID(), attachmentId: attachment, pageIndex, type: 'ink', color: tool?.color ?? '#ff3b30', lineWidth: tool?.lineWidth ?? 2, paths: [path], createdAt: new Date().toISOString()
    }])
  }, [])
  const onErase = useCallback((id: string) => {
    const { annotations: current, commitAnnotations: commit } = pageActions.current
    commit(current.filter((annotation) => annotation.id !== id))
  }, [])
  const onPlaceNote = useCallback((pageIndex: number, point: { x: number; y: number }) => pageActions.current.onRequestTextNote?.(pageIndex, point), [])
  const onLink = useCallback((target: string) => pageActions.current.onLinkActivated?.(target), [])
  const annotationsByPage = useMemo(() => {
    const byPage = new Map<number, PdfAnnotation[]>()
    for (const annotation of annotations) {
      const list = byPage.get(annotation.pageIndex)
      if (list) list.push(annotation)
      else byPage.set(annotation.pageIndex, [annotation])
    }
    return byPage
  }, [annotations])

  useImperativeHandle(ref, () => ({
    scrollAnchor: () => {
      const element = scroller.current
      if (!element || !sizes.length) return null
      const center = element.scrollTop + element.clientHeight / 2
      const pageIndex = pageAt(center)
      return { pageIndex, fraction: (center - tops[pageIndex]) / (sizes[pageIndex].height * scale) }
    },
    scrollToAnchor: (anchor) => {
      if (anchor.pageIndex >= sizes.length) return
      scrollToPage(anchor.pageIndex, Math.min(Math.max(anchor.fraction, 0), 1))
      updateVisible()
    },
    zoomIn: () => {
      const element = scroller.current
      if (element) zoomFocus.current = { x: element.clientWidth / 2, y: element.clientHeight / 2 }
      const next = clampScale(scaleRef.current * 1.2)
      scaleRef.current = next
      setScaling({ mode: 'manual', scale: next })
    },
    zoomOut: () => {
      const element = scroller.current
      if (element) zoomFocus.current = { x: element.clientWidth / 2, y: element.clientHeight / 2 }
      const next = clampScale(scaleRef.current / 1.2)
      scaleRef.current = next
      setScaling({ mode: 'manual', scale: next })
    },
    applyMarkup: (type) => {
      const selection = pdfSelection(textRoot.current)
      if (!selection || selection.isCollapsed || !scroller.current) return false
      const range = selection.getRangeAt(0)
      const byPage = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>()
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue
        const pageElement = (textRoot.current ?? window.document).elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          .map((node) => node.closest<HTMLElement>('[data-page-index]'))
          .find((node): node is HTMLElement => Boolean(node && scroller.current && pdfContains(scroller.current, textRoot.current, node)))
        if (!pageElement) continue
        const box = pageElement.getBoundingClientRect()
        const pageIndex = Number(pageElement.dataset.pageIndex)
        byPage.set(pageIndex, [...(byPage.get(pageIndex) ?? []), {
          x: (rect.left - box.left) / box.width,
          y: (rect.top - box.top) / box.height,
          width: rect.width / box.width,
          height: rect.height / box.height
        }])
      }
      if (!byPage.size) return false
      // One annotation per line, as native Freddie stores text markup.
      const created: PdfAnnotation[] = [...byPage.entries()].flatMap(([pageIndex, rects]) => mergeLineRects(rects).map((rect) => ({
        id: crypto.randomUUID(),
        attachmentId,
        pageIndex,
        type,
        color: props.tool?.color ?? '#ffd60a',
        rects: [rect],
        createdAt: new Date().toISOString()
      })))
      commitAnnotations([...annotations, ...created])
      selection.removeAllRanges()
      props.onSelection?.(null)
      return true
    },
    undo: () => {
      const previous = history.current.undo.pop()
      if (!previous) return
      history.current.redo.push(annotations)
      setAnnotations(previous)
      saveAnnotations(previous)
      props.onAnnotationState?.({ ...annotationState(), hasTextSelection: false })
    },
    redo: () => {
      const next = history.current.redo.pop()
      if (!next) return
      history.current.undo.push(annotations)
      setAnnotations(next)
      saveAnnotations(next)
      props.onAnnotationState?.({ ...annotationState(), hasTextSelection: false })
    },
    addTextNote: (pageIndex, point, contents) => {
      commitAnnotations([...annotations, {
        id: crypto.randomUUID(),
        attachmentId,
        pageIndex,
        type: 'text',
        color: props.tool?.color ?? '#ffd60a',
        rects: [{ x: point.x, y: point.y, width: 0.03, height: 0.03 }],
        contents,
        createdAt: new Date().toISOString()
      }])
    }
  }), [sizes, tops, scale, pageAt, scrollToPage, updateVisible, annotations, commitAnnotations, saveAnnotations, attachmentId, props.tool?.color])

  const pageCount = sizes.length
  const totalHeight = tops[pageCount] ?? 0

  return (
    <div className={`pdf-view appearance-${appearance} mode-${props.tool?.mode ?? 'browse'} ${props.handToolEnabled ? 'hand-tool-enabled' : ''} ${panning ? 'panning' : ''}`}>
      <div
        ref={scroller}
        className="pdf-scroller"
        onScroll={onScroll}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {error && <div className="pdf-error">{error}</div>}
        <div ref={textHost} className="pdf-canvas-area" style={{ height: totalHeight, width: showsRail ? readerWidth : Math.max(readerWidth, Math.round(widestPage * scale + 2 * pageSideMargin)) }}>
          {document && textPortal && sizes.slice(visible[0], visible[1] + 1).map((size, offset) => {
            const index = visible[0] + offset
            return (
              <PdfPage
                key={index}
                document={document}
                paperId={paperId}
                attachmentId={attachmentId}
                revision={url}
                textRoot={textPortal}
                interactive={!scrolling || hasNativeSelection}
                index={index}
                size={size}
                scale={scale}
                top={tops[index]}
                left={pageLeft(size.width * scale, readerWidth)}
                priority={index >= visible[2] && index <= visible[3] ? 0 : 1}
                missing={props.maxPage !== undefined && index >= props.maxPage}
                paperTone={appearance === 'paper'}
                annotations={annotationsByPage.get(index) ?? noAnnotations}
                tool={props.tool}
                onRendered={onPageRendered}
                onCommitInk={onCommitInk}
                onErase={onErase}
                onPlaceNote={onPlaceNote}
                onLink={onLink}
              />
            )
          })}
        </div>
        {showsRail && props.sidenotes && (
          <SidenoteRail
            notes={props.sidenotes}
            pageTops={tops}
            pageHeights={sizes.map((size) => size.height * scale)}
            left={readerWidth}
            width={railWidth}
            focusNoteId={props.focusNoteId}
            onFocusHandled={props.onSidenoteFocusHandled}
          />
        )}
      </div>
      {props.label && <div className="reader-label-slot">{props.label}</div>}
    </div>
  )
})

const noAnnotations: PdfAnnotation[] = []

/** Paper Tone multiplies the page by (0.96, 0.93, 0.86), like the native color matrix. */
const paperToneColor = 'rgb(245, 237, 219)'

/**
 * The most device pixels one page bitmap may hold (about 64 MB). Past it a zoomed page renders
 * at a lower density and is stretched, as pdf.js's viewer does, instead of filling GPU memory.
 */
const maxPagePixels = 2 ** 24

const releaseCanvas = releasePageCanvas

const PdfPage = memo(function PdfPage({ document, paperId, attachmentId, revision, textRoot, interactive, index, size, scale, top, left, priority, missing, paperTone, annotations, tool, onRendered, onCommitInk, onErase, onPlaceNote, onLink }: {
  document: PDFDocumentProxy
  paperId: string
  attachmentId: string
  revision: string
  textRoot: ShadowRoot
  interactive: boolean
  index: number
  size: PageSize
  scale: number
  top: number
  left: number
  priority: number
  missing: boolean
  paperTone: boolean
  annotations: PdfAnnotation[]
  tool?: AnnotationTool
  onRendered: () => void
  onCommitInk: (pageIndex: number, path: Array<{ x: number; y: number }>) => void
  onErase: (id: string) => void
  onPlaceNote: (pageIndex: number, point: { x: number; y: number }) => void
  onLink: (url: string) => void
}) {
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const linkLayerRef = useRef<HTMLDivElement>(null)
  const queuedRender = useRef<QueuedPdfRender>()
  const priorityRef = useRef(priority)
  priorityRef.current = priority
  const [drawing, setDrawing] = useState<Array<{ x: number; y: number }> | null>(null)
  const [rasterized, setRasterized] = useState<{ document: PDFDocumentProxy; page: PDFPageProxy; scale: number }>()
  const textReady = useRef<{ document: PDFDocumentProxy; scale: number }>()
  const width = size.width * scale
  const height = size.height * scale

  useEffect(() => {
    if (missing) return
    let cancelled = false
    const controller = new AbortController()
    let renderTask: RenderTask | undefined
    let continuationTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      const queued = pdfRenderQueue.enqueue(async () => {
        if (cancelled) return
        const page = await document.getPage(index + 1)
        if (cancelled || !canvasHostRef.current || !textLayerRef.current) return
        const viewport = page.getViewport({ scale })
        const ratio = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(maxPagePixels / (viewport.width * viewport.height)))
        // Render into a new canvas so a rescaled page keeps showing its stretched image instead of going
        // blank, then swap it in: copying it into the old canvas would hold two bitmaps per page.
        let canvas: HTMLCanvasElement | undefined
        try { canvas = await rasterPdfPage(paperId, attachmentId, index, scale, ratio, paperTone, revision, controller.signal) }
        catch (error) { if (cancelled) return; console.warn('Using browser PDF raster fallback', error) }
        const nativeRaster = Boolean(canvas)
        canvas ??= window.document.createElement('canvas')
        if (!nativeRaster) {
          const target = canvas
          // The bitmap queue runs two pages at once for the workers; drawing here stays one page at a time.
          const drawn = await pdfBrowserRaster.run(async () => {
            if (cancelled) return false
            target.width = Math.floor(viewport.width * ratio)
            target.height = Math.floor(viewport.height * ratio)
            renderTask = page.render({ canvas: target, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
            // PDF.js already splits the operator list into chunks. Yield an input turn before its
            // next animation frame, rather than letting several pages consume the same frame.
            renderTask.onContinue = (resume: () => void) => {
              continuationTimer = setTimeout(() => { if (!cancelled) resume() }, 0)
            }
            try {
              await renderTask.promise
              return true
            } catch {
              return false
            }
          })
          if (!drawn) {
            releaseCanvas(canvas)
            return
          }
        }
        const host = canvasHostRef.current
        if (cancelled || !host || !textLayerRef.current) {
          releaseCanvas(canvas)
          return
        }
        // Tint the bitmap once instead of blending a multiply layer over the page on every frame.
        if (paperTone && !nativeRaster) {
          const context = canvas.getContext('2d')
          if (context) {
            context.globalCompositeOperation = 'multiply'
            context.fillStyle = paperToneColor
            context.fillRect(0, 0, canvas.width, canvas.height)
          }
        }
        const previous = Array.from(host.children) as HTMLCanvasElement[]
        host.replaceChildren(canvas)
        previous.forEach(releaseCanvas)
        // Re-tinting reuses the same page and scale; keep the state so links are not rebuilt.
        setRasterized((current) => (current?.document === document && current.page === page && current.scale === scale ? current : { document, page, scale }))
      }, priorityRef.current)
      queuedRender.current = queued
      void queued.promise.catch((reason: unknown) => {
        if (!cancelled) console.error('Unable to render PDF page', index + 1, reason)
      })
    }, 30)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
      clearTimeout(continuationTimer)
      queuedRender.current?.cancel()
      queuedRender.current = undefined
      renderTask?.cancel()
    }
  }, [scale, document, index, missing, paperTone])

  useEffect(() => queuedRender.current?.setPriority(priority), [priority])

  // Keep scroll input ahead of accessibility/text work. Finished layers remain selectable;
  // unfinished layers yield/cancel immediately and resume when the visible page is at rest.
  useEffect(() => {
    if (!interactive || missing || priority !== 0 || rasterized?.document !== document || rasterized.scale !== scale ||
      (textReady.current?.document === document && textReady.current.scale === scale)) return
    const page = rasterized.page, viewport = page.getViewport({ scale })
    let cancelled = false
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined
    const layout = pdfTextQueue.enqueue(async () => {
      if (cancelled || !textLayerRef.current) return
      textReady.current = undefined
      // Standard text is staged off-DOM; dense SVG text commits in small independent batches.
      const container = textLayerRef.current.cloneNode(false) as HTMLDivElement
      container.removeAttribute('aria-busy')
      container.style.setProperty('--total-scale-factor', String(scale))
      const textContent = await page.getTextContent()
      if (cancelled) return
      const dense = await renderDensePdfText(textContent, viewport, container, () => cancelled, textLayerRef.current)
      if (!dense) {
        textLayer = new pdfjs.TextLayer({ textContentSource: chunkTextContent(textContent, () => cancelled), container, viewport })
        try { await textLayer.render() } catch { return }
      }
      const liveContainer = textLayerRef.current
      if (cancelled || !liveContainer) return
      if (!dense) {
        for (const attribute of Array.from(container.attributes)) liveContainer.setAttribute(attribute.name, attribute.value)
        const textFragment = window.document.createDocumentFragment()
        while (container.firstChild) textFragment.appendChild(container.firstChild)
        liveContainer.replaceChildren(textFragment)
      }
      textReady.current = { document, scale }
      onRendered()
    }, 0)
    void layout.promise.catch((reason: unknown) => {
      if (!cancelled) console.error('Unable to lay out PDF text', index + 1, reason)
    })
    return () => {
      cancelled = true
      layout.cancel()
      textLayer?.cancel()
    }
  }, [rasterized, priority, interactive, scale, document, missing])

  useEffect(() => {
    if (missing || rasterized?.document !== document || rasterized.scale !== scale) return
    let cancelled = false
    const viewport = rasterized.page.getViewport({ scale })
    void (async () => {
      // Links become clickable areas; the reader decides where they go.
      const linkLayer = linkLayerRef.current
      if (linkLayer) {
        const links = await rasterized.page.getAnnotations()
        if (cancelled) return
        linkLayer.replaceChildren()
        const fragment = window.document.createDocumentFragment()
        for (const annotation of links) {
          const target = (annotation as { url?: string }).url
          if (annotation.subtype !== 'Link' || !target) continue
          const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]) as [number, number]
          const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]) as [number, number]
          const anchor = window.document.createElement('a')
          anchor.className = 'pdf-link'
          anchor.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`
          anchor.title = target
          anchor.addEventListener('click', (event) => {
            event.preventDefault()
            onLink(target)
          })
          fragment.appendChild(anchor)
        }
        linkLayer.appendChild(fragment)
      }
    })().catch((reason: unknown) => { if (!cancelled) console.error('Unable to load PDF links', reason) })
    return () => { cancelled = true }
  }, [rasterized, document, scale, missing])

  // Free the bitmap as soon as the page leaves the render window; Intel Macs share it with system memory.
  useEffect(() => {
    if (missing) return
    const host = canvasHostRef.current
    return () => {
      if (host) (Array.from(host.children) as HTMLCanvasElement[]).forEach(releaseCanvas)
    }
  }, [missing])

  const normalized = (event: React.PointerEvent): { x: number; y: number } => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }

  const mode = tool?.mode ?? 'browse'
  return (
    <div className={`pdf-page ${missing ? 'missing' : ''}`} data-page-index={index} style={{ top, left, width, height }}>
      {!missing && (
        <>
          <div ref={canvasHostRef} className="pdf-page-canvas" />
          {createPortal(<div className="pdf-text-page" data-page-index={index} style={{ top, left, width, height }}><div ref={textLayerRef} className="textLayer" /></div>, textRoot)}
          <div ref={linkLayerRef} className="pdf-link-layer" />
        </>
      )}
      {missing && <div className="pdf-page-missing" />}
      <svg
        className={`annotation-layer mode-${mode}`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onPointerDown={(event) => {
          if (mode === 'ink') {
            ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
            setDrawing([normalized(event)])
          } else if (mode === 'textNote') onPlaceNote(index, normalized(event))
        }}
        onPointerMove={(event) => {
          if (drawing) setDrawing([...drawing, normalized(event)])
        }}
        onPointerUp={() => {
          if (drawing && drawing.length > 1) onCommitInk(index, drawing)
          setDrawing(null)
        }}
      >
        {annotations.map((annotation) => (
          <g key={annotation.id} className="annotation" onClick={() => mode === 'erase' && onErase(annotation.id)}>
            {annotation.type === 'highlight' && annotation.rects?.map((rect, rectIndex) => (
              <rect key={rectIndex} x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={annotation.color} className="annotation-highlight" />
            ))}
            {(annotation.type === 'underline' || annotation.type === 'strikeOut') && annotation.rects?.map((rect, rectIndex) => {
              const y = annotation.type === 'underline' ? rect.y + rect.height * 0.95 : rect.y + rect.height / 2
              return <line key={rectIndex} x1={rect.x} x2={rect.x + rect.width} y1={y} y2={y} stroke={annotation.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            })}
            {annotation.type === 'ink' && annotation.paths?.map((path, pathIndex) => (
              <polyline key={pathIndex} points={path.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={annotation.color} strokeWidth={annotation.lineWidth ?? 2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {annotation.type === 'text' && annotation.rects?.[0] && (
              <foreignObject x={annotation.rects[0].x} y={annotation.rects[0].y} width={0.001} height={0.001} overflow="visible">
                <div className="annotation-note" style={{ background: annotation.color }} title={annotation.contents}>✎</div>
              </foreignObject>
            )}
          </g>
        ))}
        {drawing && (
          <polyline points={drawing.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={tool?.color} strokeWidth={tool?.lineWidth ?? 2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </div>
  )
})

/** Joins the per-span rectangles of one text line into one rectangle. */
function mergeLineRects(rects: Array<{ x: number; y: number; width: number; height: number }>): Array<{ x: number; y: number; width: number; height: number }> {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Array<{ x: number; y: number; width: number; height: number }> = []
  for (const rect of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y + candidate.height / 2 - (rect.y + rect.height / 2)) < Math.max(candidate.height, rect.height) * 0.5)
    if (!line) lines.push({ ...rect })
    else {
      const right = Math.max(line.x + line.width, rect.x + rect.width)
      const bottom = Math.max(line.y + line.height, rect.y + rect.height)
      line.x = Math.min(line.x, rect.x)
      line.y = Math.min(line.y, rect.y)
      line.width = right - line.x
      line.height = bottom - line.y
    }
  }
  return lines
}

/** A DOM range over the concatenated text nodes of `root`. */
export function rangeForOffsets(root: Node, start: number, end: number): Range | null {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode: Text | null = null
  let startOffset = 0
  let node = walker.nextNode() as Text | null
  while (node) {
    const length = node.data.length
    if (!startNode && start < offset + length) {
      startNode = node
      startOffset = start - offset
    }
    if (startNode && end <= offset + length) {
      const range = root.ownerDocument!.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
    node = walker.nextNode() as Text | null
  }
  return null
}

const injectedHighlightStyles = new WeakMap<Document | ShadowRoot, Set<string>>()

function ensureHighlightStyle(attachmentId: string, root: Document | ShadowRoot = window.document): void {
  let ids = injectedHighlightStyles.get(root)
  if (!ids) { ids = new Set(); injectedHighlightStyles.set(root, ids) }
  if (ids.has(attachmentId)) return
  ids.add(attachmentId)
  const style = window.document.createElement('style')
  style.textContent = `::highlight(rp-find-${attachmentId}) { background-color: rgba(255, 214, 10, 0.45); color: inherit; }
::highlight(rp-find-current-${attachmentId}) { background-color: rgba(255, 149, 0, 0.75); color: inherit; }
::highlight(rp-held-selection-${attachmentId}) { background-color: rgba(0, 122, 255, 0.28); color: transparent; }`
  ;(root.nodeType === 9 ? window.document.head : root).appendChild(style)
}
