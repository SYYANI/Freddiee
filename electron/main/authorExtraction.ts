import { readFile } from 'node:fs/promises'
import * as cheerio from 'cheerio'
import type { Paper } from '../../shared/types'
import type { Translator } from '../../shared/i18n'
import type { FreddieStore } from './store'
import type { SecretStore } from './secrets'
import { complete, requestFor, resolveRoute, type CompletionRequest, type CompletionResponse } from './llm'

export interface LocalHTMLAuthorContext {
  metaAuthors: string[]
  bylines: string[]
  textSnippet?: string
}

type CompletionClient = (request: CompletionRequest) => Promise<CompletionResponse>

const normalizeWhitespace = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ').trim()

const knownSourceOrganizations: ReadonlyArray<readonly [string, string]> = [
  ['openai.com', 'OpenAI'],
  ['ar5iv.labs.arxiv.org', 'ar5iv'],
  ['arxiv.org', 'arXiv'],
  ['aclanthology.org', 'ACL Anthology'],
  ['acm.org', 'ACM'],
  ['ieee.org', 'IEEE'],
  ['springer.com', 'Springer'],
  ['springernature.com', 'Springer Nature'],
  ['nature.com', 'Nature'],
  ['science.org', 'Science'],
  ['sciencedirect.com', 'ScienceDirect'],
  ['elsevier.com', 'Elsevier'],
  ['wiley.com', 'Wiley'],
  ['tandfonline.com', 'Taylor & Francis'],
  ['mit.edu', 'MIT'],
  ['stanford.edu', 'Stanford'],
  ['berkeley.edu', 'UC Berkeley'],
  ['cmu.edu', 'Carnegie Mellon University'],
  ['ox.ac.uk', 'University of Oxford'],
  ['cam.ac.uk', 'University of Cambridge'],
  ['harvard.edu', 'Harvard University'],
  ['google.com', 'Google'],
  ['googleblog.com', 'Google'],
  ['microsoft.com', 'Microsoft'],
  ['meta.com', 'Meta'],
  ['anthropic.com', 'Anthropic'],
  ['deepmind.google', 'Google DeepMind']
]

const knownOrganizationNames = new Set(knownSourceOrganizations.map(([, organization]) => organization.toLowerCase()))
const commonHostPrefixes = new Set([
  'www', 'm', 'mobile', 'amp', 'blog', 'blogs', 'research', 'news', 'press', 'developer',
  'developers', 'docs', 'documentation', 'papers', 'proceedings', 'journals'
])
const multiPartDomainSuffixes = new Set([
  'ac.cn', 'ac.jp', 'ac.kr', 'ac.uk', 'co.jp', 'co.kr', 'co.uk', 'com.au', 'com.cn',
  'com.hk', 'com.sg', 'edu.au', 'edu.cn', 'edu.hk', 'edu.sg', 'net.cn', 'org.au', 'org.cn', 'org.uk'
])
const organizationNameOverrides: Readonly<Record<string, string>> = {
  ai: 'AI', acl: 'ACL', acm: 'ACM', arxiv: 'arXiv', berkeley: 'UC Berkeley',
  cmu: 'Carnegie Mellon University', deepmind: 'Google DeepMind', google: 'Google',
  googleblog: 'Google', ieee: 'IEEE', mit: 'MIT', openai: 'OpenAI',
  sciencedirect: 'ScienceDirect', springernature: 'Springer Nature'
}

export const authorExtractionPrompt = [
  "You are an academic metadata extraction assistant. Given a paper's metadata and local HTML evidence, identify the author names.",
  'Treat source URLs as metadata only; do not assume you can browse them.',
  'Prefer explicit author metadata or bylines over title guesses.',
  'If no personal authors can be identified but a source organization is provided, return that organization name.',
  'Return only the author names, one per line.',
  'Do not include affiliations, numbering, prefixes, or any other text.',
  'If no authors can be identified, return an empty response.'
].join(' ')

