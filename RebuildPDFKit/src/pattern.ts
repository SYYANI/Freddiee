/**
 * Regular expressions and string helpers with the Python semantics the rebuild rules rely on.
 *
 * The rules were written and tuned in Python and ported pattern for pattern to Swift
 * (ICU). Patterns here are written in that ICU syntax and translated to JavaScript:
 * `\w`, `\d` and `\b` are Unicode-aware as in ICU and Python, and `\z` is the end of input.
 * Offsets are UTF-16 offsets, as with `NSString`.
 */

/** ICU's `\w`: alphabetic, marks, decimal digits, connector punctuation, ZWNJ and ZWJ. */
const wordClass = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍`
const word = `[${wordClass}]`
const boundary = `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`

/** Rewrites the ICU escapes whose JavaScript meaning differs. Character classes keep `\w` and `\d` inside. */
function translate(source: string): string {
  let output = ''
  let inClass = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (!inClass && source.startsWith('[^\\W', index)) {
      // [^\W...]: word characters except the listed ones.
      let end = index + 4
      while (source[end] !== ']') end += source[end] === '\\' ? 2 : 1
      output += `(?:(?![${translate(`[${source.slice(index + 4, end)}]`).slice(1, -1)}])${word})`
      index = end
      continue
    }
    if (character === '\\' && index + 1 < source.length) {
      const next = source[index + 1]
      index += 1
      if (next === 'w') output += inClass ? wordClass : word
      else if (next === 'W') {
        if (inClass) throw new Error(`\\W inside a character class is not supported: ${source}`)
        output += `[^${wordClass}]`
      } else if (next === 'd') output += String.raw`\p{Nd}`
      else if (next === 'D') output += String.raw`\P{Nd}`
      else if (next === 'b' && !inClass) output += boundary
      else if (next === 'z' && !inClass) output += '(?![\\s\\S])'
      else output += `\\${next}`
      continue
    }
    if (character === '[' && !inClass) inClass = true
    else if (character === ']' && inClass) inClass = false
    output += character
  }
  return output
}

export interface PatternFlags {
  /** `re.S`: `.` also matches line breaks. */
  dotAll?: boolean
  /** `re.M`: `^` and `$` match at every line. */
  multiline?: boolean
  /** `re.I`. */
  ignoreCase?: boolean
}

export class PatternMatch {
  constructor(private readonly result: RegExpExecArray) {}

  get start(): number { return this.result.index }
  get end(): number { return this.result.index + this.result[0].length }
  get text(): string { return this.result[0] }
  get groupCount(): number { return this.result.length - 1 }

  /** The group's text, or undefined when the group did not take part in the match. */
  group(index: number): string | undefined {
    return this.result[index]
  }

  /** The group's text, empty when it did not take part in the match. */
  at(index: number): string {
    return this.result[index] ?? ''
  }
}

export class Pattern {
  private readonly global: RegExp
  private readonly sticky: RegExp
  private readonly whole: RegExp

  constructor(readonly source: string, flags: PatternFlags = {}) {
    const translated = translate(source)
    const base = `u${flags.dotAll ? 's' : ''}${flags.multiline ? 'm' : ''}${flags.ignoreCase ? 'i' : ''}`
    this.global = new RegExp(translated, `g${base}`)
    this.sticky = new RegExp(translated, `y${base}`)
    // Python's fullmatch may backtrack into a longer match than search would return.
    this.whole = new RegExp(`(?:${translated})(?![\\s\\S])`, `y${base}`)
  }

  /** `re.search`, optionally starting at a UTF-16 offset. */
  search(text: string, from = 0): PatternMatch | undefined {
    if (from > text.length) return undefined
    this.global.lastIndex = from
    const result = this.global.exec(text)
    return result ? new PatternMatch(result) : undefined
  }

  /** `re.match`: a match that starts at the beginning of the string. */
  match(text: string): PatternMatch | undefined {
    this.sticky.lastIndex = 0
    const result = this.sticky.exec(text)
    return result ? new PatternMatch(result) : undefined
  }

  /** `re.fullmatch`. */
  fullMatch(text: string): PatternMatch | undefined {
    this.whole.lastIndex = 0
    const result = this.whole.exec(text)
    return result ? new PatternMatch(result) : undefined
  }

  contains(text: string): boolean {
    return this.search(text) !== undefined
  }

  /** `re.finditer`. */
  matches(text: string): PatternMatch[] {
    return [...text.matchAll(this.global)].map((result) => new PatternMatch(result as RegExpExecArray))
  }

  /** `re.findall` for a pattern with at most one group (the first group otherwise). */
  findAll(text: string): string[] {
    return this.matches(text).map((match) => match.groupCount > 0 ? match.at(1) : match.text)
  }

  /** `re.findall` for a pattern with several groups; groups that did not take part are empty. */
  findAllGroups(text: string): string[][] {
    return this.matches(text).map((match) => Array.from({ length: match.groupCount }, (_, index) => match.at(index + 1)))
  }

  /** `re.sub` with a replacement function or a literal replacement (no group references). */
  sub(text: string, replacement: string | ((match: PatternMatch) => string), count = 0): string {
    let output = ''
    let previous = 0
    let replaced = 0
    for (const match of this.matches(text)) {
      if (count > 0 && replaced === count) break
      output += text.slice(previous, match.start)
      output += typeof replacement === 'string' ? replacement : replacement(match)
      previous = match.end
      replaced += 1
    }
    return output + text.slice(previous)
  }

  /** `re.split`, including captured groups between the pieces. */
  split(text: string): string[] {
    const pieces: string[] = []
    let previous = 0
    for (const match of this.matches(text)) {
      pieces.push(text.slice(previous, match.start))
      for (let group = 1; group <= match.groupCount; group += 1) pieces.push(match.at(group))
      previous = match.end
    }
    pieces.push(text.slice(previous))
    return pieces
  }
}

// MARK: - Python string helpers

const whitespace = new Set<number>([
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x85, 0xA0, 0x1680,
  0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
  ...Array.from({ length: 11 }, (_, index) => 0x2000 + index)
])
const lineBreaks = new Set<number>([0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x85, 0x2028, 0x2029])

function scalars(text: string): string[] {
  return Array.from(text)
}

function isSpace(scalar: string): boolean {
  return whitespace.has(scalar.codePointAt(0)!)
}

export const PythonText = {
  /** `str.isspace` for one code point. */
  isSpace,

  /** `str.strip()`, or `str.strip(characters)`. */
  strip(text: string, characters?: string): string {
    const removable = characters === undefined ? isSpace : (scalar: string) => characters.includes(scalar)
    const units = scalars(text)
    let first = 0
    while (first < units.length && removable(units[first])) first += 1
    let last = units.length
    while (last > first && removable(units[last - 1])) last -= 1
    return units.slice(first, last).join('')
  },

  /** `str.rstrip()`. */
  rstrip(text: string): string {
    const units = scalars(text)
    let last = units.length
    while (last > 0 && isSpace(units[last - 1])) last -= 1
    return units.slice(0, last).join('')
  },

  /** `str.lstrip()`. */
  lstrip(text: string): string {
    const units = scalars(text)
    let first = 0
    while (first < units.length && isSpace(units[first])) first += 1
    return units.slice(first).join('')
  },

  /** `str.split()` without arguments. */
  splitWhitespace(text: string): string[] {
    const words: string[] = []
    let current = ''
    for (const scalar of text) {
      if (isSpace(scalar)) {
        if (current) words.push(current)
        current = ''
      } else {
        current += scalar
      }
    }
    if (current) words.push(current)
    return words
  },

  /** `str.splitlines()`. */
  splitLines(text: string): string[] {
    const lines: string[] = []
    let current = ''
    let pendingCarriageReturn = false
    let ended = true
    for (const scalar of text) {
      const value = scalar.codePointAt(0)!
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false
        if (value === 0x0A) continue
      }
      if (lineBreaks.has(value)) {
        lines.push(current)
        current = ''
        pendingCarriageReturn = value === 0x0D
        ended = true
      } else {
        current += scalar
        ended = false
      }
    }
    if (!ended || current) lines.push(current)
    return lines
  },

  /** `len(text)`: the number of code points. */
  length(text: string): number {
    let count = 0
    for (const _ of text) count += 1
    return count
  },

  /** `text[:count]` in code points. */
  prefix(text: string, count: number): string {
    return scalars(text).slice(0, count).join('')
  },

  /** `text[-count:]` in code points. */
  suffix(text: string, count: number): string {
    const units = scalars(text)
    return units.slice(Math.max(0, units.length - count)).join('')
  },

  /** `repr(text)` for a string. */
  repr(text: string): string {
    const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
    let output = quote
    for (const scalar of text) {
      if (scalar === '\\') output += '\\\\'
      else if (scalar === '\n') output += '\\n'
      else if (scalar === '\r') output += '\\r'
      else if (scalar === '\t') output += '\\t'
      else if (scalar === quote) output += `\\${quote}`
      else if (isPrintable(scalar)) output += scalar
      else {
        const value = scalar.codePointAt(0)!
        output += value < 0x100 ? `\\x${hex(value, 2)}` : value < 0x10000 ? `\\u${hex(value, 4)}` : `\\U${hex(value, 8)}`
      }
    }
    return output + quote
  }
}

const unprintable = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u

function isPrintable(scalar: string): boolean {
  return scalar === ' ' || !unprintable.test(scalar)
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, '0')
}

/** `str.isalnum` for one code point. */
export function isAlphanumeric(scalar: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(scalar)
}

// MARK: - Numbers

/** Rounds to the nearest integer, ties to the even neighbour (`rounded(.toNearestOrEven)`). */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const difference = value - floor
  if (difference > 0.5) return floor + 1
  if (difference < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Swift's `rounded()`: ties away from zero. */
export function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** `printf("%.Nf")`: the exact binary value rounded to N decimals, ties to even. */
function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  const negative = value < 0 || Object.is(value, -0)
  const magnitude = Math.abs(value)
  let text = magnitude.toFixed(digits)
  // toFixed breaks an exact tie upwards; printf takes the even neighbour.
  const exact = magnitude.toFixed(100)
  const point = exact.indexOf('.')
  const rest = exact.slice(point + 1 + digits)
  if (/^50*$/.test(rest)) {
    const truncated = exact.slice(0, digits === 0 ? point : point + 1 + digits)
    const lastDigit = Number(truncated.replace('.', '').slice(-1))
    if (lastDigit % 2 === 0) text = truncated
  }
  return negative ? `-${text}` : text
}

/** `printf("%g")`. */
function general(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const negative = value < 0
  const magnitude = Math.abs(value)
  const exponential = magnitude.toExponential(5)
  const exponent = Number(exponential.slice(exponential.indexOf('e') + 1))
  let text: string
  if (exponent >= -4 && exponent < 6) {
    text = fixed(magnitude, 5 - exponent)
    if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  } else {
    const mantissa = exponential.slice(0, exponential.indexOf('e')).replace(/0+$/, '').replace(/\.$/, '')
    text = `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  return negative ? `-${text}` : text
}

