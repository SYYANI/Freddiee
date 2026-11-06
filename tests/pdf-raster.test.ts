import { mkdtemp, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FreddieStore } from '../electron/main/store'
import { PdfRasterService, parseRasterParameters } from '../electron/main/pdfRaster'
import { PdfRasterWorkerClient, type PdfRasterParameters, type PdfRasterWorker } from '../electron/main/pdfRasterWorkerClient'
import { rasterHeaderBytes } from '../electron/main/pdfRasterFormat'
import { warmupPdf } from '../electron/main/pdfRasterWarmup'

let root: string, workerPath: string, pdfBytes: Uint8Array
const clients: PdfRasterWorkerClient[] = []
const parameters: PdfRasterParameters = { pageIndex: 0, scale: 1, ratio: 2, paperTone: false }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'freddie-raster-test-'))
  workerPath = join(root, 'pdfRasterWorker.cjs')
  await build({ entryPoints: [resolve('electron/main/pdfRasterWorker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([200, 300])
  page.drawRectangle({ x: 20, y: 20, width: 30, height: 40, color: rgb(1, 0, 0) })
  page.drawText('Selectable original text', { x: 20, y: 200, size: 10, font })
  pdf.addPage([200, 300]).setRotation(degrees(90))
  pdfBytes = await pdf.save()
})
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); vi.restoreAllMocks() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

/** Reads the raw raster format: little-endian width and height, then straight RGBA rows. */
function decode(image: Uint8Array) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const width = view.getUint32(0, true), height = view.getUint32(4, true)
  expect(image.byteLength).toBe(rasterHeaderBytes + width * height * 4)
  const pixel = (x: number, y: number) => [...image.subarray(rasterHeaderBytes + (y * width + x) * 4, rasterHeaderBytes + (y * width + x) * 4 + 4)]
  return { width, height, pixel }
}

function client(path = workerPath): PdfRasterWorkerClient { const value = new PdfRasterWorkerClient(path); clients.push(value); return value }

async function storeFixture() {
  const directory = join(root, randomUUID()), store = new FreddieStore(directory)
  await store.initialize()
  const paperId = randomUUID(), attachmentId = randomUUID(), date = new Date().toISOString()
  await store.addPaper({ id: paperId, title: 'Raster test', authors: [], abstract: '', categories: [], tags: [], isFavorite: false, createdAt: date, modifiedAt: date },
    [{ id: attachmentId, paperId, kind: 'pdf', filename: 'paper.pdf', source: 'localImport', createdAt: date }])
  await mkdir(store.paperDirectory(paperId), { recursive: true })
  const path = store.attachmentPath(paperId, attachmentId)
  await writeFile(path, pdfBytes)
  return { store, paperId, attachmentId, path }
}

