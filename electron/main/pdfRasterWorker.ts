import { parentPort, workerData } from 'node:worker_threads'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { PdfRasterMessage, PdfRasterReply, PdfRasterResources } from './pdfRasterWorkerClient'

const port = parentPort!
const resources = workerData as PdfRasterResources
const documents = new Map<string, { task: PDFDocumentLoadingTask; document: PDFDocumentProxy }>()
const cancelled = new Set<number>()
let active: { id: number; render?: RenderTask } | undefined

port.on('message', (message: PdfRasterMessage) => {
  if (message.type === 'cancel') {
    if (active?.id === message.id) {
      cancelled.add(message.id)
      active.render?.cancel()
    }
    return
  }
  void render(message)
})

async function render(message: Extract<PdfRasterMessage, { type: 'render' }>): Promise<void> {
  active = { id: message.id }
  let canvas: import('@napi-rs/canvas').Canvas | undefined
  let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
  try {
    const pdfjs = await import(resources.pdfjsModuleURL) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
    const { createCanvas } = await import(resources.canvasModuleURL) as typeof import('@napi-rs/canvas')
    let loaded = documents.get(message.key)
    if (!loaded) {
      if (!message.pdf) throw new Error('PDF raster document is unavailable')
      while (documents.size >= 2) {
        const [key, previous] = documents.entries().next().value!
        documents.delete(key)
        await previous.task.destroy()
      }
      const task = pdfjs.getDocument({ data: message.pdf, standardFontDataUrl: resources.standardFontDataURL,
        cMapUrl: resources.cMapURL, cMapPacked: true, wasmUrl: resources.wasmURL, useSystemFonts: false, enableXfa: false })
      try { loaded = { task, document: await task.promise } } catch (error) { await task.destroy(); throw error }
    } else documents.delete(message.key)
    documents.set(message.key, loaded)
    if (cancelled.has(message.id)) throw new Error('PDF raster cancelled')
    if (message.pageIndex >= loaded.document.numPages) throw new Error('Invalid PDF page')
    page = await loaded.document.getPage(message.pageIndex + 1)
    const viewport = page.getViewport({ scale: message.scale })
    const ratio = Math.min(message.ratio, Math.sqrt(2 ** 24 / (viewport.width * viewport.height)), 32768 / Math.max(viewport.width, viewport.height))
    if (!(ratio > 0 && Number.isFinite(ratio))) throw new Error('Invalid PDF dimensions')
    canvas = createCanvas(Math.max(1, Math.floor(viewport.width * ratio)), Math.max(1, Math.floor(viewport.height * ratio)))
    const render = page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
    active!.render = render
    render.onContinue = (resume: () => void) => setImmediate(() => {
      if (cancelled.has(message.id)) render.cancel()
      else resume()
    })
    await render.promise
    if (cancelled.has(message.id)) throw new Error('PDF raster cancelled')
    if (message.paperTone) {
      const context = canvas.getContext('2d')
      context.globalCompositeOperation = 'multiply'
      context.fillStyle = 'rgb(245, 237, 219)'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    const png = Uint8Array.from(await canvas.encode('png'))
    port.postMessage({ type: 'result', id: message.id, png, documents: [...documents.keys()] } satisfies PdfRasterReply, [png.buffer])
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), documents: [...documents.keys()] } satisfies PdfRasterReply)
  } finally {
    if (canvas) { canvas.width = 1; canvas.height = 1 }
    page?.cleanup()
    cancelled.delete(message.id)
    active = undefined
  }
}
