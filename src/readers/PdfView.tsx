import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { Note, NoteSelectionContext, PdfAnnotation } from '../../shared/types'
import { openDocument, pageTexts, pdfjs } from './pdfjs'
import { buildMatcher, type FindRequest, type FindStatus } from './find'
import { SidenoteRail } from './SidenoteRail'

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
const sideMargin = 8
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
  navigation?: { id: string; pageIndex?: number; quote?: string } | null
  onSelection?: (selection: NoteSelectionContext | null) => void
  tool?: AnnotationTool
  onAnnotationState?: (state: AnnotationState) => void
  onRequestTextNote?: (pageIndex: number, point: { x: number; y: number }) => void
  sidenotes?: Note[]
  focusNoteId?: string | null
  onSidenoteFocusHandled?: () => void
  onUserScroll?: () => void
  onLinkActivated?: (url: string) => void
  label?: ReactNode
  /** The last page a partial translation covers; later pages are shown as missing. */
  maxPage?: number
}

export const PdfView = forwardRef<PdfViewHandle, PdfViewProps>(function PdfView(props, ref) {
  const { url, attachmentId, paperId, appearance, onPageChange } = props
  const scroller = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [containerWidth, setContainerWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [visible, setVisible] = useState<[number, number]>([0, 2])
  const [error, setError] = useState<string>()
  const currentPage = useRef(props.pageIndex)
  const restoredFor = useRef<string>()
  const programmatic = useRef(0)
  const texts = useRef<string[]>()
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const history = useRef<{ undo: PdfAnnotation[][]; redo: PdfAnnotation[][] }>({ undo: [], redo: [] })
  const [renderedPages, setRenderedPages] = useState(0)

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
      for (let index = 1; index <= loaded.numPages; index += 1) {
        const viewport = (await loaded.getPage(index)).getViewport({ scale: 1 })
        loadedSizes.push({ width: viewport.width, height: viewport.height })
      }
      if (!cancelled) {
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
    void window.freddie.annotations.list(paperId, attachmentId).then((list) => {
      if (!cancelled) setAnnotations(list)
    })
    return () => {
      cancelled = true
    }
  }, [paperId, attachmentId])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth))
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const showsRail = Boolean(props.sidenotes?.length) && containerWidth >= railWidth + minimumReaderWidth
  const readerWidth = containerWidth - (showsRail ? railWidth : 0)
  const maxPageWidth = Math.max(1, ...sizes.map((size) => size.width))
  const scale = Math.max(0.2, ((readerWidth - sideMargin * 2) / maxPageWidth) * zoom)

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

  const pageAt = useCallback((offset: number): number => {
    let low = 0
    let high = sizes.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (tops[mid] <= offset) low = mid
      else high = mid - 1
    }
    return Math.max(0, low)
  }, [sizes.length, tops])

  const scrollToPage = useCallback((pageIndex: number, fraction = 0) => {
    const element = scroller.current
    if (!element || !sizes.length) return
    const index = Math.min(Math.max(pageIndex, 0), sizes.length - 1)
    programmatic.current += 1
    element.scrollTop = tops[index] + sizes[index].height * scale * fraction - (fraction === 0 ? pageGap : element.clientHeight / 2)
    requestAnimationFrame(() => {
      programmatic.current = Math.max(0, programmatic.current - 1)
    })
  }, [sizes, tops, scale])

  const updateVisible = useCallback(() => {
    const element = scroller.current
    if (!element || !sizes.length) return
    const first = pageAt(element.scrollTop - element.clientHeight)
    const last = pageAt(element.scrollTop + element.clientHeight * 2)
    setVisible((current) => (current[0] === first && current[1] === last ? current : [first, last]))
    const center = pageAt(element.scrollTop + element.clientHeight / 3)
    if (center !== currentPage.current) {
      currentPage.current = center
      onPageChange(center)
    }
  }, [pageAt, sizes.length, onPageChange])

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
    }
  }, [props.pageIndex, sizes.length, containerWidth, url])

  // Keep the same place on the page when the scale changes.
  const lastScale = useRef(scale)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || lastScale.current === scale || !sizes.length) {
      lastScale.current = scale
      return
    }
    const ratio = scale / lastScale.current
    lastScale.current = scale
    programmatic.current += 1
    element.scrollTop = element.scrollTop * ratio
    requestAnimationFrame(() => {
      programmatic.current = Math.max(0, programmatic.current - 1)
    })
    updateVisible()
  }, [scale])

  useEffect(() => {
    updateVisible()
  }, [tops])

  const onScroll = (): void => {
    updateVisible()
    if (programmatic.current === 0) props.onUserScroll?.()
  }

  // Zoom with pinch or Command/Control and the wheel.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom((value) => Math.min(4, Math.max(0.5, value * Math.exp(-event.deltaY / 300))))
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
    if (!element || !registry) return
    const all: Range[] = []
    const current: Range[] = []
    matches.forEach((match, index) => {
      const layer = element.querySelector<HTMLElement>(`[data-page-index="${match.page}"] .textLayer`)
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
    ensureHighlightStyle(attachmentId)
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
    scrollToPage(navigation.pageIndex)
    if (navigation.quote) setTargetHighlight({ page: navigation.pageIndex, quote: navigation.quote })
    const timer = setTimeout(() => setTargetHighlight(null), 4000)
    return () => clearTimeout(timer)
  }, [props.navigation?.id, sizes.length])

  useEffect(() => {
    const element = scroller.current
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    if (!element || !registry || !targetHighlight) return
    const layer = element.querySelector<HTMLElement>(`[data-page-index="${targetHighlight.page}"] .textLayer`)
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
    if (!element || !props.onSelection) return
    const report = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        props.onSelection?.(null)
        props.onAnnotationState?.({ ...annotationState(), hasTextSelection: false })
        return
      }
      const range = selection.getRangeAt(0)
      const pageElement = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[data-page-index]')
        ?? (range.startContainer.parentElement?.closest<HTMLElement>('[data-page-index]'))
      if (!pageElement || !element.contains(pageElement)) return
      const quote = selection.toString().replace(/\s+/g, ' ').trim()
      if (!quote) return
      const pageIndex = Number(pageElement.dataset.pageIndex)
      const pageText = texts.current?.[pageIndex] ?? pageElement.querySelector('.textLayer')?.textContent ?? ''
      const at = pageText.indexOf(quote.slice(0, 40))
      const context = at >= 0 ? pageText.slice(Math.max(0, at - 600), at + quote.length + 600) : pageText.slice(0, 1600)
      const rect = range.getBoundingClientRect()
      props.onSelection?.({ attachmentId, quote, pageIndex, context, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
      props.onAnnotationState?.({ ...annotationState(), hasTextSelection: true })
    }
    const mouseUp = (): void => {
      setTimeout(report, 0)
    }
    const selectionChange = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) report()
    }
    element.addEventListener('mouseup', mouseUp)
    element.addEventListener('keyup', mouseUp)
    window.document.addEventListener('selectionchange', selectionChange)
    return () => {
      element.removeEventListener('mouseup', mouseUp)
      element.removeEventListener('keyup', mouseUp)
      window.document.removeEventListener('selectionchange', selectionChange)
    }
  }, [attachmentId, props.onSelection])

  // MARK: Annotations

  const annotationState = (): Omit<AnnotationState, 'hasTextSelection'> => ({
    canUndo: history.current.undo.length > 0,
    canRedo: history.current.redo.length > 0
  })

  const commitAnnotations = useCallback((next: PdfAnnotation[]) => {
    setAnnotations((previous) => {
      history.current.undo.push(previous)
      history.current.redo = []
      void window.freddie.annotations.save(paperId, attachmentId, next)
      return next
    })
    requestAnimationFrame(() => props.onAnnotationState?.({ ...annotationState(), hasTextSelection: Boolean(window.getSelection()?.toString()) }))
  }, [paperId, attachmentId])

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
    applyMarkup: (type) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !scroller.current) return false
      const range = selection.getRangeAt(0)
      const byPage = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>()
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue
        const pageElement = window.document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          .map((node) => node.closest<HTMLElement>('[data-page-index]'))
          .find((node): node is HTMLElement => Boolean(node && scroller.current?.contains(node)))
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
      const created: PdfAnnotation[] = [...byPage.entries()].map(([pageIndex, rects]) => ({
        id: crypto.randomUUID(),
        attachmentId,
        pageIndex,
        type,
        color: props.tool?.color ?? '#ffd60a',
        rects: mergeLineRects(rects),
        createdAt: new Date().toISOString()
      }))
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
      void window.freddie.annotations.save(paperId, attachmentId, previous)
      props.onAnnotationState?.({ ...annotationState(), hasTextSelection: false })
    },
    redo: () => {
      const next = history.current.redo.pop()
      if (!next) return
      history.current.undo.push(annotations)
      setAnnotations(next)
      void window.freddie.annotations.save(paperId, attachmentId, next)
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
  }), [sizes, tops, scale, pageAt, scrollToPage, updateVisible, annotations, commitAnnotations, attachmentId, props.tool?.color])

  const pageCount = sizes.length
  const totalHeight = tops[pageCount] ?? 0

  return (
    <div className={`pdf-view appearance-${appearance}`}>
      <div ref={scroller} className="pdf-scroller" onScroll={onScroll}>
        {error && <div className="pdf-error">{error}</div>}
        <div className="pdf-canvas-area" style={{ height: totalHeight, width: showsRail ? readerWidth : '100%' }}>
          {document && sizes.map((size, index) => {
            const isVisible = index >= visible[0] && index <= visible[1]
            return (
              <PdfPage
                key={index}
                document={document}
                index={index}
                size={size}
                scale={scale}
                top={tops[index]}
                left={Math.max(sideMargin, (readerWidth - size.width * scale) / 2)}
                visible={isVisible}
                missing={props.maxPage !== undefined && index >= props.maxPage}
                annotations={annotations.filter((annotation) => annotation.pageIndex === index)}
                tool={props.tool}
                onRendered={() => setRenderedPages((value) => value + 1)}
                onCommitInk={(path) => commitAnnotations([...annotations, {
                  id: crypto.randomUUID(), attachmentId, pageIndex: index, type: 'ink', color: props.tool?.color ?? '#ff3b30', lineWidth: props.tool?.lineWidth ?? 2, paths: [path], createdAt: new Date().toISOString()
                }])}
                onErase={(id) => commitAnnotations(annotations.filter((annotation) => annotation.id !== id))}
                onPlaceNote={(point) => props.onRequestTextNote?.(index, point)}
                onLink={props.onLinkActivated}
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

const PdfPage = memo(function PdfPage({ document, index, size, scale, top, left, visible, missing, annotations, tool, onRendered, onCommitInk, onErase, onPlaceNote, onLink }: {
  document: PDFDocumentProxy
  index: number
  size: PageSize
  scale: number
  top: number
  left: number
  visible: boolean
  missing: boolean
  annotations: PdfAnnotation[]
  tool?: AnnotationTool
  onRendered: () => void
  onCommitInk: (path: Array<{ x: number; y: number }>) => void
  onErase: (id: string) => void
  onPlaceNote: (point: { x: number; y: number }) => void
  onLink?: (url: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const linkLayerRef = useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = useState<Array<{ x: number; y: number }> | null>(null)
  const width = size.width * scale
  const height = size.height * scale

  useEffect(() => {
    if (!visible || missing) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined
    const timer = setTimeout(async () => {
      const page = await document.getPage(index + 1)
      if (cancelled || !canvasRef.current || !textLayerRef.current) return
      const viewport = page.getViewport({ scale })
      const ratio = Math.min(window.devicePixelRatio || 1, 3)
      const canvas = canvasRef.current
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      renderTask = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      try {
        await renderTask.promise
      } catch {
        return
      }
      if (cancelled) return
      const container = textLayerRef.current
      container.replaceChildren()
      container.style.setProperty('--total-scale-factor', String(scale))
      textLayer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container, viewport })
      await textLayer.render().catch(() => undefined)
      if (cancelled) return
      // Links become clickable areas; the reader decides where they go.
      const linkLayer = linkLayerRef.current
      if (linkLayer) {
        linkLayer.replaceChildren()
        for (const annotation of await page.getAnnotations()) {
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
            onLink?.(target)
          })
          linkLayer.appendChild(anchor)
        }
      }
      onRendered()
    }, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [visible, scale, document, index, missing])

  const normalized = (event: React.PointerEvent): { x: number; y: number } => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }

  const mode = tool?.mode ?? 'browse'
  return (
    <div className={`pdf-page ${missing ? 'missing' : ''}`} data-page-index={index} style={{ top, left, width, height }}>
      {visible && !missing && (
        <>
          <canvas ref={canvasRef} className="pdf-page-canvas" style={{ width, height }} />
          <div className="paper-tone-overlay" />
          <div ref={textLayerRef} className="textLayer" />
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
          } else if (mode === 'textNote') onPlaceNote(normalized(event))
        }}
        onPointerMove={(event) => {
          if (drawing) setDrawing([...drawing, normalized(event)])
        }}
        onPointerUp={() => {
          if (drawing && drawing.length > 1) onCommitInk(drawing)
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

const injectedHighlightStyles = new Set<string>()

function ensureHighlightStyle(attachmentId: string): void {
  if (injectedHighlightStyles.has(attachmentId)) return
  injectedHighlightStyles.add(attachmentId)
  const style = window.document.createElement('style')
  style.textContent = `::highlight(rp-find-${attachmentId}) { background-color: rgba(255, 214, 10, 0.45); color: inherit; }
::highlight(rp-find-current-${attachmentId}) { background-color: rgba(255, 149, 0, 0.75); color: inherit; }`
  window.document.head.appendChild(style)
}
