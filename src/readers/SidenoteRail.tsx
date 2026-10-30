import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../shared/types'
import { useApp } from '../app/context'
import { confirmDestructive } from '../app/native'
import { useSyncNoteEditing } from '../app/syncActivity'
import { Icon } from '../ui/Icon'
import { NoteMarkdown } from '../ui/NoteMarkdown'

const cardGap = 8
const estimatedCardHeight = 84

/**
 * Margin notes beside the PDF pages: each note sits next to its page and pushes later
 * notes down rather than overlapping them, like PDFSidenoteRail.
 */
export function SidenoteRail({ notes, pageTops, pageHeights, left, width, focusNoteId, onFocusHandled }: {
  notes: Note[]
  pageTops: number[]
  pageHeights: number[]
  left: number
  width: number
  focusNoteId?: string | null
  onFocusHandled?: () => void
}): JSX.Element {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const ordered = useMemo(() => [...notes].sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || a.createdAt.localeCompare(b.createdAt)), [notes])
  const positions = useMemo(() => {
    const result: Record<string, number> = {}
    let next = 0
    for (const note of ordered) {
      const page = note.pageIndex ?? 0
      const anchor = (pageTops[page] ?? 0) + Math.min(24, (pageHeights[page] ?? 0) * 0.05)
      const top = Math.max(anchor, next)
      result[note.id] = top
      next = top + (heights[note.id] ?? estimatedCardHeight) + cardGap
    }
    return result
  }, [ordered, pageTops, pageHeights, heights])

  return (
    <div className="sidenote-rail" style={{ left, width, height: pageTops[pageTops.length - 1] ?? 0 }}>
      {ordered.map((note) => (
        <SidenoteCard
          key={note.id}
          note={note}
          top={positions[note.id]}
          focus={focusNoteId === note.id}
          onFocusHandled={onFocusHandled}
          onHeight={(height) => setHeights((current) => (current[note.id] === height ? current : { ...current, [note.id]: height }))}
        />
      ))}
    </div>
  )
}

export function SidenoteCard({ note, top, focus, onFocusHandled, onHeight }: {
  note: Note
  top: number
  focus: boolean
  onFocusHandled?: () => void
  onHeight: (height: number) => void
}): JSX.Element {
  const { t } = useApp()
  const card = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  useSyncNoteEditing(note.id, note.paperId, editing)
  const [draft, setDraft] = useState(note.body)
  const editor = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setDraft(note.body)
  }, [note.body, editing])

  useEffect(() => {
    if (!focus) return
    setEditing(true)
    onFocusHandled?.()
  }, [focus])

  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])

  useEffect(() => {
    const element = card.current
    if (!element) return
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const commit = (): void => {
    setEditing(false)
    if (draft !== note.body) void window.freddie.notes.update(note.id, draft)
  }

  const remove = async (): Promise<void> => {
    const confirmed = await confirmDestructive(t('Delete Note?'), note.body.trim() ? t('This note will be permanently removed.') : t('This empty note will be removed.'), t('Delete'), t('Cancel'))
    if (confirmed) void window.freddie.notes.remove(note.id)
  }

  return (
    <div ref={card} className={`sidenote-card ${editing ? 'editing' : ''}`} style={{ top }}>
      <button type="button" className="sidenote-delete" title={t('Delete Note')} aria-label={t('Delete Note')} onClick={() => void remove()}>
        <Icon name="trash" size={12} />
      </button>
      {note.quote && <blockquote className="sidenote-quote">{note.quote}</blockquote>}
      {editing ? (
        <textarea
          ref={editor}
          className="sidenote-editor"
          value={draft}
          placeholder={t('Write a note…')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') commit()
          }}
        />
      ) : (
        <div className="sidenote-body" onClick={() => setEditing(true)}>
          {note.body.trim() ? <NoteMarkdown markdown={note.body} /> : <span className="placeholder">{t('Click to edit note')}</span>}
        </div>
      )}
    </div>
  )
}
