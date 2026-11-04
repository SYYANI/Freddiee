import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as files from '../electron/main/files'
import { builtInProviders, FreddieStore, migrateDatabase, schemaVersion } from '../electron/main/store'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freddie-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const timestamp = '2026-01-01T00:00:00.000Z'

describe('FreddieStore', () => {
  it('does not rewrite identical settings or normalized reading positions', async () => {
    const store = new FreddieStore(await temporaryRoot())
    await store.initialize()
    const paperId = '11111111-1111-4111-8111-111111111111'
    await store.addPaper({ id: paperId, title: 'A', abstract: '', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp }, [])
    const position = { paperId, readerMode: 'html' as const, pageIndex: 0, scrollRatio: 0.5001, zoomScale: 1 }
    await store.saveReadingState(position)
    const generation = store.generation
    const notify = vi.fn()
    store.onChange(notify)
    const write = vi.spyOn(files, 'atomicWriteFile')
    await store.saveReadingState({ ...position, scrollRatio: 0.5002 })
    await store.saveSettings({ htmlFontSize: store.database.settings.htmlFontSize, collapsedFolderIds: [...store.database.settings.collapsedFolderIds] })
    expect(store.generation).toBe(generation)
    expect(notify).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('coalesces queued saves and waits for changes made during an active write', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    const atomicWrite = files.atomicWriteFile
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { started = resolve })
    const write = vi.spyOn(files, 'atomicWriteFile').mockImplementationOnce(async (...args) => {
      started()
      await gate
      await atomicWrite(...args)
    })
    const first = store.saveSettings({ htmlFontSize: 20 })
    await writing
    let finished = false
    const second = store.saveSettings({ htmlFontSize: 21 }).then(() => { finished = true })
    const third = store.saveSettings({ inspectorCollapsed: true })
    let identicalFinished = false
    const identical = store.saveSettings({ htmlFontSize: 21 }).then(() => { identicalFinished = true })
    expect(finished).toBe(false)
    await Promise.resolve()
    expect(identicalFinished).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second, third, identical])
    expect(write).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))
    expect(saved.settings).toMatchObject({ htmlFontSize: 21, inspectorCollapsed: true })
    expect(finished).toBe(true)
    expect(identicalFinished).toBe(true)
  })

  it('does not write a batch begun while a save was queued until the batch ends', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    const atomicWrite = files.atomicWriteFile
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(files, 'atomicWriteFile').mockImplementationOnce(async (...args) => {
      started()
      await gate
      await atomicWrite(...args)
    })
    const first = store.saveSettings({ htmlFontSize: 20 })
    await writing
    const queued = store.saveSettings({ htmlFontSize: 21 })
    let finishBatch!: () => void
    const batchGate = new Promise<void>((resolve) => { finishBatch = resolve })
    const batch = store.batch(async () => {
      await store.saveSettings({ inspectorCollapsed: true })
      await batchGate
    })
    release()
    await Promise.all([first, queued])
    const during = JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))
    expect(during.settings.inspectorCollapsed).not.toBe(true)
    finishBatch()
    await batch
    const saved = JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))
    expect(saved.settings).toMatchObject({ htmlFontSize: 21, inspectorCollapsed: true })
  })

  it('retries an identical save after a failed atomic replacement', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    vi.spyOn(files, 'atomicWriteFile').mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(store.saveSettings({ htmlFontSize: 23 })).rejects.toThrow('Disk unavailable')
    await store.saveSettings({ htmlFontSize: 23 })
    expect(JSON.parse(await readFile(join(root, 'library.json'), 'utf8')).settings.htmlFontSize).toBe(23)
  })

  it('seeds the built-in providers and writes library.json atomically', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    expect(store.database.providers.map((provider) => provider.id)).toEqual(builtInProviders.map((provider) => provider.id))
    expect(store.database.models).toHaveLength(builtInProviders.length)
    const saved = JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))
    expect(saved.schemaVersion).toBe(schemaVersion)
  })

  it('keeps deleted built-in profiles deleted after relaunch', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    await store.deleteProvider(builtInProviders[0].id)
    const reopened = new FreddieStore(root)
    await reopened.initialize()
    expect(reopened.database.providers.some((provider) => provider.id === builtInProviders[0].id)).toBe(false)
    expect(reopened.database.models.some((model) => model.id === builtInProviders[0].model.id)).toBe(false)
  })

  it('moves papers of a deleted folder to Unfiled', async () => {
    const root = await temporaryRoot()
    const store = new FreddieStore(root)
    await store.initialize()
    const paperId = '11111111-1111-4111-8111-111111111111'
    await store.addPaper({ id: paperId, title: 'A', abstract: '', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp }, [])
    const folder = await store.createFolder('Reading', 'New Folder', paperId)
    expect(store.database.memberships).toEqual([expect.objectContaining({ paperId, folderId: folder.id })])
    await store.removeFolder(folder.id)
    expect(store.database.memberships).toEqual([])
    expect(store.database.papers).toHaveLength(1)
  })

  it('names unnamed folders uniquely', async () => {
    const store = new FreddieStore(await temporaryRoot())
    await store.initialize()
    expect((await store.createFolder('  ', 'New Folder')).name).toBe('New Folder')
    expect((await store.createFolder('', 'New Folder')).name).toBe('New Folder 2')
  })

  it('does not reorder the library when favoriting', async () => {
    const store = new FreddieStore(await temporaryRoot())
    await store.initialize()
    const paperId = '22222222-2222-4222-8222-222222222222'
    await store.addPaper({ id: paperId, title: 'A', abstract: '', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp }, [])
    await store.updatePaper(paperId, { isFavorite: true }, false)
    expect(store.paper(paperId).modifiedAt).toBe(timestamp)
    await store.updatePaper(paperId, { title: 'B' })
    expect(store.paper(paperId).modifiedAt).not.toBe(timestamp)
  })

  it('refuses paths that escape a paper directory', async () => {
    const store = new FreddieStore(await temporaryRoot())
    await store.initialize()
    const paperId = '33333333-3333-4333-8333-333333333333'
    expect(() => store.resolvePaperPath(paperId, '../secrets.json')).toThrow()
    expect(() => store.resolvePaperPath(paperId, '/etc/passwd')).toThrow()
    expect(store.resolvePaperPath(paperId, 'assets/a.png')).toContain(join('Library', paperId, 'assets'))
    expect(() => store.paperDirectory('../x')).toThrow()
  })

  it('clears translation routes that point at a deleted model', async () => {
    const store = new FreddieStore(await temporaryRoot())
    await store.initialize()
    const modelId = builtInProviders[1].model.id
    await store.saveSettings({ htmlModelId: modelId, pdfModelId: modelId })
    await store.deleteModel(modelId)
    expect(store.database.settings.htmlModelId).toBeUndefined()
    expect(store.database.settings.pdfModelId).toBeUndefined()
  })
})