export function parseAuthors(text: string): string[] {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => {
    const lower = line.toLowerCase()
    return !lower.startsWith('author') && !lower.startsWith('title') && !lower.startsWith('abstract') &&
      lower !== 'n/a' && lower !== 'none' && lower !== 'unknown'
  })
  return lines.flatMap(cleanAuthorLine)
}

function cleanAuthorLine(line: string): string[] {
  const withoutBy = line.replace(/^by\s+/i, '')
  const normalized = normalizeWhitespace(withoutBy)
  if (knownOrganizationNames.has(normalized.toLowerCase())) return [normalized]
  return withoutBy
    .replace(/,\s*and\s+/gi, '|||')
    .replace(/\s+and\s+/gi, '|||')
    .replace(/\s*&\s*/g, '|||')
    .split('|||')
    .map((candidate) => candidate.split(',')[0].trim())
    .filter(Boolean)
    .filter((candidate) => {
      const lower = candidate.toLowerCase()
      return !/^(by\s|author|title|abstract)/i.test(lower) && lower !== 'n/a' && lower !== 'none' && lower !== 'unknown'
    })
}

function uniqueAuthors(authors: string[]): string[] {
  const seen = new Set<string>()
  return authors.map(normalizeWhitespace).filter(Boolean).filter((author) => {
    const key = author.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function extractLocalHTMLAuthorContext(html: string, maxTextSnippetLength = 1200): LocalHTMLAuthorContext {
  const $ = cheerio.load(html)
  const collect = (selectors: string[], attribute?: string): string[] => {
    const values: string[] = []
    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const value = normalizeWhitespace(attribute ? ($(element).attr(attribute) ?? '') : $(element).text())
        if (value && !values.some((existing) => existing.toLowerCase() === value.toLowerCase())) values.push(value)
      })
    }
    return values
  }
  const metaAuthors = collect([
    'meta[name="author"]', 'meta[property="author"]', 'meta[property="article:author"]',
    'meta[name="citation_author"]', 'meta[name="dc.creator"]', 'meta[name="twitter:creator"]'
  ], 'content')
  const bylines = collect([
    '.rp-readability-byline', '[rel="author"]', '.byline', '[class*="byline"]',
    '[itemprop="author"]', '[class*="author"]'
  ])
  const visibleText = normalizeWhitespace($('body').length ? $('body').text() : $.root().text())
  return {
    metaAuthors,
    bylines,
    textSnippet: visibleText ? visibleText.slice(0, Math.max(0, maxTextSnippetLength)) : undefined
  }
}

export function buildAuthorExtractionContent(
  title: string,
  abstract: string,
  htmlURL?: string,
  localHTMLContext?: LocalHTMLAuthorContext
): string {
  const parts = [`Title: ${title}`]
  if (abstract) parts.push(`Abstract (first 200 chars): ${abstract.slice(0, 200)}`)
  if (localHTMLContext?.metaAuthors.length) parts.push(`Local HTML author metadata:\n${localHTMLContext.metaAuthors.join('\n')}`)
  if (localHTMLContext?.bylines.length) parts.push(`Local HTML byline candidates:\n${localHTMLContext.bylines.join('\n')}`)
  if (localHTMLContext?.textSnippet) parts.push(`Local HTML visible text excerpt:\n${localHTMLContext.textSnippet}`)
  if (htmlURL) parts.push(`Source URL: ${htmlURL}`)
  const organization = inferSourceOrganization(htmlURL)
  if (organization) parts.push(`Source organization inferred from URL: ${organization}`)
  return parts.join('\n')
}

export function inferSourceOrganization(urlString?: string): string | undefined {
  const value = urlString?.trim()
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!host) return undefined
  for (const [domain, organization] of knownSourceOrganizations) {
    if (host === domain || host.endsWith(`.${domain}`)) return organization
  }
  const label = organizationLabel(host)
  return label ? organizationName(label) : undefined
}

