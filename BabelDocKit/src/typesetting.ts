// Stage 7 typesetting, ported from Swift Typesetting: unit construction from
// translated/source compositions, scale search with box expansion, TOC line
// and page-marker layouts, code-background decoration curves and relocation.
// Glyph ids and advances come from the wasm MuPDF target fonts.
import {
  boxCoordinates, pythonBool,
  type ILBox, type ILDocument, type ILPage, type ILPdfCurve, type ILPdfCharacter,
  type ILPdfFormula, type ILPdfLine, type ILPdfParagraph, type ILPdfParagraphComposition, type ILPdfStyle, type PythonDebugInfo
} from './il'
import { CodeTextClassifier } from './codeTextClassifier'
import { TableOfContentsDotLeader } from './tableOfContentsDotLeader'
import { createTargetFontMapper, targetFontFamily, type TargetFont, type TargetFontMapper } from './targetFonts'
import type { SemanticParagraphAddress } from './layoutContinuation'

export interface TypesettingConfiguration {
  targetLanguage: string
  targetFontDirectory?: string | null
  preservedParagraphAddresses: Set<string>
}

export const defaultTypesettingConfiguration: TypesettingConfiguration = {
  targetLanguage: 'zh',
  targetFontDirectory: null,
  preservedParagraphAddresses: new Set()
}

export function addressKey(address: SemanticParagraphAddress): string {
  return `${address.pageIndex}:${address.paragraphIndex}`
}

/** What typesetting did with source content, per page and paragraph. */
export interface TypesettingSourceUnit {
  characters: ILPdfCharacter[]
  curves: ILPdfCurve[]
  forms: Array<Record<string, unknown>>
  transform: number[] | null
}

export interface TypesettingParagraphReport {
  isTypeset: boolean
  sourceUnits: TypesettingSourceUnit[]
  translatedCompositionIndices: number[]
}

export interface TypesettingPageReport {
  paragraphs: TypesettingParagraphReport[]
  replacedCurveBoxes: Array<ILBox | undefined>
  decorationCurves: ILPdfCurve[]
}

export interface TypesettingReport {
  pages: TypesettingPageReport[]
}

export const Typesetting = {
  validateTargetLanguage(language: string): void {
    targetFontFamily(language)
  },

  async process(
    document: ILDocument,
    configuration: TypesettingConfiguration = defaultTypesettingConfiguration
  ): Promise<TypesettingReport> {
    const fontDirectory = configuration.targetFontDirectory ?? process.env.BABELDOC_FONT_DIRECTORY ?? 'BabelDocKit/runtime/fonts'
    const mapper = await createTargetFontMapper(configuration.targetLanguage, fontDirectory)
    const weightedScales: number[] = []
    for (const [pageIndex, page] of (document.page ?? []).entries()) {
      const codeFontIDs = CodeTextClassifier.fontIDs(page)
      for (const [paragraphIndex, paragraph] of (page.pdf_paragraph ?? []).entries()) {
        const address = { pageIndex, paragraphIndex }
        if (configuration.preservedParagraphAddresses.has(addressKey(address))) {
          paragraph.optimal_scale = 1
          continue
        }
        const units = makeUnits(paragraph, page, mapper, codeFontIDs)
        const unitCount = units.reduce((count, unit) => count + (unit.formula ? (unit.formula.pdf_character ?? []).length : 1), 0)
        let scale: number
        if (units.every((unit) => unitImplementation.canPassthrough(unit))) {
          scale = 1
        } else if (layoutTableOfContentsLine(units, paragraph, 1, false)) {
          scale = (layoutTableOfContentsLine(units, paragraph, 1, false) as { scale: number }).scale
        } else if (layoutTableOfContentsPageMarker(units, paragraph, 1, false)) {
          scale = (layoutTableOfContentsPageMarker(units, paragraph, 1, false) as { scale: number }).scale
        } else {
          scale = findLayout(units, paragraph, page, 1, mapper.isCJK, mapper.base, false).scale
        }
        paragraph.optimal_scale = scale
        for (let count = 0; count < unitCount; count += 1) weightedScales.push(scale)
      }
    }

    const modeScale = stableMode(weightedScales)
    if (modeScale !== undefined) {
      for (const [pageIndex, page] of (document.page ?? []).entries()) {
        for (const [paragraphIndex, paragraph] of (page.pdf_paragraph ?? []).entries()) {
          const address = { pageIndex, paragraphIndex }
          if (configuration.preservedParagraphAddresses.has(addressKey(address))) continue
          if (paragraph.optimal_scale !== undefined && paragraph.optimal_scale > modeScale) {
            paragraph.optimal_scale = modeScale
          }
        }
      }
    }

    const report: TypesettingReport = { pages: [] }
    for (const [pageIndex, page] of (document.page ?? []).entries()) {
      const codeFontIDs = CodeTextClassifier.fontIDs(page)
      const decorations = makeCodeDecorationPlans(page, codeFontIDs)
      const pageReport: TypesettingPageReport = {
        paragraphs: [],
        replacedCurveBoxes: [...decorations.curveIndices].sort((lhs, rhs) => lhs - rhs)
          .map((index) => (page.pdf_curve ?? [])[index]?.box),
        decorationCurves: []
      }
      if (decorations.curveIndices.size > 0) {
        page.pdf_curve = (page.pdf_curve ?? []).filter((_, index) => !decorations.curveIndices.has(index))
      }
      adjustParagraphPositions(page, pageIndex, configuration.preservedParagraphAddresses)
      renderPage(page, pageIndex, mapper, codeFontIDs, decorations.paragraphs, configuration.preservedParagraphAddresses, pageReport)
      remapUnsafeSourceGlyphs(page, mapper)
      report.pages.push(pageReport)
    }
    return report
  }
}

type UnitOrigin = { kind: 'character'; character: ILPdfCharacter } | { kind: 'formula'; formula: ILPdfFormula } | null

interface Unit {
  sourceCharacter?: ILPdfCharacter
  sourceAnchorBox?: ILBox
  formula?: ILPdfFormula
  unicode?: string
  font?: TargetFont
  fontSize?: number
  style?: ILPdfStyle
  xobjID?: number
  debugInfo?: PythonDebugInfo
  codeSpanIndex?: number
  x?: number
  y?: number
  scale?: number
  origin: UnitOrigin
  sourceTransform?: number[]
}

interface LayoutResult {
  scale: number
  units: Unit[] | null
  box: ILBox | undefined
}

interface CodeDecorationStyle {
  color: { r: number; g: number; b: number }
  left: number
  right: number
  bottom: number
  top: number
}

interface PageCodeDecorations {
  paragraphs: Array<Map<number, CodeDecorationStyle>>
  curveIndices: Set<number>
}

/** Swift resolves the glyph inside advance(for:); a missing glyph reports the
 * font size itself (the PyMuPDF behavior BabelDOC relies on). */
function advanceForCharacter(font: TargetFont, unicode: string, size: number): number {
  const codePoint = unicode.codePointAt(0)
  const glyph = codePoint === undefined ? null : font.glyph(codePoint)
  if (glyph === null) return size
  return font.advance(glyph, size)
}

