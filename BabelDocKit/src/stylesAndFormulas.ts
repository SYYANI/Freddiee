// Stage 5 formula classification and style merging, ported from Swift
// StylesAndFormulas. Formula-font tables, corner-mark state machine, stacked
// fraction recovery and same-style grouping all follow the Swift behavior;
// target-font coverage checks run through the wasm MuPDF faces.
import {
  boxCoordinates, pythonBool,
  type ILBox, type ILDocument, type ILGraphicState, type ILPage, type ILPdfParagraphComposition,
  type ILPdfCharacter, type ILPdfCurve, type ILPdfForm, type ILPdfFormula, type ILPdfLine, type ILPdfParagraph, type ILPdfStyle
} from './il'
import { LayoutHelper } from './layoutHelper'
import { classificationFontNames, loadTargetFonts, type TargetFont } from './targetFonts'

export interface StylesAndFormulasConfiguration {
  formulaFontPattern?: string | null
  formulaCharacterPattern?: string | null
  skipFormulaOffsetCalculation: boolean
  ocrWorkaround: boolean
  removeNonFormulaLines: boolean
  nonFormulaLineCoverageThreshold: number
  figureTableProtectionThreshold: number
  targetFontDirectory?: string | null
}

export const defaultStylesAndFormulasConfiguration: StylesAndFormulasConfiguration = {
  formulaFontPattern: null,
  formulaCharacterPattern: null,
  skipFormulaOffsetCalculation: false,
  ocrWorkaround: false,
  removeNonFormulaLines: false,
  nonFormulaLineCoverageThreshold: 0.9,
  figureTableProtectionThreshold: 0.9,
  targetFontDirectory: null
}

const leftBrackets = new Set(['(cid:8)', '(', '(cid:16)', '{', '[', '(cid:104)', '(cid:2)'])
const rightBrackets = new Set(['(cid:9)', ')', '(cid:17)', '}', ']', '(cid:105)', '(cid:3)'])
const figureTableLayouts = new Set([
  'figure', 'table', 'figure_text', 'table_text', 'figure_caption', 'table_caption',
  'figure_title', 'table_title', 'chart_title', 'table_cell', 'table_cell_hybrid',
  'wired_table_cell', 'wireless_table_cell', 'table_footnote'
])
const nonDigitBracketPattern = /[^0-9[\],\s]/
const translatableFormulaPattern = /^[0-9, .]+$/

const expressionCache = new Map<string, RegExp | null>()
function expressionFor(pattern: string): RegExp | null {
  if (expressionCache.has(pattern)) return expressionCache.get(pattern) ?? null
  let value: RegExp | null
  try {
    value = new RegExp(pattern)
  } catch {
    value = null
  }
  if (expressionCache.size >= 32) expressionCache.clear()
  expressionCache.set(pattern, value)
  return value
}

function matchesAtStart(pattern: string, value: string): boolean {
  const expression = expressionFor(pattern)
  if (!expression) return false
  return expression.exec(value)?.index === 0
}

const formulaPrecisePrefixes = [
  'Asana', 'MiriamMonoCLM-BookOblique', 'Miriam Mono CLM', 'Logix', 'AeBonum',
  'AeMRoman', 'AePagella', 'AeSchola', 'Concrete', 'LatinModernMathCompanion',
  'Latin Modern Math Companion', 'RalphSmithsFormalScriptCompanion',
  'Ralph Smiths Formal Script Companion', 'TeXGyreBonumMathCompanion',
  'TeX Gyre Bonum Companion', 'TeXGyrePagellaMathCompanion',
  'TeX Gyre Pagella Math Companion', 'TeXGyreTermesMathCompanion',
  'TeX Gyre Termes Math Companion', 'XITSMathCompanion', 'XITS Math Companion',
  'Erewhon', 'Euler-Math', 'Euler Math', 'FiraMath-Regular', 'Fira Math',
  'Garamond-Math', 'GFSNeohellenicMath', 'KpMath', 'Lete Sans Math', 'LeteSansMath',
  'Luciole', 'NewCM', 'NewComputerModern', 'OldStandard-Math', 'STIXMath-Regular',
  'STIX Math', 'STIXTwoMath-Regular', 'STIX Two Math', 'TeXGyreBonumMath',
  'TeX Gyre Bonum Math', 'TeXGyreDejaVuMath', 'TeX Gyre DejaVu Math',
  'TeXGyrePagellaMath', 'TeX Gyre Pagella Math', 'TeXGyreScholaMath',
  'TeX Gyre Schola Math', 'TeXGyreTermesMath', 'TeX Gyre Termes Math',
  'XCharter-Math', 'XCharter Math', 'XITSMath-Bold', 'XITS Math', 'XITSMath',
  'IBMPlexMath', 'IBM Plex Math'
]
const formulaPreciseContains = [
  'Linux Libertine O', 'LibertinusMath-Regular', 'Libertinus Math',
  'LatinModernMath-Regular', 'Latin Modern Math'
]
const formulaTextPrefixes = [
  'BLKFort', 'Cambria', 'EUAlbertina', 'NimbusRomNo9L', 'GlosaMath',
  'URWPalladioL', 'CMSS', 'Arial', 'TimesNewRoman', 'SegoeUI', 'CMTT9',
  'CMSL10', 'CMTI10', 'CMTT10', 'CMTI12', 'CMR12', 'MeridienLTStd',
  'Calibri', 'STIXMathJax_Main'
]
const formulaTextContains = [
  'NewBaskerville', 'FranklinGothic', 'AGaramondPro', 'PalatinoItalCOR',
  'ITCSymbolStd', 'PlantinStd', 'DJ5EscrowCond', 'ExchangeBook', 'DJ5Exchange',
  'Times', 'PalatinoLTStd', 'Times New Roman,Italic', 'EhrhardtMT', 'GillSansMTStd',
  'MedicineSymbols3', 'HardingText', 'GraphikNaturel', 'HelveticaNeue',
  'GoudyOldStyleT', 'Symbol', 'ScalaSansLF', 'ScalaLF', 'ScalaSansPro',
  'PetersburgC', 'ColiseumC', 'Gantari', 'OptimaLTStd', 'CronosPro', 'ACaslon',
  'Frutiger', 'BrandonGrotesque', 'FairfieldLH', 'CaeciliaLTStd', 'Whitney',
  'Mercury', 'SabonLTStd', 'AnonymousPro', 'SabonLTPro', 'ArnoPro', 'CharisSIL',
  'MSReference', 'CMUSerif-Roman', 'CourierNewPS', 'XCharter', 'GillSans',
  'Perpetua', 'GEInspira', 'AGaramond', 'BMath', 'MSTT', 'Bookinsanity',
  'ScalySans', 'Code2000', 'Minion', 'JansonTextLT', 'MathPack', 'Macmillan',
  'NimbusSan', 'Mincho', 'Amerigo', 'MSGloriolaIIStd', 'CMU', 'LinLibertine',
  'txsys'
]
const defaultFormulaFontPattern = '(CM[^RB]|(MS|XY|MT|BL|RM|EU|LA|RS)[A-Z]|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Sym|.*Math|AdvP4C4E74|AdvPSSym|AdvP4C4E59)'

