// Stage 4 paragraph finding, ported stage by stage from Swift ParagraphFinder:
// character grouping by layout, line splitting with a 0.25pt collision
// histogram, dummy spaces, spacing normalization, independent-paragraph
// splitting, table/TOC repair, pseudocode marking and overlap fixing.
import { boxCoordinates, pythonBool, type ILBox, type ILDocument, type ILPage, type ILPageLayout, type ILPdfParagraph, type ILPdfParagraphComposition, type ILPdfCharacter, type ILPdfLine } from './il'
import { LayoutHelper, type CharacterLayout } from './layoutHelper'
import { TableOfContentsDotLeader } from './tableOfContentsDotLeader'
import { escapeRegExp, isLetterCodePoint, isLowercaseCodePoint, isNumberCodePoint, isWhitespaceCodePoint, normalizeWhitespace, foundationTrim } from './unicode'

const f = Math.fround

export interface ParagraphFinderConfiguration {
  splitShortLines: boolean
  shortLineSplitFactor: number
  mergeAlternatingLineNumbers: boolean
}

export const defaultParagraphFinderConfiguration: ParagraphFinderConfiguration = {
  splitShortLines: false,
  shortLineSplitFactor: 0.8,
  mergeAlternatingLineNumbers: true
}

export class ParagraphFinderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParagraphFinderError'
  }
}

const bulletPattern = /^[■•⚫⬤◆◇○●◦‣⁃▪▫∗†‡¹²³⁴⁵⁶⁷⁸⁹⁰₁₂₃₄₅₆₇₈₉₀ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ¶※⁑⁂⁕⁎⁜❧☙⁋‖‽\u{F06E}\u{F06C}·]/u
const listItemStart = /^\s*(?:\d{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,8})[.)]\s+\S/
const dashListItemStart = /^\s*[-–]\s+\S/
const cidParagraphPattern = /^\(cid:\d+\)$/
const numberedLineStart = /^\s*(\d{1,3}[.)])\s+(\S+)/
const numberedSectionTitle = /^\s*\d+(?:\.\d+)+\s+/
const dashSeparatedTOCRow = /^.*\p{L}.*\s[—–-]\s+(?:[0-9]{1,4}|[IVXLCDMivxlcdm]{1,8}(?:-[0-9]{1,4})?)$/u
const pseudocodeCall = /^[\p{L}_][\p{L}\p{N}_-]*\s*\([^)]*\)\s*$/u
const pseudocodeControlFlow = /^(?:if|else|for\s*each|foreach|while|repeat|until|return|case|switch)(?:\s|\p{L}|\p{N}|\(|$)/iu
const sparseLeaderAtEnd = /(?:\.\s*){2,}$/
const enumerationMarker = /^\d{1,3}$/
const romanFragment = /^[ivxlcdmIVXLCDM]*$/

export const ParagraphFinder = {
  process(document: ILDocument, configuration: ParagraphFinderConfiguration = defaultParagraphFinderConfiguration): void {
    if ((document.page ?? []).length === 0) return
    for (const page of document.page ?? []) ParagraphFinder.processPage(page, configuration)
    const paragraphs = (document.page ?? []).flatMap((page) => page.pdf_paragraph ?? [])
    if (paragraphs.length === 0) throw new ParagraphFinderError('The document contains no paragraphs.')
    const cidCount = paragraphs.filter(isCIDParagraph).length
    if (cidCount / paragraphs.length > 0.8) {
      throw new ParagraphFinderError('The document contains too many CID paragraphs.')
    }
  },

  processPage(page: ILPage, configuration: ParagraphFinderConfiguration = defaultParagraphFinderConfiguration): void {
    preprocessFormulaLayouts(page)
    const paragraphs = groupCharacters(page)

    for (const paragraph of paragraphs) {
      if (paragraph.layout_label !== 'isolate_formula') splitIntoLines(paragraph)
    }
    for (const paragraph of paragraphs) {
      if (paragraph.layout_label === 'isolate_formula') {
        updateIsolatedFormula(paragraph)
        updateParagraph(paragraph, { updateUnicode: true })
        continue
      }
      addSpaceDummyCharacters(paragraph)
      processSpacing(paragraph)
      updateParagraph(paragraph, { updateUnicode: true })
    }

    const medianWidth = medianLineWidth(paragraphs)
    processIndependentParagraphs(paragraphs, medianWidth, configuration)
    repairEnumeratedTableCells(paragraphs, (page.page_layout ?? []).filter((layout) => layout.class_name === 'table'))
    repairFragmentedTableOfContentsRows(paragraphs)
    markPseudocodeBlocks(paragraphs)
    if (configuration.mergeAlternatingLineNumbers) mergeAlternatingLineNumbers(paragraphs)
    for (const paragraph of paragraphs) {
      updateParagraph(paragraph, { updateUnicode: paragraph.unicode === undefined })
    }
    page.pdf_paragraph = paragraphs
    fixOverlaps(paragraphs)
    // Overlap repair may reunite adjacent lines that shared one detector box.
    // Apply the TOC-only line and page-marker split after that general pass.
    splitDashSeparatedTableOfContentsRows(paragraphs)
    splitMultiLineTableOfContentsParagraphs(paragraphs)
    splitWideGapTableOfContentsPageMarkers(paragraphs)
    setRenderOrder(paragraphs)
  }
}

function preprocessFormulaLayouts(page: ILPage): void {
  const textBoxes = (page.page_layout ?? []).filter((layout) =>
    LayoutHelper.isTextLayout({ id: layout.id, name: layout.class_name }))
  if (textBoxes.length === 0) return
  for (const layout of page.page_layout ?? []) {
    if (layout.class_name !== 'formula') continue
    const overlapsText = textBoxes.some((text) => LayoutHelper.coverage(layout.box, text.box) >= 0.5)
    if (!overlapsText) layout.class_name = 'isolate_formula'
  }
}

function groupCharacters(page: ILPage): ILPdfParagraph[] {
  const paragraphs: ILPdfParagraph[] = [...(page.pdf_paragraph ?? [])]
  const fallbackBridges = fallbackLineBridges(page.page_layout ?? [])
  const nestedBridges = nestedTextLayoutBridges(page.page_layout ?? [])
  const areas = (page.pdf_character ?? [])
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<typeof box> => box !== null)
    .map((box) => (box.x2 - box.x) * (box.y2 - box.y))
    .sort((lhs, rhs) => lhs - rhs)
  const medianArea = median(areas)
  const skipped: ILPdfCharacter[] = []
  let currentIndex: number | null = null
  let currentLayout: CharacterLayout | null = null
  const isolatedParagraphByLayoutID = new Map<number, number>()

  for (const character of page.pdf_character ?? []) {
    let layout = LayoutHelper.characterLayout(character, page.page_layout ?? [])
    if (layout?.name === 'fallback_line' && layout.id !== undefined) {
      const bridged = fallbackBridges.get(layout.id)
      if (bridged) layout = bridged
    }
    if (layout?.id !== undefined) {
      const parent = nestedBridges.get(layout.id)
      if (parent) layout = parent
    }
    character.formula_layout_id = LayoutHelper.formulaLayoutID(character, page.page_layout ?? [])
    if (layout && layout.name === 'isolate_formula') {
      character.formula_layout_id = layout.id
      let paragraphIndex: number
      const layoutID = layout.id
      if (layoutID !== undefined && isolatedParagraphByLayoutID.has(layoutID)) {
        paragraphIndex = isolatedParagraphByLayoutID.get(layoutID) as number
      } else {
        paragraphs.push({
          pdf_paragraph_composition: [{ pdf_formula: { pdf_character: [], line_id: 0 } }],
          debug_id: makeDebugID(paragraphs.length),
          layout_label: layout.name,
          layout_id: layout.id
        })
        paragraphIndex = paragraphs.length - 1
        if (layoutID !== undefined) isolatedParagraphByLayoutID.set(layoutID, paragraphIndex)
      }
      const formula = paragraphs[paragraphIndex].pdf_paragraph_composition?.[0]?.pdf_formula
      if (formula) formula.pdf_character = [...(formula.pdf_character ?? []), character]
      currentIndex = null
      currentLayout = null
      continue
    }
    if (!LayoutHelper.isTextLayout(layout) || isIsolatedFormula(character)) {
      skipped.push(character)
      continue
    }
    const visual = boxCoordinates(character.visual_bbox?.box)
    if (!layout || !visual) {
      skipped.push(character)
      continue
    }
    const area = (visual.x2 - visual.x) * (visual.y2 - visual.y)
    const small = area < medianArea * 0.05
    let startsNew = currentIndex === null
    if (
      currentIndex !== null
      && !(small && (paragraphs[currentIndex].pdf_paragraph_composition ?? []).length > 0 && layout.id === currentLayout?.id)
      && character.char_unicode !== undefined
    ) {
      const unicode = character.char_unicode ?? ''
      const lastXObject = lastComposition(paragraphs[currentIndex])?.pdf_character?.xobj_id
      if (
        (layout.id !== currentLayout?.id && !startsWithWhitespace(unicode))
        || lastXObject !== character.xobj_id
        || (isBullet(character) && (paragraphs[currentIndex].pdf_paragraph_composition ?? []).length === 0)
      ) {
        startsNew = true
      }
    }
    if (startsNew) {
      currentLayout = layout
      paragraphs.push({
        pdf_paragraph_composition: [],
        debug_id: makeDebugID(paragraphs.length),
        layout_label: layout.name,
        layout_id: layout.id
      })
      currentIndex = paragraphs.length - 1
    }
    if (currentIndex !== null) {
      paragraphs[currentIndex].pdf_paragraph_composition = [
        ...(paragraphs[currentIndex].pdf_paragraph_composition ?? []),
        { pdf_character: character }
      ]
    }
  }
  page.pdf_character = skipped
  for (const paragraph of paragraphs) {
    if (paragraph.layout_label === 'isolate_formula') updateIsolatedFormula(paragraph)
    updateParagraph(paragraph)
  }
  return paragraphs
}

