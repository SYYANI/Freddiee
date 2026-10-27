import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { assessOutline, enrichOutlineFonts, pdfOutlinePages, InvalidOutlineResponseError, headingLocations, heuristicOutline, organizedOutline, scanOutline, type OutlinePage } from '../electron/main/outlineExtraction'
import { DocumentOutlineService, latexOutline, outlineAlgorithmVersion } from '../electron/main/documentOutline'
import { FreddieStore, builtInProviders } from '../electron/main/store'
import type { SecretStore } from '../electron/main/secrets'
import { createTranslator, type Translator } from '../shared/i18n'
import { runDocumentOutlineWorker } from '../electron/main/documentOutlineWorkerClient'
import type { DocumentOutlineWorkerRunner } from '../electron/main/documentOutlineWorkerClient'
import { compileOutlineWorker } from './document-outline-worker-support'
import { currentOutlineID, isUntranslatedHeading, type DocumentOutlineEntry } from '../shared/outline'

let workerRoot: string
let workerPath: string
beforeAll(async () => {
  workerRoot = await mkdtemp(join(tmpdir(), 'freddie-outline-worker-'))
  workerPath = await compileOutlineWorker(workerRoot)
})
afterAll(async () => { await rm(workerRoot, { recursive: true, force: true }) })
const runWorker: DocumentOutlineWorkerRunner = (input, signal) => runDocumentOutlineWorker(input, signal, workerPath)
function createService(store: FreddieStore, secrets: SecretStore, translator: () => Translator,
  completion?: ConstructorParameters<typeof DocumentOutlineService>[3]) {
  return new DocumentOutlineService(store, secrets, translator, completion, runWorker)
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const entry = (title: string, pageIndex?: number, level = 1): DocumentOutlineEntry => ({ id: title, title, pageIndex, level })
const page = (text: string): OutlinePage => ({ text, lines: text.split('\n').map((title, offset) => ({ title, offset, size: 16, bold: true, fraction: (offset + 1) * 0.1 })) })

async function pdfBytes(bookmarks = false): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const body = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const titles = ['1 Introduction', '2 Methods', '2.1 Experiments', '3 Conclusion']
  for (const title of titles) {
    const page = document.addPage([500, 700])
    page.drawText('Repeated running header', { x: 30, y: 665, size: 15, font: bold })
    page.drawText(title, { x: 30, y: 580, size: 16, font: bold })
    for (let line = 0; line < 18; line += 1) page.drawText('Ordinary body paragraph with several words and a period.', { x: 30, y: 530 - line * 20, size: 11, font: body })
  }
  if (bookmarks) {
    const root = document.context.obj({ Type: 'Outlines' })
    const rootRef = document.context.register(root)
    const items = titles.map((title, index) => document.context.register(document.context.obj({ Title: PDFHexString.fromText(title), Parent: rootRef, Dest: [document.getPage(index).ref, PDFName.of('Fit')] })))
    items.forEach((ref, index) => {
      const item = document.context.lookup(ref) as typeof root
      if (items[index - 1]) item.set(PDFName.of('Prev'), items[index - 1])
      if (items[index + 1]) item.set(PDFName.of('Next'), items[index + 1])
    })
    root.set(PDFName.of('First'), items[0]); root.set(PDFName.of('Last'), items[items.length - 1])
    root.set(PDFName.of('Count'), document.context.obj(items.length))
    document.catalog.set(PDFName.of('Outlines'), rootRef)
  }
  return document.save()
}

async function fixture(bookmarks = false) {
  const root = await mkdtemp(join(tmpdir(), 'freddie-outline-')); roots.push(root)
  const store = new FreddieStore(root); await store.initialize()
  const paperId = randomUUID(), attachmentId = randomUUID()
  const timestamp = '2026-10-27T00:00:00Z'
  await store.ensurePaperDirectory(paperId)
  await writeFile(join(store.paperDirectory(paperId), 'paper.pdf'), await pdfBytes(bookmarks))
  await store.addPaper({ id: paperId, title: 'Test', abstract: '', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp }, [
    { id: attachmentId, paperId, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: timestamp }
  ])
  const secrets = { key: vi.fn(async () => 'test-secret') } as unknown as SecretStore
  const service = createService(store, secrets, () => createTranslator('en'))
  return { root, store, service, secrets, input: { paperId, attachmentId }, directory: store.paperDirectory(paperId), cachePath: join(store.paperDirectory(paperId), 'Resources', 'Outline', `${attachmentId}.json`) }
}

