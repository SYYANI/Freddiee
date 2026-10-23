// Swift `String` and `Character` semantics that the Swift kit relies on.
//
// The Swift kit walks `Array(text)`, an array of extended grapheme clusters, and asks each
// cluster questions such as `isWhitespace` or `isNumber`, which Swift answers from the first
// Unicode scalar. The property tables in `resources/unicode-properties.json` are exported from
// the Swift runtime, so the answers do not depend on the Unicode version of the JavaScript engine.
import properties from '../resources/unicode-properties.json'

/** Swift `Array(String)`: one element per extended grapheme cluster ("\r\n" is one element). */
export type Characters = string[]

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export function characters(text: string): Characters {
  // In ASCII only CR LF forms a multi-scalar cluster.
  if (!/[^\x00-\x7f]|\r\n/.test(text)) return text.split('')
  return Array.from(segmenter.segment(text), (segment) => segment.segment)
}

/** Swift `String(characters[start..<end])`. */
export function slice(chars: Characters, start = 0, end = chars.length): string {
  return chars.slice(start, end).join('')
}

/** Swift `string.count`. */
export function characterCount(text: string): number {
  return characters(text).length
}

function lookup(flattened: number[]): (scalar: number) => boolean {
  return (scalar) => {
    let low = 0
    let high = flattened.length / 2 - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (scalar < flattened[middle * 2]) high = middle - 1
      else if (scalar > flattened[middle * 2 + 1]) low = middle + 1
      else return true
    }
    return false
  }
}

const scalarIsAlphabetic = lookup(properties.alphabetic)
const scalarIsNumeric = lookup(properties.numeric)
const scalarIsWhitespace = lookup(properties.whitespace)

/** `Unicode.Scalar.Properties.isAlphabetic`. */
export function isAlphabeticScalar(scalar: number): boolean {
  return scalarIsAlphabetic(scalar)
}

const firstScalar = (character: string): number => character.codePointAt(0) ?? -1

/** `Character.isWhitespace`. */
export function isWhitespace(character: string): boolean {
  return scalarIsWhitespace(firstScalar(character))
}

/** `Character.isNewline`. */
export function isNewline(character: string): boolean {
  const scalar = firstScalar(character)
  return (scalar >= 0x0a && scalar <= 0x0d) || scalar === 0x85 || scalar === 0x2028 || scalar === 0x2029
}

/** `Character.isLetter`. */
export function isLetter(character: string): boolean {
  return scalarIsAlphabetic(firstScalar(character))
}

/** `Character.isNumber`: any numeric type, including CJK numerals. */
export function isNumber(character: string): boolean {
  return scalarIsNumeric(firstScalar(character))
}

/** A single scalar in A–Z or a–z. */
export function isASCIILetter(character: string): boolean {
  if (character.length !== 1) return false
  const code = character.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** A single scalar in 0–9. */
export function isASCIIDigit(character: string): boolean {
  return character.length === 1 && character >= '0' && character <= '9'
}

/** Foundation `CharacterSet.whitespacesAndNewlines`. */
const whitespaceAndNewlineScalar = /[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]/u
const leadingWhitespaceAndNewlines = /^[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]+/u
const trailingWhitespaceAndNewlines = /[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]+$/u

/** `trimmingCharacters(in: .whitespacesAndNewlines)`; unlike `String.trim`, it keeps U+FEFF. */
export function trimmed(value: string): string {
  return value.replace(leadingWhitespaceAndNewlines, '').replace(trailingWhitespaceAndNewlines, '')
}

/** `trimmingCharacters(in: .whitespaces)`. */
export function trimmedWhitespaces(value: string): string {
  return value.replace(/^[\p{Zs}\t]+/u, '').replace(/[\p{Zs}\t]+$/u, '')
}

export function isWhitespaceOrNewlineScalar(scalar: string): boolean {
  return whitespaceAndNewlineScalar.test(scalar)
}

/** `components(separatedBy: .newlines)`: every newline scalar separates, so "\r\n" yields an empty component. */
export function newlineComponents(value: string): string[] {
  return value.split(/[\n\v\f\r\u0085\u2028\u2029]/)
}

/** `split(whereSeparator: \.isWhitespace)` with empty subsequences omitted. */
export function splitWhitespace(value: string): string[] {
  const words: string[] = []
  let word = ''
  for (const character of characters(value)) {
    if (isWhitespace(character)) {
      if (word) words.push(word)
      word = ''
    } else word += character
  }
  if (word) words.push(word)
  return words
}

/** `lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")`. */
export function comparisonForm(value: string): string {
  return splitWhitespace(value.toLowerCase()).join(' ')
}

/** `String(value.prefix(count))`, counted in characters. */
export function characterPrefix(value: string, count: number): string {
  const chars = characters(value)
  return chars.length <= count ? value : slice(chars, 0, count)
}

/** Swift `String` ordering: Unicode scalar order of the canonically composed strings. */
export function compareStrings(a: string, b: string): number {
  const left = a.normalize('NFC')
  const right = b.normalize('NFC')
  const leftScalars = Array.from(left, (scalar) => scalar.codePointAt(0)!)
  const rightScalars = Array.from(right, (scalar) => scalar.codePointAt(0)!)
  const length = Math.min(leftScalars.length, rightScalars.length)
  for (let index = 0; index < length; index += 1) {
    if (leftScalars[index] !== rightScalars[index]) return leftScalars[index] < rightScalars[index] ? -1 : 1
  }
  return leftScalars.length - rightScalars.length
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings)
}

/** Swift's `description` of a `Double`, as used in cache identities ("1.0", not "1"). */
export function doubleDescription(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`
  return String(value)
}

/** Foundation `CharacterSet.alphanumerics`: letters, marks and numbers. */
const alphanumericScalar = /[\p{L}\p{M}\p{N}]/u

/** Replaces every scalar outside alphanumerics and `allowed` with "_", as the Swift kit names folders. */
export function safeComponent(value: string, allowed: string, fallback: string): string {
  const result = Array.from(value, (scalar) => (alphanumericScalar.test(scalar) || allowed.includes(scalar) ? scalar : '_')).join('')
  return result || fallback
}
