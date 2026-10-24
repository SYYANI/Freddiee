// Paragraph-continuation recognition, ported from Swift LayoutContinuation.
// Body paragraphs that layout split mid-sentence translate as one paragraph and
// are split back across the source boxes in proportion to source length.
import type { ILBox, ILDocument, ILPdfParagraph } from './il'
import { boxCoordinates } from './il'
import {
  hasExactlyOneOfEachPlaceholder, defaultFormulaPlaceholderProvider,
  type FormulaPlaceholder, type ILFormulaPlaceholderProviding, type TranslateInput
} from './translatorTypes'
import { isLetterCodePoint, isLowercaseCodePoint, isNumberCodePoint, wordInteriorOffsets, foundationTrim } from './unicode'

const enumeratorStart = /^[a-z]{1,4}[.)]/
const bodyLabels = new Set(['plain text', 'text'])
const closingPunctuation = new Set([...'，。、；：？！）」』》〉】〕”’,.;:!?)]}%…—–-·'])
const openingPunctuation = new Set([...'（「『《〈【〔“‘([{'])

export interface SemanticParagraphAddress {
  pageIndex: number
  paragraphIndex: number
}

export interface MergedInput {
  input: TranslateInput
  fragments: TranslateInput[]
  /** Per fragment: merged-input token → the fragment's own token. */
  originalTokens: Map<string, string>[]
}

export const LayoutContinuation = {
  maximumFragmentCount: 4,

  /** The next paragraph in reading flow, skipping page furniture. Crosses into
   * the next page only when it is the following physical page. */
  flowSuccessor(address: SemanticParagraphAddress, document: ILDocument): SemanticParagraphAddress | null {
    const page = document.page?.[address.pageIndex]
    if (!page) return null
    const paragraphs = page.pdf_paragraph ?? []
    for (let next = address.paragraphIndex + 1; next < paragraphs.length; next += 1) {
      if (paragraphs[next].layout_label !== 'abandon') return { pageIndex: address.pageIndex, paragraphIndex: next }
    }
    const nextPageIndex = address.pageIndex + 1
    const nextPage = document.page?.[nextPageIndex]
    if (!nextPage) return null
    if (page.page_number !== undefined && nextPage.page_number !== undefined
      && nextPage.page_number !== page.page_number + 1) {
      return null
    }
    const nextParagraphs = nextPage.pdf_paragraph ?? []
    for (let index = 0; index < nextParagraphs.length; index += 1) {
      if (nextParagraphs[index].layout_label !== 'abandon') return { pageIndex: nextPageIndex, paragraphIndex: index }
    }
    return null
  },

  continues(previous: ILPdfParagraph, previousText: string, next: ILPdfParagraph, nextText: string, samePage: boolean): boolean {
    if (!bodyLabels.has(previous.layout_label ?? '') || !bodyLabels.has(next.layout_label ?? '')) return false
    const previousSize = previous.pdf_style?.font_size
    const nextSize = next.pdf_style?.font_size
    if (previousSize === undefined || nextSize === undefined) return false
    if (Math.abs(previousSize - nextSize) > Math.max(0.5, 0.08 * Math.max(previousSize, nextSize))) return false
    if (!LayoutContinuation.endsMidSentence(previousText) || !LayoutContinuation.startsMidSentence(nextText)) {
      return false
    }
    return !samePage || followsOnSamePage(previous.box, next.box, previousSize)
  },

  endsMidSentence(text: string): boolean {
    const trimmed = [...foundationTrim(text)]
    const last = trimmed[trimmed.length - 1]
    if (last === undefined) return false
    return isLetterCodePoint(last) || isNumberCodePoint(last) || [',', '-', '\u{2010}', '\u{00AD}'].includes(last)
  },

  startsMidSentence(text: string): boolean {
    const trimmed = foundationTrim(text)
    const first = [...trimmed][0]
    if (first === undefined || !isLetterCodePoint(first) || !isLowercaseCodePoint(first)) return false
    // `a)`, `ii.` and similar enumerators open a new item instead of continuing one.
    return !enumeratorStart.test(trimmed)
  },

  /** Joins the fragments into one input. Placeholders are renumbered so tokens
   * that every fragment numbers from 1 stay unique; unknown token families are
   * not merged. */
  merge(
    fragments: TranslateInput[],
    translator: ILFormulaPlaceholderProviding = defaultFormulaPlaceholderProvider
  ): MergedInput | null {
    if (fragments.length <= 1) return null
    let nextID = 1
    const texts: string[] = []
    const placeholders: FormulaPlaceholder[] = []
    const originalTokens: Map<string, string>[] = []
    for (const fragment of fragments) {
      const renamed = new Map<string, string>()
      const originals = new Map<string, string>()
      for (const placeholder of fragment.placeholders) {
        let token: string
        if (placeholder.token === translator.formulaPlaceholder(placeholder.id)) {
          token = translator.formulaPlaceholder(nextID)
        } else if (placeholder.token === `[PROTECTED_${placeholder.id}]`) {
          token = `[PROTECTED_${nextID}]`
        } else {
          return null
        }
        renamed.set(placeholder.token, token)
        originals.set(token, placeholder.token)
        placeholders.push({ id: nextID, token, composition: placeholder.composition })
        nextID += 1
      }
      texts.push(replacingTokens(fragment.text, renamed))
      originalTokens.push(originals)
    }
    const input: TranslateInput = {
      text: texts.join(' '),
      placeholders,
      baseStyle: fragments[0].baseStyle
    }
    if (!hasExactlyOneOfEachPlaceholder(input.text, input)) return null
    return { input, fragments, originalTokens }
  },

  /** Splits the merged translation into one piece per fragment. Each piece
   * keeps exactly its own placeholders; a cut follows the fragments' share of
   * the source and moves to the nearest point that neither breaks a word nor
   * strands punctuation. Returns null when the translation reordered
   * placeholders across fragments or a piece would be empty. */
  split(output: string, merged: MergedInput): string[] | null {
    const characters = [...output]
    const tokenRanges: { lower: number; upper: number }[][] = []
    for (const originals of merged.originalTokens) {
      const ranges: { lower: number; upper: number }[] = []
      for (const token of originals.keys()) {
        const offset = output.indexOf(token)
        if (offset === -1) return null
        const length = [...token].length
        ranges.push({ lower: offset, upper: offset + length })
      }
      tokenRanges.push(ranges)
    }

    // A placeholder stands for a short object, so it counts as one unit of length.
    const sortedTokens = tokenRanges.flat().sort((lhs, rhs) => lhs.lower - rhs.lower)
    const unitStarts: number[] = []
    let offset = 0
    let tokenIndex = 0
    while (offset < characters.length) {
      unitStarts.push(offset)
      if (tokenIndex < sortedTokens.length && sortedTokens[tokenIndex].lower === offset) {
        offset = sortedTokens[tokenIndex].upper
        tokenIndex += 1
      } else {
        offset += 1
      }
    }
    unitStarts.push(characters.length)
    const totalUnits = unitStarts.length - 1

    const weights = merged.fragments.map((fragment) =>
      Math.max(1, [...fragment.text].length - fragment.placeholders.reduce(
        (sum, placeholder) => sum + [...placeholder.token].length - 1, 0)))
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const wordInteriors = wordInteriorOffsets(output)
    const boundaries = [0]
    let cumulativeWeight = 0
    for (let index = 1; index < merged.fragments.length; index += 1) {
      cumulativeWeight += weights[index - 1]
      const lower = Math.max(
        boundaries[boundaries.length - 1],
        tokenRanges.slice(0, index).flat().reduce((maximum, range) => Math.max(maximum, range.upper), 0)
      )
      const upper = tokenRanges.slice(index).flat().reduce((minimum, range) => Math.min(minimum, range.lower), characters.length)
      if (lower > upper) return null
      const targetUnit = Math.round((totalUnits * cumulativeWeight) / totalWeight)
      const target = Math.min(Math.max(unitStarts[Math.min(targetUnit, totalUnits)], lower), upper)
      const cut = nearestBreak(characters, target, lower, upper, wordInteriors)
      if (cut === null) return null
      boundaries.push(cut)
    }
    boundaries.push(characters.length)

    const pieces: string[] = []
    for (let index = 0; index < merged.fragments.length; index += 1) {
      const piece = replacingTokens(
        foundationTrim(characters.slice(boundaries[index], boundaries[index + 1]).join('')),
        merged.originalTokens[index]
      )
      const hasContent = [...piece].some((codePoint) => isLetterCodePoint(codePoint) || isNumberCodePoint(codePoint))
      if (!hasContent || !hasExactlyOneOfEachPlaceholder(piece, merged.fragments[index])) return null
      pieces.push(piece)
    }
    return pieces
  }
}

