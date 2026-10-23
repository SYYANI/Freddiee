import { readFile } from 'node:fs/promises'
import { markupPlain } from './coverage'
import { LatexError } from './errors'
import { type PageLayout, sameLayout } from './geometry'
import type { PageMarkup } from './markup'
import { Pattern, PythonNumber, PythonText } from './pattern'
import { pageGlyphs, withPDF } from './pdf'
import { TranslationPatterns } from './translation'
import type { CompileResult } from './xelatex'

/** How a translated page was fitted, as recorded in the translation manifest. */
export interface TranslationFitReport {
  version: string
  cjk_body: string
  cjk_quote: string
  source_body_height_pt: number
  body_height_pt: number
  body_height_ratio?: number
  size_pt: number
  leading_pt: number
  paragraph_gap_pt: number
  candidates: number
  column_bottoms_pt?: number[]
}

const han = new Pattern('[㐀-鿿]')

/**
 * `fit_translation_layout`: measure each page locally; prefer its source footprint and comfortable Chinese spacing.
 *
 * Body fonts may grow by at most 12%, leading by at most 1.45 em and paragraph
 * spacing by at most 0.8 em. Intentional blank space on short pages is preserved.
 * Rendering owns the final one-page fit and the safety checks for literal code.
 */
export async function fitTranslationLayout(
  source: PageLayout, markup: PageMarkup, sourceHeight: number, render: (layout: PageLayout) => Promise<CompileResult>
): Promise<{ result: CompileResult; layout: PageLayout; report: TranslationFitReport }> {
  const cjkCount = han.findAll(markupPlain(markup)).length
  const attempts: Array<{ layout: PageLayout; result: CompileResult }> = []
  let lastRendered: PageLayout | undefined

  const evaluate = async (layout: PageLayout): Promise<CompileResult | undefined> => {
    lastRendered = undefined
    try {
      const result = await render(layout)
      attempts.push({ layout, result })
      lastRendered = layout
      return result
    } catch (error) {
      // A more spacious candidate can fail while the original layout still fits.
      if (error instanceof LatexError) return undefined
      throw error
    }
  }

  // Figure pages and short captions retain the source geometry and font size.
  if (cjkCount < 40 || sourceHeight <= 0) {
    const result = await render(source)
    return { result, layout: source, report: await report(sourceHeight, result, source, 1, markup) }
  }

  const size = source.size * (source.size < 9.5 ? 1.04 : 1)
  const comfortable = { ...source, size, leading: Math.max(source.leading, 1.25 * size), paragraphGap: Math.max(source.paragraphGap, 0.25 * size) }
  const first = await evaluate(comfortable)
  if (!first || first.scale < 0.99 || first.overfull.length || first.bodyHeight > sourceHeight * 1.08) await evaluate(source)
  if (first && sourceHeight > 0 && first.bodyHeight < sourceHeight * 0.92) {
    const ratio = sourceHeight / Math.max(first.bodyHeight, size)
    const paragraphCount = Math.max(1, TranslationPatterns.paragraphBreak.split(markup.body).length - 1)
    const spacedLeading = Math.min(1.45 * size, comfortable.leading * ratio)
    let predicted = first.bodyHeight * spacedLeading / comfortable.leading
    const spacedGap = Math.min(0.8 * size, Math.max(0.25 * size, comfortable.paragraphGap + (sourceHeight - predicted) / paragraphCount))
    await evaluate({ ...comfortable, leading: spacedLeading, paragraphGap: spacedGap })
    const expandedSize = Math.max(source.size, Math.min(source.size * 1.12, 12))
    const leading = Math.min(1.45 * expandedSize, Math.max(1.28 * expandedSize, comfortable.leading * Math.sqrt(ratio)))
    predicted = first.bodyHeight * expandedSize / size * leading / comfortable.leading
    const gap = Math.min(0.8 * expandedSize, Math.max(0.25 * expandedSize, comfortable.paragraphGap + (sourceHeight - predicted) / paragraphCount))
    const expanded = { ...source, size: expandedSize, leading, paragraphGap: gap }
    const second = await evaluate(expanded)
    if (second && second.bodyHeight < sourceHeight * 0.9) {
      await evaluate({ ...expanded, leading: 1.45 * expandedSize, paragraphGap: 0.8 * expandedSize })
    }
  }
  if (!attempts.length) {
    // Preserve the compiler's useful error message when all candidates fail.
    await render(source)
    throw new LatexError('no translated layout candidate could be typeset')
  }

  const score = (candidate: { layout: PageLayout; result: CompileResult }): number => {
    const footprint = Math.abs(candidate.result.bodyHeight - sourceHeight) / Math.max(sourceHeight, candidate.layout.leading)
    // Content must fit; keep figures and text at their intended physical size if possible.
    const overflow = candidate.result.overfull.length ? Math.max(...candidate.result.overfull) : 0
    return footprint + 8 * (1 - candidate.result.scale) + (overflow > 1 ? 10 + overflow : 0)
  }

  let chosen = attempts[0]
  for (const candidate of attempts.slice(1)) if (score(candidate) < score(chosen)) chosen = candidate
  // Every candidate writes the same build directory; leave the chosen one on disk.
  const result = sameLayout(lastRendered, chosen.layout) ? chosen.result : await render(chosen.layout)
  return { result, layout: chosen.layout, report: await report(sourceHeight, result, chosen.layout, attempts.length, markup) }
}

