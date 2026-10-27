import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Paper } from '../shared/types'
import { PaperSummaryService } from '../electron/main/paperSummary'
import type { CompletionRequest } from '../electron/main/llm'
import type { SecretStore } from '../electron/main/secrets'
import { builtInProviders, FreddieStore } from '../electron/main/store'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(options: { kind?: 'pdf' | 'html'; abstract?: string; configured?: boolean; source?: Attachment['source'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'freddie-summary-'))
  roots.push(root)
  const store = new FreddieStore(root)
  await store.initialize()
  const timestamp = new Date().toISOString()
  const paper: Paper = { id: randomUUID(), title: 'Research paper', abstract: options.abstract ?? 'The original official abstract.', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp }
  const attachment: Attachment = { id: randomUUID(), paperId: paper.id, kind: options.kind ?? 'pdf', source: options.source ?? 'arxivPDF', filename: options.kind === 'html' ? 'paper.html' : 'paper.pdf', createdAt: timestamp }
  const directory = await store.ensurePaperDirectory(paper.id)
  await store.addPaper(paper, [attachment])
  if (options.configured !== false) await store.saveSettings({ htmlModelId: builtInProviders[0].model.id, targetLanguage: 'zh-CN' })
  const configured = new Set(options.configured === false ? [] : [builtInProviders[0].id])
  const key = vi.fn(async () => 'secret')
  const secrets = { key, configuredProviderIds: vi.fn(async () => configured) } as unknown as SecretStore
  const completion = vi.fn(async (_request: CompletionRequest) => ({ text: '论文探讨研究问题、方法及主要发现。', sources: [] }))
  const service = new PaperSummaryService(store, secrets, completion)
  const cachePath = join(directory, 'translations', 'pdf-summary.json')
  return { store, paper, attachment, directory, configured, key, secrets, completion, service, cachePath }
}

