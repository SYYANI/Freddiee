// Preparation/TarGzipTranslationArchiveReader.swift and ZipTranslationArchiveReader.swift
import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createGunzip, crc32, inflateRawSync } from 'node:zlib'
import { decodeUTF8 } from './json'
import { checkCancellation } from './models'
import { ProjectPreparationError } from './preparation'
import { trimmed } from './text'

export type TranslationArchiveEntryKind = 'regularFile' | 'directory' | 'symbolicLink' | 'hardLink'

export interface TranslationArchiveEntry {
  path: string
  kind: TranslationArchiveEntryKind
  uncompressedSize: number
  contents: Uint8Array
}

export interface TranslationArchiveReading {
  entries(archivePath: string, signal?: AbortSignal): AsyncIterable<TranslationArchiveEntry>
}

const defaultMaximumEntrySize = 128 * 1_024 * 1_024

// MARK: Tar and gzip

export type TarGzipArchiveReaderErrorReason =
  | { kind: 'unableToOpen'; path: string }
  | { kind: 'readFailed'; message: string }
  | { kind: 'truncatedArchive' }
  | { kind: 'invalidHeader' }
  | { kind: 'invalidHeaderChecksum'; path: string }
  | { kind: 'invalidNumericField'; path: string }
  | { kind: 'unsupportedEntryType'; path: string; type: number }
  | { kind: 'entryTooLarge'; path: string; size: number; limit: number }
  | { kind: 'invalidExtendedHeader' }
  | { kind: 'unsupportedSingleFile' }

export class TarGzipArchiveReaderError extends Error {
  constructor(readonly reason: TarGzipArchiveReaderErrorReason) {
    super(TarGzipArchiveReaderError.describe(reason))
    this.name = 'TarGzipArchiveReaderError'
  }

  private static describe(reason: TarGzipArchiveReaderErrorReason): string {
    switch (reason.kind) {
      case 'unableToOpen': return `Unable to open the tar or gzip source at ${reason.path}.`
      case 'readFailed': return `Reading the tar or gzip source failed: ${reason.message}.`
      case 'truncatedArchive': return 'The tar or gzip source ended unexpectedly.'
      case 'invalidHeader': return 'The source does not contain a valid tar header.'
      case 'invalidHeaderChecksum': return `The tar header checksum is invalid for ${reason.path}.`
      case 'invalidNumericField': return `The tar entry contains an invalid numeric field: ${reason.path}.`
      case 'unsupportedEntryType': return `The tar entry ${reason.path} has unsupported type ${reason.type}.`
      case 'entryTooLarge': return `The tar entry ${reason.path} is ${reason.size} bytes, exceeding the reader limit of ${reason.limit} bytes.`
      case 'invalidExtendedHeader': return 'The tar source contains an invalid extended header.'
      case 'unsupportedSingleFile': return 'The source is neither a tar archive nor a supported single TeX file.'
    }
  }
}

/**
 * Reads a file as zlib's `gzread` does: gzip members are decompressed (concatenated ones in
 * sequence) and any other file is read as it is.
 */
class GzipStreamReader {
  private readonly chunks: AsyncIterator<Buffer>
  private buffer: Buffer = Buffer.alloc(0)
  private ended = false

  private constructor(chunks: AsyncIterable<Buffer>) {
    this.chunks = chunks[Symbol.asyncIterator]()
  }

