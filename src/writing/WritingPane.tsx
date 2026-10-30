import { useCallback, useEffect, useRef, useState } from 'react'
import type { WritingMetadata } from '../../shared/types'
import { citedPaperIds, renameWriting, wordCount } from '../../shared/writing'
import { useApp } from '../app/context'
import { confirmDestructive, errorText, alertError, popupMenu } from '../app/native'
import { Button, IconButton, PromptSheet } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { WritingEditor, type WritingEditorHandle } from './WritingEditor'

export function useWritingWindowOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void window.freddie.writings.isWindowOpen().then(setOpen)
    return window.freddie.writings.onWindowState(setOpen)
  }, [])
  return open
}

export function WritingPane({ presentation, onOpenCitation }: {
  presentation: 'inspector' | 'window'
  onOpenCitation: (destination: string, title?: string, quote?: string) => void
}): JSX.Element {
  const { snapshot, t } = useApp()
  const windowOpen = useWritingWindowOpen()
  const writings = snapshot.writings
  const current = writings.find((writing) => writing.id === snapshot.settings.currentWritingId) ?? writings[0]
  const [text, setText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [renaming, setRenaming] = useState<WritingMetadata | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const pending = useRef<{ id: string; text: string } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const editorHandle = useRef<WritingEditorHandle | null>(null)

  const [reloadToken, setReloadToken] = useState(0)

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current)
    const item = pending.current
    pending.current = null
    if (!item) return
    // Sync leaves the writing alone until the edit is on disk.
    void window.freddie.writings.save(item.id, item.text).finally(() => {
      if (pending.current?.id !== item.id) window.freddie.sync.setWritingDirty(item.id, false)
    })
  }, [])

  // A newer version from another device replaces the text when nothing is unsaved here.
  useEffect(() => window.freddie.sync.onApplied((change) => {
    if (!current || !change.writingIds.includes(current.id) || pending.current) return
    void window.freddie.writings.load(current.id).then((markdown) => {
      if (pending.current) return
      setText(markdown)
      setReloadToken((value) => value + 1)
    })
  }), [current?.id])

  useEffect(() => {
    setText(null)
    setLoadError(false)
    if (!current) return
    let cancelled = false
    void window.freddie.writings.load(current.id).then((markdown) => {
      if (!cancelled) setText(markdown)
    }).catch(() => {
      if (!cancelled) setLoadError(true)
    })
    return () => {
      cancelled = true
      flush()
    }
  }, [current?.id])

  useEffect(() => {
    const save = (): void => flush()
    window.addEventListener('beforeunload', save)
    window.addEventListener('blur', save)
    return () => {
      window.removeEventListener('beforeunload', save)
      window.removeEventListener('blur', save)
      flush()
    }
  }, [flush])

  useEffect(() => window.freddie.writings.onCommand((command) => {
    if (command.type === 'focus') setFocusToken((value) => value + 1)
  }), [])

  const onChange = (value: string): void => {
    if (!current) return
    setText(value)
    if (!pending.current) window.freddie.sync.setWritingDirty(current.id, true)
    pending.current = { id: current.id, text: value }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 700)
  }

  const createWriting = async (): Promise<void> => {
    flush()
    try {
      // A new writing opens in the writing window, as in native Freddie.
      await window.freddie.writings.create('', presentation === 'inspector')
      if (presentation === 'window') setFocusToken((value) => value + 1)
    } catch (error) {
      await alertError(t('Unable to Update Writing'), errorText(error), t('OK'))
    }
  }

  const showSwitcher = async (anchor: HTMLElement): Promise<void> => {
    const choice = await popupMenu([
      ...writings.map((writing) => ({ id: writing.id, label: writing.title || t('Untitled Writing'), type: 'checkbox' as const, checked: writing.id === current?.id })),
      { type: 'separator' },
      { id: '__new', label: t('New Writing') }
    ], anchor)
    if (choice === '__new') void createWriting()
    else if (choice) {
      flush()
      void window.freddie.writings.select(choice)
    }
  }

  const showMore = async (anchor: HTMLElement): Promise<void> => {
    if (!current) return
    const choice = await popupMenu([
      { id: 'rename', label: t('Rename…') },
      { id: 'image', label: t('Insert Image…') },
      { id: 'reveal', label: t('Show in File Manager') },
      { type: 'separator' },
      { id: 'delete', label: t('Delete Writing…') }
    ], anchor)
    try {
      if (choice === 'rename') setRenaming(current)
      if (choice === 'image') {
        const paths = await window.freddie.writings.insertImages(current.id)
        if (paths.length) editorHandle.current?.insertAtCursor(paths.map((path) => `![](${path})`).join('\n\n'))
      }
      if (choice === 'reveal') {
        flush()
        await window.freddie.writings.reveal(current.id)
      }
      if (choice === 'delete') {
        const confirmed = await confirmDestructive(t('Delete Writing?'), t('“%@” will be moved to the Trash.', current.title || t('Untitled Writing')), t('Move to Trash'), t('Cancel'))
        if (confirmed) {
          pending.current = null
          await window.freddie.writings.remove(current.id)
        }
      }
    } catch (error) {
      await alertError(t('Unable to Update Writing'), errorText(error), t('OK'))
    }
  }

  const switcher = current && (
    <button type="button" className="writing-switcher" title={t('Switch Writing')} onClick={(event) => void showSwitcher(event.currentTarget)}>
      <span>{current.title || t('Untitled Writing')}</span>
      <Icon name="chevron.down" size={10} weight={2.6} className="secondary" />
    </button>
  )

  if (presentation === 'inspector' && windowOpen) {
    return (
      <div className="writing-placeholder">
        <Icon name="square.and.pencil" size={32} weight={1.3} className="tertiary" />
        <div className="writing-placeholder-buttons">
          <Button onClick={() => void window.freddie.writings.openWindow()}>{t('Show Window')}</Button>
          <Button onClick={() => void window.freddie.writings.closeWindow()}>{t('Move Back Here')}</Button>
        </div>
      </div>
    )
  }

  if (!current) {
    return (
      <div className="writing-empty">
        <Icon name="square.and.pencil" size={32} weight={1.3} className="tertiary" />
        <span>{t('No Writings Yet')}</span>
        <Button onClick={() => void createWriting()}>{t('New Writing')}</Button>
      </div>
    )
  }

  const liveWords = text !== null ? wordCount(text) : current.wordCount
  const liveCitations = text !== null ? citedPaperIds(text).length : current.citedPaperIds.length

  return (
    <div className={`writing-pane presentation-${presentation}`}>
      {presentation === 'inspector' ? (
        <div className="writing-header">
          {switcher}
          <span className="spacer" />
          <IconButton icon="square.and.pencil" size={16} label={t('New Writing')} onClick={() => void createWriting()} />
          <IconButton icon="macwindow" size={16} label={t('Open in Separate Window')} onClick={() => {
            flush()
            void window.freddie.writings.openWindow()
          }} />
          <IconButton icon="ellipsis.circle" size={16} label={t('More')} onClick={(event) => void showMore(event.currentTarget)} />
        </div>
      ) : (
        <div className="writing-window-toolbar drag-region">
          <div className="no-drag">{switcher}</div>
          <span className="spacer" />
          <div className="toolbar-group glass no-drag">
            <IconButton icon="square.and.pencil" size={17} label={t('New Writing')} onClick={() => void createWriting()} />
            <IconButton icon="ellipsis.circle" size={17} label={t('More')} onClick={(event) => void showMore(event.currentTarget)} />
          </div>
        </div>
      )}
      {loadError ? (
        <div className="writing-empty">
          <Icon name="exclamationmark.triangle" size={28} className="tertiary" />
          <strong>{t('Writing Unavailable')}</strong>
          <span className="secondary">{t('The writing’s file could not be read.')}</span>
        </div>
      ) : text === null ? (
        <div className="writing-loading" />
      ) : (
        <WritingEditor
          key={`${current.id}-${reloadToken}`}
          writingId={current.id}
          initialText={text}
          onChange={onChange}
          onOpenLink={(destination, title, markdown, position) => {
            if (/^readpaper:/i.test(destination)) {
              // A citation under its block quote opens at the full quoted passage.
              const before = markdown.slice(0, position).split('\n')
              const quoteLines: string[] = []
              for (let index = before.length - 2; index >= 0 && before[index].startsWith('>'); index -= 1) quoteLines.unshift(before[index].replace(/^>\s?/, ''))
              const quote = quoteLines.join(' ').trim() || undefined
              onOpenCitation(destination, title, quote)
            } else if (/^(https?|mailto):/i.test(destination)) void window.freddie.shell.openExternal(destination)
          }}
          focusToken={focusToken}
          maximumWidth={presentation === 'window' ? 720 : undefined}
          placeholder={t('Start writing…')}
          handleRef={editorHandle}
        />
      )}
      <div className="writing-footer">
        {snapshot.writingError ? <span className="error">{snapshot.writingError}</span> : (
          <>
            <span>{t('Words: %lld', liveWords)}</span>
            {liveCitations > 0 && (
              <>
                <span>·</span>
                <span>{t('Cited papers: %lld', liveCitations)}</span>
              </>
            )}
          </>
        )}
      </div>
      {renaming && (
        <PromptSheet
          title={t('Rename Writing')}
          message={t('The title is the writing’s first line, so renaming changes that line.')}
          placeholder={t('Title')}
          initialValue={renaming.title}
          confirmTitle={t('Rename')}
          cancelTitle={t('Cancel')}
          onCancel={() => setRenaming(null)}
          onConfirm={(value) => {
            setRenaming(null)
            const renamed = text !== null ? renameWriting(text, value) : undefined
            if (renamed !== undefined) {
              editorHandle.current?.replaceAll(renamed)
              flush()
            }
          }}
        />
      )}
    </div>
  )
}
