import type { Note, Paper } from './types'
import type { Translator } from './i18n'
import { displayAuthors, metadataIdentifierText } from './library'

export const defaultDigestTemplate = `+++
date = '{{dateISO}}'
draft = false
title = '{{title}}'
slug = '{{slug}}'
+++

# {{title}}

{{metadataBlock}}

{{abstractBlock}}

{{notesBlock}}

*{{generatedBy}}*`

export const digestPlaceholders = [
  '{{dateISO}}',
  '{{title}}',
  '{{slug}}',
  '{{authors}}',
  '{{identifier}}',
  '{{sourceTitle}}',
  '{{sourceURL}}',
  '{{metadataBlock}}',
  '{{abstractBlock}}',
  '{{notesBlock}}',
  '{{generatedBy}}'
]

export interface DigestContent {
  title: string
  authors: string
  sourceTitle?: string
  sourceURL?: string
  identifier?: string
  abstract?: string
  notes: Array<{ body: string; quote?: string; pageIndex?: number; modifiedAt: string }>
  exportDate: Date
}

const normalizeRequired = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ')
const normalizeOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function sourceMetadata(paper: Paper): { title?: string; url?: string } {
  if (paper.arxivId?.trim()) return { title: `arXiv ${paper.arxivId}`, url: `https://arxiv.org/abs/${paper.arxivId}` }
  if (paper.doi?.trim()) return { title: `DOI ${paper.doi}`, url: `https://doi.org/${paper.doi}` }
  if (paper.htmlUrl?.trim()) return { title: paper.htmlUrl, url: paper.htmlUrl }
  if (paper.pdfUrl?.trim()) return { title: paper.pdfUrl, url: paper.pdfUrl }
  return {}
}

export function makeDigestContent(paper: Paper, notes: Note[], t: Translator, exportDate = new Date()): DigestContent | undefined {
  const title = normalizeRequired(paper.title)
  if (!title) return undefined
  const source = sourceMetadata(paper)
  return {
    title,
    authors: normalizeRequired(displayAuthors(paper, t)),
    sourceTitle: source.title,
    sourceURL: source.url,
    identifier: normalizeOptional(metadataIdentifierText(paper, t)),
    abstract: normalizeOptional(paper.abstract),
    notes: notes
      .map((note) => ({ body: note.body.trim(), quote: normalizeOptional(note.quote), pageIndex: note.pageIndex, modifiedAt: note.modifiedAt }))
      .filter((note) => note.body)
      .sort((lhs, rhs) => lhs.modifiedAt === rhs.modifiedAt ? lhs.body.localeCompare(rhs.body) : lhs.modifiedAt.localeCompare(rhs.modifiedAt)),
    exportDate
  }
}

function blockquote(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line.trim()}`).join('\n')
}

function formatNoteDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function digestSlug(title: string): string {
  const normalized = normalizeRequired(title)
  if (!normalized) return 'paper-digest'
  let slug = ''
  let previousWasHyphen = false
  for (const character of normalized) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      slug += /[A-Za-z]/.test(character) ? character.toLowerCase() : character
      previousWasHyphen = false
    } else if (/[\s\-_/+:.|]/.test(character) && !previousWasHyphen && slug) {
      slug += '-'
      previousWasHyphen = true
    }
  }
  slug = slug.replace(/^-+|-+$/g, '')
  if ([...slug].length > 90) slug = [...slug].slice(0, 90).join('').replace(/^-+|-+$/g, '')
  return slug || 'paper-digest'
}

export function digestFileName(title: string, exportDate = new Date()): string {
  const date = `${exportDate.getFullYear()}-${String(exportDate.getMonth() + 1).padStart(2, '0')}-${String(exportDate.getDate()).padStart(2, '0')}`
  return `${date}-${digestSlug(title)}.md`
}

export function normalizeMarkdownLayout(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

function isoString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function tomlEscaped(value: string): string {
  return value.replace(/'/g, '’')
}

function metadataBlock(content: DigestContent, t: Translator): string {
  const lines: string[] = []
  if (content.sourceTitle && content.sourceURL) lines.push(`**${t('Source')}**: [${content.sourceTitle}](${content.sourceURL})`)
  if (content.authors) lines.push(`**${t('Authors')}**: ${content.authors}`)
  if (content.identifier) lines.push(`**${t('Identifier')}**: ${content.identifier}`)
  return lines.join('\n')
}

function abstractBlock(content: DigestContent, t: Translator): string {
  return content.abstract ? [`## ${t('Abstract')}`, '', blockquote(content.abstract)].join('\n') : ''
}

function notesBlock(content: DigestContent, t: Translator, locale: string): string {
  if (!content.notes.length) return ''
  const lines = [`## ${t('Notes')}`, '']
  for (const note of content.notes) {
    lines.push(`### ${formatNoteDate(note.modifiedAt, locale)}`)
    if (note.pageIndex !== undefined) lines.push('', `**${t('Page')}**: ${note.pageIndex + 1}`)
    if (note.quote) lines.push('', blockquote(note.quote))
    lines.push('', note.body, '')
  }
  return normalizeMarkdownLayout(lines.join('\n'))
}

export function makeDigestMarkdown(content: DigestContent, t: Translator, locale: string, template?: string): string {
  const effective = template?.trim() ? template : defaultDigestTemplate
  const values: Record<string, string> = {
    '{{dateISO}}': isoString(content.exportDate),
    '{{title}}': effective === defaultDigestTemplate ? tomlEscaped(content.title) : content.title,
    '{{slug}}': digestSlug(content.title),
    '{{authors}}': content.authors,
    '{{identifier}}': content.identifier ?? '',
    '{{sourceTitle}}': content.sourceTitle ?? '',
    '{{sourceURL}}': content.sourceURL ?? '',
    '{{metadataBlock}}': metadataBlock(content, t),
    '{{abstractBlock}}': abstractBlock(content, t),
    '{{notesBlock}}': notesBlock(content, t, locale),
    '{{generatedBy}}': t('Generated by Freddie')
  }
  let rendered = effective
  for (const [token, value] of Object.entries(values)) rendered = rendered.split(token).join(value)
  if (effective === defaultDigestTemplate) rendered = rendered.replace(`# ${values['{{title}}']}`, `# ${content.title}`)
  return normalizeMarkdownLayout(rendered)
}