function lastComposition(paragraph: ILPdfParagraph): ILPdfParagraphComposition | undefined {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  return compositions.length > 0 ? compositions[compositions.length - 1] : undefined
}

/** A detector text box can be a few points narrower than the physical PDF line;
 * hand such a fallback line to the strongly overlapping detector text layout. */
function fallbackLineBridges(layouts: ILPageLayout[]): Map<number, CharacterLayout> {
  const candidates = layouts.filter((layout) =>
    layout.class_name !== 'fallback_line'
    && layout.class_name !== 'isolate_formula'
    && LayoutHelper.isTextLayout({ id: layout.id, name: layout.class_name }))
  const result = new Map<number, CharacterLayout>()
  if (candidates.length === 0) return result

  for (const fallback of layouts) {
    if (fallback.class_name !== 'fallback_line') continue
    if (fallback.id === undefined) continue
    const fallbackBox = boxCoordinates(fallback.box)
    if (!fallbackBox) continue
    const fallbackWidth = fallbackBox.x2 - fallbackBox.x
    const fallbackHeight = fallbackBox.y2 - fallbackBox.y
    if (fallbackWidth <= 0 || fallbackHeight <= 0) continue

    const scores: { layout: ILPageLayout; score: number }[] = []
    for (const candidate of candidates) {
      const candidateBox = boxCoordinates(candidate.box)
      if (!candidateBox) continue
      const intersectionWidth = Math.min(fallbackBox.x2, candidateBox.x2) - Math.max(fallbackBox.x, candidateBox.x)
      const intersectionHeight = Math.min(fallbackBox.y2, candidateBox.y2) - Math.max(fallbackBox.y, candidateBox.y)
      if (intersectionWidth <= 0 || intersectionHeight <= 0) continue
      const horizontalCoverage = intersectionWidth / fallbackWidth
      const verticalCoverage = intersectionHeight / fallbackHeight
      if (horizontalCoverage < 0.5 || verticalCoverage < 0.5) continue
      scores.push({ layout: candidate, score: horizontalCoverage * verticalCoverage })
    }
    scores.sort((lhs, rhs) => {
      if (lhs.score !== rhs.score) return rhs.score - lhs.score
      return (lhs.layout.id ?? Number.MAX_SAFE_INTEGER) - (rhs.layout.id ?? Number.MAX_SAFE_INTEGER)
    })

    const best = scores[0]
    if (!best || best.score < 0.5) continue
    if (scores.length > 1 && best.score - scores[1].score < 0.15) continue
    result.set(fallback.id, { id: best.layout.id, name: best.layout.class_name })
  }
  return result
}

/** A nested lower-confidence box that already lies inside a taller same-class
 * block groups with that block so ownership cannot flip mid-line. */
function nestedTextLayoutBridges(layouts: ILPageLayout[]): Map<number, CharacterLayout> {
  const tolerance = 2.0
  const candidates = layouts
    .map((layout, offset) => ({ layout, offset }))
    .filter(({ layout }) =>
      layout.class_name !== 'fallback_line'
      && layout.class_name !== 'isolate_formula'
      && LayoutHelper.isTextLayout({ id: layout.id, name: layout.class_name }))
  const result = new Map<number, CharacterLayout>()
  for (const { layout: child, offset: childOffset } of candidates) {
    if (child.id === undefined) continue
    const childBox = boxCoordinates(child.box)
    if (!childBox) continue
    const childWidth = childBox.x2 - childBox.x
    const childHeight = childBox.y2 - childBox.y
    if (childWidth <= 0 || childHeight <= 0) continue

    const parents = candidates.filter(({ layout: parent, offset: parentOffset }) => {
      // Only a block that already wins the overlap tie may absorb the child.
      if (parentOffset >= childOffset || parent.class_name !== child.class_name) return false
      const parentBox = boxCoordinates(parent.box)
      if (!parentBox) return false
      const intersectionWidth = Math.min(childBox.x2, parentBox.x2) - Math.max(childBox.x, parentBox.x)
      return parentBox.y2 - parentBox.y > childHeight * 2
        && childBox.y >= parentBox.y - tolerance
        && childBox.y2 <= parentBox.y2 + tolerance
        && childBox.x2 > parentBox.x2 + tolerance
        && intersectionWidth >= childWidth * 0.5
    })
    if (parents.length !== 1) continue
    result.set(child.id, { id: parents[0].layout.id, name: parents[0].layout.class_name })
  }
  return result
}

function updateIsolatedFormula(paragraph: ILPdfParagraph): void {
  if (paragraph.layout_label !== 'isolate_formula') return
  const compositions = paragraph.pdf_paragraph_composition ?? []
  if (compositions.length !== 1) return
  const formula = compositions[0].pdf_formula
  if (!formula) return
  const boxes = (formula.pdf_character ?? [])
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<typeof box> => box !== null)
  if (boxes.length > 0) {
    formula.box = {
      x: Math.min(...boxes.map((box) => box.x)),
      y: Math.min(...boxes.map((box) => box.y)),
      x2: Math.max(...boxes.map((box) => box.x2)),
      y2: Math.max(...boxes.map((box) => box.y2))
    }
  }
  formula.x_offset = 0
  formula.y_offset = 0
  formula.x_advance = 0
  formula.line_id = 0
  formula.is_corner_mark = false
}