  static async open(path: string): Promise<GzipStreamReader> {
    let magic: Buffer
    try {
      const handle = await open(path, 'r')
      try {
        magic = Buffer.alloc(2)
        const { bytesRead } = await handle.read(magic, 0, 2, 0)
        magic = magic.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      throw new TarGzipArchiveReaderError({ kind: 'unableToOpen', path })
    }
    const file = createReadStream(path, { highWaterMark: 64 * 1_024 })
    if (magic.length < 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) return new GzipStreamReader(file)
    const gunzip = createGunzip()
    file.on('error', (error) => gunzip.destroy(error))
    return new GzipStreamReader(file.pipe(gunzip))
  }

  private async fill(count: number, signal?: AbortSignal): Promise<void> {
    while (this.buffer.length < count && !this.ended) {
      checkCancellation(signal)
      let next: IteratorResult<Buffer>
      try {
        next = await this.chunks.next()
      } catch (error) {
        throw new TarGzipArchiveReaderError({ kind: 'readFailed', message: error instanceof Error ? error.message : String(error) })
      }
      if (next.done) this.ended = true
      else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value
    }
  }

  private take(count: number): Uint8Array {
    const result = new Uint8Array(this.buffer.subarray(0, count))
    this.buffer = this.buffer.subarray(count)
    return result
  }

  /** Up to `count` bytes; undefined at the end of the source. */
  async read(count: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    if (count <= 0) return new Uint8Array()
    await this.fill(count, signal)
    if (!this.buffer.length) return undefined
    return this.take(Math.min(count, this.buffer.length))
  }

  /** Exactly `count` bytes; undefined when the source ended before the first byte. */
  async readExactly(count: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    if (count <= 0) return new Uint8Array()
    await this.fill(count, signal)
    if (!this.buffer.length) return undefined
    if (this.buffer.length < count) throw new TarGzipArchiveReaderError({ kind: 'truncatedArchive' })
    return this.take(count)
  }

  close(): void {
    void this.chunks.return?.()
  }
}

const blockSize = 512
const lossyUTF8 = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * Streams tar entries from plain or gzip-compressed sources without expanding the complete
 * archive in memory. arXiv's gzip-compressed single-TeX response is surfaced as `main.tex`.
 */
export class TarGzipTranslationArchiveReader implements TranslationArchiveReading {
  private readonly maximumEntrySize: number

  constructor(maximumEntrySize = defaultMaximumEntrySize) {
    this.maximumEntrySize = Math.max(0, maximumEntrySize)
  }

  async *entries(archivePath: string, signal?: AbortSignal): AsyncGenerator<TranslationArchiveEntry> {
    const reader = await GzipStreamReader.open(archivePath)
    try {
      const firstBlock = await reader.read(blockSize, signal)
      if (!firstBlock?.length) throw new TarGzipArchiveReaderError({ kind: 'invalidHeader' })
      if (firstBlock.length !== blockSize || !isTarHeader(firstBlock)) {
        yield await this.singleTeXFile(firstBlock, reader, signal)
        return
      }

      let nextBlock: Uint8Array | undefined = firstBlock
      let pendingPath: string | undefined
      let pendingLinkPath: string | undefined
      const globalPAX = new Map<string, string>()
      while (nextBlock) {
        checkCancellation(signal)
        const header: Uint8Array = nextBlock
        if (isZeroBlock(header)) return
        const basePath = headerPath(header)
        validateChecksum(header, basePath)
        const size = numericField(header, 124, 136, basePath)
        if (size < 0) throw new TarGzipArchiveReaderError({ kind: 'invalidNumericField', path: basePath })
        const type = header[156]
        const payload = await this.readPayload(size, basePath, reader, signal)

        switch (type) {
          case 0: case 48: case 53: case 49: case 50: {
            const path = pendingPath ?? globalPAX.get('path') ?? basePath
            const linkPath = pendingLinkPath ?? globalPAX.get('linkpath') ?? headerString(header, 157, 257)
            pendingPath = undefined
            pendingLinkPath = undefined
            const encodedLink = new TextEncoder().encode(linkPath)
            const kind: TranslationArchiveEntryKind = type === 53 ? 'directory' : type === 49 ? 'hardLink' : type === 50 ? 'symbolicLink' : 'regularFile'
            const contents = kind === 'directory' ? new Uint8Array() : kind === 'regularFile' ? payload : encodedLink
            yield { path, kind, uncompressedSize: kind === 'regularFile' ? size : 0, contents }
            break
          }
          case 76:
            pendingPath = extendedString(payload)
            break
          case 75:
            pendingLinkPath = extendedString(payload)
            break
          case 120: {
            const values = parsePAX(payload)
            pendingPath = values.get('path') ?? pendingPath
            pendingLinkPath = values.get('linkpath') ?? pendingLinkPath
            break
          }
          case 103:
            for (const [key, value] of parsePAX(payload)) globalPAX.set(key, value)
            break
          default:
            throw new TarGzipArchiveReaderError({ kind: 'unsupportedEntryType', path: basePath, type })
        }

        nextBlock = await reader.readExactly(blockSize, signal)
        if (!nextBlock) throw new TarGzipArchiveReaderError({ kind: 'truncatedArchive' })
      }
    } finally {
      reader.close()
    }
  }

