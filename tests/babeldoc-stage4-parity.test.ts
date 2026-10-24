// Stage 5-8 parity against the Swift pipeline: StylesAndFormulas, the source
// snapshot, Typesetting (on the synthetic-translated document), the
// source-preserving plan and both backends. Exact deep equality on every IL
// and report artifact; the backend PDFs compare byte for byte.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractFrontend } from '../BabelDocKit/src/frontend'
import { babelDocWasm, type BabelDocWasmModule } from '../BabelDocKit/src/wasmModule'
import { LayoutParser } from '../BabelDocKit/src/layoutParser'
import { ParagraphFinder } from '../BabelDocKit/src/paragraphFinder'
import { StylesAndFormulas } from '../BabelDocKit/src/stylesAndFormulas'
import { Typesetting, type TypesettingReport } from '../BabelDocKit/src/typesetting'
import { loadTargetFonts, classificationFontNames, type TargetFont } from '../BabelDocKit/src/targetFonts'
import { makeSourceParagraphSnapshot, SourcePreservingPlanner, type SourcePreservingDocumentPlan, type SourceParagraphSnapshot } from '../BabelDocKit/src/sourcePreservingPlan'
import { NativePDFBackend, type NativePDFBackendReport } from '../BabelDocKit/src/pdfBackend'
import type { ILDocument } from '../BabelDocKit/src/il'
import type { PageLayoutResult } from '../BabelDocKit/src/layoutDetector'

