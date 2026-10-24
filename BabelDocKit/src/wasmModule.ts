// Wrapper around the committed BabelDoc wasm module (patched MuPDF + zstd +
// BabelDocMuPDFShim static path). The glue is CommonJS (`babeldoc.cjs`) because
// the app package is `"type": "module"`; the module bytes are read from the
// asar by the caller and handed to the factory as `wasmBinary`, so the module
// never touches the host filesystem itself — PDFs, fonts and output travel
// through MEMFS.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadBabelDocWasm } from './wasm'

export interface RenderedPage {
  rgb: Uint8Array
  width: number
  height: number
}

/** Mirrors the shim's BabelDocSourcePageReport fields. */
export interface SourcePageReport {
  status: number
  fallbackReason: number
  glyphCount: number
  anchorCount: number
  requiredAnchorCount: number
  unmatchedRequiredAnchorCount: number
  unmatchedPlacementAnchorCount: number
  removedGlyphCount: number
  placedGlyphCount: number
  adoptedGlyphCount: number
  removedGraphicCount: number
  placedGraphicCount: number
  layerCount: number
  misplacedGlyphCount: number
}

export interface SourcePlanBuffers {
  /** 8 per anchor: x, y, y2, orientation, unicode (-1 none), role, placement, optional. */
  anchors: Float64Array
  /** 7 per placement: a, b, c, d, e, f, firstRect. */
  placements: Float64Array
  /** 5 per rect: x, y, x2, y2, isGraphic. */
  rects: Float64Array
  /** 4 per region. */
  removedRegions: Float64Array
  removedTextRegions: Float64Array
  underlay: Uint8Array
  overlay: Uint8Array
}

export interface BabelDocWasmModule {
  /** Raw frontend IL v1 JSON, exactly the bytes the shim C produced. */
  extractFrontendILJSON(pdf: Uint8Array, pages?: number[]): string
  /** Renders one page at `dpi` (72 = 1 px per point) as top-left-origin RGB. */
  renderPDFPage(pdf: Uint8Array, pageIndex: number, dpi?: number): RenderedPage
  /** Opens a font from bytes; returns its handle for glyph/advance queries. */
  fontOpen(bytes: Uint8Array, name: string): number
  /** Glyph id for a unicode code point, or -1 when the font has no glyph. */
  fontGlyph(font: number, unicode: number): number
  /** Unhinted glyph advance in points at `size` (double precision). */
  fontAdvance(font: number, glyph: number, size: number): number
  /** The shim's resource-name to runtime-font-name matcher. */
  fontNamesMatch(resourceName: string, runtimeName: string): boolean
  /** Drops every opened font (the module outlives them across documents). */
  fontReset(): void
  /** Decodes zstd+base85 XObject base operations to the raw content text. */
  decodeBaseOperations(encoded: string): string
  writerOpen(pdf: Uint8Array): number
  writerAddCIDFont(writer: number, pageIndex: number, ownerXref: number, resourceName: string, fontName: string): void
  writerSetPageContent(writer: number, pageIndex: number, content: Uint8Array): void
  writerSetObjectContent(writer: number, objectXref: number, content: Uint8Array): void
  writerKeepPages(writer: number, pageIndices: number[]): void
  writerSave(writer: number): Uint8Array
  writerApplySourcePreservingPage(writer: number, pageIndex: number, plan: SourcePlanBuffers, maximumUnmatchedFraction: number): SourcePageReport
  writerClose(writer: number): void
  dispose(): void
}