function isFormulaFont(rawName: string | undefined, customPattern?: string | null): boolean {
  if (!rawName) return false
  let decodedName = rawName
  if (rawName.startsWith('BASE64:')) {
    try {
      decodedName = Buffer.from(rawName.slice(7), 'base64').toString('utf8')
    } catch {
      decodedName = rawName.slice(7)
    }
  }
  const font = decodedName.split('+').pop() ?? decodedName
  if (font.length === 0) return false

  if (formulaPrecisePrefixes.some((prefix) => font.includes(prefix))
    || formulaPreciseContains.some((fragment) => font.includes(fragment))) {
    return true
  }
  if (formulaTextPrefixes.some((prefix) => font.startsWith(prefix))
    || formulaTextContains.some((fragment) => font.includes(fragment))) {
    return false
  }
  return matchesAtStart(customPattern ?? defaultFormulaFontPattern, font)
}

const scalarCategories: Array<{ test: RegExp }> = [
  { test: /\p{gc=Mn}/u }, { test: /\p{gc=Sk}/u }, { test: /\p{gc=Sm}/u }, { test: /\p{gc=Zl}/u },
  { test: /\p{gc=Zp}/u }, { test: /\p{gc=Zs}/u }, { test: /\p{gc=Co}/u }
]
const unassignedScalar = /\p{gc=Cn}/u

function targetHasCharacter(value: string, fonts: TargetFont[]): boolean {
  const scalars = [...value]
  if (scalars.length !== 1) return false
  const scalar = scalars[0]
  const unicode = scalar.codePointAt(0) ?? 0
  if (fonts.length === 0) return !unassignedScalar.test(scalar)
  return fonts.some((font) => font.hasCharacter(unicode))
}

function isFormulaStartCharacter(
  value: string,
  configuration: StylesAndFormulasConfiguration,
  targetFonts: TargetFont[]
): boolean {
  if (value.length === 0) return false
  if (value.includes('(cid:')) return true
  if (!targetHasCharacter(value, targetFonts)) {
    const scalars = [...value]
    if (scalars.length > 1 && scalars.every((scalar) => targetHasCharacter(scalar, targetFonts))) {
      return false
    }
    return true
  }
  if (configuration.formulaCharacterPattern && matchesAtStart(configuration.formulaCharacterPattern, value)) {
    return true
  }
  if (value !== ' ') {
    const scalar = [...value][0]
    if (scalar !== undefined && scalarCategories.some((category) => category.test.test(scalar))) return true
    const code = scalar.codePointAt(0) ?? 0
    if (code >= 0x370 && code < 0x400) return true
  }
  const first = [...value][0]
  return first !== undefined && '0123456789[]•'.includes(first)
}

function isFormulaMiddleCharacter(
  value: string,
  configuration: StylesAndFormulasConfiguration,
  targetFonts: TargetFont[]
): boolean {
  return isFormulaStartCharacter(value, configuration, targetFonts) || value.startsWith(',')
}

export const StylesAndFormulas = {
  async process(document: ILDocument, configuration: StylesAndFormulasConfiguration = defaultStylesAndFormulasConfiguration): Promise<void> {
    const targetFonts = await loadTargetFonts(
      classificationFontNames, configuration.targetFontDirectory ?? defaultFontDirectory()
    ).then((map) => classificationFontNames.map((name) => map.get(name)).filter((font): font is TargetFont => font !== undefined))
    for (const page of document.page ?? []) {
      StylesAndFormulas.processPage(page, configuration, targetFonts)
    }
  },

  processPage(
    page: ILPage,
    configuration: StylesAndFormulasConfiguration = defaultStylesAndFormulasConfiguration,
    targetFonts: TargetFont[] = []
  ): void {
    processPageFormulas(page, configuration, targetFonts)
    processCommaFormulas(page)
    mergeOverlappingFormulas(page)
    // Fraction recovery first: a numerator/denominator that becomes a formula
    // through its base letter can already cover the rule and hide it.
    mergeStackedFractionFragments(page)
    attachCornerMarkBaseLetters(page)
    splitWrappedInlineFormulas(page)
    if (!configuration.skipFormulaOffsetCalculation) processPageOffsets(page)
    processTranslatableFormulas(page)
    updateAllFormulaData(page)
    if (!configuration.ocrWorkaround) collectContainedElements(page)
    if (configuration.removeNonFormulaLines) removeNonFormulaLines(page, configuration)
    if (!configuration.skipFormulaOffsetCalculation) processPageOffsets(page)
    updateAllFormulaData(page)
    processPageStyles(page)
  }
}

function defaultFontDirectory(): string {
  return process.env.BABELDOC_FONT_DIRECTORY ?? 'BabelDocKit/runtime/fonts'
}

interface TaggedCharacter {
  character: ILPdfCharacter
  formula: boolean
  cornerMark: boolean
}

function processPageFormulas(page: ILPage, configuration: StylesAndFormulasConfiguration, targetFonts: TargetFont[]): void {
  const paragraphs = page.pdf_paragraph ?? []
  if (paragraphs.length === 0) return
  const [pageFormulaFonts, xobjectFormulaFonts] = formulaFontIDs(page, configuration.formulaFontPattern)
  for (const paragraph of paragraphs) {
    if (paragraph.layout_label === 'isolate_formula') continue
    if ((paragraph.pdf_paragraph_composition ?? []).length === 0) continue
    const formulaFonts = paragraph.xobj_id !== undefined && paragraph.xobj_id !== 0
      ? xobjectFormulaFonts.get(paragraph.xobj_id) ?? pageFormulaFonts
      : pageFormulaFonts

    const compositions: ILPdfParagraphComposition[] = []
    let firstIsBullet = false
    for (const [lineIndex, composition] of (paragraph.pdf_paragraph_composition ?? []).entries()) {
      const [tagged, bullet] = classifyCharacters(composition, formulaFonts, firstIsBullet, configuration, targetFonts)
      firstIsBullet = bullet
      if (tagged.length === 0) {
        compositions.push(composition)
      } else {
        compositions.push(...groupClassifiedCharacters(tagged, lineIndex))
      }
    }
    paragraph.pdf_paragraph_composition = compositions
  }
}

function classifyCharacters(
  composition: ILPdfParagraphComposition,
  formulaFontIDs: Set<string>,
  firstIsBulletSoFar: boolean,
  configuration: StylesAndFormulasConfiguration,
  targetFonts: TargetFont[]
): [TaggedCharacter[], boolean] {
  const line = composition.pdf_line
  const characters = line?.pdf_character ?? []
  if (!line || characters.length === 0) return [[], firstIsBulletSoFar]
  let firstIsBullet = firstIsBulletSoFar
  let formulaState = false
  let cornerMarkState = false
  const tagged: TaggedCharacter[] = []

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    if (!firstIsBullet && index === 0 && isBullet(character)) firstIsBullet = true

    const unicode = character.char_unicode ?? ''
    const startsFormula = isFormulaStartCharacter(unicode, configuration, targetFonts)
    const continuesFormula = isFormulaMiddleCharacter(unicode, configuration, targetFonts)
    let formula: boolean = isTruthyID(character.formula_layout_id)
      || (startsFormula && !formulaState)
      || (continuesFormula && formulaState)
      || (character.pdf_style?.font_id !== undefined && formulaFontIDs.has(character.pdf_style.font_id))
      || pythonBool(character.vertical)
      || (character.char_unicode === undefined && formulaState)
      || boxesAreDisjoint(character.box, character.visual_bbox?.box)

    const previous = index > 0 ? characters[index - 1] : undefined
    const next = index + 1 < characters.length ? characters[index + 1] : undefined
    const isSpace = [...unicode][0] !== undefined && /\p{White_Space}/u.test([...unicode][0])
    const previousIsSpace = previous?.char_unicode !== undefined
      && [...previous.char_unicode][0] !== undefined && /\p{White_Space}/u.test([...previous.char_unicode][0])
    const size = character.pdf_style?.font_size
    const previousSize = previous?.pdf_style?.font_size
    const nextSize = next?.pdf_style?.font_size
    const commonCornerConditions = !isSpace && !previousIsSpace && !firstIsBullet
    let cornerMark: boolean
    if (previous !== undefined && size !== undefined && previousSize !== undefined && commonCornerConditions) {
      cornerMark = (!cornerMarkState && size < previousSize * 0.79)
        || (cornerMarkState && size < previousSize * 1.1)
    } else if (previous === undefined && next !== undefined && size !== undefined && nextSize !== undefined
      && commonCornerConditions && !cornerMarkState) {
      cornerMark = size < nextSize * 0.79
    } else {
      cornerMark = false
    }
    formula = formula || cornerMark
    if (unicode === ' ') formula = formulaState
    if (formula !== formulaState) formulaState = formula
    cornerMarkState = cornerMark
    tagged.push({ character, formula, cornerMark })
  }
  return [tagged, firstIsBullet]
}

