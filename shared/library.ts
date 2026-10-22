import type { Attachment, Folder, FolderMembership, ItemTypeAssignment, Paper, ReaderMode } from './types'
import type { Translator } from './i18n'

/** Bibliographic item types, keyed by Zotero's identifiers, with their English titles. */
export const itemTypeTitles: Record<string, string> = {
  artwork: 'Artwork',
  audioRecording: 'Audio Recording',
  bill: 'Bill',
  blogPost: 'Blog Post',
  book: 'Book',
  bookSection: 'Book Section',
  case: 'Case',
  computerProgram: 'Software',
  conferencePaper: 'Conference Paper',
  dataset: 'Dataset',
  dictionaryEntry: 'Dictionary Entry',
  document: 'Document',
  email: 'E-mail',
  encyclopediaArticle: 'Encyclopedia Article',
  film: 'Film',
  forumPost: 'Forum Post',
  hearing: 'Hearing',
  instantMessage: 'Instant Message',
  interview: 'Interview',
  journalArticle: 'Journal Article',
  letter: 'Letter',
  magazineArticle: 'Magazine Article',
  manuscript: 'Manuscript',
  map: 'Map',
  newspaperArticle: 'Newspaper Article',
  patent: 'Patent',
  podcast: 'Podcast',
  preprint: 'Preprint',
  presentation: 'Presentation',
  radioBroadcast: 'Radio Broadcast',
  report: 'Report',
  standard: 'Standard',
  statute: 'Statute',
  thesis: 'Thesis',
  tvBroadcast: 'TV Broadcast',
  videoRecording: 'Video Recording',
  webpage: 'Web Page'
}

/** Listed first in the type picker; the rest go under "More Types". */
export const commonItemTypes = [
  'journalArticle',
  'conferencePaper',
  'preprint',
  'thesis',
  'book',
  'bookSection',
  'report',
  'webpage',
  'document'
]

export function itemTypeTitle(itemType: string, t: Translator): string {
  return t(itemTypeTitles[itemType] ?? 'Document')
}

