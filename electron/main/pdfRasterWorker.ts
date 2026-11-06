import { parentPort, workerData } from 'node:worker_threads'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { PdfRasterMessage, PdfRasterReply, PdfRasterResources } from './pdfRasterWorkerClient'
import { rasterHeaderBytes } from './pdfRasterFormat'
import { warmupPdf } from './pdfRasterWarmup'

const port = parentPort!
const resources = workerData as PdfRasterResources
const documents = new Map<string, { task: PDFDocumentLoadingTask; document: PDFDocumentProxy }>()
const cancelled = new Set<number>()
let active: { id: number; render?: RenderTask } | undefined
// Loaded when the worker starts, so a worker started ahead of the first page has them ready.
const modules = Promise.all([
  import(resources.pdfjsModuleURL) as Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>,
  import(resources.canvasModuleURL) as Promise<typeof import('@napi-rs/canvas')>
])
type PdfJS = Awaited<typeof modules>[0]
const documentOptions = (pdfjs: PdfJS) => ({ standardFontDataUrl: resources.standardFontDataURL,
  cMapUrl: resources.cMapURL, cMapPacked: true, wasmUrl: resources.wasmURL, useSystemFonts: false, enableXfa: false,
  // Malformed fonts in translated PDFs can log a warning per glyph; each one is a write on the main process.
  verbosity: pdfjs.VerbosityLevel.ERRORS })
// Draw a built-in page before any request: the reader's first page then skips V8's compile time.
const warmed = modules.then(async ([pdfjs, { createCanvas }]) => {
  const task = pdfjs.getDocument({ data: warmupPdf(), ...documentOptions(pdfjs) })
  try {
    const page = await (await task.promise).getPage(1)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height))
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  } finally { await task.destroy() }
}).catch(() => undefined)

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
    const [pdfjs, { createCanvas }] = await modules
    await warmed
    let loaded = documents.get(message.key)
    if (!loaded) {
      if (!message.pdf) throw new Error('PDF raster document is unavailable')
      while (documents.size >= 2) {
        const [key, previous] = documents.entries().next().value!
        documents.delete(key)
        await previous.task.destroy()
      }
      const task = pdfjs.getDocument({ data: message.pdf, ...documentOptions(pdfjs) })
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
    // Raw pixels: PNG compression cost two to three times the drawing of an ordinary page, and the
    // renderer only decoded it again. getImageData gives straight (unpremultiplied) RGBA, as ImageData expects.
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    const image = new Uint8Array(rasterHeaderBytes + pixels.byteLength)
    const header = new DataView(image.buffer)
    header.setUint32(0, canvas.width, true)
    header.setUint32(4, canvas.height, true)
    image.set(pixels, rasterHeaderBytes)
    port.postMessage({ type: 'result', id: message.id, image, documents: [...documents.keys()] } satisfies PdfRasterReply, [image.buffer])
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), documents: [...documents.keys()] } satisfies PdfRasterReply)
  } finally {
    if (canvas) { canvas.width = 1; canvas.height = 1 }
    page?.cleanup()
    cancelled.delete(message.id)
    active = undefined
  }
}
