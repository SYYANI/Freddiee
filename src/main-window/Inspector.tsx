import { useEffect, useRef, useState } from 'react'
import type { InspectorMode, Note, NoteSelectionContext, Paper } from '../../shared/types'
import { commonItemTypes, decodeEditableAuthors, displayAuthors, editableAuthorsText, itemTypeTitle, itemTypeTitles, metadataIdentifierText, sortedItemTypes, type ItemTypeResolution } from '../../shared/library'
import { formatDate, useApp } from '../app/context'
import { confirmDestructive, errorText, popupMenu } from '../app/native'
import { IconButton, SegmentedPicker, Spinner } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { NoteMarkdown } from '../ui/NoteMarkdown'
import { WritingPane } from '../writing/WritingPane'

export function Inspector({ paper, itemTypes, notes, mode, onMode, selection, focusedNoteId, onFocusHandled, onCreateNote, onOpenNoteAnchor, onOpenWriting, onCreateWritingAbout, onOpenCitation }: {
  paper?: Paper
  itemTypes: ItemTypeResolution
  notes: Note[]
  mode: InspectorMode
  onMode: (mode: InspectorMode) => void
  selection: NoteSelectionContext | null
  focusedNoteId: string | null
  onFocusHandled: () => void
  onCreateNote: () => void
  onOpenNoteAnchor: (note: Note) => void
  onOpenWriting: (id: string) => void
  onCreateWritingAbout: (paper: Paper) => void
  onOpenCitation: (destination: string, title?: string, quote?: string) => void
}): JSX.Element {
  const { t, snapshot } = useApp()
  return (
    <aside className={`inspector appearance-${snapshot.settings.readerAppearance}`} aria-label={t('Inspector')}>
      <div className="inspector-toolbar-spacer drag-region" />
      <div className="inspector-picker">
        <SegmentedPicker
          label={t('Inspector')}
          value={mode}
          onChange={onMode}
          options={[{ value: 'paper', title: t('Paper') }, { value: 'writing', title: t('Writing') }]}
        />
      </div>
      {mode === 'paper' ? (
        paper ? (
          <div className="inspector-scroll">
            <MetadataSection paper={paper} itemTypes={itemTypes} />
            <div className="divider" />
            <NotesSection notes={notes} selection={selection} focusedNoteId={focusedNoteId} onFocusHandled={onFocusHandled} onCreateNote={onCreateNote} onOpenNoteAnchor={onOpenNoteAnchor} />
            <div className="divider" />
            <WritingsSection paper={paper} onOpenWriting={onOpenWriting} onCreateWriting={() => onCreateWritingAbout(paper)} />
          </div>
        ) : (
          <div className="inspector-empty">
            <Icon name="doc.text" size={32} weight={1.3} className="tertiary" />
            <span>{t('No Paper Selected')}</span>
          </div>
        )
      ) : (
        <WritingPane presentation="inspector" onOpenCitation={onOpenCitation} />
      )}
    </aside>
  )
}

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="inspector-section-header">
      <span>{title}</span>
      <span className="spacer" />
      {children}
    </div>
  )
}