function splitIntoLines(paragraph: ILPdfParagraph): void {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  if (compositions.length === 0) return
  const characters: ILPdfCharacter[] = []
  const others: ILPdfParagraphComposition[] = []
  for (const composition of compositions) {
    if (composition.pdf_character) characters.push(composition.pdf_character)
    else others.push(composition)
  }
  if (characters.length === 0) return
  const bounds: { character: ILPdfCharacter; y1: number; y2: number }[] = []
  for (const character of characters) {
    const box = boxCoordinates(character.visual_bbox?.box)
    // Swift carries Float(box.y): the histogram bins sit on Float32 values.
    if (box) bounds.push({ character, y1: f(box.y), y2: f(box.y2) })
  }
  if (bounds.length === 0) {
    paragraph.pdf_paragraph_composition = others
    return
  }
  const minimum = Math.min(...bounds.map((bound) => bound.y1))
  const maximum = Math.max(...bounds.map((bound) => bound.y2))
  if (f(maximum - minimum) < 5) {
    paragraph.pdf_paragraph_composition = [makeLine(characters), ...others]
    updateParagraph(paragraph)
    return
  }

  const step: number = 0.25
  const count = Math.ceil(f(f(maximum - minimum) / step))
  const histogram = new Int32Array(Math.max(0, count + 1))
  if (count > 0) {
    for (const { y1, y2 } of bounds) {
      const start = Math.floor(f(f(f(maximum) - y2) / step))
      const rawEnd = Math.floor(f(f(f(maximum) - y1) / step)) + 1
      const end = Math.min(Math.max(rawEnd, 0), count)
      if (start >= 0 && start < histogram.length) histogram[start] += 1
      if (end >= 0 && end < histogram.length) histogram[end] -= 1
    }
  }
  const collisions: number[] = []
  let running = 0
  for (let index = 0; index < count; index += 1) {
    running += histogram[index]
    collisions.push(running)
  }
  const gapStarts: number[] = []
  let inGap = false
  for (const [index, value] of collisions.entries()) {
    if (value < 1 && !inGap) { gapStarts.push(index); inGap = true }
    else if (value >= 1 && inGap) inGap = false
  }
  if (gapStarts.length === 0) {
    paragraph.pdf_paragraph_composition = [makeLine(characters), ...others]
    updateParagraph(paragraph)
    return
  }
  const separators = gapStarts.map((start) => f(f(maximum) - f(start * step))).sort((lhs, rhs) => rhs - lhs)
  const lines: ILPdfCharacter[][] = Array.from({ length: separators.length + 1 }, () => [])
  for (const bound of bounds) {
    const center = f(f(f(bound.y1) + f(bound.y2)) / 2)
    let lineIndex = 0
    for (const separator of separators) {
      if (center > separator) break
      lineIndex += 1
    }
    lines[lineIndex].push(bound.character)
  }
  paragraph.pdf_paragraph_composition = [
    ...lines.filter((line) => line.length > 0).map((line) => makeLine(line)),
    ...others
  ]
  updateParagraph(paragraph)
}

function makeLine(characters: ILPdfCharacter[]): ILPdfParagraphComposition {
  const line: ILPdfLine = { pdf_character: characters }
  updateLine(line)
  return { pdf_line: line }
}

function updateLine(line: ILPdfLine): void {
  const boxes = (line.pdf_character ?? [])
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<typeof box> => box !== null)
  if (boxes.length === 0) return
  line.box = {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
}

function addSpaceDummyCharacters(paragraph: ILPdfParagraph): void {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  for (const composition of compositions) {
    if (composition.pdf_line) {
      const line = composition.pdf_line
      line.pdf_character ??= []
      addSpaces(line.pdf_character)
    } else if (composition.pdf_same_style_characters) {
      const same = composition.pdf_same_style_characters
      same.pdf_character ??= []
      addSpaces(same.pdf_character)
    } else if (composition.pdf_formula) {
      const formula = composition.pdf_formula
      formula.pdf_character ??= []
      addSpaces(formula.pdf_character)
    }
  }
  if (compositions.length <= 1) return
  for (let index = 0; index < compositions.length - 1; index += 1) {
    const last = lastCharacter(compositions[index])
    const first = firstCharacter(compositions[index + 1])
    const lastBox = last ? boxCoordinates(last.box) : null
    const firstBox = first ? boxCoordinates(first.box) : null
    if (!last || !first || !lastBox || !firstBox) continue
    const distance = firstBox.x - lastBox.x2
    if (distance <= 1) continue
    const space = dummySpace(last, distance)
    const line = compositions[index].pdf_line
    const same = compositions[index].pdf_same_style_characters
    const formula = compositions[index].pdf_formula
    if (line) {
      line.pdf_character ??= []
      line.pdf_character.push(space)
    } else if (same) {
      same.pdf_character ??= []
      same.pdf_character.push(space)
    } else if (formula) {
      formula.pdf_character ??= []
      formula.pdf_character.push(space)
    }
  }
}

function addSpaces(characters: ILPdfCharacter[]): void {
  if (characters.length === 0) return
  const distances: number[] = []
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const left = boxCoordinates(characters[index].box)
    const right = boxCoordinates(characters[index + 1].box)
    if (!left || !right) continue
    const distance = right.x - left.x2
    if (distance > 1) distances.push(distance)
  }
  const distinct = numericallyDistinct(distances)
  const medianDistance = distinct.length === 0 ? 1 : distinct.length === 1 ? distinct[0] : distinct[1]
  let index = 0
  while (index < characters.length - 1) {
    const current = boxCoordinates(characters[index].box)
    const next = boxCoordinates(characters[index + 1].box)
    if (!current || !next) { index += 1; continue }
    let distance = next.x - current.x2
    if (distance >= medianDistance || isNewline(characters[index], characters[index + 1])) {
      if (distance < 0) distance = -distance
      characters.splice(index + 1, 0, dummySpace(characters[index], Math.min(distance, medianDistance)))
      index += 2
    } else {
      index += 1
    }
  }
}

function dummySpace(character: ILPdfCharacter, distance: number): ILPdfCharacter {
  const box = boxCoordinates(character.box)
  if (!box) return { char_unicode: ' ' }
  const spaceBox: ILBox = { x: box.x2, y: box.y, x2: box.x2 + distance, y2: box.y2 }
  return {
    pdf_style: character.pdf_style,
    box: spaceBox,
    visual_bbox: { box: spaceBox },
    scale: character.scale,
    char_unicode: ' ',
    advance: distance
  }
}

function processSpacing(paragraph: ILPdfParagraph): void {
  const processed: ILPdfParagraphComposition[] = []
  for (const composition of paragraph.pdf_paragraph_composition ?? []) {
    const line = composition.pdf_line
    if (!line) { processed.push(composition); continue }
    const joined = (line.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')
    if (![...joined].some((codePoint) => !isWhitespaceCodePoint(codePoint))) continue
    const chars: ILPdfCharacter[] = []
    for (const character of line.pdf_character ?? []) {
      const whitespace = isWhitespaceOnly(character.char_unicode ?? '')
      if (!whitespace) chars.push(character)
      else if (chars.length > 0) chars.push(character)
    }
    while (chars.length > 0 && isWhitespaceOnly(chars[chars.length - 1].char_unicode ?? '')) chars.pop()
    if (chars.length > 0) processed.push(makeLine(chars))
  }
  paragraph.pdf_paragraph_composition = processed
  updateParagraph(paragraph)
}

function updateParagraph(paragraph: ILPdfParagraph, options: { updateUnicode?: boolean } = {}): void {
  const characters = paragraphCharacters(paragraph)
  if (options.updateUnicode && characters.length > 0) paragraph.unicode = unicodeString(characters)
  if (characters.length === 0) return
  const boxes = characters
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<typeof box> => box !== null)
  if (boxes.length === 0) return
  paragraph.box = {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
  paragraph.vertical = characters[0].vertical
  paragraph.xobj_id = characters[0].xobj_id
  paragraph.first_line_indent = false
  const firstLine = paragraph.pdf_paragraph_composition?.[0]?.pdf_line
  const first = firstLine?.pdf_character?.[0]
  const firstBox = first ? boxCoordinates(first.visual_bbox?.box) : null
  const paragraphBox = boxCoordinates(paragraph.box)
  if (firstBox && paragraphBox && firstBox.x - paragraphBox.x > 1) {
    paragraph.first_line_indent = true
  }
}

function paragraphCharacters(paragraph: ILPdfParagraph): ILPdfCharacter[] {
  const characters: ILPdfCharacter[] = []
  for (const composition of paragraph.pdf_paragraph_composition ?? []) {
    if (composition.pdf_line) characters.push(...(composition.pdf_line.pdf_character ?? []))
    else if (composition.pdf_formula) characters.push(...(composition.pdf_formula.pdf_character ?? []))
    else if (composition.pdf_character) characters.push(composition.pdf_character)
  }
  return characters
}

function unicodeString(characters: ILPdfCharacter[]): string {
  const distances: number[] = []
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const left = boxCoordinates(characters[index].box)
    const right = boxCoordinates(characters[index + 1].box)
    if (!left || !right) continue
    const value = right.x - left.x2
    if (value > 1) distances.push(value)
  }
  const distinct = numericallyDistinct(distances)
  const threshold = distinct.length === 0 ? 1 : distinct.length === 1 ? distinct[0] : distinct[1]
  let result = ''
  for (let index = 0; index < characters.length; index += 1) {
    const raw = characters[index].char_unicode ?? ''
    result += normalizeWhitespace(raw)
    if (raw === ' ') continue
    if (index < characters.length - 1) {
      const current = boxCoordinates(characters[index].box)
      const next = boxCoordinates(characters[index + 1].box)
      if (current && next && (next.x - current.x2 >= threshold || isNewline(characters[index], characters[index + 1]))) {
        result += ' '
      }
    }
  }
  return foundationTrim(normalizeWhitespace(result))
}