/** The next fragment either follows directly below in the same column or opens
 * the next column to the right. */
function followsOnSamePage(previousBox: ILBox | undefined, nextBox: ILBox | undefined, fontSize: number): boolean {
  const previous = boxCoordinates(previousBox)
  const next = boxCoordinates(nextBox)
  if (!previous || !next) return false
  const overlap = Math.min(previous.x2, next.x2) - Math.max(previous.x, next.x)
  const narrower = Math.min(previous.x2 - previous.x, next.x2 - next.x)
  if (narrower > 0 && overlap >= narrower * 0.5) {
    const gap = previous.y - next.y2
    return gap >= -fontSize * 0.5 && gap <= fontSize * 3
  }
  return next.x >= previous.x2 - fontSize && next.y2 > previous.y2
}

function nearestBreak(
  characters: string[],
  target: number,
  lowerBound: number,
  upperBound: number,
  wordInteriors: Set<number>
): number | null {
  const reach = Math.max(target - lowerBound, upperBound - target)
  for (let distance = 0; distance <= reach; distance += 1) {
    for (const candidate of [target - distance, target + distance]) {
      if (
        candidate >= lowerBound && candidate <= upperBound && candidate > 0 && candidate < characters.length
        && !wordInteriors.has(candidate)
        && !closingPunctuation.has(characters[candidate])
        && !openingPunctuation.has(characters[candidate - 1])
      ) {
        return candidate
      }
    }
  }
  return null
}

/** Rewrites every listed token in one pass, so a renumbering never re-matches
 * its own output. */
function replacingTokens(text: string, replacements: Map<string, string>): string {
  if (replacements.size === 0) return text
  let result = ''
  let cursor = 0
  for (;;) {
    let match: { at: number; length: number; token: string } | null = null
    for (const token of replacements.keys()) {
      const at = text.indexOf(token, cursor)
      if (at === -1) continue
      if (!match || at < match.at) match = { at, length: token.length, token }
    }
    if (!match) break
    result += text.slice(cursor, match.at)
    result += replacements.get(match.token) ?? ''
    cursor = match.at + match.length
  }
  result += text.slice(cursor)
  return result
}