  private async singleTeXFile(firstBlock: Uint8Array, reader: GzipStreamReader, signal?: AbortSignal): Promise<TranslationArchiveEntry> {
    const parts = [firstBlock]
    let size = firstBlock.length
    for (let chunk = await reader.read(64 * 1_024, signal); chunk?.length; chunk = await reader.read(64 * 1_024, signal)) {
      checkCancellation(signal)
      size += chunk.length
      if (size > this.maximumEntrySize) throw new TarGzipArchiveReaderError({ kind: 'entryTooLarge', path: 'main.tex', size, limit: this.maximumEntrySize })
      parts.push(chunk)
    }
    const contents = new Uint8Array(Buffer.concat(parts))
    const source = decodeUTF8(contents)
    if (source === undefined || !/\\document(?:class|style)/.test(source)) throw new TarGzipArchiveReaderError({ kind: 'unsupportedSingleFile' })
    return { path: 'main.tex', kind: 'regularFile', uncompressedSize: contents.length, contents }
  }

  private async readPayload(size: number, path: string, reader: GzipStreamReader, signal?: AbortSignal): Promise<Uint8Array> {
    if (size > this.maximumEntrySize || size > Number.MAX_SAFE_INTEGER) {
      throw new TarGzipArchiveReaderError({ kind: 'entryTooLarge', path, size, limit: this.maximumEntrySize })
    }
    const payload = (await reader.readExactly(size, signal)) ?? new Uint8Array()
    if (payload.length !== size) throw new TarGzipArchiveReaderError({ kind: 'truncatedArchive' })
    const padding = (blockSize - (size % blockSize)) % blockSize
    if (padding > 0 && !(await reader.readExactly(padding, signal))) throw new TarGzipArchiveReaderError({ kind: 'truncatedArchive' })
    return payload
  }
}

function isZeroBlock(data: Uint8Array): boolean {
  return data.every((byte) => byte === 0)
}

function isTarHeader(header: Uint8Array): boolean {
  if (header.length !== blockSize || isZeroBlock(header)) return false
  if (headerString(header, 257, 263) === 'ustar') return true
  const path = headerPath(header)
  if (!path) return false
  try {
    validateChecksum(header, path)
    return true
  } catch {
    return false
  }
}

function validateChecksum(header: Uint8Array, path: string): void {
  const stored = numericField(header, 148, 156, path)
  let computed = 0
  header.forEach((byte, index) => {
    computed += index >= 148 && index < 156 ? 32 : byte
  })
  if (stored !== computed) throw new TarGzipArchiveReaderError({ kind: 'invalidHeaderChecksum', path })
}

/** An octal field, or a base-256 one when the high bit is set (Int64 arithmetic). */
function numericField(header: Uint8Array, start: number, end: number, path: string): number {
  const bytes = header.subarray(start, end)
  if (!bytes.length) throw new TarGzipArchiveReaderError({ kind: 'invalidNumericField', path })
  const first = bytes[0]
  if (first & 0x80) {
    if (first & 0x40) throw new TarGzipArchiveReaderError({ kind: 'invalidNumericField', path })
    let value = 0n
    bytes.forEach((byte, index) => {
      value = BigInt.asIntN(64, (value << 8n) | BigInt(index === 0 ? byte & 0x7f : byte))
    })
    return Number(value)
  }
  const text = lossyUTF8.decode(bytes).replace(/^[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029\0]+|[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029\0]+$/gu, '')
  if (!/^[0-7]*$/.test(text)) throw new TarGzipArchiveReaderError({ kind: 'invalidNumericField', path })
  const number = text ? Number.parseInt(text, 8) : 0
  if (!Number.isSafeInteger(number)) throw new TarGzipArchiveReaderError({ kind: 'invalidNumericField', path })
  return number
}

function headerPath(header: Uint8Array): string {
  const name = headerString(header, 0, 100)
  const prefix = headerString(header, 345, 500)
  return prefix ? `${prefix}/${name}` : name
}

function headerString(header: Uint8Array, start: number, end: number): string {
  const field = header.subarray(start, end)
  const terminator = field.indexOf(0)
  return trimmed(lossyUTF8.decode(terminator >= 0 ? field.subarray(0, terminator) : field))
}

function extendedString(data: Uint8Array): string {
  const value = decodeUTF8(data)?.replace(/^[\0\n]+|[\0\n]+$/g, '')
  if (!value) throw new TarGzipArchiveReaderError({ kind: 'invalidExtendedHeader' })
  return value
}

function parsePAX(data: Uint8Array): Map<string, string> {
  const result = new Map<string, string>()
  const invalid = (): TarGzipArchiveReaderError => new TarGzipArchiveReaderError({ kind: 'invalidExtendedHeader' })
  let cursor = 0
  while (cursor < data.length) {
    const space = data.indexOf(32, cursor)
    if (space < 0) throw invalid()
    const lengthText = lossyUTF8.decode(data.subarray(cursor, space))
    if (!/^[+-]?[0-9]+$/.test(lengthText)) throw invalid()
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= 0 || cursor > data.length - length) throw invalid()
    const end = cursor + length
    const record = data.subarray(space + 1, end)
    const equals = record.indexOf(61)
    if (record[record.length - 1] !== 10 || equals < 0) throw invalid()
    const key = decodeUTF8(record.subarray(0, equals))
    const value = decodeUTF8(data.subarray(space + 1 + equals + 1, end - 1))
    if (key === undefined || value === undefined) throw invalid()
    result.set(key, value)
    cursor = end
  }
  return result
}

