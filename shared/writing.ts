import type { NoteSelectionContext, WritingCitationRecord } from './types'

// Citations are Markdown links in the same form as native Freddie:
// [label](readpaper://paper/<paper ID>?att=…&p=…&anchor=… "start of the quote")

export const citationScheme = 'readpaper'
const quotePrefixLength = 40
const uuidPattern = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
const citationExpression = new RegExp(`readpaper://paper/${uuidPattern}[^\\s()<>\\[\\]]*`, 'gi')

export interface PaperCitation extends WritingCitationRecord {}

const normalizeSpace = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ')

export function citationFromSelection(paperId: string, selection?: NoteSelectionContext): PaperCitation {
  const quote = selection?.quote ? normalizeSpace(selection.quote).slice(0, quotePrefixLength) : undefined
  return {
    paperId,
    attachmentId: selection?.attachmentId,
    pageIndex: selection?.pageIndex,
    htmlSelector: selection?.htmlSelector?.trim() || undefined,
    quotePrefix: quote || undefined
  }
}

const unencoded = /[A-Za-z0-9\-._~:/]/

function encodeQueryValue(value: string): string {
  let result = ''
  for (const character of value) {
    if (unencoded.test(character)) result += character
    else result += [...new TextEncoder().encode(character)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  }
  return result
}

export function citationDestination(citation: PaperCitation): string {
  let destination = `${citationScheme}://paper/${citation.paperId.toUpperCase()}`
  const query: string[] = []
  if (citation.attachmentId) query.push(`att=${citation.attachmentId.toUpperCase()}`)
  if (citation.pageIndex !== undefined) query.push(`p=${citation.pageIndex + 1}`)
  if (citation.htmlSelector) query.push(`anchor=${encodeQueryValue(citation.htmlSelector)}`)
  if (query.length) destination += `?${query.join('&')}`
  return destination
}

export function parseCitation(destination: string, title?: string): PaperCitation | undefined {
  let text = destination.trim()
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1)
  const prefix = `${citationScheme}://paper/`
  if (!text.toLowerCase().startsWith(prefix)) return undefined
  const rest = text.slice(prefix.length)
  const pathEnd = rest.search(/[?#]/)
  const id = (pathEnd >= 0 ? rest.slice(0, pathEnd) : rest)
  if (!new RegExp(`^${uuidPattern}$`).test(id)) return undefined
  const citation: PaperCitation = { paperId: id.toLowerCase() }
  if (pathEnd >= 0 && rest[pathEnd] === '?') {
    const query = rest.slice(pathEnd + 1).split('#')[0]
    for (const pair of query.split('&')) {
      const [key, raw] = pair.split('=', 2)
      if (raw === undefined) continue
      let value = raw
      try {
        value = decodeURIComponent(raw)
      } catch {
        // Keep the raw value.
      }
      if (key === 'att' && new RegExp(`^${uuidPattern}$`).test(value)) citation.attachmentId = value.toLowerCase()
      if (key === 'p' && Number(value) >= 1) citation.pageIndex = Number(value) - 1
      if (key === 'anchor' && value.trim()) citation.htmlSelector = value
      if (key === 'q' && value.trim()) citation.quotePrefix = value
    }
  }
  if (title?.trim()) citation.quotePrefix = normalizeSpace(title).slice(0, quotePrefixLength)
  return citation
}

function escapeLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1')
}

function escapeLinkTitle(value: string): string {
  return value.replace(/(["\\])/g, '\\$1')
}

export function escapeInlineMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]<>#|])/g, '\\$1')
}

export function inlineCitationMarkdown(label: string, citation: PaperCitation): string {
  let target = citationDestination(citation)
  if (citation.quotePrefix) target += ` "${escapeLinkTitle(citation.quotePrefix)}"`
  return `[${escapeLinkLabel(label)}](${target})`
}

/** A block quote of `quote` followed by its citation line. */
export function quoteCitationMarkdown(quote: string, label: string, citation: PaperCitation): string {
  const body = quote.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ')
  return `> ${body}\n>\n> — ${inlineCitationMarkdown(label, citation)}`
}

const containsCJK = (value: string): boolean => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(value)

function familyName(author: string): string {
  const name = author.trim()
  const comma = name.indexOf(',')
  if (comma >= 0) return name.slice(0, comma).trim()
  if (containsCJK(name)) return name.replace(/\s+/g, '')
  return name.split(/\s+/).pop() ?? name
}

/** A short author–year label such as "Vaswani et al., 2017, p. 2". */
export function citationLabel(authors: string[], title: string, year: number | undefined, pageIndex: number | undefined): string {
  const names = authors.map(familyName).filter(Boolean)
  const parts: string[] = []
  if (names.length === 1) parts.push(names[0])
  else if (names.length === 2) parts.push(`${names[0]} & ${names[1]}`)
  else if (names.length > 2) parts.push(containsCJK(names[0]) ? `${names[0]}等` : `${names[0]} et al.`)
  else {
    const normalized = normalizeSpace(title)
    if (normalized) parts.push(normalized.length > 32 ? `${normalized.slice(0, 32)}…` : normalized)
  }
  if (year !== undefined) parts.push(String(year))
  if (pageIndex !== undefined) parts.push(`p. ${pageIndex + 1}`)
  return parts.join(', ')
}

export function citationsIn(markdown: string): PaperCitation[] {
  const results: PaperCitation[] = []
  const linkExpression = /\[(?:[^\]\\]|\\.)*\]\(\s*(<?readpaper:\/\/[^)\s>]+>?)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)/gi
  const seenIndices = new Set<number>()
  for (const match of markdown.matchAll(linkExpression)) {
    const citation = parseCitation(match[1], match[2]?.replace(/\\(.)/g, '$1'))
    if (citation) {
      results.push(citation)
      seenIndices.add((match.index ?? 0) + match[0].indexOf(match[1]))
    }
  }
  for (const match of markdown.matchAll(citationExpression)) {
    if (seenIndices.has(match.index ?? -1)) continue
    const citation = parseCitation(match[0])
    if (citation) results.push(citation)
  }
  return results
}

