import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

// Shared with the reader so saved documents get the same repairs as new imports.
export const readableProseColorCSS = `
body.rp-readability-body {
    color: var(--rp-reader-text, #1f1f1f) !important;
    background: transparent !important;
}
body.rp-readability-body .rp-readability-shell,
body.rp-readability-body .rp-readability-shell :where(article, section, main, header, footer, aside, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, blockquote, figure, figcaption, table, thead, tbody, tfoot, tr, th, td, span, strong, b, em, i, small, sup, sub):not(:where(pre *, code *, svg *, math *)) {
    color: inherit !important;
    text-shadow: none !important;
}
body.rp-readability-body .rp-readability-shell :where(article, section, main, header, footer, aside, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, figure, figcaption, table, thead, tbody, tfoot, tr, th, td):not(:where(pre *, code *, svg *, math *, .rp-note-anchor-target, .rp-assistant-history-fallback)) {
    background-color: transparent !important;
}
body.rp-readability-body .rp-readability-header,
body.rp-readability-body .rp-readability-content {
    color: var(--rp-reader-text, #1f1f1f) !important;
}
body.rp-readability-body .rp-readability-byline,
body.rp-readability-body .rp-readability-excerpt {
    color: var(--rp-reader-muted, #5f6368) !important;
}
body.rp-readability-body .rp-readability-shell a:not(:where(pre *, code *, svg *, math *)) {
    color: var(--rp-reader-link, #335c85) !important;
}
body.rp-readability-body .rp-readability-shell .rp-translation-block {
    color: var(--rp-reader-translation, #1f4d3a) !important;
}`

export const readableProseLayoutCSS = `
html:has(> body.rp-readability-body) {
    max-width: none !important;
}
body.rp-readability-body :is(.rp-readability-header, .rp-readability-content) :is(p, h1, h2, h3, h4, h5, h6):not(svg *, math *) {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    margin-inline: 0 !important;
    padding-inline: 0 !important;
    box-sizing: border-box !important;
}`

export const readabilityCSS = `
:where(body.rp-readability-body) { margin: 0; }
body.rp-readability-body { padding: 32px 24px 56px; }
.rp-readability-shell { max-width: 980px; margin: 0 auto; }
.rp-readability-header {
    display: block;
    margin-bottom: 2rem;
    background: transparent;
    padding: 0;
    width: auto;
    box-sizing: border-box;
}
.rp-readability-title { margin: 0; font-size: 2rem; line-height: 1.25; }
.rp-readability-byline, .rp-readability-excerpt { color: #5f6368; margin-top: 0.75rem; line-height: 1.5; }
.rp-readability-content { color: #1f1f1f; font-size: 1rem; line-height: 1.65; }
.rp-readability-content p.rp-readability-prose-paragraph {
    color: inherit !important;
    font-size: inherit !important;
    line-height: inherit !important;
    margin: 0 0 0.8em 0 !important;
    white-space: normal !important;
}
.rp-readability-content img, .rp-readability-content video, .rp-readability-content svg, .rp-readability-content math { max-width: 100%; }
body.rp-readability-body .rp-readability-content #readability-page-1 :not(svg, svg *, math, math *) {
    position: static !important;
    inset: auto !important;
    transform: none !important;
    translate: none !important;
    rotate: none !important;
    scale: none !important;
}
body.rp-readability-body .rp-readability-content #readability-page-1 :is(ul, ol) {
    position: relative !important;
}
body.rp-readability-body .rp-readability-content #readability-page-1 :is(article, section, main, header, footer, aside, div) {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
}
.rp-readability-content .page,
.rp-readability-content .available-content,
.rp-readability-content .grid,
.rp-readability-content [class~='pc-display-grid'] {
    display: block !important;
}
.rp-readability-content .available-content {
    padding: 0 !important;
}
.rp-readability-content .page > *,
.rp-readability-content .available-content > *,
.rp-readability-content .grid > *,
.rp-readability-content [class~='pc-display-grid'] > * {
    width: 100% !important;
    max-width: 100% !important;
    grid-column: auto !important;
    box-sizing: border-box;
}
${readableProseLayoutCSS}
${readableProseColorCSS}`

export interface LocalizedPage {
  title?: string
  byline?: string
  excerpt?: string
  html: string
}

/**
 * How much of a page becomes the saved document. `readable` lets Readability pick the
 * article and keeps the page when it finds too little. A browser clip's body is what the
 * reader picked, so it always gets the reading shell: `clip` as is (a selection),
 * `simplifiedClip` after Readability drops page chrome inside it. `original` keeps the
 * page's own layout (a full-page clip).
 */
export type ContentExtraction = 'readable' | 'simplifiedClip' | 'clip' | 'original'

export interface LocalizeOptions {
  /** Directory of the paper; resources are saved below `Resources/`, as in native Freddie. */
  directory: string
  extraction?: ContentExtraction
  fetchResource?: (url: string, signal: AbortSignal) => Promise<{ data: Uint8Array; contentType: string } | undefined>
  signal?: AbortSignal
  resourceBudgetMs?: number
}

