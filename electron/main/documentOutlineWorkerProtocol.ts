import type { DocumentOutlineCache, DocumentOutlineSource } from '../../shared/outline'

export interface OutlineSemanticHeading {
  id: string
  kind: string
  alignmentText: string
  headingLevel?: number | null
  sectionPath?: Array<{ level: number }>
}

/** The worker receives document data and bundled resources, never model routes or secrets. */
export interface DocumentOutlineWorkerInput {
  pdf: Uint8Array
  candidatesOnly: boolean
  generateAutomatic: boolean
  semanticHeadings: OutlineSemanticHeading[]
  scanSources: Array<{ pageIndex: number; source: string }>
}

export interface DocumentOutlineWorkerData extends DocumentOutlineWorkerInput {
  pdfjsModuleURL: string
  standardFontDataURL: string
  cMapURL: string
  wasmURL: string
}

export interface DocumentOutlineWorkerResult {
  variants: DocumentOutlineCache['variants']
  candidates: DocumentOutlineCache['candidates']
  deferredCandidates: boolean
  preferredSource?: DocumentOutlineSource
}

export type DocumentOutlineWorkerEvent =
  | { type: 'result'; result: DocumentOutlineWorkerResult }
  | { type: 'error'; message: string }