function groupClassifiedCharacters(tagged: TaggedCharacter[], lineIndex: number): ILPdfParagraphComposition[] {
  const first = tagged[0]
  if (!first) return []
  const result: ILPdfParagraphComposition[] = []
  let characters: ILPdfCharacter[] = []
  let cornerFlags: boolean[] = []
  let currentFormula = first.formula
  for (const item of tagged) {
    if (item.formula !== currentFormula) {
      result.push(createComposition(characters, currentFormula, lineIndex, cornerFlags.includes(true)))
      characters = []
      cornerFlags = []
      currentFormula = item.formula
    }
    characters.push(item.character)
    cornerFlags.push(item.cornerMark)
  }
  if (characters.length > 0) {
    result.push(createComposition(characters, currentFormula, lineIndex, cornerFlags.includes(true)))
  }
  return result
}

function createComposition(
  characters: ILPdfCharacter[],
  isFormula: boolean,
  lineIndex: number,
  isCornerMark: boolean
): ILPdfParagraphComposition {
  if (isFormula) {
    const formula: ILPdfFormula = {
      pdf_character: characters,
      line_id: lineIndex,
      is_corner_mark: isCornerMark
    }
    updateFormulaData(formula)
    return { pdf_formula: formula }
  }
  const line: ILPdfLine = { pdf_character: characters }
  updateLineData(line)
  return { pdf_line: line }
}

function processCommaFormulas(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    if (paragraph.layout_label === 'isolate_formula') continue
    const result: ILPdfParagraphComposition[] = []
    for (const composition of paragraph.pdf_paragraph_composition ?? []) {
      const formula = composition.pdf_formula
      if (!formula || !shouldSplitFormula(formula)) {
        result.push(composition)
        continue
      }
      for (const [characters, comma] of splitFormulaByComma(formula)) {
        if (characters.length === 0) continue
        const split: ILPdfFormula = { pdf_character: characters, line_id: formula.line_id }
        updateFormulaData(split)
        result.push({ pdf_formula: split })
        if (comma) {
          const line: ILPdfLine = { pdf_character: [comma] }
          updateLineData(line)
          result.push({ pdf_line: line })
        }
      }
    }
    paragraph.pdf_paragraph_composition = result
  }
}

function shouldSplitFormula(formula: ILPdfFormula): boolean {
  const characters = formula.pdf_character ?? []
  if (characters.every((character) => isTruthyID(character.formula_layout_id))) return false
  const text = characters.map((character) => character.char_unicode ?? '').join('')
  if (!text.includes(',')) return false
  return nonDigitBracketPattern.test(text)
}

function splitFormulaByComma(formula: ILPdfFormula): Array<[ILPdfCharacter[], ILPdfCharacter | undefined]> {
  const result: Array<[ILPdfCharacter[], ILPdfCharacter | undefined]> = []
  let current: ILPdfCharacter[] = []
  let bracketLevel = 0
  for (const character of formula.pdf_character ?? []) {
    const unicode = character.char_unicode ?? ''
    if (leftBrackets.has(unicode)) {
      bracketLevel += 1
      current.push(character)
    } else if (rightBrackets.has(unicode)) {
      bracketLevel = Math.max(0, bracketLevel - 1)
      current.push(character)
    } else if (unicode === ',' && bracketLevel === 0) {
      if (current.length > 0) {
        result.push([current, character])
        current = []
      }
    } else {
      current.push(character)
    }
  }
  if (current.length > 0) result.push([current, undefined])
  return result
}

/** Moves a lone italic base letter into the formula when a smaller script
 * (sub/superscript corner mark) touches it. */
function attachCornerMarkBaseLetters(page: ILPage): void {
  const [pageItalicFonts, xobjectItalicFonts] = italicFontIDs(page)
  for (const paragraph of page.pdf_paragraph ?? []) {
    if (paragraph.layout_label === 'isolate_formula') continue
    const italicFonts = paragraph.xobj_id !== undefined && paragraph.xobj_id !== 0
      ? xobjectItalicFonts.get(paragraph.xobj_id) ?? pageItalicFonts
      : pageItalicFonts
    const compositions = [...(paragraph.pdf_paragraph_composition ?? [])]
    let index = 1
    while (index < compositions.length) {
      const formula = compositions[index].pdf_formula
      const line = compositions[index - 1].pdf_line
      if (
        !formula || !pythonBool(formula.is_corner_mark)
        || !line || (line.pdf_character ?? []).length === 0
      ) { index += 1; continue }
      const script = formula.pdf_character?.[0]
      const characters = line.pdf_character ?? []
      const base = characters[characters.length - 1]
      const baseBox = base ? boxCoordinates(base.visual_bbox?.box ?? base.box) : null
      const scriptBox = script ? boxCoordinates(script.visual_bbox?.box ?? script.box) : null
      const baseSize = base?.pdf_style?.font_size
      const scriptSize = script?.pdf_style?.font_size
      const baseUnicode = base?.char_unicode ?? ''
      const penultimate = characters.length >= 2 ? characters[characters.length - 2] : undefined
      const penultimateIsLetter = penultimate?.char_unicode !== undefined
        && [...penultimate.char_unicode][0] !== undefined
        && /\p{L}/u.test([...penultimate.char_unicode][0])
      if (
        !script
        || !base
        || [...baseUnicode].length !== 1
        || !([...baseUnicode][0] !== undefined && /\p{L}/u.test([...baseUnicode][0]))
        || base.pdf_style?.font_id === undefined
        || !italicFonts.has(base.pdf_style.font_id)
        || (characters.length >= 2 && penultimateIsLetter)
        || !baseBox || !scriptBox || baseSize === undefined || scriptSize === undefined
        || !(scriptSize < baseSize * 0.79)
      ) { index += 1; continue }
      const gap = scriptBox.x - baseBox.x2
      if (!(gap >= -baseSize * 0.3 && gap <= baseSize * 0.3)
        || !(scriptBox.y < baseBox.y2) || !(scriptBox.y2 > baseBox.y)) { index += 1; continue }
      const updated: ILPdfFormula = { ...formula, pdf_character: [base, ...(formula.pdf_character ?? [])] }
      updateFormulaData(updated)
      compositions[index] = { pdf_formula: updated }
      const updatedCharacters = characters.slice(0, -1)
      const updatedLine: ILPdfLine = { ...line, pdf_character: updatedCharacters }
      if (updatedCharacters.length === 0) {
        compositions.splice(index - 1, 1)
        index -= 1
      } else {
        updateLineData(updatedLine)
        compositions[index - 1] = { pdf_line: updatedLine }
      }
      index += 1
    }
    paragraph.pdf_paragraph_composition = compositions
  }
}