function organizationLabel(host: string): string | undefined {
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return undefined
  while (labels.length > 2 && commonHostPrefixes.has(labels[0])) labels.shift()
  const suffixLength = multiPartDomainSuffixes.has(labels.slice(-2).join('.')) ? 2 : 1
  const label = labels[labels.length - suffixLength - 1]?.replace(/^[-_]+|[-_]+$/g, '')
  return label && label.length >= 2 && /\p{L}/u.test(label) ? label : undefined
}

function organizationName(label: string): string {
  const normalized = label.toLowerCase()
  return organizationNameOverrides[normalized] ?? normalized.split('-').map((word) =>
    organizationNameOverrides[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  ).join(' ')
}

/** Adds authors after import without delaying or failing the import itself. */
export class AuthorExtractionService {
  constructor(
    private readonly store: FreddieStore,
    private readonly secrets: SecretStore,
    private readonly translator: () => Translator,
    private readonly completionClient: CompletionClient = complete
  ) {}

  async extractAuthorsIfNeeded(importedPaper: Paper): Promise<boolean> {
    if (importedPaper.authors.length || !importedPaper.title) return false
    try {
      return await this.extractAndAssign(importedPaper.id)
    } catch (error) {
      console.error(`Author extraction failed for "${importedPaper.title}":`, error)
      return false
    }
  }

  async extractAndAssign(paperId: string): Promise<boolean> {
    const paper = this.store.paper(paperId)
    if (paper.authors.length || !paper.title) return false
    const localHTMLContext = await this.loadLocalHTMLContext(paperId)
    const highConfidenceAuthors = uniqueAuthors([
      ...(localHTMLContext?.metaAuthors ?? []),
      ...(localHTMLContext?.bylines ?? [])
    ].flatMap(parseAuthors))
    if (highConfidenceAuthors.length) return this.assignIfEmpty(paperId, highConfidenceAuthors)

    const sourceURL = paper.htmlUrl ?? paper.pdfUrl
    const fallbackOrganization = inferSourceOrganization(sourceURL)
    try {
      const route = await resolveRoute('html', this.store, this.secrets, this.translator())
      const response = await this.completionClient(requestFor(route, [
        { role: 'system', content: authorExtractionPrompt },
        { role: 'user', content: buildAuthorExtractionContent(paper.title, paper.abstract, sourceURL, localHTMLContext) }
      ], {
        defaultTemperature: 0.1,
        maxTokens: route.apiStyle === 'anthropic-messages' ? undefined : 200,
        timeoutMs: 300_000
      }))
      const authors = uniqueAuthors(parseAuthors(response.text))
      if (authors.length) return this.assignIfEmpty(paperId, authors)
    } catch (error) {
      if (!fallbackOrganization) throw error
      console.warn(`Author extraction model step failed for "${paper.title}"; using source organization.`, error)
    }
    return fallbackOrganization ? this.assignIfEmpty(paperId, [fallbackOrganization]) : false
  }

  private async loadLocalHTMLContext(paperId: string): Promise<LocalHTMLAuthorContext | undefined> {
    const attachment = this.store.attachments(paperId).find((item) => item.kind === 'html')
    if (!attachment) return undefined
    try {
      const context = extractLocalHTMLAuthorContext(await readFile(this.store.attachmentPath(paperId, attachment.id), 'utf8'))
      return context.metaAuthors.length || context.bylines.length || context.textSnippet ? context : undefined
    } catch (error) {
      console.debug(`Unable to load local HTML for author extraction (${paperId}):`, error)
      return undefined
    }
  }

  private async assignIfEmpty(paperId: string, authors: string[]): Promise<boolean> {
    const paper = this.store.paper(paperId)
    if (paper.authors.length) return false
    const unique = uniqueAuthors(authors)
    if (!unique.length) return false
    await this.store.updatePaper(paperId, { authors: unique })
    return true
  }
}