const unitImplementation = {
  canPassthrough(unit: Unit): boolean {
    return unit.unicode === undefined
  },
  isSourceBacked(unit: Unit): boolean {
    return unit.sourceCharacter !== undefined || unit.sourceAnchorBox !== undefined
  },
  string(unit: Unit): string | undefined {
    return unit.sourceCharacter?.char_unicode ?? unit.unicode
  },
  isSpace(unit: Unit): boolean {
    return unit.formula === undefined && unitImplementation.string(unit) === ' '
  },
  isCJK(unit: Unit): boolean {
    return unit.formula === undefined && isCJK(unitImplementation.string(unit))
  },
  mixedBlacklist(unit: Unit): boolean {
    return ['。', '，', '：', '？', '！'].includes(unitImplementation.string(unit) ?? '')
  },
  canBreakLine(unit: Unit): boolean {
    return unit.formula !== undefined || !isUnbreakableLatin(unitImplementation.string(unit))
  },
  isHungPunctuation(unit: Unit): boolean {
    return hungPunctuation.has(unitImplementation.string(unit) ?? '')
  },
  cannotAppearAtLineEnd(unit: Unit): boolean {
    return openingPunctuation.has(unitImplementation.string(unit) ?? '')
  },
  box(unit: Unit): ILBox | undefined {
    if (unit.sourceCharacter) {
      const box = unit.sourceCharacter.box
      if (!box) return undefined
      const copy: ILBox = { ...box }
      const visual = unit.sourceCharacter.visual_bbox?.box
      if (visual) {
        copy.y = visual.y
        copy.y2 = visual.y2
      }
      return copy
    }
    if (unit.formula) return unit.formula.box
    if (unit.unicode === undefined || !unit.font || unit.fontSize === undefined) return undefined
    const width = advanceForCharacter(unit.font, unit.unicode, unit.fontSize)
    if (unit.x !== undefined && unit.y !== undefined) {
      return { x: unit.x, y: unit.y, x2: unit.x + width, y2: unit.y + unit.fontSize }
    }
    return { x: 0, y: 0, x2: width, y2: unit.fontSize }
  }
}

function unitWidth(unit: Unit): number {
  const box = boxCoordinates(unitImplementation.box(unit))
  return box ? box.x2 - box.x : 0
}

function unitHeight(unit: Unit): number {
  const box = boxCoordinates(unitImplementation.box(unit))
  return box ? box.y2 - box.y : 0
}

function makeUnits(
  paragraph: ILPdfParagraph,
  page: ILPage,
  mapper: TargetFontMapper,
  codeFontIDs: Set<string>
): Unit[] {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  if (compositions.length === 0) return []
  // External or legacy IL can contain duplicate resource IDs; last wins.
  const pageFonts = new Map<string, NonNullable<ILPage['pdf_font']>[number]>()
  for (const font of page.pdf_font ?? []) {
    if (font.font_id !== undefined) pageFonts.set(font.font_id, font)
  }
  const xobjectFonts = new Map<number, Map<string, NonNullable<ILPage['pdf_font']>[number]>>()
  for (const xobject of page.pdf_xobject ?? []) {
    const id = xobject.xobj_id
    if (id === undefined) continue
    const fonts = new Map(pageFonts)
    for (const font of xobject.pdf_font ?? []) {
      if (font.font_id !== undefined) fonts.set(font.font_id, font)
    }
    xobjectFonts.set(id, fonts)
  }
  const fonts = paragraph.xobj_id !== undefined ? xobjectFonts.get(paragraph.xobj_id) ?? pageFonts : pageFonts
  const codeSpans = codeSpanAssignments(paragraph, codeFontIDs)
  const result: Unit[] = []
  const sourceUnit = (character: ILPdfCharacter, codeSpanIndex: number | undefined): Unit => {
    const style = character.pdf_style
    const fontID = style?.font_id
    const originalFont = fontID !== undefined ? fonts.get(fontID) : undefined
    const unicode = character.char_unicode
    const canRender = style !== undefined
      && fontID !== undefined
      && originalFont !== undefined
      && originalFont.xref_id === undefined
      && (originalFont.font_subtype === 'Type0' || originalFont.encoding_length === 1)
      && character.pdf_character_id !== undefined
      && character.pdf_character_id < 256
      && unicode !== undefined
      && [...unicode].length === 1
      && style.font_size !== undefined
    if (!canRender) {
      return { sourceCharacter: character, codeSpanIndex, origin: { kind: 'character', character } }
    }
    const targetFont = mapper.map(originalFont as { bold?: boolean | number }, unicode as string)
    if (!targetFont) {
      return { sourceCharacter: character, codeSpanIndex, origin: { kind: 'character', character } }
    }
    // Rebuilt page streams cannot reuse low source CIDs from Type0 fonts or
    // synthesized fonts with no reusable xref; render them through the mapper.
    return {
      sourceAnchorBox: character.box,
      unicode,
      font: targetFont,
      fontSize: (style as ILPdfStyle).font_size,
      style,
      xobjID: character.xobj_id,
      debugInfo: character.debug_info,
      codeSpanIndex,
      origin: { kind: 'character', character }
    }
  }
  for (const [compositionIndex, composition] of compositions.entries()) {
    const codeSpanIndex = codeSpans.get(compositionIndex)
    if (composition.pdf_line) {
      result.push(...(composition.pdf_line.pdf_character ?? []).map((character) => sourceUnit(character, codeSpanIndex)))
    } else if (composition.pdf_character) {
      result.push(sourceUnit(composition.pdf_character, codeSpanIndex))
    } else if (composition.pdf_same_style_characters) {
      result.push(...(composition.pdf_same_style_characters.pdf_character ?? []).map((character) => sourceUnit(character, codeSpanIndex)))
    } else if (composition.pdf_same_style_unicode_characters) {
      const translated = composition.pdf_same_style_unicode_characters
      const style = translated.pdf_style
      const fontID = style?.font_id
      const originalFont = fontID !== undefined ? fonts.get(fontID) : undefined
      const fontSize = style?.font_size
      const text = translated.unicode
      if (style && fontID !== undefined && originalFont !== undefined && fontSize !== undefined && text) {
        for (const scalar of [...text]) {
          if (scalar.codePointAt(0) === 10) continue
          const font = mapper.map(originalFont as { bold?: boolean | number }, scalar)
          if (!font) continue
          result.push({
            unicode: scalar,
            font,
            fontSize,
            style,
            xobjID: paragraph.xobj_id,
            debugInfo: translated.debug_info ?? false,
            codeSpanIndex,
            origin: null
          })
        }
      }
    } else if (composition.pdf_formula) {
      result.push({
        formula: composition.pdf_formula,
        codeSpanIndex,
        origin: { kind: 'formula', formula: composition.pdf_formula }
      })
    }
  }
  return result
}