describe('migrateDatabase', () => {
  it('adds the disabled arXiv LaTeX route when migrating schema 6', () => {
    const { database } = migrateDatabase({ schemaVersion: 6, settings: { htmlFontSize: 19, latexTranslationEnabled: true } })
    expect(database.schemaVersion).toBe(schemaVersion)
    expect(database.settings.htmlFontSize).toBe(19)
    expect(database.settings.latexTranslationEnabled).toBe(false)
  })

  it('adds BabelDOC settings when migrating schema 5', () => {
    const { database } = migrateDatabase({ schemaVersion: 5, settings: { htmlFontSize: 19, latexTranslationEnabled: true } })
    expect(database.schemaVersion).toBe(schemaVersion)
    expect(database.settings).toMatchObject({
      htmlFontSize: 19,
      babelDocPageRange: '',
      babelDocRenderingMode: 'source-preserving',
      babelDocQPS: 3,
      babelDocThinkingMode: 'disabled',
      babelDocSemanticHintsEnabled: true,
      latexTranslationEnabled: false
    })
  })

  it('keeps the PDF hand tool disabled when migrating schema 4', () => {
    const { database } = migrateDatabase({ schemaVersion: 4, settings: { showPDFZoomControls: true, pdfHandToolEnabled: true } })
    expect(database.schemaVersion).toBe(schemaVersion)
    expect(database.settings.showPDFZoomControls).toBe(true)
    expect(database.settings.pdfHandToolEnabled).toBe(false)
  })

  it('adds disabled PDF zoom controls when migrating schema 3', () => {
    const { database } = migrateDatabase({ schemaVersion: 3, settings: { showPDFZoomControls: true } })
    expect(database.schemaVersion).toBe(schemaVersion)
    expect(database.settings.showPDFZoomControls).toBe(false)
  })

  it('converts schema 2 file names, folders, and the single provider', () => {
    const paperId = '44444444-4444-4444-8444-444444444444'
    const folderId = '55555555-5555-4555-8555-555555555555'
    const result = migrateDatabase({
      schemaVersion: 2,
      papers: [{
        id: paperId, title: 'Paper', authors: ['Ada'], createdAt: timestamp, modifiedAt: timestamp, kind: 'html', source: 'arxiv',
        sourceUrl: 'https://arxiv.org/abs/2303.08774', arxivId: '2303.08774', fileName: 'paper.html', pdfFileName: 'paper.pdf', htmlFileName: 'paper.html',
        translatedFileName: 'translated.pdf', folderId, favorite: true, tags: []
      }],
      folders: [{ id: folderId, name: 'Inbox', createdAt: timestamp }],
      notes: [{ id: '66666666-6666-4666-8666-666666666666', paperId, body: 'Note', page: 3, createdAt: timestamp, modifiedAt: timestamp }],
      writings: [{ id: '77777777-7777-4777-8777-777777777777', title: 'Draft', body: '# Draft', paperIds: [], createdAt: timestamp, modifiedAt: timestamp }],
      readingStates: [{ paperId, page: 4, scrollRatio: 0.5, zoom: 1, mode: 'split', contentMode: 'pdf', modifiedAt: timestamp }],
      settings: { language: 'zh-Hans', theme: 'paper', provider: { baseUrl: 'https://example.com/v1', model: 'm', apiKeyConfigured: true, temperature: 0.2 }, translation: { targetLanguage: 'Simplified Chinese', babeldocCommand: 'babeldoc', babeldocArgs: [] } },
      selectedPaperId: paperId
    })
    const database = result.database
    expect(database.schemaVersion).toBe(schemaVersion)
    expect(database.papers[0]).toMatchObject({ id: paperId, isFavorite: true, arxivId: '2303.08774' })
    expect(database.attachments.map((item) => [item.kind, item.source, item.filename])).toEqual([
      ['pdf', 'arxivPDF', 'paper.pdf'],
      ['html', 'arxivHTML', 'paper.html'],
      ['translatedPDF', 'babeldoc', 'translated.pdf']
    ])
    expect(database.memberships).toEqual([expect.objectContaining({ paperId, folderId })])
    expect(database.notes[0].pageIndex).toBe(2)
    expect(database.readingStates[0]).toMatchObject({ readerMode: 'bilingualPDF', pageIndex: 3 })
    expect(database.settings).toMatchObject({ appLanguage: 'zh-Hans', readerAppearance: 'paper', lastOpenedPaperId: paperId })
    expect(database.providers[0].baseURL).toBe('https://example.com/v1')
    expect(database.settings.htmlModelId).toBe(database.models[0].id)
    expect(result.legacyApiKeyProviderId).toBe(database.providers[0].id)
    expect(result.legacyWritings[0]).toMatchObject({ markdown: '# Draft' })
  })

  it('drops obsolete translation controls and keeps the current LaTeX opt-in', () => {
    const { database } = migrateDatabase({ schemaVersion, settings: { babelDocQPS: 8, babelDocCommand: 'babeldoc', babelDocArguments: ['--openai'], useArxivLatexStructure: true, latexTranslationEnabled: true, htmlFontSize: 19 } })
    expect(database.settings.babelDocQPS).toBe(8)
    expect(database.settings).not.toHaveProperty('babelDocCommand')
    expect(database.settings).not.toHaveProperty('babelDocArguments')
    expect(database.settings).not.toHaveProperty('useArxivLatexStructure')
    expect(database.settings.latexTranslationEnabled).toBe(true)
    expect(database.settings.htmlFontSize).toBe(19)
  })

  it('refuses a newer schema', () => {
    expect(() => migrateDatabase({ schemaVersion: schemaVersion + 1 })).toThrow()
  })

  it('migrates a schema 2 file on disk and moves its writings to Markdown files', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'library.json'), JSON.stringify({
      schemaVersion: 2, papers: [], folders: [], notes: [], readingStates: [], settings: {},
      writings: [{ id: '88888888-8888-4888-8888-888888888888', title: 'T', body: '# Hello\n\nWorld', paperIds: [], createdAt: timestamp, modifiedAt: timestamp }]
    }))
    const store = new FreddieStore(root)
    await store.initialize()
    expect(await readFile(join(root, 'Writings', '88888888-8888-4888-8888-888888888888', 'writing.md'), 'utf8')).toBe('# Hello\n\nWorld')
  })
})
