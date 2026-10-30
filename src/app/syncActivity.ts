import { useEffect, useState } from 'react'

/**
 * Tells sync which paper a reader or the Inspector shows. Remote changes to a busy paper
 * wait until it is idle, and a remote deletion waits until no view shows the paper.
 */
export function useSyncReaderActivity(paperId: string | undefined, busy: boolean): void {
  const [editorId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    window.freddie.sync.setReaderActivity(editorId, paperId ? { paperId, busy } : null)
  }, [editorId, paperId, busy])
  useEffect(() => () => window.freddie.sync.setReaderActivity(editorId, null), [editorId])
}

/** Tells sync that a note is being edited, so neither it nor its paper is replaced meanwhile. */
export function useSyncNoteEditing(noteId: string, paperId: string, editing: boolean): void {
  const [editorId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    window.freddie.sync.setNoteEditing(editorId, editing ? { noteId, paperId } : null)
  }, [editorId, noteId, paperId, editing])
  useEffect(() => () => window.freddie.sync.setNoteEditing(editorId, null), [editorId])
}
