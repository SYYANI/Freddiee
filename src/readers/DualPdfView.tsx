import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { NoteSelectionContext } from '../../shared/types'
import { PdfView, type AnnotationState, type AnnotationTool, type PdfViewHandle } from './PdfView'
import type { FindRequest, FindStatus } from './find'

export type DualSide = 'original' | 'translated'

/**
 * The original and translated PDFs side by side. Only the pane the reader scrolls leads; the
 * other follows to the same place within the page, so differently scaled panes never pull
 * each other back and forth.
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
  tool?: AnnotationTool
  onAnnotationState?: (state: AnnotationState) => void
  onRequestTextNote?: (side: DualSide, pageIndex: number, point: { x: number; y: number }) => void
  onLinkActivated?: (url: string) => void
}>(function DualPdfView(props, ref) {
  const originalRef = useRef<PdfViewHandle>(null)
  const translatedRef = useRef<PdfViewHandle>(null)
  const leader = useRef<DualSide | null>(null)
  const following = useRef(false)
  const lastActive = useRef<DualSide>('original')
  const [split, setSplit] = useState(0.5)
  const container = useRef<HTMLDivElement>(null)

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

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const box = container.current?.getBoundingClientRect()
    if (!box) return
    const move = (pointer: PointerEvent): void => setSplit(Math.min(0.8, Math.max(0.2, (pointer.clientX - box.left) / box.width)))
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
    <div ref={container} className="dual-pdf" style={{ gridTemplateColumns: `${split}fr 1px ${1 - split}fr` }}>
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
          tool={props.tool}
          onAnnotationState={props.onAnnotationState}
          onRequestTextNote={(page, point) => props.onRequestTextNote?.('original', page, point)}
          onUserScroll={() => follow('original')}
          onLinkActivated={props.onLinkActivated}
          label={props.original.label}
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
          tool={props.tool}
          onAnnotationState={props.onAnnotationState}
          onRequestTextNote={(page, point) => props.onRequestTextNote?.('translated', page, point)}
          onUserScroll={() => follow('translated')}
          onLinkActivated={props.onLinkActivated}
          label={props.translated.label}
          maxPage={props.translated.maxPage}
        />
      </div>
    </div>
  )
})