/**
 * `column_bottoms`: where the body text of each column ends on the rendered page, in points from the top.
 *
 * Only characters entirely inside one column count, so centred titles and the full-width
 * header and footer do not hide an empty column.
 */
export async function columnBottoms(result: CompileResult, fallback: PageLayout): Promise<number[] | undefined> {
  const layout = result.layout ?? fallback
  let glyphs: Awaited<ReturnType<typeof pageGlyphs>>
  try {
    glyphs = await withPDF(new Uint8Array(await readFile(result.pdf)), async (document) => pageGlyphs(await document.getPage(1)))
  } catch {
    return undefined
  }
  const width = (layout.textWidth - layout.columnGap) / 2
  const top = layout.top + result.bodyStart * 72 / 72.27 - 2
  const bottom = layout.top + (result.bodyStart + result.bodyHeight) * 72 / 72.27 + 2
  let left: number | undefined
  let right: number | undefined
  for (const glyph of glyphs) {
    if (!PythonText.strip(glyph.text)) continue
    if (!(glyph.top >= top && glyph.bottom <= bottom)) continue
    if (glyph.x1 <= layout.left + width + 3) left = Math.max(left ?? glyph.bottom, glyph.bottom)
    else if (glyph.x0 >= layout.left + width + layout.columnGap - 3) right = Math.max(right ?? glyph.bottom, glyph.bottom)
  }
  return left !== undefined && right !== undefined ? [left, right] : undefined
}

async function report(sourceHeight: number, result: CompileResult, layout: PageLayout, attempts: number, markup: PageMarkup): Promise<TranslationFitReport> {
  const twoColumns = markup.body.includes('\\begin{multicols}{2}') || markup.body.includes('\\begin{rebuildflow}')
  const bottoms = twoColumns ? await columnBottoms(result, layout) : undefined
  return {
    version: 'page-fit-v2',
    cjk_body: 'FandolSong',
    cjk_quote: 'FandolKai',
    source_body_height_pt: PythonNumber.round(sourceHeight, 2),
    body_height_pt: PythonNumber.round(result.bodyHeight, 2),
    body_height_ratio: sourceHeight !== 0 ? PythonNumber.round(result.bodyHeight / sourceHeight, 3) : undefined,
    size_pt: PythonNumber.round(layout.size * result.scale, 3),
    leading_pt: PythonNumber.round(layout.leading * result.scale, 3),
    paragraph_gap_pt: PythonNumber.round(layout.paragraphGap * result.scale, 3),
    candidates: attempts,
    column_bottoms_pt: bottoms?.map((value) => PythonNumber.round(value, 2))
  }
}