function remapUnsafeSourceGlyphs(page: ILPage, mapper: TargetFontMapper): void {
  const pageFonts = new Map<string, NonNullable<ILPage['pdf_font']>[number]>()
  for (const font of page.pdf_font ?? []) {
    if (font.font_id !== undefined) pageFonts.set(font.font_id, font)
  }
  const xobjectFonts = new Map<number, Map<string, NonNullable<ILPage['pdf_font']>[number]>>()
  for (const xobject of page.pdf_xobject ?? []) {
    const id = xobject.xobj_id
    if (id === undefined) continue
    const fonts = new Map(pageFonts)
    for (const font of xobject.pdf_font ?? []) {
      if (font.font_id !== undefined) fonts.set(font.font_id, font)
    }
    xobjectFonts.set(id, fonts)
  }
  const remap = (character: ILPdfCharacter, defaultXObjectID: number | undefined): ILPdfCharacter => {
    const fonts = (character.xobj_id ?? defaultXObjectID) !== undefined
      ? xobjectFonts.get((character.xobj_id ?? defaultXObjectID) as number) ?? pageFonts
      : pageFonts
    const style = character.pdf_style
    const fontID = style?.font_id
    const originalFont = fontID !== undefined ? fonts.get(fontID) : undefined
    const unicode = character.char_unicode
    if (
      !style || fontID === undefined || !originalFont || originalFont.xref_id !== undefined
      || !(originalFont.font_subtype === 'Type0' || originalFont.encoding_length === 1)
      || character.pdf_character_id === undefined || character.pdf_character_id >= 256
      || unicode === undefined || [...unicode].length !== 1
    ) {
      return character
    }
    const compatibleUnicode = unicode.normalize('NFKC')
    const renderUnicode = compatibleUnicode === '∘' ? '◦' : compatibleUnicode
    if ([...renderUnicode].length !== 1) return character
    const mappingFont = renderUnicode !== unicode ? { ...originalFont, italic: true } : originalFont
    const targetFont = mapper.map(mappingFont as { bold?: boolean | number }, renderUnicode)
    const codePoint = renderUnicode.codePointAt(0)
    const targetGlyph = targetFont && codePoint !== undefined ? targetFont.glyph(codePoint) : null
    if (!targetFont || targetGlyph === null) return character
    return {
      ...character,
      pdf_style: { graphic_state: style.graphic_state, font_id: targetFont.id, font_size: style.font_size },
      pdf_character_id: targetGlyph,
      char_unicode: renderUnicode
    }
  }

  page.pdf_character = (page.pdf_character ?? []).map((character) => remap(character, undefined))
  for (const paragraph of page.pdf_paragraph ?? []) {
    for (const composition of paragraph.pdf_paragraph_composition ?? []) {
      if (composition.pdf_character) {
        composition.pdf_character = remap(composition.pdf_character, paragraph.xobj_id)
      } else if (composition.pdf_formula) {
        composition.pdf_formula.pdf_character = (composition.pdf_formula.pdf_character ?? [])
          .map((character) => remap(character, paragraph.xobj_id))
      }
    }
  }
}

function renderPage(
  page: ILPage,
  pageIndex: number,
  mapper: TargetFontMapper,
  codeFontIDs: Set<string>,
  decorationPlans: Array<Map<number, CodeDecorationStyle>>,
  preservedParagraphAddresses: Set<string>,
  report: TypesettingPageReport
): void {
  const paragraphs = page.pdf_paragraph ?? []
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const address = { pageIndex, paragraphIndex }
    if (preservedParagraphAddresses.has(addressKey(address))) {
      const preserved = preservedCompositions(paragraph.pdf_paragraph_composition ?? [])
      paragraph.scale = 1
      paragraph.pdf_paragraph_composition = preserved.compositions
      page.pdf_curve = [...(page.pdf_curve ?? []), ...preserved.curves]
      page.pdf_form = [...(page.pdf_form ?? []), ...preserved.forms]
      report.paragraphs.push({ isTypeset: false, sourceUnits: [], translatedCompositionIndices: [] })
      continue
    }
    const units = makeUnits(paragraph, page, mapper, codeFontIDs)
    if (units.every((unit) => unitImplementation.canPassthrough(unit))) {
      const preserved = preservedCompositions(units.flatMap(passthrough))
      paragraph.scale = 1
      paragraph.pdf_paragraph_composition = preserved.compositions
      page.pdf_curve = [...(page.pdf_curve ?? []), ...preserved.curves]
      page.pdf_form = [...(page.pdf_form ?? []), ...preserved.forms]
      report.paragraphs.push({ isTypeset: false, sourceUnits: [], translatedCompositionIndices: [] })
      continue
    }
    const initialScale = paragraph.optimal_scale ?? 1
    const result = layoutTableOfContentsLine(units, paragraph, initialScale, true)
      ?? layoutTableOfContentsPageMarker(units, paragraph, initialScale, true)
      ?? findLayout(units, paragraph, page, initialScale, mapper.isCJK, mapper.base, true)
    if (!result.units) {
      paragraph.pdf_paragraph_composition = []
      report.paragraphs.push({ isTypeset: true, sourceUnits: [], translatedCompositionIndices: [] })
      continue
    }
    paragraph.scale = result.scale
    if (result.box) paragraph.box = result.box
    if (decorationPlans[paragraphIndex]) {
      const decorations = codeDecorationCurves(units, decorationPlans[paragraphIndex], paragraph)
      page.pdf_curve = [...(page.pdf_curve ?? []), ...decorations]
      report.decorationCurves.push(...decorations)
    }
    const compositions: ILPdfParagraphComposition[] = []
    const paragraphReport: TypesettingParagraphReport = { isTypeset: true, sourceUnits: [], translatedCompositionIndices: [] }
    for (const unit of result.units) {
      const rendered = render(unit)
      if (unit.origin?.kind === 'character') {
        paragraphReport.sourceUnits.push({
          characters: [unit.origin.character], curves: [], forms: [], transform: unit.sourceTransform ?? null
        })
      } else if (unit.origin?.kind === 'formula') {
        paragraphReport.sourceUnits.push({
          characters: unit.origin.formula.pdf_character ?? [],
          curves: unit.origin.formula.pdf_curve ?? [],
          forms: (unit.origin.formula.pdf_form ?? []) as unknown as Array<Record<string, unknown>>,
          transform: unit.sourceTransform ?? null
        })
      } else {
        for (let index = 0; index < rendered.characters.length; index += 1) {
          paragraphReport.translatedCompositionIndices.push(compositions.length + index)
        }
      }
      compositions.push(...rendered.characters.map((character) => ({ pdf_character: character })))
      page.pdf_curve = [...(page.pdf_curve ?? []), ...rendered.curves]
      page.pdf_form = [...(page.pdf_form ?? []), ...rendered.forms] as NonNullable<ILPage['pdf_form']>
    }
    paragraph.pdf_paragraph_composition = compositions
    updateRenderOrder(paragraph)
    report.paragraphs.push(paragraphReport)
  }
}