describe('PDF raster worker', () => {
  it('renders pixels with matching scale, rotation and Paper Tone without changing PDF bytes', async () => {
    const raster = client(), read = vi.fn(async () => pdfBytes.slice()), signal = new AbortController().signal
    for (const [pageIndex, paperTone] of [[0, false], [1, true]] as const) {
      const image = decode(await raster.render('document', read, { ...parameters, pageIndex, paperTone }, signal))
      expect([image.width, image.height]).toEqual(pageIndex === 0 ? [400, 600] : [600, 400])
      expect(image.pixel(0, 0)).toEqual(paperTone ? [245, 237, 219, 255] : [255, 255, 255, 255])
      if (pageIndex === 0) expect(image.pixel(50, 500)).toEqual([255, 0, 0, 255])
    }
    expect(read).toHaveBeenCalledOnce()
    expect(pdfBytes.slice(0, 4)).toEqual(new Uint8Array([37, 80, 68, 70]))
    await expect(raster.render('document', read, { ...parameters, pageIndex: 100 }, signal)).rejects.toThrow('Invalid PDF page')
  }, 15000)

  it('bounds the parsed document cache and reopens an evicted file', async () => {
    const raster = client(), read = vi.fn(async () => pdfBytes.slice()), signal = new AbortController().signal
    for (const key of ['one', 'two', 'three', 'one']) await raster.render(key, read, parameters, signal)
    expect(read).toHaveBeenCalledTimes(4)
  }, 15000)

  it('acknowledges an active cancellation before accepting another render and reuses the parsed PDF', async () => {
    const raster = client(), read = vi.fn(async () => pdfBytes.slice()), controller = new AbortController()
    const pending = raster.render('cancel-render', read, parameters, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise<void>((done) => setTimeout(done, 0))
    controller.abort()
    await rejected
    const image = await raster.render('cancel-render', read, parameters, new AbortController().signal)
    expect(decode(image).width).toBe(400)
    expect(read).toHaveBeenCalledOnce()
  }, 15000)

  it('rejects cancellation before loading bytes and closes a synchronously busy worker', async () => {
    const raster = client(), controller = new AbortController(), read = vi.fn(async () => pdfBytes.slice())
    controller.abort()
    await expect(raster.render('cancelled', read, parameters, controller.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    const path = join(root, 'busy.cjs')
    await writeFile(path, `require('node:worker_threads').parentPort.on('message', () => { while(true) Math.sqrt(Math.random()); });`)
    const busy = client(path)
    const pending = busy.render('busy', read, parameters, new AbortController().signal)
    const rejection = expect(pending).rejects.toThrow('closed')
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    let heartbeat = false
    await new Promise<void>((done) => setTimeout(() => { heartbeat = true; done() }, 30))
    expect(heartbeat).toBe(true)
    await busy.close()
    await rejection
  })
})

describe('PDF raster worker warm-up page', () => {
  it('is a well-formed PDF that PDF.js reads without repairing it', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const log = vi.spyOn(console, 'log')
    const task = pdfjs.getDocument({ data: warmupPdf(), verbosity: pdfjs.VerbosityLevel.WARNINGS, useSystemFonts: false,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
    try {
      const document = await task.promise
      expect(document.numPages).toBe(1)
      const text = await (await document.getPage(1)).getTextContent()
      expect(text.items.map((item) => ('str' in item ? item.str : '')).join(' ')).toContain('Aa 1')
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/Warning/)
    } finally { await task.destroy() }
  })
})

describe('registered PDF raster resource', () => {
  it('rejects invalid dimensions, page indices and appearance values', () => {
    const url = new URL('freddie://paper/id/raster/attachment/0?scale=1&ratio=2&tone=paper')
    expect(parseRasterParameters(url, '7')).toEqual({ ...parameters, pageIndex: 7, paperTone: true })
    for (const [name, value] of [['scale', 'Infinity'], ['scale', '-1'], ['scale', '6'], ['ratio', '0'], ['ratio', '100'], ['tone', 'raw']] as const) {
      const invalid = new URL(url); invalid.searchParams.set(name, value)
      expect(() => parseRasterParameters(invalid, '0')).toThrow('Invalid')
    }
    for (const page of ['-1', '1.5', '../0', '10000000', 'NaN']) expect(() => parseRasterParameters(url, page)).toThrow('Invalid')
  })

  it('bounds bitmap cache bytes, refreshes LRU order, and invalidates atomic file replacements', async () => {
    const fixture = await storeFixture()
    const render = vi.fn<PdfRasterWorkerClient['render']>(async () => new Uint8Array([1, 2, 3, 4]))
    const service = new PdfRasterService(fixture.store, () => ({ render, close: async () => {} }), 8)
    const run = (pageIndex: number) => service.render(fixture.paperId, fixture.attachmentId, { ...parameters, pageIndex }, new AbortController().signal)
    await run(0); await run(1); await run(0)
    expect(render).toHaveBeenCalledTimes(2)
    await run(2); await run(1)
    expect(render).toHaveBeenCalledTimes(4)
    await writeFile(fixture.path + '.incoming', await readFile(fixture.path))
    await rename(fixture.path + '.incoming', fixture.path)
    await run(1)
    expect(render).toHaveBeenCalledTimes(5)
    await service.close()
  })

  it('cancels queued requests, enforces registered attachments and limits file input', async () => {
    const fixture = await storeFixture()
    let finish!: (png: Uint8Array) => void
    const render = vi.fn<PdfRasterWorkerClient['render']>(() => new Promise((resolve) => { finish = resolve }))
    const service = new PdfRasterService(fixture.store, () => ({ render, close: async () => {} }), undefined, 1)
    const first = service.render(fixture.paperId, fixture.attachmentId, parameters, new AbortController().signal)
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const pending = service.render(fixture.paperId, fixture.attachmentId, { ...parameters, pageIndex: 1 }, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    controller.abort()
    await rejected
    finish(new Uint8Array([1]))
    await first
    expect(render).toHaveBeenCalledOnce()
    await expect(service.render('../escape', fixture.attachmentId, parameters, new AbortController().signal)).rejects.toThrow()
    await truncate(fixture.path, 256 * 1024 * 1024 + 1)
    await expect(service.render(fixture.paperId, fixture.attachmentId, parameters, new AbortController().signal)).rejects.toThrow('limit')
    await service.close()
  })

  it('draws on two workers in parallel and sends a document to the worker that already parsed it', async () => {
    const fixture = await storeFixture()
    const second = randomUUID(), date = new Date().toISOString()
    await fixture.store.addAttachment({ id: second, paperId: fixture.paperId, kind: 'translatedPDF', filename: 'translated.pdf', source: 'localImport', createdAt: date })
    await writeFile(fixture.store.attachmentPath(fixture.paperId, second), pdfBytes)
    const workers: Array<{ name: string; held: Set<string>; finish: Array<() => void> }> = []
    const calls: string[] = []
    const create = (): PdfRasterWorker => {
      const state = { name: `w${workers.length}`, held: new Set<string>(), finish: [] as Array<() => void> }
      workers.push(state)
      return {
        holds: (key) => state.held.has(key),
        render: (key, _read, parameters) => new Promise((resolve) => {
          calls.push(`${state.name}:${JSON.parse(key)[1] === second ? 'translated' : 'original'}:${parameters.pageIndex}`)
          state.finish.push(() => { state.held.add(key); resolve(new Uint8Array([parameters.pageIndex])) })
        }),
        close: async () => {}
      }
    }
    const service = new PdfRasterService(fixture.store, create)
    service.warm()
    const run = (attachment: string, pageIndex: number) => service.render(fixture.paperId, attachment, { ...parameters, pageIndex }, new AbortController().signal)
    const original = run(fixture.attachmentId, 0), translated = run(second, 0)
    await vi.waitFor(() => expect(calls).toEqual(['w0:original:0', 'w1:translated:0']))
    // A third request waits for a worker instead of starting another.
    const next = run(second, 1)
    await new Promise<void>((done) => setTimeout(done, 10))
    expect(workers).toHaveLength(2)
    workers[1].finish.shift()!()
    await translated
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]).toBe('w1:translated:1')
    workers[0].finish.shift()!(); workers[1].finish.shift()!()
    await Promise.all([original, next])
    await service.close()
  })
})