export const PythonNumber = {
  /** `f"{value:.Nf}"`. */
  fixed,
  /** `f"{value:g}"`. */
  general,
  /** `round(value)`: ties go to the even neighbour; `round(value, digits)` for report values. */
  round(value: number, digits?: number): number {
    if (digits === undefined) return roundHalfEven(value)
    const scale = 10 ** digits
    return roundHalfEven(value * scale) / scale
  },
  /** `statistics.median`. */
  median(values: number[]): number {
    if (!values.length) throw new Error('median of an empty list')
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
}

/** `statistics.median` of the values that are present, or a default. */
export function median(values: Array<number | undefined>, fallback: number): number {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length ? PythonNumber.median(present) : fallback
}

/** Swift's `Double(String)`: a complete decimal or hexadecimal float literal, or undefined. */
export function parseDouble(text: string): number | undefined {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text)
  if (/^[+-]?(?:inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(text)) return Number.NaN
  if (/^[+-]?0x[\da-f]+(?:\.[\da-f]*)?(?:p[+-]?\d+)?$/i.test(text)) {
    const match = /^([+-]?)0x([\da-f]+)(?:\.([\da-f]*))?(?:p([+-]?\d+))?$/i.exec(text)!
    const fraction = match[3] ?? ''
    const mantissa = parseInt(match[2] + fraction, 16) / 16 ** fraction.length
    const value = mantissa * 2 ** Number(match[4] ?? 0)
    return match[1] === '-' ? -value : value
  }
  return undefined
}

/** Swift's `Int(String)`. */
export function parseInt10(text: string): number | undefined {
  return /^[+-]?\d+$/.test(text) ? Number(text) : undefined
}

/** Swift's `"\(double)"`: the shortest representation, always with a decimal point or exponent. */
export function doubleDescription(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 2 ** 53)) {
    const [mantissa, exponent] = value.toExponential().split('e')
    const power = Number(exponent)
    return `${mantissa}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
  }
  const text = Object.is(value, -0) ? '-0' : String(value)
  return /[.e]/.test(text) ? text : `${text}.0`
}

/** Python's `sorted(key=...)`, which keeps equal elements in their original order. */
export function stableSorted<T>(items: readonly T[], key: (item: T) => number | string): T[] {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index)
    .map((entry) => entry.item)
}

/** Lexicographic comparison of number tuples, as Swift and Python compare tuples. */
export function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length - b.length
}

/** `str.count(substring)` for one UTF-16 unit or substring, non-overlapping. */
export function occurrences(text: string, substring: string): number {
  return substring ? text.split(substring).length - 1 : 0
}
