import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranslator } from '../shared/i18n'
import { InvalidClipError, parseBrowserClip, parseClipDate } from '../electron/main/browserClip'
import { clipperAPIVersion, clipperRejection, handleClipperRequest, paperOpenURL, readpaperLink, startClipperServer, type ClipperContext, type ClipperRequest } from '../electron/main/clipperServer'
import { PaperImporter } from '../electron/main/importer'
import { FreddieStore } from '../electron/main/store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeImporter(): Promise<{ store: FreddieStore; importer: PaperImporter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'freddie-clipper-'))
  roots.push(root)
  const store = new FreddieStore(root)
  await store.initialize()
  return { store, importer: new PaperImporter(store, () => {}, () => createTranslator('en')), root }
}

async function makePDF(): Promise<string> {
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200]).drawText('Engines', { x: 20, y: 100 })
  return Buffer.from(await pdf.save()).toString('base64')
}

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): ClipperRequest => ({
  method,
  path,
  headers: { host: '127.0.0.1:23240', 'x-freddie-clipper': '1', origin: 'chrome-extension://test', ...headers },
  body: Buffer.from(body === undefined ? '' : JSON.stringify(body))
})

const savedHTML = async (store: FreddieStore, paperId: string): Promise<string> => {
  const attachment = store.attachments(paperId).find((item) => item.kind === 'html')!
  return readFile(store.attachmentPath(paperId, attachment.id), 'utf8')
}

describe('browser clip input', () => {
  it('validates every field the extension sends', () => {
    const clip = parseBrowserClip({
      kind: 'pdf', url: 'https://example.com/a', title: '  Title ', pdfBase64: Buffer.from('%PDF-1.7').toString('base64'),
      metadata: { authors: ['Ada Lovelace', ' ', 3], doi: ' 10.1000/x ' }, folderID: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', allowDuplicate: true
    })
    expect(clip.title).toBe('Title')
    expect(Buffer.from(clip.pdf!).toString('latin1')).toBe('%PDF-1.7')
    expect(clip.metadata).toEqual({ authors: ['Ada Lovelace'], doi: '10.1000/x', abstract: undefined, publishedDate: undefined })
    expect(clip.folderId).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
    expect(clip.allowDuplicate).toBe(true)

    expect(() => parseBrowserClip({ kind: 'exe', url: 'https://example.com' })).toThrow(InvalidClipError)
    expect(() => parseBrowserClip({ kind: 'html' })).toThrow(InvalidClipError)
    expect(() => parseBrowserClip({ kind: 'html', url: 'https://example.com', folderID: '../x' })).toThrow(InvalidClipError)
    expect(() => parseBrowserClip({ kind: 'html', url: 'https://example.com', extraction: 'everything' })).toThrow(InvalidClipError)
  })

  it('reads the date formats pages use', () => {
    expect(parseClipDate('2017/06/12')).toBe('2017-06-12T00:00:00.000Z')
    expect(parseClipDate('2017-06')).toBe('2017-06-01T00:00:00.000Z')
    expect(parseClipDate('2017')).toBe('2017-01-01T00:00:00.000Z')
    expect(parseClipDate('2017-06-12T08:00:00Z')).toBe('2017-06-12T08:00:00.000Z')
    expect(parseClipDate('sometime')).toBeUndefined()
  })
})