describe('PDF inspector summaries', () => {
  it('hides an official arXiv abstract without a configured model or saved key', async () => {
    const f = await fixture({ configured: false })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    await f.store.saveSettings({ htmlModelId: builtInProviders[0].model.id })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    expect(f.key).not.toHaveBeenCalled()
    expect(f.completion).not.toHaveBeenCalled()
    expect(f.store.paper(f.paper.id).abstract).toBe(f.paper.abstract)
    await expect(access(f.cachePath)).rejects.toThrow()
  })

  it('generates at most 140 characters in the target language and caches without reading the key again', async () => {
    const f = await fixture()
    f.completion.mockResolvedValue({ text: ` \n${'摘'.repeat(180)}\n `, sources: [] })
    const first = await f.service.content(f.paper.id)
    expect(first).toEqual({ kind: 'summary', text: `${'摘'.repeat(139)}…` })
    // A new service instance must reuse the persisted cache too.
    await expect(new PaperSummaryService(f.store, f.secrets, f.completion).content(f.paper.id)).resolves.toEqual(first)
    expect(f.completion).toHaveBeenCalledOnce()
    expect(f.key).toHaveBeenCalledOnce()
    expect(f.completion.mock.calls[0][0].messages[0].content).toContain('简体中文')
    expect(f.completion.mock.calls[0][0].messages[0].content).toContain('not 140 words')
    expect(f.completion.mock.calls[0][0].messages[1].content).toContain(f.paper.abstract)
    expect(f.store.paper(f.paper.id).abstract).toBe('The original official abstract.')
    expect(await readFile(f.cachePath, 'utf8')).not.toContain('secret')
  })

  it('counts grapheme characters and normalizes whitespace', async () => {
    const f = await fixture()
    f.completion.mockResolvedValue({ text: '👩‍🔬'.repeat(141), sources: [] })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'summary', text: `${'👩‍🔬'.repeat(139)}…` })
    await f.store.updatePaper(f.paper.id, { title: 'Changed title' })
    f.completion.mockResolvedValue({ text: '  Concise\n summary.  ', sources: [] })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'summary', text: 'Concise summary.' })
  })

  it('invalidates the cache for model parameters, language, provider, model, and source', async () => {
    const f = await fixture()
    await f.service.content(f.paper.id)
    const model = f.store.database.models.find((item) => item.id === builtInProviders[0].model.id)!
    model.temperature = 0.8
    await f.service.content(f.paper.id)
    await f.store.saveSettings({ targetLanguage: 'EN' })
    await f.service.content(f.paper.id)
    expect(f.completion.mock.calls[2][0].messages[0].content).toContain('English')
    const secondModel = { ...model, id: randomUUID() }
    f.store.database.models.push(secondModel)
    await f.store.saveSettings({ htmlModelId: secondModel.id })
    await f.service.content(f.paper.id)
    const provider = { ...f.store.database.providers[0], id: randomUUID() }
    f.store.database.providers.push(provider)
    f.configured.add(provider.id)
    secondModel.providerId = provider.id
    await f.service.content(f.paper.id)
    await f.store.updatePaper(f.paper.id, { abstract: 'Revised source.' })
    await f.service.content(f.paper.id)
    expect(f.completion).toHaveBeenCalledTimes(6)
  })

  it('hides cached summaries after configuration is removed or disabled', async () => {
    const f = await fixture()
    await f.service.content(f.paper.id)
    f.configured.clear()
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    f.configured.add(builtInProviders[0].id)
    f.store.database.models.find((model) => model.id === builtInProviders[0].model.id)!.isEnabled = false
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    expect(f.completion).toHaveBeenCalledOnce()
  })

  it('falls back to the PDF model when the HTML route is unavailable', async () => {
    const f = await fixture()
    await f.store.saveSettings({ htmlModelId: randomUUID(), pdfModelId: builtInProviders[0].model.id })
    await expect(f.service.content(f.paper.id)).resolves.toMatchObject({ kind: 'summary' })
    expect(f.completion).toHaveBeenCalledOnce()
  })

  it.each(['localImport', 'webPage'] as const)('summarizes only the first three pages of a %s PDF', async (source) => {
    const f = await fixture({ abstract: '', source })
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (const text of ['Research question.', 'Method description.', 'Main finding.', 'FOURTH_PAGE_SENTINEL']) {
      document.addPage().drawText(text, { font, x: 20, y: 500 })
    }
    await writeFile(join(f.directory, 'paper.pdf'), await document.save())
    await expect(f.service.content(f.paper.id)).resolves.toMatchObject({ kind: 'summary' })
    const input = f.completion.mock.calls[0][0].messages[1].content
    expect(input).toContain('Research question.')
    expect(input).toContain('Main finding.')
    expect(input).not.toContain('FOURTH_PAGE_SENTINEL')
    expect(f.store.paper(f.paper.id).abstract).toBe('')
  })

  it('does not invent a summary for a missing or textless PDF', async () => {
    const f = await fixture({ abstract: '' })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    const document = await PDFDocument.create()
    document.addPage()
    await writeFile(join(f.directory, 'paper.pdf'), await document.save())
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    expect(f.completion).not.toHaveBeenCalled()
  })

  it('leaves HTML-only abstracts available without a model', async () => {
    const f = await fixture({ kind: 'html', configured: false })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'original', text: f.paper.abstract })
    expect(f.completion).not.toHaveBeenCalled()
  })

  it('does not cache failed or empty responses', async () => {
    const f = await fixture()
    f.completion.mockRejectedValueOnce(new Error('Timeout'))
    await expect(f.service.content(f.paper.id)).rejects.toThrow('Timeout')
    f.completion.mockResolvedValue({ text: ' \n ', sources: [] })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    await expect(access(f.cachePath)).rejects.toThrow()
    expect(f.store.paper(f.paper.id).abstract).toBe(f.paper.abstract)
  })

  it('preserves provider abort errors when the summary operation was not cancelled', async () => {
    const f = await fixture()
    const error = new DOMException('Provider request aborted', 'AbortError')
    f.completion.mockRejectedValueOnce(error)
    await expect(f.service.content(f.paper.id)).rejects.toBe(error)
    await expect(access(f.cachePath)).rejects.toThrow()
  })

  it('coalesces concurrent requests for the same paper', async () => {
    const f = await fixture()
    const results = await Promise.all([f.service.content(f.paper.id), f.service.content(f.paper.id)])
    expect(results[0]).toEqual(results[1])
    expect(f.completion).toHaveBeenCalledOnce()
  })

  it('reuses earlier language and model summaries after switching back, including after restart', async () => {
    const f = await fixture()
    const original = await f.service.content(f.paper.id)
    await f.store.saveSettings({ targetLanguage: 'EN' })
    await f.service.content(f.paper.id)
    const model = f.store.database.models.find((item) => item.id === builtInProviders[0].model.id)!
    const second = { ...model, id: randomUUID(), modelName: 'another-model' }
    f.store.database.models.push(second)
    await f.store.saveSettings({ htmlModelId: second.id })
    await f.service.content(f.paper.id)
    await f.store.saveSettings({ targetLanguage: 'zh-CN', htmlModelId: model.id })
    const restarted = new PaperSummaryService(f.store, f.secrets, f.completion)
    await expect(restarted.content(f.paper.id)).resolves.toEqual(original)
    await f.store.saveSettings({ targetLanguage: 'EN' })
    await restarted.content(f.paper.id)
    expect(f.completion).toHaveBeenCalledTimes(3)
    expect(f.key).toHaveBeenCalledTimes(3)
    const cache = JSON.parse(await readFile(f.cachePath, 'utf8'))
    expect(cache.version).toBe(2)
    expect(cache.entries).toHaveLength(3)
  })

  it('reads a legacy single-entry cache and preserves it when adding a second identity', async () => {
    const f = await fixture()
    const original = await f.service.content(f.paper.id)
    const { entries } = JSON.parse(await readFile(f.cachePath, 'utf8'))
    await writeFile(f.cachePath, JSON.stringify({ version: 1, ...entries[0] }))
    await expect(f.service.content(f.paper.id)).resolves.toEqual(original)
    expect(f.completion).toHaveBeenCalledOnce()
    await f.store.saveSettings({ targetLanguage: 'EN' })
    await f.service.content(f.paper.id)
    expect(JSON.parse(await readFile(f.cachePath, 'utf8')).entries).toHaveLength(2)
    await f.store.saveSettings({ targetLanguage: 'zh-CN' })
    await expect(f.service.content(f.paper.id)).resolves.toEqual(original)
    expect(f.completion).toHaveBeenCalledTimes(2)
  })

  it('preserves both identities when their cache writes finish together', async () => {
    const f = await fixture()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const release = deferred<void>()
    f.completion.mockImplementation(async () => {
      if (f.completion.mock.calls.length === 1) firstStarted.resolve()
      else secondStarted.resolve()
      await release.promise
      return { text: 'Summary.', sources: [] }
    })
    const first = f.service.content(f.paper.id)
    await firstStarted.promise
    await f.store.saveSettings({ targetLanguage: 'EN' })
    const second = f.service.content(f.paper.id)
    await secondStarted.promise
    release.resolve()
    await Promise.all([first, second])
    expect(JSON.parse(await readFile(f.cachePath, 'utf8')).entries).toHaveLength(2)
    await f.service.content(f.paper.id)
    await f.store.saveSettings({ targetLanguage: 'zh-CN' })
    await f.service.content(f.paper.id)
    expect(f.completion).toHaveBeenCalledTimes(2)
  })

  it('cancels the old request on a settings change without cancelling its replacement', async () => {
    const f = await fixture()
    const started = deferred<CompletionRequest>()
    f.completion.mockImplementationOnce(async (request) => {
      started.resolve(request)
      await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
      return { text: 'Old summary.', sources: [] }
    })
    const operationId = randomUUID()
    const old = f.service.content(f.paper.id, operationId)
    const cancelled = expect(old).resolves.toEqual({ kind: 'hidden' })
    const oldRequest = await started.promise
    await f.store.saveSettings({ targetLanguage: 'EN' })
    f.service.cancel(operationId)
    const replacement = f.service.content(f.paper.id, randomUUID())
    // Repeated cleanup from an old effect must never cancel its replacement.
    f.service.cancel(operationId)
    await cancelled
    expect(oldRequest.signal!.aborted).toBe(true)
    await expect(replacement).resolves.toMatchObject({ kind: 'summary' })
    const cache = JSON.parse(await readFile(f.cachePath, 'utf8'))
    expect(cache.entries).toHaveLength(1)
    expect(cache.entries[0].identity).toContain('"language":"EN"')
  })

  it('cancels before route lookup completes without starting a model request', async () => {
    const f = await fixture()
    const configured = deferred<Set<string>>()
    vi.mocked(f.secrets.configuredProviderIds).mockReturnValueOnce(configured.promise)
    const id = randomUUID()
    const result = f.service.content(f.paper.id, id)
    const cancelled = expect(result).resolves.toEqual({ kind: 'hidden' })
    f.service.cancel(id)
    configured.resolve(f.configured)
    await cancelled
    expect(f.completion).not.toHaveBeenCalled()
    await expect(access(f.cachePath)).rejects.toThrow()
  })

  it('keeps a shared generation alive until its last consumer cancels', async () => {
    const f = await fixture()
    const started = deferred<CompletionRequest>()
    const release = deferred<void>()
    f.completion.mockImplementation(async (request) => {
      started.resolve(request)
      await release.promise
      return { text: 'Shared summary.', sources: [] }
    })
    const firstId = randomUUID()
    const first = f.service.content(f.paper.id, firstId)
    const cancelled = expect(first).resolves.toEqual({ kind: 'hidden' })
    const request = await started.promise
    const second = f.service.content(f.paper.id, randomUUID())
    // Allow the second operation to finish its asynchronous route lookup.
    await Promise.resolve()
    await Promise.resolve()
    f.service.cancel(firstId)
    expect(request.signal!.aborted).toBe(false)
    release.resolve()
    await cancelled
    await expect(second).resolves.toEqual({ kind: 'summary', text: 'Shared summary.' })
    expect(f.completion).toHaveBeenCalledOnce()
  })

  it('discards late cancelled responses without disturbing a replacement for the same summary', async () => {
    const f = await fixture()
    const started = deferred<CompletionRequest>()
    const release = deferred<void>()
    f.completion.mockImplementationOnce(async (request) => {
      started.resolve(request)
      // A provider may still return a response after cancellation.
      await release.promise
      return { text: 'Stale summary.', sources: [] }
    })
    const operationId = randomUUID()
    const old = f.service.content(f.paper.id, operationId)
    const cancelled = expect(old).resolves.toEqual({ kind: 'hidden' })
    const oldRequest = await started.promise
    f.service.cancel(operationId)
    expect(oldRequest.signal!.aborted).toBe(true)
    await expect(f.service.content(f.paper.id)).resolves.toMatchObject({ kind: 'summary' })
    release.resolve()
    await cancelled
    const cache = JSON.parse(await readFile(f.cachePath, 'utf8'))
    expect(cache.entries).toHaveLength(1)
    expect(cache.entries[0].text).toBe('论文探讨研究问题、方法及主要发现。')
    expect(f.completion).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending summary before deletion without recreating its cache', async () => {
    const f = await fixture()
    let started!: () => void
    const pending = new Promise<void>((resolve) => { started = resolve })
    f.completion.mockImplementation(async (request) => {
      started()
      await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
      return { text: 'Late summary.', sources: [] }
    })
    const result = f.service.content(f.paper.id)
    const cancelled = expect(result).resolves.toEqual({ kind: 'hidden' })
    await pending
    await f.service.cancelPaper(f.paper.id)
    await f.store.deletePaper(f.paper.id)
    await cancelled
    await expect(access(f.directory)).rejects.toThrow()
  })

  it('discards responses arriving after a paper has already been deleted', async () => {
    const f = await fixture()
    f.completion.mockImplementation(async () => {
      await f.store.deletePaper(f.paper.id)
      return { text: 'Late summary.', sources: [] }
    })
    await expect(f.service.content(f.paper.id)).resolves.toEqual({ kind: 'hidden' })
    await expect(access(f.cachePath)).rejects.toThrow()
  })
})
