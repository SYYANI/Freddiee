import { mkdtemp, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { loadImage, createCanvas } from '@napi-rs/canvas'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FreddieStore } from '../electron/main/store'
import { PdfRasterService, parseRasterParameters } from '../electron/main/pdfRaster'
import { PdfRasterWorkerClient, type PdfRasterParameters } from '../electron/main/pdfRasterWorkerClient'

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
      const png = await raster.render('document', read, { ...parameters, pageIndex, paperTone }, signal)
      const image = await loadImage(png)
      expect([image.width, image.height]).toEqual(pageIndex === 0 ? [400, 600] : [600, 400])
      const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      expect([...context.getImageData(0, 0, 1, 1).data]).toEqual(paperTone ? [245, 237, 219, 255] : [255, 255, 255, 255])
      if (pageIndex === 0) expect([...context.getImageData(50, 500, 1, 1).data]).toEqual([255, 0, 0, 255])
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
    const png = await raster.render('cancel-render', read, parameters, new AbortController().signal)
    expect((await loadImage(png)).width).toBe(400)
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

  it('bounds PNG cache bytes, refreshes LRU order, and invalidates atomic file replacements', async () => {
    const fixture = await storeFixture()
    const render = vi.fn<PdfRasterWorkerClient['render']>(async () => new Uint8Array([1, 2, 3, 4]))
    const service = new PdfRasterService(fixture.store, { render, close: async () => {} }, 8)
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
    const service = new PdfRasterService(fixture.store, { render, close: async () => {} })
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
})