function italicFontIDs(page: ILPage): [Set<string>, Map<number, Set<string>>] {
  const pageIDs = new Set<string>((page.pdf_font ?? [])
    .filter((font) => pythonBool(font.italic) && font.font_id !== undefined)
    .map((font) => font.font_id as string))
  const xobjectIDs = new Map<number, Set<string>>()
  for (const xobject of page.pdf_xobject ?? []) {
    const ids = new Set(pageIDs)
    for (const font of xobject.pdf_font ?? []) {
      const id = font.font_id
      if (id === undefined) continue
      if (pythonBool(font.italic)) ids.add(id)
      else ids.delete(id)
    }
    if (xobject.xobj_id !== undefined) xobjectIDs.set(xobject.xobj_id, ids)
  }
  return [pageIDs, xobjectIDs]
}

function mergeOverlappingFormulas(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    if (paragraph.layout_label === 'isolate_formula') continue
    let merged = true
    while (merged) {
      merged = false
      const count = (paragraph.pdf_paragraph_composition ?? []).length
      if (count < 2) break
      outer:
      for (let firstIndex = 0; firstIndex < count; firstIndex += 1) {
        const first = paragraph.pdf_paragraph_composition?.[firstIndex].pdf_formula
        if (!first) continue
        for (let secondIndex = firstIndex + 1; secondIndex < count; secondIndex += 1) {
          const second = paragraph.pdf_paragraph_composition?.[secondIndex].pdf_formula
          if (!second) continue
          const sameLine = first.line_id === second.line_id
          const compositionsAreAdjacent = secondIndex === firstIndex + 1
          const adjacentGeometry = compositionsAreAdjacent && (
            (xAxisContained(first.box, second.box) && yIntersects(first.box, second.box))
            || (xAxisAdjacent(first.box, second.box) && yIOU(first.box, second.box) > 0.5)
          )
          const shouldMerge = sameLine && (
            adjacentGeometry
            || haveSameLayoutIDs(first, second)
            || (compositionsAreAdjacent && (
              coverage(first.box, second.box) > 0.8 || coverage(second.box, first.box) > 0.8))
          )
          if (shouldMerge) {
            const formula: ILPdfFormula = {
              pdf_character: [...(first.pdf_character ?? []), ...(second.pdf_character ?? [])],
              line_id: first.line_id
            }
            updateFormulaData(formula)
            paragraph.pdf_paragraph_composition?.splice(firstIndex, 1, { pdf_formula: formula })
            paragraph.pdf_paragraph_composition?.splice(secondIndex, 1)
            merged = true
            break outer
          }
        }
      }
    }
  }
}

/** Splits an inline formula that wraps at the page margin when its characters
 * jump back to the next visual line's left edge. */
function splitWrappedInlineFormulas(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    const paragraphBox = boxCoordinates(paragraph.box)
    if (paragraph.layout_label === 'isolate_formula' || !paragraphBox) continue
    const paragraphWidth = paragraphBox.x2 - paragraphBox.x
    if (paragraphWidth <= 0) continue

    const result: ILPdfParagraphComposition[] = []
    for (const composition of paragraph.pdf_paragraph_composition ?? []) {
      const formula = composition.pdf_formula
      const formulaBox = formula ? boxCoordinates(formula.box) : null
      const fragments = formula ? wrappedFormulaFragments(formula) : null
      if (
        !formula || (formula.pdf_curve ?? []).length > 0 || (formula.pdf_form ?? []).length > 0
        || !formulaBox || formulaBox.x2 - formulaBox.x < paragraphWidth * 0.75
        || !fragments || fragments.length <= 1
      ) {
        result.push(composition)
        continue
      }
      for (const characters of fragments) {
        const fragment: ILPdfFormula = {
          pdf_character: characters,
          line_id: formula.line_id,
          is_corner_mark: formula.is_corner_mark
        }
        updateFormulaData(fragment)
        result.push({ pdf_formula: fragment })
      }
    }
    paragraph.pdf_paragraph_composition = result
  }
}

function wrappedFormulaFragments(formula: ILPdfFormula): ILPdfCharacter[][] | null {
  const boxes = (formula.pdf_character ?? [])
    .map((character) => boxCoordinates(character.visual_bbox?.box ?? character.box))
    .filter((box): box is NonNullable<typeof box> => box !== null && box.x2 > box.x && box.y2 > box.y)
  const heights = boxes.map((box) => box.y2 - box.y).sort((lhs, rhs) => lhs - rhs)
  if (heights.length < 2) return null
  const medianHeight = heights[Math.floor(heights.length / 2)]
  if (medianHeight <= 0) return null

  const fragments: ILPdfCharacter[][] = [[]]
  let previousBox: NonNullable<ReturnType<typeof boxCoordinates>> | null = null
  let splitCount = 0
  for (const character of formula.pdf_character ?? []) {
    const box = boxCoordinates(character.visual_bbox?.box ?? character.box)
    if (previousBox && box) {
      const previousCenterY = (previousBox.y + previousBox.y2) / 2
      const centerY = (box.y + box.y2) / 2
      const resetsToVisualLineStart = box.x < previousBox.x - medianHeight
        && Math.abs(centerY - previousCenterY) >= medianHeight * 0.5
      if (resetsToVisualLineStart && fragments[fragments.length - 1].length > 0) {
        fragments.push([])
        splitCount += 1
      }
    }
    fragments[fragments.length - 1].push(character)
    if (box) previousBox = box
  }
  return splitCount > 0 && fragments.every((fragment) => fragment.length > 0) ? fragments : null
}

/** Recovers a stacked fraction container from a thin horizontal rule with
 * formula fragments on both sides of its Y coordinate. */
const maximumFilledRuleHeight = 1.0

function mergeStackedFractionFragments(page: ILPage): void {
  type Rule = { box: NonNullable<ReturnType<typeof boxCoordinates>>; xobjectID: number | undefined }
  const horizontalRule = (box: ILBox | undefined, xobjectID: number | undefined, maximumHeight: number): Rule | null => {
    const coordinates = boxCoordinates(box)
    if (!coordinates) return null
    const width = coordinates.x2 - coordinates.x
    const height = Math.abs(coordinates.y2 - coordinates.y)
    if (width <= 2 || height > maximumHeight || height * 4 > width) return null
    return { box: coordinates, xobjectID }
  }
  const horizontalRules = [
    ...(page.pdf_curve ?? []).map((curve) => horizontalRule(curve.box, curve.xobj_id, 0.05)),
    ...(page.pdf_form ?? []).map((form) => horizontalRule(form.box, form.xobj_id, maximumFilledRuleHeight))
  ].filter((rule): rule is Rule => rule !== null)
    .sort((lhs, rhs) => (lhs.box.x2 - lhs.box.x) - (rhs.box.x2 - rhs.box.x))

  for (const candidate of horizontalRules) {
    for (const paragraph of page.pdf_paragraph ?? []) {
      if (paragraph.layout_label === 'isolate_formula') continue
      const compositions = paragraph.pdf_paragraph_composition ?? []
      if (compositions.length === 0) continue
      if (paragraph.xobj_id !== undefined && paragraph.xobj_id !== candidate.xobjectID) continue
      const selection = stackedFractionSelection(candidate.box, compositions)
      if (!selection) continue
      const replacement = mergedFractionCompositions(selection, compositions)
      if (!replacement) continue
      paragraph.pdf_paragraph_composition = [
        ...compositions.slice(0, selection.lower),
        ...replacement,
        ...compositions.slice(selection.upper + 1)
      ]
      break
    }
  }
}