describe('document outline extraction parity', () => {
  it('repairs shared offsets and junk without changing the selectable embedded outline', () => {
    const entries = [entry('Introduction', 0), entry('Methods', 1), entry('Experiments', 2), entry('Conclusion', 3), entry('Cover', 0), entry('\\376\\377123', 0), entry('Broken destination')]
    const result = assessOutline(entries, ['Title', 'Introduction', 'Methods', 'Experiments', 'Conclusion'].map(page))
    expect(result.isGood).toBe(true)
    expect(result.repaired.map((item) => item.title)).toEqual(['Introduction', 'Methods', 'Experiments', 'Conclusion'])
    expect(result.repaired.map((item) => item.pageIndex)).toEqual([1, 2, 3, 4])
    expect(result.repaired.every((item) => item.fraction === 0.1)).toBe(true)
    expect(entries[0].pageIndex).toBe(0)
  })

  it('rejects single entries, gibberish, narrow coverage, and reversed page order', () => {
    const pages = Array.from({ length: 30 }, () => page('Introduction Methods Experiments Conclusion'))
    for (const items of [[entry('Introduction', 0)], [entry('12345', 0), entry('�', 2)], [entry('Introduction', 0), entry('Methods', 0), entry('Experiments', 0)], [entry('Introduction', 1), entry('Methods', 2), entry('Experiments', 3)], [entry('Absent', 4), entry('Also absent', 8)]]) expect(assessOutline(items, pages).isGood).toBe(false)
    expect(assessOutline([entry('Introduction', 3), entry('Methods', 2), entry('Experiments', 1), entry('Conclusion', 0)], ['Conclusion', 'Experiments', 'Methods', 'Introduction'].map(page)).isGood).toBe(false)
  })

  it('retains grouping bookmarks and accepts well formed textless scan targets', () => {
    const items = [entry('Part I'), entry('Introduction', 1, 2), entry('Methods', 2, 2), entry('Results', 3, 2), entry('Lonely group')]
    const result = assessOutline(items, ['Title', 'Introduction', 'Methods', 'Results'].map(page))
    expect(result.isGood).toBe(true)
    expect(result.repaired.map((item) => item.id)).toEqual(['Part I', 'Introduction', 'Methods', 'Results'])
    expect(assessOutline([entry('Introduction', 0), entry('Conclusion', 2)], ['', '', ''].map(page)).isGood).toBe(true)
  })

  it('matches whole heading lines and locates LaTeX headings in reading order', () => {
    expect(headingLocations('Method', page('We describe our method in detail.\n3. Method\nBody text\nSection 4 Experiments:')).map((line) => line.offset)).toEqual([1])
    expect(headingLocations('4 Experiments', page('Section 4 Experiments:'))).toHaveLength(1)
    expect(headingLocations('detail', page('We describe our method in detail.'))).toHaveLength(0)
    const pages = ['Abstract: our method beats prior experiments', 'Introduction\nMethod', 'Experiments'].map(page)
    const entries = latexOutline(['Introduction', 'Method', 'Experiments', 'Absent'].map((title, i) => ({ id: String(i), kind: 'sectionHeading', alignmentText: title, headingLevel: i + 1 })), pages)
    expect(entries.map((item) => item.pageIndex)).toEqual([1, 1, 2])
    expect(entries.map((item) => item.level)).toEqual([1, 2, 3])
  })

  it('keeps original coordinates for partial translations and follows headings on the same page', () => {
    const items = [{ ...entry('Methods', 1), fraction: 0.1 }, { ...entry('Experiments', 1), fraction: 0.7 }]
    expect(currentOutlineID(items, 1, 0.4)).toBe('Methods')
    expect(currentOutlineID(items, 1, 0.8)).toBe('Experiments')
    expect(currentOutlineID(items, 2)).toBe('Experiments')
    expect(isUntranslatedHeading(entry('Methods', 2), 3)).toBe(false)
    expect(isUntranslatedHeading(entry('Results', 3), 3)).toBe(true)
    expect(isUntranslatedHeading(entry('Appendix', 17), 3)).toBe(true)
  })

  it('uses section font bands rather than the document title to infer levels', () => {
    const pages = ['1 Introduction', '2 Methods', 'References'].map((title) => ({ text: title, lines: [
      { title, size: 16, bold: true, fraction: 0.2, offset: 0 },
      { title: '2.1 Setup', size: 13, bold: true, fraction: 0.3, offset: 1 },
      { title: 'Ordinary body text has many words repeated with a period.'.repeat(20), size: 11, bold: false, fraction: 0.4, offset: 2 }
    ] }))
    pages[0].lines.unshift({ title: 'A Large Paper Title', size: 24, bold: true, fraction: 0.1, offset: -1 })
    const levels = Object.fromEntries(heuristicOutline(pages).map((item) => [item.title, item.level]))
    expect(levels).toMatchObject({ '1 Introduction': 1, '2 Methods': 1, References: 1, '2.1 Setup': 2, 'A Large Paper Title': 1 })
  })

  it('preserves scan pages and nested formatted heading titles', () => {
    expect(scanOutline(String.raw`\section{Introduction} text \subsection{A \textbf{nested} heading}`, 3).map(({ title, level, pageIndex }) => ({ title, level, pageIndex }))).toEqual([
      { title: 'Introduction', level: 1, pageIndex: 3 }, { title: 'A nested heading', level: 2, pageIndex: 3 }
    ])
  })

  it('constrains model choices to existing candidates, valid levels, source order and coordinates', () => {
    const items = [entry('Intro', 0), entry('Methods', 2), entry('Results', 3)]
    expect(organizedOutline(items, '```json\n[{"id":"Results","level":2,"pageIndex":999},{"id":"invented","level":1},{"id":"Intro","level":1},{"id":"Methods","level":7}]\n```')).toEqual([items[0], { ...items[2], level: 2 }])
  })
})

