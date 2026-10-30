import { createHash } from 'node:crypto'
import { annotationFromWire, annotationSwiftValue } from './records'
import { encodeSwiftJSON, SwiftDouble, type SwiftJSONValue } from './swiftJSON'

// The sync protocol and its document format are defined by native Freddie
// (`../read-paper`, ReadPaper/Services/LibrarySync) and the Freddie Sync Server.
// Documents keep native field names, uppercase UUIDs and dates in milliseconds;
// identifiers and scopes inside this app are lowercase.

export const maximumDocumentSize = 32 * 1024 * 1024
export const maximumFileSize = 512 * 1024 * 1024

export class SyncError extends Error {
  constructor(message: string, readonly detail?: { status?: number; code?: string; retryAfter?: number; current?: SyncRecord | null; fileChanged?: boolean; args?: Array<string | number> }) {
    super(message)
  }

  static fileChanged(): SyncError {
    return new SyncError('A file is still changing. Sync will retry shortly.', { fileChanged: true })
  }

  /** The server refused without committing, so replaying the same request can only fail again. */
  get rejectsRequest(): boolean {
    const status = this.detail?.status
    if (status === undefined || this.detail?.current !== undefined) return false
    return status === 507 || (status >= 400 && status < 500 && ![401, 408, 429].includes(status))
  }

  get isConflict(): boolean {
    return this.detail?.current !== undefined
  }
}

export interface Scope {
  paperId?: string
  writingId?: string
}

export interface Envelope {
  schemaVersion: 1
  documentHash: string
  scope?: Scope
}

export interface SyncRecord {
  kind: string
  id: string
  revision: number
  deleted: boolean
  payload?: Envelope
  blobs: string[]
  deviceID: string
  updatedAt: string
}

export interface SyncMutation {
  kind: string
  id: string
  baseRevision: number
  deleted: boolean
  restore: boolean
  payload?: Envelope
  blobs: string[]
}

export interface SyncEntry {
  kind: string
  id: string
  payload: Envelope
  blobs: string[]
  scope: Scope
  title: string
}

export interface SyncInfo {
  protocolVersion: number
  storeID: string
  libraryID: string
  deviceID: string
}

export interface SyncConfiguration {
  baseURL: string
  deviceID: string
  libraryID: string
  label: string
  isEnabled: boolean
}

export interface SyncFile {
  relativePath: string
  hash: string
  size: number
}

/** The Swift enum cases of `LibrarySyncDocument.Content`, keyed by record kind. */
export const documentTags = {
  paper: 'paper',
  attachment: 'attachment',
  folder: 'folder',
  folderMembership: 'membership',
  itemType: 'itemType',
  note: 'note',
  readingState: 'reading',
  translationSegment: 'translations',
  pdfAnnotation: 'annotation',
  htmlState: 'resource',
  writing: 'writing'
} as const

export type RecordKind = keyof typeof documentTags
export type DocumentTag = (typeof documentTags)[RecordKind]

export type DocumentValue = Record<string, unknown>

export interface SyncDocument {
  tag: DocumentTag
  value: DocumentValue
}

const tagKinds = Object.fromEntries(Object.entries(documentTags).map(([kind, tag]) => [tag, kind])) as Record<DocumentTag, RecordKind>

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUUID = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value)

/** Lowercase for local use; undefined for anything that is not a UUID. */
export function localUUID(value: unknown): string | undefined {
  return isUUID(value) ? value.toLowerCase() : undefined
}

/** The form Swift's `UUID` encodes to. */
export function wireUUID(value: string): string {
  return value.toUpperCase()
}

export function validateHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new SyncError('The synced file hash is not valid.')
}

function requireUUID(value: unknown): string {
  const id = localUUID(value)
  if (!id) throw new SyncError('The synced document does not match its record.')
  return id
}

export function documentKind(document: SyncDocument): RecordKind {
  return tagKinds[document.tag]
}