function MetadataSection({ paper, itemTypes }: { paper: Paper; itemTypes: ItemTypeResolution }): JSX.Element {
  const { t } = useApp()
  const [editingAuthors, setEditingAuthors] = useState(false)
  const [authorsDraft, setAuthorsDraft] = useState('')
  const [error, setError] = useState<string>()
  const [abstractExpanded, setAbstractExpanded] = useState(false)
  const [translatedAbstract, setTranslatedAbstract] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [abstractError, setAbstractError] = useState<string>()
  const request = useRef(0)
  const authorsField = useRef<HTMLTextAreaElement>(null)
  const identifier = metadataIdentifierText(paper, t)
  const itemType = itemTypes.itemType(paper.id)
  const detected = itemTypes.detectedType(paper.id)

  useEffect(() => {
    setEditingAuthors(false)
    setError(undefined)
    setAbstractExpanded(false)
    setTranslatedAbstract(null)
    setTranslating(false)
    setAbstractError(undefined)
    request.current += 1
  }, [paper.id])

  useEffect(() => {
    if (editingAuthors) {
      authorsField.current?.focus()
      authorsField.current?.select()
    }
  }, [editingAuthors])

  const commitAuthors = async (): Promise<void> => {
    const authors = decodeEditableAuthors(authorsDraft)
    setEditingAuthors(false)
    if (authors.join('\n') === paper.authors.join('\n')) return
    try {
      await window.freddie.library.updatePaper(paper.id, { authors })
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const chooseItemType = async (anchor: HTMLElement): Promise<void> => {
    const others = sortedItemTypes(Object.keys(itemTypeTitles).filter((type) => !commonItemTypes.includes(type)), t)
    const choice = await popupMenu([
      ...commonItemTypes.map((type) => ({ id: type, label: itemTypeTitle(type, t), type: 'checkbox' as const, checked: type === itemType })),
      { label: t('More Types'), submenu: others.map((entry) => ({ id: entry.itemType, label: entry.title, type: 'checkbox' as const, checked: entry.itemType === itemType })) },
      ...(itemTypes.isAssigned(paper.id) ? [{ type: 'separator' as const }, { id: '__detected', label: t('Use Detected Type (%@)', itemTypeTitle(detected, t)) }] : [])
    ], anchor)
    if (!choice) return
    try {
      await window.freddie.library.setItemType(paper.id, choice === '__detected' ? null : choice)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const translateAbstract = async (): Promise<void> => {
    const id = ++request.current
    setTranslating(true)
    setAbstractError(undefined)
    try {
      const text = await window.freddie.translation.translateAbstract(paper.id)
      if (id === request.current) setTranslatedAbstract(text)
    } catch (reason) {
      if (id === request.current) setAbstractError(errorText(reason))
    } finally {
      if (id === request.current) setTranslating(false)
    }
  }

  return (
    <section className="inspector-section metadata">
      <button type="button" className="item-type-picker" title={t('Item Type')} onClick={(event) => void chooseItemType(event.currentTarget)}>
        {itemTypeTitle(itemType, t)}
        <Icon name="chevron.down" size={9} weight={2.6} />
      </button>
      <h2 className="inspector-title selectable">{paper.title}</h2>
      {editingAuthors ? (
        <textarea
          ref={authorsField}
          className="authors-field field-well focused"
          rows={Math.min(3, Math.max(1, Math.ceil(authorsDraft.length / 40)))}
          value={authorsDraft}
          onChange={(event) => setAuthorsDraft(event.target.value)}
          onBlur={() => void commitAuthors()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void commitAuthors()
            }
            if (event.key === 'Escape') setEditingAuthors(false)
          }}
        />
      ) : (
        <button type="button" className="authors-button" onClick={() => {
          setAuthorsDraft(editableAuthorsText(paper.authors))
          setEditingAuthors(true)
        }}>
          {displayAuthors(paper, t)}
        </button>
      )}
      {identifier && <div className="caption secondary selectable">{identifier}</div>}
      {error && <div className="caption error">{error}</div>}
      {paper.abstract && (
        <div className="abstract">
          <SectionHeader title={t('Abstract')}>
            {translatedAbstract !== null ? (
              <IconButton icon="arrow.uturn.backward" size={14} label={t('Original')} onClick={() => setTranslatedAbstract(null)} />
            ) : !translating && (
              <IconButton icon="character.book.closed" size={14} label={t('Translate')} onClick={() => void translateAbstract()} />
            )}
            <IconButton icon={abstractExpanded ? 'chevron.up' : 'chevron.down'} size={14} label={abstractExpanded ? t('Less') : t('More')} onClick={() => setAbstractExpanded((value) => !value)} />
          </SectionHeader>
          {abstractError && <div className="caption error">{abstractError}</div>}
          {translating ? (
            <div className="abstract-progress"><Spinner size={12} /><span>{t('Translating abstract...')}</span></div>
          ) : (
            <p className={`abstract-text selectable ${abstractExpanded ? 'expanded' : ''}`}>{translatedAbstract ?? paper.abstract}</p>
          )}
        </div>
      )}
    </section>
  )
}

function NotesSection({ notes, selection, focusedNoteId, onFocusHandled, onCreateNote, onOpenNoteAnchor }: {
  notes: Note[]
  selection: NoteSelectionContext | null
  focusedNoteId: string | null
  onFocusHandled: () => void
  onCreateNote: () => void
  onOpenNoteAnchor: (note: Note) => void
}): JSX.Element {
  const { t } = useApp()
  return (
    <section className="inspector-section notes">
      <SectionHeader title={t('Notes')}>
        <IconButton icon="plus" size={16} label={selection ? t('Add Note to Current Selection') : t('Add Note')} onClick={onCreateNote} />
      </SectionHeader>
      {selection && <div className="caption secondary">{t('Selected text will be attached to the next note.')}</div>}
      {notes.length === 0 ? (
        <div className="caption secondary">{t('No notes yet.')}</div>
      ) : notes.map((note) => (
        <NoteEditor key={note.id} note={note} focus={focusedNoteId === note.id} onFocusHandled={onFocusHandled} onOpenAnchor={note.pageIndex !== undefined || note.htmlSelector ? () => onOpenNoteAnchor(note) : undefined} />
      ))}
    </section>
  )
}

function NoteEditor({ note, focus, onFocusHandled, onOpenAnchor }: { note: Note; focus: boolean; onFocusHandled: () => void; onOpenAnchor?: () => void }): JSX.Element {
  const { t, language } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const editor = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (!editing) setDraft(note.body)
  }, [note.body])

  useEffect(() => {
    if (focus) {
      setEditing(true)
      onFocusHandled()
    }
  }, [focus])

  useEffect(() => {
    if (editing) {
      editor.current?.focus()
      editor.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [editing])

  const save = (value: string): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void window.freddie.notes.update(note.id, value), 400)
  }

  const remove = async (): Promise<void> => {
    const confirmed = await confirmDestructive(t('Delete Note?'), note.body.trim() ? t('This note will be permanently removed.') : t('This empty note will be removed.'), t('Delete'), t('Cancel'))
    if (confirmed) await window.freddie.notes.remove(note.id)
  }

  const anchor = note.pageIndex !== undefined ? `${t('Page')} ${note.pageIndex + 1}` : note.htmlSelector ? t('HTML selection') : undefined

  return (
    <div className="note-editor">
      <div className="note-meta">
        <span className="caption2 secondary">{formatDate(note.modifiedAt, language)}</span>
        <span className="spacer" />
        <IconButton icon="trash" size={13} label={t('Delete note')} onClick={() => void remove()} />
      </div>
      {anchor && (
        <div className="note-anchor">
          <Icon name={note.pageIndex !== undefined ? 'bookmark' : 'text.alignleft'} size={12} />
          <span>{anchor}</span>
          {onOpenAnchor && <button type="button" className="link-button" onClick={onOpenAnchor}>{t('Go to Selection')}</button>}
        </div>
      )}
      {note.quote.trim() && <blockquote className="note-quote selectable">{note.quote}</blockquote>}
      {editing ? (
        <>
          <textarea
            ref={editor}
            className="note-textarea field-well focused"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              save(event.target.value)
            }}
            onBlur={() => {
              clearTimeout(saveTimer.current)
              void window.freddie.notes.update(note.id, draft)
              setEditing(false)
            }}
          />
          {draft.trim() && <div className="note-preview-card"><NoteMarkdown markdown={draft} /></div>}
        </>
      ) : (
        <div className="note-preview-card interactive" onClick={() => setEditing(true)}>
          {note.body.trim() ? <NoteMarkdown markdown={note.body} /> : <span className="secondary">{t('Click to edit note')}</span>}
        </div>
      )}
    </div>
  )
}

function WritingsSection({ paper, onOpenWriting, onCreateWriting }: { paper: Paper; onOpenWriting: (id: string) => void; onCreateWriting: () => void }): JSX.Element {
  const { t, snapshot, language } = useApp()
  const writings = snapshot.writings.filter((writing) => writing.citedPaperIds.includes(paper.id))
  return (
    <section className="inspector-section writings">
      <SectionHeader title={t('Writings')}>
        <IconButton icon="square.and.pencil" size={15} label={t('New Writing About This Paper')} onClick={onCreateWriting} />
      </SectionHeader>
      {writings.length === 0 ? (
        <div className="caption secondary">{t('No writings cite this paper yet.')}</div>
      ) : writings.map((writing) => (
        <button key={writing.id} type="button" className="writing-row" title={t('Open in the Writing Tab')} onClick={() => onOpenWriting(writing.id)}>
          <Icon name="doc.text" size={14} className="secondary" />
          <span className="writing-row-title">{writing.title || t('Untitled Writing')}</span>
          <span className="spacer" />
          <span className="caption secondary">{formatDate(writing.modifiedAt, language, { dateStyle: 'medium' })}</span>
        </button>
      ))}
    </section>
  )
}