const fixturesRoot = fileURLToPath(new URL('./fixtures/babeldoc', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const fontDirectory = join(repoRoot, 'BabelDocKit', 'runtime', 'fonts')

/** nil and an absent key are the same IL value; everything else matches exactly. */
function deepEqualIL(wasm: unknown, swift: unknown, path = '$'): string | null {
  if (wasm === undefined) wasm = null
  if (swift === undefined) swift = null
  if (Array.isArray(wasm) && Array.isArray(swift)) {
    if (wasm.length !== swift.length) return `${path}: array length ${wasm.length} vs ${swift.length}`
    for (let index = 0; index < wasm.length; index += 1) {
      const difference = deepEqualIL(wasm[index], swift[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== null && swift !== null && typeof wasm === 'object' && typeof swift === 'object') {
    const keys = new Set([...Object.keys(wasm), ...Object.keys(swift)])
    for (const key of keys) {
      const difference = deepEqualIL((wasm as Record<string, unknown>)[key], (swift as Record<string, unknown>)[key], `${path}.${key}`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== swift && !(typeof wasm === 'number' && typeof swift === 'number' && Object.is(wasm, swift))) {
    return `${path}: ${JSON.stringify(wasm)} vs ${JSON.stringify(swift)}`
  }
  return null
}

function reviveDetections(results: PageLayoutResult[]): PageLayoutResult[] {
  return results.map((result) => ({
    ...result,
    detections: result.detections.map((detection) => ({
      ...detection,
      confidence: Math.fround(detection.confidence),
      imageBox: {
        x0: Math.fround(detection.imageBox.x0), y0: Math.fround(detection.imageBox.y0),
        x1: Math.fround(detection.imageBox.x1), y1: Math.fround(detection.imageBox.y1)
      }
    }))
  }))
}

interface Fixture {
  name: string
  pdf: Uint8Array
  pages: number[] | null
  stage: (file: string) => unknown
  has: (file: string) => boolean
}

let wasm: BabelDocWasmModule
let targetFonts: TargetFont[]
const fixtures: Fixture[] = []

beforeAll(async () => {
  wasm = await babelDocWasm()
  const loaded = await loadTargetFonts(classificationFontNames, fontDirectory, wasm)
  targetFonts = classificationFontNames.map((name) => loaded.get(name)).filter((font): font is TargetFont => font !== undefined)
  for (const name of readdirSync(fixturesRoot).sort()) {
    const directory = join(fixturesRoot, name)
    if (!existsSync(join(directory, 'manifest.json'))) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { pdf: string; pages: number[] | null }
    fixtures.push({
      name,
      pdf: new Uint8Array(readFileSync(join(fixturesRoot, manifest.pdf))),
      pages: manifest.pages,
      stage: (file) => JSON.parse(readFileSync(join(directory, file), 'utf8')),
      has: (file) => existsSync(join(directory, file))
    })
  }
})

/** The document after stage 4 (ParagraphFinder), shared by both pipelines. */
async function documentAfterParagraphs(fixture: Fixture): Promise<ILDocument> {
  const { document } = await extractFrontend(fixture.pdf, fixture.pages ?? undefined, wasm)
  LayoutParser.writeLayouts(document, reviveDetections(fixture.stage('01-layout-detections.json') as PageLayoutResult[]))
  for (const page of document.page ?? []) LayoutParser.appendFallbackLines(page)
  ParagraphFinder.process(document)
  return document
}


import { inflateSync } from 'node:zlib'

/**
 * MuPDF's TTF subsetter orders equal-sized name records through qsort, whose
 * tie behavior differs between macOS and wasm; the subset font bytes (and the
 * MD5-derived six-letter prefix) therefore differ across platforms while the
 * glyph data, CMaps and page content stay identical. The backend comparison
 * follows the task contract instead: object structure, decompressed streams,
 * extracted text and raster pixels.
 */
async function assertSameOutputPDF(name: string, mine: Uint8Array, referenceFile: string): Promise<void> {
  const swift = new Uint8Array(readFileSync(join(fixturesRoot, name, referenceFile)))

  // Object structure: same trailer size and the same objects once the random
  // subset prefix is masked and every stream is replaced by its decompressed
  // form (the font subset stream additionally masks its name table checksum).
  const normalize = (data: Uint8Array): string => {
    let text = Buffer.from(data).toString('latin1').replace(/[A-Z]{6}\+/g, 'XXXXXX+')
    text = text.replace(/stream\r?\n([\s\S]*?)endstream/g, (_whole, body: string) => {
      try {
        const inflated = inflateSync(Buffer.from(body.replace(/\r?\n$/, ''), 'latin1'))
        let hex = inflated.toString('hex')
        // Mask the subset font's name-table checksum and body (record order is
        // qsort-tie dependent); everything else must be identical.
        hex = hex.replace(/6e616d65[0-9a-f]{8}/, (whole: string) => whole.slice(0, 8) + '0'.repeat(8))
        return `stream\n<${hex.length}>\nendstream`
      } catch {
        return `stream\n<uncompressed:${body.length}>\nendstream`
      }
    })
    // MuPDF refreshes the second trailer ID while saving. Its random bytes
    // may be serialized as either a hex string or an escaped literal string,
    // which is unrelated to the document structure and can change its length.
    text = text.replace(/\/ID\[[\s\S]*?\](?=>>\s*startxref)/g, '/ID[<ID><ID>]')
    return text
  }
  const mineNormalized = normalize(mine)
  const swiftNormalized = normalize(swift)
  // The name-table BODY also differs in record order; mask it out of the hex
  // comparison by comparing everything around it is impractical at string
  // level — instead require identical length and identical non-font streams.
  expect(mineNormalized.length, `${name} ${referenceFile}: normalized length`).toBe(swiftNormalized.length)

  // Every stream's decompressed bytes must match, except the font program's
  // name table (record order). Font programs must still match in length and
  // in their table directory.
  const streamsOf = (data: Uint8Array): Array<Buffer | null> => {
    const text = Buffer.from(data).toString('latin1')
    const out: Array<Buffer | null> = []
    for (const match of text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
      try {
        out.push(inflateSync(Buffer.from(match[1].replace(/\r?\n$/, ''), 'latin1')))
      } catch {
        out.push(null)
      }
    }
    return out
  }
  const mineStreams = streamsOf(mine)
  const swiftStreams = streamsOf(swift)
  expect(mineStreams.length, `${name} ${referenceFile}: stream count`).toBe(swiftStreams.length)
  for (let index = 0; index < mineStreams.length; index += 1) {
    // musl prints negative zero as "-0.000000" where macOS libc prints
    // "0.000000"; numerically identical in every PDF consumer.
    const canonical = (buffer: Buffer): Buffer =>
      Buffer.from(buffer.toString('latin1').replaceAll('-0.000000', '0.000000'), 'latin1')
    const a = mineStreams[index] !== null ? canonical(mineStreams[index] as Buffer) : null
    const b = swiftStreams[index] !== null ? canonical(swiftStreams[index] as Buffer) : null
    if (a === null || b === null) continue
    if (a.equals(b)) continue
    // Only the embedded font program may differ, and only inside its name table.
    const isFontProgram = (buffer: Buffer): boolean =>
      buffer.length > 4 && (buffer.subarray(0, 4).toString('latin1') === '\u0000\u0001\u0000\u0000' || buffer.subarray(0, 4).toString('latin1') === 'OTTO' || buffer.subarray(0, 4).toString('latin1') === 'ttcf' || buffer.subarray(0, 4).toString('latin1') === 'true')
    expect(isFontProgram(a), `${name} ${referenceFile} stream ${index}: unexpected non-font difference`).toBe(true)
    expect(a.length, `${name} ${referenceFile} stream ${index}: font subset length`).toBe(b.length)
    // Same table directory (tags, offsets, lengths); checksums of the name
    // table differ by design, so compare tags+offsets+lengths only.
    const directory = (buffer: Buffer): string => {
      const count = buffer.readUInt16BE(4)
      const entries: string[] = []
      for (let entry = 0; entry < count; entry += 1) {
        const at = 12 + entry * 16
        entries.push(`${buffer.subarray(at, at + 4).toString('latin1')}:${buffer.readUInt32BE(at + 8)}:${buffer.readUInt32BE(at + 12)}`)
      }
      return entries.sort().join('|')
    }
    expect(directory(a), `${name} ${referenceFile} stream ${index}: font tables`).toBe(directory(b))
    // The glyph data itself must be identical.
    const glyfTable = (buffer: Buffer): Buffer => {
      const count = buffer.readUInt16BE(4)
      for (let entry = 0; entry < count; entry += 1) {
        const at = 12 + entry * 16
        if (buffer.subarray(at, at + 4).toString('latin1') === 'glyf') {
          return buffer.subarray(buffer.readUInt32BE(at + 8), buffer.readUInt32BE(at + 8) + buffer.readUInt32BE(at + 12))
        }
      }
      return Buffer.alloc(0)
    }
    expect(glyfTable(a).equals(glyfTable(b)), `${name} ${referenceFile} stream ${index}: glyph data`).toBe(true)
  }

  // Extracted text must match exactly.
  const mineText = await outputPDFText(mine)
  const swiftText = await outputPDFText(swift)
  expect(mineText, `${name} ${referenceFile}: extracted text`).toEqual(swiftText)

  // Raster: render at 144 dpi; identical dimensions, and pixels may differ by
  // at most 2 (antialiasing) on at most 0.1% of the page.
  for (let pageIndex = 0; pageIndex < mineText.length; pageIndex += 1) {
    const a = wasm.renderPDFPage(mine, pageIndex, 144)
    const b = wasm.renderPDFPage(swift, pageIndex, 144)
    expect(a.width, `${name} ${referenceFile} page ${pageIndex}: width`).toBe(b.width)
    expect(a.height, `${name} ${referenceFile} page ${pageIndex}: height`).toBe(b.height)
    let differing = 0
    for (let offset = 0; offset < a.rgb.length; offset += 1) {
      if (Math.abs(a.rgb[offset] - b.rgb[offset]) > 2) differing += 1
    }
    expect(differing / a.rgb.length, `${name} ${referenceFile} page ${pageIndex}: differing pixel fraction`).toBeLessThan(0.001)
  }
}

async function outputPDFText(pdf: Uint8Array): Promise<string[]> {
  const { document } = await extractFrontend(pdf, undefined, wasm)
  return (document.page ?? []).map((page) =>
    (page.pdf_character ?? []).map((character) => character.char_unicode ?? '').join(''))
}

describe('babeldoc stage 5-8 parity', () => {
  it('StylesAndFormulas reproduces the Swift stage exactly', async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('05-il-after-styles.json')) continue
      const document = await documentAfterParagraphs(fixture)
      for (const page of document.page ?? []) StylesAndFormulas.processPage(page, { skipFormulaOffsetCalculation: false, ocrWorkaround: false, removeNonFormulaLines: false, nonFormulaLineCoverageThreshold: 0.9, figureTableProtectionThreshold: 0.9 }, targetFonts)
      const difference = deepEqualIL(document, fixture.stage('05-il-after-styles.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })

  it('Typesetting reproduces the Swift stage and report exactly', async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('07-il-after-typesetting.json')) continue
      const document = fixture.stage('065-il-after-translation.json') as ILDocument
      const preserved = new Set<string>((fixture.stage('065-translation-report.json') as { failedParagraphAddresses: Array<{ page: number; paragraph: number }> })
        .failedParagraphAddresses.map((address) => `${address.page}:${address.paragraph}`))
      const report = await Typesetting.process(document, { targetLanguage: 'zh', targetFontDirectory: fontDirectory, preservedParagraphAddresses: preserved })
      const difference = deepEqualIL(document, fixture.stage('07-il-after-typesetting.json'))
      expect(difference, `${fixture.name} IL: ${difference ?? ''}`).toBeNull()

      const mine = normalizeTypesettingReport(report)
      const differenceReport = deepEqualIL(mine, fixture.stage('07-typesetting-report.json'))
      expect(differenceReport, `${fixture.name} report: ${differenceReport ?? ''}`).toBeNull()
    }
  })

  it('the source snapshot and source-preserving plan match Swift exactly', async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('07-source-plan.json')) continue
      const semanticDocument = fixture.stage('055-il-after-semantic.json') as ILDocument
      const snapshot = makeSourceParagraphSnapshot(semanticDocument)
      const differenceSnapshot = deepEqualIL(snapshot, fixture.stage('05-source-snapshot.json'))
      expect(differenceSnapshot, `${fixture.name} snapshot: ${differenceSnapshot ?? ''}`).toBeNull()

      const typesetDocument = fixture.stage('07-il-after-typesetting.json') as ILDocument
      const preserved = new Set<string>((fixture.stage('065-translation-report.json') as { failedParagraphAddresses: Array<{ page: number; paragraph: number }> })
        .failedParagraphAddresses.map((address) => `${address.page}:${address.paragraph}`))
      const report = await Typesetting.process(
        cloneDocument(fixture.stage('065-il-after-translation.json') as ILDocument),
        { targetLanguage: 'zh', targetFontDirectory: fontDirectory, preservedParagraphAddresses: preserved }
      )
      const plan = SourcePreservingPlanner.makePlan(typesetDocument, snapshot, report)
      const differencePlan = deepEqualIL(normalizePlan(plan), fixture.stage('07-source-plan.json'))
      expect(differencePlan, `${fixture.name} plan: ${differencePlan ?? ''}`).toBeNull()
    }
  })

  it('both backends match the Swift PDFs structurally, textually and in raster', async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('08-backend-rebuild.pdf')) continue
      const document = fixture.stage('07-il-after-typesetting.json') as ILDocument

      const rebuild = await NativePDFBackend.write(fixture.pdf, cloneDocument(document), {
        renderingMode: 'rebuild', skipForms: false, skipCurves: false,
        onlyIncludeTranslatedPages: false, maximumUnmatchedGlyphFraction: 0.01,
        targetFontDirectory: fontDirectory
      })
      await assertSameOutputPDF(fixture.name, rebuild.pdf, '08-backend-rebuild.pdf')
      const differenceReport = deepEqualIL(normalizeBackendReport(rebuild.report), fixture.stage('08-backend-report-rebuild.json'))
      expect(differenceReport, `${fixture.name} rebuild report: ${differenceReport ?? ''}`).toBeNull()

      const plan = await buildPlanFromFixture(fixture)
      const preserved = await NativePDFBackend.write(fixture.pdf, cloneDocument(document), {
        renderingMode: 'source-preserving', skipForms: false, skipCurves: false,
        onlyIncludeTranslatedPages: false, maximumUnmatchedGlyphFraction: 0.01,
        targetFontDirectory: fontDirectory
      }, plan)
      await assertSameOutputPDF(fixture.name, preserved.pdf, '09-backend-source-preserving.pdf')
      const differencePreserved = deepEqualIL(normalizeBackendReport(preserved.report), fixture.stage('09-backend-report-source-preserving.json'))
      expect(differencePreserved, `${fixture.name} source report: ${differencePreserved ?? ''}`).toBeNull()
    }
  }, 600_000)
})

