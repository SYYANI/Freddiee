import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranslator } from '../shared/i18n'
import type { SyncStatus } from '../shared/sync'
import { FreddieStore } from '../electron/main/store'
import { WritingStore } from '../electron/main/writings'
import type { SyncPage, SyncPush, SyncReceipt, SyncTransport } from '../electron/main/sync/client'
import { SyncController } from '../electron/main/sync/controller'
import { formatSwiftDouble } from '../electron/main/sync/swiftJSON'
import { AnnotationStore } from '../electron/main/annotations'
import { TranslationService } from '../electron/main/translation'
import { newSegment, translationCacheIdentity, TranslationSegmentStore } from '../electron/main/translationSegments'
import { annotationToRecord, boxGeometry, recordToAnnotation } from '../shared/pdfAnnotationGeometry'
import type { PdfAnnotation } from '../shared/types'
import { decodeDocument, documentIdentity, encodeDocument, SyncError, type SyncInfo, type SyncRecord } from '../electron/main/sync/types'
import swiftDocuments from './fixtures/sync/swift-documents.json'

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The protocol as the Freddie Sync Server implements it, kept in memory. */
class TestServer {
  storeID = randomUUID()
  readonly libraryID = randomUUID()
  records = new Map<string, SyncRecord>()
  history: SyncRecord[] = []
  blobs = new Map<string, Buffer>()
  receipts = new Map<string, SyncReceipt>()
  pushes = 0

  transport(deviceID: string): SyncTransport {
    return {
      info: async (): Promise<SyncInfo> => ({ protocolVersion: 1, storeID: this.storeID, libraryID: this.libraryID, deviceID }),
      changes: async (after, until): Promise<SyncPage> => {
        const head = this.history.length
        if (after > head) throw new SyncError('Sync server returned HTTP %d.', { status: 409, code: 'invalid_cursor' })
        const matches = this.history.filter((record) => record.revision > after && record.revision <= (until ?? head))
        const page = matches.slice(0, 7) // Force pagination.
        return { changes: structuredClone(page), cursor: page.at(-1)?.revision ?? after, headRevision: head, hasMore: matches.length > page.length }
      },
      push: async (push: SyncPush): Promise<SyncReceipt> => {
        const key = `${deviceID}/${push.requestID}`
        const previous = this.receipts.get(key)
        if (previous) return previous
        for (const mutation of push.mutations) {
          const current = this.records.get(`${mutation.kind}/${mutation.id}`)
          if ((current?.revision ?? 0) !== mutation.baseRevision || (current?.deleted && !mutation.restore)) {
            throw new SyncError('Some changes need conflict resolution.', { status: 409, code: 'revision_conflict', current: current ? structuredClone(current) : null })
          }
          for (const hash of mutation.blobs) if (!this.blobs.has(hash)) throw new SyncError('Sync server returned HTTP %d.', { status: 409, code: 'missing_blob', args: [409] })
        }
        const revisions = push.mutations.map((mutation) => this.commit({ kind: mutation.kind, id: mutation.id, deleted: mutation.deleted, payload: mutation.payload, blobs: mutation.blobs, deviceID }))
        const receipt = { requestID: push.requestID, revisions }
        this.receipts.set(key, receipt)
        this.pushes += 1
        return receipt
      },
      hasBlob: async (hash) => this.blobs.has(hash),
      upload: async (path, hash) => {
        const data = await readFile(path)
        if (sha(data) !== hash) throw new Error('Upload hash mismatch')
        this.blobs.set(hash, data)
      },
      download: async (hash, directory) => {
        const data = this.blobs.get(hash)
        if (!data) throw new Error('Missing blob')
        const file = join(directory, `.download-${randomUUID()}`)
        await writeFile(file, data)
        return file
      }
    }
  }

