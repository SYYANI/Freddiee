import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib'
import type { PdfAnnotationKind, PdfAnnotationRecord } from '../../shared/types'
import { wholeSecondDate } from '../../shared/pdfAnnotationGeometry'
import { atomicWriteFile } from './files'
import type { FreddieStore } from './store'

const kinds: PdfAnnotationKind[] = ['highlight', 'underline', 'strikeOut', 'ink', 'text']
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const point = (value: unknown): boolean => Boolean(value) && finite((value as { x?: unknown }).x) && finite((value as { y?: unknown }).y)
const points = (value: unknown): boolean => Array.isArray(value) && value.every(point)

/** Native Freddie's sidecar shape and checks; anything else is dropped rather than stored. */
export function isAnnotationRecord(value: unknown): value is PdfAnnotationRecord {
  const record = value as PdfAnnotationRecord
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !/^[0-9A-F-]{36}$/i.test(record.id)) return false
  const bounds = record.bounds as unknown as Record<string, unknown> | undefined
  const color = record.color as unknown as Record<string, unknown> | undefined
  return Number.isInteger(record.pageIndex) && record.pageIndex >= 0 && kinds.includes(record.kind) &&
    Boolean(bounds) && ['x', 'y', 'width', 'height'].every((key) => finite(bounds![key])) &&
    Boolean(color) && ['red', 'green', 'blue', 'alpha'].every((key) => finite(color![key])) &&
    finite(record.lineWidth) && points(record.quadrilateralPoints) && Array.isArray(record.inkPaths) && record.inkPaths.every(points) &&
    (record.inkSamplePaths === undefined || (Array.isArray(record.inkSamplePaths) && record.inkSamplePaths.every((path) => Array.isArray(path) && path.every((sample) => point(sample) && finite(sample.width))))) &&
    (record.contents === undefined || typeof record.contents === 'string') && (record.quote === undefined || typeof record.quote === 'string') &&
    typeof record.createdAt === 'string' && !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.modifiedAt === 'string' && !Number.isNaN(Date.parse(record.modifiedAt))
}

/**
 * Annotations are kept beside the PDF instead of being written into it, in native
 * Freddie's sidecar (`notes/pdf-annotations-{ATTACHMENT}.json`, PDF page coordinates),
 * so the original stays untouched and the file means the same in both apps. "Export
 * Annotated PDF" writes them into a copy as standard PDF annotations.
 */
export class AnnotationStore {
  constructor(private readonly store: FreddieStore) {}

  sidecarPath(paperId: string, attachmentId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error('Invalid attachment identifier')
    return join(this.store.paperDirectory(paperId), 'notes', `pdf-annotations-${attachmentId.toUpperCase()}.json`)
  }

