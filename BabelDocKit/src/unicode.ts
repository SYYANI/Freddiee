// Unicode predicates shared by the paragraph stages. Swift iterates Characters
// (grapheme clusters); these helpers iterate code points, which matches for the
// single-scalar glyph text PDFs carry. All sets follow the Swift definitions:
// White_Space for whitespace, N for isNumber, Nd for decimal digits.
const isWhitespaceScalar = /\p{White_Space}/u
const isLetterScalar = /\p{L}/u
const isLowercaseScalar = /\p{Lowercase}/u
const isNumberScalar = /\p{N}/u
const isDecimalDigitScalar = /\p{Nd}/u

export function isWhitespaceCodePoint(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && isWhitespaceScalar.test(value)
}

export function isLetterCodePoint(value: string): boolean {
  return isLetterScalar.test(value)
}

export function isLowercaseCodePoint(value: string): boolean {
  return isLowercaseScalar.test(value)
}

export function isNumberCodePoint(value: string): boolean {
  return isNumberScalar.test(value)
}

export function isDecimalDigitCodePoint(value: string): boolean {
  return isDecimalDigitScalar.test(value)
}

/** NFKC compatibility mapping, then any whitespace run collapses to one space. */
export function normalizeWhitespace(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ')
}

/** Foundation's trimmingCharacters(in: .whitespacesAndNewlines): Unicode
 * White_Space plus U+200B (which CharacterSet.whitespacesAndNewlines carries
 * even though it is not White_Space). Unlike String.trim, U+FEFF stays. */
export function foundationTrim(text: string): string {
  const scalars = [...text]
  let start = 0
  let end = scalars.length
  while (start < end && isTrimmableScalar(scalars[start])) start += 1
  while (end > start && isTrimmableScalar(scalars[end - 1])) end -= 1
  return scalars.slice(start, end).join('')
}

export function isTrimmableScalar(value: string): boolean {
  return isWhitespaceScalar.test(value) || value === '\u200B'
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const romanNumerals = new Set('ivxlcdmIVXLCDM')

export function isRomanNumeralCodePoint(value: string): boolean {
  return romanNumerals.has(value)
}

/** Word interiors by ICU word segmentation (Foundation's enumerateSubstrings
 * byWords); a cut between fragments keeps words such as 共同 whole. */
export function wordInteriorOffsets(text: string): Set<number> {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' })
  const interiors = new Set<number>()
  let offset = 0
  for (const segment of segmenter.segment(text)) {
    const length = [...segment.segment].length
    if (length > 1) {
      for (let index = 1; index < length; index += 1) interiors.add(offset + index)
    }
    offset += length
  }
  return interiors
}