function preservedCompositions(compositions: ILPdfParagraphComposition[]): {
  compositions: ILPdfParagraphComposition[]
  curves: ILPdfCurve[]
  forms: NonNullable<ILPage['pdf_form']>
} {
  const flattened: ILPdfParagraphComposition[] = []
  const curves: ILPdfCurve[] = []
  const forms: NonNullable<ILPage['pdf_form']> = []
  for (const composition of compositions) {
    if (composition.pdf_line) {
      flattened.push(...(composition.pdf_line.pdf_character ?? []).map((character) => ({ pdf_character: character })))
    } else if (composition.pdf_character) {
      flattened.push({ pdf_character: composition.pdf_character })
    } else if (composition.pdf_same_style_characters) {
      flattened.push(...(composition.pdf_same_style_characters.pdf_character ?? []).map((character) => ({ pdf_character: character })))
    } else if (composition.pdf_formula) {
      flattened.push({ pdf_formula: composition.pdf_formula })
      curves.push(...(composition.pdf_formula.pdf_curve ?? []))
      forms.push(...(composition.pdf_formula.pdf_form ?? []))
    } else {
      // Preserve unknown future compositions rather than deleting them.
      flattened.push(composition)
    }
  }
  return { compositions: flattened, curves, forms }
}

function codeSpanAssignments(paragraph: ILPdfParagraph, codeFontIDs: Set<string>): Map<number, number> {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  if (compositions.length === 0) return new Map()
  const members = compositions.map((composition) =>
    composition.pdf_same_style_characters
      ? CodeTextClassifier.isCodeStyle(composition.pdf_same_style_characters.pdf_style, codeFontIDs)
      : false)
  for (let index = 0; index < compositions.length; index += 1) {
    if (compositions[index].pdf_formula === undefined) continue
    let left = index - 1
    while (left >= 0 && compositions[left].pdf_formula !== undefined) left -= 1
    let right = index + 1
    while (right < compositions.length && compositions[right].pdf_formula !== undefined) right += 1
    if (left >= 0 && right < compositions.length && members[left] && members[right]) members[index] = true
  }
  const result = new Map<number, number>()
  let span = -1
  let previousWasMember = false
  for (let index = 0; index < compositions.length; index += 1) {
    if (!members[index]) {
      previousWasMember = false
      continue
    }
    if (!previousWasMember) span += 1
    result.set(index, span)
    previousWasMember = true
  }
  return result
}

function makeCodeDecorationPlans(page: ILPage, codeFontIDs: Set<string>): PageCodeDecorations {
  const paragraphs = page.pdf_paragraph ?? []
  const paragraphPlans = paragraphs.map(() => new Map<number, CodeDecorationStyle>())
  const claimedCurves = new Set<number>()
  paragraphs.forEach((paragraph, paragraphIndex) => {
    // A code-only paragraph keeps its original drawing operations verbatim.
    if (!paragraph.pdf_paragraph_composition?.some((composition) => composition.pdf_same_style_unicode_characters != null)) return
    const assignments = codeSpanAssignments(paragraph, codeFontIDs)
    if (assignments.size === 0) return
    const spanBoxes = new Map<number, Array<NonNullable<ReturnType<typeof boxCoordinates>>>>()
    for (const [compositionIndex, spanIndex] of assignments) {
      const composition = paragraph.pdf_paragraph_composition?.[compositionIndex]
      if (!composition) continue
      if (composition.pdf_same_style_characters) {
        const boxes = (composition.pdf_same_style_characters.pdf_character ?? [])
          .map((character) => boxCoordinates(character.visual_bbox?.box ?? character.box))
          .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
        spanBoxes.set(spanIndex, [...(spanBoxes.get(spanIndex) ?? []), ...boxes])
      } else if (composition.pdf_formula) {
        const box = boxCoordinates(composition.pdf_formula.box)
        if (box) spanBoxes.set(spanIndex, [...(spanBoxes.get(spanIndex) ?? []), box])
      }
    }
    ;(page.pdf_curve ?? []).forEach((curve, curveIndex) => {
      if (claimedCurves.has(curveIndex)) return
      if (!pythonBool(curve.fill_background)) return
      const curveBox = boxCoordinates(curve.box)
      const color = lightNeutralFillColor(curve.graphic_state)
      if (!curveBox || !color) return
      if (curve.xobj_id !== undefined && paragraph.xobj_id !== undefined && curve.xobj_id !== paragraph.xobj_id) return
      let best: { span: number; glyphs: Array<NonNullable<ReturnType<typeof boxCoordinates>>>; score: number } | null = null
      for (const [spanIndex, boxes] of spanBoxes) {
        const overlapping = boxes.filter((box) => intersectionArea(box, curveBox) > 0)
        const glyphUnion = union(overlapping)
        if (!glyphUnion) continue
        const intersection = intersectionArea(glyphUnion, curveBox)
        const denominator = Math.min(area(glyphUnion), area(curveBox))
        const score = denominator > 0 ? intersection / denominator : 0
        if (score >= 0.35 && score > (best?.score ?? -1)) best = { span: spanIndex, glyphs: overlapping, score }
      }
      if (!best) return
      const glyphUnion = union(best.glyphs)
      if (!glyphUnion) return
      claimedCurves.add(curveIndex)
      const padding = {
        left: clamp(glyphUnion.x - curveBox.x, 0, 8),
        right: clamp(curveBox.x2 - glyphUnion.x2, 0, 8),
        bottom: clamp(glyphUnion.y - curveBox.y, 0, 5),
        top: clamp(curveBox.y2 - glyphUnion.y2, 0, 5)
      }
      const existing = paragraphPlans[paragraphIndex].get(best.span)
      if (existing) {
        const style: CodeDecorationStyle = { ...existing }
        if (color.r + color.g + color.b > style.color.r + style.color.g + style.color.b) style.color = color
        style.left = Math.max(style.left, padding.left)
        style.right = Math.max(style.right, padding.right)
        style.bottom = Math.max(style.bottom, padding.bottom)
        style.top = Math.max(style.top, padding.top)
        paragraphPlans[paragraphIndex].set(best.span, style)
      } else {
        paragraphPlans[paragraphIndex].set(best.span, {
          color,
          left: Math.max(padding.left, 1.5),
          right: Math.max(padding.right, 1.5),
          bottom: Math.max(padding.bottom, 0.75),
          top: Math.max(padding.top, 0.75)
        })
      }
    })
  })
  return { paragraphs: paragraphPlans, curveIndices: claimedCurves }
}

