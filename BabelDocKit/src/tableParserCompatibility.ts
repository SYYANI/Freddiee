// Compatibility boundary for the retired legacy table-parser stage. The
// pipeline always runs disabled; the legacy mode only adapts already-produced
// detections and never runs model inference itself.
import type { IntSize } from './geometry'
import type { LayoutDetection } from './layoutDetector'
import { makePageLayouts } from './layoutParser'
import type { ILDocument } from './il'

export type TableParserMode = 'disabled' | 'legacyLayoutExtension'

export interface TableParserPageDetections {
  /** IL page numbers are zero based. */
  pageNumber: number
  rasterSize: IntSize
  detections: LayoutDetection[]
}

export const TableParserCompatibility = {
  process(document: ILDocument, mode: TableParserMode = 'disabled', pageDetections: TableParserPageDetections[] = []): void {
    if (mode !== 'legacyLayoutExtension') return
    const detectionsByPage = new Map(pageDetections.map((result) => [result.pageNumber, result]))
    for (const page of document.page ?? []) {
      const hasTable = (page.page_layout ?? []).some((layout) => layout.class_name === 'table')
      if (!hasTable || page.page_number === undefined) continue
      const result = detectionsByPage.get(page.page_number)
      if (!result) continue
      // The legacy stage numbers only the newly detected layouts from one,
      // then appends them even when IDs overlap existing layouts.
      const layouts = makePageLayouts(
        result.detections, result.rasterSize.width, result.rasterSize.height
      )
      page.page_layout = [...(page.page_layout ?? []), ...layouts]
    }
  }
}
