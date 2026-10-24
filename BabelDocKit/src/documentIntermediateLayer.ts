// The debug/observation layer over detection results, ported from Swift
// DocumentIntermediateLayer. It records what each stage produced for tooling;
// the translation pipeline itself reads the IL document.
import type { FloatBox, IntSize } from './geometry'
import type { DocumentPageInput } from './documentLoader'
import type { LayoutDetection } from './layoutDetector'

export interface LayoutClassCount { className: string; count: number }

export interface PageContentAvailability {
  hasRasterInput: boolean
  hasLayouts: boolean
  hasRawCharacters: boolean
  hasParagraphCandidates: boolean
}

export interface PageDebugMetadata {
  sourceKind: 'pdf' | 'image'
  rasterizedFromPDF: boolean
  contentAvailability: PageContentAvailability
  layoutClassCounts: LayoutClassCount[]
  notes: string[]
}

export interface PageInputSnapshot {
  rasterPixelSize: IntSize
  rasterImageBox: FloatBox
  pdfPointSize: IntSize | null
  pdfMediaBox: FloatBox | null
  pdfCropBox: FloatBox | null
  rotationDegrees: number | null
}

export interface IntermediatePage {
  pageIndex: number
  sourcePageNumber: number
  input: PageInputSnapshot
  rawCharacters: unknown[]
  layouts: LayoutDetection[]
  paragraphCandidates: unknown[]
  debug: PageDebugMetadata
}

export interface DocumentIntermediateLayer {
  sourceKind: 'pdf' | 'image'
  totalPages: number
  pages: IntermediatePage[]
}

export function buildDocumentIntermediateLayer(pages: DocumentPageInput[], layoutsPerPage: LayoutDetection[][]): DocumentIntermediateLayer {
  return {
    sourceKind: 'pdf',
    totalPages: pages.length,
    pages: pages.map((page, index) => {
      const layouts = layoutsPerPage[index] ?? []
      const counts = new Map<string, number>()
      for (const layout of layouts) counts.set(layout.className, (counts.get(layout.className) ?? 0) + 1)
      return {
        pageIndex: page.pageIndex,
        sourcePageNumber: page.sourcePageNumber,
        input: {
          rasterPixelSize: page.sourcePixelSize,
          rasterImageBox: {
            x0: 0, y0: 0,
            x1: Math.max(page.sourcePixelSize.width - 1, 0),
            y1: Math.max(page.sourcePixelSize.height - 1, 0)
          },
          pdfPointSize: page.pdfPointSize,
          pdfMediaBox: page.pdfMediaBox,
          pdfCropBox: page.pdfCropBox,
          rotationDegrees: page.rotationDegrees
        },
        rawCharacters: [],
        layouts,
        paragraphCandidates: [],
        debug: {
          sourceKind: 'pdf',
          rasterizedFromPDF: true,
          contentAvailability: {
            hasRasterInput: true,
            hasLayouts: layouts.length > 0,
            hasRawCharacters: false,
            hasParagraphCandidates: false
          },
          layoutClassCounts: [...counts.entries()]
            .sort(([lhs], [rhs]) => (lhs < rhs ? -1 : lhs > rhs ? 1 : 0))
            .map(([className, count]) => ({ className, count })),
          notes: [
            'pdf_text_objects_pending_stage_2',
            'raw_characters_placeholder_active',
            'paragraph_candidates_pending_stage_3'
          ]
        }
      }
    })
  }
}