interface EmscriptenModule {
  _malloc(size: number): number
  _free(pointer: number): void
  _babeldoc_wasm_extract_frontend_il(
    pdf: number, pdfLength: number, pages: number, pageCount: number,
    outJson: number, outError: number
  ): number
  _babeldoc_wasm_render_page(
    pdf: number, pdfLength: number, pageIndex: number, dpi: number,
    outPixels: number, outWidth: number, outHeight: number, outComponents: number, outError: number
  ): number
  _babeldoc_wasm_font_open(font: number, fontLength: number, name: number, outError: number): number
  _babeldoc_wasm_font_glyph(font: number, unicode: number): number
  _babeldoc_wasm_font_advance(font: number, glyph: number, size: number): number
  _babeldoc_wasm_font_advance_exact(font: number, glyph: number, size: number): number
  _babeldoc_wasm_font_names_match(resource: number, runtime: number): number
  _babeldoc_wasm_font_reset(): void
  _babeldoc_wasm_decode_base_operations(encoded: number, outText: number, outError: number): number
  _babeldoc_wasm_writer_open(pdf: number, pdfLength: number, outWriter: number, outError: number): number
  _babeldoc_wasm_writer_add_cid_font(
    writer: number, pageIndex: number, ownerXref: number, resource: number, fontName: number, outError: number
  ): number
  _babeldoc_wasm_writer_set_page_content(writer: number, pageIndex: number, content: number, length: number, outError: number): number
  _babeldoc_wasm_writer_set_object_content(writer: number, xref: number, content: number, length: number, outError: number): number
  _babeldoc_wasm_writer_keep_pages(writer: number, pages: number, count: number, outError: number): number
  _babeldoc_wasm_writer_save(writer: number, outBytes: number, outLength: number, outError: number): number
  _babeldoc_wasm_writer_close(writer: number): void
  _babeldoc_wasm_writer_apply_source_preserving_page(
    writer: number, pageIndex: number,
    anchors: number, anchorCount: number,
    placements: number, placementCount: number,
    rects: number, rectCount: number,
    removedRegions: number, removedRegionCount: number,
    removedTextRegions: number, removedTextRegionCount: number,
    underlay: number, underlayLength: number,
    overlay: number, overlayLength: number,
    maximumUnmatchedFraction: number,
    outReport: number, outError: number
  ): number
  _babeldoc_wasm_free(pointer: number): void
  HEAPU8: Uint8Array
  getValue(pointer: number, type: 'i32' | '*'): number
  setValue(pointer: number, value: number, type: 'i32'): void
  UTF8ToString(pointer: number): string
  stringToUTF8(value: string, pointer: number, length: number): number
  lengthBytesUTF8(value: string): number
}

let cached: Promise<BabelDocWasmModule> | null = null

/** Loads the wasm module once per process (per worker when run in one). */
export function babelDocWasm(): Promise<BabelDocWasmModule> {
  cached ??= createModule()
  return cached
}

