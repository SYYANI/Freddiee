// Source-preserving planning (ADR-0002), ported from Swift SourcePreservingPlan:
// where each source glyph was, what typesetting did with it, and the per-page
// plan the shim's filter applies to the untouched content stream.
import { boxCoordinates, pythonBool, type ILBox, type ILDocument, type ILPage, type ILPdfCharacter, type ILPdfCurve, type ILPdfParagraph } from './il'
import type { TypesettingReport } from './typesetting'

export interface SourceGlyphAnchor {
  x: number
  y: number
  y2: number
  orientation: 0 | 1 | 2
  unicode: number | null
  isOptional: boolean
}

export interface SourceParagraphSnapshot {
  pages: Array<Array<{ anchors: SourceGlyphAnchor[]; extent: ILBox | undefined }>>
  pageCharacters: SourceGlyphAnchor[][]
}

export type GlyphRole = 0 | 1 | 2

export interface PlanGlyph {
  anchor: SourceGlyphAnchor
  role: GlyphRole
  placement: number | null
}

export interface PlanPlacement {
  transform: number[]
  glyphRects: ILBox[]
  graphicRects: ILBox[]
}

export interface SourcePreservingPagePlan {
  glyphs: PlanGlyph[]
  placements: PlanPlacement[]
  removedRegions: ILBox[]
  removedTextRegions: ILBox[]
  underlayCurves: ILPdfCurve[]
  overlayCharacters: ILPdfCharacter[]
}

export interface SourcePreservingDocumentPlan {
  pages: Map<number, SourcePreservingPagePlan>
}

const formatScalar = /\p{gc=Cf}|\p{White_Space}/u

export function sourceGlyphAnchor(character: ILPdfCharacter): SourceGlyphAnchor | null {
  const box = boxCoordinates(character.box)
  if (!box) return null
  const text = character.char_unicode ?? ''
  const unicode = text.startsWith('(cid:') ? null : [...text][0]?.codePointAt(0) ?? null
  const isOptional = text.length > 0 && !text.startsWith('(cid:') && [...text].every((scalar) => formatScalar.test(scalar))
  if (pythonBool(character.vertical)) {
    return { x: box.x2, y: box.y, y2: box.y2, orientation: 2, unicode, isOptional }
  }
  if (pythonBool(character.y_flipped)) {
    return { x: box.x, y: box.y2, y2: box.y2, orientation: 1, unicode, isOptional }
  }
  return { x: box.x, y: box.y, y2: box.y, orientation: 0, unicode, isOptional }
}

function anchorKey(anchor: SourceGlyphAnchor): string {
  return `${anchor.x}|${anchor.y}|${anchor.y2}|${anchor.orientation}|${anchor.unicode}|${anchor.isOptional}`
}

function snapshotCharacters(paragraph: ILPdfParagraph): ILPdfCharacter[] {
  const characters: ILPdfCharacter[] = []
  for (const composition of paragraph.pdf_paragraph_composition ?? []) {
    if (composition.pdf_line) characters.push(...(composition.pdf_line.pdf_character ?? []))
    else if (composition.pdf_character) characters.push(composition.pdf_character)
    else if (composition.pdf_same_style_characters) characters.push(...(composition.pdf_same_style_characters.pdf_character ?? []))
    else if (composition.pdf_formula) characters.push(...(composition.pdf_formula.pdf_character ?? []))
  }
  return characters
}

export function makeSourceParagraphSnapshot(document: ILDocument): SourceParagraphSnapshot {
  const pageCharacters = (document.page ?? []).map((page) =>
    (page.pdf_character ?? []).map(sourceGlyphAnchor).filter((anchor): anchor is SourceGlyphAnchor => anchor !== null))
  const pages = (document.page ?? []).map((page) =>
    (page.pdf_paragraph ?? []).map((paragraph) => {
      const characters = snapshotCharacters(paragraph)
      return {
        anchors: characters.map(sourceGlyphAnchor).filter((anchor): anchor is SourceGlyphAnchor => anchor !== null),
        extent: unionBoxes(characters.flatMap((character) =>
          [character.box, character.visual_bbox?.box].filter((box): box is ILBox => box !== undefined))) ?? undefined
      }
    }))
  return { pages, pageCharacters }
}

