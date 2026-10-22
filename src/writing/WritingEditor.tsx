import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { liveMarkdown } from './liveMarkdown'
import { insertCitationText, registerWritingHandler } from './writingBus'

export interface WritingEditorHandle {
  replaceAll(text: string): void
  insertAtCursor(text: string): void
}

/**
 * The writing's Markdown, edited as text with live styling. Saves shortly after typing stops
 * and when the editor goes away.
 */
export function WritingEditor({ writingId, initialText, onChange, onOpenLink, focusToken, maximumWidth, placeholder, handleRef }: {
  writingId: string
  initialText: string
  onChange: (text: string) => void
  onOpenLink: (destination: string, title: string | undefined, text: string, position: number) => void
  focusToken: number
  maximumWidth?: number
  placeholder: string
  handleRef?: React.MutableRefObject<WritingEditorHandle | null>
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>()
  const change = useRef(onChange)
  const openLink = useRef(onOpenLink)
  change.current = onChange
  openLink.current = onOpenLink

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          drawSelection(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          placeholderExtension(placeholder),
          liveMarkdown(
            (path) => window.freddie.writings.imageURL(writingId, path),
            (destination, title, position) => openLink.current(destination, title, editor.state.doc.toString(), position)
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString())
          }),
          EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Writing' })
        ]
      })
    })
    view.current = editor
    if (handleRef) {
      handleRef.current = {
        replaceAll: (text) => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }),
        insertAtCursor: (text) => editor.dispatch(editor.state.replaceSelection(text))
      }
    }
    const unregister = registerWritingHandler((command) => {
      if (command.type === 'focus') {
        editor.focus()
        return true
      }
      if (command.type !== 'insert-citation') return false
      const current = editor.state.doc.toString()
      const { text, cursor } = insertCitationText(current, command.markdown, editor.state.selection.main.head)
      editor.dispatch({ changes: { from: 0, to: current.length, insert: text }, selection: { anchor: cursor }, scrollIntoView: true })
      return true
    })
    return () => {
      unregister()
      editor.destroy()
      view.current = undefined
      if (handleRef) handleRef.current = null
    }
  }, [writingId])

  useEffect(() => {
    if (focusToken > 0) view.current?.focus()
  }, [focusToken])

  return <div ref={host} className="writing-editor" style={maximumWidth ? { ['--writing-max-width' as string]: `${maximumWidth}px` } : undefined} />
}