export function documentIdentity(document: SyncDocument): { kind: RecordKind; id: string } {
  const value = document.value
  const kind = documentKind(document)
  switch (document.tag) {
    case 'membership':
    case 'itemType':
    case 'reading':
    case 'translations':
      return { kind, id: requireUUID(value.paperID) }
    case 'annotation':
      return { kind, id: requireUUID((value.annotation as DocumentValue | undefined)?.id) }
    case 'resource': {
      const scope = documentScope(document)
      return { kind, id: sha256(`${scope.paperId ?? scope.writingId ?? ''}/${(value.file as SyncFile).relativePath}`) }
    }
    default:
      return { kind, id: requireUUID(value.id) }
  }
}

export function documentKey(document: SyncDocument): string {
  const { kind, id } = documentIdentity(document)
  return `${kind}/${id}`
}

export function documentScope(document: SyncDocument): Scope {
  const value = document.value
  switch (document.tag) {
    case 'paper':
      return { paperId: requireUUID(value.id) }
    case 'folder':
      return {}
    case 'writing':
      return { writingId: requireUUID(value.id) }
    case 'resource':
      return scopeFromWire(value.scope)
    default:
      return { paperId: requireUUID(value.paperID) }
  }
}

export function documentFiles(document: SyncDocument): SyncFile[] {
  if (document.tag === 'attachment' || document.tag === 'resource' || document.tag === 'writing') return [document.value.file as SyncFile]
  return []
}

export function documentTitle(document: SyncDocument): string {
  const value = document.value
  switch (document.tag) {
    case 'paper':
    case 'writing':
      return String(value.title ?? '')
    case 'folder':
      return String(value.name ?? '')
    case 'attachment':
      return String(value.filename ?? '')
    case 'resource':
      return (value.file as SyncFile).relativePath
    default:
      return documentKind(document)
  }
}

export function scopeFromWire(value: unknown): Scope {
  if (!value || typeof value !== 'object') throw new SyncError('The synced document scope is not valid.')
  const raw = value as Record<string, unknown>
  const paperId = raw.paperID === undefined ? undefined : requireUUID(raw.paperID)
  const writingId = raw.writingID === undefined ? undefined : requireUUID(raw.writingID)
  return { ...(paperId ? { paperId } : {}), ...(writingId ? { writingId } : {}) }
}

export function scopeToWire(scope: Scope): { paperID?: string; writingID?: string } {
  return { ...(scope.paperId ? { paperID: wireUUID(scope.paperId) } : {}), ...(scope.writingId ? { writingID: wireUUID(scope.writingId) } : {}) }
}

export const scopesEqual = (a: Scope | undefined, b: Scope | undefined): boolean => (a?.paperId ?? '') === (b?.paperId ?? '') && (a?.writingId ?? '') === (b?.writingId ?? '')

export function entriesEqual(a: SyncEntry | undefined | null, b: SyncEntry | undefined | null): boolean {
  if (!a || !b) return !a && !b
  return a.kind === b.kind && a.id === b.id && a.title === b.title &&
    a.payload.documentHash === b.payload.documentHash && a.payload.schemaVersion === b.payload.schemaVersion &&
    scopesEqual(a.payload.scope, b.payload.scope) && scopesEqual(a.scope, b.scope) &&
    a.blobs.length === b.blobs.length && a.blobs.every((hash, index) => hash === b.blobs[index])
}

/** The translation cache identity, as native Freddie computes it. */
export function translationCacheKey(segment: DocumentValue): string {
  return [segment.sourceType, segment.targetLanguage, segment.sourceHash, localUUID(segment.providerProfileID) ?? '', localUUID(segment.modelProfileID) ?? '', segment.modelName].map((part) => String(part ?? '')).join('|')
}

// MARK: Encoding

