import type { PDFPageProxy } from 'pdfjs-dist'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

/** Keep PDF.js's layout and item order, but give input a turn between batches of text. */
export function chunkTextContent(content: TextContent, isCancelled: () => boolean, batchSize = 128): ReadableStream<TextContent> {
  let offset = 0
  let first = true
  let cancelled = false
  return new ReadableStream<TextContent>({
    async pull(controller) {
      if (!first && offset >= content.items.length) { controller.close(); return }
      if (!first) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (cancelled) return
      if (isCancelled()) { controller.close(); return }
      const items = content.items.slice(offset, offset + batchSize)
      controller.enqueue({ ...content, items, styles: first ? content.styles : {} })
      first = false
      offset += items.length
    },
    cancel() { cancelled = true }
  }, { highWaterMark: 0 })
}