function codeDecorationCurves(
  units: Unit[],
  styles: Map<number, CodeDecorationStyle>,
  paragraph: ILPdfParagraph
): ILPdfCurve[] {
  const result: ILPdfCurve[] = []
  for (const [spanIndex, style] of [...styles.entries()].sort((lhs, rhs) => lhs[0] - rhs[0])) {
    const boxes = units
      .filter((unit) => unit.codeSpanIndex === spanIndex)
      .map((unit) => boxCoordinates(unitImplementation.box(unit)))
      .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
      .sort((lhs, rhs) => (lhs.y2 === rhs.y2 ? lhs.x - rhs.x : lhs.y2 > rhs.y2 ? -1 : 1))
    const lines: Array<Array<NonNullable<ReturnType<typeof boxCoordinates>>>> = []
    for (const box of boxes) {
      const lineIndex = lines.findIndex((line) => {
        const lineBox = union(line)
        if (!lineBox) return false
        const overlap = Math.min(lineBox.y2, box.y2) - Math.max(lineBox.y, box.y)
        return overlap > Math.min(lineBox.y2 - lineBox.y, box.y2 - box.y) * 0.35
      })
      if (lineIndex >= 0) lines[lineIndex].push(box)
      else lines.push([box])
    }
    for (const line of lines) {
      const box = union(line)
      if (!box) continue
      const rectangle: ILBox = {
        x: box.x - style.left,
        y: box.y - style.bottom,
        x2: box.x2 + style.right,
        y2: box.y2 + style.top
      }
      const args = [rectangle.x ?? 0, rectangle.y ?? 0, (rectangle.x2 ?? 0) - (rectangle.x ?? 0), (rectangle.y2 ?? 0) - (rectangle.y ?? 0)]
      const instruction = `${style.color.r.toFixed(6)} ${style.color.g.toFixed(6)} ${style.color.b.toFixed(6)} rg`
      result.push({
        box: rectangle,
        graphic_state: { passthrough_per_char_instruction: instruction },
        pdf_original_path_primitive: { op: 're', args },
        debug_info: 'code-decoration',
        fill_background: true,
        stroke_path: false,
        evenodd: false,
        passthrough_paint: false,
        xobj_id: paragraph.xobj_id,
        render_order: Math.max((paragraph.render_order ?? 1) - 1, 0),
        ctm: [1, 0, 0, 1, 0, 0]
      })
    }
  }
  return result
}

function lightNeutralFillColor(state: { passthrough_per_char_instruction?: string } | undefined): { r: number; g: number; b: number } | null {
  const instruction = state?.passthrough_per_char_instruction
  if (!instruction) return null
  const tokens = instruction.split(/\s+/).filter((token) => token.length > 0)
  const numbers: number[] = []
  let result: [number, number, number] | null = null
  for (const token of tokens) {
    const number = Number(token)
    if (!Number.isNaN(number) && token.trim().length > 0) {
      numbers.push(number)
      continue
    }
    switch (token) {
      case 'rg':
        if (numbers.length >= 3) {
          result = [numbers[numbers.length - 3], numbers[numbers.length - 2], numbers[numbers.length - 1]]
        }
        break
      case 'g':
        if (numbers.length > 0) {
          const value = numbers[numbers.length - 1]
          result = [value, value, value]
        }
        break
      case 'sc':
      case 'scn':
        if (numbers.length >= 3) {
          result = [numbers[numbers.length - 3], numbers[numbers.length - 2], numbers[numbers.length - 1]]
        } else if (numbers.length > 0) {
          const value = numbers[numbers.length - 1]
          result = [value, value, value]
        }
        break
      default:
        break
    }
    numbers.length = 0
  }
  if (!result) return null
  const average = (result[0] + result[1] + result[2]) / 3
  const spread = Math.max(result[0], result[1], result[2]) - Math.min(result[0], result[1], result[2])
  if (!(average >= 0.82 && average <= 0.99 && spread <= 0.12)) return null
  return { r: result[0], g: result[1], b: result[2] }
}

function area(box: NonNullable<ReturnType<typeof boxCoordinates>>): number {
  return Math.max(box.x2 - box.x, 0) * Math.max(box.y2 - box.y, 0)
}

function intersectionArea(
  lhs: NonNullable<ReturnType<typeof boxCoordinates>>,
  rhs: NonNullable<ReturnType<typeof boxCoordinates>>
): number {
  return Math.max(Math.min(lhs.x2, rhs.x2) - Math.max(lhs.x, rhs.x), 0)
    * Math.max(Math.min(lhs.y2, rhs.y2) - Math.max(lhs.y, rhs.y), 0)
}