// MARK: ZIP

export type ZipArchiveReaderErrorReason =
  | { kind: 'unableToOpen'; path: string }
  | { kind: 'truncatedArchive' }
  | { kind: 'invalidEndRecord' }
  | { kind: 'multiDiskArchiveUnsupported' }
  | { kind: 'zip64Unsupported' }
  | { kind: 'tooManyEntries'; count: number; limit: number }
  | { kind: 'invalidCentralDirectory' }
  | { kind: 'invalidFileName' }
  | { kind: 'encryptedEntry'; path: string }
  | { kind: 'unsupportedCompression'; path: string; method: number }
  | { kind: 'entryTooLarge'; path: string; size: number; limit: number }
  | { kind: 'invalidLocalHeader'; path: string }
  | { kind: 'decompressionFailed'; path: string; code: number }
  | { kind: 'invalidExpandedSize'; path: string; expected: number; actual: number }
  | { kind: 'checksumMismatch'; path: string }

export class ZipArchiveReaderError extends Error {
  constructor(readonly reason: ZipArchiveReaderErrorReason) {
    super(ZipArchiveReaderError.describe(reason))
    this.name = 'ZipArchiveReaderError'
  }

  private static describe(reason: ZipArchiveReaderErrorReason): string {
    switch (reason.kind) {
      case 'unableToOpen': return `Unable to open the ZIP source at ${reason.path}.`
      case 'truncatedArchive': return 'The ZIP source ended unexpectedly.'
      case 'invalidEndRecord': return 'The ZIP source has no valid end-of-central-directory record.'
      case 'multiDiskArchiveUnsupported': return 'Multi-disk ZIP sources are not supported.'
      case 'zip64Unsupported': return 'ZIP64 sources are outside the supported archive size limits.'
      case 'tooManyEntries': return `The ZIP source contains ${reason.count} entries, exceeding the reader limit of ${reason.limit}.`
      case 'invalidCentralDirectory': return 'The ZIP central directory is invalid.'
      case 'invalidFileName': return 'The ZIP source contains a filename that cannot be decoded safely.'
      case 'encryptedEntry': return `The ZIP entry is encrypted and cannot be read: ${reason.path}.`
      case 'unsupportedCompression': return `The ZIP entry ${reason.path} uses unsupported compression method ${reason.method}.`
      case 'entryTooLarge': return `The ZIP entry ${reason.path} is ${reason.size} bytes, exceeding the reader limit of ${reason.limit} bytes.`
      case 'invalidLocalHeader': return `The ZIP entry has an invalid local header: ${reason.path}.`
      case 'decompressionFailed': return `The ZIP entry ${reason.path} could not be decompressed (zlib code ${reason.code}).`
      case 'invalidExpandedSize': return `The ZIP entry ${reason.path} expanded to ${reason.actual} bytes instead of ${reason.expected}.`
      case 'checksumMismatch': return `The ZIP entry checksum does not match: ${reason.path}.`
    }
  }
}