export const SourcePreservingPlanner = {
  makePlan(document: ILDocument, snapshot: SourceParagraphSnapshot, typesetting: TypesettingReport): SourcePreservingDocumentPlan {
    const pages = new Map<number, SourcePreservingPagePlan>()
    ;(document.page ?? []).forEach((page, pageIndex) => {
      const pageNumber = page.page_number
      const pageParagraphs = page.pdf_paragraph ?? []
      if (
        pageNumber === undefined || pageNumber < 0
        || pageIndex >= snapshot.pages.length || pageIndex >= typesetting.pages.length
        || snapshot.pages[pageIndex].length !== pageParagraphs.length
        || typesetting.pages[pageIndex].paragraphs.length !== pageParagraphs.length
      ) {
        return
      }
      pages.set(pageNumber, makePagePlan(
        page,
        snapshot.pages[pageIndex],
        pageIndex < snapshot.pageCharacters.length ? snapshot.pageCharacters[pageIndex] : [],
        typesetting.pages[pageIndex]
      ))
    })
    return { pages }
  }
}

function makePagePlan(
  page: ILPage,
  sourceParagraphs: SourceParagraphSnapshot['pages'][number],
  sourceCharacters: SourceGlyphAnchor[],
  report: TypesettingReport['pages'][number]
): SourcePreservingPagePlan {
  const userOffset = userSpaceOffset(page)
  const plan: SourcePreservingPagePlan = {
    glyphs: [],
    placements: [],
    removedRegions: [],
    removedTextRegions: [],
    underlayCurves: report.decorationCurves,
    overlayCharacters: []
  }
  if (userOffset) {
    plan.removedRegions = report.replacedCurveBoxes
      .map((box) => (box ? userBoxToIL(box, userOffset) : null))
      .filter((box): box is ILBox => box !== null)
  }
  // Every untouched character is named too: only glyphs with no IL character at
  // all may follow the moved or removed content around them.
  plan.glyphs = sourceCharacters.map((anchor): PlanGlyph => ({ anchor, role: 1, placement: null }))
  report.paragraphs.forEach((paragraph, paragraphIndex) => {
    if (!paragraph.isTypeset) {
      plan.glyphs.push(...sourceParagraphs[paragraphIndex].anchors.map((anchor): PlanGlyph => ({ anchor, role: 1, placement: null })))
    }
  })
  report.paragraphs.forEach((paragraph, paragraphIndex) => {
    if (!paragraph.isTypeset) return
    const claimed = new Map<string, number>()
    for (const unit of paragraph.sourceUnits) {
      const anchors = unit.characters.map(sourceGlyphAnchor).filter((anchor): anchor is SourceGlyphAnchor => anchor !== null)
      for (const anchor of anchors) claimed.set(anchorKey(anchor), (claimed.get(anchorKey(anchor)) ?? 0) + 1)
      if (!unit.transform || isIdentity(unit.transform)) {
        plan.glyphs.push(...anchors.map((anchor): PlanGlyph => ({ anchor, role: 1, placement: null })))
        continue
      }
      const placement = plan.placements.length
      plan.placements.push(sourcePlacement(unit, unit.transform, userOffset))
      plan.glyphs.push(...anchors.map((anchor): PlanGlyph => ({ anchor, role: 2, placement })))
    }
    const source = sourceParagraphs[paragraphIndex]
    for (const anchor of source.anchors) {
      const key = anchorKey(anchor)
      const count = claimed.get(key)
      if (count !== undefined && count > 0) {
        claimed.set(key, count - 1)
        continue
      }
      plan.glyphs.push({ anchor, role: 0, placement: null } satisfies PlanGlyph)
    }
    if (source.extent) plan.removedTextRegions.push(source.extent)
    const compositions = page.pdf_paragraph?.[paragraphIndex]?.pdf_paragraph_composition ?? []
    for (const index of paragraph.translatedCompositionIndices) {
      const character = compositions[index]?.pdf_character
      if (character) plan.overlayCharacters.push(character)
    }
  })
  return plan
}

