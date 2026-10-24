import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractFrontend, NativePDFBackend } from '../BabelDocKit'
import type { BabelDocWorkerData, BabelDocWorkerEvent } from '../electron/main/babeldocWorkerProtocol'
import * as files from '../electron/main/files'
import type { SecretStore } from '../electron/main/secrets'
import { builtInProviders, FreddieStore } from '../electron/main/store'
import { TranslationService } from '../electron/main/translation'
import { createTranslator } from '../shared/i18n'
import type { TranslationEvent } from '../shared/types'

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: vi.fn(function () {
      return Object.assign(new EventEmitter(), {
        terminate: vi.fn(async () => 0),
        postMessage: vi.fn()
      })
    })
  }
})

vi.mock('../BabelDocKit', async (importOriginal) => ({
  ...await importOriginal<typeof import('../BabelDocKit')>(),
  verifyBabelDocRuntime: vi.fn()
}))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function startTranslation(pageRange = '', pdf: Uint8Array = new TextEncoder().encode('%PDF-test source')) {
  const root = await mkdtemp(join(tmpdir(), 'freddie-babeldoc-service-'))
  roots.push(root)
  const store = new FreddieStore(root)
  await store.initialize()
  await store.saveSettings({ pdfModelId: builtInProviders[0].model.id })
  const paperId = randomUUID()
  const timestamp = new Date().toISOString()
  const directory = await store.ensurePaperDirectory(paperId)
  await writeFile(join(directory, 'paper.pdf'), pdf)
  await store.addPaper({
    id: paperId, title: 'Test paper', abstract: '', authors: [], categories: [], tags: [],
    isFavorite: false, createdAt: timestamp, modifiedAt: timestamp
  }, [{
    id: randomUUID(), paperId, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: timestamp
  }])
  const events: TranslationEvent[] = []
  const secrets = { key: async () => 'test-key' } as unknown as SecretStore
  const service = new TranslationService(store, secrets, (event) => events.push(event), () => createTranslator('en'))
  const job = service.translateBabeldocPDF(paperId, pageRange)
  await vi.waitFor(() => expect(Worker).toHaveBeenCalledOnce())
  const worker = vi.mocked(Worker).mock.results[0].value as Worker
  const data = vi.mocked(Worker).mock.calls[0][1]!.workerData as BabelDocWorkerData
  return { store, paperId, events, service, job, worker, data }
}

const result: BabelDocWorkerEvent = {
  type: 'result', pdf: new Uint8Array([37, 80, 68, 70]),
  diagnostics: {
    semanticHintStatus: 'notProvided',
    translationReport: {
      candidateCount: 1, translatedCount: 1, failedCount: 0,
      providerFailureCount: 0, placeholderValidationFailureCount: 0,
      semanticFallbackCount: 0, continuationGroupCount: 0, failedParagraphAddresses: []
    }
  }
}

describe('BabelDOC translation service', () => {
  it.each(['2-3', '2,4'])('keeps all physical pages for the bilingual reader when selecting %s', async (pageRange) => {
    const source = await PDFDocument.create()
    const font = await source.embedFont(StandardFonts.Helvetica)
    for (let page = 1; page <= 4; page += 1) {
      source.addPage([612, 792]).drawText(`source page ${page}`, { x: 50, y: 700, size: 12, font })
    }
    const { store, paperId, events, service, job, worker, data } = await startTranslation(pageRange, await source.save())
    expect(data.pages).toEqual(pageRange === '2-3' ? [2, 3] : [2, 4])
    const { document } = await extractFrontend(data.pdf, data.pages!)
    // Change the selected pages using their original Helvetica font and the real backend.
    for (const page of document.page ?? []) {
      for (const character of page.pdf_character ?? []) {
        const uppercase = character.char_unicode?.toUpperCase()
        if (uppercase) {
          character.char_unicode = uppercase
          character.pdf_character_id = uppercase.codePointAt(0)
        }
      }
    }
    const translated = await NativePDFBackend.write(data.pdf, document, {
      renderingMode: data.configuration.renderingMode,
      onlyIncludeTranslatedPages: data.configuration.onlyIncludeTranslatedPages,
      targetFontDirectory: data.configuration.targetFontDirectory,
      skipForms: false, skipCurves: false, maximumUnmatchedGlyphFraction: 0.01
    })
    worker.emit('message', { ...result, pdf: translated.pdf })
    await job
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: 'finished' })
    expect(service.isRunning(paperId)).toBe(false)
    const attachment = store.attachments(paperId).find((item) => item.source === 'babeldoc')!
    const saved = new Uint8Array(await readFile(store.attachmentPath(paperId, attachment.id)))
    const output = await extractFrontend(saved)
    expect(output.document.page?.map((page) => (page.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')))
      .toEqual([1, 2, 3, 4].map((page) => data.pages!.includes(page) ? `SOURCE PAGE ${page}` : `source page ${page}`))
  })

  it('handles checkpoint failures before a worker result and still saves the translation', async () => {
    const { store, paperId, events, service, job, worker } = await startTranslation()
    const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
    vi.spyOn(files, 'atomicWriteFile').mockRejectedValueOnce(failure)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    worker.emit('message', { type: 'structured_document', document: { page: [] } } satisfies BabelDocWorkerEvent)

    // Leave the worker running past the failed write: no result has arrived to catch it.
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.stringContaining('checkpoint'), failure))
    expect(service.isRunning(paperId)).toBe(true)
    expect(events.some((event) => event.type === 'failed')).toBe(false)

    worker.emit('message', result)
    await job
    expect(events.at(-1)?.type).toBe('finished')
    const attachment = store.attachments(paperId).find((item) => item.source === 'babeldoc')!
    expect(new Uint8Array(await readFile(store.attachmentPath(paperId, attachment.id)))).toEqual(result.pdf)
  })
})
