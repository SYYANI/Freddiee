import { type PageLayout, type PageMeasure } from './geometry'
import { LineMetrics } from './lineMetrics'
import { LineRules, bodyLines, frameWidth } from './lineBreaks'
import type { PageMarkup } from './markup'
import { Pattern, PythonNumber, PythonText, median, parseInt10 } from './pattern'

/** The document-wide type chosen by `documentLayouts`, as recorded in manifest.json. */
export interface LayoutSummary {
  font: string
  size_pt: number
  leading_pt: number
  indent_pt: number
  paragraph_gap_pt: number
  text_width_pt: number
  line_samples: number
}

const LayoutPatterns = {
  resized: new Pattern(String.raw`\\(small|footnotesize|scriptsize|large|Large|LARGE|begin|end|\[|\])`),
  columnBlock: new Pattern(String.raw`\\begin\{multicols\}\{(\d)\}`)
}

/**
 * `document_layouts`: one body size and measure for the document, positioned on each page as scanned.
 *
 * `markups` lists the pages in reading order; the most common face wins, ties going to
 * the first page that uses it.
 */
export function documentLayouts(
  measures: ReadonlyMap<number, PageMeasure>,
  markups: ReadonlyArray<{ page: number; markup: PageMarkup }>
): { layouts: Map<number, PageLayout>; summary: LayoutSummary } {
  const pages = [...measures.keys()].sort((a, b) => a - b)
  const values = pages.map((page) => measures.get(page)!)
  const reference = values[0]
  const widths = values.flatMap((measure) => measure.left !== undefined && measure.right !== undefined ? [measure.right - measure.left] : [])
  const textWidth = widths.length ? PythonNumber.median(widths) : reference.pageWidth * 0.75
  const columnGap = median(values.map((measure) => measure.columnGap), textWidth * 0.05)
  // A page whose text area differs clearly from the document's keeps its own, such as
  // references that fill only the first column of a two-column article, or a page of a
  // collection set in another format, when its scan shows the columns its markup sets.
  const own = new Map<number, number>()
  for (const { page, markup } of markups) {
    const measure = measures.get(page)
    if (!measure || measure.left === undefined || measure.right === undefined
      || !(Math.abs(measure.right - measure.left - textWidth) > textWidth * 0.1) || markup.body.includes('\\begin{sidebyside}')) continue
    const blocks = LayoutPatterns.columnBlock.findAll(markup.body).flatMap((value) => {
      const parsed = parseInt10(value)
      return parsed === undefined ? [] : [parsed]
    })
    const written = blocks.length ? Math.max(...blocks) : 1
    if (Math.max(1, measure.columns.length) === written) own.set(page, measure.right - measure.left)
  }
  const font = mostCommonFont(markups.map((entry) => entry.markup.font)) ?? 'serif'
  const metrics = new LineMetrics(font)
  const estimates: number[] = []
  for (const { page, markup } of markups) {
    for (const { line, frames, last } of bodyLines(markup.body)) {
      if (last || frames.some((frame) => frame.name !== 'multicols') || LayoutPatterns.resized.contains(line)) continue
      const plain = LineRules.mathSpan.sub(line, '')
      const plainLength = PythonText.length(plain)
      if (plainLength < 30 || plainLength < PythonText.length(line) * 0.7) continue
      const measure = frameWidth(frames, own.get(page) ?? textWidth, columnGap, 0, markup.columns)
      const em = metrics.widthEm(line)
      if (em > 0) estimates.push(measure / em)
    }
  }
  // The line pitch belongs with the type estimated from the transcribed pages; the other
  // measured pages stand in only where those show no running text.
  const transcribed = new Set(markups.map((entry) => entry.page))
  const typesetPitch = median(pages.filter((page) => transcribed.has(page)).map((page) => measures.get(page)!.pitch), 0)
  const pitch = typesetPitch !== 0 ? typesetPitch : median(values.map((measure) => measure.pitch), 0)
  let size: number
  if (estimates.length >= 5) {
    estimates.sort((a, b) => a - b)
    // Size for the narrower lines so most lines stretch slightly instead of overflowing.
    size = estimates[Math.trunc(estimates.length * 0.3)]
  } else {
    size = pitch !== 0 ? pitch / 1.2 : 10
  }
  size = Math.max(5, Math.min(16, size))
  const leading = Math.max(size * 1.05, pitch !== 0 ? pitch : size * 1.2)
  const indent = median(values.map((measure) => measure.indent), size * 1.2)
  // Blank-line paragraph separation only exists with block paragraphs; in indented text the
  // larger gaps belong to headings and displays, which the markup spaces itself.
  const paragraphGap = indent < size * 0.3 ? median(values.map((measure) => measure.paragraphGap), 0) : 0
  const bottom = median(values.map((measure) => measure.bottom), reference.pageHeight * 0.9)
  const usualLeft = median(values.map((measure) => measure.left), (reference.pageWidth - textWidth) / 2)
  const headedPages = new Set(markups.filter((entry) => entry.markup.header).map((entry) => entry.page))
  const layouts = new Map<number, PageLayout>()
  for (const [number, measure] of measures) {
    const width = own.get(number) ?? textWidth
    let left = measure.left ?? usualLeft
    left = Math.max(4, Math.min(left, measure.pageWidth - width - 4))
    const top = measure.top ?? median(values.map((item) => item.top), measure.pageHeight * 0.08)
    // A short last page still uses the full text area, so its footer sits where it was printed.
    const pageBottom = Math.max(measure.bottom !== undefined && measure.bottom !== 0 ? measure.bottom : bottom, bottom)
    const textHeight = pageBottom - top - 0.2 * size
    let headerGap = 0
    if (headedPages.has(number) && measure.headerPitch !== undefined && measure.headerPitch !== 0) {
      headerGap = Math.max(0, measure.headerPitch - leading)
    }
    layouts.set(number, {
      pageWidth: measure.pageWidth, pageHeight: measure.pageHeight, left, top,
      textWidth: width, textHeight: Math.max(textHeight, leading * 3), size,
      leading, indent, columnGap, headerGap, paragraphGap
    })
  }
  const summary: LayoutSummary = {
    font,
    size_pt: PythonNumber.round(size, 3),
    leading_pt: PythonNumber.round(leading, 3),
    indent_pt: PythonNumber.round(indent, 2),
    paragraph_gap_pt: PythonNumber.round(paragraphGap, 2),
    text_width_pt: PythonNumber.round(textWidth, 2),
    line_samples: estimates.length
  }
  return { layouts, summary }
}

/** `Counter(fonts).most_common(1)`: ties go to the font seen first. */
function mostCommonFont(fonts: readonly string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const font of fonts) counts.set(font, (counts.get(font) ?? 0) + 1)
  let best: string | undefined
  for (const [font, count] of counts) if (best === undefined || count > counts.get(best)!) best = font
  return best
}
