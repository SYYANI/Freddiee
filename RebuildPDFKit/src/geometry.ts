import { Pattern, PythonNumber, isAlphanumeric, stableSorted } from './pattern'

/** One recognized line of a page image, in pixels from the top-left corner. */
export interface OcrLine {
  id: string
  left: number
  top: number
  right: number
  bottom: number
  text: string
  /** 0 to 100, as Tesseract reports it. */
  confidence: number
}

export const lineWidth = (line: OcrLine): number => line.right - line.left
export const lineHeight = (line: OcrLine): number => line.bottom - line.top

/** Text-area measurements of one scan, in PDF points from the top-left corner. */
export interface PageMeasure {
  pageWidth: number
  pageHeight: number
  left?: number
  right?: number
  top?: number
  bottom?: number
  pitch?: number
  indent?: number
  columnGap?: number
  headerPitch?: number
  paragraphGap?: number
  /** Lowest running-text line of each column on a page set in columns, left to right. */
  columnBottoms?: number[]
  /** Left and right edge of each column on a page set in columns, left to right. */
  columns: number[][]
}

export function emptyMeasure(pageWidth: number, pageHeight: number): PageMeasure {
  return { pageWidth, pageHeight, columns: [] }
}

/** The text area and type of one page, in PDF points. */
export interface PageLayout {
  pageWidth: number
  pageHeight: number
  left: number
  top: number
  textWidth: number
  textHeight: number
  size: number
  leading: number
  indent: number
  columnGap: number
  headerGap: number
  paragraphGap: number
}

export function pageLayout(values: Omit<PageLayout, 'headerGap' | 'paragraphGap'> & Partial<Pick<PageLayout, 'headerGap' | 'paragraphGap'>>): PageLayout {
  return { headerGap: 0, paragraphGap: 0, ...values }
}

export function sameLayout(a: PageLayout | undefined, b: PageLayout | undefined): boolean {
  if (!a || !b) return a === b
  return (Object.keys(a) as Array<keyof PageLayout>).every((key) => a[key] === b[key])
}

const MeasurePatterns = {
  word: new Pattern(String.raw`[^\W\d_]{3,}`),
  han: new Pattern('[㐀-鿿]')
}

/** `measure_page`: the text area, line pitch, indent and column gap of one scan. */
export function measurePage(lines: readonly OcrLine[], imageSize: { width: number; height: number }, pageSize: { width: number; height: number }): PageMeasure {
  const scale = pageSize.width / imageSize.width
  const measure = emptyMeasure(pageSize.width, pageSize.height)
  const good = lines.filter((line) => line.confidence >= 45 && Array.from(line.text).filter(isAlphanumeric).length >= 2)
  if (!good.length) return measure
  measure.top = Math.min(...good.map((line) => line.top)) * scale
  measure.bottom = Math.max(...good.map((line) => line.bottom)) * scale
  const ordered = stableSorted(good, (line) => line.top)
  const next = ordered.slice(1).find((line) => line.top > ordered[0].bottom)
  if (next) measure.headerPitch = (next.bottom - ordered[0].bottom) * scale
  // Width, indent, columns and pitch come from running text only: rows of a formula,
  // table or chemical drawing would otherwise pass for a narrow text block.
  const prose = good.filter((line) => MeasurePatterns.word.findAll(line.text).length >= 3 || MeasurePatterns.han.findAll(line.text).length >= 6)
  if (prose.length < 4) return measure
  const spans = prose.map((line) => line.right - line.left).sort((a, b) => a - b)
  const typical = spans[Math.trunc(spans.length * 0.85)]
  const full = prose.filter((line) => lineWidth(line) >= typical * 0.6)
  if (full.length < 4) return measure

  let edges = textColumns(full, imageSize.width).map(textEdges)
  let gaps = edges.slice(1).map((edge, index) => edge.left - edges[index].right)
  if (gaps.some((gap) => gap <= 0)) {
    edges = [textEdges(full)]
    gaps = []
  }
  const left = edges[0].left
  const right = edges[edges.length - 1].right
  measure.left = left * scale
  measure.right = right * scale
  if (gaps.length) {
    measure.columnGap = PythonNumber.median(gaps) * scale
    measure.columns = edges.map((edge) => [edge.left * scale, edge.right * scale])
  }
  // Each column runs from gutter to gutter; a line across a gutter belongs to none.
  const bounds = [-Infinity, ...edges.slice(1).map((edge, index) => (edges[index].right + edge.left) / 2), Infinity]

  const split = (items: readonly OcrLine[]): OcrLine[][] => bounds.slice(1).map((high, index) => {
    const low = bounds[index]
    return items.filter((line) => low < line.left && line.right < high)
  })

  const offsets = paragraphIndents(split(full), left, right)
  if (offsets.length >= 2) measure.indent = PythonNumber.median(offsets) * scale
  else if (full.length >= 12) measure.indent = 0 // block paragraphs, as in most typewritten reports

  const steps = (items: readonly OcrLine[]): Array<{ step: number; height: number }> => {
    const found: Array<{ step: number; height: number }> = []
    for (const column of split(items)) {
      const sorted = stableSorted(column, (line) => line.top)
      for (let index = 0; index + 1 < sorted.length; index += 1) {
        const upper = sorted[index]
        const lower = sorted[index + 1]
        const overlap = Math.min(upper.right, lower.right) - Math.max(upper.left, lower.left)
        const step = (lower.top + lower.bottom - upper.top - upper.bottom) / 2
        if (overlap > 0 && step > 0) found.push({ step, height: lineHeight(upper) })
      }
    }
    return found
  }

  const pitches = steps(full).filter((entry) => entry.step < entry.height * 2.5).map((entry) => entry.step)
  if (pitches.length >= 3) {
    const pitch = PythonNumber.median(pitches)
    measure.pitch = pitch * scale
    // Short paragraph-final lines are not prose, so gaps are measured over all lines.
    const paragraphGaps = steps(good).map((entry) => entry.step).filter((step) => 1.6 * pitch <= step && step <= 2.8 * pitch)
    if (paragraphGaps.length >= 2) measure.paragraphGap = (PythonNumber.median(paragraphGaps) - pitch) * scale
    const columns = split(full)
    if (columns.length > 1 && columns.every((column) => column.length > 0)) {
      // A page footer is set apart below the columns; it does not show how deep they run.
      measure.columnBottoms = columns.map((column) => {
        const depths = column.map((line) => line.bottom).sort((a, b) => a - b)
        while (depths.length > 1 && depths[depths.length - 1] - depths[depths.length - 2] > 2.5 * pitch) depths.pop()
        return depths[depths.length - 1] * scale
      })
    }
  }
  return measure
}