export function sortedItemTypes(itemTypes: Iterable<string>, t: Translator): Array<{ itemType: string; title: string }> {
  return [...itemTypes]
    .map((itemType) => ({ itemType, title: itemTypeTitle(itemType, t) }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
}

export interface ItemTypeResolution {
  itemType(paperId: string): string
  detectedType(paperId: string): string
  isAssigned(paperId: string): boolean
}

/**
 * arXiv papers are preprints and HTML web imports are web pages. Anything else,
 * including a PDF with a DOI, stays a generic document.
 */
export function resolveItemTypes(papers: Paper[], attachments: Attachment[], assignments: ItemTypeAssignment[]): ItemTypeResolution {
  const webPagePaperIds = new Set(attachments.filter((item) => item.source === 'webPage' && item.kind === 'html').map((item) => item.paperId))
  const detected = new Map<string, string>()
  for (const paper of papers) {
    detected.set(paper.id, paper.arxivId ? 'preprint' : webPagePaperIds.has(paper.id) ? 'webpage' : 'document')
  }
  const assigned = new Map<string, string>()
  for (const assignment of assignments) {
    if (itemTypeTitles[assignment.itemType]) assigned.set(assignment.paperId, assignment.itemType)
  }
  return {
    itemType: (paperId) => assigned.get(paperId) ?? detected.get(paperId) ?? 'document',
    detectedType: (paperId) => detected.get(paperId) ?? 'document',
    isAssigned: (paperId) => assigned.has(paperId)
  }
}

export interface FolderSection {
  folder: Folder
  papers: Paper[]
}

export interface LibraryGrouping {
  folderSections: FolderSection[]
  unfiledPapers: Paper[]
  folderIdByPaperId: Map<string, string>
}

/** Paper order within each group follows `papers`; folders sort by name. */
export function groupLibrary(papers: Paper[], folders: Folder[], memberships: FolderMembership[]): LibraryGrouping {
  const sortedFolders = [...folders].sort((lhs, rhs) => {
    const order = lhs.name.localeCompare(rhs.name, undefined, { numeric: true, sensitivity: 'base' })
    return order !== 0 ? order : lhs.createdAt.localeCompare(rhs.createdAt)
  })
  const known = new Set(sortedFolders.map((folder) => folder.id))
  const folderIdByPaperId = new Map<string, string>()
  for (const membership of memberships) {
    if (known.has(membership.folderId)) folderIdByPaperId.set(membership.paperId, membership.folderId)
  }
  const papersByFolder = new Map<string, Paper[]>()
  const unfiledPapers: Paper[] = []
  for (const paper of papers) {
    const folderId = folderIdByPaperId.get(paper.id)
    if (folderId) papersByFolder.set(folderId, [...(papersByFolder.get(folderId) ?? []), paper])
    else unfiledPapers.push(paper)
  }
  return {
    folderSections: sortedFolders.map((folder) => ({ folder, papers: papersByFolder.get(folder.id) ?? [] })),
    unfiledPapers,
    folderIdByPaperId
  }
}

export function filterGrouping(grouping: LibraryGrouping, isVisible: (paper: Paper) => boolean): LibraryGrouping {
  return {
    folderSections: grouping.folderSections.map((section) => ({ folder: section.folder, papers: section.papers.filter(isVisible) })),
    unfiledPapers: grouping.unfiledPapers.filter(isVisible),
    folderIdByPaperId: grouping.folderIdByPaperId
  }
}

export function orderedPaperIds(grouping: LibraryGrouping): string[] {
  return [...grouping.folderSections.flatMap((section) => section.papers.map((paper) => paper.id)), ...grouping.unfiledPapers.map((paper) => paper.id)]
}

export type FilterCriterion = 'favorites' | 'translated' | 'notes'

export interface LibraryFilter {
  criteria: FilterCriterion[]
  itemTypes: string[]
}

export const emptyFilter: LibraryFilter = { criteria: [], itemTypes: [] }

export function isFilterActive(filter: LibraryFilter): boolean {
  return filter.criteria.length > 0 || filter.itemTypes.length > 0
}

export interface FilterFacts {
  translatedPaperIds: Set<string>
  notedPaperIds: Set<string>
  itemTypes: ItemTypeResolution
}

/** A paper must meet every selected criterion and be one of the selected item types, if any. */
export function matchesFilter(paper: Paper, filter: LibraryFilter, facts: FilterFacts): boolean {
  if (filter.itemTypes.length > 0 && !filter.itemTypes.includes(facts.itemTypes.itemType(paper.id))) return false
  return filter.criteria.every((criterion) => {
    if (criterion === 'favorites') return paper.isFavorite
    if (criterion === 'translated') return facts.translatedPaperIds.has(paper.id)
    return facts.notedPaperIds.has(paper.id)
  })
}

export function displayAuthors(paper: Pick<Paper, 'authors'>, t: Translator): string {
  const names = paper.authors
  if (names.length === 0) return t('Unknown authors')
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} et al.`
}

export function sidebarIdentifierText(paper: Paper, t: Translator): string | undefined {
  if (paper.arxivId) return t('arXiv %@', paper.arxivId)
  if (paper.doi) return t('DOI %@', paper.doi)
  return undefined
}

export function metadataIdentifierText(paper: Paper, t: Translator): string | undefined {
  if (paper.arxivId) return t('arXiv: %@', paper.arxivId)
  if (paper.doi) return t('DOI: %@', paper.doi)
  return undefined
}

export function editableAuthorsText(authors: string[]): string {
  return authors.map((author) => author.trim()).filter(Boolean).join(', ')
}

export function decodeEditableAuthors(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/[\n,，;；]/)
    .map((author) => author.trim())
    .filter(Boolean)
}

export function resolvedReaderMode(preferred: ReaderMode | undefined, hasHTML: boolean, hasPDF: boolean, hasTranslatedPDF: boolean): ReaderMode {
  if (preferred && supportsReaderMode(preferred, hasHTML, hasPDF, hasTranslatedPDF)) return preferred
  if (hasPDF) return 'pdf'
  if (hasHTML) return 'html'
  if (hasTranslatedPDF) return 'translatedPDF'
  return 'pdf'
}

function supportsReaderMode(mode: ReaderMode, hasHTML: boolean, hasPDF: boolean, hasTranslatedPDF: boolean): boolean {
  if (mode === 'html') return hasHTML
  if (mode === 'pdf') return hasPDF
  if (mode === 'bilingualPDF') return hasPDF && hasTranslatedPDF
  return hasTranslatedPDF
}

/** The newest attachment of a kind, as the native reader picks them. */
export function latestAttachment(attachments: Attachment[], kind: Attachment['kind']): Attachment | undefined {
  return attachments.filter((item) => item.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

export function firstAttachment(attachments: Attachment[], kind: Attachment['kind']): Attachment | undefined {
  return attachments.filter((item) => item.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

export function isPartialTranslation(attachment: Attachment | undefined, originalPageCount: number | undefined): boolean {
  if (!attachment?.translatedLastPage || !originalPageCount) return false
  return attachment.translatedLastPage < originalPageCount
}