function isIdentity(transform: number[]): boolean {
  if (transform.length !== 6) return true
  return Math.abs(transform[0] - 1) < 1e-9 && Math.abs(transform[3] - 1) < 1e-9
    && Math.abs(transform[1]) < 1e-9 && Math.abs(transform[2]) < 1e-9
    && Math.abs(transform[4]) < 0.01 && Math.abs(transform[5]) < 0.01
}

/** One rectangle per moved glyph (widened for overhang) and one per rule or
 * image the unit owns, so content between distant glyphs stays behind. */
function sourcePlacement(
  unit: { characters: ILPdfCharacter[]; curves: Array<{ box?: ILBox }>; forms: Array<{ box?: ILBox }> },
  transform: number[],
  userOffset: { x: number; y: number } | null
): PlanPlacement {
  const glyphRects = unit.characters.map((character): ILBox | null => {
    const anchor = sourceGlyphAnchor(character)
    const boxes = [character.box, character.visual_bbox?.box].filter((box): box is ILBox => box !== undefined)
    const unioned = unionBoxes(boxes)
    if (!unioned || anchor?.isOptional === true) return null
    const box = boxCoordinates(unioned)
    if (!box) return null
    const margin = Math.max(0.5, 0.15 * (character.pdf_style?.font_size ?? 0))
    return { x: box.x - margin, y: box.y - margin, x2: box.x2 + margin, y2: box.y2 + margin }
  }).filter((box): box is ILBox => box !== null)
  let graphicRects: ILBox[] = []
  if (userOffset) {
    graphicRects = [...unit.curves.map((curve) => curve.box), ...unit.forms.map((form) => form.box)]
      .map((box) => (box ? userBoxToIL(box, userOffset) : null))
      .filter((box): box is ILBox => box !== null)
  }
  return { transform, glyphRects, graphicRects }
}

/** The frontend writes characters in crop-box local coordinates but curves and
 * images in PDF user space; they differ by the crop-box origin on an unrotated
 * page. */
export function userSpaceOffset(page: ILPage): { x: number; y: number } | null {
  const tolerance = 0.001
  const media = boxCoordinates(page.mediabox?.box)
  const crop = boxCoordinates(page.cropbox?.box)
  if (!media || !crop) return null
  if (
    Math.abs(media.x) > tolerance || Math.abs(media.y) > tolerance
    || Math.abs((media.x2 - media.x) - (crop.x2 - crop.x)) > tolerance
    || Math.abs((media.y2 - media.y) - (crop.y2 - crop.y)) > tolerance
  ) {
    return null
  }
  return { x: crop.x, y: crop.y }
}

export function userBoxToIL(box: ILBox, offset: { x: number; y: number }): ILBox | null {
  const coordinates = boxCoordinates(box)
  if (!coordinates) return null
  return {
    x: Math.min(coordinates.x, coordinates.x2) - offset.x,
    y: Math.min(coordinates.y, coordinates.y2) - offset.y,
    x2: Math.max(coordinates.x, coordinates.x2) - offset.x,
    y2: Math.max(coordinates.y, coordinates.y2) - offset.y
  }
}

export function unionBoxes(boxes: ILBox[]): ILBox | null {
  let result: { x: number; y: number; x2: number; y2: number } | null = null
  for (const box of boxes) {
    const coordinates = boxCoordinates(box)
    if (!coordinates) continue
    const lowX = Math.min(coordinates.x, coordinates.x2)
    const lowY = Math.min(coordinates.y, coordinates.y2)
    const highX = Math.max(coordinates.x, coordinates.x2)
    const highY = Math.max(coordinates.y, coordinates.y2)
    result = result
      ? { x: Math.min(result.x, lowX), y: Math.min(result.y, lowY), x2: Math.max(result.x2, highX), y2: Math.max(result.y2, highY) }
      : { x: lowX, y: lowY, x2: highX, y2: highY }
  }
  return result ? { x: result.x, y: result.y, x2: result.x2, y2: result.y2 } : null
}

