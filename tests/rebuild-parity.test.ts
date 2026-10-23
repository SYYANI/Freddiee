import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { RGBImage, splitRows } from '../RebuildPDFKit/src/bitmap'
import { coverageTokens, coverageWarnings, markupPlain, placeColumnBreaks, restoreVerticalGaps } from '../RebuildPDFKit/src/coverage'
import { documentLayouts } from '../RebuildPDFKit/src/documentLayout'
import { LatexError, MarkupError } from '../RebuildPDFKit/src/errors'
import { figureFrames, figureOrigin, frameHints, resolveFigureBoxes, snapFigureBox } from '../RebuildPDFKit/src/figures'
import { type OcrLine, type PageLayout, type PageMeasure, measurePage } from '../RebuildPDFKit/src/geometry'
import { type LineFrame, applyLineBreaks, isCodeLine, lineContexts, lockSpaces } from '../RebuildPDFKit/src/lineBreaks'
import { LineMetrics } from '../RebuildPDFKit/src/lineMetrics'
import { FigureBoxes, PageMarkup, figureBox } from '../RebuildPDFKit/src/markup'
import { layoutSamples } from '../RebuildPDFKit/src/pipeline'
import { RebuildPrompts } from '../RebuildPDFKit/src/prompts'
import { ParagraphSizes, type PlacedFigures, buildTeX, untagDisplays } from '../RebuildPDFKit/src/texSource'
import { protectMarkup, releaseColumnBreaks, restoreTranslation } from '../RebuildPDFKit/src/translation'
import { coverFigures, latexErrorMessage } from '../RebuildPDFKit/src/xelatex'

type Entry = Record<string, any>

const fixtureDirectory = join(__dirname, 'fixtures', 'rebuild-pdf')
const fixtures = JSON.parse(readFileSync(join(fixtureDirectory, 'parity.json'), 'utf8')) as Record<string, any>
const section = (name: string): Entry[] => {
  const value = fixtures[name]
  if (!Array.isArray(value)) throw new Error(`missing fixture section ${name}`)
  return value
}

const images = new Map<string, RGBImage>()
const image = (name: string): RGBImage => {
  const loaded = images.get(name)
  if (!loaded) throw new Error(`fixture image ${name} was not loaded`)
  return loaded
}

const Fixture = {
  number(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined
  },
  lines(value: unknown): OcrLine[] {
    return (value as OcrLine[] ?? []).map((line) => ({ ...line }))
  },
  measure(value: unknown): PageMeasure {
    const entry = value as Entry
    return {
      pageWidth: entry.page_width, pageHeight: entry.page_height,
      left: Fixture.number(entry.left), right: Fixture.number(entry.right), top: Fixture.number(entry.top),
      bottom: Fixture.number(entry.bottom), pitch: Fixture.number(entry.pitch), indent: Fixture.number(entry.indent),
      columnGap: Fixture.number(entry.column_gap), headerPitch: Fixture.number(entry.header_pitch),
      paragraphGap: Fixture.number(entry.paragraph_gap),
      columnBottoms: Array.isArray(entry.column_bottoms) ? entry.column_bottoms : undefined,
      columns: Array.isArray(entry.columns) ? entry.columns : []
    }
  },
  layout(value: unknown): PageLayout {
    const entry = value as Entry
    return {
      pageWidth: entry.page_width, pageHeight: entry.page_height, left: entry.left, top: entry.top,
      textWidth: entry.text_width, textHeight: entry.text_height, size: entry.size, leading: entry.leading,
      indent: entry.indent, columnGap: entry.column_gap, headerGap: entry.header_gap, paragraphGap: entry.paragraph_gap
    }
  },
  frames(value: unknown): LineFrame[] {
    return (value as unknown[][] ?? []).map((item) => ({ name: item[0] as string, argument: (item[1] as string | null) ?? undefined, block: item[2] as number }))
  },
  figures(value: unknown): PlacedFigures {
    return (value as unknown[][] ?? []).map((item) => ({
      key: item[0] as string,
      placement: {
        file: item[1] as string, width: item[2] as number, offset: item[3] as number,
        top: item.length > 4 ? item[4] as number : 0, height: item.length > 5 ? item[5] as number : 0,
        free: item.length > 6 ? item[6] as boolean : false
      }
    }))
  },
  sizes(value: unknown): ParagraphSizes {
    const sizes = new ParagraphSizes()
    for (const item of value as number[][] ?? []) sizes.set({ first: item[0], last: item[1] }, item[2])
    return sizes
  },
  typography(value: unknown): { referenceSize: number; referenceLeading: number } | undefined {
    return Array.isArray(value) ? { referenceSize: value[0], referenceLeading: value[1] } : undefined
  },
  /** The first differing line, for readable failures of long generated sources. */
  firstDifference(lhs: string, rhs: string): string {
    const left = lhs.split('\n')
    const right = rhs.split('\n')
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) return `line ${index + 1}: port ${left[index] ?? '<end>'} | python ${right[index] ?? '<end>'}`
    }
    return 'identical'
  }
}

