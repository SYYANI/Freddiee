import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PageLayout } from '../RebuildPDFKit/src/geometry'
import type { RebuildCompletion, RebuildCompletionRequest, RebuildModelClient } from '../RebuildPDFKit/src/model'
import { pageGlyphs, pageText as extractText, withPDF } from '../RebuildPDFKit/src/pdf'
import type { TextRecognizing } from '../RebuildPDFKit/src/textRecognition'
import { XeLaTeXCompiler } from '../RebuildPDFKit/src/xelatex'

export function page(body: string, options: { header?: string; footer?: string; figures?: string; font?: string; columns?: number } = {}): string {
  return `<page font="${options.font ?? 'serif'}" columns="${options.columns ?? 1}">\n<header>${options.header ?? ''}</header>\n<body>\n${body}\n</body>\n`
    + `<footer>\n${options.footer ?? ''}\n</footer>\n<figures>\n${options.figures ?? ''}\n</figures>\n<notes>\n</notes>\n</page>`
}

export const testLayout: PageLayout = {
  pageWidth: 300, pageHeight: 400, left: 30, top: 30, textWidth: 240, textHeight: 330,
  size: 10, leading: 12, indent: 10, columnGap: 12, headerGap: 0, paragraphGap: 0
}

export const xelatexPath = await XeLaTeXCompiler.locate(process.platform === 'win32' ? [] : ['/Library/TeX/texbin'])

/** A scratch directory; remove it with `cleanup`. */
export function temporaryDirectory(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), 'rebuild-pdf-tests-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** A PDF with one line of text per page, standing in for a scan. */
export async function makeSourcePDF(path: string, pages: string[], size = { width: 300, height: 400 }): Promise<void> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.TimesRoman)
  for (const text of pages) {
    const pdfPage = document.addPage([size.width, size.height])
    if (text) pdfPage.drawText(text, { x: 40, y: size.height - 60, size: 11, font })
  }
  await writeFile(path, await document.save())
}

export async function pageText(path: string, index: number): Promise<string> {
  return withPDF(new Uint8Array(await readFile(path)), async (document) => extractText(await document.getPage(index + 1)))
}

export async function pageCount(path: string): Promise<number> {
  return withPDF(new Uint8Array(await readFile(path)), async (document) => document.numPages)
}

/** The left edge of the first occurrence of `text` on a page, in points, like PDFKit's `findString`. */
export async function textLeft(path: string, text: string, index = 0): Promise<number | undefined> {
  const glyphs = await withPDF(new Uint8Array(await readFile(path)), async (document) => pageGlyphs(await document.getPage(index + 1)))
  const target = Array.from(text.replaceAll(' ', ''))
  const visible = glyphs.filter((glyph) => glyph.text.trim())
  for (let start = 0; start + target.length <= visible.length; start += 1) {
    if (target.every((character, offset) => visible[start + offset].text === character)) return visible[start].x0
  }
  return undefined
}

/** A model that answers from a script and records what it was asked. */
export class ScriptedModel implements RebuildModelClient {
  requests: RebuildCompletionRequest[] = []

  constructor(private readonly answer: (request: RebuildCompletionRequest) => string | Promise<string>, readonly identity = 'test-model') {}

  get labels(): string[] {
    return this.requests.map((request) => request.label)
  }

  reset(): void {
    this.requests = []
  }

  async complete(request: RebuildCompletionRequest): Promise<RebuildCompletion> {
    this.requests.push(request)
    return { text: await this.answer(request), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 10 }, finishReason: 'stop' }
  }
}

/** OCR that reports no lines, so pages use the default text area. */
export const noText: TextRecognizing = { recognizeLines: async () => [] }

/** A sequence of canned answers. */
export class Replies {
  constructor(private readonly queue: string[]) {}

  next(): string {
    return this.queue.shift() ?? ''
  }
}
