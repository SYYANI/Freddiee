import type { PdfAnnotationRecord } from '../../../shared/types'
import { isAnnotationRecord } from '../annotations'
import type { TranslationSegment } from '../translationSegments'
import { SwiftDouble, type SwiftJSONValue } from './swiftJSON'
import type { DocumentValue } from './types'

// Native sync documents use dates in milliseconds where the stored forms differ: annotation
// sidecars keep ISO 8601 in whole seconds, like native Freddie's own sidecar.

const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function annotationToWire(record: PdfAnnotationRecord): DocumentValue {
  return {
    id: record.id.toUpperCase(),
    pageIndex: record.pageIndex,
    kind: record.kind,
    bounds: { x: record.bounds.x, y: record.bounds.y, width: record.bounds.width, height: record.bounds.height },
    color: { red: record.color.red, green: record.color.green, blue: record.color.blue, alpha: record.color.alpha },
    lineWidth: record.lineWidth,
    contents: record.contents,
    quote: record.quote,
    quadrilateralPoints: record.quadrilateralPoints.map(({ x, y }) => ({ x, y })),
    inkPaths: record.inkPaths.map((path) => path.map(({ x, y }) => ({ x, y }))),
    inkSamplePaths: record.inkSamplePaths?.map((path) => path.map(({ x, y, width }) => ({ x, y, width }))),
    createdAt: Date.parse(record.createdAt),
    modifiedAt: Date.parse(record.modifiedAt)
  }
}

/** The sidecar form of a received annotation, or undefined when it is not a valid record. */
export function annotationFromWire(value: unknown): PdfAnnotationRecord | undefined {
  const wire = value as Record<string, unknown> | undefined
  if (!wire || typeof wire !== 'object' || !Number.isSafeInteger(wire.createdAt) || !Number.isSafeInteger(wire.modifiedAt)) return undefined
  const record = { ...wire, createdAt: isoSeconds(wire.createdAt as number), modifiedAt: isoSeconds(wire.modifiedAt as number) } as unknown as PdfAnnotationRecord
  for (const key of ['contents', 'quote', 'inkSamplePaths'] as const) if (record[key] === undefined || record[key] === null) delete record[key]
  return isAnnotationRecord(record) ? record : undefined
}

/** Swift encodes every coordinate, color component and width as a `Double`. */
export function annotationSwiftValue(record: DocumentValue): SwiftJSONValue {
  const double = (value: unknown): SwiftDouble => new SwiftDouble(Number(value))
  const point = (value: { x: number; y: number }): SwiftJSONValue => ({ x: double(value.x), y: double(value.y) })
  const bounds = record.bounds as Record<string, number>
  const color = record.color as Record<string, number>
  return {
    ...(record as Record<string, SwiftJSONValue>),
    bounds: { x: double(bounds.x), y: double(bounds.y), width: double(bounds.width), height: double(bounds.height) },
    color: { red: double(color.red), green: double(color.green), blue: double(color.blue), alpha: double(color.alpha) },
    lineWidth: double(record.lineWidth),
    quadrilateralPoints: (record.quadrilateralPoints as Array<{ x: number; y: number }>).map(point),
    inkPaths: (record.inkPaths as Array<Array<{ x: number; y: number }>>).map((path) => path.map(point)),
    inkSamplePaths: (record.inkSamplePaths as Array<Array<{ x: number; y: number; width: number }>> | undefined)?.map((path) =>
      path.map((sample) => ({ x: double(sample.x), y: double(sample.y), width: double(sample.width) })))
  }
}

/** A cache segment with exactly native `LibrarySyncTranslation`'s fields. */
export function segmentToWire(segment: TranslationSegment): DocumentValue {
  return {
    id: segment.id.toUpperCase(),
    sourceType: segment.sourceType,
    targetLanguage: segment.targetLanguage,
    sourceHash: segment.sourceHash,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    modelName: segment.modelName,
    createdAt: segment.createdAt,
    modifiedAt: segment.modifiedAt,
    providerProfileID: segment.providerProfileID?.toUpperCase(),
    modelProfileID: segment.modelProfileID?.toUpperCase()
  }
}

export function segmentFromWire(value: DocumentValue): TranslationSegment {
  return {
    id: String(value.id),
    sourceType: String(value.sourceType),
    targetLanguage: String(value.targetLanguage),
    sourceHash: String(value.sourceHash),
    sourceText: String(value.sourceText),
    translatedText: String(value.translatedText),
    modelName: String(value.modelName),
    createdAt: Number(value.createdAt),
    modifiedAt: Number(value.modifiedAt),
    ...(typeof value.providerProfileID === 'string' ? { providerProfileID: value.providerProfileID } : {}),
    ...(typeof value.modelProfileID === 'string' ? { modelProfileID: value.modelProfileID } : {})
  }
}
