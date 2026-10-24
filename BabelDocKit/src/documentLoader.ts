// Page inputs for layout detection, mirroring the Swift DocumentLoader for PDF
// sources: each selected page is rendered by MuPDF (crop box, /Rotate forced to
// 0, 72 dpi) and carries the PDF metadata the coordinate conversion needs.
// Swift reads media/crop boxes from Quartz; here they come from the frontend IL
// page boxes, which agree with Quartz on unrotated pages and keep the same
// absolute coordinates for rotation 0 (BabelDocPythonPageBoxes passes the crop
// box through and reports the media box normalized to the crop size).
import { babelDocWasm, type BabelDocWasmModule } from './wasmModule'
import { extractFrontend } from './frontend'
import { boxCoordinates, type ILDocument } from './il'
import type { FloatBox, IntSize } from './geometry'

export interface DocumentPageInput {
  pageIndex: number
  sourcePageNumber: number
  raster: { rgb: Uint8Array; size: IntSize }
  pdfPointSize: IntSize
  pdfMediaBox: FloatBox
  pdfCropBox: FloatBox
  rotationDegrees: number
  sourcePixelSize: IntSize
}

export interface LoadedDocumentInput {
  totalPages: number
  pages: DocumentPageInput[]
}

function pdfBoxFromIL(document: ILDocument, pageIndex: number, key: 'mediabox' | 'cropbox', fallbackSize: IntSize): FloatBox {
  const box = boxCoordinates(document.page?.[pageIndex]?.[key]?.box)
  if (box) return { x0: box.x, y0: box.y, x1: box.x2, y1: box.y2 }
  return { x0: 0, y0: 0, x1: fallbackSize.width, y1: fallbackSize.height }
}

/**
 * Loads the selected pages (1-based, in order; every page when empty). The
 * frontend IL for the selected pages supplies the page boxes; the media box
 * width/height rounded up is the `pdfPointSize` the conversion uses, exactly as
 * the Swift loader derives it from Quartz.
 */
export async function loadPDFPages(
  pdf: Uint8Array,
  selectedPage: number | null,
  wasm?: BabelDocWasmModule
): Promise<LoadedDocumentInput> {
  const module = wasm ?? await babelDocWasm()
  const selection = selectedPage === null || selectedPage === undefined ? null : [selectedPage]
  const frontend = await extractFrontend(pdf, selection ?? undefined, module)
  const totalPages = frontend.document.total_pages ?? frontend.document.page?.length ?? 0
  if (selection && (selection[0] < 1 || selection[0] > totalPages)) {
    throw new Error(`Selected page ${selection[0]} is out of range 1...${totalPages}.`)
  }

  const pages: DocumentPageInput[] = []
  const sourcePageNumbers = selection ?? Array.from({ length: totalPages }, (_, index) => index + 1)
  for (const [logicalIndex, sourcePageNumber] of sourcePageNumbers.entries()) {
    const raster = module.renderPDFPage(pdf, sourcePageNumber - 1, 72)
    const size: IntSize = { width: raster.width, height: raster.height }
    const mediaBox = pdfBoxFromIL(frontend.document, sourcePageNumber - 1, 'mediabox', size)
    const cropBox = pdfBoxFromIL(frontend.document, sourcePageNumber - 1, 'cropbox', size)
    pages.push({
      pageIndex: logicalIndex,
      sourcePageNumber,
      raster: { rgb: raster.rgb, size },
      pdfPointSize: {
        width: Math.ceil(Math.abs(mediaBox.x1 - mediaBox.x0)),
        height: Math.ceil(Math.abs(mediaBox.y1 - mediaBox.y0))
      },
      pdfMediaBox: mediaBox,
      pdfCropBox: cropBox,
      rotationDegrees: 0,
      sourcePixelSize: size
    })
  }
  return { totalPages, pages }
}