interface FractionFragment {
  index: number
  isFormula: boolean
  selectedCharacterIndices: number[]
  aboveIntervals: Array<[number, number]>
  belowIntervals: Array<[number, number]>
}

interface StackedFractionSelection {
  lower: number
  upper: number
  characterIndices: Map<number, number[]>
}

function stackedFractionSelection(
  rule: NonNullable<ReturnType<typeof boxCoordinates>>,
  compositions: ILPdfParagraphComposition[]
): StackedFractionSelection | null {
  const ruleY = (rule.y + rule.y2) / 2
  if (compositions.some((composition) => {
    const formulaBox = composition.pdf_formula?.box
    if (!formulaBox) return false
    const ruleBox: ILBox = { x: rule.x, y: rule.y, x2: rule.x2, y2: rule.y2 }
    if (elementCoverage(ruleBox, formulaBox) >= 0.95) return true
    return elementCoverage(ruleBox, expanded(formulaBox, 2)) >= 0.95
  })) {
    return null
  }

  const overlappingBoxes = compositions
    .flatMap(compositionCharacters)
    .map((character) => boxCoordinates(character.visual_bbox?.box ?? character.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
    .filter((box) => Math.min(box.x2, rule.x2) - Math.max(box.x, rule.x) > 0)
  if (overlappingBoxes.length === 0) return null
  const heights = overlappingBoxes.map((box) => box.y2 - box.y).filter((height) => height > 0).sort((lhs, rhs) => lhs - rhs)
  if (heights.length === 0) return null
  const medianHeight = heights[Math.floor(heights.length / 2)]
  const verticalLimit = Math.min(Math.max(medianHeight * 1.5, 4), 12)
  const sideEpsilon = Math.max(medianHeight * 0.02, 0.05)

  const fragments: FractionFragment[] = []
  for (const [index, composition] of compositions.entries()) {
    const characters = compositionCharacters(composition)
    if (characters.length === 0) continue
    const above: Array<[number, number]> = []
    const below: Array<[number, number]> = []
    let selectedCharacterIndices: number[] = []
    for (const [characterIndex, character] of characters.entries()) {
      const box = boxCoordinates(character.visual_bbox?.box ?? character.box)
      if (!box) continue
      const left = Math.max(box.x, rule.x)
      const right = Math.min(box.x2, rule.x2)
      if (right <= left) continue
      const centerY = (box.y + box.y2) / 2
      if (Math.abs(centerY - ruleY) > verticalLimit) continue
      if (centerY > ruleY + sideEpsilon) {
        above.push([left, right])
        selectedCharacterIndices.push(characterIndex)
      } else if (centerY < ruleY - sideEpsilon) {
        below.push([left, right])
        selectedCharacterIndices.push(characterIndex)
      }
    }
    if (above.length > 0 || below.length > 0) {
      if (composition.pdf_formula) {
        // Preserve operators such as the `=` immediately before a numerator.
        selectedCharacterIndices = characters.map((_, characterIndex) => characterIndex)
      }
      fragments.push({
        index,
        isFormula: composition.pdf_formula !== undefined,
        selectedCharacterIndices: [...new Set(selectedCharacterIndices)].sort((lhs, rhs) => lhs - rhs),
        aboveIntervals: above,
        belowIntervals: below
      })
    }
  }

  const above = fragments.filter((fragment) => fragment.aboveIntervals.length > 0)
  const below = fragments.filter((fragment) => fragment.belowIntervals.length > 0)
  if (!above.some((fragment) => fragment.isFormula) || !below.some((fragment) => fragment.isFormula)) return null
  const aboveIndices = above.map((fragment) => fragment.index)
  const belowIndices = below.map((fragment) => fragment.index)
  const firstAbove = Math.min(...aboveIndices)
  const lastAbove = Math.max(...aboveIndices)
  const firstBelow = Math.min(...belowIndices)
  const lastBelow = Math.max(...belowIndices)
  if (!(lastAbove < firstBelow || lastBelow < firstAbove)) return null

  const ruleWidth = rule.x2 - rule.x
  if (intervalEnvelopeCoverage(above.flatMap((fragment) => fragment.aboveIntervals), ruleWidth) < 0.75
    || intervalEnvelopeCoverage(below.flatMap((fragment) => fragment.belowIntervals), ruleWidth) < 0.75) {
    return null
  }

  const selectedIndices = new Set([...aboveIndices, ...belowIndices])
  const lower = Math.min(...selectedIndices)
  const upper = Math.max(...selectedIndices)
  for (let index = lower; index <= upper; index += 1) {
    if (!selectedIndices.has(index)) return null
  }
  const characterIndices = new Map<number, number[]>()
  for (const fragment of fragments) {
    if (selectedIndices.has(fragment.index)) characterIndices.set(fragment.index, fragment.selectedCharacterIndices)
  }
  return { lower, upper, characterIndices }
}

function intervalEnvelopeCoverage(intervals: Array<[number, number]>, width: number): number {
  if (width <= 0 || intervals.length === 0) return 0
  const minimum = Math.min(...intervals.map((interval) => interval[0]))
  const maximum = Math.max(...intervals.map((interval) => interval[1]))
  return Math.max(0, maximum - minimum) / width
}

function compositionCharacters(composition: ILPdfParagraphComposition): ILPdfCharacter[] {
  if (composition.pdf_formula) return composition.pdf_formula.pdf_character ?? []
  if (composition.pdf_line) return composition.pdf_line.pdf_character ?? []
  if (composition.pdf_same_style_characters) return composition.pdf_same_style_characters.pdf_character ?? []
  if (composition.pdf_character) return [composition.pdf_character]
  return []
}

function mergedFractionCompositions(
  selection: StackedFractionSelection,
  compositions: ILPdfParagraphComposition[]
): ILPdfParagraphComposition[] | null {
  const fractionCharacters: ILPdfCharacter[] = []
  const formulas: ILPdfFormula[] = []
  let prefix: ILPdfParagraphComposition | null = null
  let suffix: ILPdfParagraphComposition | null = null

  for (let compositionIndex = selection.lower; compositionIndex <= selection.upper; compositionIndex += 1) {
    const composition = compositions[compositionIndex]
    const characters = compositionCharacters(composition)
    const selected = selection.characterIndices.get(compositionIndex)
    if (!selected || selected.length === 0) return null
    const first = selected[0]
    const last = selected[selected.length - 1]
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index] !== selected[index - 1] + 1) return null
    }
    if (compositionIndex !== selection.lower && first !== 0) return null
    if (compositionIndex !== selection.upper && last !== characters.length - 1) return null
    if (compositionIndex === selection.lower && first > 0) {
      prefix = compositionReplacingCharacters(composition, characters.slice(0, first))
    }
    fractionCharacters.push(...characters.slice(first, last + 1))
    if (composition.pdf_formula) formulas.push(composition.pdf_formula)
    if (compositionIndex === selection.upper && last + 1 < characters.length) {
      suffix = compositionReplacingCharacters(composition, characters.slice(last + 1))
    }
  }

  if (fractionCharacters.length === 0) return null
  const formula: ILPdfFormula = {
    pdf_character: fractionCharacters,
    pdf_curve: formulas.flatMap((formula) => formula.pdf_curve ?? []),
    pdf_form: formulas.flatMap((formula) => formula.pdf_form ?? []),
    line_id: formulas.map((formula) => formula.line_id).find((id) => id !== undefined),
    is_corner_mark: formulas.some((formula) => pythonBool(formula.is_corner_mark))
  }
  updateFormulaData(formula)
  return [prefix, { pdf_formula: formula }, suffix].filter((composition): composition is ILPdfParagraphComposition => composition !== null)
}