interface CentralDirectoryRecord {
  path: string
  flags: number
  method: number
  checksum: number
  compressedSize: number
  uncompressedSize: number
  externalAttributes: number
  localHeaderOffset: number
}

const uint16 = (data: Uint8Array, offset: number): number => data[offset] | (data[offset + 1] << 8)
const uint32 = (data: Uint8Array, offset: number): number => (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0

async function readExactly(handle: FileHandle, count: number, position: number): Promise<Uint8Array> {
  if (count < 0) throw new ZipArchiveReaderError({ kind: 'truncatedArchive' })
  if (count === 0) return new Uint8Array()
  const buffer = new Uint8Array(count)
  let offset = 0
  while (offset < count) {
    const { bytesRead } = await handle.read(buffer, offset, count - offset, position + offset)
    if (bytesRead === 0) throw new ZipArchiveReaderError({ kind: 'truncatedArchive' })
    offset += bytesRead
  }
  return buffer
}

/** Code page 437, the ZIP default for names without the UTF-8 flag, from 0x80. */
const codePage437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

function decodePath(data: Uint8Array, usesUTF8: boolean): string {
  const value = decodeUTF8(data)
  if (value !== undefined) return value
  if (usesUTF8) throw new ZipArchiveReaderError({ kind: 'invalidFileName' })
  return Array.from(data, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : codePage437[byte - 0x80])).join('')
}

/**
 * Reads stored and deflated ZIP entries from the central directory, bounding the size of
 * each entry.
 */
export class ZipTranslationArchiveReader implements TranslationArchiveReading {
  private readonly maximumEntryCount: number
  private readonly maximumEntrySize: number

  constructor(maximumEntryCount = 10_000, maximumEntrySize = defaultMaximumEntrySize) {
    this.maximumEntryCount = Math.max(1, maximumEntryCount)
    this.maximumEntrySize = Math.max(0, maximumEntrySize)
  }

  async *entries(archivePath: string, signal?: AbortSignal): AsyncGenerator<TranslationArchiveEntry> {
    let handle: FileHandle
    try {
      handle = await open(archivePath, 'r')
    } catch {
      throw new ZipArchiveReaderError({ kind: 'unableToOpen', path: archivePath })
    }
    try {
      const records = await this.centralDirectory(handle)
      for (const record of records) {
        checkCancellation(signal)
        yield await this.readEntry(record, handle)
      }
    } finally {
      await handle.close()
    }
  }

