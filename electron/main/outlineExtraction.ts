import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import type { DocumentOutlineEntry } from '../../shared/outline'

export interface OutlineLine {
  title: string
  size: number
  bold: boolean
  fraction: number
  offset: number
  /** Transient character weights for the optional font pass; never persisted. */
  fontWeights?: Record<string, number>
}
export interface OutlinePage { lines: OutlineLine[]; text: string }
export const cleanHeading = (text: string): string => text.replace(/\s+/gu, ' ').trim()
const normalize = (text: string): string => cleanHeading(text.normalize('NFKC').replace(/\u00ad/g, '')).toLocaleLowerCase()
export const meaningfulHeading = (text: string): boolean => {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  return letters >= 2 && letters / Math.max(1, text.length) > 0.25 && !/\\376\\377|�|[\u0000-\u001f]/u.test(text)
}
const junk = (text: string): boolean => /^(cover|front matter|title page|figure\s*\d+|table\s*\d+)\b/i.test(text)
const numbering = /^\s*(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s+/
const strippingNumber = (title: string): string => title.replace(numbering, '')
const sectionNumber = /^(?:(?:section|chapter|appendix|part)\s+)?(?:\d+(?:\.\d+)*|[A-Z]|[IVXLCDM]+)\.?$|^第[0-9一二三四五六七八九十百]+[章节部分篇]$/i

/** Whole heading lines win over mentions in prose, including wrapped titles. */
export function headingLocations(title: string, page: OutlinePage): OutlineLine[] {
  const titles = [...new Set([title, strippingNumber(title)].map(normalize))].filter(Boolean)
  return page.lines.filter((line, index) => {
    for (let count = 1; count <= 3 && index + count <= page.lines.length; count += 1) {
      const text = normalize(page.lines.slice(index, index + count).map((item) => item.title).join(' '))
      for (const target of titles) {
        const start = text.indexOf(target)
        if (start < 0) continue
        const prefix = text.slice(0, start).trim()
        const suffix = text.slice(start + target.length).trim()
        if ((!prefix || sectionNumber.test(prefix)) && /^[.:：。]*$/u.test(suffix)) return true
      }
    }
    return false
  })
}

export function matchedHeadingPage(title: string, target: number, pages: OutlinePage[], preferredOffset = 0): number | undefined {
  const candidates = [...new Set([preferredOffset, 0, -1, 1, -2, 2].map((delta) => target + delta))].filter((index) => index >= 0 && index < pages.length)
  const heading = candidates.find((index) => headingLocations(title, pages[index]).length > 0)
  if (heading !== undefined) return heading
  const expected = target + preferredOffset
  const text = pages[expected]?.text
  return text && [title, strippingNumber(title)].some((value) => normalize(text).includes(normalize(value))) ? expected : undefined
}

export function withHeadingLocations(entries: DocumentOutlineEntry[], pages: OutlinePage[]): DocumentOutlineEntry[] {
  return entries.map((entry) => {
    if (entry.fraction !== undefined || entry.pageIndex === undefined || !pages[entry.pageIndex]) return entry
    const line = headingLocations(entry.title, pages[entry.pageIndex])[0]
    return line ? { ...entry, fraction: line.fraction } : entry
  })
}

export function assessOutline(entries: DocumentOutlineEntry[], pages: OutlinePage[]): { isGood: boolean; repaired: DocumentOutlineEntry[] } {
  if (entries.length < 2 || !pages.length) return { isGood: false, repaired: [] }
  const usable = entries.filter((entry) => entry.pageIndex !== undefined && pages[entry.pageIndex] && meaningfulHeading(entry.title) && !junk(entry.title))
  const offsets = new Map<number, number>()
  for (const entry of usable) {
    const found = matchedHeadingPage(entry.title, entry.pageIndex!, pages)
    if (found !== undefined) { const offset = found - entry.pageIndex!; offsets.set(offset, (offsets.get(offset) ?? 0) + 1) }
  }
  const common = [...offsets].sort((a, b) => b[1] - a[1])[0]
  const offset = common && common[1] / Math.max(1, usable.length) >= 0.65 ? common[0] : 0
  let matched = 0
  const kept = new Map<string, DocumentOutlineEntry>()
  for (const entry of usable) {
    const found = matchedHeadingPage(entry.title, entry.pageIndex!, pages, offset)
    if (found !== undefined) {
      matched += 1
      kept.set(entry.id, found === entry.pageIndex ? entry : { ...entry, pageIndex: found, fraction: undefined })
    } else if (!pages[entry.pageIndex!].text.trim()) kept.set(entry.id, entry)
  }
  const repaired = entries.flatMap((entry, index) => {
    if (kept.has(entry.id)) return [kept.get(entry.id)!]
    if (entry.pageIndex !== undefined || !meaningfulHeading(entry.title) || junk(entry.title)) return []
    for (let i = index + 1; i < entries.length && entries[i].level > entry.level; i += 1) {
      if (kept.has(entries[i].id)) return [entry]
    }
    return []
  })
  const targets = repaired.filter((entry) => kept.has(entry.id)).map((entry) => entry.pageIndex!)
  const groups = repaired.length - targets.length
  const inversions = targets.slice(1).filter((page, i) => targets[i] > page).length
  let score = 1 - 0.5 * (1 - targets.length / Math.max(1, entries.length - groups))
  if (new Set(targets).size <= 1 && pages.length > 2) score -= 0.6
  if (targets.length) score -= inversions / Math.max(1, targets.length - 1)
  if (pages.length > 8 && targets.length && Math.max(...targets) / pages.length < 0.35) score -= 0.4
  if (pages.some((page) => page.text.trim()) && matched / Math.max(1, usable.length) < 0.6) score -= 0.5
  return { isGood: targets.length >= 2 && score >= 0.65, repaired: withHeadingLocations(repaired, pages) }
}

export function heuristicOutline(pages: OutlinePage[]): DocumentOutlineEntry[] {
  const sizes = new Map<number, number>()
  const lines = pages.flatMap((page, pageIndex) => page.lines.map((line) => ({ ...line, pageIndex })))
  const band = (line: OutlineLine): number => Math.round(line.size * 2)
  for (const line of lines) sizes.set(band(line), (sizes.get(band(line)) ?? 0) + line.title.length)
  const bodySize = ([...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 20) / 2
  const repeated = new Map<string, Set<number>>()
  const key = (line: OutlineLine): string => `${normalize(line.title)}|${Math.round(line.fraction * 20)}`
  for (const line of lines) if (line.fraction < 0.12 || line.fraction > 0.88) {
    const set = repeated.get(key(line)) ?? new Set<number>()
    set.add(line.pageIndex); repeated.set(key(line), set)
  }
  const headings = lines.flatMap((line, index) => {
    if (!meaningfulHeading(line.title) || line.title.length > 160 || line.title.split(/\s+/).length > 12 || /[.。]$/.test(line.title) || junk(line.title) || (repeated.get(key(line))?.size ?? 0) >= 2) return []
    const number = numbering.exec(line.title)?.[0].trim().replace(/\.$/, '')
    const common = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|related work|methods?|methodology|experiments?|results|discussion|conclusions?|references|appendix)\b|^(?:摘要|引言|绪论|相关工作|方法|实验|结果|讨论|结论|参考文献|附录)/i.test(line.title)
    if (!(line.size > bodySize + 0.4 || (line.bold && (number || common)))) return []
    return [{ line, index, depth: number ? number.split('.').length : undefined }]
  })
  const bands = [...new Set(headings.filter(({ line }) => line.size > bodySize + 0.4).map(({ line }) => band(line)))].sort((a, b) => b - a)
  const numbered = new Map<number, number>()
  for (const { line, depth } of headings) if (depth === 1) numbered.set(band(line), (numbered.get(band(line)) ?? 0) + 1)
  const topBand = [...numbered].sort((a, b) => b[1] - a[1])[0]?.[0] ?? bands.find((size) => new Set(headings.filter(({ line }) => band(line) === size).map(({ line }) => line.pageIndex)).size >= 2) ?? bands[0]
  const top = bands.indexOf(topBand)
  return headings.slice(0, 10000).map(({ line, index, depth }) => ({
    id: `auto-${index}`, title: line.title, level: Math.min(6, depth ?? Math.max(1, bands.indexOf(band(line)) - top + 1)),
    pageIndex: line.pageIndex, fraction: line.fraction
  }))
}

export class InvalidOutlineResponseError extends Error {}

/** Only existing IDs and valid hierarchy levels survive; source order and coordinates win. */
export function organizedOutline(candidates: DocumentOutlineEntry[], output: string): DocumentOutlineEntry[] {
  const start = output.indexOf('['), end = output.lastIndexOf(']')
  let choices: unknown
  try {
    if (start < 0 || end < start) throw new Error()
    choices = JSON.parse(output.slice(start, end + 1))
    if (!Array.isArray(choices)) throw new Error()
  } catch { throw new InvalidOutlineResponseError('Invalid outline response') }
  const levels = new Map<string, number>()
  for (const item of choices as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const choice = item as { id?: unknown; level?: unknown }
    if (typeof choice.id === 'string' && typeof choice.level === 'number' && Number.isInteger(choice.level) && choice.level >= 1 && choice.level <= 6 && !levels.has(choice.id)) levels.set(choice.id, choice.level)
  }
  return candidates.flatMap((entry) => levels.has(entry.id) ? [{ ...entry, level: levels.get(entry.id)! }] : [])
}

export async function pdfOutlinePages(document: PDFDocumentProxy, signal: AbortSignal): Promise<OutlinePage[]> {
  const pages: OutlinePage[] = []
  for (let index = 0; index < document.numPages; index += 1) {
    signal.throwIfAborted()
    const page = await document.getPage(index + 1)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const lines: OutlineLine[] = []
      let current: { parts: string[]; sizes: Map<number, number>; bold: number; length: number; fraction: number; y: number; endX: number; fontWeights: Record<string, number> } | undefined
      const flush = (): void => {
        if (!current) return
        const title = cleanHeading(current.parts.join(''))
        if (title) lines.push({ title, size: ([...current.sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0) / 2, bold: current.bold * 2 >= current.length, fraction: current.fraction, offset: lines.length, fontWeights: current.fontWeights })
        current = undefined
      }
      for (const item of content.items) {
        if (!('str' in item)) continue
        const run = item as TextItem
        const [x, y] = viewport.convertToViewportPoint(run.transform[4], run.transform[5])
        const size = Math.hypot(run.transform[2], run.transform[3])
        // Respect reading order and explicit EOLs; separate columns at the same baseline.
        if (current && (Math.abs(current.y - y) > Math.max(2, size * 0.35) || x < current.endX - size || x - current.endX > size * 4)) flush()
        current ??= { parts: [], sizes: new Map(), bold: 0, length: 0, fraction: Math.max(0, Math.min(1, (y - size) / viewport.height)), y, endX: x, fontWeights: {} }
        if (current.parts.length && x - current.endX > size * 0.15) current.parts.push(' ')
        current.parts.push(run.str)
        current.endX = x + run.width
        current.sizes.set(Math.round(size * 2), (current.sizes.get(Math.round(size * 2)) ?? 0) + run.str.length)
        current.length += run.str.length
        current.fontWeights[run.fontName] = (current.fontWeights[run.fontName] ?? 0) + run.str.length
        const font = page.commonObjs.has(run.fontName) ? page.commonObjs.get(run.fontName) as { name?: string; bold?: boolean } : undefined
        if (font?.bold || /bold|black|heavy|semibold/i.test(`${font?.name ?? ''} ${content.styles[run.fontName]?.fontFamily ?? ''}`)) current.bold += run.str.length
        if (run.hasEOL) flush()
      }
      flush()
      pages.push({ lines, text: lines.map((line) => line.title).join('\n') })
    } finally { page.cleanup() }
    // Node PDF.js uses a fake worker; let IPC, cancellation and window events run.
    await yieldToEventLoop()
  }
  signal.throwIfAborted()
  return pages
}

/** Reuse extracted text/geometry and load only the missing font information. */
export async function enrichOutlineFonts(document: PDFDocumentProxy, pages: OutlinePage[], signal: AbortSignal): Promise<void> {
  for (let index = 0; index < pages.length; index += 1) {
    signal.throwIfAborted()
    const page = await document.getPage(index + 1)
    try {
      await page.getOperatorList()
      signal.throwIfAborted()
      for (const line of pages[index].lines) {
        let total = 0, bold = 0
        for (const [name, weight] of Object.entries(line.fontWeights ?? {})) {
          total += weight
          const font = page.commonObjs.has(name) ? page.commonObjs.get(name) as { name?: string; bold?: boolean } : undefined
          if (font?.bold || /bold|black|heavy|semibold/i.test(font?.name ?? '')) bold += weight
        }
        line.bold ||= total > 0 && bold * 2 >= total
      }
    } finally { page.cleanup() }
    await yieldToEventLoop()
  }
  signal.throwIfAborted()
}

export async function embeddedOutline(document: PDFDocumentProxy, signal: AbortSignal): Promise<DocumentOutlineEntry[]> {
  const root = await document.getOutline()
  const entries: DocumentOutlineEntry[] = []
  const visit = async (nodes: NonNullable<typeof root>, level: number, path: string): Promise<void> => {
    if (level > 32) return
    for (const [index, node] of nodes.entries()) {
      signal.throwIfAborted()
      if (entries.length >= 10000) return
      const id = `${path}${index}`
      let pageIndex: number | undefined
      let fraction: number | undefined
      try {
        const destination = typeof node.dest === 'string' ? await document.getDestination(node.dest) : node.dest
        if (Array.isArray(destination)) {
          const target = typeof destination[0] === 'number' ? destination[0] : await document.getPageIndex(destination[0])
          if (Number.isInteger(target) && target >= 0 && target < document.numPages) {
            pageIndex = target
            const kind = destination[1]?.name
            const y = kind === 'XYZ' ? destination[3] : kind === 'FitH' || kind === 'FitBH' ? destination[2] : kind === 'FitR' ? destination[5] : undefined
            if (typeof y === 'number' && Number.isFinite(y) && Math.abs(y) < 1e6) {
              const page = await document.getPage(target + 1)
              try {
                const viewport = page.getViewport({ scale: 1 })
                fraction = Math.min(1, Math.max(0, viewport.convertToViewportPoint(viewport.viewBox[0], y)[1] / viewport.height))
              } finally { page.cleanup() }
            }
          }
        }
      } catch { /* Retain destination-less grouping nodes and invalid embedded entries for review. */ }
      entries.push({ id: `pdf-${id}`, title: cleanHeading(node.title ?? ''), level, pageIndex, fraction })
      if (node.items.length) await visit(node.items, level + 1, `${id}.`)
    }
  }
  if (root) await visit(root, 1, '')
  return entries
}

export function scanOutline(source: string, pageIndex: number): DocumentOutlineEntry[] {
  const result: DocumentOutlineEntry[] = []
  const regex = /\\(section|subsection|subsubsection)\*?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g
  for (const match of source.matchAll(regex)) {
    const title = cleanHeading(match[2].replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?|[{}]/g, ''))
    if (meaningfulHeading(title)) result.push({ id: `scan-${pageIndex + 1}-${match.index}`, title, level: match[1] === 'section' ? 1 : match[1] === 'subsection' ? 2 : 3, pageIndex })
  }
  return result
}

/** Align cached LaTeX headings on the worker, keeping original PDF reading order. */
export function latexOutline(blocks: Array<{ id: string; kind: string; alignmentText: string; headingLevel?: number | null; sectionPath?: Array<{ level: number }> }>, pages: OutlinePage[]): DocumentOutlineEntry[] {
  let start = { page: 0, offset: -1 }
  return blocks.filter((block) => block.kind === 'sectionHeading').flatMap((block) => {
    const title = cleanHeading(block.alignmentText)
    for (let index = start.page; index < pages.length; index += 1) {
      const line = headingLocations(title, pages[index]).find((line) => index > start.page || line.offset > start.offset)
      if (!line) continue
      start = { page: index, offset: line.offset }
      return [{ id: `latex-${block.id}`, title, level: Math.min(6, Math.max(1, block.headingLevel ?? block.sectionPath?.[block.sectionPath.length - 1]?.level ?? 1)), pageIndex: index, fraction: line.fraction }]
    }
    return []
  })
}
