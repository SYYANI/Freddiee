import * as pdfjs from 'pdfjs-dist'
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import jbig2URL from 'pdfjs-dist/wasm/jbig2.wasm?url'
import openjpegURL from 'pdfjs-dist/wasm/openjpeg.wasm?url'
import qcmsURL from 'pdfjs-dist/wasm/qcms_bg.wasm?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

export { pdfjs }

const wasmURLs: Record<string, string> = { 'jbig2.wasm': jbig2URL, 'openjpeg.wasm': openjpegURL, 'qcms_bg.wasm': qcmsURL }

/**
 * pdf.js decodes JBIG2 and JPEG 2000 images (common in scanned papers) and ICC colors with
 * WebAssembly it requests by file name. Vite emits those files with hashed names, so this
 * factory maps each name to its bundled URL; without it such pages draw blank.
 */
class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === 'wasmUrl' ? wasmURLs[filename] : undefined
    if (!url) throw new Error(`Unable to load ${kind} data: ${filename}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to load ${kind} data: ${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

interface CachedDocument {
  url: string
  task: PDFDocumentLoadingTask
  promise: Promise<PDFDocumentProxy>
  users: number
}

const cache = new Map<string, CachedDocument>()

/** Shares one loaded document between views of the same file and version. */
export function openDocument(url: string): { promise: Promise<PDFDocumentProxy>; release: () => void } {
  let entry = cache.get(url)
  if (!entry) {
    const task = pdfjs.getDocument({ url, enableXfa: false, useWorkerFetch: false, BinaryDataFactory: BundledBinaryDataFactory })
    entry = { url, task, promise: task.promise, users: 0 }
    cache.set(url, entry)
  }
  entry.users += 1
  const current = entry
  return {
    promise: current.promise,
    release: () => {
      current.users -= 1
      if (current.users <= 0) {
        cache.delete(current.url)
        void current.task.destroy()
      }
    }
  }
}

/** Text of each page as its text layer will contain it, for searching. */
export async function pageTexts(document: PDFDocumentProxy): Promise<string[]> {
  const texts: string[] = []
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent()
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
  }
  return texts
}
