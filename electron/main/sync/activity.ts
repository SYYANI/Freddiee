import { randomUUID } from 'node:crypto'

/** What a reader or the Inspector shows; a busy one is annotating, editing regions or metadata. */
export interface ReaderActivity {
  paperId: string
  busy: boolean
}

/**
 * The counterpart of native `LibrarySyncActivity`. Records of busy papers wait until the
 * work ends, notes being edited are not replaced, and open papers are deleted once closed.
 */
export class SyncActivity {
  private readonly readers = new Map<string, ReaderActivity>()
  private readonly noteEditors = new Map<string, { noteId: string; paperId: string }>()
  private readonly work = new Map<string, string>()

  setReader(owner: string, activity: ReaderActivity | undefined): void {
    if (activity) this.readers.set(owner, activity)
    else this.readers.delete(owner)
  }

  setNoteEditor(owner: string, note: { noteId: string; paperId: string } | undefined): void {
    if (note) this.noteEditors.set(owner, note)
    else this.noteEditors.delete(owner)
  }

  /** Forgets every reader and note editor whose owner starts with `prefix`, such as a closed window's. */
  removeOwners(prefix: string): void {
    for (const owner of [...this.readers.keys()]) if (owner.startsWith(prefix)) this.readers.delete(owner)
    for (const owner of [...this.noteEditors.keys()]) if (owner.startsWith(prefix)) this.noteEditors.delete(owner)
  }

  /** Protection for work that outlives the view that started it. */
  beginWork(paperId: string): string {
    const id = randomUUID()
    this.work.set(id, paperId)
    return id
  }

  endWork(id: string): void {
    this.work.delete(id)
  }

  busyPaperIds(): Set<string> {
    return new Set([
      ...[...this.readers.values()].filter((reader) => reader.busy).map((reader) => reader.paperId),
      ...this.work.values(),
      ...[...this.noteEditors.values()].map((note) => note.paperId)
    ])
  }

  /** Papers shown in a reader or the Inspector, busy or not. */
  openPaperIds(): Set<string> {
    return new Set([...this.readers.values()].map((reader) => reader.paperId))
  }

  editingNoteIds(): Set<string> {
    return new Set([...this.noteEditors.values()].map((note) => note.noteId))
  }
}
