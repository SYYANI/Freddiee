import { describe, expect, it } from 'vitest'
import { extractArxivIdentifier, extractDOI, fallbackWebPageTitle, normalizeArxivIdentifier, normalizeWebPageURL } from '../shared/identifiers'
import { citationDestination, citationLabel, citationsIn, citedPaperIds, deriveWritingTitle, inlineCitationMarkdown, parseCitation, quoteCitationMarkdown, renameWriting, wordCount } from '../shared/writing'
import { digestSlug, makeDigestContent, makeDigestMarkdown } from '../shared/digest'
import { createTranslator, formatString, resolveLanguage } from '../shared/i18n'
import { filterGrouping, groupLibrary, matchesFilter, orderedPaperIds, resolveItemTypes, resolvedReaderMode, decodeEditableAuthors, displayAuthors } from '../shared/library'
import { insertCitationText } from '../src/writing/writingBus'
import type { Paper } from '../shared/types'

const t = createTranslator('en')
const timestamp = '2026-01-01T00:00:00.000Z'
const paper = (id: string, patch: Partial<Paper> = {}): Paper => ({ id, title: id, abstract: '', authors: [], categories: [], tags: [], isFavorite: false, createdAt: timestamp, modifiedAt: timestamp, ...patch })

describe('arXiv and web identifiers', () => {
  it('normalizes IDs and URLs', () => {
    expect(normalizeArxivIdentifier('2303.08774')).toEqual({ baseId: '2303.08774' })
    expect(normalizeArxivIdentifier('arXiv:2303.08774v2')).toEqual({ baseId: '2303.08774', version: 'v2' })
    expect(normalizeArxivIdentifier('https://arxiv.org/pdf/2303.08774v1.pdf')).toEqual({ baseId: '2303.08774', version: 'v1' })
    expect(normalizeArxivIdentifier('https://ar5iv.labs.arxiv.org/html/hep-th/9901001')).toEqual({ baseId: 'hep-th/9901001' })
    expect(() => normalizeArxivIdentifier('10.1145/3290605')).toThrow()
  })

  it('only extracts arXiv IDs with explicit arXiv context', () => {
    expect(extractArxivIdentifier('see arXiv:2303.08774 for details')?.baseId).toBe('2303.08774')
    expect(extractArxivIdentifier('https://arxiv.org/abs/2401.00001')?.baseId).toBe('2401.00001')
    expect(extractArxivIdentifier('doi 10.2303.08774 and 2303.08774 alone')).toBeUndefined()
  })

  it('extracts DOIs across line breaks', () => {
    expect(extractDOI('https://doi.org/10.1145/ 3290605.3300233')).toBe('10.1145/3290605.3300233')
    expect(extractDOI('no identifier')).toBeUndefined()
  })

  it('normalizes web URLs and derives fallback titles', () => {
    expect(normalizeWebPageURL('example.com/a#b').toString()).toBe('https://example.com/a')
    expect(() => normalizeWebPageURL('ftp://example.com')).toThrow('unsupportedScheme')
    expect(fallbackWebPageTitle(new URL('https://x.org/my-great-paper.html'), 'Untitled')).toBe('my great paper')
    expect(fallbackWebPageTitle(new URL('https://x.org/'), 'Untitled')).toBe('x.org')
  })
})

describe('writing citations', () => {
  const id = '9f0f79e3-f2ad-4dd5-a5d9-dc82ba1d413d'

  it('round-trips the native readpaper:// link format', () => {
    const citation = { paperId: id, pageIndex: 2, htmlSelector: 'rp-path:0/1 2', quotePrefix: 'The key result' }
    const destination = citationDestination(citation)
    expect(destination).toBe('readpaper://paper/9F0F79E3-F2AD-4DD5-A5D9-DC82BA1D413D?p=3&anchor=rp-path:0/1%202')
    expect(parseCitation(destination, 'The key result')).toEqual(citation)
  })

  it('finds citations and cited papers in Markdown', () => {
    const markdown = `${quoteCitationMarkdown('A quote', 'Smith, 2020', { paperId: id, quotePrefix: 'A "quote"' })}\n\nAgain ${inlineCitationMarkdown('Smith', { paperId: id })}`
    expect(citationsIn(markdown)).toHaveLength(2)
    expect(citedPaperIds(markdown)).toEqual([id])
    expect(citationsIn(markdown)[0].quotePrefix).toBe('A "quote"')
  })

  it('labels citations by author and year', () => {
    expect(citationLabel(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], 'Attention', 2017, 1)).toBe('Vaswani et al., 2017, p. 2')
    expect(citationLabel(['张三', '李四', '王五'], 'T', 2024, undefined)).toBe('张三等, 2024')
    expect(citationLabel([], 'A very long title that keeps on going for a while', undefined, undefined)).toBe('A very long title that keeps on …')
  })

  it('derives titles, counts words, and renames', () => {
    expect(deriveWritingTitle('\n\n## **Hello** [world](https://x)\nbody')).toBe('Hello world')
    expect(deriveWritingTitle('```\ncode\n```\ntext')).toBe('text')
    expect(wordCount('Hello world 你好 [link](https://example.com/a-b-c)')).toBe(5)
    expect(renameWriting('## Old\n\ntext', 'New title')).toBe('## New title\n\ntext')
    expect(renameWriting('plain first line', 'Named')).toBe('# Named\n\nplain first line')
  })

  it('inserts a quote citation as its own paragraph', () => {
    expect(insertCitationText('First line\nSecond', '> quote', 3).text).toBe('First line\n\n> quote\n\nSecond')
    expect(insertCitationText('Text', '[cite](readpaper://x)', 4).text).toBe('Text [cite](readpaper://x)')
  })
})

