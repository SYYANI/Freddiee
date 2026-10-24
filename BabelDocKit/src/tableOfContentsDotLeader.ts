// Recognition of text-based table-of-contents leaders, ported from Swift
// TableOfContentsDotLeader. TeX PDFs position individual period glyphs with
// gaps; Stage 5 inserts dummy spaces into those gaps, so the source-level
// `.{20,}` rule treats whitespace between periods as part of the same run.
import { foundationTrim, isNumberCodePoint, isTrimmableScalar } from './unicode'

/** Foundation's whitespacesAndNewlines set (includes U+200B). */
const trimmedScalars = { test: (value: string) => isTrimmableScalar(value) }
/** Swift Character.isWhitespace: the Unicode White_Space property only. */
const isWhitespaceOnly = /\p{White_Space}/u
const romanScalars = new Set('ivxlcdmIVXLCDM')
const pageMarkerSuffix = /(?:[0-9]+|(?=[mdclxvi])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i

function isPageMarkerScalar(scalar: string): boolean {
  return ('0' <= scalar && scalar <= '9') || romanScalars.has(scalar)
}

/** Combining marks, joiners, variation selectors and emoji modifiers join the
 * preceding character instead of forming one of their own. */
function extendsPreviousCharacter(scalar: string): boolean {
  if (scalar.length === 1 && scalar.charCodeAt(0) < 128) return false
  return [...`a${scalar}`].length === 1
}

function isSuffixScalar(scalar: string): boolean {
  return scalar === '.' || trimmedScalars.test(scalar) || isPageMarkerScalar(scalar) || extendsPreviousCharacter(scalar)
}

function containsLeader(text: string, minimumDotCount: number): boolean {
  let run = 0
  for (const character of text) {
    if (character === '.') {
      run += 1
      if (run >= minimumDotCount) return true
    } else if (!isWhitespaceOnly.test(character)) {
      run = 0
    }
  }
  return false
}

/** The last visible scalar is an ASCII digit or Roman numeral letter. */
function lastBaseScalarIsPageMarker(fragments: string[]): boolean {
  for (let fragment = fragments.length - 1; fragment >= 0; fragment -= 1) {
    const scalars = [...fragments[fragment]]
    for (let index = scalars.length - 1; index >= 0; index -= 1) {
      const scalar = scalars[index]
      if (!trimmedScalars.test(scalar) && !extendsPreviousCharacter(scalar)) {
        return isPageMarkerScalar(scalar)
      }
    }
  }
  return false
}

export const TableOfContentsDotLeader = {
  pageMarkerLayoutLabel: 'table_of_contents_page_marker',
  minimumDotCount: 20,
  minimumProtectedSuffixDotCount: 10,

  containsLeader(text: string): boolean {
    return containsLeader(text, TableOfContentsDotLeader.minimumDotCount)
  },

  containsProtectedSuffix(text: string): boolean {
    if (!lastBaseScalarIsPageMarker([text])) return false
    return TableOfContentsDotLeader.suffixStart([...text]) !== null
  },

  isProtectedSuffix(text: string): boolean {
    const trimmed = foundationTrim(text)
    if (trimmed.length === 0) return false
    const match = pageMarkerSuffix.exec(trimmed)
    if (!match || match.index + match[0].length !== trimmed.length) return false
    const leader = trimmed.slice(0, match.index)
    if (!containsLeader(leader, TableOfContentsDotLeader.minimumProtectedSuffixDotCount)) return false
    return [...leader].every((scalar) => scalar === '.' || isWhitespaceOnly.test(scalar))
  },

  /** The first fragment index whose joined suffix `isProtectedSuffix`. Each
   * check only discards suffixes that cannot pass, so the result matches the
   * quadratic join-and-test in the Swift implementation. */
  suffixStart(fragments: string[]): number | null {
    if (!lastBaseScalarIsPageMarker(fragments)) return null
    let runStart = fragments.length
    let dotCount = 0
    let lastCandidate: number | null = null
    while (runStart > 0) {
      const scalars = [...fragments[runStart - 1]]
      if (!scalars.every(isSuffixScalar)) break
      runStart -= 1
      dotCount += scalars.filter((scalar) => scalar === '.').length
      if (lastCandidate === null && dotCount >= TableOfContentsDotLeader.minimumProtectedSuffixDotCount) {
        lastCandidate = runStart
      }
    }
    if (lastCandidate === null) return null
    for (let index = runStart; index <= lastCandidate; index += 1) {
      const scalars = [...fragments[index]]
      const first = scalars[0]
      const startsLikeLeader = first === undefined || first === '.' || trimmedScalars.test(first)
      if (startsLikeLeader && TableOfContentsDotLeader.isProtectedSuffix(fragments.slice(index).join(''))) {
        return index
      }
    }
    return null
  },

  pageMarkerRange(fragments: string[]): { start: number; end: number } | null {
    if (!TableOfContentsDotLeader.isProtectedSuffix(fragments.join(''))) return null
    let end = fragments.length
    while (end > 0 && [...fragments[end - 1]].every((scalar) => trimmedScalars.test(scalar))) end -= 1
    let start = end
    while (start > 0 && isPageMarkerFragment(fragments[start - 1])) start -= 1
    return start < end ? { start, end } : null
  },

  isPageMarker(fragments: string[]): boolean {
    const text = foundationTrim(fragments.join(''))
    if (text.length === 0) return false
    return [...text].every((scalar) => isNumberCodePoint(scalar))
      || [...text].every((scalar) => romanScalars.has(scalar))
  }
}

function isPageMarkerFragment(text: string): boolean {
  if (text.length === 0) return false
  return [...text].every((scalar) => isNumberCodePoint(scalar) || romanScalars.has(scalar))
}