export function citedPaperIds(markdown: string): string[] {
  const seen = new Set<string>()
  return citationsIn(markdown).map((citation) => citation.paperId).filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const maximumTitleLength = 80

function visibleLineText(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\\([\\`*_{}[\]<>#|])/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

/** The text of the first line that has any, without its Markdown syntax. */
export function deriveWritingTitle(markdown: string): string {
  let inFence = false
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence || !raw.trim() || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue
    const title = visibleLineText(raw)
    if (title) return title.length > maximumTitleLength ? `${title.slice(0, maximumTitleLength)}…` : title
  }
  return ''
}

/**
 * Renames a writing by editing the line its title comes from: a heading keeps its level and
 * gets the new text; otherwise a `# title` heading goes on top.
 */
export function renameWriting(markdown: string, newTitle: string): string | undefined {
  const title = normalizeSpace(newTitle)
  if (!title || title === deriveWritingTitle(markdown)) return undefined
  const content = escapeInlineMarkdown(title)
  const lines = markdown.split('\n')
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence || !raw.trim() || !visibleLineText(raw)) continue
    const heading = raw.match(/^(\s{0,3}#{1,6})\s+/)
    if (heading) lines[index] = `${heading[1]} ${content}`
    else lines.splice(index, 0, `# ${content}`, '')
    return lines.join('\n')
  }
  return `# ${content}\n\n${markdown}`
}

/** Every CJK character plus every run of other letters and digits; link targets are left out. */
export function wordCount(markdown: string): number {
  const text = markdown.replace(/\]\([^)\s]*(?:\s+"(?:[^"\\]|\\.)*")?\)/g, ']')
  let count = 0
  let inWord = false
  for (const character of text) {
    if (containsCJK(character)) {
      count += 1
      inWord = false
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      if (!inWord) count += 1
      inWord = true
    } else if (inWord && (character === "'" || character === '\u2019')) {
      continue
    } else {
      inWord = false
    }
  }
  return count
}

export function citationRecords(markdown: string): WritingCitationRecord[] {
  return citationsIn(markdown)
}
