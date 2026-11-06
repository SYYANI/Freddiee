import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

export interface PdfRasterResources { mupdfModuleURL: string }
export interface PdfRasterParameters { pageIndex: number; scale: number; ratio: number; paperTone: boolean }
export type PdfRasterMessage = { type: 'cancel'; id: number } | ({ type: 'render'; id: number; key: string; pdf?: Uint8Array } & PdfRasterParameters)
export type PdfRasterReply = { id: number; documents: string[] } & ({ type: 'result'; image: Uint8Array } | { type: 'error'; message: string })
export type PdfRasterWorker = Pick<PdfRasterWorkerClient, 'render' | 'close'> & Partial<Pick<PdfRasterWorkerClient, 'warm' | 'holds'>>

/**
 * One credential-free worker drawing with MuPDF; only its current request and two parsed PDFs are
 * kept. MuPDF's WebAssembly memory never shrinks, so a worker idle for `idleMs` exits and gives it
 * back; the next request starts another (MuPDF compiles in tens of milliseconds).
 */
export class PdfRasterWorkerClient {
  private worker?: Worker
  private documents = new Set<string>()
  private nextID = 0
  private stopped = false
  private busy = false
  private idle?: NodeJS.Timeout
  private active?: { id: number; finish: (error?: unknown, image?: Uint8Array) => void }

  constructor(private readonly workerPath = join(__dirname, 'pdfRasterWorker.cjs'), private readonly idleMs = 120_000) {}

  private start(): Worker {
    if (this.stopped) throw new Error('PDF raster worker is closed')
    if (this.worker) return this.worker
    // Loaded from outside the archive: Emscripten reads mupdf-wasm.wasm beside the module.
    const mupdf = require.resolve('mupdf').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    const worker = new Worker(this.workerPath, { workerData: { mupdfModuleURL: pathToFileURL(mupdf).href } satisfies PdfRasterResources })
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
      if (reply.type === 'result') this.active.finish(undefined, reply.image)
      else this.active.finish(new Error(reply.message))
    })
    return worker
  }

  /** Starts the worker and MuPDF's compilation ahead of the first page. */
  warm(): void {
    if (this.stopped) return
    this.start()
    this.scheduleRetirement()
  }

  private scheduleRetirement(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      const worker = this.worker
      if (this.busy || !worker) return
      this.worker = undefined
      this.documents.clear()
      void worker.terminate()
    }, this.idleMs)
    this.idle.unref?.()
  }

  /** Whether the worker still holds this document parsed, so a request for it skips reading and parsing. */
  holds(key: string): boolean {
    return this.worker !== undefined && this.documents.has(key)
  }

  async render(key: string, read: () => Promise<Uint8Array>, parameters: PdfRasterParameters, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    if (this.busy) throw new Error('PDF raster worker already busy')
    this.busy = true
    clearTimeout(this.idle)
    try {
      const worker = this.start()
      const pdf = this.documents.has(key) ? undefined : await read()
      signal.throwIfAborted()
      if (this.worker !== worker) throw new Error('PDF raster worker is closed')
      const id = ++this.nextID
      return await new Promise<Uint8Array>((resolve, reject) => {
        const abort = (): void => worker.postMessage({ type: 'cancel', id } satisfies PdfRasterMessage)
        this.active = { id, finish: (error, image) => {
          this.active = undefined
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(signal.reason)
          else if (error !== undefined) reject(error)
          else resolve(image!)
        } }
        signal.addEventListener('abort', abort, { once: true })
        try { worker.postMessage({ type: 'render', id, key, pdf, ...parameters } satisfies PdfRasterMessage, pdf ? [pdf.buffer as ArrayBuffer] : []) }
        catch (error) { this.active.finish(error) }
        if (signal.aborted) abort()
      })
    } finally {
      this.busy = false
      if (!this.stopped) this.scheduleRetirement()
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    clearTimeout(this.idle)
    this.active?.finish(new Error('PDF raster worker is closed'))
    const worker = this.worker
    this.worker = undefined
    this.documents.clear()
    if (worker) await worker.terminate()
  }
}
