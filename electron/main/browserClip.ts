import type { ContentExtraction } from './localizer'

/**
 * A page saved by the browser extension (`BrowserExtension/` in the native Freddie
 * repository), as it posts it to the clipper server. The extension captures the page as the
 * reader sees it, signed in and after scripts have run, which a download by URL often cannot.
 */
export interface BrowserClip {
  /** `html`: rendered HTML; `pdf`: the PDF the tab shows or the page links; `arxiv`: imported by ID. */
  kind: 'html' | 'pdf' | 'arxiv'
  url: string
  /** Empty to use the title found in the saved file. */
  title?: string
  html?: string
  extraction?: 'article' | 'selection' | 'page'
  /** The PDF as the browser fetched it, with the reader's cookies. */
  pdf?: Uint8Array
  /** Downloaded here when the browser could not fetch it. */
  pdfUrl?: string
  metadata: ClipMetadata
  folderId?: string
  /** Saves again even when the library has this page. */
  allowDuplicate: boolean
}

/** What the page says about itself (`citation_*`, Dublin Core, Open Graph, JSON-LD). */
export interface ClipMetadata {
  authors: string[]
  doi?: string
  abstract?: string
  publishedDate?: string
}

export class InvalidClipError extends Error {}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const clipExtraction = (clip: BrowserClip): ContentExtraction => ({
  article: 'simplifiedClip' as const,
  selection: 'clip' as const,
  page: 'original' as const
})[clip.extraction ?? 'article']

/** Validates a request body; the server never trusts its shape. */
export function parseBrowserClip(value: unknown): BrowserClip {
  if (!value || typeof value !== 'object') throw new InvalidClipError('Expected a JSON object.')
  const body = value as Record<string, unknown>
  const text = (key: string, limit: number): string | undefined => {
    const item = body[key]
    if (item === undefined || item === null) return undefined
    if (typeof item !== 'string' || item.length > limit) throw new InvalidClipError(`Invalid ${key}.`)
    return item
  }

  const kind = body.kind
  if (kind !== 'html' && kind !== 'pdf' && kind !== 'arxiv') throw new InvalidClipError('Invalid kind.')
  const url = text('url', 8192)
  if (!url) throw new InvalidClipError('Missing url.')
  const extraction = body.extraction ?? undefined
  if (extraction !== undefined && extraction !== 'article' && extraction !== 'selection' && extraction !== 'page') {
    throw new InvalidClipError('Invalid extraction.')
  }
  const folderId = text('folderID', 64)
  if (folderId !== undefined && !uuidPattern.test(folderId)) throw new InvalidClipError('Invalid folderID.')
  const pdfBase64 = text('pdfBase64', 200 * 1024 * 1024)
  const pdf = pdfBase64 === undefined ? undefined : new Uint8Array(Buffer.from(pdfBase64, 'base64'))

  const rawMetadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : {}
  const metadataText = (key: string, limit: number): string | undefined => {
    const item = rawMetadata[key]
    return typeof item === 'string' && item.trim() ? item.trim().slice(0, limit) : undefined
  }
  const authors = Array.isArray(rawMetadata.authors)
    ? rawMetadata.authors.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 200)
    : []

  return {
    kind,
    url,
    title: text('title', 2000)?.trim() || undefined,
    html: text('html', 150 * 1024 * 1024),
    extraction,
    pdf,
    pdfUrl: text('pdfURL', 8192)?.trim() || undefined,
    metadata: {
      authors,
      doi: metadataText('doi', 512),
      abstract: metadataText('abstract', 20_000),
      publishedDate: metadataText('publishedDate', 64)
    },
    folderId: folderId?.toLowerCase(),
    allowDuplicate: body.allowDuplicate === true
  }
}

/**
 * Dates as pages write them in `citation_publication_date` and similar tags: ISO 8601 with or
 * without a time, `2017/06/12`, `2017-06` or a bare year. Returns an ISO string.
 */
export function parseClipDate(value: string): string | undefined {
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/)
  if (match) {
    const [year, month = 1, day = 1] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3] ?? 1)]
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    return new Date(Date.UTC(year, month - 1, day)).toISOString()
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return undefined
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
