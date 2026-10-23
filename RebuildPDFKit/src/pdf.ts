import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfjsResourceBase } from '../../electron/main/pdfjsResources'
import { RGBImage } from './bitmap'
import { roundHalfAway } from './pattern'

const moduleRequire = createRequire(import.meta.url)

/** A directory of pdfjs-dist, outside the asar archive in a packaged app. */
function pdfjsDirectory(name: string): string {
  const directory = join(dirname(moduleRequire.resolve('pdfjs-dist/package.json')), name).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return pdfjsResourceBase(directory)
}

export type PDFDocument = PDFDocumentProxy
export type PDFPage = PDFPageProxy

const loadingTasks = new WeakMap<PDFDocument, { destroy(): Promise<void> }>()

/** Opens a PDF for rendering; the caller closes it with `closePDF`. */
export async function openPDF(bytes: Uint8Array): Promise<PDFDocument> {
  const task = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    wasmUrl: pdfjsDirectory('wasm'),
    standardFontDataUrl: pdfjsDirectory('standard_fonts'),
    cMapUrl: pdfjsDirectory('cmaps'),
    cMapPacked: true
  })
  const document = await task.promise
  loadingTasks.set(document, task)
  return document
}

export async function closePDF(document: PDFDocument): Promise<void> {
  await loadingTasks.get(document)?.destroy()
}

/** Page size as PyMuPDF's `page.rect`: the crop box with the page rotation applied. */
export function pageSize(page: PDFPage): { width: number; height: number } {
  const viewport = page.getViewport({ scale: 1 })
  return { width: viewport.width, height: viewport.height }
}

export interface ClipRect { x: number; y: number; width: number; height: number }

/**
 * Render a PDF page region at a resolution, on white, like PyMuPDF's `get_pixmap(dpi=, clip=)`.
 *
 * `clip` is in points from the top-left corner of the page as displayed (crop box, rotation
 * applied), like PyMuPDF's `page.rect`; undefined renders the whole page.
 */
export async function renderPage(page: PDFPage, dpi: number, clip?: ClipRect): Promise<RGBImage> {
  const size = pageSize(page)
  const region = clip ?? { x: 0, y: 0, width: size.width, height: size.height }
  const scale = dpi / 72
  const width = Math.max(1, roundHalfAway(region.width * scale))
  const height = Math.max(1, roundHalfAway(region.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const viewport = page.getViewport({ scale })
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],
    background: 'rgb(255,255,255)'
  }).promise
  page.cleanup()
  return RGBImage.fromCanvas(canvas)
}

/** One run of text with its glyph boxes, in points from the top-left of the page. */
export interface TextGlyph {
  text: string
  x0: number
  x1: number
  top: number
  bottom: number
}

/**
 * The characters of a page with approximate boxes, like PDFKit's `characterBounds(at:)`:
 * each text run's advance is shared out over its characters, and the box spans the font's
 * usual ascent and descent.
 */
export async function pageGlyphs(page: PDFPage): Promise<TextGlyph[]> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const glyphs: TextGlyph[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue
    const [a, b, , , e, f] = item.transform as number[]
    const fontSize = Math.hypot(a, b) || item.height
    const characters = Array.from(item.str)
    const advance = item.width / Math.max(1, characters.length)
    const [left, baseline] = viewport.convertToViewportPoint(e, f) as [number, number]
    characters.forEach((text, index) => {
      glyphs.push({
        text,
        x0: left + index * advance,
        x1: left + (index + 1) * advance,
        top: baseline - 0.8 * fontSize,
        bottom: baseline + 0.2 * fontSize
      })
    })
  }
  return glyphs
}

/** The page's text, runs joined as a PDF text extractor would. */
export async function pageText(page: PDFPage): Promise<string> {
  const content = await page.getTextContent()
  return content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
}

/** Opens a PDF, runs `body` and destroys the document. */
export async function withPDF<T>(bytes: Uint8Array, body: (document: PDFDocument) => Promise<T>): Promise<T> {
  const document = await openPDF(bytes)
  try {
    return await body(document)
  } finally {
    await closePDF(document)
  }
}