function medianLineWidth(paragraphs: ILPdfParagraph[]): number {
  const widths = paragraphs
    .flatMap((paragraph) => paragraph.pdf_paragraph_composition ?? [])
    .map((composition) => (composition.pdf_line ? boxCoordinates(composition.pdf_line.box) : null))
    .filter((box): box is NonNullable<typeof box> => box !== null)
    .map((box) => box.x2 - box.x)
    .sort((lhs, rhs) => lhs - rhs)
  return median(widths)
}

function processIndependentParagraphs(
  paragraphs: ILPdfParagraph[],
  medianWidth: number,
  configuration: ParagraphFinderConfiguration
): void {
  let paragraphIndex = 0
  while (paragraphIndex < paragraphs.length) {
    if ((paragraphs[paragraphIndex].pdf_paragraph_composition ?? []).length <= 1) { paragraphIndex += 1; continue }
    let lineIndex = 1
    while (lineIndex < (paragraphs[paragraphIndex].pdf_paragraph_composition ?? []).length) {
      const compositions = paragraphs[paragraphIndex].pdf_paragraph_composition ?? []
      const previous = compositions[lineIndex - 1].pdf_line
      const previousBox = previous ? boxCoordinates(previous.box) : null
      if (!previous || !previousBox) { lineIndex += 1; continue }
      const text = (previous.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')
      const dotted = TableOfContentsDotLeader.containsLeader(text)
        || TableOfContentsDotLeader.containsProtectedSuffix(text)
      const currentLine = compositions[lineIndex].pdf_line
      const firstLine = compositions[0].pdf_line
      const currentListItem = (currentLine ? startsListItem(currentLine) : false)
        || (currentLine && firstLine ? (startsDashListItem(currentLine) && startsDashListItem(firstLine)) : false)
      if (
        dotted
        || (configuration.splitShortLines && previousBox.x2 - previousBox.x < medianWidth * configuration.shortLineSplitFactor)
        || currentListItem
      ) {
        const splitUnicode = currentLine ? numberedListSplit(paragraphs[paragraphIndex].unicode, currentLine) : null
        const suffix = compositions.slice(lineIndex)
        paragraphs[paragraphIndex].pdf_paragraph_composition = compositions.slice(0, lineIndex)
        const next: ILPdfParagraph = {
          box: { x: 0, y: 0, x2: 0, y2: 0 },
          pdf_paragraph_composition: suffix,
          unicode: '',
          debug_id: makeDebugID(paragraphs.length),
          layout_label: paragraphs[paragraphIndex].layout_label,
          layout_id: paragraphs[paragraphIndex].layout_id
        }
        if (currentListItem) {
          const prefix = physicalLineText(paragraphs[paragraphIndex].pdf_paragraph_composition ?? [])
          const suffixText = physicalLineText(suffix)
          if (prefix !== null && suffixText !== null) {
            paragraphs[paragraphIndex].unicode = prefix
            paragraphs[paragraphIndex].layout_label = 'list_item'
            next.unicode = suffixText
            next.layout_label = 'list_item'
          } else {
            paragraphs[paragraphIndex].unicode = undefined
            next.unicode = undefined
          }
        } else if (splitUnicode) {
          paragraphs[paragraphIndex].unicode = splitUnicode.prefix
          next.unicode = splitUnicode.suffix
        } else {
          paragraphs[paragraphIndex].unicode = undefined
          next.unicode = undefined
        }
        updateParagraph(paragraphs[paragraphIndex])
        updateParagraph(next)
        paragraphs.splice(paragraphIndex + 1, 0, next)
        break
      }
      lineIndex += 1
    }
    paragraphIndex += 1
  }
}

function physicalLineText(compositions: ILPdfParagraphComposition[]): string | null {
  const parts = compositions
    .map((composition) => composition.pdf_line)
    .filter((line): line is ILPdfLine => line !== undefined)
    .map((line) => foundationTrim(listLineUnicode(line.pdf_character ?? [])))
    .filter((text) => text.length > 0)
  const text = parts.join(' ')
  return text.length === 0 ? null : text
}

/** A narrow algorithm listing that the detector returned as one tall plain-text
 * box is relabeled as code so translation keeps its source geometry. */
function markPseudocodeBlocks(paragraphs: ILPdfParagraph[]): void {
  for (const paragraph of paragraphs) {
    if ((paragraph.layout_label ?? '').toLowerCase() !== 'plain text') continue
    const lines = (paragraph.pdf_paragraph_composition ?? [])
      .map((composition) => composition.pdf_line)
      .filter((line): line is ILPdfLine => line !== undefined)
    if (lines.length < 8) continue

    const texts = lines
      .map((line) => foundationTrim(normalizeWhitespace((line.pdf_character ?? []).map((character) => character.char_unicode ?? '').join(''))))
      .filter((text) => text.length > 0)
    if (texts.length < 8) continue

    const callCount = texts.filter(isPseudocodeCall).length
    const controlCount = texts.filter(isPseudocodeControlFlow).length
    const assignmentCount = texts.filter(isPseudocodeAssignment).length
    const signalCount = texts.filter((text) =>
      isPseudocodeCall(text) || isPseudocodeControlFlow(text) || isPseudocodeAssignment(text)).length
    const minimumSignals = Math.max(5, Math.ceil(texts.length * 0.35))
    if (callCount < 2 || controlCount + assignmentCount < 2 || signalCount < minimumSignals) continue

    const starts = lines
      .map((line) => boxCoordinates(line.box)?.x)
      .filter((x): x is number => x !== undefined)
      .sort((lhs, rhs) => lhs - rhs)
    const indentationLevels = clusteredIndentationCount(starts, 4)
    if (!(indentationLevels >= 2 || signalCount * 2 >= texts.length)) continue
    paragraph.layout_label = 'code'
  }
}

function isPseudocodeCall(text: string): boolean {
  return pseudocodeCall.test(text)
}

function isPseudocodeControlFlow(text: string): boolean {
  return pseudocodeControlFlow.test(text)
}

function isPseudocodeAssignment(text: string): boolean {
  return text.includes('←') || text.includes(':=') || text.includes('≔')
}

function clusteredIndentationCount(values: number[], tolerance: number): number {
  if (values.length === 0) return 0
  let previous = values[0]
  let count = 1
  for (const value of values.slice(1)) {
    if (value - previous > tolerance) {
      count += 1
      previous = value
    }
  }
  return count
}

function listLineUnicode(characters: ILPdfCharacter[]): string {
  const candidateGaps: number[] = []
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const previousBox = boxCoordinates(characters[index].box)
    const currentBox = boxCoordinates(characters[index + 1].box)
    if (!previousBox || !currentBox) continue
    const gap = currentBox.x - previousBox.x2
    if (gap > 1) candidateGaps.push(gap)
  }
  const minimum = candidateGaps.length > 0 ? Math.min(...candidateGaps) : null
  const threshold = minimum === null ? 1 : Math.max(1, minimum - 0.05)
  let result = ''
  for (let index = 0; index < characters.length; index += 1) {
    const raw = characters[index].char_unicode ?? ''
    result += normalizeWhitespace(raw)
    if (raw === ' ') continue
    if (index < characters.length - 1) {
      const previousBox = boxCoordinates(characters[index].box)
      const currentBox = boxCoordinates(characters[index + 1].box)
      if (previousBox && currentBox && currentBox.x - previousBox.x2 >= threshold) result += ' '
    }
  }
  return normalizeWhitespace(result)
}

