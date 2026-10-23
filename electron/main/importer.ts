import { randomUUID } from 'node:crypto'
import { copyFile, open, readFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import * as cheerio from 'cheerio'
import type { Attachment, ImportProgress, Paper } from '../../shared/types'
import type { Translator } from '../../shared/i18n'
import {
  arxivQueryId,
  extractArxivIdentifier,
  extractDOI,
  fallbackWebPageTitle,
  InvalidIdentifierError,
  normalizeArxivIdentifier,
  normalizeWebPageURL,
  type ArxivIdentifier
} from '../../shared/identifiers'
import { atomicWriteFile } from './files'
import { localizeHTML } from './localizer'
import type { FreddieStore } from './store'

type ProgressSink = (progress: ImportProgress) => void

const browserHeaders = (accept: 'document' | 'resource'): Record<string, string> => ({
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 Freddie/1.0',
  accept: accept === 'document' ? 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8' : '*/*',
  'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8'
})

interface ArxivMetadata {
  arxivId: string
  version?: string
  title: string
  abstract: string
  authors: string[]
  categories: string[]
  publishedAt?: string
  updatedAt?: string
  pdfUrl?: string
  absUrl?: string
}

const clean = (value?: string | null): string => value?.replace(/\s+/g, ' ').trim() ?? ''
const now = (): string => new Date().toISOString()

export class ImportError extends Error {}

export class PaperImporter {
  private readonly operations = new Map<string, AbortController>()
  private lastArxivRequest = 0

  constructor(
    private readonly store: FreddieStore,
    private readonly progress: ProgressSink,
    private readonly translator: () => Translator
  ) {}

  cancel(operationId: string): void {
    this.operations.get(operationId)?.abort(new DOMException('Import cancelled', 'AbortError'))
  }

  private begin(operationId: string): AbortController {
    const controller = new AbortController()
    this.operations.set(operationId, controller)
    return controller
  }

  private emit(operationId: string, step: number, total: number, fraction: number, title: string, detail?: string): void {
    const t = this.translator()
    this.progress({ operationId, stepLabel: t('Step %d of %d', step, total), fraction, title, detail })
  }

  private async fetchOK(url: string, accept: 'document' | 'resource', signal: AbortSignal, errorFor: (status: number) => Error): Promise<Response> {
    const response = await fetch(url, { headers: browserHeaders(accept), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'follow' })
    if (!response.ok) throw errorFor(response.status)
    return response
  }

  // MARK: arXiv

  async importArxiv(rawValue: string, includeHTML: boolean, operationId: string): Promise<Paper> {
    const t = this.translator()
    const controller = this.begin(operationId)
    const total = includeHTML ? 6 : 5
    const step = (stage: number): number => (stage === 6 && !includeHTML ? 5 : stage)
    try {
      this.emit(operationId, 1, total, 0.08, t('Checking arXiv identifier'), t('Normalizing the input and checking whether it already exists in your library.'))
      let identifier: ArxivIdentifier
      try {
        identifier = normalizeArxivIdentifier(rawValue)
      } catch {
        throw new ImportError(t('Invalid arXiv identifier: %@', rawValue))
      }
      const queryId = arxivQueryId(identifier)
      this.emit(operationId, 1, total, 0.08, t('Checking arXiv identifier'), t('Normalized to %@ and checking whether it already exists in your library.', queryId))
      const existing = this.store.database.papers.find((paper) => paper.arxivId === identifier.baseId)
      if (existing) return existing

      this.emit(operationId, 2, total, 0.22, t('Fetching metadata'), t('Loading title, authors, abstract, and links for %@.', queryId))
      const metadata = await this.fetchArxivMetadata(identifier, rawValue, controller.signal)
      const title = metadata.title || metadata.arxivId
      this.emit(operationId, 3, total, 0.38, t('Creating library entry'), t('Preparing local storage for "%@".', title))
      const id = randomUUID()
      const directory = await this.store.ensurePaperDirectory(id)
      const attachments: Attachment[] = []
      try {
        this.emit(operationId, 4, total, 0.56, t('Downloading PDF'), t('Saving the source PDF for %@ to your local library.', metadata.arxivId))
        const pdfURL = metadata.pdfUrl ?? `https://arxiv.org/pdf/${queryId}`
        const pdfResponse = await this.fetchOK(pdfURL, 'resource', controller.signal, (status) => new ImportError(t('arXiv returned an error (status %d). Please try again later.', status)))
        await atomicWriteFile(join(directory, 'paper.pdf'), new Uint8Array(await pdfResponse.arrayBuffer()))
        attachments.push({ id: randomUUID(), paperId: id, kind: 'pdf', source: 'arxivPDF', filename: 'paper.pdf', createdAt: now() })

        let htmlImported = false
        if (includeHTML) {
          htmlImported = await this.importArxivHTML(id, directory, queryId, operationId, controller.signal, attachments)
        }
        controller.signal.throwIfAborted()
        this.emit(operationId, step(6), total, 0.92, t('Finalizing import'), includeHTML
          ? (htmlImported ? t('Saving the paper, PDF, and localized HTML to your library.') : t('Saving the paper and PDF. HTML was unavailable, so the import will finish with PDF only.'))
          : t('Saving the paper metadata and PDF to your library.'))
        const timestamp = now()
        const paper: Paper = {
          id,
          arxivId: metadata.arxivId,
          arxivVersion: metadata.version,
          title,
          abstract: metadata.abstract,
          authors: metadata.authors,
          categories: metadata.categories,
          publishedAt: metadata.publishedAt,
          updatedAt: metadata.updatedAt,
          pdfUrl: metadata.pdfUrl,
          htmlUrl: metadata.absUrl,
          tags: [],
          isFavorite: false,
          createdAt: timestamp,
          modifiedAt: timestamp
        }
        await this.store.addPaper(paper, attachments)
        return paper
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    } finally {
      this.operations.delete(operationId)
    }
  }

  private async importArxivHTML(id: string, directory: string, queryId: string, operationId: string, signal: AbortSignal, attachments: Attachment[]): Promise<boolean> {
    const t = this.translator()
    const sources: Array<{ url: string; name: string }> = [
      { url: `https://arxiv.org/html/${queryId}`, name: t('arXiv HTML') },
      { url: `https://ar5iv.labs.arxiv.org/html/${queryId}`, name: 'ar5iv' }
    ]
    for (const [index, source] of sources.entries()) {
      const isFallback = index > 0
      this.emit(operationId, 5, 6, isFallback ? 0.8 : 0.72,
        isFallback ? t('Trying backup HTML source') : t('Fetching reader HTML'),
        isFallback ? t('The primary HTML source was unavailable, so ReadPaper is trying %@.', source.name) : t('Localizing the paper body from %@ for reading and translation.', source.name))
      try {
        const response = await fetch(source.url, { headers: browserHeaders('document'), signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
        if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html')) continue
        // arXiv redirects papers without HTML back to the abstract page.
        if (/\/abs\//.test(response.url)) continue
        const page = await localizeHTML(await response.text(), new URL(response.url || source.url), {
          directory,
          signal,
          fetchResource: (url, resourceSignal) => this.fetchResource(url, resourceSignal)
        })
        await atomicWriteFile(join(directory, 'paper.html'), page.html)
        attachments.push({ id: randomUUID(), paperId: id, kind: 'html', source: 'arxivHTML', filename: 'paper.html', createdAt: now() })
        return true
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
    return false
  }

  private async fetchArxivMetadata(identifier: ArxivIdentifier, rawValue: string, signal: AbortSignal): Promise<ArxivMetadata> {
    const t = this.translator()
    const queryId = arxivQueryId(identifier)
    // arXiv asks clients to wait three seconds between API requests.
    const wait = this.lastArxivRequest + 3000 - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastArxivRequest = Date.now()
    try {
      const response = await this.fetchOK(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}`, 'document', signal, (status) => new ImportError(t('arXiv returned an error (status %d). Please try again later.', status)))
      const metadata = parseArxivAtom(await response.text())
      if (metadata) return metadata
      throw new InvalidIdentifierError(rawValue)
    } catch (error) {
      if (signal.aborted) throw error
      try {
        const response = await this.fetchOK(`https://arxiv.org/abs/${queryId}`, 'document', signal, (status) => status === 404
          ? new ImportError(t('Invalid arXiv identifier: %@', rawValue))
          : new ImportError(t('arXiv returned an error (status %d). Please try again later.', status)))
        const metadata = parseArxivAbsPage(await response.text(), identifier)
        if (metadata) return metadata
      } catch (fallbackError) {
        if (fallbackError instanceof ImportError) throw fallbackError
      }
      if (error instanceof InvalidIdentifierError) throw new ImportError(t('Invalid arXiv identifier: %@', rawValue))
      throw error
    }
  }

  // MARK: Web pages

  async importWebPage(rawValue: string, operationId: string): Promise<Paper> {
    const t = this.translator()
    const controller = this.begin(operationId)
    try {
      this.emit(operationId, 1, 4, 0.1, t('Checking web page URL'), t('Normalizing the URL and checking whether it already exists in your library.'))
      let url: URL
      try {
        url = normalizeWebPageURL(rawValue)
      } catch (error) {
        throw new ImportError((error as { code?: string }).code === 'unsupportedScheme' ? t('Only http:// or https:// page URLs are supported.') : t('Please enter a valid web page URL.'))
      }
      this.emit(operationId, 1, 4, 0.1, t('Checking web page URL'), t('Normalized to %@ and checking whether it already exists in your library.', url.toString()))
      // An arXiv page goes through the arXiv path, which saves its metadata.
      if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
        try {
          normalizeArxivIdentifier(url.toString())
          this.operations.delete(operationId)
          return await this.importArxiv(url.toString(), true, operationId)
        } catch (error) {
          if (!(error instanceof ImportError) && !(error instanceof InvalidIdentifierError)) throw error
        }
      }
      const existing = this.store.database.papers.find((paper) => paper.htmlUrl === url.toString() || paper.pdfUrl === url.toString())
      if (existing && this.store.attachments(existing.id).some((item) => item.kind === 'html' || item.kind === 'pdf')) return existing

      this.emit(operationId, 2, 4, 0.35, t('Fetching web page'), t('Downloading %@, extracting the readable article body, and localizing linked resources.', url.hostname))
      const response = await this.fetchOK(url.toString(), 'document', controller.signal, (status) => new ImportError(t('The web server returned an error (status %d).', status)))
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      const id = randomUUID()
      const directory = await this.store.ensurePaperDirectory(id)
      try {
        if (contentType.includes('application/pdf')) {
          this.emit(operationId, 2, 4, 0.35, t('Downloading PDF'), t('Saving the source PDF for %@ to your local library.', url.hostname))
          const data = new Uint8Array(await response.arrayBuffer())
          await atomicWriteFile(join(directory, 'paper.pdf'), data)
          const metadata = await readPDFMetadata(data)
          const title = metadata.title || fallbackWebPageTitle(url, t('Untitled Web Page'))
          this.emit(operationId, 3, 4, 0.78, t('Creating library entry'), t('Preparing local storage for "%@".', title))
          this.emit(operationId, 4, 4, 0.92, t('Finalizing import'), t('Saving the paper and localized HTML to your library.'))
          const timestamp = now()
          const paper: Paper = {
            id, title, abstract: '', authors: metadata.authors, categories: [], tags: [], isFavorite: false,
            arxivId: metadata.arxiv?.baseId, arxivVersion: metadata.arxiv?.version, doi: metadata.arxiv ? undefined : metadata.doi,
            pdfUrl: url.toString(), createdAt: timestamp, modifiedAt: timestamp
          }
          await this.store.addPaper(paper, [{ id: randomUUID(), paperId: id, kind: 'pdf', source: 'webPage', filename: 'paper.pdf', createdAt: timestamp }])
          return paper
        }
        const page = await localizeHTML(await response.text(), new URL(response.url || url.toString()), {
          directory,
          signal: controller.signal,
          fetchResource: (resourceURL, signal) => this.fetchResource(resourceURL, signal)
        })
        const title = page.title || fallbackWebPageTitle(url, t('Untitled Web Page'))
        this.emit(operationId, 3, 4, 0.78, t('Creating library entry'), t('Preparing local storage for "%@".', title))
        await atomicWriteFile(join(directory, 'paper.html'), page.html)
        controller.signal.throwIfAborted()
        this.emit(operationId, 4, 4, 0.92, t('Finalizing import'), t('Saving the paper and localized HTML to your library.'))
        const timestamp = now()
        const paper: Paper = {
          id, title, abstract: page.excerpt ?? '', authors: page.byline ? [page.byline] : [], categories: [], tags: [], isFavorite: false,
          htmlUrl: url.toString(), createdAt: timestamp, modifiedAt: timestamp
        }
        await this.store.addPaper(paper, [{ id: randomUUID(), paperId: id, kind: 'html', source: 'webPage', filename: 'paper.html', createdAt: timestamp }])
        return paper
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    } finally {
      this.operations.delete(operationId)
    }
  }

  private async fetchResource(url: string, signal: AbortSignal): Promise<{ data: Uint8Array; contentType: string } | undefined> {
    const response = await fetch(url, { headers: browserHeaders('resource'), signal })
    if (!response.ok) return undefined
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 20 * 1024 * 1024) return undefined
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? '' }
  }

  // MARK: Local files

  async importLocalPDF(path: string): Promise<Paper> {
    const t = this.translator()
    if (extname(path).toLowerCase() !== '.pdf') throw new ImportError(t('Unsupported file: %@', basename(path)))
    // Paths may come from a drop in the renderer, so only real PDF files are accepted.
    const handle = await open(path, 'r')
    try {
      const header = Buffer.alloc(5)
      await handle.read(header, 0, 5, 0)
      if (header.toString('latin1') !== '%PDF-') throw new ImportError(t('Unsupported file: %@', basename(path)))
    } finally {
      await handle.close()
    }
    const id = randomUUID()
    const directory = await this.store.ensurePaperDirectory(id)
    try {
      await copyFile(path, join(directory, 'paper.pdf'))
      const metadata = await readPDFMetadata(new Uint8Array(await readFile(join(directory, 'paper.pdf'))))
      const timestamp = now()
      const paper: Paper = {
        id,
        title: metadata.title || basename(path, extname(path)) || t('Untitled PDF'),
        abstract: '',
        authors: metadata.authors,
        categories: [],
        tags: [],
        isFavorite: false,
        arxivId: metadata.arxiv?.baseId,
        arxivVersion: metadata.arxiv?.version,
        doi: metadata.doi,
        createdAt: timestamp,
        modifiedAt: timestamp
      }
      await this.store.addPaper(paper, [{ id: randomUUID(), paperId: id, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: timestamp }])
      return paper
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
}

export function parseArxivAtom(xml: string): ArxivMetadata | undefined {
  const $ = cheerio.load(xml, { xml: true })
  const entry = $('entry').first()
  if (!entry.length) return undefined
  const idURL = clean(entry.children('id').first().text())
  const idMatch = idURL.match(/abs\/(.+?)(v\d+)?$/)
  if (!idMatch) return undefined
  const title = clean(entry.children('title').first().text())
  if (!title || /^error$/i.test(title)) return undefined
  const pdfLink = entry.find('link[title="pdf"]').attr('href') ?? entry.find('link[type="application/pdf"]').attr('href')
  return {
    arxivId: idMatch[1],
    version: idMatch[2],
    title,
    abstract: clean(entry.children('summary').first().text()),
    authors: entry.find('author > name').map((_, element) => clean($(element).text())).get().filter(Boolean),
    categories: entry.find('category').map((_, element) => $(element).attr('term') ?? '').get().filter(Boolean),
    publishedAt: clean(entry.children('published').first().text()) || undefined,
    updatedAt: clean(entry.children('updated').first().text()) || undefined,
    pdfUrl: pdfLink?.replace(/^http:/, 'https:'),
    absUrl: idURL.replace(/^http:/, 'https:')
  }
}

function parseArxivAbsPage(html: string, identifier: ArxivIdentifier): ArxivMetadata | undefined {
  const $ = cheerio.load(html)
  const meta = (name: string): string[] => $(`meta[name="${name}"]`).map((_, element) => clean($(element).attr('content'))).get().filter(Boolean)
  const title = meta('citation_title')[0]
  if (!title) return undefined
  const authors = meta('citation_author').map((author) => {
    const [family, given] = author.split(',').map((part) => part.trim())
    return given ? `${given} ${family}` : family
  })
  const date = meta('citation_date')[0]
  return {
    arxivId: identifier.baseId,
    version: identifier.version,
    title,
    abstract: meta('citation_abstract')[0] ?? clean($('blockquote.abstract').text().replace(/^Abstract:/, '')),
    authors,
    categories: [],
    publishedAt: date ? new Date(date.replace(/\//g, '-')).toISOString() : undefined,
    pdfUrl: meta('citation_pdf_url')[0] ?? `https://arxiv.org/pdf/${arxivQueryId(identifier)}`,
    absUrl: `https://arxiv.org/abs/${identifier.baseId}`
  }
}

/**
 * Lightweight identification from the Info dictionary and the first pages' text. PDF text is
 * never treated as a stable full-text structure.
 */
export async function readPDFMetadata(data: Uint8Array): Promise<{ title?: string; authors: string[]; arxiv?: ArxivIdentifier; doi?: string; pageCount: number }> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loadingTask = pdfjs.getDocument({ data: data.slice(), useSystemFonts: false, standardFontDataUrl: standardFontDataURL() })
    const document = await loadingTask.promise
    const { info } = await document.getMetadata().catch(() => ({ info: {} as Record<string, unknown> }))
    const infoRecord = info as Record<string, unknown>
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= Math.min(3, document.numPages); pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    const strings = Object.values(infoRecord).filter((value): value is string => typeof value === 'string')
    const searchable = [...pages, ...strings].join('\n')
    const title = clean(typeof infoRecord.Title === 'string' ? infoRecord.Title : '') || undefined
    const author = clean(typeof infoRecord.Author === 'string' ? infoRecord.Author : '')
    const result = {
      title: title && !/^(untitled|microsoft word|\s*)$/i.test(title) ? title : undefined,
      authors: author ? [author] : [],
      arxiv: extractArxivIdentifier(searchable),
      doi: extractDOI(searchable),
      pageCount: document.numPages
    }
    await loadingTask.destroy()
    return result
  } catch {
    return { authors: [], pageCount: 0 }
  }
}

/**
 * pdf.js needs its standard fonts to read text set in the 14 standard PDF fonts. In Node it
 * reads them with fs.readFile, so this is a directory path rather than a URL, and packaged
 * builds unpack the fonts outside the asar archive.
 */
export function standardFontDataURL(): string {
  return pdfjsDataDirectory('standard_fonts')
}

/** pdf.js's WebAssembly image decoders (JBIG2, JPEG 2000), needed to render scanned pages. */
export function wasmDataURL(): string {
  return pdfjsDataDirectory('wasm')
}

function pdfjsDataDirectory(name: string): string {
  const directory = join(dirname(require.resolve('pdfjs-dist/package.json')), name).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return `${directory}${sep}`
}