function compositionReplacingCharacters(
  composition: ILPdfParagraphComposition,
  characters: ILPdfCharacter[]
): ILPdfParagraphComposition | null {
  if (characters.length === 0) return null
  if (composition.pdf_formula) {
    const formula: ILPdfFormula = { ...composition.pdf_formula, pdf_character: characters }
    updateFormulaData(formula)
    return { pdf_formula: formula }
  }
  if (composition.pdf_line) {
    const line: ILPdfLine = { ...composition.pdf_line, pdf_character: characters }
    updateLineData(line)
    return { pdf_line: line }
  }
  if (composition.pdf_same_style_characters) {
    return {
      pdf_same_style_characters: {
        ...composition.pdf_same_style_characters,
        pdf_character: characters,
        box: characterUnionBox(characters)
      }
    }
  }
  if (characters.length === 1) return { pdf_character: characters[0] }
  return null
}

function characterUnionBox(characters: ILPdfCharacter[]): ILBox | undefined {
  const boxes = characters
    .map((character) => boxCoordinates(character.visual_bbox?.box ?? character.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  if (boxes.length === 0) return undefined
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
}

function processTranslatableFormulas(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    if (paragraph.layout_label === 'isolate_formula') continue
    const result: ILPdfParagraphComposition[] = []
    for (const composition of paragraph.pdf_paragraph_composition ?? []) {
      const formula = composition.pdf_formula
      if (formula && !pythonBool(formula.is_corner_mark) && isTranslatableFormula(formula)) {
        const line: ILPdfLine = { pdf_character: formula.pdf_character ?? [] }
        updateLineData(line)
        result.push({ pdf_line: line })
      } else {
        result.push(composition)
      }
    }
    paragraph.pdf_paragraph_composition = result
  }
}

function isTranslatableFormula(formula: ILPdfFormula): boolean {
  const characters = formula.pdf_character ?? []
  if (characters.every((character) => isTruthyID(character.formula_layout_id))) return false
  if ((formula.y_offset ?? 0) > 0.1) return false
  const text = characters.map((character) => character.char_unicode ?? '').join('')
  return translatableFormulaPattern.test(text)
}

function updateAllFormulaData(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    for (const composition of paragraph.pdf_paragraph_composition ?? []) {
      if (composition.pdf_formula) updateFormulaData(composition.pdf_formula)
    }
  }
}

function updateFormulaData(formula: ILPdfFormula): void {
  const characterBoxes = (formula.pdf_character ?? [])
    .map((character) => {
      const box = boxCoordinates(character.visual_bbox?.box)
      return box ? { character, box } : null
    })
    .filter((entry): entry is { character: ILPdfCharacter; box: NonNullable<ReturnType<typeof boxCoordinates>> } => entry !== null)
  if (characterBoxes.length === 0) return
  const useful = characterBoxes.filter((entry) => entry.character.pdf_character_id !== undefined && entry.character.char_unicode !== undefined)
  const yBoxes = useful.length === 0 ? characterBoxes : useful
  formula.box = {
    x: Math.min(...characterBoxes.map((entry) => entry.box.x)),
    y: Math.min(...yBoxes.map((entry) => entry.box.y)),
    x2: Math.max(...characterBoxes.map((entry) => entry.box.x2)),
    y2: Math.max(...yBoxes.map((entry) => entry.box.y2))
  }
  if (formula.y_offset === undefined || formula.y_offset === 0) formula.y_offset = 0
  if (formula.x_offset === undefined || formula.x_offset === 0) formula.x_offset = 0
  if (formula.x_advance === undefined || formula.x_advance === 0) formula.x_advance = 0
}

function updateLineData(line: ILPdfLine): void {
  const boxes = (line.pdf_character ?? [])
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  if (boxes.length === 0) return
  line.box = {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
}

function processPageOffsets(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    if (paragraph.debug_id === undefined) continue
    const compositions = paragraph.pdf_paragraph_composition ?? []
    if (compositions.length === 0) continue
    for (let index = 0; index < compositions.length; index += 1) {
      const formula = compositions[index].pdf_formula
      if (!formula || boxCoordinates(formula.box) === null) continue
      let leftCharacter: ILPdfCharacter | null = null
      let rightCharacter: ILPdfCharacter | null = null
      let leftIOU = 0
      let rightIOU = 0

      // The baseline reference is the nearest body text on either side;
      // adjacent formulas share that baseline, so step over them.
      let leftIndex = index - 1
      while (leftIndex >= 0 && compositions[leftIndex].pdf_formula !== undefined) leftIndex -= 1
      let rightIndex = index + 1
      while (rightIndex < compositions.length && compositions[rightIndex].pdf_formula !== undefined) rightIndex += 1
      if (leftIndex >= 0) {
        const line = compositions[leftIndex].pdf_line
        if (line) {
          const lineCharacters = line.pdf_character ?? []
          for (let position = lineCharacters.length - 1; position >= 0; position -= 1) {
            const character = lineCharacters[position]
            if ((character.pdf_character_id ?? 0) === 0) continue
            leftIOU = trueYIOU(formula.box, character.box)
            if (leftIOU > 0.6) { leftCharacter = character; break }
          }
        }
      }
      if (rightIndex < compositions.length) {
        const line = compositions[rightIndex].pdf_line
        if (line) {
          for (const character of line.pdf_character ?? []) {
            if ((character.pdf_character_id ?? 0) === 0) continue
            rightIOU = trueYIOU(formula.box, character.box)
            if (rightIOU > 0.6) { rightCharacter = character; break }
          }
        }
      }
      if (leftCharacter && rightCharacter) {
        if (leftIOU < rightIOU) leftCharacter = null
        else if (rightIOU < leftIOU) rightCharacter = null
      }
      const formulaBox = boxCoordinates(formula.box)
      if (!formulaBox) continue
      let xOffset = 0
      if (leftIndex === index - 1) {
        const leftBox = leftCharacter ? boxCoordinates(leftCharacter.box) : null
        if (leftBox) xOffset = formulaBox.x - leftBox.x2
      }
      if (Math.abs(xOffset) < 0.1 || xOffset > 10 || xOffset < -5) xOffset = 0
      formula.x_offset = xOffset
      let yOffset = 0
      const leftBox = leftCharacter ? boxCoordinates(leftCharacter.box) : null
      const rightBox = rightCharacter ? boxCoordinates(rightCharacter.box) : null
      if (leftBox) yOffset = formulaBox.y - leftBox.y
      else if (rightBox) yOffset = formulaBox.y - rightBox.y
      if (Math.abs(yOffset) < 0.1) yOffset = 0
      formula.y_offset = yOffset
    }
  }
}

interface FormulaLocation {
  paragraph: number
  composition: number
  xobjectID: number | undefined
  formula: ILPdfFormula
}

