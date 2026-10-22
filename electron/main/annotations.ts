import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib'
import type { PdfAnnotation } from '../../shared/types'
import { atomicWriteFile } from './files'
import type { FreddieStore } from './store'

/**
 * Annotations are kept beside the PDF instead of being written into it, so the original stays
 * untouched; "Export Annotated PDF" writes them into a copy as standard PDF annotations.
 */
export class AnnotationStore {
  constructor(private readonly store: FreddieStore) {}

  private path(paperId: string, attachmentId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error('Invalid attachment identifier')
    return join(this.store.paperDirectory(paperId), 'annotations', `${attachmentId}.json`)
  }

  async list(paperId: string, attachmentId: string): Promise<PdfAnnotation[]> {
    this.store.attachment(paperId, attachmentId)
    try {
      return (JSON.parse(await readFile(this.path(paperId, attachmentId), 'utf8')) as { annotations?: PdfAnnotation[] }).annotations ?? []
    } catch {
      return []
    }
  }

  async save(paperId: string, attachmentId: string, annotations: PdfAnnotation[]): Promise<void> {
    this.store.attachment(paperId, attachmentId)
    const valid = annotations.filter((annotation) => annotation.attachmentId === attachmentId && Number.isInteger(annotation.pageIndex) && annotation.pageIndex >= 0)
    await atomicWriteFile(this.path(paperId, attachmentId), `${JSON.stringify({ version: 1, annotations: valid })}\n`)
  }

  /** Writes the annotations into a copy of the PDF and returns how many were exported. */
  async exportAnnotated(paperId: string, attachmentId: string, destination: string): Promise<number> {
    const annotations = await this.list(paperId, attachmentId)
    const document = await PDFDocument.load(await readFile(this.store.attachmentPath(paperId, attachmentId)), { ignoreEncryption: true })
    const pages = document.getPages()
    let exported = 0
    for (const annotation of annotations) {
      const page = pages[annotation.pageIndex]
      if (!page) continue
      const { width, height } = page.getSize()
      const color = hexColor(annotation.color)
      const toPDF = (x: number, y: number): [number, number] => [x * width, height - y * height]
      if ((annotation.type === 'highlight' || annotation.type === 'underline' || annotation.type === 'strikeOut') && annotation.rects?.length) {
        const quadPoints: number[] = []
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const rect of annotation.rects) {
          const [x1, y1] = toPDF(rect.x, rect.y)
          const [x2, y2] = toPDF(rect.x + rect.width, rect.y + rect.height)
          quadPoints.push(x1, y1, x2, y1, x1, y2, x2, y2)
          minX = Math.min(minX, x1)
          maxX = Math.max(maxX, x2)
          minY = Math.min(minY, y2)
          maxY = Math.max(maxY, y1)
          if (annotation.type === 'highlight') page.drawRectangle({ x: x1, y: y2, width: x2 - x1, height: y1 - y2, color: rgb(...color), opacity: 0.35 })
          else {
            const lineY = annotation.type === 'underline' ? y2 + 0.5 : (y1 + y2) / 2
            page.drawLine({ start: { x: x1, y: lineY }, end: { x: x2, y: lineY }, thickness: 1, color: rgb(...color) })
          }
        }
        const subtype = annotation.type === 'highlight' ? 'Highlight' : annotation.type === 'underline' ? 'Underline' : 'StrikeOut'
        addAnnotation(document, page, {
          Type: 'Annot', Subtype: subtype, Rect: [minX, minY, maxX, maxY], QuadPoints: quadPoints, C: color, F: 4
        })
        exported += 1
      } else if (annotation.type === 'ink' && annotation.paths?.length) {
        const lineWidth = annotation.lineWidth ?? 2
        for (const path of annotation.paths) {
          for (let index = 1; index < path.length; index += 1) {
            const [x1, y1] = toPDF(path[index - 1].x, path[index - 1].y)
            const [x2, y2] = toPDF(path[index].x, path[index].y)
            page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: lineWidth, color: rgb(...color) })
          }
        }
        exported += 1
      } else if (annotation.type === 'text' && annotation.rects?.[0]) {
        const [x, y] = toPDF(annotation.rects[0].x, annotation.rects[0].y)
        addAnnotation(document, page, {
          Type: 'Annot', Subtype: 'Text', Rect: [x, y - 20, x + 20, y], Contents: PDFString.of(annotation.contents ?? ''), C: color, Name: 'Note', F: 4
        })
        exported += 1
      }
    }
    await atomicWriteFile(destination, await document.save())
    return exported
  }
}

function addAnnotation(document: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number], dictionary: Record<string, unknown>): void {
  const reference = document.context.register(document.context.obj(dictionary as never))
  const existing = page.node.lookup(PDFName.of('Annots'))
  if (existing && 'push' in (existing as object)) (existing as unknown as { push(value: unknown): void }).push(reference)
  else page.node.set(PDFName.of('Annots'), document.context.obj([reference]))
}

function hexColor(value: string): [number, number, number] {
  const match = value.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)
  if (!match) return [1, 0.85, 0.2]
  return [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255]
}