const escapeHTML = (value: string): string => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!)
const normalizeSpace = (value?: string | null): string | undefined => value?.replace(/\s+/g, ' ').trim() || undefined

/** Extracts the readable article, falling back to the sanitized page, and localizes its images. */
export async function localizeHTML(source: string, pageURL: URL, options: LocalizeOptions): Promise<LocalizedPage> {
  const extraction = options.extraction ?? 'readable'
  const dom = new JSDOM(source, { url: pageURL.toString() })
  const document = dom.window.document
  const documentTitle = normalizeSpace(document.title)
  let article: ReturnType<Readability<string>['parse']> = null
  if (extraction === 'readable' || extraction === 'simplifiedClip') {
    try {
      article = new Readability(document.cloneNode(true) as Document, { keepClasses: true }).parse()
    } catch {
      article = null
    }
  }

  let html: string
  let title = normalizeSpace(article?.title) ?? documentTitle
  const minimumLength = extraction === 'readable' ? 200 : 0
  if (article?.content && (article.textContent?.trim().length ?? 0) > minimumLength) {
    const content = preferLargerCandidate(article.content, article.textContent ?? '', document)
    html = renderReadableDocument({
      title,
      byline: normalizeSpace(article.byline),
      excerpt: shouldRenderExcerpt(article.excerpt, article.textContent) ? normalizeSpace(article.excerpt) : undefined,
      content,
      lang: article.lang ?? document.documentElement.lang,
      dir: article.dir ?? undefined
    })
  } else if (extraction === 'simplifiedClip' || extraction === 'clip') {
    title = documentTitle
    html = renderReadableDocument({ title, content: document.body?.innerHTML ?? '', lang: document.documentElement.lang })
  } else {
    html = dom.serialize()
    title = documentTitle
  }
  dom.window.close()

  const $ = cheerio.load(html)
  sanitize($, pageURL)
  await localizeResources($, pageURL, options)
  return { title, byline: normalizeSpace(article?.byline), excerpt: normalizeSpace(article?.excerpt), html: $.html() }
}

/** Readability sometimes keeps one short block of a long article; use the main element then. */
function preferLargerCandidate(content: string, textContent: string, document: Document): string {
  const candidates = ['article.ltx_document', '.ltx_page_content', 'article', 'main', '[role=main]']
  for (const selector of candidates) {
    const element = document.querySelector(selector)
    const text = element?.textContent?.trim() ?? ''
    if (element && textContent.trim().length * 5 < text.length) return `<div id="readability-page-1" class="page">${element.innerHTML}</div>`
  }
  return content
}

function shouldRenderExcerpt(excerpt: string | null | undefined, textContent: string | null | undefined): boolean {
  const normalizedExcerpt = normalizeSpace(excerpt?.replace(/\s*(?:\[\s*(?:…|\.{3})\s*\]|…|\.{3})\s*$/, ''))
  if (!normalizedExcerpt) return false
  return !(normalizeSpace(textContent) ?? '').startsWith(normalizedExcerpt)
}

function renderReadableDocument(input: { title?: string; byline?: string; excerpt?: string; content: string; lang?: string; dir?: string }): string {
  const header = input.title
    ? `<div class="rp-readability-header"><h1 class="rp-readability-title">${escapeHTML(input.title)}</h1>${input.byline ? `<p class="rp-readability-byline">${escapeHTML(input.byline)}</p>` : ''}${input.excerpt ? `<p class="rp-readability-excerpt">${escapeHTML(input.excerpt)}</p>` : ''}</div>`
    : ''
  const lang = input.lang ? ` lang="${escapeHTML(input.lang)}"` : ''
  const dir = input.dir ? ` dir="${escapeHTML(input.dir)}"` : ''
  return `<!DOCTYPE html><html${lang}${dir}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(input.title ?? 'Paper')}</title><style id="rp-readability-style">${readabilityCSS}</style></head><body class="rp-readability-body"><main class="rp-readability-shell">${header}<article class="rp-readability-content">${input.content}</article></main></body></html>`
}

/** Removes everything that could run or navigate on its own, and makes links absolute. */
export function sanitize($: CheerioAPI, pageURL: URL): void {
  $('script, noscript, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv], form, input, button, select, textarea, dialog, template').remove()
  $('link').each((_, element) => {
    const rel = ($(element).attr('rel') ?? '').toLowerCase()
    if (!rel.includes('stylesheet')) $(element).remove()
  })
  $('*').each((_, element) => {
    const attributes = (element as { attribs?: Record<string, string> }).attribs ?? {}
    for (const [name, value] of Object.entries(attributes)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('on') || lower === 'srcdoc' || lower === 'formaction' || lower === 'ping') $(element).removeAttr(name)
      else if (['href', 'src', 'xlink:href', 'action', 'poster', 'data'].includes(lower) && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) $(element).removeAttr(name)
    }
  })
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? ''
    if (href.startsWith('#')) return
    try {
      $(element).attr('href', new URL(href, pageURL).toString())
    } catch {
      $(element).removeAttr('href')
    }
  })
  $('img').each((_, element) => {
    $(element).attr('loading', 'lazy')
    $(element).attr('decoding', 'async')
    // Lazy-loading scripts often keep the real URL in a data attribute.
    for (const key of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc']) {
      const value = $(element).attr(key)
      if (value && (!$(element).attr('src') || $(element).attr('src')!.startsWith('data:image/gif'))) $(element).attr('src', value)
    }
  })
}

