import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { SyncConflictChoice, SyncStatus } from '../../../shared/sync'
import type { Translator } from '../../../shared/i18n'
import type { FreddieStore } from '../store'
import type { WritingStore } from '../writings'
import { SyncClient, validatedBaseURL, type SyncTransport } from './client'
import { BlobStore, type PreparedFile } from './files'
import { mergeDocuments } from './merge'
import { filesAreCurrent, SyncRepository, type Change, type Snapshot, type UnavailableAttachment } from './repository'
import { acceptRecord, emptyState, priority, sortIncoming, stage, SyncLease, SyncStateStore, type PendingPush, type SyncState } from './state'
import {
  documentFiles,
  documentIdentity,
  documentScope,
  documentTitle,
  entriesEqual,
  localUUID,
  maximumDocumentSize,
  recordKey,
  scopesEqual,
  sha256,
  SyncError,
  type Scope,
  type SyncConfiguration,
  type SyncDocument,
  type SyncEntry,
  type SyncRecord
} from './types'

export interface SyncTokenStore {
  setSyncToken(account: string, token: string): Promise<void>
  syncToken(account: string): Promise<string | undefined>
}

export interface SyncHost {
  root: string
  store: FreddieStore
  writings: WritingStore
  tokens: SyncTokenStore
  translator: () => Translator
  /** Papers being translated, annotated or edited; their records wait until the work ends. */
  busyPapers: () => Set<string>
  /** Writings with unsaved edits in an editor. */
  busyWritings: () => Set<string>
  /** Papers shown in a reader or the Inspector; deletions of them wait until they close. */
  openPapers: () => Set<string>
  /** Notes being edited; neither they nor their paper are replaced meanwhile. */
  editingNotes: () => Set<string>
  onStatus: (status: SyncStatus) => void
  onApplied: (paperIds: string[], writingIds: string[]) => void
  makeTransport?: (baseURL: string, token: string) => SyncTransport
}

const account = (configuration: SyncConfiguration): string => sha256(`${configuration.baseURL}|${configuration.deviceID}`)
const sameValue = (a: SyncDocument, b: SyncDocument): boolean => a.tag === b.tag && JSON.stringify(a.value) === JSON.stringify(b.value)

/** The counterpart of native `LibrarySyncController`, for this app's library. */
export class SyncController {
  private configuration?: SyncConfiguration
  private state: SyncState = emptyState()
  private readonly persistence: SyncStateStore
  private readonly blobs: BlobStore
  private readonly repository: SyncRepository
  private readonly makeTransport: (baseURL: string, token: string) => SyncTransport
  private isSyncing = false
  private statusKey = 'Sync is not connected.'
  private errorMessage?: string
  private progressCompleted = 0
  private progressTotal = 0
  private needsHistoryReview = false
  private unavailable: UnavailableAttachment[] = []
  private failures = 0
  private nextAttempt = 0
  private timer?: ReturnType<typeof setInterval>
  private lastAttempt = 0

  constructor(private readonly host: SyncHost) {
    this.persistence = new SyncStateStore(host.root)
    this.blobs = new BlobStore(host.root)
    this.repository = new SyncRepository(host.root, host.store, host.writings, this.blobs)
    this.makeTransport = host.makeTransport ?? ((baseURL, token) => new SyncClient(baseURL, token))
  }

  async initialize(): Promise<void> {
    try {
      await this.blobs.initialize()
      this.configuration = await this.persistence.loadConfiguration()
      if (this.configuration) {
        this.state = await this.persistence.load(this.configuration)
        this.statusKey = 'Ready to sync.'
      }
    } catch (error) {
      this.errorMessage = this.describe(error)
    }
    this.publish()
  }

