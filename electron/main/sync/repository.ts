import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Attachment, AttachmentKind, AttachmentSource, Paper, PdfAnnotationRecord, ReaderMode } from '../../../shared/types'
import { deriveWritingTitle } from '../../../shared/writing'
import { atomicWriteFile } from '../files'
import type { Database, FreddieStore } from '../store'
import { makeMetadata, type WritingStore } from '../writings'
import { AnnotationStore, sidecarJSON } from '../annotations'
import { TranslationSegmentStore } from '../translationSegments'
import { annotationFromWire, annotationToWire, segmentFromWire, segmentToWire } from './records'
import { readStamp, resourceFiles, stampsEqual, type BlobStore, type PreparedFile, type Stamp } from './files'
import { scopeDirectory, scopedFile } from './paths'
import type { SyncState } from './state'
import {
  documentFiles,
  documentKey,
  documentScope,
  localUUID,
  paperResourceFolders,
  translationCacheKey,
  scopeToWire,
  SyncError,
  wireUUID,
  writingResourceFolders,
  type DocumentValue,
  type SyncDocument,
  type SyncEntry,
  type SyncFile,
  type SyncRecord
} from './types'

export interface UnavailableAttachment {
  id: string
  paperId: string
  paperTitle: string
  filename: string
  path: string
  reason: 'missing' | 'unreadable' | 'outsideLibrary'
}

export interface Snapshot {
  entries: Map<string, SyncEntry>
  documents: Map<string, SyncDocument>
  /** Files each entry was read from, with the stamp they had. */
  stamps: Map<string, Map<string, Stamp>>
  /** Attachments whose file is missing or outside the library: neither uploaded nor deleted. */
  unavailable: Set<string>
  unavailableAttachments: UnavailableAttachment[]
}

export interface Change {
  record: SyncRecord
  document?: SyncDocument
  previous?: SyncDocument
  files: PreparedFile[]
}

/** Reads a file's contents with the stamp they belong to; a file changing meanwhile retries the snapshot. */
async function stable<T>(path: string, read: () => Promise<T>): Promise<{ value: T; stamp?: Stamp }> {
  const before = await readStamp(path)
  const value = await read()
  if (!stampsEqual(before, await readStamp(path))) throw SyncError.fileChanged()
  return { value, stamp: before }
}

export async function filesAreCurrent(snapshot: Snapshot, key: string): Promise<boolean> {
  for (const [path, stamp] of snapshot.stamps.get(key) ?? []) {
    if (!stampsEqual(await readStamp(path), stamp)) return false
  }
  return true
}

const attachmentKinds: AttachmentKind[] = ['pdf', 'html', 'translatedPDF', 'resource']
const attachmentSources: AttachmentSource[] = ['arxivPDF', 'arxivHTML', 'localImport', 'webPage', 'babeldoc', 'latexTrans', 'scanRebuild', 'generated']
const readerModes: ReaderMode[] = ['html', 'pdf', 'bilingualPDF', 'translatedPDF']

// MARK: Field conversions

const ms = (iso: string | undefined): number | undefined => {
  const value = iso ? Date.parse(iso) : NaN
  return Number.isFinite(value) ? value : undefined
}
/** Required dates; an unreadable one must not change on every pass. */
const requiredMs = (iso: string | undefined): number => ms(iso) ?? 0
const iso = (value: unknown): string | undefined => (typeof value === 'number' ? new Date(value).toISOString() : undefined)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
/** Native Freddie stores lists as newline-separated text. */
const list = (value: unknown): string[] => (typeof value === 'string' ? value.split('\n').map((item) => item.trim()).filter(Boolean) : [])
const normalizedList = (items: string[]): string[] => items.map((item) => item.trim()).filter(Boolean)
const kind = (value: unknown): AttachmentKind => (attachmentKinds.includes(value as AttachmentKind) ? value as AttachmentKind : 'resource')
const source = (value: unknown): AttachmentSource => (attachmentSources.includes(value as AttachmentSource) ? value as AttachmentSource : 'generated')
const readerMode = (value: unknown): ReaderMode => (readerModes.includes(value as ReaderMode) ? value as ReaderMode : 'pdf')
const clampRatio = (value: unknown): number => Math.min(Math.max(Number.isFinite(value) ? Number(value) : 0, 0), 1)