/** Recovers the common enumerated wireless-table shape: an aligned numeric key
 * column plus at least two repeated content-column starts. */
function repairEnumeratedTableCells(paragraphs: ILPdfParagraph[], tableLayouts: ILPageLayout[]): void {
  for (const tableLayout of tableLayouts) {
    const tableBox = boxCoordinates(tableLayout.box)
    if (!tableBox) continue
    const tableWidth = tableBox.x2 - tableBox.x
    if (tableWidth <= 0) continue

    const tableIndices = paragraphs
      .map((_, index) => index)
      .filter((index) => {
        const box = boxCoordinates(paragraphs[index].box)
        if (!box) return false
        const centerX = (box.x + box.x2) / 2
        const centerY = (box.y + box.y2) / 2
        return centerX >= tableBox.x - 1 && centerX <= tableBox.x2 + 1
          && centerY >= tableBox.y - 1 && centerY <= tableBox.y2 + 1
      })
    if (tableIndices.length < 9) continue

    const markerIndices = tableIndices
      .filter((index) => {
        const box = boxCoordinates(paragraphs[index].box)
        if (!box) return false
        const text = paragraphText(paragraphs[index])
        return enumerationMarker.test(text)
          && box.x2 - box.x <= tableWidth * 0.12
          && (box.x + box.x2) / 2 <= tableBox.x + tableWidth * 0.2
      })
      .sort((lhs, rhs) =>
        (boxCoordinates(paragraphs[lhs].box)?.y2 ?? 0) - (boxCoordinates(paragraphs[rhs].box)?.y2 ?? 0))
    if (markerIndices.length < 3) continue

    const markerCentersX = markerIndices
      .map((index) => boxCoordinates(paragraphs[index].box))
      .filter((box): box is NonNullable<typeof box> => box !== null)
      .map((box) => (box.x + box.x2) / 2)
    if (markerCentersX.length === 0) continue
    const minimumMarkerX = Math.min(...markerCentersX)
    const maximumMarkerX = Math.max(...markerCentersX)
    if (maximumMarkerX - minimumMarkerX > Math.max(4, tableWidth * 0.02)) continue
    const markerCenterX = markerCentersX.reduce((sum, value) => sum + value, 0) / markerCentersX.length

    const columnTolerance = Math.max(3, tableWidth * 0.015)
    const nonMarkerIndices = tableIndices.filter((index) => !markerIndices.includes(index))
    const startClusters = clusteredStarts(
      nonMarkerIndices
        .map((index) => boxCoordinates(paragraphs[index].box)?.x)
        .filter((x): x is number => x !== undefined),
      columnTolerance
    )
    const minimumSupport = Math.max(3, Math.min(markerIndices.length, 4))
    const columnAnchors = startClusters
      .filter((cluster) => cluster.values.length >= minimumSupport && clusterCenter(cluster) >= markerCenterX + tableWidth * 0.05)
      .map(clusterCenter)
      .sort((lhs, rhs) => lhs - rhs)
    if (columnAnchors.length < 2) continue

    const markerRows = markerIndices
      .map((index) => {
        const box = boxCoordinates(paragraphs[index].box)
        if (!box) return null
        return { index, centerY: (box.y + box.y2) / 2, height: box.y2 - box.y }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
    if (markerRows.length !== markerIndices.length) continue
    const rowTolerance = Math.max(2, median([...markerRows].map((row) => row.height).sort((lhs, rhs) => lhs - rhs)) * 0.75)

    const cellIndices = new Map<string, number[]>()
    for (const index of nonMarkerIndices) {
      const box = boxCoordinates(paragraphs[index].box)
      if (!box) continue
      const centerY = (box.y + box.y2) / 2
      let row: number | null = null
      for (let candidate = 0; candidate < markerRows.length; candidate += 1) {
        if (centerY <= markerRows[candidate].centerY + rowTolerance) row = candidate
        else break
      }
      if (row === null) continue

      let column: number | null = null
      for (let candidate = 0; candidate < columnAnchors.length; candidate += 1) {
        if (box.x + columnTolerance >= columnAnchors[candidate]) column = candidate
      }
      if (column === null) continue
      const key = `${row}:${column}`
      cellIndices.set(key, [...(cellIndices.get(key) ?? []), index])
    }

    const mergeGroups = [...cellIndices.values()].filter((indices) => indices.length > 1)
    if (mergeGroups.length === 0) continue
    const replacements = new Map<number, ILPdfParagraph>()
    const removed = new Set<number>()
    for (const indices of mergeGroups) {
      const ordered = orderedTableCellFragments(indices, paragraphs)
      if (ordered.length === 0) continue
      const insertionIndex = Math.min(...ordered)
      const merged: ILPdfParagraph = { ...paragraphs[ordered[0]] }
      merged.pdf_paragraph_composition = ordered.flatMap((index) => paragraphs[index].pdf_paragraph_composition ?? [])
      merged.unicode = joinedTableCellText(ordered.map((index) => paragraphs[index]))
      merged.layout_label = 'wireless_table_cell'
      merged.debug_id = makeDebugID(paragraphs.length + insertionIndex)
      updateParagraph(merged)
      replacements.set(insertionIndex, merged)
      for (const index of ordered) removed.add(index)
    }
    if (replacements.size === 0) continue

    const rebuilt: ILPdfParagraph[] = []
    for (let index = 0; index < paragraphs.length; index += 1) {
      const replacement = replacements.get(index)
      if (replacement) rebuilt.push(replacement)
      if (!removed.has(index)) rebuilt.push(paragraphs[index])
    }
    paragraphs.length = 0
    paragraphs.push(...rebuilt)
  }
}

interface StartCluster { values: number[] }

function clusterCenter(cluster: StartCluster): number {
  return cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length
}

function clusteredStarts(values: number[], tolerance: number): StartCluster[] {
  const clusters: StartCluster[] = []
  for (const value of [...values].sort((lhs, rhs) => lhs - rhs)) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(value - clusterCenter(last)) <= tolerance) last.values.push(value)
    else clusters.push({ values: [value] })
  }
  return clusters
}