  /** Syncs every 30 seconds while a window is focused, and every 5 minutes otherwise. */
  start(isForeground: () => boolean): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!this.configuration?.isEnabled || Date.now() < this.nextAttempt) return
      if (!isForeground() && Date.now() - this.lastAttempt < 5 * 60_000) return
      void this.syncNow()
    }, 30_000)
    if (this.configuration?.isEnabled) void this.syncNow()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Called when the app returns to the foreground. */
  foregrounded(): void {
    if (this.timer && this.configuration?.isEnabled && Date.now() >= this.nextAttempt) void this.syncNow()
  }

  get status(): SyncStatus {
    return {
      ...(this.configuration ? { configuration: { server: this.configuration.baseURL, label: this.configuration.label, isEnabled: this.configuration.isEnabled } } : {}),
      isSyncing: this.isSyncing,
      statusKey: this.statusKey,
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      ...(this.state.lastSuccess ? { lastSuccess: this.state.lastSuccess } : {}),
      pendingCount: this.state.outbox.length + Object.keys(this.state.incoming).length,
      progressCompleted: this.progressCompleted,
      progressTotal: this.progressTotal,
      needsHistoryReview: this.needsHistoryReview,
      conflicts: Object.values(this.state.conflicts).sort((a, b) => (a.id < b.id ? -1 : 1)).map((conflict) => ({
        id: conflict.id,
        title: conflict.title,
        remoteDeleted: conflict.remote.deleted,
        localDeleted: !conflict.local,
        isWriting: conflict.local?.kind === 'writing'
      })),
      unavailableAttachments: this.unavailable.map((item) => ({ id: item.id, paperTitle: item.paperTitle, filename: item.filename, reason: item.reason }))
    }
  }

  /** Where an attachment that cannot sync is, for "Show in File Manager". */
  unavailablePath(id: string): string | undefined {
    return this.unavailable.find((item) => item.id === id)?.path
  }

  /** The server a credential points to, before anything is uploaded to it. */
  credentialServer(json: string): { server: string; isNew: boolean } {
    const credential = this.parseCredential(json)
    return { server: credential.baseURL, isNew: credential.baseURL !== this.configuration?.baseURL }
  }

  private parseCredential(json: string): { baseURL: string; token: string; device: { id: string; libraryID: string; label: string } } {
    if (Buffer.byteLength(json) > 64 * 1024) throw new SyncError('The device credential is not valid.')
    let value: { baseURL?: unknown; token?: unknown; device?: { id?: unknown; libraryID?: unknown; label?: unknown } }
    try {
      value = JSON.parse(json) as typeof value
    } catch {
      throw new SyncError('The device credential is not valid.')
    }
    const device = value?.device
    if (typeof value?.token !== 'string' || typeof device?.id !== 'string' || typeof device.libraryID !== 'string' || typeof device.label !== 'string') {
      throw new SyncError('The device credential is not valid.')
    }
    return { baseURL: validatedBaseURL(value.baseURL), token: value.token, device: { id: device.id, libraryID: device.libraryID, label: device.label } }
  }

  async connect(json: string): Promise<boolean> {
    if (this.isSyncing) return false
    this.isSyncing = true
    this.statusKey = 'Checking connection…'
    this.errorMessage = undefined
    this.publish()
    try {
      const credential = this.parseCredential(json)
      const info = await this.makeTransport(credential.baseURL, credential.token).info()
      if (info.protocolVersion !== 1 || info.deviceID !== credential.device.id || info.libraryID !== credential.device.libraryID) {
        throw new SyncError('The credential does not match this server or library.')
      }
      const candidate: SyncConfiguration = { baseURL: credential.baseURL, deviceID: info.deviceID, libraryID: info.libraryID, label: credential.device.label, isEnabled: true }
      const saved = await this.persistence.load(candidate)
      await this.host.tokens.setSyncToken(account(candidate), credential.token)
      await this.persistence.saveConfiguration(candidate)
      this.configuration = candidate
      this.state = saved
      this.nextAttempt = 0
      this.failures = 0
      this.statusKey = 'Ready to sync.'
      return true
    } catch (error) {
      this.errorMessage = this.host.translator()('Unable to connect sync: %@', this.describe(error))
      return false
    } finally {
      this.isSyncing = false
      this.publish()
    }
  }

  async setAutomatic(value: boolean): Promise<void> {
    if (!this.configuration) return
    const next = { ...this.configuration, isEnabled: value }
    await this.persistence.saveConfiguration(next)
    this.configuration = next
    this.publish()
  }

  // MARK: Sync

  async syncNow(): Promise<void> {
    const configuration = this.configuration
    if (this.isSyncing || !configuration) return
    this.isSyncing = true
    this.errorMessage = undefined
    this.progressCompleted = 0
    this.progressTotal = 0
    this.lastAttempt = Date.now()
    this.publish()
    let lease: SyncLease | undefined
    try {
      lease = await SyncLease.acquire(this.host.root)
      this.state = await this.persistence.load(configuration)
      const offline = await this.snapshot()
      stage(this.state, offline.entries, this.uploadProtectedKeys(offline))
      await this.save()
      await this.blobs.cleanCache(this.retainedBlobHashes())
      const client = await this.client(configuration)
      this.setStatus('Checking connection…')
      const info = await client.info()
      if (info.protocolVersion !== 1 || info.libraryID !== configuration.libraryID || info.deviceID !== configuration.deviceID) {
        throw new SyncError('The credential does not match this server or library.')
      }
      const previous = this.state.info
      if (previous && (previous.storeID !== info.storeID || previous.libraryID !== info.libraryID)) {
        this.needsHistoryReview = true
        throw new SyncError('The server history has changed. Review it before continuing sync.')
      }
      this.state.info = info
      await this.save()
      const pending = this.state.inFlight
      if (pending) {
        if (pending.deviceID === info.deviceID) {
          try {
            await this.send(pending, client)
          } catch (error) {
            // Nothing was committed; staging rebuilds the request and re-checks its blobs.
            if (!(error instanceof SyncError && error.rejectsRequest)) throw error
            this.state.inFlight = undefined
            await this.save()
          }
        } else {
          // A replacement credential cannot replay another device's receipt.
          this.state.inFlight = undefined
          this.state.outbox = []
          await this.save()
        }
      }
      this.setStatus('Fetching library changes…')
      let boundary: number | undefined
      for (;;) {
        let page
        try {
          page = await client.changes(this.state.cursor, boundary)
        } catch (error) {
          if (error instanceof SyncError && error.detail?.status === 409 && error.detail.code === 'invalid_cursor') {
            this.needsHistoryReview = true
            throw new SyncError('The server history has changed. Review it before continuing sync.')
          }
          throw error
        }
        if (page.cursor < this.state.cursor || (page.hasMore && page.cursor <= this.state.cursor)) throw new SyncError('The sync server response is not valid.')
        boundary ??= page.headRevision
        for (const record of page.changes) {
          const key = recordKey(record)
          if (record.revision <= (this.state.known[key]?.revision ?? 0)) continue
          if ((this.state.incoming[key]?.revision ?? 0) < record.revision) this.state.incoming[key] = record
        }
        this.state.cursor = page.cursor
        await this.save() // A durable inbox first; applying can resume after a crash.
        if (!page.hasMore) break
      }
      let uploaded = false
      // A revision conflict queues the server's newer record; apply it and try again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.progressTotal = 0
        this.progressCompleted = 0
        while (await this.applyIncoming(client)) { /* Next batch. */ }
        const snapshot = await this.snapshot()
        for (const [key, entry] of snapshot.entries) {
          const known = this.state.known[key]
          if (!known || known.entry || this.state.explicitRestores.includes(key) || this.state.conflicts[key]) continue
          this.state.conflicts[key] = { id: key, title: entry.title, local: entry, remote: { kind: entry.kind, id: entry.id, revision: known.revision, deleted: true, blobs: [], deviceID: '', updatedAt: '' } }
        }
        stage(this.state, snapshot.entries, this.uploadProtectedKeys(snapshot))
        await this.save()
        uploaded = await this.upload(snapshot, info.deviceID, client)
        if (uploaded) break
      }
      this.failures = 0
      this.nextAttempt = 0
      if (uploaded) this.state.lastSuccess = new Date().toISOString()
      await this.save()
      this.statusKey = Object.keys(this.state.conflicts).length ? 'Some changes need review.'
        : !uploaded ? 'Some changes will upload on the next sync.'
          : Object.keys(this.state.incoming).length || this.host.busyPapers().size || this.host.busyWritings().size ? 'Waiting for open documents…' : 'Up to date'
      await this.blobs.cleanCache(this.retainedBlobHashes())
    } catch (error) {
      this.failures += 1
      let wait = Math.min(300, 2 ** Math.min(this.failures, 7)) + Math.random() * 3
      const requested = error instanceof SyncError ? error.detail?.retryAfter : undefined
      if (requested !== undefined) wait = Math.max(wait, Math.min(requested, 3600))
      this.nextAttempt = Date.now() + wait * 1000
      this.errorMessage = this.host.translator()('Unable to sync: %@', this.describe(error))
      this.statusKey = 'Sync needs attention.'
    } finally {
      await lease?.release()
      this.isSyncing = false
      this.publish()
    }
  }

  private async client(configuration: SyncConfiguration): Promise<SyncTransport> {
    const token = await this.host.tokens.syncToken(account(configuration))
    if (!token) throw new SyncError('Import a device credential to connect sync.')
    return this.makeTransport(configuration.baseURL, token)
  }

  /** Returns false when the server rejected a batch for a revision conflict. */
  private async upload(snapshot: Snapshot, deviceID: string, client: SyncTransport): Promise<boolean> {
    this.setStatus('Uploading changes…')
    const confirmed = new Set<string>()
    this.progressTotal = new Set(this.state.outbox.flatMap((mutation) => mutation.blobs)).size
    this.progressCompleted = 0
    while (this.state.outbox.length) {
      const mutations = this.state.outbox.slice(0, 100)
      const entries: Record<string, SyncEntry> = {}
      for (const mutation of mutations) {
        const entry = snapshot.entries.get(recordKey(mutation))
        if (entry) entries[recordKey(mutation)] = entry
      }
      const pending: PendingPush = { request: { requestID: randomUUID(), mutations }, entries, deviceID }
      for (const hash of [...new Set(mutations.flatMap((mutation) => mutation.blobs))].filter((hash) => !confirmed.has(hash)).sort()) {
        if (!(await client.hasBlob(hash))) await client.upload(await this.blobs.uploadFile(hash), hash)
        confirmed.add(hash)
        this.progressCompleted += 1
        this.publish()
      }
      // Persist the exact request first; the server already has every blob it names.
      this.state.inFlight = pending
      await this.save()
      if (!(await this.send(pending, client))) return false
    }
    return true
  }

  private async send(pending: PendingPush, client: SyncTransport): Promise<boolean> {
    try {
      const receipt = await client.push(pending.request)
      if (receipt.requestID !== pending.request.requestID || receipt.revisions.length !== pending.request.mutations.length || !receipt.revisions.every((revision) => revision > 0)) {
        throw new SyncError('The sync server response is not valid.')
      }
      pending.request.mutations.forEach((mutation, index) => {
        const key = recordKey(mutation)
        const entry = pending.entries[key]
        this.state.known[key] = { revision: receipt.revisions[index], ...(entry ? { entry } : {}), scope: entry?.scope ?? this.state.known[key]?.scope ?? {} }
        this.state.explicitRestores = this.state.explicitRestores.filter((item) => item !== key)
      })
      const keys = new Set(pending.request.mutations.map(recordKey))
      this.state.outbox = this.state.outbox.filter((mutation) => !keys.has(recordKey(mutation)))
      this.state.inFlight = undefined
      await this.save()
      return true
    } catch (error) {
      if (!(error instanceof SyncError && error.isConflict)) throw error
      this.state.inFlight = undefined
      const current = error.detail?.current
      if (current) this.state.incoming[recordKey(current)] = current
      await this.save()
      return false
    }
  }

  /** Saved local state, retried until nothing was written while it was read. */
  private async snapshot(): Promise<Snapshot> {
    this.setStatus('Checking local changes…')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const papers = this.host.busyPapers()
      const writings = this.host.busyWritings()
      const generation = this.repository.generation
      let snapshot: Snapshot
      try {
        snapshot = await this.repository.snapshot(this.state, papers, writings)
      } catch (error) {
        if (error instanceof SyncError && error.detail?.fileChanged) continue
        throw error
      }
      if (this.repository.generation !== generation || !sameSet(this.host.busyPapers(), papers) || !sameSet(this.host.busyWritings(), writings)) continue
      this.unavailable = snapshot.unavailableAttachments.sort((a, b) => (a.paperTitle + a.filename).localeCompare(b.paperTitle + b.filename))
      return snapshot
    }
    throw SyncError.fileChanged()
  }

  private blocked(scope: Scope | undefined): boolean {
    if (!scope) return false
    return Boolean((scope.paperId && this.host.busyPapers().has(scope.paperId)) || (scope.writingId && this.host.busyWritings().has(scope.writingId)))
  }

  /** Keys staging must leave alone. */
  private uploadProtectedKeys(snapshot: Snapshot): Set<string> {
    const keys = this.protectedKeys(snapshot)
    for (const key of snapshot.unavailable) keys.add(key)
    for (const key of Object.keys(this.state.incoming)) keys.add(key)
    return keys
  }

  private protectedKeys(snapshot: Snapshot): Set<string> {
    const keys = new Set<string>()
    for (const [key, known] of Object.entries(this.state.known)) if (this.blocked(known.scope)) keys.add(key)
    for (const [key, entry] of snapshot.entries) if (this.blocked(entry.scope)) keys.add(key)
    const deletedPapers = new Set(Object.values(this.state.conflicts).filter((conflict) => conflict.remote.kind === 'paper' && conflict.remote.deleted).map((conflict) => localUUID(conflict.remote.id)))
    for (const [key, known] of Object.entries(this.state.known)) if (known.scope.paperId && deletedPapers.has(known.scope.paperId)) keys.add(key)
    for (const [key, entry] of snapshot.entries) if (entry.scope.paperId && deletedPapers.has(entry.scope.paperId)) keys.add(key)
    for (const id of this.host.editingNotes()) {
      const key = `note/${id}`
      keys.add(key)
      const paperId = snapshot.entries.get(key)?.scope.paperId ?? this.state.known[key]?.scope.paperId
      if (paperId) keys.add(`paper/${paperId}`)
    }
    return keys
  }

  private async downloadedDocument(record: SyncRecord, client: SyncTransport): Promise<SyncDocument | undefined> {
    if (record.deleted) return undefined
    const envelope = record.payload
    if (!envelope || !record.blobs.includes(envelope.documentHash)) throw new SyncError('The sync server response is not valid.')
    await this.ensureBlob(envelope.documentHash, maximumDocumentSize, client)
    const document = await this.blobs.document(envelope)
    const identity = documentIdentity(document)
    const expected = new Set([envelope.documentHash, ...documentFiles(document).map((file) => file.hash)])
    if (identity.kind !== record.kind || identity.id !== record.id || new Set(record.blobs).size !== expected.size || !record.blobs.every((hash) => expected.has(hash))) {
      throw new SyncError('The synced document does not match its record.')
    }
    for (const file of documentFiles(document)) await this.ensureBlob(file.hash, file.size, client)
    return document
  }

  private async ensureBlob(hash: string, maximumSize: number, client: SyncTransport): Promise<void> {
    if (await this.blobs.contains(hash)) return
    await this.blobs.retainDownload(await client.download(hash, this.blobs.cache), hash, maximumSize)
  }

  private remoteEntry(record: SyncRecord, document: SyncDocument): SyncEntry {
    return { kind: record.kind, id: record.id, payload: record.payload!, blobs: [...record.blobs].sort(), scope: documentScope(document), title: documentTitle(document) }
  }

  /** Applies one batch of queued records; true when more remain and progress was made. */
  private async applyIncoming(client: SyncTransport): Promise<boolean> {
    if (!Object.keys(this.state.incoming).length) return false
    const records = sortIncoming(Object.values(this.state.incoming))
    this.setStatus('Downloading changes…')
    const documents = new Map<string, SyncDocument>()
    const previousDocuments = new Map<string, SyncDocument>()
    const prepared = new Map<string, PreparedFile[]>()
    const batch: SyncRecord[] = []
    let madeProgress = false
    this.progressTotal = Math.max(this.progressTotal, this.progressCompleted + records.length)
    try {
      for (const record of records) {
        if (batch.length >= 50) break
        const key = recordKey(record)
        const known = this.state.known[key]
        if (this.blocked(known?.scope)) continue
        // Readers still show an open paper; delete it once it is closed.
        if (record.deleted && known?.scope.paperId && this.host.openPapers().has(known.scope.paperId)) continue
        if (record.revision <= (known?.revision ?? 0)) {
          delete this.state.incoming[key]
          madeProgress = true
          this.progressCompleted += 1
          continue
        }
        const document = await this.downloadedDocument(record, client)
        if (document) {
          if (this.blocked(documentScope(document))) continue
          documents.set(key, document)
          prepared.set(key, await this.blobs.prepare(document))
        }
        batch.push(record)
        if (known?.entry) previousDocuments.set(key, await this.blobs.document(known.entry.payload))
        this.progressCompleted += 1
        this.publish()
      }
      const local = await this.snapshot()
      const protectedKeys = this.protectedKeys(local)
      const conflictingPaperDeletions = new Set<string>()
      for (const deletion of [...Object.values(this.state.incoming), ...Object.values(this.state.conflicts).map((conflict) => conflict.remote)]) {
        if (deletion.kind !== 'paper' || !deletion.deleted) continue
        const paperId = localUUID(deletion.id)
        if (!paperId) continue
        const dirtyChild = [...local.entries.entries()].some(([key, entry]) => entry.kind !== 'readingState' && entry.scope.paperId === paperId &&
          (!entriesEqual(entry, this.state.known[key]?.entry) || (this.state.known[key]?.revision ?? 0) > deletion.revision))
        const laterRemoteChild = Object.values(this.state.incoming).some((record) => !record.deleted && record.kind !== 'readingState' && record.payload?.scope?.paperId === paperId && record.revision > deletion.revision)
        if (dirtyChild || laterRemoteChild || this.state.conflicts[recordKey(deletion)]) conflictingPaperDeletions.add(paperId)
      }
      const creating = (tag: 'paper' | 'writing'): Set<string> => new Set([...documents.entries()]
        .filter(([key, document]) => document.tag === tag && entriesEqual(local.entries.get(key), this.state.known[key]?.entry))
        .map(([, document]) => localUUID(document.value.id)!))
      const creatingPapers = creating('paper')
      const creatingWritings = creating('writing')
      const changes: Change[] = []
      const accepted: Array<[SyncRecord, SyncEntry | undefined, Scope]> = []
      for (const record of batch) {
        const key = recordKey(record)
        const known = this.state.known[key]
        if (record.revision <= (known?.revision ?? 0)) continue
        // A missing attachment file is not a local edit; the remote version restores it.
        const own = local.entries.get(key) ?? (local.unavailable.has(key) ? known?.entry : undefined)
        const document = documents.get(key)
        const scope = document ? documentScope(document) : own?.scope ?? known?.scope ?? {}
        if (record.kind !== 'paper' && scope.paperId && conflictingPaperDeletions.has(scope.paperId)) continue
        if (protectedKeys.has(key) || this.blocked(scope)) continue
        if (document && !this.repository.canApply(document, creatingPapers, creatingWritings)) {
          // Wait while the parent is still queued; otherwise it was deleted here, so ask.
          const parent = scope.paperId ? `paper/${scope.paperId}` : scope.writingId ? `writing/${scope.writingId}` : undefined
          if (parent && this.state.incoming[parent] && !this.state.incoming[parent].deleted) continue
          this.state.conflicts[key] = { id: key, title: documentTitle(document), remote: record }
          delete this.state.incoming[key]
          madeProgress = true
          continue
        }
        if (!(await filesAreCurrent(local, key))) continue
        const remote = document ? this.remoteEntry(record, document) : undefined
        if (entriesEqual(own, remote)) {
          accepted.push([record, remote, scope])
          madeProgress = true
          continue
        }
        let isClean = entriesEqual(own, known?.entry)
        if (document && documentFiles(document).some((incoming) => [...local.documents.entries()].some(([otherKey, existing]) =>
          otherKey !== key && scopesEqual(documentScope(existing), scope) && documentFiles(existing).some((file) => file.relativePath === incoming.relativePath && file.hash !== incoming.hash)))) {
          isClean = false
        }
        if (record.kind === 'paper' && record.deleted && scope.paperId && conflictingPaperDeletions.has(scope.paperId)) isClean = false
        const localDocument = local.documents.get(key)
        if (!isClean && localDocument && document) {
          const merged = mergeDocuments(previousDocuments.get(key), localDocument, document)
          if (merged) {
            if (!sameValue(merged, localDocument)) changes.push({ record, document: merged, previous: previousDocuments.get(key), files: [] })
            accepted.push([record, remote, scope])
            madeProgress = true
            continue
          }
        }
        if (isClean) {
          changes.push({ record, document, previous: previousDocuments.get(key) ?? localDocument, files: prepared.get(key) ?? [] })
          accepted.push([record, remote, scope])
        } else {
          this.state.conflicts[key] = { id: key, title: own?.title ?? (document ? documentTitle(document) : record.kind), ...(own ? { local: own } : {}), remote: record }
          delete this.state.incoming[key]
        }
        madeProgress = true
      }
      this.setStatus('Applying changes…')
      changes.sort((a, b) => priority(a.record.kind, a.record.deleted) - priority(b.record.kind, b.record.deleted))
      const applied = await this.repository.apply(changes)
      for (const [record, entry, scope] of accepted) acceptRecord(this.state, record, entry, scope)
      await this.save()
      if (applied.paperIds.size || applied.writingIds.size) this.host.onApplied([...applied.paperIds], [...applied.writingIds])
      return madeProgress && Object.keys(this.state.incoming).length > 0
    } finally {
      for (const files of prepared.values()) for (const file of files) await rm(file.temporary, { force: true })
    }
  }

  async reviewChangedHistory(): Promise<void> {
    if (this.isSyncing || !this.configuration) return
    try {
      await this.persistence.archive(this.state, `History-${randomUUID()}.json`)
      this.state = emptyState()
      await this.persistence.save(this.state, this.configuration)
      this.needsHistoryReview = false
      this.errorMessage = undefined
      this.nextAttempt = 0
    } catch (error) {
      this.errorMessage = this.describe(error)
    }
    this.publish()
  }

  async resolve(id: string, choice: SyncConflictChoice): Promise<void> {
    const configuration = this.configuration
    const conflict = this.state.conflicts[id]
    if (this.isSyncing || !configuration || !conflict) return
    this.isSyncing = true
    this.errorMessage = undefined
    this.publish()
    let prepared: PreparedFile[] = []
    try {
      const client = await this.client(configuration)
      const document = await this.downloadedDocument(conflict.remote, client)
      if (document) prepared = await this.blobs.prepare(document)
      const knownEntry = this.state.known[id]?.entry
      const knownDocument = knownEntry ? await this.blobs.document(knownEntry.payload) : undefined
      const local = await this.snapshot()
      const own = local.entries.get(id)
      const scope = document ? documentScope(document) : own?.scope ?? this.state.known[id]?.scope ?? {}
      if (this.blocked(scope)) throw new SyncError('Finish editing this document before resolving its sync conflict.')
      if (choice !== 'thisDevice' && conflict.remote.deleted && scope.paperId && this.host.openPapers().has(scope.paperId)) {
        throw new SyncError('Close this paper before accepting this deletion.')
      }
      if (choice !== 'thisDevice' && document && !this.repository.canApply(document, new Set(), new Set())) {
        throw new SyncError("This change belongs to a paper or writing deleted on this device. Keep this device's version to discard it.")
      }
      if (choice === 'thisDevice') {
        this.state.known[id] = { revision: conflict.remote.revision, ...(document ? { entry: this.remoteEntry(conflict.remote, document) } : {}), scope }
        if (conflict.remote.deleted) this.state.explicitRestores.push(id)
        if (conflict.remote.kind === 'paper' && conflict.remote.deleted && scope.paperId) {
          for (const [key, pending] of Object.entries(this.state.incoming)) {
            const entry = local.entries.get(key)
            if (key === id || entry?.scope.paperId !== scope.paperId) continue
            const baseline = pending.payload ? { kind: pending.kind, id: pending.id, payload: pending.payload, blobs: [...pending.blobs].sort(), scope: entry.scope, title: entry.title } : undefined
            this.state.known[key] = { revision: pending.revision, ...(pending.deleted || !baseline ? {} : { entry: baseline }), scope: entry.scope }
            if (pending.deleted) this.state.explicitRestores.push(key)
            delete this.state.incoming[key]
          }
        }
      } else {
        const group = (snapshot: Snapshot): Map<string, SyncEntry> => new Map([...snapshot.entries].filter(([key, entry]) =>
          key === id || (scope.paperId !== undefined && entry.scope.paperId === scope.paperId) || (scope.writingId !== undefined && entry.scope.writingId === scope.writingId)))
        const before = group(local)
        await this.blobs.preserve([...before.values()])
        const localDocument = local.documents.get(id)
        if (choice === 'keepBoth' && localDocument?.tag === 'writing') {
          await this.repository.duplicateWriting(localDocument, [...local.documents.values()], this.host.translator()('%@ (conflict copy)', documentTitle(localDocument)))
        }
        const current = await this.snapshot()
        const after = group(current)
        // A duplicated writing adds its own scope; the conflict's scope must be unchanged.
        if (after.size !== before.size || [...before].some(([key, entry]) => !entriesEqual(entry, after.get(key))) || !(await filesAreCurrent(current, id))) {
          throw SyncError.fileChanged()
        }
        const applied = await this.repository.apply([{ record: conflict.remote, document, previous: current.documents.get(id) ?? knownDocument, files: prepared }])
        acceptRecord(this.state, conflict.remote, document ? this.remoteEntry(conflict.remote, document) : undefined, scope)
        this.host.onApplied([...applied.paperIds], [...applied.writingIds])
      }
      delete this.state.conflicts[id]
      delete this.state.incoming[id]
      await this.save()
      this.isSyncing = false
      await this.syncNow()
    } catch (error) {
      this.errorMessage = this.host.translator()('Unable to resolve sync conflict: %@', this.describe(error))
    } finally {
      for (const file of prepared) await rm(file.temporary, { force: true })
      this.isSyncing = false
      this.publish()
    }
  }

  // MARK: Helpers

  private async save(): Promise<void> {
    if (this.configuration) await this.persistence.save(this.state, this.configuration)
    this.publish()
  }

  private retainedBlobHashes(): Set<string> {
    const retained = new Set<string>()
    for (const known of Object.values(this.state.known)) {
      if (known.entry) retained.add(known.entry.payload.documentHash)
      if (known.entry?.kind === 'writing') known.entry.blobs.forEach((hash) => retained.add(hash))
    }
    for (const record of Object.values(this.state.incoming)) record.blobs.forEach((hash) => retained.add(hash))
    for (const conflict of Object.values(this.state.conflicts)) {
      conflict.remote.blobs.forEach((hash) => retained.add(hash))
      conflict.local?.blobs.forEach((hash) => retained.add(hash))
    }
    this.state.inFlight?.request.mutations.forEach((mutation) => mutation.blobs.forEach((hash) => retained.add(hash)))
    this.state.outbox.forEach((mutation) => mutation.blobs.forEach((hash) => retained.add(hash)))
    return retained
  }

  private setStatus(key: string): void {
    this.statusKey = key
    this.publish()
  }

  private publish(): void {
    this.host.onStatus(this.status)
  }

  private describe(error: unknown): string {
    const t = this.host.translator()
    if (error instanceof SyncError) return t(error.message, ...(error.detail?.args ?? []))
    return error instanceof Error ? error.message : String(error)
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item))
}