function expectError(kind: typeof MarkupError | typeof LatexError, message: string, body: () => unknown): void {
  let thrown: unknown
  try {
    body()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(kind)
  expect((thrown as Error).message).toBe(message)
}

function plainMeasure(measure: PageMeasure): Entry {
  return Object.fromEntries(Object.entries(measure).filter(([, value]) => value !== undefined))
}

beforeAll(async () => {
  for (const name of ['bands.png', 'drawing.png', 'frame.png', 'gaps.png', 'prose.png', 'sketch.png', 'stacked.png']) {
    images.set(name, await RGBImage.decode(new Uint8Array(readFileSync(join(fixtureDirectory, 'images', name)))))
  }
})

describe('RebuildPDFKit parity with the Python implementation', () => {
  it('has byte-identical prompts', () => {
    const expected = fixtures.prompts as Record<string, string>
    for (const [name, text] of [['transcribe', RebuildPrompts.transcribe], ['review', RebuildPrompts.review], ['translate-zh', RebuildPrompts.translateChinese]]) {
      expect(createHash('sha256').update(text, 'utf8').digest('hex'), name).toBe(expected[name])
    }
  })

  it('parses, serializes and rejects markup', () => {
    for (const entry of section('markups')) {
      if (typeof entry.serialized === 'string') expect(PageMarkup.parse(entry.text).serialize()).toBe(entry.serialized)
      else expectError(MarkupError, entry.error, () => PageMarkup.parse(entry.text))
    }
  })

  it('keeps printed line breaks', () => {
    for (const entry of section('line_breaks')) {
      const ratio = typeof entry.ratio === 'number' ? (): number => entry.ratio : undefined
      expect(applyLineBreaks(entry.text, entry.mode, ratio), entry.text).toBe(entry.output)
    }
    for (const entry of section('code_lines')) expect(isCodeLine(entry.line), entry.line).toBe(entry.result)
    for (const entry of section('lock_spaces')) expect(lockSpaces(entry.line)).toBe(entry.result)
    for (const entry of section('line_contexts')) {
      const contexts = lineContexts((entry.text as string).split('\n'))
      const expected = entry.contexts as unknown[][]
      expect(contexts.length).toBe(expected.length)
      contexts.forEach((context, index) => {
        expect([context.breakable, context.environment, context.frames], entry.text)
          .toEqual([expected[index][0], expected[index][1], Fixture.frames(expected[index][2])])
      })
    }
  })

  it('measures line widths with PyMuPDF base fonts', () => {
    for (const entry of section('width_em')) {
      expect(new LineMetrics(entry.font).widthEm(entry.line), `${entry.font}: ${entry.line}`).toBe(entry.width)
    }
  })

  it('measures pages and lays out documents', () => {
    for (const entry of section('measure')) {
      const measure = measurePage(Fixture.lines(entry.lines), { width: entry.image[0], height: entry.image[1] }, { width: entry.page[0], height: entry.page[1] })
      expect(plainMeasure(measure)).toEqual(plainMeasure(Fixture.measure(entry.measure)))
    }
    for (const entry of section('layouts')) {
      const measures = new Map(Object.entries(entry.measures as Record<string, unknown>).map(([key, value]) => [Number(key), Fixture.measure(value)]))
      const markups = (entry.markups as unknown[][]).map((item) => ({ page: item[0] as number, markup: PageMarkup.parse(item[1] as string) }))
      const { layouts, summary } = documentLayouts(measures, markups)
      for (const [key, value] of Object.entries(entry.layouts as Record<string, unknown>)) expect(layouts.get(Number(key)), `page ${key}`).toEqual(Fixture.layout(value))
      expect(summary).toEqual(entry.summary)
    }
    for (const entry of section('layout_samples')) expect(layoutSamples(entry.pages, entry.chosen)).toEqual(entry.samples)
  })

  it('keeps figures at their printed place and size', () => {
    for (const entry of section('figure_origins')) {
      const { origin, free } = figureOrigin(Fixture.frames(entry.frames), Fixture.layout(entry.layout), entry.x0, entry.columns)
      expect([origin, free], JSON.stringify(entry.frames)).toEqual(entry.result)
    }
    for (const entry of section('cover_figures')) {
      expect(coverFigures(Fixture.layout(entry.layout), Fixture.figures(entry.figures))).toEqual(Fixture.layout(entry.result))
    }
  })

  it('restores blank space around headings', () => {
    for (const entry of section('vertical_gaps')) {
      const { markup, note } = restoreVerticalGaps(PageMarkup.parse(entry.markup), Fixture.lines(entry.lines), Fixture.measure(entry.measure), Fixture.layout(entry.layout), image(entry.image))
      expect(markup.serialize()).toBe(entry.result)
      expect(note).toBe(entry.note ?? undefined)
    }
  })

  it('generates byte-identical main.tex', () => {
    for (const entry of section('build_tex')) {
      const tex = buildTeX({
        markup: PageMarkup.parse(entry.markup), layout: Fixture.layout(entry.layout), figures: Fixture.figures(entry.figures),
        lineMode: entry.mode, scale: entry.scale, paragraphSizes: Fixture.sizes(entry.sizes), typography: Fixture.typography(entry.typography)
      })
      expect(tex === entry.tex, Fixture.firstDifference(tex, entry.tex)).toBe(true)
    }
    for (const entry of section('build_tex_scaled')) {
      const tex = buildTeX({
        markup: PageMarkup.parse(entry.markup), layout: Fixture.layout(entry.layout), figures: Fixture.figures(entry.figures),
        lineMode: entry.mode, displayScales: Fixture.sizes(entry.displays), spaceScale: entry.space_scale
      })
      expect(tex === entry.tex, Fixture.firstDifference(tex, entry.tex)).toBe(true)
    }
    for (const entry of section('untag')) expect(untagDisplays(entry.text)).toBe(entry.result)
  })

  it('protects and restores translations', () => {
    for (const entry of section('protect')) {
      const { text, protected: spans } = protectMarkup(PageMarkup.parse(entry.markup))
      expect(text).toBe(entry.text)
      expect(spans).toEqual(entry.protected)
    }
    for (const entry of section('restore')) {
      const source = PageMarkup.parse(entry.source)
      if (typeof entry.result === 'string') expect(restoreTranslation(entry.raw, entry.protected, source).serialize()).toBe(entry.result)
      else expectError(MarkupError, entry.error, () => restoreTranslation(entry.raw, entry.protected, source))
    }
    for (const entry of section('place_breaks')) {
      const { markup, note } = placeColumnBreaks(PageMarkup.parse(entry.markup), Fixture.lines(entry.lines), Fixture.measure(entry.measure), { width: 1000, height: 1300 })
      expect(markup.serialize()).toBe(entry.result)
      expect(note).toBe(entry.note ?? undefined)
    }
    for (const entry of section('release_breaks')) {
      expect(releaseColumnBreaks(PageMarkup.parse(entry.markup), Fixture.measure(entry.measure)).serialize()).toBe(entry.result)
    }
  })

  it('reports coverage, plain text and tokens', () => {
    for (const entry of section('coverage')) expect(coverageWarnings(PageMarkup.parse(entry.markup), Fixture.lines(entry.lines))).toEqual(entry.warnings)
    for (const entry of section('plain')) {
      const plain = markupPlain(PageMarkup.parse(entry.markup))
      expect(plain).toBe(entry.plain)
      expect(coverageTokens(plain)).toEqual(entry.tokens)
    }
  })

  it('explains LaTeX errors to the model', () => {
    for (const entry of section('latex_errors')) expect(latexErrorMessage(entry.log, entry.tex)).toBe(entry.message)
  })

  it('splits pages into bands and snaps figures', () => {
    for (const entry of section('split_rows')) {
      expect(splitRows(image(entry.image), entry.parts).map((band) => [band.top, band.bottom])).toEqual(entry.bands)
    }
    for (const entry of section('snap')) expect(snapFigureBox(image(entry.image), entry.box)).toEqual(entry.result)
    for (const entry of section('frames')) {
      expect(figureFrames(image(entry.image))).toEqual(entry.frames)
      expect(frameHints(image(entry.image))).toBe(entry.hints)
    }
    for (const entry of section('resolve_figures')) {
      const boxes = new FigureBoxes()
      for (const box of entry.boxes as unknown[][]) boxes.set(box[0] as string, figureBox(box[1] as number, box[2] as number, box[3] as number, box[4] as number))
      if (Array.isArray(entry.resolved)) {
        const result = resolveFigureBoxes(image(entry.image), boxes)
        expect(result.map((item) => [item.key, ...item.box])).toEqual(entry.resolved)
      } else {
        expectError(LatexError, entry.error, () => resolveFigureBoxes(image(entry.image), boxes))
      }
    }
  })
})
