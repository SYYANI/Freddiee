import { afterEach, describe, expect, it, vi } from 'vitest'
import { rasterPdfPage } from '../src/readers/pdfRaster'

afterEach(() => vi.unstubAllGlobals())

describe('renderer PDF raster fallback', () => {
  it('stops asking the worker for a document after a failure, but not after cancellation', async () => {
    const fetch = vi.fn(async () => new Response('Not found', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { freddie: { shell: { pdfPageURL: (...parts: unknown[]) => `freddie://raster/${parts.join('/')}` } } })
    const cancelled = new AbortController()
    cancelled.abort()
    fetch.mockImplementationOnce(async () => { throw new DOMException('Aborted', 'AbortError') })
    await expect(rasterPdfPage('paper', 'pdf', 0, 1, 2, false, 'v1', cancelled.signal)).rejects.toThrow('Aborted')
    const signal = new AbortController().signal
    await expect(rasterPdfPage('paper', 'pdf', 0, 1, 2, false, 'v1', signal)).rejects.toThrow('PDF raster response 404')
    await expect(rasterPdfPage('paper', 'pdf', 1, 1, 2, false, 'v1', signal)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    // Another revision of the file gets its own attempt.
    await expect(rasterPdfPage('paper', 'pdf', 0, 1, 2, false, 'v2', signal)).rejects.toThrow('PDF raster response 404')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