function orderedTableCellFragments(indices: number[], paragraphs: ILPdfParagraph[]): number[] {
  const positioned = indices
    .map((index) => ({ index, box: boxCoordinates(paragraphs[index].box) }))
    .filter((item): item is { index: number; box: NonNullable<typeof item.box> } => item.box !== null)
    .sort((lhs, rhs) => {
      if (lhs.box.y2 !== rhs.box.y2) return rhs.box.y2 - lhs.box.y2
      if (lhs.box.x !== rhs.box.x) return lhs.box.x - rhs.box.x
      return lhs.index - rhs.index
    })

  const lines: { indices: number[]; box: { x: number; y: number; x2: number; y2: number } }[] = []
  for (const item of positioned) {
    let best = -1
    let bestOverlap = -1
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex].box
      const overlap = Math.max(0, Math.min(line.y2, item.box.y2) - Math.max(line.y, item.box.y))
      const minimumHeight = Math.min(line.y2 - line.y, item.box.y2 - item.box.y)
      const ratio = minimumHeight > 0 ? overlap / minimumHeight : 0
      if (ratio >= 0.6 && (best === -1 || ratio > bestOverlap)) {
        best = lineIndex
        bestOverlap = ratio
      }
    }
    if (best >= 0) {
      lines[best].indices.push(item.index)
      const old = lines[best].box
      lines[best].box = {
        x: Math.min(old.x, item.box.x), y: Math.min(old.y, item.box.y),
        x2: Math.max(old.x2, item.box.x2), y2: Math.max(old.y2, item.box.y2)
      }
    } else {
      lines.push({ indices: [item.index], box: item.box })
    }
  }
  return lines
    .sort((lhs, rhs) => {
      if (lhs.box.y2 !== rhs.box.y2) return rhs.box.y2 - lhs.box.y2
      return lhs.box.x - rhs.box.x
    })
    .flatMap((line) => line.indices.slice().sort((lhs, rhs) => {
      const left = boxCoordinates(paragraphs[lhs].box)?.x
      const right = boxCoordinates(paragraphs[rhs].box)?.x
      if (left !== right) return (left ?? 0) - (right ?? 0)
      return lhs - rhs
    }))
}

function joinedTableCellText(fragments: ILPdfParagraph[]): string {
  let result = ''
  for (const fragment of fragments) {
    const text = foundationTrim(fragment.unicode ?? paragraphText(fragment))
    if (text.length === 0) continue
    if (result.length === 0) result = text
    else if (result.endsWith('-')) result += text
    else result += ` ${text}`
  }
  return result
}

function startsListItem(line: ILPdfLine): boolean {
  const first = line.pdf_character?.[0]
  if (first && isBullet(first)) return true
  const text = unicodeString((line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined))
  return listItemStart.test(text)
}

function startsDashListItem(line: ILPdfLine): boolean {
  const text = unicodeString((line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined))
  return dashListItemStart.test(text)
}

function numberedListSplit(paragraphUnicode: string | undefined, line: ILPdfLine): { prefix: string; suffix: string } | null {
  if (paragraphUnicode === undefined) return null
  const lineText = unicodeString((line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined))
  const lineMatch = numberedLineStart.exec(lineText)
  if (!lineMatch) return null
  const marker = escapeRegExp(lineMatch[1])
  const nextWord = escapeRegExp(lineMatch[2])
  const anchor = new RegExp(`(?<!\\S)${marker}\\s+${nextWord}`, 'g')
  const matches = [...paragraphUnicode.matchAll(anchor)]
  if (matches.length !== 1) return null
  const match = matches[0]
  const splitOffset = match.index ?? 0
  if (splitOffset <= 0) return null
  const prefix = foundationTrim(paragraphUnicode.slice(0, splitOffset))
  const suffix = foundationTrim(paragraphUnicode.slice(splitOffset))
  if (prefix.length === 0 || suffix.length === 0) return null
  return { prefix, suffix }
}

function paragraphText(paragraph: ILPdfParagraph): string {
  return foundationTrim(unicodeString(paragraphCharacters(paragraph).filter((character) => character.pdf_character_id !== undefined)))
}

/** Rejoins one visual TOC row the detector split into section number, title,
 * dot leader and page number — only rows with strong leader evidence. */
function repairFragmentedTableOfContentsRows(paragraphs: ILPdfParagraph[]): void {
  for (;;) {
    const pageTOCEvidence = paragraphs.filter((paragraph) => {
      const text = paragraphCharacters(paragraph).map((character) => character.char_unicode ?? '').join('')
      return TableOfContentsDotLeader.containsLeader(text)
        || TableOfContentsDotLeader.containsProtectedSuffix(text)
    }).length
    let repair: { indices: number[]; paragraph: ILPdfParagraph } | null = null
    for (const [anchorIndex, anchor] of paragraphs.entries()) {
      const anchorText = paragraphCharacters(anchor).map((character) => character.char_unicode ?? '').join('')
      const hasStrongLeader = TableOfContentsDotLeader.containsLeader(anchorText)
      const hasSparseLeader = pageTOCEvidence >= 2 && sparseTableOfContentsLeaderAtEnd(anchorText)
      if (!hasStrongLeader && !hasSparseLeader) continue
      const anchorLine = singleLine(anchor)
      const anchorBox = anchorLine ? boxCoordinates(anchorLine.box) : null
      if (!anchorLine || !anchorBox) continue

      const rowIndices = paragraphs
        .map((_, index) => index)
        .filter((index) => {
          if (paragraphs[index].xobj_id !== anchor.xobj_id) return false
          const line = singleLine(paragraphs[index])
          if (!line) return false
          const box = boxCoordinates(line.box)
          if (!box) return false
          const overlap = Math.min(anchorBox.y2, box.y2) - Math.max(anchorBox.y, box.y)
          const minimumHeight = Math.min(anchorBox.y2 - anchorBox.y, box.y2 - box.y)
          return minimumHeight > 0 && overlap / minimumHeight >= 0.6
        })
      if (rowIndices.length <= 1) continue

      const characters = rowIndices
        .flatMap((index) => singleLine(paragraphs[index])?.pdf_character ?? [])
        .sort((lhs, rhs) => {
          const left = boxCoordinates(lhs.box)?.x
          const right = boxCoordinates(rhs.box)?.x
          if (left !== right) return (left ?? 0) - (right ?? 0)
          return (lhs.render_order ?? Number.MAX_SAFE_INTEGER) - (rhs.render_order ?? Number.MAX_SAFE_INTEGER)
        })
      addSpaces(characters)
      const text = characters.map((character) => character.char_unicode ?? '').join('')
      const hasProtectedSuffix = TableOfContentsDotLeader.containsProtectedSuffix(text)
      const isSparseTOCRow = hasSparseLeader
        && numberedSectionTitle.test(unicodeString(characters))
        && trailingPageMarkerRange(characters.filter((character) => character.pdf_character_id !== undefined)) !== null
      if (!hasProtectedSuffix && !isSparseTOCRow) continue

      const insertionIndex = Math.min(...rowIndices)
      const merged: ILPdfParagraph = { ...paragraphs[insertionIndex] }
      merged.pdf_paragraph_composition = [makeLine(characters)]
      merged.layout_label = rowIndices
        .map((index) => (paragraphs[index].layout_label === 'fallback_line' ? null : paragraphs[index].layout_label))
        .filter((label): label is string => label !== null)[0] ?? merged.layout_label
      updateParagraph(merged, { updateUnicode: true })
      repair = { indices: rowIndices, paragraph: merged }
      break
    }
    if (!repair) return
    const insertionIndex = Math.min(...repair.indices)
    const removed = new Set(repair.indices)
    const rebuilt: ILPdfParagraph[] = []
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (index === insertionIndex) rebuilt.push(repair.paragraph)
      if (!removed.has(index)) rebuilt.push(paragraphs[index])
    }
    paragraphs.length = 0
    paragraphs.push(...rebuilt)
  }
}

function sparseTableOfContentsLeaderAtEnd(text: string): boolean {
  return sparseLeaderAtEnd.test(text)
}

/** Splits a numeric-only trailing page marker preceded by a large visual gap on
 * a page already proven to contain dotted TOC rows. */
