import { readFile, stat } from 'node:fs/promises'
import type { FreddieStore } from './store'
import { PdfRasterWorkerClient, type PdfRasterParameters } from './pdfRasterWorkerClient'

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

interface Pending { run: () => Promise<void>; reject: (error: Error) => void }

/** Registered PDFs only; derived PNGs are memory-only, bounded by bytes and entry count. */
export class PdfRasterService {
  private readonly cache = new Map<string, Uint8Array>()
  private cacheBytes = 0
  private queue: Pending[] = []
  private running = false
  private closed = false

  constructor(private readonly store: FreddieStore, private readonly worker: Pick<PdfRasterWorkerClient, 'render' | 'close'> = new PdfRasterWorkerClient(), private readonly budget = 64 * 1024 * 1024) {}

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
      const pending: Pending = { reject: (error) => { signal.removeEventListener('abort', cancel); reject(error) }, run: async () => {
        signal.removeEventListener('abort', cancel)
        try {
          signal.throwIfAborted()
          const reused = this.cache.get(key)
          const png = reused ?? await this.worker.render(documentKey, () => readWhole(path), parameters, signal)
          signal.throwIfAborted()
          if (this.closed) throw new Error('PDF raster service is closed')
          if (!reused && png.byteLength <= this.budget) {
            this.cache.set(key, png); this.cacheBytes += png.byteLength
            while (this.cacheBytes > this.budget || this.cache.size > 64) {
              const [oldKey, old] = this.cache.entries().next().value!
              this.cache.delete(oldKey); this.cacheBytes -= old.byteLength
            }
          }
          resolve(png)
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

  private drain(): void {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) return
    this.running = true
    void next.run().finally(() => { this.running = false; this.drain() })
  }

  async close(): Promise<void> {
    this.closed = true
    this.cache.clear(); this.cacheBytes = 0
    for (const pending of this.queue.splice(0)) pending.reject(new Error('PDF raster service is closed'))
    await this.worker.close()
  }
}
