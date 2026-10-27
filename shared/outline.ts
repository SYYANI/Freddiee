/** Reader sidecar metadata; destinations always refer to the original PDF. */
export const outlineSources = ['pdf', 'repairedPDF', 'latex', 'scan', 'automatic', 'ai', 'html'] as const
export type DocumentOutlineSource = typeof outlineSources[number]

export const outlineSourceTitles: Record<DocumentOutlineSource, string> = {
  pdf: 'Embedded PDF', repairedPDF: 'Embedded PDF (repaired)', latex: 'From LaTeX source',
  scan: 'From scan reconstruction', automatic: 'Automatically generated', ai: 'Organized with AI', html: 'HTML headings'
}

export interface DocumentOutlineEntry {
  id: string
  title: string
  level: number
  pageIndex?: number
  fraction?: number
  anchor?: string
  translation?: string
}

export interface DocumentOutlineCache {
  algorithmVersion: number
  fingerprint: string
  selectedSource?: DocumentOutlineSource
  userSelectedSource?: DocumentOutlineSource
  variants: Array<{ source: DocumentOutlineSource; entries: DocumentOutlineEntry[] }>
  candidates: DocumentOutlineEntry[]
  deferredCandidates?: boolean
}

export function currentOutlineID(entries: DocumentOutlineEntry[], page: number, fraction = 1): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.pageIndex !== undefined && (entry.pageIndex < page ||
      (entry.pageIndex === page && (entry.fraction ?? 0) <= fraction + 0.025))) return entry.id
  }
  return undefined
}

export function isUntranslatedHeading(entry: DocumentOutlineEntry, lastPage?: number): boolean {
  return lastPage !== undefined && entry.pageIndex !== undefined && entry.pageIndex >= lastPage
}

export function visibleOutlineEntries(entries: DocumentOutlineEntry[], expanded: ReadonlySet<string>, filter: string): DocumentOutlineEntry[] {
  const query = filter.trim().toLocaleLowerCase()
  if (query) return entries.filter((entry) => `${entry.title}\n${entry.translation ?? ''}`.toLocaleLowerCase().includes(query))
  let hiddenBelow: number | undefined
  return entries.filter((entry, index) => {
    if (hiddenBelow !== undefined && entry.level > hiddenBelow) return false
    hiddenBelow = undefined
    if (entries[index + 1]?.level > entry.level && !expanded.has(entry.id)) hiddenBelow = entry.level
    return true
  })
}

export function outlineAncestors(entries: DocumentOutlineEntry[], id?: string): string[] {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return []
  let level = entries[index].level
  const result: string[] = []
  for (let i = index - 1; i >= 0; i -= 1) {
    if (entries[i].level < level) { result.push(entries[i].id); level = entries[i].level }
  }
  return result
}