const extensionFor = (contentType: string, url: string): string => {
  const known: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'text/css': '.css'
  }
  const fromType = known[contentType.split(';')[0].trim().toLowerCase()]
  if (fromType) return fromType
  const match = new URL(url).pathname.match(/\.(png|jpe?g|gif|webp|svg|avif|css)$/i)
  return match ? `.${match[1].toLowerCase()}` : '.bin'
}

async function localizeResources($: CheerioAPI, pageURL: URL, options: LocalizeOptions): Promise<void> {
  if (!options.fetchResource) return
  const assetsDirectory = join(options.directory, 'Resources')
  await mkdir(assetsDirectory, { recursive: true })
  const deadline = Date.now() + (options.resourceBudgetMs ?? 30_000)
  const saved = new Map<string, string>()

  const download = async (raw: string, kind: 'image' | 'css'): Promise<string | undefined> => {
    let url: URL
    try {
      url = new URL(raw, pageURL)
    } catch {
      return undefined
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const key = url.toString()
    if (saved.has(key)) return saved.get(key)
    if (Date.now() > deadline || options.signal?.aborted) return undefined
    const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(options.signal ? [options.signal] : [])])
    try {
      const result = await options.fetchResource!(key, signal)
      if (!result) return undefined
      const type = result.contentType.toLowerCase()
      if (kind === 'image' && !type.startsWith('image/')) return undefined
      if (kind === 'css' && !type.includes('css')) return undefined
      const name = `${createHash('sha256').update(key).digest('hex').slice(0, 24)}${extensionFor(type, key)}`
      let data = result.data
      if (kind === 'css') data = new TextEncoder().encode(rewriteCSSURLs(new TextDecoder().decode(data), new URL(key)))
      await writeFile(join(assetsDirectory, name), data)
      saved.set(key, `Resources/${name}`)
      return `Resources/${name}`
    } catch {
      return undefined
    }
  }

  const tasks: Array<() => Promise<void>> = []
  $('img[src], image[href], input[type=image][src]').slice(0, 96).each((_, element) => {
    const attribute = element.tagName === 'image' ? 'href' : 'src'
    const value = $(element).attr(attribute)
    if (!value || value.startsWith('data:')) return
    tasks.push(async () => {
      const local = await download(value, 'image')
      if (local) $(element).attr(attribute, local)
      else {
        try {
          $(element).attr(attribute, new URL(value, pageURL).toString())
        } catch {
          // Leave it as it is.
        }
      }
    })
  })
  $('img[srcset], source[srcset]').each((_, element) => {
    // A single localized source is enough for reading offline.
    const candidates = ($(element).attr('srcset') ?? '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
    const best = candidates[candidates.length - 1]
    $(element).removeAttr('srcset')
    if (element.tagName === 'source') {
      $(element).remove()
      return
    }
    if (!$(element).attr('src') && best) {
      tasks.push(async () => {
        const local = await download(best, 'image')
        $(element).attr('src', local ?? new URL(best, pageURL).toString())
      })
    }
  })
  $('link[rel~=stylesheet][href]').slice(0, 16).each((_, element) => {
    const href = $(element).attr('href')!
    tasks.push(async () => {
      const local = await download(href, 'css')
      if (local) $(element).attr('href', local)
      else $(element).remove()
    })
  })

  // Six downloads at a time, like the native localizer.
  let next = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      await task()
    }
  }))
}

function rewriteCSSURLs(css: string, base: URL): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, value: string) => {
    if (value.startsWith('data:')) return match
    try {
      return `url(${quote}${new URL(value, base).toString()}${quote})`
    } catch {
      return match
    }
  }).replace(/@import\s+[^;]+;/g, '')
}

/**
 * Marks the regions the reader hid. Paths count original children from <body>, skipping
 * translation blocks, the same way the reader builds them.
 */
export function applyHiddenRegions($: CheerioAPI, paths: string[]): void {
  $('[data-rp-hidden]').removeAttr('data-rp-hidden')
  for (const path of paths) {
    if (!path.startsWith('rp-path:')) continue
    let current = $('body').first()
    for (const part of path.slice('rp-path:'.length).split('/').filter(Boolean)) {
      const children = current.children().filter((_, child) => !$(child).hasClass('rp-translation-block') && $(child).attr('data-rp-reader') === undefined)
      current = children.eq(Number(part))
      if (!current.length) break
    }
    if (current.length && !current.is('body')) current.attr('data-rp-hidden', 'true')
  }
}
