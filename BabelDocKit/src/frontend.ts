// Frontend extraction: PDF bytes in, BabelDocIL v1 document out. The wasm
// module runs the unchanged shim C frontend (characters, fonts, curves,
// figures, forms, annotations, base operations) and returns its JSON.
import type { ILDocument } from './il'
import { babelDocWasm, type BabelDocWasmModule } from './wasmModule'

export class BabelDocFrontendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocFrontendError'
  }
}

export interface FrontendExtraction {
  document: ILDocument
  /** The shim's raw JSON, kept for parity tooling. */
  json: string
}

/** 1-based `pages` select pages in the given order; empty selects all. */
export async function extractFrontend(
  pdf: Uint8Array,
  pages?: number[],
  wasm?: BabelDocWasmModule
): Promise<FrontendExtraction> {
  const module = wasm ?? await babelDocWasm()
  const json = module.extractFrontendILJSON(pdf, pages)
  try {
    return { document: JSON.parse(json) as ILDocument, json }
  } catch (error) {
    throw new BabelDocFrontendError(`MuPDF frontend extraction returned invalid JSON: ${String(error)}`)
  }
}