  private async centralDirectory(handle: FileHandle): Promise<CentralDirectoryRecord[]> {
    const fileSize = (await handle.stat()).size
    if (fileSize < 22) throw new ZipArchiveReaderError({ kind: 'invalidEndRecord' })
    const tailSize = Math.min(fileSize, 65_557)
    const tailOffset = fileSize - tailSize
    const tail = await readExactly(handle, tailSize, tailOffset)
    const endOffset = validEndRecordOffset(tail, tailOffset)
    if (endOffset === undefined) throw new ZipArchiveReaderError({ kind: 'invalidEndRecord' })
    const diskNumber = uint16(tail, endOffset + 4)
    const centralDisk = uint16(tail, endOffset + 6)
    const diskEntries = uint16(tail, endOffset + 8)
    const totalEntries = uint16(tail, endOffset + 10)
    const centralSize = uint32(tail, endOffset + 12)
    const centralOffset = uint32(tail, endOffset + 16)
    const commentLength = uint16(tail, endOffset + 20)
    if (endOffset + 22 + commentLength !== tail.length) throw new ZipArchiveReaderError({ kind: 'invalidEndRecord' })
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new ZipArchiveReaderError({ kind: 'multiDiskArchiveUnsupported' })
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new ZipArchiveReaderError({ kind: 'zip64Unsupported' })
    if (totalEntries > this.maximumEntryCount) throw new ZipArchiveReaderError({ kind: 'tooManyEntries', count: totalEntries, limit: this.maximumEntryCount })
    const centralEnd = centralOffset + centralSize
    if (centralEnd > fileSize) throw new ZipArchiveReaderError({ kind: 'invalidCentralDirectory' })

    let position = centralOffset
    const records: CentralDirectoryRecord[] = []
    for (let index = 0; index < totalEntries; index += 1) {
      const header = await readExactly(handle, 46, position)
      position += 46
      if (uint32(header, 0) !== 0x02014b50) throw new ZipArchiveReaderError({ kind: 'invalidCentralDirectory' })
      const flags = uint16(header, 8)
      const compressedSize = uint32(header, 20)
      const uncompressedSize = uint32(header, 24)
      const nameLength = uint16(header, 28)
      const extraLength = uint16(header, 30)
      const entryCommentLength = uint16(header, 32)
      const localHeaderOffset = uint32(header, 42)
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ZipArchiveReaderError({ kind: 'zip64Unsupported' })
      }
      if (uint16(header, 34) !== 0) throw new ZipArchiveReaderError({ kind: 'multiDiskArchiveUnsupported' })
      const nameData = await readExactly(handle, nameLength, position)
      position += nameLength + extraLength + entryCommentLength
      records.push({
        path: decodePath(nameData, (flags & 0x0800) !== 0),
        flags,
        method: uint16(header, 10),
        checksum: uint32(header, 16),
        compressedSize,
        uncompressedSize,
        externalAttributes: uint32(header, 38),
        localHeaderOffset
      })
    }
    if (position > centralEnd) throw new ZipArchiveReaderError({ kind: 'invalidCentralDirectory' })
    return records
  }

  private async readEntry(record: CentralDirectoryRecord, handle: FileHandle): Promise<TranslationArchiveEntry> {
    const { path } = record
    if (record.flags & 0x0001) throw new ZipArchiveReaderError({ kind: 'encryptedEntry', path })
    if (record.uncompressedSize > this.maximumEntrySize) {
      throw new ZipArchiveReaderError({ kind: 'entryTooLarge', path, size: record.uncompressedSize, limit: this.maximumEntrySize })
    }
    const compressedLimit = this.maximumEntrySize + 1_024 * 1_024
    if (record.compressedSize > compressedLimit) throw new ZipArchiveReaderError({ kind: 'entryTooLarge', path, size: record.compressedSize, limit: compressedLimit })

    const localHeader = await readExactly(handle, 30, record.localHeaderOffset)
    if (uint32(localHeader, 0) !== 0x04034b50) throw new ZipArchiveReaderError({ kind: 'invalidLocalHeader', path })
    const payloadOffset = record.localHeaderOffset + 30 + uint16(localHeader, 26) + uint16(localHeader, 28)

    let contents: Uint8Array
    if (record.method === 0) {
      if (record.compressedSize !== record.uncompressedSize) {
        throw new ZipArchiveReaderError({ kind: 'invalidExpandedSize', path, expected: record.uncompressedSize, actual: record.compressedSize })
      }
      contents = await readExactly(handle, record.compressedSize, payloadOffset)
    } else if (record.method === 8) {
      const compressed = await readExactly(handle, record.compressedSize, payloadOffset)
      try {
        contents = new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(1, this.maximumEntrySize) }))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipArchiveReaderError({ kind: 'entryTooLarge', path, size: this.maximumEntrySize + 1, limit: this.maximumEntrySize })
        }
        // A stream that ends before its final block is reported as a data error.
        const code = (error as { errno?: number }).errno
        throw new ZipArchiveReaderError({ kind: 'decompressionFailed', path, code: code === undefined || code === -5 ? -3 : code })
      }
    } else {
      throw new ZipArchiveReaderError({ kind: 'unsupportedCompression', path, method: record.method })
    }
    if (contents.length !== record.uncompressedSize) {
      throw new ZipArchiveReaderError({ kind: 'invalidExpandedSize', path, expected: record.uncompressedSize, actual: contents.length })
    }
    if (crc32(contents) >>> 0 !== record.checksum) throw new ZipArchiveReaderError({ kind: 'checksumMismatch', path })

    const unixMode = (record.externalAttributes >>> 16) & 0o170000
    const kind: TranslationArchiveEntryKind = unixMode === 0o120000
      ? 'symbolicLink'
      : path.endsWith('/') || (record.externalAttributes & 0x10) !== 0 ? 'directory' : 'regularFile'
    return { path, kind, uncompressedSize: kind === 'regularFile' ? record.uncompressedSize : 0, contents: kind === 'directory' ? new Uint8Array() : contents }
  }
}