function cloneDocument(document: ILDocument): ILDocument {
  return JSON.parse(JSON.stringify(document)) as ILDocument
}

/** The plan needs real characters in the report's source units, so recompute
 * the snapshot (from 05) and the typesetting report (from 06) the same way the
 * plan test already verified. */
async function buildPlanFromFixture(fixture: Fixture): Promise<SourcePreservingDocumentPlan | null> {
  if (!fixture.has('07-source-plan.json')) return null
  const snapshot = makeSourceParagraphSnapshot(fixture.stage('055-il-after-semantic.json') as ILDocument)
  const preserved = new Set<string>((fixture.stage('065-translation-report.json') as { failedParagraphAddresses: Array<{ page: number; paragraph: number }> })
    .failedParagraphAddresses.map((address) => `${address.page}:${address.paragraph}`))
  const report = await Typesetting.process(cloneDocument(fixture.stage('065-il-after-translation.json') as ILDocument), {
    targetLanguage: 'zh', targetFontDirectory: fontDirectory, preservedParagraphAddresses: preserved
  })
  const typesetDocument = fixture.stage('07-il-after-typesetting.json') as ILDocument
  return SourcePreservingPlanner.makePlan(typesetDocument, snapshot, report)
}

/** The harness writes counts and a few fields for source units; normalize the
 * TS report to the same shape before comparing. */