/**
 * `_text_columns`: running-text lines grouped into side-by-side columns, left to right.
 *
 * The lines of a column start at one left edge. A paragraph indent starts a little to the
 * right, but its lines run on past where a next column would begin. A page has columns
 * when at least two of them hold five lines; otherwise all lines form one group.
 */
export function textColumns(full: readonly OcrLine[], width: number): OcrLine[][] {
  const tolerance = width * 0.012
  const clusters: number[][] = []
  for (const x of full.map((line) => line.left).sort((a, b) => a - b)) {
    const last = clusters.at(-1)?.at(-1)
    if (last !== undefined && x - last <= tolerance) clusters[clusters.length - 1].push(x)
    else clusters.push([x])
  }
  let starts: Array<{ x: number; reach: number }> = []
  // Largest clusters first; equal ones keep their left-to-right order.
  for (const cluster of stableSorted(clusters, (item) => -item.length)) {
    if (cluster.length < 3) break
    const x = cluster[Math.trunc(cluster.length / 2)]
    const ends = full.filter((line) => Math.abs(line.left - x) <= tolerance).map((line) => line.right).sort((a, b) => a - b)
    const reach = ends[Math.trunc(ends.length / 4)]
    if (starts.every((start) => reach < start.x || start.reach < x)) starts.push({ x, reach })
  }
  starts.sort((a, b) => a.x !== b.x ? a.x - b.x : a.reach - b.reach)
  for (;;) {
    const bounds = [...starts.map((start) => start.x), Infinity]
    const groups = starts.map((_, index) => full.filter((line) => bounds[index] - tolerance <= line.left
      && line.left < bounds[index + 1] - tolerance && line.right < bounds[index + 1]))
    const weak = groups.findIndex((group) => group.length < 5)
    if (weak < 0) return groups.length > 1 ? groups : [[...full]]
    starts = starts.filter((_, index) => index !== weak)
  }
}

/** `_text_edges`: the left and right edge of a block of running text, in pixels. */
export function textEdges(lines: readonly OcrLine[]): { left: number; right: number } {
  const lefts = lines.map((line) => line.left).sort((a, b) => a - b)
  const rights = lines.map((line) => line.right).sort((a, b) => a - b)
  return { left: lefts[Math.trunc(lefts.length / 5)], right: rights[Math.trunc(rights.length * 4 / 5)] }
}

/**
 * `_paragraph_indents`: offsets of indented first lines, an indented line followed by a flush one.
 *
 * A run of equally indented lines is a quotation or a differently set block, not a
 * paragraph indent.
 */
export function paragraphIndents(columns: readonly OcrLine[][], left: number, right: number): number[] {
  const width = (right - left) / columns.length
  if (!(width > 0)) return []
  const offsets: number[] = []
  for (const column of columns) {
    if (!column.length) continue
    const edge = column.map((line) => line.left).sort((a, b) => a - b)[Math.trunc(column.length / 5)]
    const ordered = stableSorted(column, (line) => line.top)
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const offset = ordered[index].left - edge
      if (0.01 < offset / width && offset / width < 0.12 && Math.abs(ordered[index + 1].left - edge) < width * 0.01) offsets.push(offset)
    }
  }
  return offsets
}