/** Swift's encoding of a document; received documents that are unchanged keep their original bytes. */
export function encodeDocument(document: SyncDocument): string {
  const value: Record<string, SwiftJSONValue | undefined> = { ...(document.value as Record<string, SwiftJSONValue | undefined>) }
  if (document.tag === 'reading') value.scrollRatio = new SwiftDouble(Number(document.value.scrollRatio))
  if (document.tag === 'annotation') value.annotation = annotationSwiftValue(document.value.annotation as DocumentValue)
  return encodeSwiftJSON({ content: { [document.tag]: { _0: value } }, schemaVersion: 1 })
}

// MARK: Decoding

const string = (value: unknown): value is string => typeof value === 'string'
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const optional = (check: (value: unknown) => boolean) => (value: unknown): boolean => value === undefined || value === null || check(value)
const uuid = (value: unknown): boolean => isUUID(value)

const fields: Record<DocumentTag, Record<string, (value: unknown) => boolean>> = {
  paper: {
    id: uuid, title: string, abstractText: string, authorsStorage: string, categoriesStorage: string, tagsStorage: string,
    isFavorite: (value) => typeof value === 'boolean', createdAt: integer, modifiedAt: integer,
    arxivID: optional(string), arxivVersion: optional(string), doi: optional(string), publishedAt: optional(integer),
    updatedAt: optional(integer), pdfURLString: optional(string), htmlURLString: optional(string)
  },
  attachment: { id: uuid, paperID: uuid, kind: string, source: string, filename: string, createdAt: integer, translatedLastPage: optional(integer) },
  folder: { id: uuid, name: string, createdAt: integer, modifiedAt: integer, parentID: optional(uuid) },
  membership: { paperID: uuid, folderID: uuid, addedAt: integer },
  itemType: { paperID: uuid, rawValue: string, assignedAt: integer },
  note: { id: uuid, paperID: uuid, quote: string, body: string, createdAt: integer, modifiedAt: integer, attachmentID: optional(uuid), pageIndex: optional(integer), htmlSelector: optional(string) },
  reading: { paperID: uuid, readerMode: string, pageIndex: integer, scrollRatio: (value) => typeof value === 'number' && Number.isFinite(value), modifiedAt: integer, attachmentID: optional(uuid), htmlAnchor: optional(string) },
  translations: { paperID: uuid, segments: Array.isArray },
  annotation: { paperID: uuid, attachmentID: uuid, annotation: (value) => annotationFromWire(value) !== undefined },
  resource: { scope: (value) => Boolean(value) && typeof value === 'object' },
  writing: { id: uuid, title: string, createdAt: integer, modifiedAt: integer }
}

function validFile(value: unknown): value is SyncFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Record<string, unknown>
  return string(file.relativePath) && string(file.hash) && integer(file.size)
}

export const paperResourceFolders = ['Resources']
export const writingResourceFolders = ['assets']

/**
 * Parses and checks a received document like native Freddie's `LibrarySyncFiles.document`.
 * `checkPath` validates each file path for the document's scope.
 */