  commit(record: Omit<SyncRecord, 'revision' | 'updatedAt'>): number {
    const revision = this.history.length + 1
    const value: SyncRecord = { ...structuredClone(record), revision, updatedAt: '2026-10-30T00:00:00Z' }
    this.records.set(`${record.kind}/${record.id}`, value)
    this.history.push(value)
    return revision
  }

  /** Publishes a document exactly as another app encoded it. */
  publish(json: string, files: Buffer[] = []): void {
    const document = decodeDocument(json, undefined, () => {})
    const { kind, id } = documentIdentity(document)
    const hash = sha(json)
    this.blobs.set(hash, Buffer.from(json))
    for (const file of files) this.blobs.set(sha(file), file)
    const scope = document.tag === 'folder' ? {} : document.tag === 'writing' ? { writingId: id } : { paperId: String(document.value.paperID ?? document.value.id).toLowerCase() }
    this.commit({ kind, id, deleted: false, payload: { schemaVersion: 1, documentHash: hash, scope }, blobs: [...new Set([hash, ...files.map(sha)])].sort(), deviceID: 'native' })
  }
}

interface Device {
  root: string
  store: FreddieStore
  writings: WritingStore
  controller: SyncController
  status: () => SyncStatus
  dirty: Set<string>
}

async function device(server: TestServer): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), 'freddie-sync-'))
  roots.push(root)
  const store = new FreddieStore(root)
  await store.initialize()
  const writings = new WritingStore(store.writingsRoot)
  const tokens = new Map<string, string>()
  const deviceID = randomUUID()
  const dirty = new Set<string>()
  let status: SyncStatus | undefined
  const controller = new SyncController({
    root,
    store,
    writings,
    tokens: { setSyncToken: async (account, token) => void tokens.set(account, token), syncToken: async (account) => tokens.get(account) },
    translator: () => createTranslator('en'),
    busyPapers: () => new Set(),
    busyWritings: () => dirty,
    onStatus: (value) => {
      status = value
    },
    onApplied: () => {},
    makeTransport: () => server.transport(deviceID)
  })
  await controller.initialize()
  const connected = await controller.connect(JSON.stringify({
    baseURL: 'https://sync.example.com/freddie-sync/',
    token: `fs1_${'a'.repeat(64)}`,
    device: { id: deviceID, libraryID: server.libraryID, label: 'Test device' }
  }))
  expect(connected).toBe(true)
  return { root, store, writings, controller, status: () => status!, dirty }
}

async function sync(device: Device): Promise<void> {
  await device.controller.syncNow()
  expect(device.status().errorMessage).toBeUndefined()
}

async function addPaper(device: Device, title = 'A paper'): Promise<{ paperId: string; attachmentId: string }> {
  const paperId = randomUUID()
  const attachmentId = randomUUID()
  const directory = await device.store.ensurePaperDirectory(paperId)
  await writeFile(join(directory, 'paper.pdf'), '%PDF-1.7\nfixture')
  const now = new Date().toISOString()
  await device.store.addPaper(
    { id: paperId, title, abstract: '', authors: ['Ada Lovelace'], categories: [], tags: [], isFavorite: false, createdAt: now, modifiedAt: now },
    [{ id: attachmentId, paperId, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: now }]
  )
  return { paperId, attachmentId }
}

const fixture = (label: string): string => {
  const value = (swiftDocuments as Array<{ label: string; json: string }>).find((item) => item.label === label)
  if (!value) throw new Error(`Missing fixture ${label}`)
  return value.json
}

