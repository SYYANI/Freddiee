import type { PdfAnnotation, PdfAnnotationKind, PdfAnnotationRecord } from './types'

/**
 * Converts between stored annotations (native Freddie's records, in PDF page space) and the
 * reader's normalized coordinates. The page transform comes from PDF.js's viewport at scale
 * 1, which accounts for the crop box and page rotation.
 */
export interface PageGeometry {
  /** PDF page point → normalized point (0...1, origin top-left of the displayed page). */
  toNormalized(x: number, y: number): [number, number]
  /** Normalized point → PDF page point. */
  toPDF(x: number, y: number): [number, number]
}

/** Native Freddie's preset alphas by kind. */
const alphaByKind: Record<PdfAnnotationKind, number> = { highlight: 0.36, underline: 0.92, strikeOut: 0.92, ink: 1, text: 0.92 }
/** Native Freddie's text note icon, in points. */
const noteIconSize = 24

type Rect = { x: number; y: number; width: number; height: number }

function normalizedRect(rect: Rect, geometry: PageGeometry): Rect {
  const [x1, y1] = geometry.toNormalized(rect.x, rect.y)
  const [x2, y2] = geometry.toNormalized(rect.x + rect.width, rect.y + rect.height)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

function pdfRect(rect: Rect, geometry: PageGeometry): Rect {
  const [x1, y1] = geometry.toPDF(rect.x, rect.y)
  const [x2, y2] = geometry.toPDF(rect.x + rect.width, rect.y + rect.height)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

const hex = (value: number): string => Math.round(Math.min(Math.max(value, 0), 1) * 255).toString(16).padStart(2, '0')

export function colorToHex(color: PdfAnnotationRecord['color']): string {
  return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`
}

export function hexToColor(value: string, kind: PdfAnnotationKind): PdfAnnotationRecord['color'] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(value) ?? ['', 'ff', 'c8', '14']
  const channel = (text: string): number => Math.round(parseInt(text, 16) / 255 * 1000) / 1000
  return { red: channel(match[1]), green: channel(match[2]), blue: channel(match[3]), alpha: alphaByKind[kind] }
}

/** Whole seconds, as native Freddie's ISO 8601 sidecar dates are. */
export function wholeSecondDate(date = new Date()): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function recordToAnnotation(record: PdfAnnotationRecord, attachmentId: string, geometry: PageGeometry): PdfAnnotation {
  const base = { id: record.id, attachmentId, pageIndex: record.pageIndex, type: record.kind, color: colorToHex(record.color), lineWidth: record.lineWidth, createdAt: record.createdAt, record }
  if (record.kind === 'ink') {
    const paths = record.inkPaths.length ? record.inkPaths : (record.inkSamplePaths ?? []).map((path) => path.map(({ x, y }) => ({ x, y })))
    return { ...base, paths: paths.map((path) => path.map((point) => {
      const [x, y] = geometry.toNormalized(point.x, point.y)
      return { x, y }
    })) }
  }
  if (record.kind === 'text') {
    // The reader anchors a note at its icon's top-left corner.
    const [x, y] = geometry.toNormalized(record.bounds.x, record.bounds.y + record.bounds.height)
    const size = normalizedRect(record.bounds, geometry)
    return { ...base, contents: record.contents, rects: [{ x, y, width: size.width, height: size.height }] }
  }
  return { ...base, contents: record.contents, rects: [normalizedRect(record.bounds, geometry)] }
}

/** The stored form; an annotation read from a record and left unchanged keeps it exactly. */
export function annotationToRecord(annotation: PdfAnnotation, geometry: PageGeometry, now = new Date()): PdfAnnotationRecord {
  if (annotation.record) return annotation.record
  const lineWidth = Math.max(0.5, annotation.lineWidth ?? 1)
  const date = wholeSecondDate(now)
  const record: PdfAnnotationRecord = {
    id: annotation.id.toUpperCase(),
    pageIndex: Math.max(0, annotation.pageIndex),
    kind: annotation.type,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    color: hexToColor(annotation.color, annotation.type),
    lineWidth,
    quadrilateralPoints: [],
    inkPaths: [],
    createdAt: date,
    modifiedAt: date
  }
  if (annotation.type === 'ink') {
    record.inkPaths = (annotation.paths ?? []).map((path) => path.map((point) => {
      const [x, y] = geometry.toPDF(point.x, point.y)
      return { x, y }
    }))
    const points = record.inkPaths.flat()
    if (points.length) {
      const minX = Math.min(...points.map((point) => point.x)) - lineWidth
      const minY = Math.min(...points.map((point) => point.y)) - lineWidth
      record.bounds = { x: minX, y: minY, width: Math.max(...points.map((point) => point.x)) + lineWidth - minX, height: Math.max(...points.map((point) => point.y)) + lineWidth - minY }
    }
  } else if (annotation.type === 'text') {
    const anchor = annotation.rects?.[0] ?? { x: 0, y: 0, width: 0, height: 0 }
    const [x, y] = geometry.toPDF(anchor.x, anchor.y)
    record.bounds = { x, y: y - noteIconSize, width: noteIconSize, height: noteIconSize }
    if (annotation.contents) record.contents = annotation.contents
  } else {
    // Native Freddie stores one record per line; the reader creates them that way too.
    const rects = (annotation.rects ?? []).map((rect) => pdfRect(rect, geometry))
    if (rects.length) {
      const minX = Math.min(...rects.map((rect) => rect.x))
      const minY = Math.min(...rects.map((rect) => rect.y))
      record.bounds = { x: minX, y: minY, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - minX, height: Math.max(...rects.map((rect) => rect.y + rect.height)) - minY }
    }
    if (annotation.contents) record.contents = annotation.contents
  }
  return record
}

/** An unrotated page with the given crop box, for tests and pages PDF.js has not measured. */
export function boxGeometry(box: [number, number, number, number]): PageGeometry {
  const [x0, y0, x1, y1] = box
  const width = x1 - x0
  const height = y1 - y0
  return {
    toNormalized: (x, y) => [(x - x0) / width, (y1 - y) / height],
    toPDF: (x, y) => [x0 + x * width, y1 - y * height]
  }
}