function validEndRecordOffset(data: Uint8Array, absoluteTailOffset: number): number | undefined {
  if (data.length < 22) return undefined
  for (let index = data.length - 22; index >= 0; index -= 1) {
    if (uint32(data, index) !== 0x06054b50) continue
    const commentLength = uint16(data, index + 20)
    const centralSize = uint32(data, index + 12)
    const centralOffset = uint32(data, index + 16)
    if (index + 22 + commentLength === data.length && centralOffset + centralSize === absoluteTailOffset + index) return index
  }
  return undefined
}

// MARK: Automatic

/** ZIP when the file starts with "PK", tar or gzip otherwise. */
export class AutomaticTranslationArchiveReader implements TranslationArchiveReading {
  private readonly tarGzip: TarGzipTranslationArchiveReader
  private readonly zip: ZipTranslationArchiveReader

  constructor(maximumEntryCount = 10_000, maximumEntrySize = defaultMaximumEntrySize) {
    this.tarGzip = new TarGzipTranslationArchiveReader(maximumEntrySize)
    this.zip = new ZipTranslationArchiveReader(maximumEntryCount, maximumEntrySize)
  }

  async *entries(archivePath: string, signal?: AbortSignal): AsyncGenerator<TranslationArchiveEntry> {
    let prefix: Uint8Array
    try {
      const handle = await open(archivePath, 'r')
      try {
        prefix = new Uint8Array(4)
        prefix = prefix.subarray(0, (await handle.read(prefix, 0, 4, 0)).bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      throw new ProjectPreparationError({ kind: 'archiveNotFound', path: archivePath })
    }
    if (prefix.length >= 2 && prefix[0] === 0x50 && prefix[1] === 0x4b) yield* this.zip.entries(archivePath, signal)
    else yield* this.tarGzip.entries(archivePath, signal)
  }
}
