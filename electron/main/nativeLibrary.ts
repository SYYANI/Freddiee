import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, cp, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Attachment, AttachmentKind, AttachmentSource, Folder, NativeLibraryImportResult, ReaderMode } from '../../shared/types'
import type { FreddieStore } from './store'

const run = promisify(execFile)

/** Core Data stores dates as seconds since 2001-01-01. */
const referenceDate = Date.UTC(2001, 0, 1)
const date = (value: unknown): string | undefined => (typeof value === 'number' ? new Date(referenceDate + value * 1000).toISOString() : undefined)
const uuid = (hex: unknown): string | undefined => {
  if (typeof hex !== 'string' || !/^[0-9A-F]{32}$/i.test(hex)) return undefined
  const value = hex.toLowerCase()
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
const list = (value: unknown): string[] => (typeof value === 'string' ? value.split('\n').map((item) => item.trim()).filter(Boolean) : [])
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

const attachmentKinds: AttachmentKind[] = ['pdf', 'html', 'translatedPDF', 'resource']
const attachmentSources: AttachmentSource[] = ['arxivPDF', 'arxivHTML', 'localImport', 'webPage', 'babeldoc', 'latexTrans', 'scanRebuild', 'generated']
const readerModes: ReaderMode[] = ['html', 'pdf', 'bilingualPDF', 'translatedPDF']

export type NativeImportStage = 'reading' | 'folders' | 'papers' | 'notes' | 'organizing' | 'translations' | 'writings' | 'finalizing'

export interface NativeImportUpdate {
  stage: NativeImportStage
  fraction: number
  current?: number
  total?: number
  item?: string
}

type ProgressSink = (update: NativeImportUpdate) => void

export const nativeRoot = join(homedir(), 'Library', 'Application Support', 'ReadPaper')

export async function nativeLibraryExists(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await access(join(nativeRoot, 'ReadPaper.store'))
    return true
  } catch {
    return false
  }
}

async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  // Read-only and immutable, so the native app's open store is never written to.
  const uri = `file:${join(nativeRoot, 'ReadPaper.store')}?mode=ro`
  const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', uri, sql], { maxBuffer: 256 * 1024 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) as Array<Record<string, unknown>> : []
}