function splitWideGapTableOfContentsPageMarkers(paragraphs: ILPdfParagraph[]): void {
  const tocEvidence = paragraphs.filter((paragraph) =>
    TableOfContentsDotLeader.containsProtectedSuffix(
      paragraphCharacters(paragraph).map((character) => character.char_unicode ?? '').join('')
    )).length
  if (tocEvidence < 2) return

  let index = 0
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]
    const paragraphTextValue = paragraphCharacters(paragraph).map((character) => character.char_unicode ?? '').join('')
    if (
      TableOfContentsDotLeader.containsLeader(paragraphTextValue)
      || TableOfContentsDotLeader.containsProtectedSuffix(paragraphTextValue)
    ) { index += 1; continue }
    const line = singleLine(paragraph)
    if (!line) { index += 1; continue }
    const original = (line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined)
    const markerRange = trailingPageMarkerRange(original)
    if (!markerRange || markerRange.start <= 0) { index += 1; continue }
    const markerBox = boxCoordinates(original[markerRange.start].box)
    const precedingBox = boxCoordinates(original[markerRange.start - 1].box)
    if (!markerBox || !precedingBox || markerBox.x - precedingBox.x2 < 12) { index += 1; continue }

    const markerStartX = markerBox.x
    const titleCharacters = (line.pdf_character ?? []).filter((character) => {
      const box = boxCoordinates(character.box)
      return box !== null && box.x2 <= markerStartX
    })
    while (titleCharacters.length > 0 && isWhitespaceOnly(titleCharacters[titleCharacters.length - 1].char_unicode ?? '')) {
      titleCharacters.pop()
    }
    const markerCharacters = original.slice(markerRange.start, markerRange.end)
    if (titleCharacters.length === 0 || markerCharacters.length === 0) { index += 1; continue }

    const title: ILPdfParagraph = { ...paragraph, pdf_paragraph_composition: [makeLine(titleCharacters)] }
    updateParagraph(title, { updateUnicode: true })
    const marker: ILPdfParagraph = {
      ...paragraph,
      pdf_paragraph_composition: [makeLine(markerCharacters)],
      debug_id: makeDebugID(paragraphs.length + index),
      layout_label: TableOfContentsDotLeader.pageMarkerLayoutLabel
    }
    updateParagraph(marker, { updateUnicode: true })
    paragraphs[index] = title
    paragraphs.splice(index + 1, 0, marker)
    index += 2
  }
}

/** Undotted contents pages can be one detector box with `title — page` rows;
 * requires three consecutive, aligned physical rows. */
function splitDashSeparatedTableOfContentsRows(paragraphs: ILPdfParagraph[]): void {
  const rebuilt: ILPdfParagraph[] = []
  for (const paragraph of paragraphs) {
    const compositions = paragraph.pdf_paragraph_composition ?? []
    if (
      !['plain text', 'text', 'fallback_line'].includes(paragraph.layout_label ?? '')
      || compositions.length < 3
      || !compositions.every((composition) => composition.pdf_line !== undefined)
    ) {
      rebuilt.push(paragraph)
      continue
    }
    const lines = compositions
      .map((composition) => composition.pdf_line)
      .filter((line): line is ILPdfLine => line !== undefined)
    const rowIndices = new Set<number>()
    let run: number[] = []
    const finishRun = () => {
      if (run.length >= 3) for (const index of run) rowIndices.add(index)
      run = []
    }
    for (let index = 0; index < lines.length; index += 1) {
      const text = foundationTrim(listLineUnicode(lines[index].pdf_character ?? []))
      const box = boxCoordinates(lines[index].box)
      if (!dashSeparatedTOCRow.test(text) || !box) {
        finishRun()
        continue
      }
      const previous = run[run.length - 1]
      if (previous !== undefined) {
        const previousBox = boxCoordinates(lines[previous].box)
        if (previousBox) {
          const height = Math.max(box.y2 - box.y, previousBox.y2 - previousBox.y)
          const pitch = previousBox.y - box.y
          if (Math.abs(box.x - previousBox.x) > Math.max(2, height * 0.5) || pitch < height * 0.8 || pitch > height * 3) {
            finishRun()
          }
        }
      }
      run.push(index)
    }
    finishRun()
    if (rowIndices.size === 0) { rebuilt.push(paragraph); continue }

    // Preserve contiguous non-TOC text as paragraphs, and copy each accepted
    // row's original glyph geometry.
    let start = 0
    while (start < compositions.length) {
      let end = start + 1
      const isRow = rowIndices.has(start)
      if (!isRow) {
        while (end < compositions.length && !rowIndices.has(end)) end += 1
      }
      const replacement: ILPdfParagraph = { ...paragraph, pdf_paragraph_composition: compositions.slice(start, end) }
      replacement.debug_id = makeDebugID(paragraphs.length + rebuilt.length)
      if (isRow) replacement.layout_label = 'table_of_contents_item'
      updateParagraph(replacement, { updateUnicode: true })
      replacement.unicode = physicalLineText(replacement.pdf_paragraph_composition ?? []) ?? undefined
      rebuilt.push(replacement)
      start = end
    }
  }
  paragraphs.length = 0
  paragraphs.push(...rebuilt)
}

function splitMultiLineTableOfContentsParagraphs(paragraphs: ILPdfParagraph[]): void {
  const tocEvidence = paragraphs.filter((paragraph) =>
    TableOfContentsDotLeader.containsProtectedSuffix(
      paragraphCharacters(paragraph).map((character) => character.char_unicode ?? '').join('')
    )).length
  if (tocEvidence < 2) return

  let index = 0
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]
    const lines = (paragraph.pdf_paragraph_composition ?? [])
      .map((composition) => composition.pdf_line)
      .filter((line): line is ILPdfLine => line !== undefined)
    if (
      lines.length <= 1
      || !lines.every((line) =>
        isTableOfContentsTitleLine(line)
        && (trailingPageMarkerRange((line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined)) !== null
          || hasAlignedTableOfContentsPageMarker(line, paragraphs, index)))
    ) { index += 1; continue }

    const replacements = lines.map((line, offset) => {
      const replacement: ILPdfParagraph = {
        ...paragraph,
        pdf_paragraph_composition: [{ pdf_line: line }],
        debug_id: makeDebugID(paragraphs.length + index + offset)
      }
      updateParagraph(replacement, { updateUnicode: true })
      return replacement
    })
    paragraphs.splice(index, 1, ...replacements)
    index += replacements.length
  }
}

function isTableOfContentsTitleLine(line: ILPdfLine): boolean {
  const text = unicodeString((line.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined))
  return numberedSectionTitle.test(text)
}

function hasAlignedTableOfContentsPageMarker(line: ILPdfLine, paragraphs: ILPdfParagraph[], excluding: number): boolean {
  const lineBox = boxCoordinates(line.box)
  if (!lineBox) return false
  return paragraphs.some((paragraph, index) => {
    if (index === excluding) return false
    const markerLine = singleLine(paragraph)
    if (!markerLine) return false
    const markerBox = boxCoordinates(markerLine.box)
    if (!markerBox || markerBox.x <= lineBox.x) return false
    if (trailingPageMarkerRange((markerLine.pdf_character ?? []).filter((character) => character.pdf_character_id !== undefined)) === null) {
      return false
    }
    const overlap = Math.min(lineBox.y2, markerBox.y2) - Math.max(lineBox.y, markerBox.y)
    const minimumHeight = Math.min(lineBox.y2 - lineBox.y, markerBox.y2 - markerBox.y)
    return minimumHeight > 0 && overlap / minimumHeight >= 0.6
  })
}

function singleLine(paragraph: ILPdfParagraph): ILPdfLine | null {
  const compositions = paragraph.pdf_paragraph_composition ?? []
  if (compositions.length !== 1) return null
  return compositions[0].pdf_line ?? null
}