export function decodeDocument(bytes: Uint8Array | string, envelope: Envelope | undefined, checkPath: (scope: Scope, path: string) => void): SyncDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new SyncError('The synced document does not match its record.')
  }
  const root = parsed as { schemaVersion?: unknown; content?: unknown }
  if (!root || typeof root !== 'object' || root.schemaVersion !== 1) throw new SyncError('This synced document requires a newer version of Freddie.')
  const content = root.content as Record<string, unknown> | undefined
  const tags = content && typeof content === 'object' ? Object.keys(content) : []
  const tag = tags[0] as DocumentTag
  if (tags.length !== 1 || !(tag in fields)) throw new SyncError('This synced document requires a newer version of Freddie.')
  const value = (content![tag] as { _0?: unknown } | undefined)?._0 as DocumentValue | undefined
  if (!value || typeof value !== 'object') throw new SyncError('The synced document does not match its record.')
  for (const [key, check] of Object.entries(fields[tag])) {
    if (!check(value[key])) throw new SyncError('The synced document does not match its record.')
  }
  const document: SyncDocument = { tag, value }
  const scope = documentScope(document)
  if (envelope?.scope && !scopesEqual(envelope.scope, scope)) throw new SyncError('The synced document does not match its record.')
  for (const file of documentFiles(document)) {
    if (!validFile(file)) throw new SyncError('The synced document does not match its record.')
    validateHash(file.hash)
    if (file.size < 0 || file.size > maximumFileSize) throw new SyncError('A synced file exceeds the supported size.')
    checkPath(scope, file.relativePath)
  }
  if (tag === 'resource') {
    if (!scope.paperId === !scope.writingId) throw new SyncError('The synced document scope is not valid.')
    const path = (value.file as SyncFile).relativePath
    const allowed = scope.paperId
      ? paperResourceFolders.some((folder) => path.startsWith(`${folder}/`)) || path.endsWith('.pdf.diagnostics.json')
      : writingResourceFolders.some((folder) => path.startsWith(`${folder}/`))
    if (!allowed) throw new SyncError('The synced file path is not safe.')
  }
  if (tag === 'writing') {
    const file = value.file as SyncFile
    if (file.relativePath !== 'writing.md') throw new SyncError('The synced file path is not safe.')
    if (file.size > maximumDocumentSize) throw new SyncError('A sync document exceeds the supported size.')
  }
  if (tag === 'attachment') {
    const lastPage = value.translatedLastPage
    if ((value.file as SyncFile).relativePath.startsWith('notes/') || (integer(lastPage) && lastPage <= 0)) {
      throw new SyncError('The synced attachment metadata is not valid.')
    }
  }
  if (tag === 'translations') {
    const segments = value.segments as DocumentValue[]
    const segmentFields: Record<string, (value: unknown) => boolean> = {
      id: uuid, sourceType: string, targetLanguage: string, sourceHash: string, sourceText: string, translatedText: string, modelName: string,
      createdAt: integer, modifiedAt: integer, providerProfileID: optional(uuid), modelProfileID: optional(uuid)
    }
    if (!segments.every((segment) => segment && typeof segment === 'object' && Object.entries(segmentFields).every(([key, check]) => check(segment[key]))) ||
      new Set(segments.map((segment) => localUUID(segment.id))).size !== segments.length ||
      new Set(segments.map(translationCacheKey)).size !== segments.length) {
      throw new SyncError('The synced translation cache is not valid.')
    }
  }
  return document
}

// MARK: Wire parsing

export function parseEnvelope(value: unknown): Envelope | undefined {
  if (value === undefined || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw !== 'object' || raw.schemaVersion !== 1) throw new SyncError('This synced document requires a newer version of Freddie.')
  validateHash(raw.documentHash)
  return { schemaVersion: 1, documentHash: raw.documentHash, ...(raw.scope !== undefined && raw.scope !== null ? { scope: scopeFromWire(raw.scope) } : {}) }
}

export function envelopeToWire(envelope: Envelope): Record<string, unknown> {
  return { schemaVersion: 1, documentHash: envelope.documentHash, ...(envelope.scope ? { scope: scopeToWire(envelope.scope) } : {}) }
}

export function parseRecord(value: unknown): SyncRecord {
  const raw = value as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || !string(raw.kind) || !string(raw.id) || !integer(raw.revision) || raw.revision <= 0 ||
    typeof raw.deleted !== 'boolean' || !Array.isArray(raw.blobs)) {
    throw new SyncError('The sync server response is not valid.')
  }
  const blobs = raw.blobs as unknown[]
  blobs.forEach(validateHash)
  return {
    kind: raw.kind,
    // Native Freddie uses lowercase identifiers for records (`librarySyncID`).
    id: raw.id,
    revision: raw.revision,
    deleted: raw.deleted,
    payload: parseEnvelope(raw.payload),
    blobs: [...(blobs as string[])],
    deviceID: string(raw.deviceID) ? raw.deviceID : '',
    updatedAt: string(raw.updatedAt) ? raw.updatedAt : ''
  }
}

export const recordKey = (value: { kind: string; id: string }): string => `${value.kind}/${value.id}`
