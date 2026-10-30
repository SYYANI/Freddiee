import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../files'
import { scopedFile, scopedRelativePath } from './paths'
import {
  decodeDocument,
  documentFiles,
  documentIdentity,
  documentScope,
  documentTitle,
  encodeDocument,
  maximumDocumentSize,
  maximumFileSize,
  scopeToWire,
  SyncError,
  validateHash,
  type Envelope,
  type Scope,
  type SyncDocument,
  type SyncEntry,
  type SyncFile
} from './types'

export interface Stamp {
  size: number
  modified: number
  inode: number
}

export const stampsEqual = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
  (!a && !b) || (Boolean(a && b) && a!.size === b!.size && a!.modified === b!.modified && a!.inode === b!.inode)

/** Undefined for a missing file; throws for links and special files. */
export async function readStamp(path: string): Promise<Stamp | undefined> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile()) throw new SyncError('Sync cannot read a symbolic link or special file.')
  return { size: info.size, modified: info.mtimeMs, inode: info.ino }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Flushes a file that was just copied, so a crash cannot publish an empty one. */
async function flush(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface PreparedFile {
  temporary: string
  destination: string
}

/**
 * Immutable, content-addressed copies of everything sync reads or downloads, in
 * `Sync/Blobs/{sha256}`. Uploads and conflict recovery read these copies, never a file
 * the user may still be changing.
 */
export class BlobStore {
  readonly cache: string
  private readonly fingerprintsPath: string
  private fingerprints = new Map<string, { stamp: Stamp; hash: string }>()
  private sources = new Map<string, string>()
  private documents = new Map<string, SyncDocument>()

  constructor(readonly root: string) {
    this.cache = join(root, 'Sync', 'Blobs')
    this.fingerprintsPath = join(root, 'Sync', 'file-fingerprints.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.cache, { recursive: true, mode: 0o700 })
    try {
      // Only an optimization: a damaged cache just means hashing again.
      const stored = JSON.parse(await readFile(this.fingerprintsPath, 'utf8')) as Record<string, { stamp: Stamp; hash: string }>
      this.fingerprints = new Map(Object.entries(stored))
    } catch {
      this.fingerprints = new Map()
    }
  }

  blobPath(hash: string): string {
    validateHash(hash)
    return join(this.cache, hash)
  }

  async contains(hash: string): Promise<boolean> {
    return (await readStamp(this.blobPath(hash))) !== undefined
  }

  /** Stores an encoded document and returns its entry. */
  async entry(document: SyncDocument): Promise<SyncEntry> {
    const bytes = Buffer.from(encodeDocument(document), 'utf8')
    if (bytes.length > maximumDocumentSize) throw new SyncError('A sync document exceeds the supported size.')
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!(await this.contains(hash))) await atomicWriteFile(this.blobPath(hash), bytes, 0o600)
    this.documents.set(hash, document)
    return makeEntry(document, hash)
  }

  /** A document already in the cache, decoded and checked; parsed documents are reused. */
  async document(envelope: Envelope): Promise<SyncDocument> {
    if (envelope.schemaVersion !== 1) throw new SyncError('This synced document requires a newer version of Freddie.')
    const cached = this.documents.get(envelope.documentHash)
    if (cached) return cached
    const path = this.blobPath(envelope.documentHash)
    const stamp = await readStamp(path)
    if (!stamp || stamp.size > maximumDocumentSize) throw new SyncError('A sync document exceeds the supported size.')
    const document = decodeDocument(await readFile(path), envelope, (scope, relativePath) => {
      scopedFile(this.root, scope, relativePath)
    })
    this.documents.set(envelope.documentHash, document)
    return document
  }

  async retainDownload(downloaded: string, hash: string, maximumSize: number): Promise<void> {
    try {
      const stamp = await readStamp(downloaded)
      if (!stamp || stamp.size > maximumSize || (await hashFile(downloaded)) !== hash) {
        throw new SyncError('The downloaded file failed its size or SHA-256 check.')
      }
      const destination = this.blobPath(hash)
      if (await this.contains(hash)) return
      await rename(downloaded, destination).catch(async () => {
        await copyFile(downloaded, destination)
      })
      await flush(destination)
    } finally {
      await rm(downloaded, { force: true })
    }
  }

  /** Hashes a library file through a private copy and records where uploads can find it. */
  async captureFile(path: string, scope: Scope): Promise<{ file: SyncFile; stamp: Stamp }> {
    const relativePath = scopedRelativePath(this.root, scope, path)
    if (!relativePath) throw new SyncError('An attachment is outside the managed paper library.')
    const before = await readStamp(path)
    if (!before) throw SyncError.fileChanged()
    if (before.size > maximumFileSize) throw new SyncError('A synced file exceeds the supported size.')
    let hash: string
    const cached = this.fingerprints.get(path)
    if (cached && stampsEqual(cached.stamp, before)) {
      hash = cached.hash
    } else {
      const temporary = join(this.cache, `.snapshot-${randomUUID()}`)
      try {
        await copyFile(path, temporary)
        hash = await hashFile(temporary)
        if (!stampsEqual(await readStamp(path), before)) throw SyncError.fileChanged()
        if (!(await this.contains(hash))) await rename(temporary, this.blobPath(hash))
      } finally {
        await rm(temporary, { force: true })
      }
      this.fingerprints.set(path, { stamp: before, hash })
    }
    this.sources.set(hash, path)
    return { file: { relativePath, hash, size: before.size }, stamp: before }
  }

  /** A stable copy of a blob for upload or recovery. */
  async uploadFile(hash: string): Promise<string> {
    const destination = this.blobPath(hash)
    if (await this.contains(hash)) return destination
    const source = this.sources.get(hash)
    if (!source) throw SyncError.fileChanged()
    const temporary = join(this.cache, `.upload-${randomUUID()}`)
    try {
      await copyFile(source, temporary)
      if ((await hashFile(temporary)) !== hash) throw SyncError.fileChanged()
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
    return destination
  }

  async saveFingerprints(): Promise<void> {
    await atomicWriteFile(this.fingerprintsPath, JSON.stringify(Object.fromEntries(this.fingerprints)), 0o600)
  }

  resetSources(): void {
    this.sources.clear()
  }

  /** Copies a document's files next to their destinations, ready to be renamed into place. */
  async prepare(document: SyncDocument): Promise<PreparedFile[]> {
    const prepared: PreparedFile[] = []
    try {
      for (const file of documentFiles(document)) {
        const destination = scopedFile(this.root, documentScope(document), file.relativePath)
        const source = this.blobPath(file.hash)
        if ((await readStamp(source))?.size !== file.size) throw new SyncError('The downloaded file failed its size or SHA-256 check.')
        await mkdir(dirname(destination), { recursive: true })
        const temporary = join(dirname(destination), `.SyncIncoming-${randomUUID()}`)
        await copyFile(source, temporary)
        await flush(temporary)
        prepared.push({ temporary, destination })
      }
      return prepared
    } catch (error) {
      await Promise.all(prepared.map((file) => rm(file.temporary, { force: true })))
      throw error
    }
  }

  async cleanCache(keeping: Set<string>): Promise<void> {
    for (const name of await readdir(this.cache)) {
      if (keeping.has(name)) continue
      await rm(join(this.cache, name), { force: true })
      this.documents.delete(name)
    }
  }

  /** Keeps both versions' blobs and entries before a conflict is resolved toward the server. */
  async preserve(entries: SyncEntry[]): Promise<void> {
    const directory = join(this.root, 'Sync', 'Recovery', `Conflict-${randomUUID()}`)
    await mkdir(join(directory, 'Blobs'), { recursive: true, mode: 0o700 })
    for (const hash of new Set(entries.flatMap((entry) => entry.blobs))) {
      const source = await this.uploadFile(hash)
      await link(source, join(directory, 'Blobs', hash)).catch(() => copyFile(source, join(directory, 'Blobs', hash)))
    }
    await atomicWriteFile(join(directory, 'entries.json'), JSON.stringify(entries.map((entry) => ({ ...entry, scope: scopeToWire(entry.scope) }))), 0o600)
  }
}

export function makeEntry(document: SyncDocument, hash: string): SyncEntry {
  const { kind, id } = documentIdentity(document)
  const scope = documentScope(document)
  return {
    kind,
    id,
    payload: { schemaVersion: 1, documentHash: hash, scope },
    blobs: [...new Set([hash, ...documentFiles(document).map((file) => file.hash)])].sort(),
    scope,
    title: documentTitle(document)
  }
}

/** Every regular file below a folder, skipping hidden files and derived caches. */
export async function resourceFiles(directory: string): Promise<string[]> {
  try {
    if (!(await stat(directory)).isDirectory()) return []
  } catch {
    return []
  }
  const result: string[] = []
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new SyncError('Sync cannot read a symbolic link or special file.')
      if (entry.isDirectory()) {
        if (!['Outline', 'LaTeXSemantic', 'ScanRebuild', 'BabelDOC'].includes(entry.name)) await visit(path)
      } else if (entry.isFile()) {
        result.push(path)
      }
    }
  }
  await visit(directory)
  return result.sort()
}