/** Keeps the received raw value whenever it means the same as the local one. */
function keep<T>(local: T, shadow: DocumentValue | undefined, field: string, same: (raw: unknown, local: T) => boolean = (raw, value) => raw === value): unknown {
  if (shadow && field in shadow && same(shadow[field], local)) return shadow[field]
  return local
}
const sameText = (raw: unknown, local: string | undefined): boolean => (text(raw) ?? undefined) === (local || undefined)
const sameUUID = (raw: unknown, local: string | undefined): boolean => localUUID(raw) === (local ? local.toLowerCase() : undefined)
const sameList = (raw: unknown, local: string[]): boolean => JSON.stringify(list(raw)) === JSON.stringify(normalizedList(local))
const wire = (id: string | undefined): string | undefined => (id ? wireUUID(id) : undefined)

/** Order-independent comparison that ignores absent optionals, as decoding does. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, field]) => field !== undefined && field !== null).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return item
  })
}

function filesEqual(a: unknown, b: SyncFile): boolean {
  const file = a as SyncFile | undefined
  return Boolean(file) && file!.relativePath === b.relativePath && file!.hash === b.hash && file!.size === b.size
}

/**
 * Maps this app's library to native Freddie's sync documents and back, and applies
 * received changes. Unchanged records reuse the exact bytes that were received, so
 * fields this app does not model (native HTML anchors, display file names, raw list
 * text) survive and an unchanged record never uploads again.
 */
export class SyncRepository {
  constructor(
    private readonly root: string,
    private readonly store: FreddieStore,
    private readonly writings: WritingStore,
    private readonly blobs: BlobStore
  ) {
    this.annotations = new AnnotationStore(store)
    this.segments = new TranslationSegmentStore(store)
  }

  private readonly annotations: AnnotationStore
  private readonly segments: TranslationSegmentStore

  get generation(): number {
    return this.store.generation
  }

  private async shadow(state: SyncState, key: string): Promise<{ entry: SyncEntry; document: SyncDocument } | undefined> {
    const entry = state.known[key]?.entry
    if (!entry || !(await this.blobs.contains(entry.payload.documentHash))) return undefined
    try {
      return { entry, document: await this.blobs.document(entry.payload) }
    } catch {
      return undefined
    }
  }

  // MARK: Snapshot