describe('Swift-compatible encoding', () => {
  it('formats doubles like Swift', () => {
    const cases: Array<[number, string]> = [
      [0, '0'], [-0, '-0'], [1, '1'], [0.5, '0.5'], [0.1, '0.1'], [1e-5, '1e-05'], [1.5e-7, '1.5e-07'], [0.0001, '0.0001'],
      [1e15, '1000000000000000'], [1e16, '1e+16'], [1.2345678901234567e16, '1.2345678901234568e+16'], [1e21, '1e+21'],
      [2.5e-300, '2.5e-300'], [0.30000000000000004, '0.30000000000000004'], [1 / 3, '0.3333333333333333'], [100, '100']
    ]
    for (const [value, expected] of cases) expect(formatSwiftDouble(value)).toBe(expected)
  })

  it('re-encodes every document Swift produced to the same bytes', () => {
    for (const item of swiftDocuments as Array<{ label: string; json: string; kind: string; id: string }>) {
      const document = decodeDocument(item.json, undefined, () => {})
      expect(documentIdentity(document), item.label).toEqual({ kind: item.kind, id: item.id })
      expect(encodeDocument(document), item.label).toBe(item.json)
    }
  })

  it('rejects unsafe paths and unknown document versions', () => {
    const resource = JSON.parse(fixture('resource-writing')) as { content: { resource: { _0: { file: { relativePath: string } } } } }
    resource.content.resource._0.file.relativePath = 'writing.md'
    expect(() => decodeDocument(JSON.stringify(resource), undefined, () => {})).toThrow('The synced file path is not safe.')
    expect(() => decodeDocument(fixture('paper-full').replace('"schemaVersion":1', '"schemaVersion":2'), undefined, () => {})).toThrow('newer version')
  })
})

describe('native formats', () => {
  it('builds the translation cache identity like native Freddie', () => {
    const route = { providerId: 'p', modelId: 'm', modelName: 'gpt-5.6-terra', apiStyle: 'responses' as const, temperature: 1, topP: 0.9, thinkingMode: 'disabled' as const }
    expect(translationCacheIdentity(route)).toBe('model=gpt-5.6-terra|api=responses|temperature=1.0|topP=0.9|maxTokens=default|thinking=disabled|reasoning=default|prompt=academic-v3')
    expect(translationCacheIdentity({ ...route, temperature: undefined, maxTokens: 16000 }, 'term = 术语')).toBe(
      `model=gpt-5.6-terra|api=responses|temperature=default|topP=0.9|maxTokens=16000|thinking=disabled|reasoning=default|prompt=academic-v3|glossary=${sha('term = 术语')}`)
  })

  it('converts annotations between PDF page space and the reader, including a cropped page', () => {
    const geometry = boxGeometry([10, 20, 622, 812])
    const ink: PdfAnnotation = { id: randomUUID(), attachmentId: randomUUID(), pageIndex: 2, type: 'ink', color: '#ff3b30', lineWidth: 2, paths: [[{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }]], createdAt: '' }
    const record = annotationToRecord(ink, geometry, new Date('2026-10-30T12:34:56.789Z'))
    expect(record).toEqual(expect.objectContaining({ id: ink.id.toUpperCase(), kind: 'ink', inkPaths: [[{ x: 10, y: 812 }, { x: 316, y: 614 }]], createdAt: '2026-10-30T12:34:56Z', color: { red: 1, green: 0.231, blue: 0.188, alpha: 1 } }))
    expect(record.bounds).toEqual({ x: 8, y: 612, width: 310, height: 202 })
    const shown = recordToAnnotation(record, ink.attachmentId, geometry)
    expect(shown.paths).toEqual(ink.paths)
    expect(annotationToRecord(shown, geometry), 'An unchanged annotation saves its record as it was').toBe(record)
    const note = annotationToRecord({ ...ink, type: 'text', paths: undefined, rects: [{ x: 0.5, y: 0.5, width: 0.03, height: 0.03 }], contents: 'Note' }, geometry)
    expect(note.bounds).toEqual({ x: 316, y: 392, width: 24, height: 24 })
    expect(recordToAnnotation(note, ink.attachmentId, geometry).rects![0]).toEqual(expect.objectContaining({ x: 0.5, y: 0.5 }))
  })
})

