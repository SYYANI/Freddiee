import { useMemo, useState } from 'react'
import type { Note } from '../../shared/types'
import { SidenoteCard } from '../readers/SidenoteRail'

const cardGap = 8
const estimatedCardHeight = 84

/** Margin notes beside the HTML page, scrolled with it and stacked so they never overlap. */
export function HtmlSidenotes({ positions, layout, focusNoteId, onFocusHandled }: {
  positions: Array<{ note: Note; top: number }>
  layout: { left: number; width: number; scrollTop: number } | null
  focusNoteId: string | null
  onFocusHandled: () => void
}): JSX.Element | null {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const placed = useMemo(() => {
    let next = 0
    return [...positions].sort((a, b) => a.top - b.top).map(({ note, top }) => {
      const placedTop = Math.max(top, next)
      next = placedTop + (heights[note.id] ?? estimatedCardHeight) + cardGap
      return { note, top: placedTop }
    })
  }, [positions, heights])
  if (!layout || placed.length === 0) return null
  return (
    <div className="html-sidenotes" style={{ left: layout.left, width: layout.width }}>
      <div className="html-sidenotes-track" style={{ transform: `translateY(${-layout.scrollTop}px)` }}>
        {placed.map(({ note, top }) => (
          <SidenoteCard
            key={note.id}
            note={note}
            top={top}
            focus={focusNoteId === note.id}
            onFocusHandled={onFocusHandled}
            onHeight={(height) => setHeights((current) => (current[note.id] === height ? current : { ...current, [note.id]: height }))}
          />
        ))}
      </div>
    </div>
  )
}