describe('clipper server', () => {
  const context: ClipperContext = {
    version: '0.4.2',
    folders: () => [{ id: '2', name: 'Reading' }, { id: '1', name: 'Archive' }],
    save: async () => ({ paper: { id: 'p', title: 'Saved' } as never, existing: false })
  }

  it('answers only the extension', () => {
    expect(clipperRejection(request('GET', '/ping'))).toBeUndefined()
    expect(clipperRejection(request('GET', '/ping', undefined, { host: 'localhost:23240', origin: 'moz-extension://x' }))).toBeUndefined()
    // A web page, a page that rebinds its domain to 127.0.0.1, and a request without the header.
    expect(clipperRejection(request('GET', '/ping', undefined, { origin: 'https://evil.example' }))?.status).toBe(403)
    expect(clipperRejection(request('GET', '/ping', undefined, { host: 'evil.example:23240' }))?.status).toBe(403)
    const withoutHeader = request('GET', '/ping')
    delete withoutHeader.headers['x-freddie-clipper']
    expect(clipperRejection(withoutHeader)?.status).toBe(403)
  })

  it('routes ping, folders and saves', async () => {
    expect((await handleClipperRequest(request('GET', '/ping'), context)).body).toEqual({ app: 'Freddie', version: '0.4.2', api: clipperAPIVersion })
    expect((await handleClipperRequest(request('GET', '/folders'), context)).body).toEqual({ folders: [{ id: '1', name: 'Archive' }, { id: '2', name: 'Reading' }] })
    expect(await handleClipperRequest(request('POST', '/save', { kind: 'html', url: 'https://example.com', html: '<p>x</p>' }), context))
      .toEqual({ status: 200, body: { status: 'saved', paperID: 'p', title: 'Saved', openURL: paperOpenURL('p') } })
    expect((await handleClipperRequest(request('GET', '/save'), context)).status).toBe(405)
    expect((await handleClipperRequest(request('GET', '/open'), context)).status).toBe(404)
    expect((await handleClipperRequest({ ...request('POST', '/save'), body: Buffer.from('{') }, context)).status).toBe(400)
  })

  it('opens saved papers in this app even beside native Freddie on macOS', () => {
    expect(paperOpenURL('p', 'darwin')).toBe('freddie-general://paper/p')
    expect(paperOpenURL('p', 'win32')).toBe('readpaper://paper/p')
    expect(paperOpenURL('p', 'linux')).toBe('readpaper://paper/p')
    expect(readpaperLink('Freddie-General://paper/p?p=2')).toBe('readpaper://paper/p?p=2')
    expect(readpaperLink('readpaper://paper/p')).toBe('readpaper://paper/p')
  })

  it('listens on the loopback interface', async () => {
    const port = 41000 + Math.floor(Math.random() * 7000)
    const server = startClipperServer(context, port)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'x-freddie-clipper': '1' } })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('access-control-allow-origin')).toBeNull()
      expect((await ok.json()).app).toBe('Freddie')
      expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(403)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('browser clip import', () => {
  it('keeps exactly the selection in the reading shell and files it', async () => {
    const { store, importer } = await makeImporter()
    const folder = await store.createFolder('Clips', 'Untitled')
    const clip = parseBrowserClip({
      kind: 'html', url: 'https://example.com/post#comments', title: 'A Short Quote', extraction: 'selection',
      html: '<!DOCTYPE html><html><head><title>Page</title><script>alert(1)</script></head><body><p>Attention is all you need.</p></body></html>',
      metadata: { authors: ['Ashish Vaswani'], doi: 'https://doi.org/10.48550/arXiv.1706.03762', publishedDate: '2017/06/12' },
      folderID: folder.id
    })

    const { paper, existing } = await importer.importClip(clip)

    expect(existing).toBe(false)
    expect(paper).toMatchObject({ title: 'A Short Quote', htmlUrl: 'https://example.com/post', authors: ['Ashish Vaswani'], doi: '10.48550/arXiv.1706.03762', publishedAt: '2017-06-12T00:00:00.000Z' })
    expect(store.database.memberships).toEqual([expect.objectContaining({ paperId: paper.id, folderId: folder.id })])
    expect(store.attachments(paper.id)).toEqual([expect.objectContaining({ kind: 'html', source: 'webPage' })])
    // Far shorter than a readable import accepts, but the reader chose it.
    const $ = cheerio.load(await savedHTML(store, paper.id))
    expect($('.rp-readability-content').text().trim()).toBe('Attention is all you need.')
    expect($('script')).toHaveLength(0)
  })

  it('simplifies an article and keeps a full page in its own layout', async () => {
    const { store, importer } = await makeImporter()
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>Paragraph ${index + 1} explains the method in enough detail for Readability to keep it as article text.</p>`).join('')
    const html = `<!DOCTYPE html><html><head><title>Method Notes</title></head><body class="site-theme"><article><div class="share">Share on social media</div>${paragraphs}</article></body></html>`

    const article = await importer.importClip(parseBrowserClip({ kind: 'html', url: 'https://example.com/article', extraction: 'article', html }))
    const page = await importer.importClip(parseBrowserClip({ kind: 'html', url: 'https://example.com/page', extraction: 'page', html }))

    expect(article.paper.title).toBe('Method Notes')
    const articleDocument = cheerio.load(await savedHTML(store, article.paper.id))
    expect(articleDocument('.rp-readability-content').text()).toContain('Paragraph 6 explains')
    const pageDocument = cheerio.load(await savedHTML(store, page.paper.id))
    expect(pageDocument('.rp-readability-content')).toHaveLength(0)
    expect(pageDocument('body').hasClass('site-theme')).toBe(true)
    expect(pageDocument('.share').text()).toBe('Share on social media')
  })

  it('reports a page that is already saved unless asked to save again', async () => {
    const { store, importer } = await makeImporter()
    const body = { kind: 'html', url: 'https://example.com/again', extraction: 'selection', html: '<html><body><p>Saved twice.</p></body></html>' }

    const first = await importer.importClip(parseBrowserClip(body))
    const second = await importer.importClip(parseBrowserClip(body))
    expect(second).toMatchObject({ existing: true, paper: { id: first.paper.id } })
    expect(store.database.papers).toHaveLength(1)

    const third = await importer.importClip(parseBrowserClip({ ...body, allowDuplicate: true }))
    expect(third.existing).toBe(false)
    expect(store.database.papers).toHaveLength(2)
  })

  it('adds the PDF of a clipped page to the same paper', async () => {
    const { store, importer } = await makeImporter()
    const first = await importer.importClip(parseBrowserClip({
      kind: 'html', url: 'https://journal.example/paper/7', extraction: 'selection', title: 'My Title',
      html: '<html><body><p>The abstract, clipped first.</p></body></html>', metadata: { authors: ['Grace Hopper'] }
    }))

    const second = await importer.importClip(parseBrowserClip({
      kind: 'pdf', url: 'https://journal.example/paper/7', pdfURL: 'https://journal.example/paper/7.pdf', pdfBase64: await makePDF(),
      title: 'Publisher Title', metadata: { authors: ['G. Hopper'], doi: '10.1000/seven' }
    }))

    expect(second).toMatchObject({ existing: false, paper: { id: first.paper.id, title: 'My Title', authors: ['Grace Hopper'], doi: '10.1000/seven', pdfUrl: 'https://journal.example/paper/7.pdf' } })
    expect(store.database.papers).toHaveLength(1)
    expect(store.attachments(first.paper.id).map((item) => item.kind).sort()).toEqual(['html', 'pdf'])

    // The same DOI from another address is the same paper.
    const third = await importer.importClip(parseBrowserClip({ kind: 'pdf', url: 'https://mirror.example/7', pdfBase64: await makePDF(), metadata: { doi: '10.1000/SEVEN' } }))
    expect(third.existing).toBe(true)
  })

  it('leaves nothing behind when the browser sent a sign-in page instead of the PDF', async () => {
    const { store, importer, root } = await makeImporter()
    const clip = parseBrowserClip({ kind: 'pdf', url: 'https://example.com/login', pdfBase64: Buffer.from('<html>Sign in</html>').toString('base64') })

    await expect(importer.importClip(clip)).rejects.toThrow('The downloaded file is not a PDF.')
    expect(store.database.papers).toHaveLength(0)
    expect(await readdir(join(root, 'Library')).catch(() => [])).toEqual([])
  })
})
