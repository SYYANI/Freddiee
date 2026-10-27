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

  it('coalesces concurrent requests for the same paper', async () => {
    const f = await fixture()
    const results = await Promise.all([f.service.content(f.paper.id), f.service.content(f.paper.id)])
    expect(results[0]).toEqual(results[1])
    expect(f.completion).toHaveBeenCalledOnce()
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
    const rejection = expect(result).rejects.toThrow()
    await pending
    await f.service.cancelPaper(f.paper.id)
    await f.store.deletePaper(f.paper.id)
    await rejection
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
