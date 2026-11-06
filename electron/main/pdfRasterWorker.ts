import { parentPort, workerData } from 'node:worker_threads'
import type { Document as MuDocument } from 'mupdf'
import type { PdfRasterMessage, PdfRasterParameters, PdfRasterReply, PdfRasterResources } from './pdfRasterWorkerClient'
import { rasterHeaderBytes } from './pdfRasterFormat'
import { warmupPdf } from './pdfRasterWarmup'

type MuPDF = typeof import('mupdf')
const port = parentPort!
const resources = workerData as PdfRasterResources
const documents = new Map<string, MuDocument>()
const cancelled = new Set<number>()
let active: number | undefined
// MuPDF reports damaged fonts and objects on the console, sometimes once per glyph; each line
// would be a write on the main process.
Object.assign(globalThis, { $libmupdf_wasm_Module: { print: () => {}, printErr: () => {} } })
// Loaded when the worker starts, so a worker started ahead of the first page has MuPDF compiled.
const loaded = import(resources.mupdfModuleURL) as Promise<MuPDF>
// Draw a built-in page before any request, so the reader's first page skips MuPDF's one-time setup.
const warmed = loaded.then((mupdf) => {
  const document = mupdf.Document.openDocument(warmupPdf(), 'application/pdf')
  try { draw(mupdf, document, { pageIndex: 0, scale: 1, ratio: 2, paperTone: false }) } finally { document.destroy() }
}).catch(() => undefined)

port.on('message', (message: PdfRasterMessage) => {
  if (message.type === 'cancel') {
    // Drawing a page is one synchronous call; a cancellation is seen before or after it.
    if (active === message.id) cancelled.add(message.id)
    return
  }
  void render(message)
})

// Paper Tone multiplies each channel by the paper colour, as the browser renderer's `multiply` fill does.
const paper = [245, 237, 219].map((tone) => Uint8Array.from({ length: 256 }, (_, value) => Math.round(value * tone / 255)))

/**
 * Draws a page at exactly the size PDF.js gives it (`floor(viewport × ratio)`), so the bitmap lines
 * up with the PDF.js text layer and annotations. MuPDF's page bounds already include rotation,
 * CropBox and UserUnit, like a PDF.js viewport.
 */
function draw(mupdf: MuPDF, document: MuDocument, { pageIndex, scale, ratio: requested, paperTone }: PdfRasterParameters): Uint8Array<ArrayBuffer> {
  const page = document.loadPage(pageIndex)
  try {
    const [x0, y0, x1, y1] = page.getBounds()
    const viewWidth = (x1 - x0) * scale, viewHeight = (y1 - y0) * scale
    const ratio = Math.min(requested, Math.sqrt(2 ** 24 / (viewWidth * viewHeight)), 32768 / Math.max(viewWidth, viewHeight))
    if (!(ratio > 0 && Number.isFinite(ratio))) throw new Error('Invalid PDF dimensions')
    const width = Math.max(1, Math.floor(viewWidth * ratio)), height = Math.max(1, Math.floor(viewHeight * ratio))
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true)
    try {
      // An opaque white page: everything drawn over it stays opaque, so MuPDF's premultiplied
      // RGBA is already the straight RGBA that ImageData expects.
      pixmap.clear(255)
      const zoom = scale * ratio
      const device = new mupdf.DrawDevice(mupdf.Matrix.concat(mupdf.Matrix.translate(-x0, -y0), mupdf.Matrix.scale(zoom, zoom)), pixmap)
      try {
        page.run(device, mupdf.Matrix.identity)
        device.close()
      } finally { device.destroy() }
      const pixels = pixmap.getPixels()
      if (pixels.length !== width * height * 4) throw new Error('Unexpected PDF raster layout')
      const image = new Uint8Array(new ArrayBuffer(rasterHeaderBytes + pixels.length))
      const header = new DataView(image.buffer)
      header.setUint32(0, width, true)
      header.setUint32(4, height, true)
      if (!paperTone) image.set(pixels, rasterHeaderBytes)
      else {
        const [red, green, blue] = paper
        for (let source = 0, target = rasterHeaderBytes; source < pixels.length; source += 4, target += 4) {
          image[target] = red[pixels[source]]
          image[target + 1] = green[pixels[source + 1]]
          image[target + 2] = blue[pixels[source + 2]]
          image[target + 3] = 255
        }
      }
      return image
    } finally { pixmap.destroy() }
  } finally { page.destroy() }
}

async function render(message: Extract<PdfRasterMessage, { type: 'render' }>): Promise<void> {
  active = message.id
  try {
    const mupdf = await loaded
    await warmed
    let document = documents.get(message.key)
    if (document) documents.delete(message.key)
    else {
      if (!message.pdf) throw new Error('PDF raster document is unavailable')
      while (documents.size >= 2) {
        const [key, previous] = documents.entries().next().value!
        documents.delete(key)
        previous.destroy()
      }
      document = mupdf.Document.openDocument(message.pdf, 'application/pdf')
      // The browser renderer asks for the password; this worker never sees one.
      if (document.needsPassword()) {
        document.destroy()
        throw new Error('PDF requires a password')
      }
    }
    // Kept even when this request was cancelled: the next page of the document skips parsing.
    documents.set(message.key, document)
    if (cancelled.has(message.id)) throw new Error('PDF raster cancelled')
    if (message.pageIndex >= document.countPages()) throw new Error('Invalid PDF page')
    const image = draw(mupdf, document, message)
    port.postMessage({ type: 'result', id: message.id, image, documents: [...documents.keys()] } satisfies PdfRasterReply, [image.buffer])
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), documents: [...documents.keys()] } satisfies PdfRasterReply)
  } finally {
    cancelled.delete(message.id)
    active = undefined
  }
}
