/**
 * JSON bytes identical to native Freddie's `JSONEncoder` with `.sortedKeys` and
 * `.withoutEscapingSlashes`. A synced document is addressed by the SHA-256 of these
 * bytes and native Freddie re-encodes what it applies, so any difference would make
 * the two apps upload each other's records forever.
 */

/** A Swift `Double`; plain numbers must be integers (Swift `Int`, `Int64`, dates in ms). */
export class SwiftDouble {
  constructor(readonly value: number) {}
}

export type SwiftJSONValue = string | number | boolean | SwiftDouble | SwiftJSONValue[] | { [key: string]: SwiftJSONValue | undefined }

export function encodeSwiftJSON(value: SwiftJSONValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Sync documents encode integers only: ${value}`)
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (value instanceof SwiftDouble) return formatSwiftDouble(value.value)
  if (Array.isArray(value)) return `[${value.map(encodeSwiftJSON).join(',')}]`
  // Optionals are omitted like Swift's `encodeIfPresent`; keys sort by UTF-8 bytes, which
  // for the BMP characters used here is the same order as UTF-16 code units.
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeSwiftJSON(value[key]!)}`).join(',')}}`
}

/** Swift's `Double.description`: shortest round-trip digits, exponent below 1e-4 and from 1e16. */
export function formatSwiftDouble(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Sync documents cannot encode a non-finite number')
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e')
  const exponent = Number(exponentText)
  const digits = mantissa.replace('.', '')
  const sign = value < 0 ? '-' : ''
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    return `${sign}${fraction}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  if (digits.length <= exponent + 1) return `${sign}${digits}${'0'.repeat(exponent + 1 - digits.length)}`
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`
}