function collectContainedElements(page: ILPage): void {
  const formulas: FormulaLocation[] = []
  const paragraphs = page.pdf_paragraph ?? []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const compositions = paragraph.pdf_paragraph_composition ?? []
    compositions.forEach((composition, compositionIndex) => {
      const formula = composition.pdf_formula
      if (formula) {
        formulas.push({
          paragraph: paragraphIndex,
          composition: compositionIndex,
          xobjectID: paragraph.xobj_id,
          formula
        })
      }
    })
  })
  if (formulas.length === 0) return

  const curveAssignments = new Map<number, number[]>()
  const formAssignments = new Map<number, number[]>()
  const usedCurves = new Set<number>()
  const usedForms = new Set<number>()
  const curves = page.pdf_curve ?? []
  curves.forEach((curve, curveIndex) => {
    const formulaIndex = curve.box ? bestFormula(curve.box, curve.xobj_id, formulas) : null
    if (formulaIndex === null) return
    curveAssignments.set(formulaIndex, [...(curveAssignments.get(formulaIndex) ?? []), curveIndex])
    usedCurves.add(curveIndex)
  })
  const forms = page.pdf_form ?? []
  forms.forEach((form, formIndex) => {
    const formulaIndex = form.box ? bestFormula(form.box, form.xobj_id, formulas) : null
    if (formulaIndex === null) return
    formAssignments.set(formulaIndex, [...(formAssignments.get(formulaIndex) ?? []), formIndex])
    usedForms.add(formIndex)
  })
  formulas.forEach((location, formulaIndex) => {
    const formula = page.pdf_paragraph?.[location.paragraph]?.pdf_paragraph_composition?.[location.composition]?.pdf_formula
    if (!formula) return
    formula.pdf_curve = [
      ...(formula.pdf_curve ?? []),
      ...(curveAssignments.get(formulaIndex) ?? []).map((curveIndex) => (page.pdf_curve ?? [])[curveIndex])
    ]
    formula.pdf_form = [
      ...(formula.pdf_form ?? []),
      ...(formAssignments.get(formulaIndex) ?? []).map((formIndex) => (page.pdf_form ?? [])[formIndex])
    ]
  })
  page.pdf_curve = (page.pdf_curve ?? []).filter((_, index) => !usedCurves.has(index))
  page.pdf_form = (page.pdf_form ?? []).filter((_, index) => !usedForms.has(index))
}

function bestFormula(
  elementBox: ILBox,
  xobjectID: number | undefined,
  formulas: FormulaLocation[]
): number | null {
  const exact: Array<{ index: number; score: number }> = []
  const tolerant: Array<{ index: number; score: number }> = []
  formulas.forEach((location, index) => {
    const formulaBox = location.formula.box
    if (!formulaBox) return
    if (location.xobjectID !== undefined && location.xobjectID !== xobjectID) return
    const exactCoverage = elementCoverage(elementBox, formulaBox)
    if (exactCoverage >= 0.95) {
      exact.push({ index, score: exactCoverage })
    } else {
      const expandedBox = expanded(formulaBox, 2)
      if (elementCoverage(elementBox, expandedBox) >= 0.95) {
        const distance = boxDistance(elementBox, formulaBox)
        tolerant.push({ index, score: 0.5 + 0.4 * Math.max(0, 1 - distance / 100) })
      }
    }
  })
  const candidates = exact.length === 0 ? tolerant : exact
  let bestIndex = -1
  let bestScore = Number.NaN
  let bestOffset = -1
  candidates.forEach((candidate, offset) => {
    if (bestIndex === -1 || candidate.score > bestScore
      || (candidate.score === bestScore && offset < bestOffset)) {
      bestIndex = candidate.index
      bestScore = candidate.score
      bestOffset = offset
    }
  })
  return bestIndex >= 0 ? bestIndex : null
}

function processPageStyles(page: ILPage): void {
  for (const paragraph of page.pdf_paragraph ?? []) {
    const compositions = paragraph.pdf_paragraph_composition ?? []
    if (compositions.length === 0) continue
    paragraph.pdf_style = baseStyle(paragraph)
    const result: ILPdfParagraphComposition[] = []
    let currentCharacters: ILPdfCharacter[] = []
    let currentStyle: ILPdfStyle | undefined
    for (const composition of compositions) {
      if (composition.pdf_formula) {
        if (currentCharacters.length > 0) {
          result.push(sameStyleComposition(currentCharacters, currentStyle))
          currentCharacters = []
        }
        result.push(composition)
        continue
      }
      const line = composition.pdf_line
      if (!line) {
        result.push(composition)
        continue
      }
      for (const character of line.pdf_character ?? []) {
        const style = character.pdf_style
        if (currentStyle === undefined) {
          currentStyle = style
          currentCharacters.push(character)
        } else if (sameStyle(style, currentStyle)) {
          currentCharacters.push(character)
        } else {
          if (currentCharacters.length > 0) {
            result.push(sameStyleComposition(currentCharacters, currentStyle))
          }
          currentCharacters = [character]
          currentStyle = style
        }
      }
    }
    if (currentCharacters.length > 0) {
      result.push(sameStyleComposition(currentCharacters, currentStyle))
    }
    paragraph.pdf_paragraph_composition = result
  }
}

function baseStyle(paragraph: ILPdfParagraph): ILPdfStyle | undefined {
  const styles = (paragraph.pdf_paragraph_composition ?? [])
    .flatMap((composition) => composition.pdf_line?.pdf_character?.map((character) => character.pdf_style) ?? [])
    .filter((style): style is ILPdfStyle => style !== undefined)
  const first = styles[0]
  if (!first) return undefined
  let base = first
  for (const style of styles.slice(1)) base = mergeStyles(base, style)
  const result: ILPdfStyle = { ...base }
  if (result.font_id === undefined) result.font_id = stableMode(styles.map((style) => style.font_id))
  if (result.font_size === undefined) result.font_size = stableMode(styles.map((style) => style.font_size))
  return result
}

function mergeStyles(first: ILPdfStyle, second: ILPdfStyle): ILPdfStyle {
  if (first.font_size === undefined) return second
  if (second.font_size === undefined) return first
  const size = Math.abs((first.font_size ?? 0) - (second.font_size ?? 0)) < 0.02 ? first.font_size : undefined
  return {
    graphic_state: mergeGraphicStates(first.graphic_state, second.graphic_state),
    font_id: first.font_id === second.font_id ? first.font_id : undefined,
    font_size: size
  }
}

function mergeGraphicStates(first: ILGraphicState | undefined, second: ILGraphicState | undefined): ILGraphicState | undefined {
  if (!first) return second
  if (!second) return first
  return {
    passthrough_per_char_instruction: first.passthrough_per_char_instruction === second.passthrough_per_char_instruction
      ? first.passthrough_per_char_instruction
      : undefined
  }
}