/** Copies the native Freddie library into this one, skipping papers that are already here. */
export async function importNativeLibrary(store: FreddieStore, writingsRoot: string, onProgress: ProgressSink = () => {}): Promise<NativeLibraryImportResult> {
  const report = (stage: NativeImportStage, fraction: number, current?: number, total?: number, item?: string): void => {
    if (current !== undefined && total !== undefined) {
      const interval = Math.max(1, Math.ceil(total / 100))
      if (current !== 0 && current !== total && current % interval !== 0) return
    }
    onProgress({ stage, fraction: Math.min(0.99, Math.max(0, fraction)), current, total, item })
  }
  const reportRange = (stage: NativeImportStage, current: number, total: number, start: number, end: number, item?: string): void => {
    report(stage, total ? start + (end - start) * current / total : end, current, total, item)
  }
  let readStep = 0
  const read = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    const rows = await query(sql)
    readStep += 1
    reportRange('reading', readStep, 8, 0, 0.12)
    return rows
  }

  report('reading', 0, 0, 8)
  const papers = await read('select hex(ZID) id, ZTITLE, ZABSTRACTTEXT, ZARXIVID, ZARXIVVERSION, ZDOI, ZAUTHORSSTORAGE, ZCATEGORIESSTORAGE, ZTAGSSTORAGE, ZPUBLISHEDAT, ZUPDATEDAT, ZPDFURLSTRING, ZHTMLURLSTRING, ZISFAVORITE, ZCREATEDAT, ZMODIFIEDAT, ZLOCALDIRECTORYPATH from ZPAPER')
  const attachments = await read('select hex(ZID) id, hex(ZPAPERID) paperId, ZKINDRAWVALUE kind, ZSOURCERAWVALUE source, ZFILEPATH path, ZTRANSLATEDLASTPAGE lastPage, ZCREATEDAT createdAt from ZPAPERATTACHMENT')
  const notes = await read('select hex(ZID) id, hex(ZPAPERID) paperId, hex(ZATTACHMENTID) attachmentId, ZQUOTE quote, ZBODY body, ZPAGEINDEX pageIndex, ZHTMLSELECTOR selector, ZCREATEDAT createdAt, ZMODIFIEDAT modifiedAt from ZNOTE')
  const folders = await read('select hex(ZID) id, ZNAME name, ZCREATEDAT createdAt, ZMODIFIEDAT modifiedAt from ZPAPERFOLDER')
  const memberships = await read('select hex(ZPAPERID) paperId, hex(ZFOLDERID) folderId, ZADDEDAT addedAt from ZPAPERFOLDERMEMBERSHIP')
  const itemTypes = await read('select hex(ZPAPERID) paperId, ZITEMTYPERAWVALUE itemType, ZASSIGNEDAT assignedAt from ZPAPERITEMTYPEASSIGNMENT')
  const readingStates = await read('select hex(ZPAPERID) paperId, hex(ZATTACHMENTID) attachmentId, ZREADERMODERAWVALUE mode, ZPAGEINDEX pageIndex, ZSCROLLRATIO scrollRatio, ZZOOMSCALE zoom, ZMODIFIEDAT modifiedAt from ZREADINGSTATE')
  const segments = await read("select hex(ZPAPERID) paperId, ZSOURCEHASH hash, ZTARGETLANGUAGE language, ZTRANSLATEDTEXT text, hex(ZPROVIDERPROFILEID) providerId, hex(ZMODELPROFILEID) modelId, ZMODELNAME identity, ZCREATEDAT createdAt from ZTRANSLATIONSEGMENT where ZSOURCETYPE = 'html'")

  const existing = new Set(store.database.papers.map((paper) => paper.id))
  const imported = new Set<string>()
  const now = new Date().toISOString()

  const folderIds = new Map<string, string>()
  reportRange('folders', 0, folders.length, 0.12, 0.18)
  for (const [index, row] of folders.entries()) {
    reportRange('folders', index, folders.length, 0.12, 0.18, text(row.name))
    const id = uuid(row.id)
    if (!id) continue
    const match = store.database.folders.find((folder) => folder.id === id || folder.name === row.name)
    if (match) {
      folderIds.set(id, match.id)
      continue
    }
    const folder: Folder = { id, name: String(row.name ?? 'Folder'), createdAt: date(row.createdAt) ?? now, modifiedAt: date(row.modifiedAt) ?? now }
    await store.importFolder(folder)
    folderIds.set(id, id)
  }
  reportRange('folders', folders.length, folders.length, 0.12, 0.18)

  reportRange('papers', 0, papers.length, 0.18, 0.72)
  for (const [index, row] of papers.entries()) {
    reportRange('papers', index, papers.length, 0.18, 0.72, text(row.ZTITLE))
    const id = uuid(row.id)
    if (!id || existing.has(id)) continue
    const nativeDirectory = typeof row.ZLOCALDIRECTORYPATH === 'string' && isAbsolute(row.ZLOCALDIRECTORYPATH)
      ? row.ZLOCALDIRECTORYPATH
      : join(nativeRoot, 'Library', id.toUpperCase())
    const directory = store.paperDirectory(id)
    try {
      await cp(nativeDirectory, directory, { recursive: true, errorOnExist: false, force: false, mode: constants.COPYFILE_FICLONE })
    } catch {
      // A paper without files still keeps its metadata and notes.
    }
    const paperAttachments: Attachment[] = []
    for (const attachment of attachments.filter((item) => uuid(item.paperId) === id)) {
      const attachmentId = uuid(attachment.id)
      const kind = attachment.kind as AttachmentKind
      if (!attachmentId || !attachmentKinds.includes(kind) || typeof attachment.path !== 'string') continue
      const relativePath = relative(nativeDirectory, attachment.path)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) continue
      paperAttachments.push({
        id: attachmentId,
        paperId: id,
        kind,
        source: attachmentSources.includes(attachment.source as AttachmentSource) ? attachment.source as AttachmentSource : 'generated',
        filename: relativePath.split(sep).join('/'),
        translatedLastPage: typeof attachment.lastPage === 'number' ? attachment.lastPage : undefined,
        createdAt: date(attachment.createdAt) ?? now
      })
    }
    const createdAt = date(row.ZCREATEDAT) ?? now
    await store.importPaper({
      id,
      arxivId: text(row.ZARXIVID),
      arxivVersion: text(row.ZARXIVVERSION),
      doi: text(row.ZDOI),
      title: text(row.ZTITLE) ?? 'Untitled PDF',
      abstract: typeof row.ZABSTRACTTEXT === 'string' ? row.ZABSTRACTTEXT : '',
      authors: list(row.ZAUTHORSSTORAGE),
      categories: list(row.ZCATEGORIESSTORAGE),
      tags: list(row.ZTAGSSTORAGE),
      publishedAt: date(row.ZPUBLISHEDAT),
      updatedAt: date(row.ZUPDATEDAT),
      pdfUrl: text(row.ZPDFURLSTRING),
      htmlUrl: text(row.ZHTMLURLSTRING),
      isFavorite: row.ZISFAVORITE === 1,
      createdAt,
      modifiedAt: date(row.ZMODIFIEDAT) ?? createdAt
    }, paperAttachments)
    imported.add(id)
  }
  reportRange('papers', papers.length, papers.length, 0.18, 0.72)

  let noteCount = 0
  reportRange('notes', 0, notes.length, 0.72, 0.80)
  for (const [index, row] of notes.entries()) {
    reportRange('notes', index, notes.length, 0.72, 0.80)
    const paperId = uuid(row.paperId)
    const id = uuid(row.id)
    if (!id || !paperId || !imported.has(paperId)) continue
    await store.importNote({
      id,
      paperId,
      attachmentId: uuid(row.attachmentId),
      quote: typeof row.quote === 'string' ? row.quote : '',
      body: typeof row.body === 'string' ? row.body : '',
      pageIndex: typeof row.pageIndex === 'number' ? row.pageIndex : undefined,
      htmlSelector: text(row.selector),
      createdAt: date(row.createdAt) ?? now,
      modifiedAt: date(row.modifiedAt) ?? now
    })
    noteCount += 1
  }
  reportRange('notes', notes.length, notes.length, 0.72, 0.80)

  const organizationTotal = memberships.length + itemTypes.length + readingStates.length
  let organizationIndex = 0
  reportRange('organizing', 0, organizationTotal, 0.80, 0.88)
  for (const row of memberships) {
    reportRange('organizing', organizationIndex++, organizationTotal, 0.80, 0.88)
    const paperId = uuid(row.paperId)
    const folderId = folderIds.get(uuid(row.folderId) ?? '')
    if (paperId && folderId && imported.has(paperId)) await store.movePaper(paperId, folderId)
  }
  for (const row of itemTypes) {
    reportRange('organizing', organizationIndex++, organizationTotal, 0.80, 0.88)
    const paperId = uuid(row.paperId)
    if (paperId && imported.has(paperId) && typeof row.itemType === 'string') await store.setItemType(paperId, row.itemType, '')
  }
  for (const row of readingStates) {
    reportRange('organizing', organizationIndex++, organizationTotal, 0.80, 0.88)
    const paperId = uuid(row.paperId)
    if (!paperId || !imported.has(paperId)) continue
    await store.saveReadingState({
      paperId,
      attachmentId: uuid(row.attachmentId),
      readerMode: readerModes.includes(row.mode as ReaderMode) ? row.mode as ReaderMode : 'pdf',
      pageIndex: typeof row.pageIndex === 'number' ? row.pageIndex : 0,
      scrollRatio: typeof row.scrollRatio === 'number' ? row.scrollRatio : 0,
      zoomScale: typeof row.zoom === 'number' ? row.zoom : 1
    })
  }
  reportRange('organizing', organizationTotal, organizationTotal, 0.80, 0.88)

  // HTML translation caches mark papers as translated for the library filter.
  const segmentsByPaper = new Map<string, Array<Record<string, unknown>>>()
  for (const [index, row] of segments.entries()) {
    reportRange('translations', index, segments.length, 0.88, 0.92)
    const paperId = uuid(row.paperId)
    if (paperId && imported.has(paperId)) segmentsByPaper.set(paperId, [...(segmentsByPaper.get(paperId) ?? []), row])
  }
  const translationGroups = [...segmentsByPaper.entries()]
  for (const [index, [paperId, rows]] of translationGroups.entries()) {
    reportRange('translations', index, translationGroups.length, 0.92, 0.95)
    await store.importTranslationCache(paperId, rows.map((row) => ({
      sourceHash: String(row.hash ?? ''),
      targetLanguage: String(row.language ?? ''),
      providerId: uuid(row.providerId) ?? '',
      modelId: uuid(row.modelId) ?? '',
      identity: `native|${String(row.identity ?? '')}`,
      text: String(row.text ?? ''),
      createdAt: date(row.createdAt) ?? now
    })))
  }
  reportRange('translations', translationGroups.length, translationGroups.length, 0.92, 0.95)

  // Writings are Markdown folders in the same layout.
  let writingCount = 0
  try {
    const entries = await readdir(join(nativeRoot, 'Writings'))
    for (const [index, entry] of entries.entries()) {
      reportRange('writings', index, entries.length, 0.95, 0.99)
      if (!/^[0-9A-F-]{36}$/i.test(entry)) continue
      const target = join(writingsRoot, entry.toLowerCase())
      try {
        await access(target)
        continue
      } catch {
        await cp(join(nativeRoot, 'Writings', entry), target, { recursive: true })
        writingCount += 1
      }
    }
    reportRange('writings', entries.length, entries.length, 0.95, 0.99)
  } catch {
    // No writings.
  }

  report('finalizing', 0.99)
  return { papers: imported.size, notes: noteCount, writings: writingCount }
}