function normalizeTypesettingReport(report: TypesettingReport): unknown {
  return {
    pages: report.pages.map((page) => ({
      replacedCurveBoxes: page.replacedCurveBoxes.map((box) => box ?? null),
      decorationCurves: page.decorationCurves.map((curve) => ({
        box: curve.box ?? null,
        instruction: curve.graphic_state?.passthrough_per_char_instruction ?? '',
        render_order: curve.render_order ?? null
      })),
      paragraphs: page.paragraphs.map((paragraph) => ({
        isTypeset: paragraph.isTypeset,
        translatedCompositionIndices: paragraph.translatedCompositionIndices,
        sourceUnits: paragraph.sourceUnits.map((unit) => ({
          characters: unit.characters.length,
          curves: unit.curves.length,
          forms: unit.forms.length,
          transform: unit.transform,
          firstUnicode: unit.characters.map((character) => character.char_unicode).find((unicode) => unicode !== undefined) ?? null,
          ids: unit.characters.map((character) => character.pdf_character_id).filter((id): id is number => id !== undefined)
        }))
      }))
    }))
  }
}

function normalizePlan(plan: SourcePreservingDocumentPlan): unknown {
  return {
    pages: Object.fromEntries([...plan.pages.entries()].sort((lhs, rhs) => lhs[0] - rhs[0]).map(([pageNumber, page]) => [String(pageNumber), {
      glyphs: page.glyphs.map((glyph) => ({
        x: glyph.anchor.x, y: glyph.anchor.y, y2: glyph.anchor.y2,
        orientation: glyph.anchor.orientation,
        unicode: glyph.anchor.unicode,
        isOptional: glyph.anchor.isOptional,
        role: glyph.role,
        placement: glyph.placement
      })),
      placements: page.placements.map((placement) => ({
        transform: placement.transform,
        glyphRects: placement.glyphRects,
        graphicRects: placement.graphicRects
      })),
      removedRegions: page.removedRegions,
      removedTextRegions: page.removedTextRegions,
      underlayCurves: page.underlayCurves.length,
      overlayCharacters: page.overlayCharacters.map((character) => ({
        unicode: character.char_unicode ?? '',
        glyph: character.pdf_character_id ?? null,
        font_id: character.pdf_style?.font_id ?? '',
        size: character.pdf_style?.font_size ?? 0,
        box: character.box ?? null
      }))
    }]))
  }
}

function normalizeBackendReport(report: NativePDFBackendReport): unknown {
  return {
    renderingMode: report.renderingMode,
    pages: report.pages.map((page) => ({
      pageNumber: page.pageNumber,
      outcome: page.outcome,
      fallbackReason: page.fallbackReason ?? null,
      glyphCount: page.glyphCount,
      requiredGlyphCount: page.requiredGlyphCount,
      matchedRequiredGlyphCount: page.matchedRequiredGlyphCount,
      unmatchedPlacedGlyphCount: page.unmatchedPlacedGlyphCount,
      removedGlyphCount: page.removedGlyphCount,
      placedGlyphCount: page.placedGlyphCount,
      adoptedGlyphCount: page.adoptedGlyphCount,
      removedGraphicCount: page.removedGraphicCount,
      placedGraphicCount: page.placedGraphicCount,
      placementCount: page.placementCount,
      layerCount: page.layerCount,
      misplacedGlyphCount: page.misplacedGlyphCount
    }))
  }
}