  async snapshot(state: SyncState, blockedPapers: Set<string>, blockedWritings: Set<string>): Promise<Snapshot> {
    const result: Snapshot = { entries: new Map(), documents: new Map(), stamps: new Map(), unavailable: new Set(), unavailableAttachments: [] }
    const database = this.store.database
    const papers = new Map(database.papers.filter((paper) => !blockedPapers.has(paper.id)).map((paper) => [paper.id, paper]))
    this.blobs.resetSources()

    const add = async (key: string, build: (shadow: DocumentValue | undefined) => SyncDocument, stamps = new Map<string, Stamp>()): Promise<void> => {
      const shadow = await this.shadow(state, key)
      const document = build(shadow?.document.value)
      if (shadow && shadow.document.tag === document.tag && canonical(shadow.document.value) === canonical(document.value)) {
        result.entries.set(key, shadow.entry)
        result.documents.set(key, shadow.document)
      } else {
        const entry = await this.blobs.entry(document)
        result.entries.set(key, entry)
        result.documents.set(key, document)
      }
      result.stamps.set(key, stamps)
    }

    for (const paper of papers.values()) {
      await add(`paper/${paper.id}`, (shadow) => ({ tag: 'paper', value: paperValue(paper, shadow) }))
    }
    for (const folder of database.folders) {
      await add(`folder/${folder.id}`, (shadow) => ({
        tag: 'folder',
        value: {
          id: keep(wireUUID(folder.id), shadow, 'id', (raw) => sameUUID(raw, folder.id)),
          name: folder.name,
          parentID: keep(wire(folder.parentId), shadow, 'parentID', (raw) => sameUUID(raw, folder.parentId)),
          createdAt: requiredMs(folder.createdAt),
          modifiedAt: requiredMs(folder.modifiedAt)
        }
      }))
    }
    for (const membership of database.memberships) {
      if (!papers.has(membership.paperId)) continue
      await add(`folderMembership/${membership.paperId}`, (shadow) => ({
        tag: 'membership',
        value: {
          paperID: keep(wireUUID(membership.paperId), shadow, 'paperID', (raw) => sameUUID(raw, membership.paperId)),
          folderID: keep(wireUUID(membership.folderId), shadow, 'folderID', (raw) => sameUUID(raw, membership.folderId)),
          addedAt: requiredMs(membership.addedAt)
        }
      }))
    }
    for (const assignment of database.itemTypeAssignments) {
      if (!papers.has(assignment.paperId)) continue
      await add(`itemType/${assignment.paperId}`, (shadow) => ({
        tag: 'itemType',
        value: {
          paperID: keep(wireUUID(assignment.paperId), shadow, 'paperID', (raw) => sameUUID(raw, assignment.paperId)),
          rawValue: assignment.itemType,
          assignedAt: requiredMs(assignment.assignedAt)
        }
      }))
    }
    for (const note of database.notes) {
      if (!papers.has(note.paperId)) continue
      await add(`note/${note.id}`, (shadow) => ({
        tag: 'note',
        value: {
          id: keep(wireUUID(note.id), shadow, 'id', (raw) => sameUUID(raw, note.id)),
          paperID: keep(wireUUID(note.paperId), shadow, 'paperID', (raw) => sameUUID(raw, note.paperId)),
          attachmentID: keep(wire(note.attachmentId), shadow, 'attachmentID', (raw) => sameUUID(raw, note.attachmentId)),
          quote: note.quote,
          body: note.body,
          pageIndex: note.pageIndex,
          htmlSelector: keep(note.htmlSelector, shadow, 'htmlSelector', sameText),
          createdAt: requiredMs(note.createdAt),
          modifiedAt: requiredMs(note.modifiedAt)
        }
      }))
    }
    for (const reading of database.readingStates) {
      if (!papers.has(reading.paperId)) continue
      await add(`readingState/${reading.paperId}`, (shadow) => {
        const pageIndex = Math.max(0, reading.pageIndex)
        const scrollRatio = keep(clampRatio(reading.scrollRatio), shadow, 'scrollRatio', (raw, value) => clampRatio(raw) === value)
        const position = {
          paperID: keep(wireUUID(reading.paperId), shadow, 'paperID', (raw) => sameUUID(raw, reading.paperId)),
          attachmentID: keep(wire(reading.attachmentId), shadow, 'attachmentID', (raw) => sameUUID(raw, reading.attachmentId)),
          readerMode: keep(reading.readerMode, shadow, 'readerMode', (raw, value) => readerMode(raw) === value),
          pageIndex: keep(pageIndex, shadow, 'pageIndex', (raw, value) => Math.max(0, Number(raw)) === value),
          scrollRatio,
          htmlAnchor: reading.htmlAnchor,
          modifiedAt: requiredMs(reading.modifiedAt)
        }
        return { tag: 'reading', value: position }
      })
    }

    // One translation cache document per paper, as native Freddie exports it.
    for (const paper of papers.values()) {
      const path = this.segments.path(paper.id)
      const { value: segments, stamp } = await stable(path, () => this.segments.read(paper.id))
      if (!segments.length) continue
      const latest = new Map<string, DocumentValue>()
      for (const segment of segments.map(segmentToWire)) {
        const key = translationCacheKey(segment)
        if (!latest.has(key) || Number(segment.modifiedAt) > Number(latest.get(key)!.modifiedAt)) latest.set(key, segment)
      }
      const unique = [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, segment]) => segment)
      await add(`translationSegment/${paper.id}`, (shadow) => ({
        tag: 'translations',
        value: { paperID: keep(wireUUID(paper.id), shadow, 'paperID', (raw) => sameUUID(raw, paper.id)), segments: unique }
      }), stamp ? new Map([[path, stamp]]) : new Map())
    }

    for (const attachment of database.attachments) {
      const paper = papers.get(attachment.paperId)
      // The translated LaTeX project is a build folder; only its PDF syncs.
      if (!paper || (attachment.kind === 'resource' && attachment.source === 'latexTrans')) continue
      const key = `attachment/${attachment.id}`
      const scope = { paperId: attachment.paperId }
      let path: string | undefined
      try {
        path = scopedFile(this.root, scope, attachment.filename)
      } catch {
        path = undefined
      }
      if (path) {
        try {
          if ((await stat(path)).isDirectory()) {
            // Folder attachments are device-local output, not a missing file.
            result.unavailable.add(key)
            continue
          }
        } catch {
          // Missing; reported below.
        }
      }
      let reason: UnavailableAttachment['reason'] | undefined
      if (!path) reason = 'outsideLibrary'
      else {
        try {
          reason = (await readStamp(path)) ? undefined : 'missing'
        } catch {
          reason = 'unreadable'
        }
      }
      if (reason || !path) {
        // One missing or foreign file must not stop the whole library from syncing.
        result.unavailable.add(key)
        result.unavailableAttachments.push({ id: attachment.id, paperId: paper.id, paperTitle: paper.title, filename: basename(attachment.filename), path: path ?? join(this.store.paperDirectory(paper.id), attachment.filename), reason: reason ?? 'outsideLibrary' })
      } else {
        const { file, stamp } = await this.blobs.captureFile(path, scope)
        await add(key, (shadow) => ({ tag: 'attachment', value: attachmentValue(attachment, file, shadow) }), new Map([[path!, stamp]]))
        const diagnostics = `${path}.diagnostics.json`
        if (existsSync(diagnostics)) await this.addResource(add, scope, diagnostics)
      }
      // Annotations sync one by one, also while their PDF is unavailable here.
      const sidecar = this.annotations.sidecarPath(paper.id, attachment.id)
      const { value: records, stamp } = await stable(sidecar, () => this.annotations.read(paper.id, attachment.id))
      for (const record of records) {
        await add(`pdfAnnotation/${record.id.toLowerCase()}`, (shadow) => ({
          tag: 'annotation',
          value: {
            paperID: keep(wireUUID(paper.id), shadow, 'paperID', (raw) => sameUUID(raw, paper.id)),
            attachmentID: keep(wireUUID(attachment.id), shadow, 'attachmentID', (raw) => sameUUID(raw, attachment.id)),
            annotation: annotationToWire(record)
          }
        }), stamp ? new Map([[sidecar, stamp]]) : new Map())
      }
    }
    for (const paper of papers.values()) {
      const directory = scopeDirectory(this.root, { paperId: paper.id })
      for (const folder of paperResourceFolders) {
        for (const path of await resourceFiles(join(directory, folder))) await this.addResource(add, { paperId: paper.id }, path)
      }
    }

    for (const metadata of await this.writings.loadAll()) {
      if (blockedWritings.has(metadata.id)) continue
      const scope = { writingId: metadata.id }
      const markdownPath = this.writings.markdownPath(metadata.id)
      const { file, stamp } = await this.blobs.captureFile(markdownPath, scope)
      if (file.size > 32 * 1024 * 1024) throw new SyncError('A sync document exceeds the supported size.')
      const markdown = await readFile(await this.blobs.uploadFile(file.hash), 'utf8')
      await add(`writing/${metadata.id}`, (shadow) => {
        // The file and creation date decide; titles and save times differ between the apps.
        if (shadow && filesEqual(shadow.file, file) && shadow.createdAt === requiredMs(metadata.createdAt)) return { tag: 'writing', value: shadow }
        return {
          tag: 'writing',
          value: {
            id: keep(wireUUID(metadata.id), shadow, 'id', (raw) => sameUUID(raw, metadata.id)),
            title: deriveWritingTitle(markdown),
            createdAt: requiredMs(metadata.createdAt),
            modifiedAt: Math.max(requiredMs(metadata.modifiedAt), Math.round(stamp.modified)),
            file
          }
        }
      }, new Map([[markdownPath, stamp]]))
      const directory = this.writings.directory(metadata.id)
      for (const folder of writingResourceFolders) {
        for (const path of await resourceFiles(join(directory, folder))) await this.addResource(add, scope, path)
      }
    }
    await this.blobs.saveFingerprints()
    return result
  }

  private async addResource(
    add: (key: string, build: (shadow: DocumentValue | undefined) => SyncDocument, stamps?: Map<string, Stamp>) => Promise<void>,
    scope: { paperId?: string; writingId?: string },
    path: string
  ): Promise<void> {
    const { file, stamp } = await this.blobs.captureFile(path, scope)
    const document: SyncDocument = { tag: 'resource', value: { scope: scopeToWire(scope), file } }
    await add(documentKey(document), (shadow) => ({
      tag: 'resource',
      value: shadow && filesEqual(shadow.file, file) ? shadow : document.value
    }), new Map([[path, stamp]]))
  }

  // MARK: Apply

  canApply(document: SyncDocument, creatingPapers: Set<string>, creatingWritings: Set<string>): boolean {
    if (document.tag === 'paper' || document.tag === 'folder' || document.tag === 'writing') return true
    const scope = documentScope(document)
    if (scope.paperId) return creatingPapers.has(scope.paperId) || this.store.database.papers.some((paper) => paper.id === scope.paperId)
    if (scope.writingId) return creatingWritings.has(scope.writingId) || existsSync(this.writings.markdownPath(scope.writingId))
    return true
  }

  /**
   * Publishes downloaded files, then removes and upserts records with one library write.
   * Replaced and deleted files are kept in `Sync/Recovery`; on failure everything is put back.
   */
  async apply(changes: Change[]): Promise<{ paperIds: Set<string>; writingIds: Set<string> }> {
    const paperIds = new Set<string>()
    const writingIds = new Set<string>()
    if (!changes.length) return { paperIds, writingIds }
    const recovery = join(this.root, 'Sync', 'Recovery', randomUUID())
    await mkdir(recovery, { recursive: true, mode: 0o700 })
    const deletedWritings = new Set<string>()
    const undo: Array<{ destination: string; backup?: string }> = []
    const moved: Array<{ original: string; backup: string }> = []
    const backup = async (path: string): Promise<string | undefined> => {
      if (!existsSync(path)) return undefined
      const target = join(recovery, randomUUID())
      await link(path, target).catch(() => copyFile(path, target))
      return target
    }
    const preserve = async (path: string): Promise<void> => {
      if (!existsSync(path)) return
      const target = join(recovery, `${randomUUID()}-${basename(path)}`)
      await rename(path, target)
      moved.push({ original: path, backup: target })
    }
    const publish = async (temporary: string, destination: string): Promise<void> => {
      const previous = await backup(destination)
      await rename(temporary, destination)
      undo.push({ destination, backup: previous })
    }
    const publishText = async (destination: string, text: string): Promise<void> => {
      const temporary = join(dirname(destination), `.SyncIncoming-${randomUUID()}`)
      await atomicWriteFile(temporary, text)
      await publish(temporary, destination)
    }
    // Annotations are written once per attachment and batch, like native Freddie's sidecars.
    const deletedPapers = new Set(changes.filter((change) => change.record.deleted && change.previous?.tag === 'paper').map((change) => documentScope(change.previous!).paperId!))
    const annotationGroups = new Map<string, { paperId: string; records: Map<string, PdfAnnotationRecord> }>()
    for (const change of changes) {
      const document = change.record.deleted ? change.previous : change.document
      if (document?.tag !== 'annotation') continue
      const paperId = localUUID(document.value.paperID)!
      const attachmentId = localUUID(document.value.attachmentID)!
      if (deletedPapers.has(paperId)) continue
      let group = annotationGroups.get(attachmentId)
      if (!group) {
        const existing = await this.annotations.read(paperId, attachmentId).catch(() => [] as PdfAnnotationRecord[])
        group = { paperId, records: new Map(existing.map((record) => [record.id.toUpperCase(), record])) }
        annotationGroups.set(attachmentId, group)
      }
      const id = String((document.value.annotation as DocumentValue).id).toUpperCase()
      const record = annotationFromWire(document.value.annotation)
      if (change.record.deleted) group.records.delete(id)
      else if (record) group.records.set(id, record)
    }
    try {
      for (const [attachmentId, group] of annotationGroups) {
        const records = [...group.records.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
        await publishText(this.annotations.sidecarPath(group.paperId, attachmentId), sidecarJSON(group.paperId, attachmentId, records))
        paperIds.add(group.paperId)
      }
      for (const change of changes) {
        for (const file of change.files) {
          // Revalidate every path right before publication, after all awaits.
          if (change.document) for (const value of documentFiles(change.document)) scopedFile(this.root, documentScope(change.document), value.relativePath)
          await publish(file.temporary, file.destination)
        }
        if (change.record.deleted) {
          const previous = change.previous
          if (!previous) continue
          const scope = documentScope(previous)
          if (previous.tag === 'paper') await preserve(scopeDirectory(this.root, scope))
          if (previous.tag === 'writing') await preserve(scopeDirectory(this.root, scope))
          if (previous.tag === 'resource') await preserve(scopedFile(this.root, scope, (previous.value.file as SyncFile).relativePath))
          if (previous.tag === 'translations') await preserve(this.segments.path(scope.paperId!))
          if (scope.paperId) paperIds.add(scope.paperId)
          if (scope.writingId) writingIds.add(scope.writingId)
          if (previous.tag === 'writing') deletedWritings.add(scope.writingId!)
        } else if (change.document) {
          const document = change.document
          const scope = documentScope(document)
          if (document.tag === 'paper') await mkdir(scopeDirectory(this.root, scope), { recursive: true })
          if (document.tag === 'translations') {
            // The received cache replaces this paper's, as native Freddie applies it.
            const segments = (document.value.segments as DocumentValue[]).map(segmentFromWire)
            await publishText(this.segments.path(scope.paperId!), `${JSON.stringify({ segments })}\n`)
          }
          if (document.tag === 'writing') {
            // The Markdown is already in place; rebuild meta.json the way a local save does.
            const id = scope.writingId!
            const markdownPath = this.writings.markdownPath(id)
            const markdown = await readFile(markdownPath, 'utf8')
            const createdAt = iso(document.value.createdAt)!
            const modifiedAt = iso(document.value.modifiedAt)!
            const metadataPath = join(this.writings.directory(id), 'meta.json')
            const temporary = join(dirname(metadataPath), `.SyncIncoming-${randomUUID()}`)
            await atomicWriteFile(temporary, `${JSON.stringify(makeMetadata(id, markdown, createdAt, modifiedAt), null, 2)}\n`)
            await publish(temporary, metadataPath)
            // A download must not look like a new local edit just because it arrived now.
            const time = new Date(Number(document.value.modifiedAt))
            await utimes(markdownPath, time, time)
            await utimes(metadataPath, time, time)
          }
          // Open readers and editors reload when their files change.
          if (document.tag === 'attachment' || document.tag === 'resource' || document.tag === 'writing') {
            if (scope.paperId) paperIds.add(scope.paperId)
            if (scope.writingId) writingIds.add(scope.writingId)
          }
        }
      }
      await this.store.applySync((database) => {
        for (const change of changes) {
          if (change.record.deleted) {
            if (change.previous) remove(database, change.previous)
          } else if (change.document) {
            upsert(database, change.document)
          }
        }
        if (database.settings.currentWritingId && deletedWritings.has(database.settings.currentWritingId)) delete database.settings.currentWritingId
      })
      // Deletions stay in Recovery; backups of successful replacements are discarded.
      for (const item of undo) if (item.backup) await rm(item.backup, { force: true })
      if (!(await readdir(recovery)).length) await rm(recovery, { recursive: true, force: true })
    } catch (error) {
      for (const item of moved.reverse()) await rename(item.backup, item.original).catch(() => undefined)
      for (const item of undo.reverse()) {
        if (item.backup) await rename(item.backup, item.destination).catch(() => undefined)
        else await rm(item.destination, { force: true })
      }
      throw error
    }
    return { paperIds, writingIds }
  }

  /** Copies a writing and its images under a new identifier, for "Keep Both Writings". */
  async duplicateWriting(document: SyncDocument, resources: SyncDocument[], title: string): Promise<string> {
    const writingId = documentScope(document).writingId!
    const markdown = await readFile(await this.blobs.uploadFile((document.value.file as SyncFile).hash), 'utf8')
    const renamed = renameWriting(markdown, title)
    const metadata = await this.writings.create(renamed)
    for (const resource of resources) {
      if (resource.tag !== 'resource' || documentScope(resource).writingId !== writingId) continue
      const file = resource.value.file as SyncFile
      const target = scopedFile(this.root, { writingId: metadata.id }, file.relativePath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(await this.blobs.uploadFile(file.hash), target)
    }
    return metadata.id
  }
}

/** Replaces the first heading's text, or adds one, like native `WritingTitle.renaming`. */
function renameWriting(markdown: string, title: string): string {
  const match = /^(#{1,6})[ \t]+.*$/m.exec(markdown)
  if (match && markdown.slice(0, match.index).trim() === '') return `${markdown.slice(0, match.index)}${match[1]} ${title}${markdown.slice(match.index + match[0].length)}`
  return `# ${title}\n\n${markdown}`
}

function paperValue(paper: Paper, shadow: DocumentValue | undefined): DocumentValue {
  return {
    id: keep(wireUUID(paper.id), shadow, 'id', (raw) => sameUUID(raw, paper.id)),
    arxivID: keep(paper.arxivId, shadow, 'arxivID', sameText),
    arxivVersion: keep(paper.arxivVersion, shadow, 'arxivVersion', sameText),
    doi: keep(paper.doi, shadow, 'doi', sameText),
    title: paper.title,
    abstractText: paper.abstract,
    authorsStorage: keep(normalizedList(paper.authors).join('\n'), shadow, 'authorsStorage', (raw) => sameList(raw, paper.authors)),
    categoriesStorage: keep(normalizedList(paper.categories).join('\n'), shadow, 'categoriesStorage', (raw) => sameList(raw, paper.categories)),
    publishedAt: ms(paper.publishedAt),
    updatedAt: ms(paper.updatedAt),
    pdfURLString: keep(paper.pdfUrl, shadow, 'pdfURLString', sameText),
    htmlURLString: keep(paper.htmlUrl, shadow, 'htmlURLString', sameText),
    tagsStorage: keep(normalizedList(paper.tags).join('\n'), shadow, 'tagsStorage', (raw) => sameList(raw, paper.tags)),
    isFavorite: paper.isFavorite,
    createdAt: requiredMs(paper.createdAt),
    modifiedAt: requiredMs(paper.modifiedAt)
  }
}

function attachmentValue(attachment: Attachment, file: SyncFile, shadow: DocumentValue | undefined): DocumentValue {
  const samePath = shadow && (shadow.file as SyncFile | undefined)?.relativePath === file.relativePath
  return {
    id: keep(wireUUID(attachment.id), shadow, 'id', (raw) => sameUUID(raw, attachment.id)),
    paperID: keep(wireUUID(attachment.paperId), shadow, 'paperID', (raw) => sameUUID(raw, attachment.paperId)),
    kind: keep(attachment.kind, shadow, 'kind', (raw, value) => kind(raw) === value),
    source: keep(attachment.source, shadow, 'source', (raw, value) => source(raw) === value),
    // Native Freddie keeps a display name beside the path; this app only has the path.
    filename: samePath && typeof shadow!.filename === 'string' ? shadow!.filename : basename(file.relativePath),
    file,
    translatedLastPage: attachment.translatedLastPage,
    createdAt: requiredMs(attachment.createdAt)
  }
}

function upsert(database: Database, document: SyncDocument): void {
  const value = document.value
  switch (document.tag) {
    case 'paper': {
      const id = localUUID(value.id)!
      const paper: Paper = {
        id,
        arxivId: text(value.arxivID),
        arxivVersion: text(value.arxivVersion),
        doi: text(value.doi),
        title: String(value.title),
        abstract: String(value.abstractText),
        authors: list(value.authorsStorage),
        categories: list(value.categoriesStorage),
        tags: list(value.tagsStorage),
        publishedAt: iso(value.publishedAt),
        updatedAt: iso(value.updatedAt),
        pdfUrl: text(value.pdfURLString),
        htmlUrl: text(value.htmlURLString),
        isFavorite: Boolean(value.isFavorite),
        createdAt: iso(value.createdAt)!,
        modifiedAt: iso(value.modifiedAt)!
      }
      for (const key of Object.keys(paper) as Array<keyof Paper>) if (paper[key] === undefined) delete paper[key]
      const index = database.papers.findIndex((item) => item.id === id)
      if (index >= 0) database.papers[index] = paper
      else database.papers.unshift(paper)
      break
    }
    case 'attachment': {
      const id = localUUID(value.id)!
      const attachment: Attachment = {
        id,
        paperId: localUUID(value.paperID)!,
        kind: kind(value.kind),
        source: source(value.source),
        filename: (value.file as SyncFile).relativePath,
        ...(typeof value.translatedLastPage === 'number' ? { translatedLastPage: value.translatedLastPage } : {}),
        createdAt: iso(value.createdAt)!
      }
      const index = database.attachments.findIndex((item) => item.id === id)
      if (index >= 0) database.attachments[index] = attachment
      else database.attachments.push(attachment)
      break
    }
    case 'folder': {
      const id = localUUID(value.id)!
      const folder = { id, name: String(value.name), ...(localUUID(value.parentID) ? { parentId: localUUID(value.parentID) } : {}), createdAt: iso(value.createdAt)!, modifiedAt: iso(value.modifiedAt)! }
      const index = database.folders.findIndex((item) => item.id === id)
      if (index >= 0) database.folders[index] = folder
      else database.folders.push(folder)
      break
    }
    case 'membership': {
      const paperId = localUUID(value.paperID)!
      database.memberships = database.memberships.filter((item) => item.paperId !== paperId)
      database.memberships.push({ paperId, folderId: localUUID(value.folderID)!, addedAt: iso(value.addedAt)! })
      break
    }
    case 'itemType': {
      const paperId = localUUID(value.paperID)!
      database.itemTypeAssignments = database.itemTypeAssignments.filter((item) => item.paperId !== paperId)
      database.itemTypeAssignments.push({ paperId, itemType: String(value.rawValue), assignedAt: iso(value.assignedAt)! })
      break
    }
    case 'note': {
      const id = localUUID(value.id)!
      const note = {
        id,
        paperId: localUUID(value.paperID)!,
        ...(localUUID(value.attachmentID) ? { attachmentId: localUUID(value.attachmentID) } : {}),
        quote: String(value.quote),
        body: String(value.body),
        ...(typeof value.pageIndex === 'number' ? { pageIndex: value.pageIndex } : {}),
        ...(text(value.htmlSelector) ? { htmlSelector: text(value.htmlSelector) } : {}),
        createdAt: iso(value.createdAt)!,
        modifiedAt: iso(value.modifiedAt)!
      }
      const index = database.notes.findIndex((item) => item.id === id)
      if (index >= 0) database.notes[index] = note
      else database.notes.push(note)
      break
    }
    case 'reading': {
      const paperId = localUUID(value.paperID)!
      const index = database.readingStates.findIndex((item) => item.paperId === paperId)
      // Zoom stays a preference of each device.
      const zoomScale = index >= 0 ? database.readingStates[index].zoomScale : 1
      const state = {
        paperId,
        ...(localUUID(value.attachmentID) ? { attachmentId: localUUID(value.attachmentID) } : {}),
        readerMode: readerMode(value.readerMode),
        pageIndex: Math.max(0, Number(value.pageIndex)),
        scrollRatio: clampRatio(value.scrollRatio),
        zoomScale,
        ...(text(value.htmlAnchor) ? { htmlAnchor: text(value.htmlAnchor) } : {}),
        modifiedAt: iso(value.modifiedAt)!
      }
      if (index >= 0) database.readingStates[index] = state
      else database.readingStates.push(state)
      break
    }
    default:
      // Resource and writing files are already in place; opaque kinds are kept by the sync state.
      break
  }
}

function remove(database: Database, document: SyncDocument): void {
  const value = document.value
  const id = localUUID(value.id)
  const paperId = localUUID(value.paperID)
  switch (document.tag) {
    case 'paper':
      database.papers = database.papers.filter((item) => item.id !== id)
      database.attachments = database.attachments.filter((item) => item.paperId !== id)
      database.notes = database.notes.filter((item) => item.paperId !== id)
      database.readingStates = database.readingStates.filter((item) => item.paperId !== id)
      database.memberships = database.memberships.filter((item) => item.paperId !== id)
      database.itemTypeAssignments = database.itemTypeAssignments.filter((item) => item.paperId !== id)
      if (database.settings.lastOpenedPaperId === id) delete database.settings.lastOpenedPaperId
      break
    case 'attachment':
      database.attachments = database.attachments.filter((item) => item.id !== id)
      break
    case 'folder':
      // Memberships are records of their own; one pointing to a missing folder shows as Unfiled.
      database.folders = database.folders.filter((item) => item.id !== id)
      database.settings.collapsedFolderIds = database.settings.collapsedFolderIds.filter((item) => item !== id)
      break
    case 'membership':
      database.memberships = database.memberships.filter((item) => item.paperId !== paperId)
      break
    case 'itemType':
      database.itemTypeAssignments = database.itemTypeAssignments.filter((item) => item.paperId !== paperId)
      break
    case 'note':
      database.notes = database.notes.filter((item) => item.id !== id)
      break
    case 'reading':
      database.readingStates = database.readingStates.filter((item) => item.paperId !== paperId)
      break
    default:
      break
  }
}