function union(boxes: Array<NonNullable<ReturnType<typeof boxCoordinates>>>): NonNullable<ReturnType<typeof boxCoordinates>> | null {
  if (boxes.length === 0) return null
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

function passthrough(unit: Unit): ILPdfParagraphComposition[] {
  if (unit.formula) return [{ pdf_formula: unit.formula }]
  if (unit.sourceCharacter) return [{ pdf_character: unit.sourceCharacter }]
  return []
}

function findLayout(
  units: Unit[],
  paragraph: ILPdfParagraph,
  page: ILPage,
  initialScale: number,
  isCJKLayout: boolean,
  baseFont: TargetFont,
  apply: boolean,
  useEnglishLineBreak = true
): LayoutResult {
  const paragraphBox = paragraph.box
  if (!paragraphBox) return { scale: initialScale, units: null, box: undefined }
  const box: ILBox = { ...paragraphBox }
  let scale = initialScale
  const lineSkip = isCJKLayout ? 1.5 : 1.3
  let expansion = 0
  while (scale >= 0.1 - 0.000001) {
    const attempt = layout(units, box, scale, lineSkip, pythonBool(paragraph.first_line_indent), useEnglishLineBreak, baseFont)
    if (attempt.fit) return { scale, units: apply ? attempt.units : null, box }
    if (paragraph.debug_id === undefined) return { scale, units: null, box }
    scale -= scale > 0.6 ? 0.05 : 0.1
    if (scale < 0.7) {
      let expanded = false
      if (expansion === 0) {
        const minimumY = maxBottomSpace(box, page) + 2
        if (box.y !== undefined && minimumY < box.y) { box.y = minimumY; expanded = true }
        expansion = 1
        if (expanded) continue
      } else if (expansion === 1) {
        const maximumX = maxRightSpace(box, page) - 5
        if (box.x2 !== undefined && maximumX > box.x2) { box.x2 = maximumX; expanded = true }
        expansion = 2
        if (expanded) continue
      }
      if (expansion < 2) scale = 1
    }
  }
  if (useEnglishLineBreak) {
    return findLayout(units, paragraph, page, initialScale, isCJKLayout, baseFont, apply, false)
  }
  return { scale: 0.1, units: null, box }
}

function layoutTableOfContentsLine(
  units: Unit[],
  paragraph: ILPdfParagraph,
  initialScale: number,
  apply: boolean
): LayoutResult | null {
  const bounds = boxCoordinates(paragraph.box)
  if (!bounds) return null
  const sourceStart = units.findIndex((unit) => unitImplementation.isSourceBacked(unit))
  if (sourceStart <= 0) return null
  if (!units.slice(0, sourceStart).every((unit) => !unitImplementation.isSourceBacked(unit) && unit.unicode !== undefined)) return null
  if (!units.slice(sourceStart).every((unit) => unitImplementation.isSourceBacked(unit))) return null
  const suffix = units.slice(sourceStart)
  const fragments = suffix.map((unit) => unitImplementation.string(unit) ?? '')
  const pageRange = TableOfContentsDotLeader.pageMarkerRange(fragments)
  if (!pageRange) return null
  const markerUnits = fragments.slice(pageRange.start, pageRange.end).map((_, offset) => suffix[pageRange.start + offset])
  const pageRightX = Math.max(...markerUnits.map((unit) => sourceCoordinates(unit)?.x2 ?? Number.NEGATIVE_INFINITY))
  if (!Number.isFinite(pageRightX)) return null

  const translated = units.slice(0, sourceStart)
  const translatedWidth = translated.reduce((sum, unit) => sum + unitWidth(unit), 0)
  const minimumGap = 2.0
  const markerWidth = markerUnits.reduce((sum, unit) => sum + unitWidth(unit), 0)
  const markerLeftX = pageRightX - markerWidth
  const availableWidth = markerLeftX - bounds.x - minimumGap
  if (translatedWidth <= 0 || availableWidth <= 0) return null
  const scale = Math.min(initialScale, availableWidth / translatedWidth)
  if (scale < 0.1) return null
  if (!apply) return { scale, units: null, box: paragraph.box }

  const heights = translated.map((unit) => unitHeight(unit))
  const commonHeight = stableMode(heights) ?? heights.reduce((sum, height) => sum + height, 0) / Math.max(heights.length, 1)
  let currentX = bounds.x
  const currentY = bounds.y2 - commonHeight * scale
  const laidOut: Unit[] = []
  for (const unit of translated) {
    const relocated = relocate(unit, currentX, currentY, scale)
    laidOut.push(relocated)
    currentX = boxCoordinates(unitImplementation.box(relocated))?.x2 ?? currentX
  }

  const safeLeaderStart = currentX + minimumGap
  suffix.forEach((unit, index) => {
    if (index >= pageRange.start && index < pageRange.end) return
    const anchored = unitAnchoredToSource(unit)
    const box = boxCoordinates(unitImplementation.box(anchored))
    if (box && box.x >= safeLeaderStart && box.x2 <= markerLeftX - minimumGap) {
      laidOut.push(anchored)
    }
  })
  let markerX = markerLeftX
  for (const unit of markerUnits) {
    const markerY = sourceCoordinates(unit)?.y ?? bounds.y
    const relocated = relocate(unit, markerX, markerY, 1)
    laidOut.push(relocated)
    markerX = boxCoordinates(unitImplementation.box(relocated))?.x2 ?? markerX
  }
  return { scale, units: laidOut, box: paragraph.box }
}

function layoutTableOfContentsPageMarker(
  units: Unit[],
  paragraph: ILPdfParagraph,
  initialScale: number,
  apply: boolean
): LayoutResult | null {
  if (paragraph.layout_label !== TableOfContentsDotLeader.pageMarkerLayoutLabel) return null
  const bounds = boxCoordinates(paragraph.box)
  if (!bounds || units.length === 0) return null
  if (!units.every((unit) => unitImplementation.isSourceBacked(unit))) return null
  if (!TableOfContentsDotLeader.isPageMarker(units.map((unit) => unitImplementation.string(unit) ?? ''))) return null
  const rightEdge = Math.max(...units.map((unit) => sourceCoordinates(unit)?.x2 ?? Number.NEGATIVE_INFINITY))
  if (!Number.isFinite(rightEdge)) return null
  const width = units.reduce((sum, unit) => sum + unitWidth(unit), 0)
  const availableWidth = rightEdge - bounds.x
  if (width <= 0 || availableWidth <= 0) return null
  const scale = Math.min(initialScale, availableWidth / width)
  if (scale < 0.1) return null
  if (!apply) return { scale, units: null, box: paragraph.box }

  let currentX = rightEdge - width * scale
  const laidOut: Unit[] = []
  for (const unit of units) {
    const y = sourceCoordinates(unit)?.y ?? bounds.y
    const relocated = relocate(unit, currentX, y, scale)
    laidOut.push(relocated)
    currentX = boxCoordinates(unitImplementation.box(relocated))?.x2 ?? currentX
  }
  return { scale, units: laidOut, box: paragraph.box }
}

function sourceCoordinates(unit: Unit): NonNullable<ReturnType<typeof boxCoordinates>> | null {
  return boxCoordinates(unit.sourceCharacter?.box ?? unit.sourceAnchorBox)
}

function unitAnchoredToSource(unit: Unit): Unit {
  if (unit.sourceCharacter !== undefined) return unit
  const box = sourceCoordinates(unit)
  if (!box) return unit
  return relocate(unit, box.x, box.y, 1)
}

function layout(
  input: Unit[],
  box: ILBox,
  scale: number,
  lineSkip: number,
  firstLineIndent: boolean,
  useEnglishLineBreak: boolean,
  baseFont: TargetFont | null
): { units: Unit[]; fit: boolean } {
  const bounds = boxCoordinates(box)
  if (!bounds || input.length === 0) return { units: [], fit: true }
  const fontSizes = input
    .map((unit) => unit.fontSize ?? unit.sourceCharacter?.pdf_style?.font_size)
    .filter((size): size is number => size !== undefined)
  const commonSize = stableMode(fontSizes)
  if (commonSize === undefined) return { units: [], fit: false }
  const spaceWidth = ((baseFont ? advanceForCharacter(baseFont, '你', commonSize * scale) : commonSize * scale)) * 0.5
  const heights = input.map((unit) => unitHeight(unit))
  const commonHeight = stableMode(heights) ?? heights.reduce((sum, height) => sum + height, 0) / Math.max(heights.length, 1)
  let currentX = bounds.x + (firstLineIndent ? spaceWidth * 4 : 0)
  let currentY = bounds.y2 - commonHeight * scale
  let currentHeights: number[] = []
  const result: Unit[] = []
  let fit = true

  for (let index = 0; index < input.length; index += 1) {
    const unit = input[index]
    const width = unitWidth(unit) * scale
    const height = unitHeight(unit) * scale
    if (currentX === bounds.x && unitImplementation.isSpace(unit)) continue
    const beforeBreak = useEnglishLineBreak ? widthBeforeBreak(input.slice(index), scale) : 0
    if (
      !unitImplementation.isHungPunctuation(unit)
      && (currentX + width > bounds.x2
        || currentX + width + beforeBreak > bounds.x2
        || (unitImplementation.cannotAppearAtLineEnd(unit) && currentX + width * 2 > bounds.x2))
    ) {
      currentX = bounds.x
      if (currentHeights.length === 0) return { units: [], fit: false }
      const maximum = Math.max(...currentHeights)
      const mode = stableMode(currentHeights) ?? maximum
      currentY -= Math.max(mode * lineSkip, maximum * 1.05)
      currentHeights = []
      if (currentY < bounds.y) fit = false
      if (unitImplementation.isSpace(unit)) continue
    }
    const relocated = relocate(unit, currentX, currentY, scale)
    result.push(relocated)
    if (!unitImplementation.isSpace(unit)) currentHeights.push(height)
    currentX = boxCoordinates(unitImplementation.box(relocated))?.x2 ?? currentX
  }
  return { units: result, fit }
}

function widthBeforeBreak(units: Unit[], scale: number): number {
  const first = units[0]
  if (!first || unitImplementation.canBreakLine(first)) return 0
  let width = 0
  for (const unit of units) {
    if (unitImplementation.canBreakLine(unit)) return width * scale
    width += unitWidth(unit)
  }
  return width * scale
}

function relocate(unit: Unit, x: number, y: number, scale: number): Unit {
  if (unit.sourceCharacter) {
    const copy: Unit = { ...unit }
    const width = unitWidth(unit) * scale
    const height = unitHeight(unit) * scale
    const character = unit.sourceCharacter
    const style: ILPdfStyle = {
      graphic_state: character.pdf_style?.graphic_state,
      font_id: character.pdf_style?.font_id,
      font_size: character.pdf_style?.font_size !== undefined ? character.pdf_style.font_size * scale : undefined
    }
    const box: ILBox = { x, y, x2: x + width, y2: y + height }
    const relocated: ILPdfCharacter = {
      pdf_style: style,
      box,
      vertical: character.vertical,
      y_flipped: character.y_flipped,
      scale,
      pdf_character_id: character.pdf_character_id,
      char_unicode: character.char_unicode,
      advance: character.advance !== undefined ? character.advance * scale : undefined,
      xobj_id: character.xobj_id,
      debug_info: unit.debugInfo
    }
    copy.sourceCharacter = relocated
    if (unit.origin?.kind === 'character') {
      copy.sourceTransform = anchorTransform(unit.origin.character, relocated, scale)
    }
    return copy
  }
  if (unit.formula) {
    const copy: Unit = { ...unit }
    const relocated = relocateFormulaObject(unit.formula, x, y, scale)
    copy.formula = relocated.formula
    copy.sourceTransform = relocated.transform ?? undefined
    return copy
  }
  const copy: Unit = { ...unit }
  copy.x = x
  copy.y = y
  copy.scale = scale
  if (copy.unicode !== undefined && copy.fontSize !== undefined) copy.fontSize = copy.fontSize * scale
  const anchor = boxCoordinates(copy.sourceAnchorBox)
  if (anchor) {
    copy.sourceTransform = [scale, 0, 0, scale, x - scale * anchor.x, y - scale * anchor.y]
  }
  return copy
}

function anchorTransform(source: ILPdfCharacter, destination: ILPdfCharacter, scale: number): number[] | undefined {
  const start = glyphAnchor(source)
  const end = glyphAnchor(destination)
  if (!start || !end) return undefined
  return [scale, 0, 0, scale, end.x - scale * start.x, end.y - scale * start.y]
}

function glyphAnchor(character: ILPdfCharacter): { x: number; y: number } | null {
  const box = boxCoordinates(character.box)
  if (!box) return null
  if (pythonBool(character.vertical)) return { x: box.x2, y: box.y }
  if (pythonBool(character.y_flipped)) return { x: box.x, y: box.y2 }
  return { x: box.x, y: box.y }
}

function render(unit: Unit): { characters: ILPdfCharacter[]; curves: ILPdfCurve[]; forms: NonNullable<ILPage['pdf_form']> } {
  if (unit.sourceCharacter) return { characters: [unit.sourceCharacter], curves: [], forms: [] }
  if (unit.formula) {
    return { characters: unit.formula.pdf_character ?? [], curves: unit.formula.pdf_curve ?? [], forms: unit.formula.pdf_form ?? [] }
  }
  if (unit.unicode === undefined || !unit.font || unit.fontSize === undefined || !unit.style
    || unit.x === undefined || unit.y === undefined) {
    return { characters: [], curves: [], forms: [] }
  }
  const width = advanceForCharacter(unit.font, unit.unicode, unit.fontSize)
  const translatedStyle: ILPdfStyle = {
    graphic_state: unit.style.graphic_state,
    font_id: unit.font.id,
    font_size: unit.fontSize
  }
  const codePoint = unit.unicode.codePointAt(0)
  const glyph = codePoint !== undefined ? unit.font.glyph(codePoint) : null
  const character: ILPdfCharacter = {
    pdf_style: translatedStyle,
    box: { x: unit.x, y: unit.y, x2: unit.x + width, y2: unit.y + unit.fontSize },
    vertical: false,
    scale: unit.scale,
    pdf_character_id: glyph ?? undefined,
    char_unicode: unit.unicode,
    advance: width,
    xobj_id: unit.xobjID,
    debug_info: unit.debugInfo
  }
  return { characters: [character], curves: [], forms: [] }
}

function relocateFormulaObject(
  formula: ILPdfFormula,
  x: number,
  y: number,
  scale: number
): { formula: ILPdfFormula; transform: number[] | null } {
  const source = boxCoordinates(formula.box)
  if (!source) return { formula, transform: null }
  const xOffset = formula.x_offset ?? 0
  const yOffset = formula.y_offset ?? 0
  const characters = (formula.pdf_character ?? []).map((character): ILPdfCharacter | null => {
    const box = boxCoordinates(character.box)
    const visual = boxCoordinates(character.visual_bbox?.box)
    if (!box || !visual) return null
    const style: ILPdfStyle = {
      graphic_state: character.pdf_style?.graphic_state,
      font_id: character.pdf_style?.font_id,
      font_size: character.pdf_style?.font_size !== undefined ? character.pdf_style.font_size * scale : undefined
    }
    return {
      pdf_style: style,
      box: {
        x: x + (box.x - source.x + xOffset) * scale,
        y: y + (box.y - source.y + yOffset) * scale,
        x2: x + (box.x2 - source.x + xOffset) * scale,
        y2: y + (box.y2 - source.y + yOffset) * scale
      },
      visual_bbox: {
        box: {
          x: x + (visual.x - source.x + xOffset) * scale,
          y: y + (visual.y - source.y + yOffset) * scale,
          x2: x + (visual.x2 - source.x + xOffset) * scale,
          y2: y + (visual.y2 - source.y + yOffset) * scale
        }
      },
      vertical: character.vertical,
      y_flipped: character.y_flipped,
      scale,
      pdf_character_id: character.pdf_character_id,
      char_unicode: character.char_unicode,
      advance: character.advance !== undefined && character.advance !== 0 ? character.advance * scale : undefined,
      xobj_id: character.xobj_id
    }
  }).filter((character): character is ILPdfCharacter => character !== null)
  if (characters.length === 0) return { formula, transform: null }
  const visualBoxes = characters
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  if (visualBoxes.length === 0) return { formula, transform: null }
  const usefulCharacters = characters.filter((character) => character.pdf_character_id !== undefined && character.char_unicode !== undefined)
  const usefulVisualBoxes = usefulCharacters
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  const heightBoxes = usefulVisualBoxes.length === 0 ? visualBoxes : usefulVisualBoxes
  const relocatedBox: ILBox = {
    x: Math.min(...visualBoxes.map((box) => box.x)),
    y: Math.min(...heightBoxes.map((box) => box.y)),
    x2: Math.max(...visualBoxes.map((box) => box.x2)),
    y2: Math.max(...heightBoxes.map((box) => box.y2))
  }
  const translationX = x + xOffset * scale - source.x * scale
  const translationY = y + yOffset * scale - source.y * scale
  const relocationTransform = [scale, 0, 0, scale, translationX, translationY]
  const curves = (formula.pdf_curve ?? []).map((curve): ILPdfCurve => {
    const copy: ILPdfCurve = { ...curve }
    const box = boxCoordinates(curve.box)
    if (box) {
      const relativeX = box.x - source.x
      const relativeY = box.y - source.y
      copy.box = {
        x: x + (relativeX + xOffset) * scale,
        y: y + (relativeY + yOffset) * scale,
        x2: x + (relativeX + box.x2 - box.x + xOffset) * scale,
        y2: y + (relativeY + box.y2 - box.y + yOffset) * scale
      }
    }
    copy.relocation_transform = relocationTransform
    return copy
  })
  const forms = (formula.pdf_form ?? []).map((form) => {
    const copy = { ...form } as Record<string, unknown> & typeof form
    const box = boxCoordinates(form.box)
    if (box) {
      const relativeX = box.x - source.x
      const relativeY = box.y - source.y
      copy.box = {
        x: x + (relativeX + xOffset) * scale,
        y: y + (relativeY + yOffset) * scale,
        x2: x + (relativeX + box.x2 - box.x + xOffset) * scale,
        y2: y + (relativeY + box.y2 - box.y + yOffset) * scale
      }
    }
    copy.relocation_transform = relocationTransform
    return copy as typeof form
  })
  const relocated: ILPdfFormula = {
    box: relocatedBox,
    pdf_character: characters,
    pdf_curve: curves,
    pdf_form: forms,
    x_offset: xOffset * scale,
    y_offset: yOffset * scale,
    x_advance: (formula.x_advance ?? 0) * scale
  }
  return { formula: relocated, transform: relocationTransform }
}

function updateRenderOrder(paragraph: ILPdfParagraph): void {
  const order = paragraph.render_order
  if (order === undefined) return
  let suborder = 1
  for (const composition of paragraph.pdf_paragraph_composition ?? []) {
    if (composition.pdf_character) {
      composition.pdf_character.render_order = order
      composition.pdf_character.sub_render_order = suborder
      suborder += 1
    }
  }
}

function adjustParagraphPositions(page: ILPage, pageIndex: number, preservedParagraphAddresses: Set<string>): void {
  const paragraphs = page.pdf_paragraph ?? []
  for (let upperIndex = 0; upperIndex < paragraphs.length; upperIndex += 1) {
    if (preservedParagraphAddresses.has(addressKey({ pageIndex, paragraphIndex: upperIndex }))) continue
    const upper = boxCoordinates(paragraphs[upperIndex].box)
    if (!upper) continue
    const gap = upper.y2 - upper.y < 36 ? 0.5 : 3
    const conflicts = paragraphs
      .map((_, lowerIndex) => lowerIndex)
      .filter((lowerIndex) => {
        if (lowerIndex === upperIndex) return false
        const lower = boxCoordinates(paragraphs[lowerIndex].box)
        if (!lower) return false
        return lower.y2 >= upper.y - gap && lower.y2 <= upper.y
          && !(lower.x2 < upper.x || lower.x > upper.x2)
      })
    const maximum = Math.max(...conflicts.map((index) => boxCoordinates(paragraphs[index].box)?.y2 ?? Number.NEGATIVE_INFINITY))
    if (Number.isFinite(maximum) && maximum + gap < upper.y2) {
      const box = paragraphs[upperIndex].box
      if (box) box.y = maximum + gap
    }
  }
}

function maxRightSpace(box: ILBox, page: ILPage): number {
  const current = boxCoordinates(box)
  if (!current) return 0
  let maximum = (boxCoordinates(page.cropbox?.box)?.x2 ?? current.x2) * 0.9
  const candidates = [
    ...(page.pdf_paragraph ?? []), ...(page.pdf_character ?? []), ...(page.pdf_figure ?? [])
  ].map((item) => boxCoordinates('box' in item ? (item as { box?: ILBox }).box : undefined))
    .filter((candidate): candidate is NonNullable<ReturnType<typeof boxCoordinates>> => candidate !== null)
  for (const other of candidates) {
    if (other.x > current.x && !(other.y >= current.y2 || other.y2 <= current.y)) {
      maximum = Math.min(maximum, other.x)
    }
  }
  return maximum
}

function maxBottomSpace(box: ILBox, page: ILPage): number {
  const current = boxCoordinates(box)
  if (!current) return 0
  let minimum = (boxCoordinates(page.cropbox?.box)?.y ?? current.y) * 1.1
  const candidates = [
    ...(page.pdf_paragraph ?? []), ...(page.pdf_character ?? []), ...(page.pdf_figure ?? [])
  ].map((item) => boxCoordinates('box' in item ? (item as { box?: ILBox }).box : undefined))
    .filter((candidate): candidate is NonNullable<ReturnType<typeof boxCoordinates>> => candidate !== null)
  for (const other of candidates) {
    if (other.y2 < current.y && !(other.x >= current.x2 || other.x2 <= current.x)) {
      minimum = Math.max(minimum, other.y2)
    }
  }
  return minimum
}

const hungPunctuation = new Set([
  ',', '.', ':', ';', '?', '!', '，', '。', '．', '、', '：', '；', '！', '‼', '？', '⁇',
  '”', '’', '」', '』', ')', ']', '}', '）', '〕', '〉', '】', '〗', '］', '｝', '》',
  '～', '-', '–', '—', '·', '・', '‧', '/', '／', '⁄'
])
const openingPunctuation = new Set([
  '“', '‘', '「', '『', '(', '[', '{', '（', '〔', '〈', '《', '〖', '〘', '〚'
])

function isUnbreakableLatin(value: string | undefined): boolean {
  if (!value) return false
  const scalars = [...value]
  if (scalars.length !== 1) return false
  const code = scalars[0].codePointAt(0) ?? 0
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)
    || (code >= 0x370 && code <= 0x52f) || [0x27, 0x2d, 0xb7, 0x2bb].includes(code)
}

function isCJK(value: string | undefined): boolean {
  if (!value) return false
  const scalars = [...value]
  if (scalars.length !== 1) return false
  const code = scalars[0].codePointAt(0) ?? 0
  return (code >= 0x3000 && code <= 0x33ff) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7ff) || (code >= 0x2e80 && code <= 0x2fdf)
    || (code >= 0xfe10 && code <= 0xfe4f)
}

function stableMode(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const counts = new Map<number, number>()
  const first = new Map<number, number>()
  values.forEach((value, index) => {
    counts.set(value, (counts.get(value) ?? 0) + 1)
    if (!first.has(value)) first.set(value, index)
  })
  return values.reduce((best, value) => {
    const bestCount = counts.get(best) ?? 0
    const valueCount = counts.get(value) ?? 0
    if (valueCount > bestCount) return value
    if (valueCount === bestCount && (first.get(value) ?? 0) < (first.get(best) ?? 0)) return value
    return best
  })
}
