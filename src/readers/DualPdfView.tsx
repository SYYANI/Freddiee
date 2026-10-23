import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { NoteSelectionContext } from '../../shared/types'
import { PdfView, type AnnotationState, type AnnotationTool, type PdfViewHandle } from './PdfView'
import type { FindRequest, FindStatus } from './find'
import { clampedSplitFraction } from './pdfScaling'

export type DualSide = 'original' | 'translated'

/**
 * The original and translated PDFs side by side. Only the pane the reader scrolls leads; the
 * other follows to the same place within the page, so differently scaled panes never pull
 * each other back and forth. Both panes fit their width until the reader zooms one.
 */
export const DualPdfView = forwardRef<{ active(): PdfViewHandle | null }, {
  paperId: string
  original: { url: string; attachmentId: string; label: ReactNode }
  translated: { url: string; attachmentId: string; label: ReactNode; maxPage?: number }
  pageIndex: number
  onPageChange: (pageIndex: number) => void
  appearance: 'default' | 'paper'
  find?: FindRequest | null
  findTarget: DualSide
  onFindStatus?: (status: FindStatus) => void
  navigation?: { id: string; pageIndex?: number; quote?: string; attachmentId?: string } | null
  onSelection?: (selection: NoteSelectionContext | null) => void
  heldSelection?: NoteSelectionContext | null
  tool?: AnnotationTool
  onAnnotationState?: (state: AnnotationState) => void
  onRequestTextNote?: (side: DualSide, pageIndex: number, point: { x: number; y: number }) => void
  onLinkActivated?: (url: string) => void
  handToolEnabled?: boolean
}>(function DualPdfView(props, ref) {
  const originalRef = useRef<PdfViewHandle>(null)
  const translatedRef = useRef<PdfViewHandle>(null)
  const leader = useRef<DualSide | null>(null)
  const following = useRef(false)
  const lastActive = useRef<DualSide>('original')
  const [split, setSplit] = useState(0.5)
  const [scalingRestoreToken, setScalingRestoreToken] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  // The divider column is one pixel wide; both panes keep at least the native minimum width.
  const fraction = clampedSplitFraction(split, width - 1)

  useImperativeHandle(ref, () => ({
    active: () => (lastActive.current === 'translated' ? translatedRef.current : originalRef.current)
  }))

  const follow = useCallback((side: DualSide) => {
    if (following.current) return
    leader.current = side
    lastActive.current = side
    const source = side === 'original' ? originalRef.current : translatedRef.current
    const target = side === 'original' ? translatedRef.current : originalRef.current
    const anchor = source?.scrollAnchor()
    if (!anchor || !target) return
    following.current = true
    target.scrollToAnchor(anchor)
    requestAnimationFrame(() => {
      following.current = false
    })
  }, [])

  // The divider follows the drag from where it was grabbed. Starting a drag lets a pane zoomed
  // close to its fitted scale fit its width again, so it keeps fitting while the panes resize.
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const available = (container.current?.clientWidth ?? 0) - 1
    if (available <= 0) return
    const startX = event.clientX
    const startWidth = available * clampedSplitFraction(split, available)
    setScalingRestoreToken((token) => token + 1)
    const move = (pointer: PointerEvent): void => setSplit(clampedSplitFraction((startWidth + pointer.clientX - startX) / available, available))
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('resizing-columns')
    }
    document.body.classList.add('resizing-columns')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const navigationFor = (side: DualSide): typeof props.navigation => {
    if (!props.navigation) return null
    const targetSide = props.navigation.attachmentId === props.translated.attachmentId ? 'translated' : 'original'
    return targetSide === side ? props.navigation : { ...props.navigation, quote: undefined }
  }

  return (
    <div ref={container} className="dual-pdf" style={{ gridTemplateColumns: `${fraction}fr 1px ${1 - fraction}fr` }}>
      <div className="dual-pane" onPointerDown={() => { lastActive.current = 'original' }}>
        <PdfView
          ref={originalRef}
          paperId={props.paperId}
          attachmentId={props.original.attachmentId}
          url={props.original.url}
          pageIndex={props.pageIndex}
          onPageChange={(page) => {
            if (leader.current !== 'translated') props.onPageChange(page)
          }}
          appearance={props.appearance}
          find={props.findTarget === 'original' ? props.find : null}
          onFindStatus={props.findTarget === 'original' ? props.onFindStatus : undefined}
          navigation={navigationFor('original')}
          onSelection={props.onSelection}
          heldSelection={props.heldSelection}
          tool={props.tool}
          onAnnotationState={props.onAnnotationState}
          onRequestTextNote={(page, point) => props.onRequestTextNote?.('original', page, point)}
          onUserScroll={() => follow('original')}
          onLinkActivated={props.onLinkActivated}
          label={props.original.label}
          automaticScaling
          scalingRestoreToken={scalingRestoreToken}
          handToolEnabled={props.handToolEnabled}
        />
      </div>
      <div className="dual-divider" onPointerDown={beginResize} role="separator" aria-orientation="vertical" />
      <div className="dual-pane" onPointerDown={() => { lastActive.current = 'translated' }}>
        <PdfView
          ref={translatedRef}
          paperId={props.paperId}
          attachmentId={props.translated.attachmentId}
          url={props.translated.url}
          pageIndex={props.pageIndex}
          onPageChange={(page) => {
            if (leader.current === 'translated') props.onPageChange(page)
          }}
          appearance={props.appearance}
          find={props.findTarget === 'translated' ? props.find : null}
          onFindStatus={props.findTarget === 'translated' ? props.onFindStatus : undefined}
          navigation={navigationFor('translated')}
          onSelection={props.onSelection}
          heldSelection={props.heldSelection}
          tool={props.tool}
          onAnnotationState={props.onAnnotationState}
          onRequestTextNote={(page, point) => props.onRequestTextNote?.('translated', page, point)}
          onUserScroll={() => follow('translated')}
          onLinkActivated={props.onLinkActivated}
          label={props.translated.label}
          maxPage={props.translated.maxPage}
          automaticScaling
          scalingRestoreToken={scalingRestoreToken}
          handToolEnabled={props.handToolEnabled}
        />
      </div>
    </div>
  )
})