function sameStyleComposition(characters: ILPdfCharacter[], style: ILPdfStyle | undefined): ILPdfParagraphComposition {
  const boxes = characters
    .map((character) => boxCoordinates(character.visual_bbox?.box))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  const box: ILBox | undefined = boxes.length === 0 ? undefined : {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
  return { pdf_same_style_characters: { box, pdf_style: style, pdf_character: characters } }
}

function sameStyle(first: ILPdfStyle | undefined, second: ILPdfStyle | undefined): boolean {
  if (!first || !second) return first === undefined && second === undefined
  const firstSize = first.font_size
  const secondSize = second.font_size
  if (firstSize === undefined || secondSize === undefined) return false
  return first.font_id === second.font_id
    && Math.abs(firstSize - secondSize) < 0.02
    && sameGraphicState(first.graphic_state, second.graphic_state)
}

function sameGraphicState(first: ILGraphicState | undefined, second: ILGraphicState | undefined): boolean {
  if (!first || !second) return first === undefined && second === undefined
  return first.passthrough_per_char_instruction === second.passthrough_per_char_instruction
}

function stableMode<T>(values: Array<T | undefined>): T | undefined {
  const present = values.filter((value): value is T => value !== undefined)
  if (present.length === 0) return undefined
  const counts = new Map<T, number>()
  const firstOffsets = new Map<T, number>()
  present.forEach((value, offset) => {
    counts.set(value, (counts.get(value) ?? 0) + 1)
    if (!firstOffsets.has(value)) firstOffsets.set(value, offset)
  })
  return present.reduce((best, value) => {
    const bestCount = counts.get(best) ?? 0
    const valueCount = counts.get(value) ?? 0
    if (valueCount > bestCount) return value
    if (valueCount === bestCount && (firstOffsets.get(value) ?? 0) < (firstOffsets.get(best) ?? 0)) return value
    return best
  })
}

function removeNonFormulaLines(page: ILPage, configuration: StylesAndFormulasConfiguration): void {
  const layouts = page.page_layout ?? []
  const paragraphs = page.pdf_paragraph ?? []
  page.pdf_curve = (page.pdf_curve ?? []).filter((curve) => {
    const curveBox = curve.box
    if (!curveBox) return false
    const protectedCurve = layouts.some((layout) =>
      figureTableLayouts.has(layout.class_name ?? '')
      && coverage(curveBox, layout.box) > configuration.figureTableProtectionThreshold)
    if (protectedCurve) return false
    return !paragraphs.some((paragraph) =>
      coverage(curveBox, paragraphBoundingBox(paragraph)) > configuration.nonFormulaLineCoverageThreshold)
  })
}

function paragraphBoundingBox(paragraph: ILPdfParagraph): ILBox | undefined {
  const boxes = (paragraph.pdf_paragraph_composition ?? [])
    .map((composition) => composition.pdf_line?.box
      ?? composition.pdf_formula?.box
      ?? composition.pdf_same_style_characters?.box
      ?? composition.pdf_character?.visual_bbox?.box)
    .map((box) => (box ? boxCoordinates(box) : null))
    .filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  if (boxes.length === 0) return undefined
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2))
  }
}

function formulaFontIDs(page: ILPage, pattern?: string | null): [Set<string>, Map<number, Set<string>>] {
  const pageIDs = new Set<string>((page.pdf_font ?? [])
    .filter((font) => isFormulaFont(font.name, pattern) && font.font_id !== undefined)
    .map((font) => font.font_id as string))
  const xobjectIDs = new Map<number, Set<string>>()
  for (const xobject of page.pdf_xobject ?? []) {
    const ids = new Set(pageIDs)
    for (const font of xobject.pdf_font ?? []) {
      const id = font.font_id
      if (id === undefined) continue
      if (isFormulaFont(font.name, pattern)) ids.add(id)
      else ids.delete(id)
    }
    if (xobject.xobj_id !== undefined) xobjectIDs.set(xobject.xobj_id, ids)
  }
  return [pageIDs, xobjectIDs]
}

function haveSameLayoutIDs(first: ILPdfFormula, second: ILPdfFormula): boolean {
  const ids = (formula: ILPdfFormula) => new Set((formula.pdf_character ?? [])
    .map((character) => (character.char_unicode === ' ' ? undefined : character.formula_layout_id === 0 ? undefined : character.formula_layout_id))
    .filter((id): id is number => id !== undefined))
  const firstIDs = ids(first)
  const secondIDs = ids(second)
  return firstIDs.size === 1 && secondIDs.size === 1 && setsEqual(firstIDs, secondIDs)
}

function setsEqual<T>(first: Set<T>, second: Set<T>): boolean {
  if (first.size !== second.size) return false
  for (const value of first) if (!second.has(value)) return false
  return true
}

function xAxisContained(first: ILBox | undefined, second: ILBox | undefined): boolean {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return false
  return (a.x >= b.x && a.x2 <= b.x2) || (b.x >= a.x && b.x2 <= a.x2)
}

function yIntersects(first: ILBox | undefined, second: ILBox | undefined): boolean {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return false
  return !(a.y2 < b.y - 1 || b.y2 < a.y - 1)
}

function xAxisAdjacent(first: ILBox | undefined, second: ILBox | undefined): boolean {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return false
  return !(a.x2 < b.x || b.x2 < a.x)
    || Math.abs(a.x2 - b.x) <= 2
    || Math.abs(b.x2 - a.x) <= 2
}

function yIOU(first: ILBox | undefined, second: ILBox | undefined): number {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return 0
  const intersection = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y, b.y))
  const union = a.y2 - a.y + b.y2 - b.y - intersection
  return union > 0 ? intersection / union : 0
}

function trueYIOU(first: ILBox | undefined, second: ILBox | undefined): number {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return 0
  const intersection = Math.min(a.y2, b.y2) - Math.max(a.y, b.y)
  const minimumHeight = Math.min(a.y2 - a.y, b.y2 - b.y)
  return intersection > 0 && minimumHeight > 0 ? intersection / minimumHeight : 0
}

function coverage(first: ILBox | undefined, by: ILBox | undefined): number {
  return LayoutHelper.coverage(first, by)
}

function elementCoverage(element: ILBox, container: ILBox): number {
  const a = boxCoordinates(element)
  const b = boxCoordinates(container)
  if (!a || !b) return 0
  const width = a.x2 - a.x
  const height = a.y2 - a.y
  const epsilon = 0.000001
  if (Math.abs(height) <= epsilon && width > epsilon) {
    if (a.y < b.y || a.y > b.y2) return 0
    const overlap = Math.min(a.x2, b.x2) - Math.max(a.x, b.x)
    return Math.max(0, overlap) / width
  }
  if (Math.abs(width) <= epsilon && height > epsilon) {
    if (a.x < b.x || a.x > b.x2) return 0
    const overlap = Math.min(a.y2, b.y2) - Math.max(a.y, b.y)
    return Math.max(0, overlap) / height
  }
  return coverage(
    { x: a.x, y: a.y, x2: a.x2, y2: a.y2 },
    { x: b.x, y: b.y, x2: b.x2, y2: b.y2 }
  )
}

function expanded(box: ILBox, by: number): ILBox {
  const coordinates = boxCoordinates(box)
  if (!coordinates) return box
  return { x: coordinates.x - by, y: coordinates.y - by, x2: coordinates.x2 + by, y2: coordinates.y2 + by }
}

function boxDistance(first: ILBox, second: ILBox): number {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return Number.POSITIVE_INFINITY
  const dx = a.x2 < b.x ? b.x - a.x2 : (a.x > b.x2 ? a.x - b.x2 : 0)
  const dy = a.y2 < b.y ? b.y - a.y2 : (a.y > b.y2 ? a.y - b.y2 : 0)
  return Math.sqrt(dx * dx + dy * dy)
}

function boxesAreDisjoint(first: ILBox | undefined, second: ILBox | undefined): boolean {
  const a = boxCoordinates(first)
  const b = boxCoordinates(second)
  if (!a || !b) return false
  return a.x > b.x2 || a.x2 < b.x || a.y > b.y2 || a.y2 < b.y
}

function isBullet(character: ILPdfCharacter): boolean {
  const first = character.char_unicode !== undefined ? [...character.char_unicode][0] : undefined
  return first !== undefined && bulletCharacters.has(first)
}

const bulletCharacters = new Set([...'■•⚫⬤◆◇○●◦‣⁃▪▫∗†‡¹²³⁴⁵⁶⁷⁸⁹⁰₁₂₃₄₅₆₇₈₉₀ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ¶※⁑⁂⁕⁎⁜❧☙⁋‖‽\u{F06E}\u{F06C}·'])

function isTruthyID(value: number | undefined): boolean {
  return value !== undefined && value !== 0
}

export type { ILPdfCurve, ILPdfForm }