  /** Records of an attachment, oldest first; works for attachments not (or no longer) in the library. */
  async read(paperId: string, attachmentId: string): Promise<PdfAnnotationRecord[]> {
    let sidecar: { version?: unknown; paperID?: unknown; attachmentID?: unknown; annotations?: unknown }
    try {
      sidecar = JSON.parse(await readFile(this.sidecarPath(paperId, attachmentId), 'utf8')) as typeof sidecar
    } catch {
      return []
    }
    if (typeof sidecar.version !== 'number' || sidecar.version > 2) throw new Error('This PDF annotation file was created by a newer version of Freddie.')
    if (String(sidecar.paperID).toLowerCase() !== paperId.toLowerCase() || String(sidecar.attachmentID).toLowerCase() !== attachmentId.toLowerCase()) {
      throw new Error('The PDF annotation file does not match this attachment.')
    }
    const records = Array.isArray(sidecar.annotations) ? sidecar.annotations.filter(isAnnotationRecord) : []
    return records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async write(paperId: string, attachmentId: string, records: PdfAnnotationRecord[]): Promise<void> {
    await atomicWriteFile(this.sidecarPath(paperId, attachmentId), sidecarJSON(paperId, attachmentId, records))
  }

  async list(paperId: string, attachmentId: string): Promise<PdfAnnotationRecord[]> {
    this.store.attachment(paperId, attachmentId)
    try {
      return await this.read(paperId, attachmentId)
    } catch {
      return []
    }
  }

  async save(paperId: string, attachmentId: string, records: PdfAnnotationRecord[]): Promise<void> {
    this.store.attachment(paperId, attachmentId)
    const seen = new Set<string>()
    const valid = records.filter((record) => isAnnotationRecord(record) && !seen.has(record.id.toUpperCase()) && seen.add(record.id.toUpperCase()))
    await this.write(paperId, attachmentId, valid)
  }

  /** Writes the annotations into a copy of the PDF and returns how many were exported. */
  async exportAnnotated(paperId: string, attachmentId: string, destination: string): Promise<number> {
    const records = await this.list(paperId, attachmentId)
    const document = await PDFDocument.load(await readFile(this.store.attachmentPath(paperId, attachmentId)), { ignoreEncryption: true })
    const pages = document.getPages()
    let exported = 0
    for (const record of records) {
      const page = pages[record.pageIndex]
      if (!page) continue
      // Records are already in PDF page space.
      const color: [number, number, number] = [record.color.red, record.color.green, record.color.blue]
      const { x, y, width, height } = record.bounds
      if (record.kind === 'highlight' || record.kind === 'underline' || record.kind === 'strikeOut') {
        if (record.kind === 'highlight') page.drawRectangle({ x, y, width, height, color: rgb(...color), opacity: record.color.alpha })
        else {
          const lineY = record.kind === 'underline' ? y + 0.5 : y + height / 2
          page.drawLine({ start: { x, y: lineY }, end: { x: x + width, y: lineY }, thickness: 1, color: rgb(...color), opacity: record.color.alpha })
        }
        const subtype = record.kind === 'highlight' ? 'Highlight' : record.kind === 'underline' ? 'Underline' : 'StrikeOut'
        addAnnotation(document, page, {
          Type: 'Annot', Subtype: subtype, Rect: [x, y, x + width, y + height], QuadPoints: [x, y + height, x + width, y + height, x, y, x + width, y], C: color, F: 4
        })
        exported += 1
      } else if (record.kind === 'ink') {
        const paths = record.inkPaths.length ? record.inkPaths : record.inkSamplePaths ?? []
        for (const path of paths) {
          for (let index = 1; index < path.length; index += 1) {
            page.drawLine({ start: path[index - 1], end: path[index], thickness: record.lineWidth, color: rgb(...color), opacity: record.color.alpha })
          }
        }
        exported += 1
      } else if (record.kind === 'text') {
        addAnnotation(document, page, {
          Type: 'Annot', Subtype: 'Text', Rect: [x, y, x + width, y + height], Contents: PDFString.of(record.contents ?? ''), C: color, Name: 'Note', F: 4
        })
        exported += 1
      }
    }
    await atomicWriteFile(destination, await document.save())
    return exported
  }
}

/** Native `PDFAnnotationSidecar`; version 2 only when pressure ink is present. */
export function sidecarJSON(paperId: string, attachmentId: string, records: PdfAnnotationRecord[]): string {
  const sidecar = {
    annotations: records,
    attachmentID: attachmentId.toUpperCase(),
    modifiedAt: wholeSecondDate(),
    paperID: paperId.toUpperCase(),
    version: records.some((record) => record.inkSamplePaths?.length) ? 2 : 1
  }
  return `${JSON.stringify(sidecar, null, 2)}\n`
}

function addAnnotation(document: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number], dictionary: Record<string, unknown>): void {
  const reference = document.context.register(document.context.obj(dictionary as never))
  const existing = page.node.lookup(PDFName.of('Annots'))
  if (existing && 'push' in (existing as object)) (existing as unknown as { push(value: unknown): void }).push(reference)
  else page.node.set(PDFName.of('Annots'), document.context.obj([reference]))
}
