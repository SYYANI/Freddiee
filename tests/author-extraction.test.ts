import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Attachment, Paper } from '../shared/types'
import {
  AuthorExtractionService,
  buildAuthorExtractionContent,
  extractLocalHTMLAuthorContext,
  inferSourceOrganization,
  parseAuthors
} from '../electron/main/authorExtraction'
import type { SecretStore } from '../electron/main/secrets'
import { builtInProviders, FreddieStore } from '../electron/main/store'

const timestamp = '2026-10-23T00:00:00.000Z'

const paper = (patch: Partial<Paper> = {}): Paper => ({
  id: randomUUID(),
  title: 'Harness engineering',
  abstract: '',
  authors: [],
  categories: [],
  tags: [],
  isFavorite: false,
  createdAt: timestamp,
  modifiedAt: timestamp,
  ...patch
})

async function temporaryStore(): Promise<{ root: string; store: FreddieStore }> {
  const root = await mkdtemp(join(tmpdir(), 'freddie-author-extraction-'))
  const store = new FreddieStore(root)
  await store.initialize()
  return { root, store }
}

describe('author extraction', () => {
  it('parses model and byline output while removing affiliations and noise', () => {
    expect(parseAuthors('Authors:\nBy Ryan Lopopolo, Member of the Technical Staff\nJane Doe & John Smith\nN/A')).toEqual([
      'Ryan Lopopolo', 'Jane Doe', 'John Smith'
    ])
    expect(parseAuthors('Taylor & Francis')).toEqual(['Taylor & Francis'])
  })

  it('extracts explicit author metadata, readability bylines, and visible context', () => {
    const context = extractLocalHTMLAuthorContext(`
      <html><head><meta name="author" content="Ryan Lopopolo"></head><body>
      <p class="rp-readability-byline">By Ryan Lopopolo, Member of the Technical Staff</p>
      <article>Local article text.</article></body></html>
    `)
    expect(context.metaAuthors).toEqual(['Ryan Lopopolo'])
    expect(context.bylines).toEqual(['By Ryan Lopopolo, Member of the Technical Staff'])
    expect(context.textSnippet).toContain('Local article text.')
  })

  it('builds bounded model context and infers source organizations', () => {
    const content = buildAuthorExtractionContent('Title', 'a'.repeat(500), 'https://research.example-lab.ac.uk/paper')
    expect(content).toContain(`Abstract (first 200 chars): ${'a'.repeat(200)}`)
    expect(content).toContain('Source organization inferred from URL: Example Lab')
    expect(inferSourceOrganization('https://openai.com/index/test')).toBe('OpenAI')
    expect(inferSourceOrganization('not a url')).toBeUndefined()
  })

  it('uses local HTML evidence without requiring a configured model', async () => {
    const { root, store } = await temporaryStore()
    try {
      const imported = paper({ htmlUrl: 'https://openai.com/index/test' })
      const directory = await store.ensurePaperDirectory(imported.id)
      await writeFile(join(directory, 'paper.html'), '<p class="rp-readability-byline">By Ryan Lopopolo, Member of the Technical Staff</p>')
      const attachment: Attachment = {
        id: randomUUID(), paperId: imported.id, kind: 'html', source: 'webPage', filename: 'paper.html', createdAt: timestamp
      }
      await store.addPaper(imported, [attachment])
      const service = new AuthorExtractionService(store, {} as SecretStore, () => ((key: string) => key))

      await expect(service.extractAndAssign(imported.id)).resolves.toBe(true)
      expect(store.paper(imported.id).authors).toEqual(['Ryan Lopopolo'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the HTML route for model extraction and does not overwrite existing authors', async () => {
    const { root, store } = await temporaryStore()
    try {
      const imported = paper({ abstract: 'An abstract.' })
      await store.addPaper(imported, [])
      await store.saveSettings({ htmlModelId: builtInProviders[0].model.id })
      const completion = vi.fn(async () => ({ text: 'Ada Lovelace\nAlan Turing', sources: [] }))
      const secrets = { key: vi.fn(async () => 'secret') } as unknown as SecretStore
      const service = new AuthorExtractionService(store, secrets, () => ((key: string) => key), completion)

      await expect(service.extractAndAssign(imported.id)).resolves.toBe(true)
      expect(store.paper(imported.id).authors).toEqual(['Ada Lovelace', 'Alan Turing'])
      expect(completion).toHaveBeenCalledOnce()

      await store.updatePaper(imported.id, { authors: ['Manual Author'] })
      await expect(service.extractAuthorsIfNeeded(store.paper(imported.id))).resolves.toBe(false)
      expect(store.paper(imported.id).authors).toEqual(['Manual Author'])
      expect(completion).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to the source organization when no model route is configured', async () => {
    const { root, store } = await temporaryStore()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const imported = paper({ pdfUrl: 'https://openai.com/research/paper.pdf' })
      await store.addPaper(imported, [])
      const service = new AuthorExtractionService(store, {} as SecretStore, () => ((key: string) => key))

      await expect(service.extractAndAssign(imported.id)).resolves.toBe(true)
      expect(store.paper(imported.id).authors).toEqual(['OpenAI'])
    } finally {
      warning.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