describe('document outline service', () => {
  it('extracts a real PDF, removes running headers and atomically caches manual selection without rewriting the PDF', async () => {
    const f = await fixture()
    const original = await readFile(join(f.directory, 'paper.pdf'))
    const cache = await f.service.run(f.input, randomUUID())
    expect(cache.selectedSource).toBe('automatic')
    expect(cache.candidates.map((item) => item.title)).toEqual(['1 Introduction', '2 Methods', '2.1 Experiments', '3 Conclusion'])
    expect(cache.candidates[2].level).toBe(2)
    const selected = await f.service.run(f.input, randomUUID(), 'automatic')
    expect(selected.userSelectedSource).toBe('automatic')
    const obsolete = { ...selected, algorithmVersion: 0, variants: [] }
    await writeFile(f.cachePath, JSON.stringify(obsolete))
    const rebuilt = await f.service.run(f.input, randomUUID())
    expect(rebuilt.algorithmVersion).toBe(outlineAlgorithmVersion)
    expect(rebuilt.candidates).toHaveLength(4)
    expect(await readFile(join(f.directory, 'paper.pdf'))).toEqual(original)
    expect(await readdir(join(f.directory, 'Resources', 'Outline'))).toEqual([`${f.input.attachmentId}.json`])
    expect(f.secrets.key).not.toHaveBeenCalled()
  })

  it('uses real fit-page bookmarks and defers heuristics until requested', async () => {
    const f = await fixture(true)
    const cache = await f.service.run(f.input, randomUUID())
    expect(cache.selectedSource).toBe('pdf')
    expect(cache.deferredCandidates).toBe(true)
    expect(cache.candidates).toEqual([])
    expect(cache.variants[0].entries.map((item) => item.pageIndex)).toEqual([0, 1, 2, 3])
    expect(cache.variants[0].entries.every((item) => item.fraction! < 0.3)).toBe(true)
    const generated = await f.service.run(f.input, randomUUID(), 'automatic')
    expect(generated.selectedSource).toBe('automatic')
    expect(generated.deferredCandidates).toBe(false)
    expect(generated.candidates).toHaveLength(4)
    expect((await f.service.run(f.input, randomUUID())).selectedSource).toBe('automatic')
  })

  it('refreshes sidecars and preserves user choice while keeping scan targets on original pages', async () => {
    const f = await fixture()
    const before = await f.service.run(f.input, randomUUID(), 'automatic')
    const typeset = join(f.directory, 'Resources', 'ScanRebuild', 'typeset')
    await mkdir(typeset, { recursive: true })
    await writeFile(join(typeset, 'page-0004.page.tex'), String.raw`\section{Scan conclusion}`)
    const after = await f.service.run(f.input, randomUUID())
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.selectedSource).toBe('automatic')
    expect(after.variants.find((variant) => variant.source === 'scan')?.entries[0].pageIndex).toBe(3)
    await f.service.run(f.input, randomUUID(), 'scan')
    expect((await f.service.run(f.input, randomUUID())).selectedSource).toBe('scan')
  })

  it('loads validated native LaTeX sidecars without source acquisition and rejects corrupt caches', async () => {
    const f = await fixture()
    await f.store.updatePaper(f.input.paperId, { arxivId: '2401.00001', arxivVersion: 'v1' })
    const identifier = '2401.00001v1'
    const key = createHash('sha256').update(`schema=1|extractor=3|source=${identifier}`).digest('hex').slice(0, 24)
    const root = join(f.directory, 'Resources', 'LaTeXSemantic')
    await mkdir(root, { recursive: true })
    const blocks = ['Introduction', 'Methods', 'Experiments', 'Conclusion'].map((title, ordinal) => ({
      id: `s${ordinal}`, ordinal, kind: 'sectionHeading', alignmentText: title, translationTemplate: title, rawSource: title,
      sectionPath: [{ title, level: ordinal === 2 ? 2 : 1 }], atoms: []
    }))
    const data = JSON.stringify({ schemaVersion: 1, sourceIdentifier: identifier, blocks })
    await writeFile(join(root, `semantic-${key}.json`), data)
    await writeFile(join(root, `semantic-${key}.metadata.json`), JSON.stringify({ cacheSchemaVersion: 1, extractorAlgorithmVersion: 3, sourceIdentifier: identifier, semanticSHA256: createHash('sha256').update(data).digest('hex') }))
    const fetch = vi.spyOn(globalThis, 'fetch')
    try {
      const cache = await f.service.run(f.input, randomUUID())
      expect(cache.selectedSource).toBe('latex')
      expect(cache.variants.find((variant) => variant.source === 'latex')?.entries.map((entry) => [entry.pageIndex, entry.level])).toEqual([[0, 1], [1, 1], [2, 2], [3, 1]])
      expect(fetch).not.toHaveBeenCalled()
      await writeFile(f.cachePath, JSON.stringify({ ...cache, variants: [{ source: 'latex', entries: [{ title: 123 }] }] }))
      expect((await f.service.run(f.input, randomUUID())).variants.find((variant) => variant.source === 'latex')?.entries).toHaveLength(4)
    } finally { fetch.mockRestore() }
  })

  it('keeps explicit bookmark coordinates even when the title is mentioned earlier on the page', async () => {
    const f = await fixture()
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([500, 700])
    page.drawText('An ordinary paragraph about methods', { x: 30, y: 640, font, size: 11 })
    page.drawText('Methods', { x: 30, y: 300, font, size: 16 })
    const root = pdf.context.obj({ Type: 'Outlines' }), rootRef = pdf.context.register(root)
    const item = pdf.context.register(pdf.context.obj({ Title: PDFHexString.fromText('Methods'), Parent: rootRef, Dest: [page.ref, PDFName.of('XYZ'), 0, 318, null] }))
    root.set(PDFName.of('First'), item); root.set(PDFName.of('Last'), item)
    root.set(PDFName.of('Count'), pdf.context.obj(1)); pdf.catalog.set(PDFName.of('Outlines'), rootRef)
    await writeFile(join(f.directory, 'paper.pdf'), await pdf.save())
    const cache = await f.service.run(f.input, randomUUID())
    expect(cache.variants.find((variant) => variant.source === 'pdf')?.entries[0].fraction).toBeCloseTo(382 / 700, 5)
  })

  it('does not recreate a paper deleted while organization is in flight', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    const service = createService(f.store, f.secrets, () => createTranslator('en'), async (request) => {
      await f.store.deletePaper(f.input.paperId)
      return { text: JSON.stringify(JSON.parse(request.messages[1].content as string).map((item: DocumentOutlineEntry) => ({ id: item.id, level: 1 }))), sources: [] }
    })
    await expect(service.run(f.input, randomUUID(), 'organize')).rejects.toThrow()
    await expect(readdir(f.directory)).rejects.toThrow()
  })

  it('organizes with the PDF route and persists only validated IDs, never credentials', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    const completion = vi.fn(async (request) => ({ text: JSON.stringify([...JSON.parse(request.messages[1].content as string).reverse().map((item: DocumentOutlineEntry) => ({ id: item.id, level: 2, title: 'invented', pageIndex: 999 })), { id: 'invented', level: 1 }]), sources: [] }))
    const service = createService(f.store, f.secrets, () => createTranslator('en'), completion)
    const result = await service.run(f.input, randomUUID(), 'organize')
    expect(result.selectedSource).toBe('ai')
    expect(result.variants.find((item) => item.source === 'ai')?.entries.map((item) => item.title)).toEqual(result.candidates.map((item) => item.title))
    expect(result.variants.find((item) => item.source === 'ai')?.entries.map((item) => item.pageIndex)).toEqual([0, 1, 2, 3])
    expect((await service.run(f.input, randomUUID())).userSelectedSource).toBe('ai')
    expect(await readFile(f.cachePath, 'utf8')).not.toContain('test-secret')
    expect(completion.mock.calls[0][0].model).toBe(builtInProviders[0].model.modelName)
  })

  it('discards AI results if the document changes during the request', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    const service = createService(f.store, f.secrets, () => createTranslator('en'), async (request) => {
      await writeFile(join(f.directory, 'paper.pdf'), await pdfBytes(true))
      return { text: JSON.stringify(JSON.parse(request.messages[1].content as string).map((item: DocumentOutlineEntry) => ({ id: item.id, level: 1 }))), sources: [] }
    })
    await expect(service.run(f.input, randomUUID(), 'organize')).rejects.toThrow('The document changed')
    expect(JSON.parse(await readFile(f.cachePath, 'utf8')).selectedSource).toBe('automatic')
  })

  it('stops active and queued outline work on shutdown and refuses new requests', async () => {
    const f = await fixture()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const extract = vi.fn<DocumentOutlineWorkerRunner>(async (_data, signal) => {
      started()
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const service = new DocumentOutlineService(f.store, f.secrets, () => createTranslator('en'), undefined, extract)
    const active = service.run(f.input, randomUUID()), queued = service.run(f.input, randomUUID())
    const rejectedActive = expect(active).rejects.toThrow(), rejectedQueued = expect(queued).rejects.toThrow()
    await ready
    expect(service.hasRunningJobs()).toBe(true)
    await service.shutdown()
    await Promise.all([rejectedActive, rejectedQueued])
    expect(service.hasRunningJobs()).toBe(false)
    expect(extract).toHaveBeenCalledOnce()
    await expect(service.run(f.input, randomUUID())).rejects.toThrow('stopping')
    await expect(readFile(f.cachePath)).rejects.toThrow()
  })

  it('stops waiting on shutdown when model work ignores cancellation', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const service = createService(f.store, f.secrets, () => createTranslator('en'), async () => {
      started()
      return new Promise<never>(() => undefined)
    })
    void service.run(f.input, randomUUID(), 'organize').catch(() => undefined)
    await ready
    const begin = Date.now()
    await service.shutdown(50)
    expect(Date.now() - begin).toBeLessThan(1000)
    await expect(service.run(f.input, randomUUID())).rejects.toThrow('stopping')
  })

  it('cancels model work without publishing results and rejects cross-paper attachments', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const service = createService(f.store, f.secrets, () => createTranslator('en'), async (request) => {
      started()
      return new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
    })
    const operationId = randomUUID()
    const pending = service.run(f.input, operationId, 'organize')
    const rejection = expect(pending).rejects.toThrow()
    await ready
    service.cancel(operationId)
    await rejection
    expect(JSON.parse(await readFile(f.cachePath, 'utf8')).selectedSource).toBe('automatic')
    await expect(service.run({ ...f.input, attachmentId: randomUUID() }, randomUUID())).rejects.toThrow()
    service.cancelPaper(f.input.paperId)
    await f.store.deletePaper(f.input.paperId)
    await expect(service.run(f.input, randomUUID())).rejects.toThrow()
  })
})

