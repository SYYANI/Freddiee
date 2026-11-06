import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { pdfjsResourceBase } from './pdfjsResources'

export interface PdfRasterResources { pdfjsModuleURL: string; canvasModuleURL: string; standardFontDataURL: string; cMapURL: string; wasmURL: string }
export interface PdfRasterParameters { pageIndex: number; scale: number; ratio: number; paperTone: boolean }
export type PdfRasterMessage = { type: 'cancel'; id: number } | ({ type: 'render'; id: number; key: string; pdf?: Uint8Array } & PdfRasterParameters)
export type PdfRasterReply = { id: number; documents: string[] } & ({ type: 'result'; png: Uint8Array } | { type: 'error'; message: string })

/** One persistent, credential-free worker; only its current request and two parsed PDFs are kept. */
export class PdfRasterWorkerClient {
  private worker?: Worker
  private documents = new Set<string>()
  private nextID = 0
  private stopped = false
  private busy = false
  private active?: { id: number; finish: (error?: unknown, png?: Uint8Array) => void }

  constructor(private readonly workerPath = join(__dirname, 'pdfRasterWorker.cjs')) {}

  private start(): Worker {
    if (this.stopped) throw new Error('PDF raster worker is closed')
    if (this.worker) return this.worker
    const root = dirname(require.resolve('pdfjs-dist/package.json')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    const worker = new Worker(this.workerPath, { workerData: {
      pdfjsModuleURL: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
      canvasModuleURL: pathToFileURL(require.resolve('@napi-rs/canvas')).href,
      standardFontDataURL: pdfjsResourceBase(join(root, 'standard_fonts')), cMapURL: pdfjsResourceBase(join(root, 'cmaps')),
      wasmURL: pdfjsResourceBase(join(root, 'wasm'))
    } satisfies PdfRasterResources })
    this.worker = worker
    const fail = (error: unknown): void => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.documents.clear()
      this.active?.finish(error)
      void worker.terminate()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`PDF raster worker exited (${code})`)))
    worker.on('message', (reply: PdfRasterReply) => {
      if (this.worker !== worker || reply.id !== this.active?.id) return
      this.documents = new Set(reply.documents)
      if (reply.type === 'result') this.active.finish(undefined, reply.png)
      else this.active.finish(new Error(reply.message))
    })
    return worker
  }

  async render(key: string, read: () => Promise<Uint8Array>, parameters: PdfRasterParameters, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    if (this.busy) throw new Error('PDF raster worker already busy')
    this.busy = true
    try {
      const worker = this.start()
      const pdf = this.documents.has(key) ? undefined : await read()
      signal.throwIfAborted()
      if (this.worker !== worker) throw new Error('PDF raster worker is closed')
      const id = ++this.nextID
      return await new Promise<Uint8Array>((resolve, reject) => {
        const abort = (): void => worker.postMessage({ type: 'cancel', id } satisfies PdfRasterMessage)
        this.active = { id, finish: (error, png) => {
          this.active = undefined
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(signal.reason)
          else if (error !== undefined) reject(error)
          else resolve(png!)
        } }
        signal.addEventListener('abort', abort, { once: true })
        try { worker.postMessage({ type: 'render', id, key, pdf, ...parameters } satisfies PdfRasterMessage, pdf ? [pdf.buffer as ArrayBuffer] : []) }
        catch (error) { this.active.finish(error) }
        if (signal.aborted) abort()
      })
    } finally { this.busy = false }
  }

  async close(): Promise<void> {
    this.stopped = true
    this.active?.finish(new Error('PDF raster worker is closed'))
    const worker = this.worker
    this.worker = undefined
    this.documents.clear()
    if (worker) await worker.terminate()
  }
}