describe('library sync', () => {
  it('syncs papers, files, organization, notes, positions and writings between two devices without echo', async () => {
    const server = new TestServer()
    const a = await device(server)
    const b = await device(server)
    const { paperId, attachmentId } = await addPaper(a)
    const folder = await a.store.createFolder('Research', 'New Folder', paperId)
    await a.store.setItemType(paperId, 'journalArticle', 'document')
    const note = await a.store.createNote(paperId, { attachmentId, quote: 'source', pageIndex: 2 }, 'note body')
    await a.store.saveReadingState({ paperId, attachmentId, readerMode: 'pdf', pageIndex: 4, scrollRatio: 0.4, zoomScale: 2 })
    await mkdir(join(a.store.paperDirectory(paperId), 'Resources'), { recursive: true })
    await writeFile(join(a.store.paperDirectory(paperId), 'Resources', 'figure.png'), Buffer.from([1, 2, 3]))
    const writing = await a.writings.create('# Draft\n\n![](assets/photo.png)')
    const photo = join(a.root, 'photo.png')
    await writeFile(photo, Buffer.from([9, 8, 7]))
    expect(await a.writings.importImage(writing.id, photo)).toBe('assets/photo.png')
    const highlight = annotationToRecord({ id: randomUUID(), attachmentId, pageIndex: 0, type: 'highlight', color: '#ffd60a', rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }], createdAt: '' }, boxGeometry([0, 0, 612, 792]))
    await new AnnotationStore(a.store).save(paperId, attachmentId, [highlight])
    const route = { providerId: randomUUID(), modelId: randomUUID(), modelName: 'model', apiStyle: 'responses' as const }
    await new TranslationSegmentStore(a.store).update(paperId, () => [newSegment({ sourceType: 'html', targetLanguage: 'zh-CN', sourceHash: 'hash', sourceText: 'Hello', translatedText: '你好', modelName: translationCacheIdentity(route) }, route)])

    await sync(a)
    await sync(b)

    const paper = b.store.database.papers.find((item) => item.id === paperId)
    expect(paper?.title).toBe('A paper')
    expect(paper?.authors).toEqual(['Ada Lovelace'])
    expect(await readFile(join(b.store.paperDirectory(paperId), 'paper.pdf'), 'utf8')).toBe('%PDF-1.7\nfixture')
    expect(await readFile(join(b.store.paperDirectory(paperId), 'Resources', 'figure.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(await new AnnotationStore(b.store).read(paperId, attachmentId)).toEqual([highlight])
    expect((await new TranslationSegmentStore(b.store).read(paperId)).map((segment) => segment.translatedText)).toEqual(['你好'])
    expect(b.store.database.folders.find((item) => item.id === folder.id)?.name).toBe('Research')
    expect(b.store.database.memberships).toEqual([expect.objectContaining({ paperId, folderId: folder.id })])
    expect(b.store.database.itemTypeAssignments[0]?.itemType).toBe('journalArticle')
    expect(b.store.database.notes.find((item) => item.id === note.id)?.body).toBe('note body')
    expect(b.store.database.readingStates[0]).toEqual(expect.objectContaining({ pageIndex: 4, scrollRatio: 0.4, zoomScale: 1 }))
    expect(await b.writings.loadMarkdown(writing.id)).toBe('# Draft\n\n![](assets/photo.png)')
    expect(await readFile(b.writings.resolve(writing.id, 'assets/photo.png'))).toEqual(Buffer.from([9, 8, 7]))

    const pushes = server.pushes
    await sync(a)
    await sync(b)
    await sync(a)
    expect(server.pushes, 'Applying remote data must not echo').toBe(pushes)
  })

  it('applies documents encoded by native Freddie and keeps their bytes until they change', async () => {
    const server = new TestServer()
    for (const label of ['paper-full', 'folder-root', 'membership', 'itemType', 'note', 'reading-3', 'translations']) server.publish(fixture(label))
    const pdf = Buffer.from('%PDF-1.7\nnative')
    const attachment = (JSON.parse(fixture('attachment')) as { content: { attachment: { _0: Record<string, unknown> } } })
    Object.assign(attachment.content.attachment._0, { file: { hash: sha(pdf), relativePath: 'translations/paper.zh.pdf', size: pdf.length } })
    const attachmentJSON = JSON.stringify(attachment) // Same key order and escaping as Swift for this shape.
    server.publish(attachmentJSON, [pdf])
    const annotation = JSON.parse(fixture('annotation')) as { content: { annotation: { _0: Record<string, unknown> } } }
    expect(String(annotation.content.annotation._0.attachmentID).toLowerCase()).toBe(String(attachment.content.attachment._0.id).toLowerCase())
    server.publish(fixture('annotation'))

    const b = await device(server)
    await sync(b)
    const paperId = '0e9b3f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
    const paper = b.store.database.papers.find((item) => item.id === paperId)!
    expect(paper.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer'])
    expect(paper.title).toContain('注意力')
    expect(b.store.database.attachments[0]).toEqual(expect.objectContaining({ filename: 'translations/paper.zh.pdf', translatedLastPage: 10 }))
    expect(await readFile(join(b.store.paperDirectory(paperId), 'translations', 'paper.zh.pdf'))).toEqual(pdf)
    expect(b.store.database.readingStates[0]).toEqual(expect.objectContaining({ readerMode: 'html', pageIndex: 21, scrollRatio: 1, htmlAnchor: 'rp-anchor:/1/4' }))
    // Annotations and caches are stored in native Freddie's formats.
    const attachmentId = '7d1c55a2-9f3e-4b6a-8c2d-1e0f9a8b7c6d'
    const sidecar = JSON.parse(await readFile(join(b.store.paperDirectory(paperId), 'notes', 'pdf-annotations-7D1C55A2-9F3E-4B6A-8C2D-1E0F9A8B7C6D.json'), 'utf8'))
    expect(sidecar).toEqual(expect.objectContaining({ version: 2, paperID: '0E9B3F0A-1C2D-4E5F-8A9B-0C1D2E3F4A5B', attachmentID: '7D1C55A2-9F3E-4B6A-8C2D-1E0F9A8B7C6D' }))
    expect(sidecar.annotations[0]).toEqual(expect.objectContaining({ kind: 'ink', lineWidth: 2.5, quote: 'q', createdAt: '2025-10-30T04:53:20Z', inkSamplePaths: [[{ x: 1, y: 2, width: 0.5 }]] }))
    expect((await new AnnotationStore(b.store).read(paperId, attachmentId))[0].bounds).toEqual({ x: 10.5, y: 20.25, width: 100, height: 0.1 })
    const segments = await new TranslationSegmentStore(b.store).read(paperId)
    expect(segments.map((segment) => [segment.sourceType, segment.translatedText])).toEqual([['abstract', '世界'], ['html', '你好']])
    expect(await new TranslationService(b.store, {} as never, () => {}, () => createTranslator('en')).htmlTranslatedPaperIds()).toEqual([paperId])
    expect(server.pushes, 'Native documents are applied without uploading them again').toBe(0)
    await sync(b)
    expect(server.pushes).toBe(0)

    // An edit uploads a new paper document; fields this app does not model are kept.
    await b.store.updatePaper(paperId, { title: 'Edited here' }, false)
    // Only the zoom changes: the position is the same, so native's anchor stays.
    await b.store.saveReadingState({ paperId, readerMode: 'html', pageIndex: 21, scrollRatio: 1, zoomScale: 3 })
    await sync(b)
    const unmoved = server.records.get(`readingState/${paperId}`)!
    expect(JSON.parse(server.blobs.get(unmoved.payload!.documentHash)!.toString()).content.reading._0.htmlAnchor).toBe('rp-anchor:/1/4')
    await b.store.saveReadingState({ paperId, readerMode: 'html', pageIndex: 21, scrollRatio: 0.5, zoomScale: 3 })
    await sync(b)
    const record = server.records.get(`paper/${paperId}`)!
    const edited = JSON.parse(server.blobs.get(record.payload!.documentHash)!.toString()).content.paper._0
    expect(edited).toEqual(expect.objectContaining({ title: 'Edited here', authorsStorage: 'Ashish Vaswani\nNoam Shazeer', doi: '10.1000/xyz', id: '0E9B3F0A-1C2D-4E5F-8A9B-0C1D2E3F4A5B' }))
    const reading = server.records.get(`readingState/${paperId}`)!
    const position = JSON.parse(server.blobs.get(reading.payload!.documentHash)!.toString()).content.reading._0
    expect(position.htmlAnchor, 'A new position drops the native HTML anchor').toBeUndefined()
    // The verbatim kinds are still the native ones.
    expect(server.records.get(`translationSegment/${paperId}`)!.revision).toBeLessThan(record.revision)

    // Deleting the paper here deletes its native annotation and translation cache too.
    await b.store.deletePaper(paperId)
    await sync(b)
    expect(server.records.get(`paper/${paperId}`)!.deleted).toBe(true)
    expect(server.records.get(`translationSegment/${paperId}`)!.deleted).toBe(true)
    expect(server.records.get('pdfAnnotation/c3a1e2f4-5b6d-4e7f-8091-a2b3c4d5e6f7')!.deleted).toBe(true)
  })

  it('propagates deletions and keeps the deleted folder in recovery', async () => {
    const server = new TestServer()
    const a = await device(server)
    const b = await device(server)
    const { paperId } = await addPaper(a)
    await sync(a)
    await sync(b)
    await a.store.deletePaper(paperId)
    await sync(a)
    await sync(b)
    expect(b.store.database.papers).toHaveLength(0)
    expect(existsSync(b.store.paperDirectory(paperId))).toBe(false)
    const recovery = await readdir(join(b.root, 'Sync', 'Recovery'))
    expect(recovery.length).toBeGreaterThan(0)
  })

  it('merges different fields and asks about the same field', async () => {
    const server = new TestServer()
    const a = await device(server)
    const b = await device(server)
    const { paperId } = await addPaper(a)
    await sync(a)
    await sync(b)
    await a.store.updatePaper(paperId, { title: 'Title from A' }, false)
    await b.store.updatePaper(paperId, { isFavorite: true }, false)
    await sync(a)
    await sync(b)
    const merged = b.store.database.papers[0]
    expect(merged).toEqual(expect.objectContaining({ title: 'Title from A', isFavorite: true }))
    await sync(a)
    expect(a.store.database.papers[0].isFavorite).toBe(true)

    await a.store.updatePaper(paperId, { title: 'A again' }, false)
    await b.store.updatePaper(paperId, { title: 'B again' }, false)
    await sync(a)
    await b.controller.syncNow()
    expect(b.status().conflicts).toEqual([expect.objectContaining({ id: `paper/${paperId}`, remoteDeleted: false })])
    await b.controller.resolve(`paper/${paperId}`, 'server')
    expect(b.status().conflicts).toHaveLength(0)
    expect(b.store.database.papers[0].title).toBe('A again')
  })

  it('leaves a writing with unsaved edits alone until it is saved', async () => {
    const server = new TestServer()
    const a = await device(server)
    const b = await device(server)
    const writing = await a.writings.create('first')
    await sync(a)
    await sync(b)
    await a.writings.save(writing.id, 'second from A', writing.createdAt)
    await sync(a)
    b.dirty.add(writing.id)
    await sync(b)
    expect(await b.writings.loadMarkdown(writing.id)).toBe('first')
    b.dirty.clear()
    await sync(b)
    expect(await b.writings.loadMarkdown(writing.id)).toBe('second from A')
  })

  it('stops when the server history changes', async () => {
    const server = new TestServer()
    const a = await device(server)
    await addPaper(a)
    await sync(a)
    server.storeID = randomUUID()
    await a.controller.syncNow()
    expect(a.status().needsHistoryReview).toBe(true)
    expect(a.store.database.papers).toHaveLength(1)
  })
})
