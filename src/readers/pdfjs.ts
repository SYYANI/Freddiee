import * as pdfjs from 'pdfjs-dist'
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

export { pdfjs }

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
    const task = pdfjs.getDocument({ url, enableXfa: false })
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