async function createModule(): Promise<BabelDocWasmModule> {
  const bundle = loadBabelDocWasm()
  const require = createRequire(import.meta.url)
  const gluePath = fileURLToPath(new URL(`file:${join(bundle.directory, 'babeldoc.cjs')}`))
  const factory = require(gluePath) as (options: Record<string, unknown>) => Promise<EmscriptenModule>
  const Module = await factory({ wasmBinary: bundle.wasm })

  const fail = (where: string, pointer: number): never => {
    throw new Error(`${where}: ${pointer ? Module.UTF8ToString(pointer) : 'unknown MuPDF failure'}`)
  }

  const withBytes = <T>(bytes: Uint8Array, body: (pointer: number, length: number) => T): T => {
    const pointer = Module._malloc(bytes.length)
    Module.HEAPU8.set(bytes, pointer)
    try {
      return body(pointer, bytes.length)
    } finally {
      Module._free(pointer)
    }
  }

  const withString = <T>(value: string, body: (pointer: number) => T): T => {
    const pointer = Module._malloc(Module.lengthBytesUTF8(value) + 1)
    Module.stringToUTF8(value, pointer, Module.lengthBytesUTF8(value) + 1)
    try {
      return body(pointer)
    } finally {
      Module._free(pointer)
    }
  }

  const writerCall = (writer: number, run: (outError: number) => number): void => {
    const outError = Module._malloc(4)
    try {
      const status = run(outError)
      if (status !== 0) fail('MuPDF writer', Module.getValue(outError, '*'))
    } finally {
      Module._free(outError)
    }
  }

  const module: BabelDocWasmModule = {
    extractFrontendILJSON(pdf, pages) {
      const indices = (pages ?? []).map((page) => (page >= 1 ? page - 1 : page))
      return withBytes(pdf, (pdfPointer, pdfLength) => {
        const pagesPointer = indices.length > 0 ? Module._malloc(indices.length * 4) : 0
        const outJson = Module._malloc(4)
        const outError = Module._malloc(4)
        try {
          indices.forEach((page, offset) => Module.setValue(pagesPointer + offset * 4, page, 'i32'))
          const status = Module._babeldoc_wasm_extract_frontend_il(
            pdfPointer, pdfLength, pagesPointer, indices.length, outJson, outError
          )
          if (status !== 0) fail('MuPDF frontend extraction', Module.getValue(outError, '*'))
          const jsonPointer = Module.getValue(outJson, '*')
          if (jsonPointer === 0) throw new Error('MuPDF frontend extraction returned no JSON.')
          const json = Module.UTF8ToString(jsonPointer)
          Module._babeldoc_wasm_free(jsonPointer)
          return json
        } finally {
          if (pagesPointer !== 0) Module._free(pagesPointer)
          Module._free(outJson)
          Module._free(outError)
        }
      })
    },

    renderPDFPage(pdf, pageIndex, dpi = 72) {
      return withBytes(pdf, (pdfPointer, pdfLength) => {
        const outPixels = Module._malloc(4)
        const outWidth = Module._malloc(4)
        const outHeight = Module._malloc(4)
        const outComponents = Module._malloc(4)
        const outError = Module._malloc(4)
        let pixels = 0
        try {
          const status = Module._babeldoc_wasm_render_page(
            pdfPointer, pdfLength, pageIndex, dpi,
            outPixels, outWidth, outHeight, outComponents, outError
          )
          if (status !== 0) fail('MuPDF page rendering', Module.getValue(outError, '*'))
          pixels = Module.getValue(outPixels, '*')
          const width = Module.getValue(outWidth, 'i32')
          const height = Module.getValue(outHeight, 'i32')
          const components = Module.getValue(outComponents, 'i32')
          if (pixels === 0 || width <= 0 || height <= 0 || components <= 0) {
            throw new Error('MuPDF returned an invalid page image.')
          }
          const rgb = Module.HEAPU8.slice(pixels, pixels + width * height * components)
          return { rgb, width, height }
        } finally {
          if (pixels !== 0) Module._babeldoc_wasm_free(pixels)
          Module._free(outPixels)
          Module._free(outWidth)
          Module._free(outHeight)
          Module._free(outComponents)
          Module._free(outError)
        }
      })
    },

    fontOpen(bytes, name) {
      return withBytes(bytes, (fontPointer, fontLength) =>
        withString(name, (namePointer) => {
          const outError = Module._malloc(4)
          try {
            const handle = Module._babeldoc_wasm_font_open(fontPointer, fontLength, namePointer, outError)
            if (handle < 0) fail('MuPDF font open', Module.getValue(outError, '*'))
            return handle
          } finally {
            Module._free(outError)
          }
        }))
    },

    fontGlyph(font, unicode) {
      return Module._babeldoc_wasm_font_glyph(font, unicode)
    },

    fontAdvance(font, glyph, size) {
      return Module._babeldoc_wasm_font_advance_exact(font, glyph, size)
    },

    fontNamesMatch(resourceName, runtimeName) {
      return withString(resourceName, (resourcePointer) =>
        withString(runtimeName, (runtimePointer) =>
          Module._babeldoc_wasm_font_names_match(resourcePointer, runtimePointer) !== 0))
    },

    fontReset() {
      Module._babeldoc_wasm_font_reset()
    },

    decodeBaseOperations(encoded) {
      return withString(encoded, (encodedPointer) => {
        const outText = Module._malloc(4)
        const outError = Module._malloc(4)
        try {
          const status = Module._babeldoc_wasm_decode_base_operations(encodedPointer, outText, outError)
          if (status !== 0) fail('base operations decode', Module.getValue(outError, '*'))
          const textPointer = Module.getValue(outText, '*')
          if (textPointer === 0) throw new Error('base operations decode returned no text.')
          const text = Module.UTF8ToString(textPointer)
          Module._babeldoc_wasm_free(textPointer)
          return text
        } finally {
          Module._free(outText)
          Module._free(outError)
        }
      })
    },

    writerOpen(pdf) {
      return withBytes(pdf, (pdfPointer, pdfLength) => {
        const outWriter = Module._malloc(4)
        const outError = Module._malloc(4)
        try {
          const status = Module._babeldoc_wasm_writer_open(pdfPointer, pdfLength, outWriter, outError)
          if (status !== 0) fail('MuPDF writer open', Module.getValue(outError, '*'))
          const writer = Module.getValue(outWriter, '*')
          if (writer === 0) throw new Error('MuPDF writer returned no handle.')
          return writer
        } finally {
          Module._free(outWriter)
          Module._free(outError)
        }
      })
    },

    writerAddCIDFont(writer, pageIndex, ownerXref, resourceName, fontName) {
      withString(resourceName, (resourcePointer) =>
        withString(fontName, (fontPointer) =>
          writerCall(writer, (outError) =>
            Module._babeldoc_wasm_writer_add_cid_font(
              writer, pageIndex, ownerXref, resourcePointer, fontPointer, outError
            ))))
    },

    writerSetPageContent(writer, pageIndex, content) {
      withBytes(content, (pointer, length) =>
        writerCall(writer, (outError) =>
          Module._babeldoc_wasm_writer_set_page_content(writer, pageIndex, pointer, length, outError)))
    },

    writerSetObjectContent(writer, objectXref, content) {
      withBytes(content, (pointer, length) =>
        writerCall(writer, (outError) =>
          Module._babeldoc_wasm_writer_set_object_content(writer, objectXref, pointer, length, outError)))
    },

    writerKeepPages(writer, pageIndices) {
      if (pageIndices.length === 0) return
      const pointer = Module._malloc(pageIndices.length * 4)
      try {
        pageIndices.forEach((page, offset) => Module.setValue(pointer + offset * 4, page, 'i32'))
        writerCall(writer, (outError) =>
          Module._babeldoc_wasm_writer_keep_pages(writer, pointer, pageIndices.length, outError))
      } finally {
        Module._free(pointer)
      }
    },

    writerSave(writer) {
      const outBytes = Module._malloc(4)
      const outLength = Module._malloc(4)
      const outError = Module._malloc(4)
      let bytes = 0
      try {
        const status = Module._babeldoc_wasm_writer_save(writer, outBytes, outLength, outError)
        if (status !== 0) fail('MuPDF writer save', Module.getValue(outError, '*'))
        bytes = Module.getValue(outBytes, '*')
        const length = Module.getValue(outLength, 'i32')
        if (bytes === 0 || length <= 0) throw new Error('MuPDF writer save returned no bytes.')
        return Module.HEAPU8.slice(bytes, bytes + length)
      } finally {
        if (bytes !== 0) Module._babeldoc_wasm_free(bytes)
        Module._free(outBytes)
        Module._free(outLength)
        Module._free(outError)
      }
    },

    writerApplySourcePreservingPage(writer, pageIndex, plan, maximumUnmatchedFraction) {
      const anchors = new Uint8Array(plan.anchors.buffer, plan.anchors.byteOffset, plan.anchors.byteLength)
      const placements = new Uint8Array(plan.placements.buffer, plan.placements.byteOffset, plan.placements.byteLength)
      const rects = new Uint8Array(plan.rects.buffer, plan.rects.byteOffset, plan.rects.byteLength)
      const removedRegions = new Uint8Array(plan.removedRegions.buffer, plan.removedRegions.byteOffset, plan.removedRegions.byteLength)
      const removedTextRegions = new Uint8Array(plan.removedTextRegions.buffer, plan.removedTextRegions.byteOffset, plan.removedTextRegions.byteLength)
      return withBytes(anchors, (anchorPointer) =>
        withBytes(placements, (placementPointer) =>
          withBytes(rects, (rectPointer) =>
            withBytes(removedRegions, (removedPointer) =>
              withBytes(removedTextRegions, (removedTextPointer) =>
                withBytes(plan.underlay, (underlayPointer, underlayLength) =>
                  withBytes(plan.overlay, (overlayPointer, overlayLength) => {
                    const outReport = Module._malloc(4 * 14)
                    const outError = Module._malloc(4)
                    try {
                      const status = Module._babeldoc_wasm_writer_apply_source_preserving_page(
                        writer, pageIndex,
                        anchorPointer, plan.anchors.length / 8,
                        placementPointer, plan.placements.length / 7,
                        rectPointer, plan.rects.length / 5,
                        removedPointer, plan.removedRegions.length / 4,
                        removedTextPointer, plan.removedTextRegions.length / 4,
                        underlayPointer, underlayLength,
                        overlayPointer, overlayLength,
                        maximumUnmatchedFraction,
                        outReport, outError
                      )
                      if (status !== 0) fail('MuPDF source-preserving filter', Module.getValue(outError, '*'))
                      const values = Array.from({ length: 14 }, (_, index) => Module.getValue(outReport + index * 4, 'i32'))
                      return {
                        status: values[0],
                        fallbackReason: values[1],
                        glyphCount: values[2],
                        anchorCount: values[3],
                        requiredAnchorCount: values[4],
                        unmatchedRequiredAnchorCount: values[5],
                        unmatchedPlacementAnchorCount: values[6],
                        removedGlyphCount: values[7],
                        placedGlyphCount: values[8],
                        adoptedGlyphCount: values[9],
                        removedGraphicCount: values[10],
                        placedGraphicCount: values[11],
                        layerCount: values[12],
                        misplacedGlyphCount: values[13]
                      }
                    } finally {
                      Module._free(outReport)
                      Module._free(outError)
                    }
                  }))))))) as SourcePageReport
    },

    writerClose(writer) {
      Module._babeldoc_wasm_writer_close(writer)
    },

    dispose() {
      cached = null
    }
  }
  return module
}
