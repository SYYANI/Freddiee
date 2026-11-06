import { readFile, stat } from 'node:fs/promises'
import type { FreddieStore } from './store'
import { PdfRasterWorkerClient, type PdfRasterParameters, type PdfRasterWorker } from './pdfRasterWorkerClient'

export function parseRasterParameters(url: URL, page: string): PdfRasterParameters {
  const scale = Number(url.searchParams.get('scale')), ratio = Number(url.searchParams.get('ratio'))
  if (!/^\d{1,7}$/.test(page) || !Number.isFinite(scale) || scale < 0.1 || scale > 5 || !Number.isFinite(ratio) || ratio < 0.01 || ratio > 3 ||
    !['default', 'paper'].includes(url.searchParams.get('tone') ?? 'default')) throw new Error('Invalid PDF raster request')
  return { pageIndex: Number(page), scale, ratio, paperTone: url.searchParams.get('tone') === 'paper' }
}

/** The bytes are transferred to the worker; avoid copying a file of up to 256 MiB first. */
async function readWhole(path: string): Promise<Uint8Array> {
  const data = await readFile(path)
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? new Uint8Array(data.buffer) : new Uint8Array(data)
}

interface Pending { documentKey: string; run: (worker: PdfRasterWorker) => Promise<void>; reject: (error: Error) => void }

/**
 * Registered PDFs only; derived bitmaps are memory-only, bounded by bytes and entry count.
 * Two workers draw in parallel, so one slow figure page no longer holds every other page (or the
 * other pane) behind it. A request goes to an idle worker that already holds its document.
 */
export class PdfRasterService {
  private readonly cache = new Map<string, Uint8Array>()
  private cacheBytes = 0
  private queue: Pending[] = []
  private readonly workers: PdfRasterWorker[] = []
  private readonly busy = new Set<PdfRasterWorker>()
  private closed = false

  constructor(private readonly store: FreddieStore, private readonly createWorker: () => PdfRasterWorker = () => new PdfRasterWorkerClient(),
    private readonly budget = 96 * 1024 * 1024, private readonly poolSize = 2) {}

  /**
   * Starts the workers ahead of the first page, so opening a paper waits neither for their imports nor
   * for V8 to compile PDF.js. Both start: an opening reader asks for two pages (or one in each pane) at once.
   */
  warm(): void {
    while (!this.closed && this.workers.length < this.poolSize) this.workers.push(this.createWorker())
    for (const worker of this.workers) worker.warm?.()
  }

  async render(paperId: string, attachmentId: string, parameters: PdfRasterParameters, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const attachment = this.store.attachment(paperId, attachmentId)
    if (!['pdf', 'translatedPDF'].includes(attachment.kind)) throw new Error('Not a PDF attachment')
    const path = this.store.attachmentPath(paperId, attachmentId)
    const info = await stat(path)
    signal.throwIfAborted()
    if (info.size > 256 * 1024 * 1024) throw new Error('PDF exceeds raster worker input limit')
    const documentKey = JSON.stringify([paperId, attachmentId, info.size, info.mtimeMs, info.ctimeMs, info.ino])
    const key = JSON.stringify([documentKey, parameters])
    const cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached }
    if (this.closed || this.queue.length >= 32) throw new Error('PDF raster queue unavailable')
    return new Promise((resolve, reject) => {
      const pending: Pending = { documentKey, reject: (error) => { signal.removeEventListener('abort', cancel); reject(error) }, run: async (worker) => {
        signal.removeEventListener('abort', cancel)
        try {
          signal.throwIfAborted()
          const reused = this.cache.get(key)
          const image = reused ?? await worker.render(documentKey, () => readWhole(path), parameters, signal)
          signal.throwIfAborted()
          if (this.closed) throw new Error('PDF raster service is closed')
          if (!reused && image.byteLength <= this.budget) {
            this.cache.set(key, image); this.cacheBytes += image.byteLength
            while (this.cacheBytes > this.budget || this.cache.size > 64) {
              const [oldKey, old] = this.cache.entries().next().value!
              this.cache.delete(oldKey); this.cacheBytes -= old.byteLength
            }
          }
          resolve(image)
        } catch (error) { reject(error) }
      } }
      const cancel = (): void => {
        const index = this.queue.indexOf(pending)
        if (index >= 0) { this.queue.splice(index, 1); reject(signal.reason) }
      }
      this.queue.push(pending)
      signal.addEventListener('abort', cancel, { once: true })
      this.drain()
    })
  }

  private idleWorker(documentKey: string): PdfRasterWorker | undefined {
    const idle = this.workers.filter((worker) => !this.busy.has(worker))
    const holding = idle.find((worker) => worker.holds?.(documentKey))
    if (holding) return holding
    // Another worker would parse the document a second time; start one only while every worker is busy.
    if (!idle.length && this.workers.length < this.poolSize) {
      const worker = this.createWorker()
      this.workers.push(worker)
      return worker
    }
    return idle[0]
  }

  private drain(): void {
    while (!this.closed && this.queue.length) {
      const worker = this.idleWorker(this.queue[0].documentKey)
      if (!worker) return
      const next = this.queue.shift()!
      this.busy.add(worker)
      void next.run(worker).finally(() => { this.busy.delete(worker); this.drain() })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.cache.clear(); this.cacheBytes = 0
    for (const pending of this.queue.splice(0)) pending.reject(new Error('PDF raster service is closed'))
    await Promise.all(this.workers.splice(0).map((worker) => worker.close()))
  }
}
