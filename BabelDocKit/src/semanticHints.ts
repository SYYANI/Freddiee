// Semantic hint document types and validation, ported from Swift SemanticHints.
// The wire format is the JSON the LaTeXTransKit sidecar produces.
export const semanticHintsSchemaVersion = 1

export type BabelDocSemanticBlockKind =
  | 'documentTitle' | 'sectionHeading' | 'paragraph' | 'abstract' | 'figure' | 'table'
  | 'figureCaption' | 'tableCaption' | 'caption' | 'listItem' | 'footnote' | 'reference'
  | 'theorem' | 'proof' | 'algorithm' | 'code' | 'equation' | 'tableCell' | 'keywords' | 'other'

export type BabelDocSemanticContainerKind =
  | 'figure' | 'table' | 'list' | 'bibliography' | 'theorem' | 'proof' | 'algorithm'
  | 'code' | 'equation' | 'other'

export interface BabelDocSemanticSectionPathEntry {
  level: number
  title: string
}

export type BabelDocSemanticAtomKind = 'math' | 'citation' | 'reference' | 'url' | 'code'

export interface BabelDocSemanticAtom {
  id: string
  kind: BabelDocSemanticAtomKind
  token: string
  rawSource: string
  visibleText?: string | null
}

export interface BabelDocSemanticBlock {
  id: string
  ordinal: number
  kind: BabelDocSemanticBlockKind
  alignmentText: string
  translationTemplate: string
  rawSource: string
  sectionPath: BabelDocSemanticSectionPathEntry[]
  headingLevel?: number | null
  environment?: string | null
  containerKind?: BabelDocSemanticContainerKind | null
  parentID?: string | null
  atoms: BabelDocSemanticAtom[]
}

export interface BabelDocSemanticDocument {
  schemaVersion: number
  sourceIdentifier: string
  blocks: BabelDocSemanticBlock[]
}

export function isSemanticBlockAlignable(block: BabelDocSemanticBlock): boolean {
  if (block.kind === 'figure' || block.kind === 'table' || block.kind === 'equation') return false
  return block.alignmentText.trim().length > 0
}

export class SemanticHintValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemanticHintValidationError'
  }
}

export function validateSemanticDocument(document: BabelDocSemanticDocument): void {
  if (document.schemaVersion !== semanticHintsSchemaVersion) {
    throw new SemanticHintValidationError(`Unsupported semantic hint schema version: ${document.schemaVersion}.`)
  }
  if (document.sourceIdentifier.trim().length === 0) {
    throw new SemanticHintValidationError('Semantic hints have an empty source identifier.')
  }
  const blockIDs = document.blocks.map((block) => block.id)
  if (new Set(blockIDs).size !== blockIDs.length) {
    throw new SemanticHintValidationError('Semantic hints contain duplicate block identifiers.')
  }
  const knownBlockIDs = new Set(blockIDs)
  const atomIDs = new Set<string>()
  const atomTokens = new Set<string>()
  let lastOrdinal: number | undefined
  for (const block of document.blocks) {
    const valid = block.ordinal >= 0 && (lastOrdinal === undefined || block.ordinal > lastOrdinal)
    if (!valid) {
      throw new SemanticHintValidationError('Semantic hint block ordinals are not strictly increasing.')
    }
    lastOrdinal = block.ordinal
    if (block.parentID !== undefined && block.parentID !== null && !knownBlockIDs.has(block.parentID)) {
      throw new SemanticHintValidationError(`Semantic hint block references an unknown parent: ${block.parentID}.`)
    }
    for (const atom of block.atoms) {
      if (atomIDs.has(atom.id)) {
        throw new SemanticHintValidationError(`Semantic hints contain duplicate atom identifier: ${atom.id}.`)
      }
      atomIDs.add(atom.id)
      if (atomTokens.has(atom.token)) {
        throw new SemanticHintValidationError(`Semantic hints contain duplicate atom token: ${atom.token}.`)
      }
      atomTokens.add(atom.token)
      if (block.translationTemplate.split(atom.token).length !== 2) {
        throw new SemanticHintValidationError(`Semantic atom ${atom.id} does not occur exactly once in block ${block.id}.`)
      }
    }
  }
}

export interface SemanticPDFParagraph {
  id: string
  pageIndex: number
  paragraphIndex: number
  text: string
  layoutLabel?: string | null
}

export type SemanticMatchConfidence = 'rejected' | 'low' | 'medium' | 'high'

export interface SemanticAlignmentMatch {
  sourceRange: { start: number; end: number }
  pdfRange: { start: number; end: number }
  score: number
  confidence: SemanticMatchConfidence
}

export interface SemanticAlignmentResult {
  sourceBlockIDs: string[]
  pdfParagraphIDs: string[]
  matches: SemanticAlignmentMatch[]
  unmatchedSourceBlockIDs: string[]
  unmatchedPDFParagraphIDs: string[]
}

export interface SemanticParagraphAddress {
  pageIndex: number
  paragraphIndex: number
}

export function semanticAddressKey(address: SemanticParagraphAddress): string {
  return `${address.pageIndex}:${address.paragraphIndex}`
}

export interface SemanticParagraphContext {
  sourceBlockIDs: string[]
  role: BabelDocSemanticBlockKind
  environment?: string | null
  sectionPath: BabelDocSemanticSectionPathEntry[]
  previousSourceParagraph?: string | null
  nextSourceParagraph?: string | null
  completeSourceText: string
  translationTemplate?: string | null
  atoms: BabelDocSemanticAtom[]
  matchConfidence: SemanticMatchConfidence
  continuationGroupID?: string | null
  fragmentIndex: number
  fragmentCount: number
  associatedLayoutID?: number | null
}