describe('PDF outline parsing resources', () => {
  function documentFixture() {
    let fontsLoaded = false
    const page = {
      getViewport: () => ({ height: 700, convertToViewportPoint: (x: number, y: number) => [x, 700 - y] }),
      getTextContent: vi.fn(async () => ({ items: [{ str: '1 Methods', fontName: 'f1', transform: [16, 0, 0, 16, 30, 580], width: 100, hasEOL: true }], styles: { f1: { fontFamily: 'sans-serif' } } })),
      getOperatorList: vi.fn(async () => { fontsLoaded = true }),
      commonObjs: { has: () => fontsLoaded, get: () => ({ name: 'Helvetica-Bold' }) },
      cleanup: vi.fn(() => { fontsLoaded = false })
    }
    return { page, document: { numPages: 2, getPage: vi.fn(async () => page) } }
  }

  it('reuses text and geometry when supplementing fonts, releases every page and yields between pages', async () => {
    const f = documentFixture(), signal = new AbortController().signal
    const document = f.document as unknown as PDFDocumentProxy
    let eventRan = false
    setImmediate(() => { eventRan = true })
    const pages = await pdfOutlinePages(document, signal)
    expect(eventRan).toBe(true)
    expect(f.page.getTextContent).toHaveBeenCalledTimes(2)
    expect(f.page.getOperatorList).not.toHaveBeenCalled()
    expect(f.page.cleanup).toHaveBeenCalledTimes(2)
    const lines = pages[0].lines
    expect(lines[0].bold).toBe(false)
    await enrichOutlineFonts(document, pages, signal)
    expect(pages[0].lines).toBe(lines)
    expect(lines[0].bold).toBe(true)
    expect(f.page.getTextContent).toHaveBeenCalledTimes(2)
    expect(f.page.getOperatorList).toHaveBeenCalledTimes(2)
    expect(f.page.cleanup).toHaveBeenCalledTimes(4)
  })

  it('processes cancellation before the next page and releases a page even if text extraction fails', async () => {
    const f = documentFixture(), controller = new AbortController()
    setImmediate(() => controller.abort())
    await expect(pdfOutlinePages(f.document as unknown as PDFDocumentProxy, controller.signal)).rejects.toThrow()
    expect(f.document.getPage).toHaveBeenCalledTimes(1)
    expect(f.page.cleanup).toHaveBeenCalledOnce()
    f.page.getTextContent.mockRejectedValueOnce(new Error('Broken page'))
    await expect(pdfOutlinePages(f.document as unknown as PDFDocumentProxy, new AbortController().signal)).rejects.toThrow('Broken page')
    expect(f.page.cleanup).toHaveBeenCalledTimes(2)
  })

  it('reads JSON surrounded by prose while retaining ID and level restrictions', () => {
    const candidates = [entry('Methods', 1), entry('Results', 2)]
    expect(organizedOutline(candidates, 'Here are the headings:\n```json\n[{"id":"Results","level":2},{"id":"Methods","level":1},{"id":"invented","level":1}]\n```\nDone.')).toEqual([candidates[0], { ...candidates[1], level: 2 }])
    for (const invalid of ['No JSON', 'The result is [broken].', '{"id":"Methods"}']) expect(() => organizedOutline(candidates, invalid)).toThrow(InvalidOutlineResponseError)
  })

  it('reports a localized organizer error instead of the raw JSON parser error', async () => {
    const f = await fixture()
    await f.store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
    const service = createService(f.store, f.secrets, () => createTranslator('zh-Hans'), async () => ({ text: 'Here is [invalid JSON].', sources: [] }))
    await expect(service.run(f.input, randomUUID(), 'organize')).rejects.toThrow('无法解析 AI 返回的结果，请重新整理目录。')
  })
})