describe('digest', () => {
  it('makes slugs and Markdown from the template', () => {
    expect(digestSlug('Attention Is All You Need: A/B')).toBe('attention-is-all-you-need-a-b')
    expect(digestSlug('   ')).toBe('paper-digest')
    const content = makeDigestContent(paper('p', { title: 'A Paper', arxivId: '2303.08774', authors: ['Ada'], abstract: 'Line one' }), [
      { id: 'n', paperId: 'p', quote: 'q', body: 'Note body', pageIndex: 1, createdAt: timestamp, modifiedAt: timestamp }
    ], t, new Date(timestamp))!
    const markdown = makeDigestMarkdown(content, t, 'en-US')
    expect(markdown).toContain("title = 'A Paper'")
    expect(markdown).toContain('**Source**: [arXiv 2303.08774](https://arxiv.org/abs/2303.08774)')
    expect(markdown).toContain('## Abstract\n\n> Line one')
    expect(markdown).toContain('**Page**: 2')
    expect(markdown.endsWith('*Generated by Freddie*')).toBe(true)
    expect(makeDigestMarkdown(content, t, 'en-US', '{{title}} by {{authors}}')).toBe('A Paper by Ada')
  })
})

describe('localization', () => {
  it('formats Foundation specifiers', () => {
    expect(formatString('%1$lld of %2$lld', [3, 10])).toBe('3 of 10')
    expect(formatString('%@ and %d%%', ['a', 5])).toBe('a and 5%')
  })

  it('uses the native catalog for Simplified Chinese', () => {
    const zh = createTranslator('zh-Hans')
    expect(zh('Add Paper')).toBe('添加论文')
    expect(zh('Step %d of %d', 2, 5)).toBe('第 2/5 步')
    expect(zh('A string the catalog does not have')).toBe('A string the catalog does not have')
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh-Hans')
    expect(resolveLanguage('en', 'zh-CN')).toBe('en')
  })
})

describe('library', () => {
  it('groups by folder name and keeps paper order', () => {
    const papers = [paper('a'), paper('b'), paper('c')]
    const folders = [
      { id: 'f2', name: 'Zeta', createdAt: timestamp, modifiedAt: timestamp },
      { id: 'f1', name: 'alpha', createdAt: timestamp, modifiedAt: timestamp }
    ]
    const grouping = groupLibrary(papers, folders, [{ paperId: 'c', folderId: 'f1', addedAt: timestamp }, { paperId: 'a', folderId: 'missing', addedAt: timestamp }])
    expect(grouping.folderSections.map((section) => section.folder.name)).toEqual(['alpha', 'Zeta'])
    expect(orderedPaperIds(grouping)).toEqual(['c', 'a', 'b'])
    expect(orderedPaperIds(filterGrouping(grouping, (item) => item.id !== 'a'))).toEqual(['c', 'b'])
  })

  it('detects item types and filters by criteria', () => {
    const papers = [paper('arxiv', { arxivId: '1', isFavorite: true }), paper('web'), paper('pdf')]
    const types = resolveItemTypes(papers, [{ id: 'x', paperId: 'web', kind: 'html', source: 'webPage', filename: 'paper.html', createdAt: timestamp }], [{ paperId: 'pdf', itemType: 'thesis', assignedAt: timestamp }])
    expect(['arxiv', 'web', 'pdf'].map((id) => types.itemType(id))).toEqual(['preprint', 'webpage', 'thesis'])
    expect(types.detectedType('pdf')).toBe('document')
    const facts = { translatedPaperIds: new Set(['web']), notedPaperIds: new Set<string>(), itemTypes: types }
    expect(papers.filter((item) => matchesFilter(item, { criteria: ['favorites'], itemTypes: [] }, facts)).map((item) => item.id)).toEqual(['arxiv'])
    expect(papers.filter((item) => matchesFilter(item, { criteria: ['translated'], itemTypes: ['webpage'] }, facts)).map((item) => item.id)).toEqual(['web'])
  })

  it('resolves the reader mode against available attachments', () => {
    expect(resolvedReaderMode('bilingualPDF', true, true, false)).toBe('pdf')
    expect(resolvedReaderMode('html', true, false, false)).toBe('html')
    expect(resolvedReaderMode(undefined, true, false, false)).toBe('html')
    expect(resolvedReaderMode('translatedPDF', false, false, true)).toBe('translatedPDF')
  })

  it('edits authors like the native inspector', () => {
    expect(decodeEditableAuthors('Ada Lovelace, Alan Turing；张三\nGrace')).toEqual(['Ada Lovelace', 'Alan Turing', '张三', 'Grace'])
    expect(displayAuthors({ authors: ['A', 'B', 'C', 'D'] }, t)).toBe('A, B, C et al.')
    expect(displayAuthors({ authors: [] }, t)).toBe('Unknown authors')
  })
})
