import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Note, NoteSelectionContext, TranslationDisplayMode } from '../../shared/types'
import { buildMatcher, type FindRequest, type FindStatus } from './find'
import { readerCSS } from './htmlReaderCSS'
import { elementPath, resolveElementPath } from './htmlAnchors'
import { observeHtmlOutline, visibleHeadingTarget } from './htmlOutline'
import type { DocumentOutlineEntry } from '../../shared/outline'
export { elementPath, resolveElementPath } from './htmlAnchors'

export interface HtmlViewHandle {
  scrollRatio(): number
}

export interface RegionEditState {
  hiddenCount: number
  canUndo: boolean
  canRedo: boolean
}

const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, blockquote, td, th, dd, dt, pre, figure, table, img'
const regionSelector = 'p, li, ul, ol, h1, h2, h3, h4, h5, h6, figure, figcaption, blockquote, pre, table, img, video, math, section, aside, div.ltx_para, div.ltx_figure, nav, footer, header'

export const HtmlView = forwardRef<HtmlViewHandle, {
  paperId: string
  attachmentId: string
  reloadToken: number
  displayMode: TranslationDisplayMode
  appearance: 'default' | 'paper'
  fontSize: number
  initialScrollRatio: number
  onScrollRatio: (ratio: number) => void
  segmentUpdate?: { segmentId: string; translatedHTML: string; sequence: number } | null
  find?: FindRequest | null
  onFindStatus?: (status: FindStatus) => void
  navigation?: { id: string; htmlSelector?: string; quote?: string; outline?: boolean } | null
  onOutline?: (entries: DocumentOutlineEntry[], currentID?: string) => void
  onSelection?: (selection: NoteSelectionContext | null) => void
  sidenotes: Note[]
  renderSidenotes: (positions: Array<{ note: Note; top: number }>, layout: { left: number; width: number; scrollTop: number } | null) => JSX.Element | null
  regionEditing: boolean
  onRegionEditingExit?: () => void
  regionCommand?: { action: 'undo' | 'redo' | 'restoreAll'; token: number } | null
  onRegionState?: (state: RegionEditState) => void
  onLinkActivated: (url: string) => void
}>(function HtmlView(props, ref) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [source, setSource] = useState<string>()
  const [loadedToken, setLoadedToken] = useState(0)
  const restoredRatio = useRef(props.initialScrollRatio)
  const [scrollTop, setScrollTop] = useState(0)
  const [layout, setLayout] = useState<{ left: number; width: number } | null>(null)
  const [positions, setPositions] = useState<Array<{ note: Note; top: number }>>([])
  const regionHistory = useRef<{ undo: string[][]; redo: string[][] }>({ undo: [], redo: [] })

  const documentOf = useCallback((): Document | undefined => frame.current?.contentDocument ?? undefined, [])

  useEffect(() => {
    let cancelled = false
    void window.freddie.library.readHTML(props.paperId, props.attachmentId).then((html) => {
      if (cancelled) return
      setSource(prepareDocument(html, window.freddie.shell.paperBaseURL(props.paperId)))
    })
    return () => {
      cancelled = true
    }
  }, [props.paperId, props.attachmentId, props.reloadToken])

  useEffect(() => {
    restoredRatio.current = props.initialScrollRatio
  }, [props.paperId])

  useImperativeHandle(ref, () => ({
    scrollRatio: () => {
      const document = documentOf()
      const scroller = document?.scrollingElement
      if (!scroller) return 0
      return scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    }
  }))

  const applyStyles = useCallback(() => {
    const document = documentOf()
    if (!document?.documentElement) return
    document.documentElement.setAttribute('data-rp-display-mode', props.displayMode)
    document.documentElement.setAttribute('data-rp-reader-appearance', props.appearance)
    document.documentElement.toggleAttribute('data-rp-region-editing', props.regionEditing)
    let style = document.getElementById('rp-reader-dynamic-style')
    if (!style) {
      style = document.createElement('style')
      style.id = 'rp-reader-dynamic-style'
      style.setAttribute('data-rp-reader', 'true')
      document.head.appendChild(style)
    }
    const reserve = props.sidenotes.length > 0 ? 'html[data-rp-has-sidenotes] body.rp-readability-body { padding-right: 312px !important; } html[data-rp-has-sidenotes] body:not(.rp-readability-body) { margin-right: 312px !important; }' : ''
    style.textContent = readerCSS(props.fontSize, props.appearance) + reserve
    const wideEnough = (document.defaultView?.innerWidth ?? 0) >= 720
    document.documentElement.toggleAttribute('data-rp-has-sidenotes', props.sidenotes.length > 0 && wideEnough)
  }, [props.displayMode, props.appearance, props.fontSize, props.sidenotes.length, props.regionEditing, documentOf])

  useEffect(applyStyles, [applyStyles, loadedToken])

  const updateSidenotes = useCallback(() => {
    const document = documentOf()
    const view = frame.current
    if (!document?.body || !view) return
    const width = view.clientWidth
    const wide = width >= 720
    const next: Array<{ note: Note; top: number }> = []
    for (const note of props.sidenotes) {
      const element = note.htmlSelector ? resolveElementPath(document, note.htmlSelector) : undefined
      if (!element) continue
      const rect = element.getBoundingClientRect()
      next.push({ note, top: rect.top + (document.scrollingElement?.scrollTop ?? 0) })
    }
    setPositions(next)
    setLayout(wide && next.length ? { left: width - 300, width: 280 } : null)
  }, [props.sidenotes, documentOf])

  // The frame's resize listener lives for the document, while display mode and
  // typography may change. Pinning Contents also resizes it; always use current styles.
  const layoutCallbacks = useRef({ applyStyles, updateSidenotes })
  layoutCallbacks.current = { applyStyles, updateSidenotes }

  // Wire the loaded page: scrolling, selection, links, region editing.
  const onLoad = (): void => {
    const document = documentOf()
    const window_ = frame.current?.contentWindow
    if (!document || !window_) return
    applyStyles()
    const scroller = document.scrollingElement as HTMLElement
    const restore = (): void => {
      scroller.scrollTop = restoredRatio.current * Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    }
    restore()
    // Images may change the height after the first layout.
    setTimeout(restore, 120)
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    window_.addEventListener('scroll', () => {
      setScrollTop(scroller.scrollTop)
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight)
        restoredRatio.current = ratio
        props.onScrollRatio(ratio)
      }, 200)
    }, { passive: true })
    window_.addEventListener('resize', () => {
      layoutCallbacks.current.applyStyles()
      layoutCallbacks.current.updateSidenotes()
    })
    document.addEventListener('click', (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      event.preventDefault()
      if (href.startsWith('#')) {
        document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' })
        return
      }
      if (/^https?:/i.test(anchor.href)) props.onLinkActivated(anchor.href)
    })
    document.addEventListener('mouseup', () => setTimeout(reportSelection, 0))
    document.addEventListener('keyup', () => setTimeout(reportSelection, 0))
    document.addEventListener('selectionchange', () => {
      if (document.getSelection()?.isCollapsed) props.onSelection?.(null)
    })
    // Drag events do not bubble out of an iframe. Forward file drags to the iframe element so
    // the window-wide PDF drop target can show its hover treatment and handle the drop.
    const forwardFileDrag = (event: globalThis.DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      if (event.type === 'dragleave' && event.relatedTarget != null) return
      const host = frame.current
      if (!host) return
      const forwarded = new DragEvent(event.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: event.dataTransfer,
        relatedTarget: event.relatedTarget
      })
      if (!host.dispatchEvent(forwarded)) event.preventDefault()
    }
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'] as const) {
      document.addEventListener(type, forwardFileDrag)
    }
    document.addEventListener('mouseover', (event) => {
      if (!document.documentElement.hasAttribute('data-rp-region-editing')) return
      document.querySelectorAll('.rp-region-hover').forEach((element) => element.classList.remove('rp-region-hover'))
      ;(event.target as Element | null)?.closest?.(regionSelector)?.classList.add('rp-region-hover')
    })
    document.addEventListener('keydown', (event) => {
      if (!document.documentElement.hasAttribute('data-rp-region-editing')) return
      if (event.key === 'Escape') props.onRegionEditingExit?.()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        setRegionCommandFromKeyboard(event.shiftKey ? 'redo' : 'undo')
      }
    })
    document.addEventListener('click', (event) => {
      if (!document.documentElement.hasAttribute('data-rp-region-editing')) return
      const target = (event.target as Element | null)?.closest?.(regionSelector)
      if (!target || target === document.body) return
      event.preventDefault()
      event.stopPropagation()
      toggleRegion(target)
    }, true)
    updateSidenotes()
    setLoadedToken((value) => value + 1)
    reportRegionState()
  }

  const reportSelection = (): void => {
    const document = documentOf()
    const selection = document?.getSelection()
    if (!document || !selection || selection.isCollapsed || !selection.rangeCount) return
    const quote = selection.toString().replace(/\s+/g, ' ').trim()
    if (!quote) return
    const range = selection.getRangeAt(0)
    const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const block = startElement?.closest(blockSelector) ?? startElement
    if (!block) return
    const sourceBlock = block.classList.contains('rp-translation-block')
      ? document.querySelector(`[data-rp-segment-id="${block.getAttribute('data-rp-source-segment-id')}"]`) ?? block
      : block
    const context = [sourceBlock.previousElementSibling?.textContent, sourceBlock.textContent, sourceBlock.nextElementSibling?.textContent]
      .filter(Boolean).join('\n').replace(/[ \t]+/g, ' ').slice(0, 4000)
    const frameRect = frame.current!.getBoundingClientRect()
    const rect = range.getBoundingClientRect()
    props.onSelection?.({
      attachmentId: props.attachmentId,
      quote,
      htmlSelector: elementPath(sourceBlock),
      context,
      rect: { x: frameRect.left + rect.left, y: frameRect.top + rect.top, width: rect.width, height: rect.height }
    })
  }

  // MARK: Live translation segments

  useEffect(() => {
    const update = props.segmentUpdate
    const document = documentOf()
    if (!update || !document) return
    const sourceElement = document.querySelector(`[data-rp-segment-id="${update.segmentId}"]`)
    if (!sourceElement) return
    document.querySelectorAll(`.rp-translation-block[data-rp-source-segment-id="${update.segmentId}"]`).forEach((element) => element.remove())
    const template = document.createElement('template')
    template.innerHTML = update.translatedHTML
    const block = template.content.firstElementChild
    if (block) sourceElement.after(block)
    updateSidenotes()
  }, [props.segmentUpdate?.sequence])

  useEffect(updateSidenotes, [props.sidenotes, loadedToken, props.displayMode, props.fontSize])

  // MARK: Find

  const lastFindToken = useRef(0)
  const [matchRanges, setMatchRanges] = useState<Range[]>([])
  const [currentMatch, setCurrentMatch] = useState(-1)
  const findKey = props.find ? `${props.find.query}|${props.find.options.matchCase}|${props.find.options.wholeWords}|${props.displayMode}` : ''

  useEffect(() => {
    const document = documentOf()
    if (!props.find || !document?.body) {
      setMatchRanges([])
      setCurrentMatch(-1)
      return
    }
    const matcher = buildMatcher(props.find.query, props.find.options)
    const ranges: Range[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement
        if (!parent || parent.closest('style, script, [data-rp-hidden="true"]')) return NodeFilter.FILTER_REJECT
        const mode = document.documentElement.getAttribute('data-rp-display-mode')
        if (mode === 'original' && parent.closest('.rp-translation-block')) return NodeFilter.FILTER_REJECT
        if (mode === 'translated' && parent.closest('[data-rp-source="true"]')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    // Search block by block so a match may span inline elements.
    const blocks = new Map<Element, Text[]>()
    let node = walker.nextNode() as Text | null
    while (node) {
      const block = node.parentElement!.closest(blockSelector) ?? node.parentElement!
      blocks.set(block, [...(blocks.get(block) ?? []), node])
      node = walker.nextNode() as Text | null
    }
    for (const nodes of blocks.values()) {
      const text = nodes.map((textNode) => textNode.data).join('')
      for (const match of text.matchAll(matcher)) {
        const range = rangeOverNodes(nodes, match.index ?? 0, (match.index ?? 0) + match[0].length)
        if (range) ranges.push(range)
      }
    }
    setMatchRanges(ranges)
    const first = ranges.findIndex((range) => range.getBoundingClientRect().top >= 0)
    const index = ranges.length ? Math.max(0, first) : -1
    setCurrentMatch(index)
    lastFindToken.current = props.find.navigationToken
    props.onFindStatus?.({ query: props.find.query, options: props.find.options, isSearching: false, matchCount: ranges.length, currentIndex: index >= 0 ? index : undefined })
  }, [findKey, loadedToken])

  useEffect(() => {
    if (!props.find || props.find.navigationToken === lastFindToken.current || !matchRanges.length) return
    lastFindToken.current = props.find.navigationToken
    const next = (currentMatch + (props.find.direction === 'backward' ? -1 : 1) + matchRanges.length) % matchRanges.length
    setCurrentMatch(next)
    props.onFindStatus?.({ query: props.find.query, options: props.find.options, isSearching: false, matchCount: matchRanges.length, currentIndex: next })
  }, [props.find?.navigationToken])

  useEffect(() => {
    const window_ = frame.current?.contentWindow as (Window & { CSS: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown }) | null
    const registry = window_?.CSS?.highlights
    if (!window_ || !registry || !window_.Highlight) return
    registry.set('rp-find', new window_.Highlight(...matchRanges.filter((_, index) => index !== currentMatch)))
    registry.set('rp-find-current', new window_.Highlight(...(currentMatch >= 0 && matchRanges[currentMatch] ? [matchRanges[currentMatch]] : [])))
    const current = matchRanges[currentMatch]
    if (current) {
      const rect = current.getBoundingClientRect()
      const height = window_.innerHeight
      if (rect.top < 40 || rect.bottom > height - 40) window_.scrollBy({ top: rect.top - height / 3 })
    }
    return () => {
      registry.delete('rp-find')
      registry.delete('rp-find-current')
    }
  }, [matchRanges, currentMatch])

  // Runs in the host renderer; the imported frame remains sandboxed without scripts.
  const outlineCallback = useRef(props.onOutline)
  outlineCallback.current = props.onOutline
  useEffect(() => {
    const document = documentOf()
    if (!loadedToken || !document?.body) return
    return observeHtmlOutline(document, (entries, currentID) => outlineCallback.current?.(entries, currentID))
  }, [loadedToken, documentOf])

  // MARK: Navigation

  useEffect(() => {
    const document = documentOf()
    const navigation = props.navigation
    if (!document || !navigation?.htmlSelector) return
    const element = resolveElementPath(document, navigation.htmlSelector)
    if (!element) return
    const target = navigation.outline ? visibleHeadingTarget(element) ?? element : element
    target.scrollIntoView({ block: navigation.outline ? 'start' : 'center' })
    target.classList.add('rp-note-anchor-target')
    const timer = setTimeout(() => target.classList.remove('rp-note-anchor-target'), 2400)
    return () => clearTimeout(timer)
  }, [props.navigation?.id, loadedToken])

  // MARK: Region editing

  const hiddenPaths = (): string[] => {
    const document = documentOf()
    if (!document) return []
    return Array.from(document.querySelectorAll('[data-rp-hidden="true"]')).map((element) => elementPath(element)).filter((path): path is string => Boolean(path))
  }

  const reportRegionState = (): void => {
    props.onRegionState?.({
      hiddenCount: documentOf()?.querySelectorAll('[data-rp-hidden="true"]').length ?? 0,
      canUndo: regionHistory.current.undo.length > 0,
      canRedo: regionHistory.current.redo.length > 0
    })
  }

  const saveRegions = (): void => {
    void window.freddie.library.saveHiddenRegions(props.paperId, props.attachmentId, hiddenPaths())
  }

  const setHidden = (paths: string[]): void => {
    const document = documentOf()
    if (!document) return
    document.querySelectorAll('[data-rp-hidden="true"]').forEach((element) => element.removeAttribute('data-rp-hidden'))
    for (const path of paths) resolveElementPath(document, path)?.setAttribute('data-rp-hidden', 'true')
  }

  const toggleRegion = (element: Element): void => {
    regionHistory.current.undo.push(hiddenPaths())
    regionHistory.current.redo = []
    if (element.getAttribute('data-rp-hidden') === 'true') element.removeAttribute('data-rp-hidden')
    else element.setAttribute('data-rp-hidden', 'true')
    saveRegions()
    reportRegionState()
  }

  const [keyboardCommand, setKeyboardCommand] = useState<{ action: 'undo' | 'redo'; token: number } | null>(null)
  const setRegionCommandFromKeyboard = (action: 'undo' | 'redo'): void => setKeyboardCommand({ action, token: Date.now() })
  useEffect(() => {
    if (keyboardCommand) runRegionCommand(keyboardCommand.action)
  }, [keyboardCommand?.token])

  useEffect(() => {
    if (props.regionCommand) runRegionCommand(props.regionCommand.action)
  }, [props.regionCommand?.token])

  function runRegionCommand(action: 'undo' | 'redo' | 'restoreAll'): void {
    const current = hiddenPaths()
    if (action === 'undo') {
      const previous = regionHistory.current.undo.pop()
      if (!previous) return
      regionHistory.current.redo.push(current)
      setHidden(previous)
    } else if (action === 'redo') {
      const next = regionHistory.current.redo.pop()
      if (!next) return
      regionHistory.current.undo.push(current)
      setHidden(next)
    } else {
      regionHistory.current.undo.push(current)
      regionHistory.current.redo = []
      setHidden([])
    }
    saveRegions()
    reportRegionState()
  }

  useEffect(() => {
    if (!props.regionEditing) documentOf()?.querySelectorAll('.rp-region-hover').forEach((element) => element.classList.remove('rp-region-hover'))
  }, [props.regionEditing])

  useLayoutEffect(() => {
    regionHistory.current = { undo: [], redo: [] }
  }, [props.paperId])

  return (
    <div className="html-view">
      {source !== undefined && (
        <iframe
          ref={frame}
          key={`${props.paperId}-${props.attachmentId}-${props.reloadToken}`}
          className="html-frame"
          title="HTML"
          sandbox="allow-same-origin"
          srcDoc={source}
          onLoad={onLoad}
        />
      )}
      {props.renderSidenotes(positions, layout ? { ...layout, scrollTop } : null)}
    </div>
  )
})

function rangeOverNodes(nodes: Text[], start: number, end: number): Range | null {
  let offset = 0
  let startNode: Text | undefined
  let startOffset = 0
  for (const node of nodes) {
    const length = node.data.length
    if (!startNode && start < offset + length) {
      startNode = node
      startOffset = start - offset
    }
    if (startNode && end <= offset + length) {
      const range = node.ownerDocument.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}

/** Adds the base URL and reader styles; the page itself never runs scripts. */
function prepareDocument(html: string, baseURL: string): string {
  const head = `<base href="${baseURL}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src freddie: https: data: blob:; style-src freddie: 'unsafe-inline'; font-src freddie: data:; media-src freddie: https:">`
  const withHead = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${head}`) : `<head>${head}</head>${html}`
  return withHead.replace(/<script\b[\s\S]*?<\/script>/gi, '')
}