function trailingPageMarkerRange(characters: ILPdfCharacter[]): { start: number; end: number } | null {
  let end = characters.length
  while (end > 0 && isWhitespaceOnly(characters[end - 1].char_unicode ?? '')) end -= 1
  if (end <= 0) return null
  const last = characters[end - 1].char_unicode ?? ''
  const lastCodePoints = [...last]
  const isDecimal = last.length > 0 && lastCodePoints.every((codePoint) => isNumberDecimal(codePoint))
  const isRoman = last.length > 0 && lastCodePoints.every((codePoint) => romanFragment.test(codePoint))
  if (!isDecimal && !isRoman) return null
  let start = end
  while (start > 0) {
    const value = characters[start - 1].char_unicode ?? ''
    const belongs = value.length > 0 && [...value].every((codePoint) =>
      isDecimal ? isNumberDecimal(codePoint) : romanFragment.test(codePoint))
    if (!belongs) break
    start -= 1
  }
  if (start >= end) return null
  const marker = characters.slice(start, end).map((character) => character.char_unicode ?? '').join('')
  if (![...marker].some((codePoint) => isNumberDecimal(codePoint)) && [...marker].length > 8) return null
  return { start, end }
}

function isNumberDecimal(value: string): boolean {
  return isNumberCodePoint(value)
}

function mergeAlternatingLineNumbers(paragraphs: ILPdfParagraph[]): void {
  if (paragraphs.length < 3) return
  let index = 0
  while (index < paragraphs.length - 2) {
    let candidate = index + 1
    let sawLineNumber = false
    while (candidate < paragraphs.length && isDigitOrSpaceParagraph(paragraphs[candidate])) {
      sawLineNumber = true
      candidate += 1
    }
    if (
      sawLineNumber && candidate < paragraphs.length
      && paragraphs[index].layout_id !== undefined
      && paragraphs[index].layout_id === paragraphs[candidate].layout_id
      && paragraphs[index].xobj_id !== undefined
      && paragraphs[index].xobj_id === paragraphs[candidate].xobj_id
    ) {
      paragraphs[index].pdf_paragraph_composition = [
        ...(paragraphs[index].pdf_paragraph_composition ?? []),
        ...(paragraphs[candidate].pdf_paragraph_composition ?? [])
      ]
      updateParagraph(paragraphs[index], { updateUnicode: true })
      paragraphs.splice(candidate, 1)
    } else {
      index += 1
    }
  }
}

function isDigitOrSpaceParagraph(paragraph: ILPdfParagraph): boolean {
  const text = paragraphCharacters(paragraph).map((character) => character.char_unicode ?? '').join('')
  if (text.length === 0) return true
  let digit = false
  for (const codePoint of text) {
    const code = codePoint.codePointAt(0) ?? 0
    if (code < 128 && isNumberDecimal(codePoint)) { digit = true; continue }
    if (isWhitespaceCodePoint(codePoint)) continue
    return false
  }
  return digit || foundationTrim(text).length === 0
}

function isCIDParagraph(paragraph: ILPdfParagraph): boolean {
  const characters = paragraphCharacters(paragraph)
  let cidCount = 0
  for (const character of characters) {
    if (cidParagraphPattern.test(character.char_unicode ?? '')) cidCount += 1
  }
  return cidCount > characters.length * 0.8
}

function fixOverlaps(paragraphs: ILPdfParagraph[]): void {
  if (paragraphs.length < 2) return
  const maximum = paragraphs.length * paragraphs.length
  for (let iteration = 0; iteration < maximum; iteration += 1) {
    let found = false
    for (let firstIndex = 0; firstIndex < paragraphs.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < paragraphs.length; secondIndex += 1) {
        if (paragraphs[firstIndex].xobj_id !== paragraphs[secondIndex].xobj_id) continue
        const first = boxCoordinates(paragraphs[firstIndex].box)
        const second = boxCoordinates(paragraphs[secondIndex].box)
        if (!first || !second) continue
        if (!overlaps(first, second) || verticallyContained(first, second)) continue
        const yStart = Math.max(first.y, second.y)
        const yEnd = Math.min(first.y2, second.y2)
        const xStart = Math.max(first.x, second.x)
        const xEnd = Math.min(first.x2, second.x2)
        if (yEnd - yStart <= 1e-6 || xEnd - xStart <= 1e-6) continue
        found = true
        const midpoint = yStart + (yEnd - yStart) / 2
        if (first.y2 > second.y && first.y < second.y) {
          if (midpoint > second.y && midpoint < first.y2) { second.y = midpoint + 1; first.y2 = midpoint - 1 }
        } else if (first.y2 < second.y2) {
          if (midpoint > second.y && midpoint < first.y2) { second.y = midpoint + 1; first.y2 = midpoint - 1 }
        } else if (midpoint > first.y && midpoint < second.y2) {
          first.y = midpoint + 1
          second.y2 = midpoint - 1
        }
        paragraphs[firstIndex].box = { x: first.x, y: first.y, x2: first.x2, y2: first.y2 }
        paragraphs[secondIndex].box = { x: second.x, y: second.y, x2: second.x2, y2: second.y2 }
      }
    }
    if (!found) break
  }
}

function setRenderOrder(paragraphs: ILPdfParagraph[]): void {
  for (const paragraph of paragraphs) {
    const orders = paragraphCharacters(paragraph)
      .map((character) => character.render_order)
      .filter((order): order is number => order !== undefined)
    if (orders.length > 0) paragraph.render_order = Math.min(...orders)
  }
}

function isNewline(previous: ILPdfCharacter, current: ILPdfCharacter): boolean {
  const first = boxCoordinates(previous.box)
  const second = boxCoordinates(current.box)
  if (!first || !second) return false
  const width = Math.max(second.x2 - second.x, first.x2 - first.x)
  const newline = second.y2 < first.y || second.x2 < first.x - width * 10
  if (
    newline
    && (previous.pdf_character_id === undefined
      || current.pdf_character_id === undefined
      || previous.char_unicode === undefined
      || current.char_unicode === undefined)
  ) {
    return false
  }
  return newline
}

function isIsolatedFormula(character: ILPdfCharacter): boolean {
  return ['(cid:122)', '(cid:123)', '(cid:124)', '(cid:125)'].includes(character.char_unicode ?? '')
}

function isBullet(character: ILPdfCharacter): boolean {
  return bulletPattern.test(character.char_unicode ?? '')
}

function isWhitespaceOnly(value: string): boolean {
  return value.length > 0 && [...value].every((codePoint) => isWhitespaceCodePoint(codePoint))
}

function startsWithWhitespace(value: string): boolean {
  return isWhitespaceCodePoint([...value][0])
}

function firstCharacter(composition: ILPdfParagraphComposition): ILPdfCharacter | undefined {
  return composition.pdf_line?.pdf_character?.[0]
    ?? composition.pdf_same_style_characters?.pdf_character?.[0]
    ?? composition.pdf_formula?.pdf_character?.[0]
    ?? composition.pdf_character
}

function lastCharacter(composition: ILPdfParagraphComposition): ILPdfCharacter | undefined {
  const line = composition.pdf_line?.pdf_character
  const same = composition.pdf_same_style_characters?.pdf_character
  const formula = composition.pdf_formula?.pdf_character
  if (line && line.length > 0) return line[line.length - 1]
  if (same && same.length > 0) return same[same.length - 1]
  if (formula && formula.length > 0) return formula[formula.length - 1]
  return composition.pdf_character
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]
}

/** Stage 2 can produce sub-millipoint coordinate deltas; collapse values inside
 * the established frontend tolerance before selecting the second gap. */
function numericallyDistinct(values: number[]): number[] {
  const result: number[] = []
  for (const value of [...values].sort((lhs, rhs) => lhs - rhs)) {
    const last = result[result.length - 1]
    if (last !== undefined && Math.abs(value - last) < 0.001) continue
    result.push(value)
  }
  return result
}

function makeDebugID(index: number): string {
  return `swift${index}`
}

function overlaps(
  first: { x: number; y: number; x2: number; y2: number },
  second: { x: number; y: number; x2: number; y2: number }
): boolean {
  return first.x < second.x2 && first.x2 > second.x && first.y < second.y2 && first.y2 > second.y
}

function verticallyContained(
  first: { x: number; y: number; x2: number; y2: number },
  second: { x: number; y: number; x2: number; y2: number }
): boolean {
  return (first.y >= second.y && first.y2 <= second.y2) || (second.y >= first.y && second.y2 <= first.y2)
}
