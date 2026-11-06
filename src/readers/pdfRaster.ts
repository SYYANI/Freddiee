import { fetchRasterBitmap } from './pdfRasterImage'
import type { RasterFetchReply, RasterFetchRequest } from './pdfRasterFetch.worker'

// A document whose worker raster failed (worker unavailable, unsupported content, oversized file)
// uses the browser renderer for the rest of the session. Retrying per page would make the main
// process read and transfer the whole PDF again for every page and repeat the same failure.
const unavailable = new Set<string>()

interface PendingFetch { resolve: (bitmap: ImageBitmap) => void; reject: (error: unknown) => void; retry: () => void }

/** One dedicated worker receives page images; without one (tests, a failed start) this thread does. */
class RasterFetcher {
  private worker?: Worker
  private failed = typeof Worker === 'undefined'
  private nextID = 0
  private readonly pending = new Map<number, PendingFetch>()

  private start(): Worker | undefined {
    if (this.failed) return undefined
    if (this.worker) return this.worker
    try {
      const worker = new Worker(new URL('./pdfRasterFetch.worker.ts', import.meta.url), { type: 'module', name: 'pdf-raster-fetch' })
      worker.onmessage = ({ data }: MessageEvent<RasterFetchReply>) => {
        const request = this.pending.get(data.id)
        if (!request) {
          if ('bitmap' in data) data.bitmap.close()
          return
        }
        this.pending.delete(data.id)
        if ('bitmap' in data) request.resolve(data.bitmap)
        else request.reject(new Error(data.error))
      }
      worker.onerror = () => {
        this.failed = true
        this.worker = undefined
        worker.terminate()
        // The main process still has the pages; only this worker failed, so fetch them here instead.
        const requests = [...this.pending.values()]
        this.pending.clear()
        for (const request of requests) request.retry()
      }
      this.worker = worker
      return worker
    } catch {
      this.failed = true
      return undefined
    }
  }

  fetch(url: string, signal: AbortSignal): Promise<ImageBitmap> {
    signal.throwIfAborted()
    const worker = this.start()
    if (!worker) return fetchRasterBitmap(url, signal)
    const id = ++this.nextID
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (!this.pending.delete(id)) return
        worker.postMessage({ type: 'cancel', id } satisfies RasterFetchRequest)
        reject(signal.reason)
      }
      this.pending.set(id, {
        resolve: (bitmap) => { signal.removeEventListener('abort', abort); resolve(bitmap) },
        reject: (error) => { signal.removeEventListener('abort', abort); reject(error) },
        retry: () => { signal.removeEventListener('abort', abort); fetchRasterBitmap(url, signal).then(resolve, reject) }
      })
      signal.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type: 'fetch', id, url } satisfies RasterFetchRequest)
    })
  }
}

const fetcher = new RasterFetcher()
const bitmapCanvases = new WeakSet<HTMLCanvasElement>()

/** Drops a page bitmap's backing store now rather than whenever the canvas is collected. */
export function releasePageCanvas(canvas: HTMLCanvasElement): void {
  if (bitmapCanvases.has(canvas)) canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(null)
  canvas.width = 0
  canvas.height = 0
}

/** Fetch a registered page rendered outside the UI process; no paths or drawing commands cross the bridge. */
export async function rasterPdfPage(paperId: string, attachmentId: string, index: number, scale: number, ratio: number,
  paperTone: boolean, revision: string, signal: AbortSignal): Promise<HTMLCanvasElement | undefined> {
  const makeURL = window.freddie.shell?.pdfPageURL
  const key = JSON.stringify([paperId, attachmentId, revision])
  if (!makeURL || unavailable.has(key)) return undefined
  try {
    const bitmap = await fetcher.fetch(makeURL(paperId, attachmentId, index, scale, ratio, paperTone, revision), signal)
    if (signal.aborted) {
      bitmap.close()
      signal.throwIfAborted()
    }
    // Hand the bitmap to the canvas without drawing it again: no copy on this thread.
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap)
    bitmapCanvases.add(canvas)
    return canvas
  } catch (error) {
    if (!signal.aborted) unavailable.add(key)
    throw error
  }
}
