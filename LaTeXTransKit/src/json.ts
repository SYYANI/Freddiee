// JSON as Foundation's `JSONEncoder` writes it and `JSONDecoder` accepts it. Prompts embed
// encoded slots and checkpoint fingerprints hash the prompts, so the encoding must match
// byte for byte; model answers must be accepted or rejected exactly as the Swift kit does.

/** `JSONDecoder` rejected data that does not have the expected shape. */
export class DecodingError extends Error {
  constructor() {
    super('The data couldn’t be read because it isn’t in the correct format.')
    this.name = 'DecodingError'
  }
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

/** A string literal as `JSONEncoder` writes it: "/" is escaped, DEL and U+2028 are not. */
export function encodeString(value: string): string {
  let result = '"'
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character === '"') result += '\\"'
    else if (character === '\\') result += '\\\\'
    else if (character === '/') result += '\\/'
    else if (character === '\b') result += '\\b'
    else if (character === '\f') result += '\\f'
    else if (character === '\n') result += '\\n'
    else if (character === '\r') result += '\\r'
    else if (character === '\t') result += '\\t'
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`
    else result += character
  }
  return `${result}"`
}

/** An object of strings with `.sortedKeys`, compact. */
export function encodeSortedStringObject(value: Record<string, string>, compare: (a: string, b: string) => number): string {
  return `{${Object.keys(value).sort(compare).map((key) => `${encodeString(key)}:${encodeString(value[key])}`).join(',')}}`
}

class Scanner {
  index = 0
  constructor(private readonly text: string) {}

  fail(): never {
    throw new SyntaxError('Invalid JSON')
  }

  skipWhitespace(): void {
    while (this.index < this.text.length) {
      const character = this.text[this.index]
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') return
      this.index += 1
    }
  }

  value(): JSONValue {
    this.skipWhitespace()
    const character = this.text[this.index]
    if (character === '[') return this.array()
    if (character === '{') return this.object()
    if (character === '"') return this.string()
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length
        return value
      }
    }
    if (character === '-' || (character >= '0' && character <= '9')) return this.number()
    return this.fail()
  }

  /** Numbers are consumed as a run of number characters, as the decoder skips unused values. */
  number(): number {
    const start = this.index
    while (this.index < this.text.length && '0123456789+-.eE'.includes(this.text[this.index])) this.index += 1
    return Number(this.text.slice(start, this.index))
  }

  array(): JSONValue[] {
    this.index += 1
    const values: JSONValue[] = []
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      return values
    }
    for (;;) {
      values.push(this.value())
      this.skipWhitespace()
      const separator = this.text[this.index]
      if (separator === ']') {
        this.index += 1
        return values
      }
      if (separator !== ',') this.fail()
      this.index += 1
      this.skipWhitespace()
      // A single trailing comma is accepted.
      if (this.text[this.index] === ']') {
        this.index += 1
        return values
      }
    }
  }

  object(): { [key: string]: JSONValue } {
    this.index += 1
    const result: { [key: string]: JSONValue } = Object.create(null)
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') this.fail()
      const key = this.string()
      this.skipWhitespace()
      if (this.text[this.index] !== ':') this.fail()
      this.index += 1
      const value = this.value()
      // The first occurrence of a duplicate key wins.
      if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value
      this.skipWhitespace()
      const separator = this.text[this.index]
      if (separator === '}') {
        this.index += 1
        return result
      }
      if (separator !== ',') this.fail()
      this.index += 1
      this.skipWhitespace()
      if (this.text[this.index] === '}') {
        this.index += 1
        return result
      }
    }
  }

  hexQuad(): number {
    const digits = this.text.slice(this.index, this.index + 4)
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail()
    this.index += 4
    return Number.parseInt(digits, 16)
  }

  string(): string {
    this.index += 1
    let result = ''
    for (;;) {
      if (this.index >= this.text.length) this.fail()
      const character = this.text[this.index]
      if (character === '"') {
        this.index += 1
        return result
      }
      if (character.charCodeAt(0) < 0x20) this.fail()
      if (character !== '\\') {
        result += character
        this.index += 1
        continue
      }
      const escape = this.text[this.index + 1]
      this.index += 2
      switch (escape) {
        case '"': result += '"'; break
        case '\\': result += '\\'; break
        case '/': result += '/'; break
        case 'b': result += '\b'; break
        case 'f': result += '\f'; break
        case 'n': result += '\n'; break
        case 'r': result += '\r'; break
        case 't': result += '\t'; break
        case 'u': {
          const unit = this.hexQuad()
          if (unit >= 0xdc00 && unit <= 0xdfff) this.fail()
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') this.fail()
            this.index += 2
            const low = this.hexQuad()
            if (low < 0xdc00 || low > 0xdfff) this.fail()
            result += String.fromCharCode(unit, low)
          } else result += String.fromCharCode(unit)
          break
        }
        default: this.fail()
      }
    }
  }
}

/** Parses JSON the way `JSONDecoder` reads it; undefined when the decoder would throw. */
export function parseJSON(text: string): JSONValue | undefined {
  try {
    const scanner = new Scanner(text.startsWith('\ufeff') ? text.slice(1) : text)
    const value = scanner.value()
    scanner.skipWhitespace()
    if (scanner.index !== (text.startsWith('\ufeff') ? text.length - 1 : text.length)) return undefined
    return value
  } catch {
    return undefined
  }
}

export function isJSONObject(value: JSONValue | undefined): value is { [key: string]: JSONValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decodes UTF-8 strictly, as `String(data:encoding: .utf8)` does: a leading byte order mark
 * is dropped, and invalid bytes give undefined.
 */
export function decodeUTF8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return undefined
  }
}
