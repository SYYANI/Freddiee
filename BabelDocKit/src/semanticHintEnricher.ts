// Conservative application of LaTeX semantics to the document IL, ported from
// Swift SemanticHintEnricher: quality gate, reading-order repair, same-column
// paragraph merge, source-anchored splits, label correction and per-paragraph
// translation contexts.
import {
  boxCoordinates, pythonBool,
  type ILBox, type ILDocument, type ILPage, type ILPdfParagraphComposition, type ILPdfCharacter,
  type ILPdfParagraph
} from './il'
import {
  semanticAddressKey, validateSemanticDocument,
  type BabelDocSemanticAtom, type BabelDocSemanticBlock, type BabelDocSemanticBlockKind,
  type BabelDocSemanticDocument, type SemanticAlignmentMatch, type SemanticAlignmentResult,
  type SemanticMatchConfidence, type SemanticParagraphAddress, type SemanticParagraphContext,
  type SemanticPDFParagraph
} from './semanticHints'
import {
  SemanticHintMatcher, alignPreparedBlocks as alignPrepared, defaultMatcherConfiguration,
  type PreparedSource, type SemanticHintMatcherConfiguration, type SemanticIndependentMatch
} from './semanticHintMatcher'
import { TableOfContentsDotLeader } from './tableOfContentsDotLeader'
import { foundationTrim } from './unicode'

export type SemanticEnrichmentActionKind =
  | 'qualityGate' | 'readingOrder' | 'paragraphMerge' | 'paragraphSplit'
  | 'labelCorrection' | 'continuation' | 'floatingObjectAssociation' | 'tableCellAssociation'

export interface SemanticEnrichmentDiagnostic {
  kind: SemanticEnrichmentActionKind
  accepted: boolean
  sourceBlockIDs: string[]
  pdfParagraphIDs: string[]
  reason: string
}

export interface SemanticEnrichmentReport {
  alignment: SemanticAlignmentResult
  diagnostics: SemanticEnrichmentDiagnostic[]
  pdfParagraphCount: number
  matchedPDFParagraphCount: number
  flowPDFParagraphCount: number
  matchedFlowPDFParagraphCount: number
  matchedPDFCoverage: number
  highConfidenceMatchCount: number
  mediumConfidenceMatchCount: number
  lowConfidenceMatchCount: number
  structuralChangesEnabled: boolean
  elapsedMilliseconds: number
}

export interface SemanticEnrichmentResult {
  paragraphContexts: Map<string, SemanticParagraphContext>
  report: SemanticEnrichmentReport
}

export interface SemanticHintEnricherConfiguration {
  matcher: SemanticHintMatcherConfiguration
  minimumStructuralConfidence: SemanticMatchConfidence
  maximumMergeVerticalGap: number
  minimumColumnOverlap: number
  minimumPDFCoverageForStructuralChanges: number
  minimumHighConfidenceMatchesForStructuralChanges: number
  minimumContextConfidence: SemanticMatchConfidence
}

export const defaultEnricherConfiguration: SemanticHintEnricherConfiguration = {
  matcher: defaultMatcherConfiguration,
  minimumStructuralConfidence: 'high',
  maximumMergeVerticalGap: 36,
  minimumColumnOverlap: 0.42,
  minimumPDFCoverageForStructuralChanges: 0.35,
  minimumHighConfidenceMatchesForStructuralChanges: 1,
  minimumContextConfidence: 'medium'
}

interface Location {
  page: number
  paragraph: number
}

export const SemanticHintEnricher = {
  process(
    document: ILDocument,
    hints: BabelDocSemanticDocument,
    configuration: SemanticHintEnricherConfiguration = defaultEnricherConfiguration
  ): SemanticEnrichmentResult {
    const startedAt = performance.now()
    validateSemanticDocument(hints)
    assignStableParagraphIDs(document)
    let diagnostics: SemanticEnrichmentDiagnostic[] = []
    let descriptors = makeDescriptors(document)
    const preparedSource = SemanticHintMatcher.prepare(hints, configuration.matcher)
    let alignment = alignPrepared(preparedSource, descriptors, configuration.matcher)
    const initialMetrics = metrics(alignment, descriptors)
    const independentMatches = SemanticHintMatcher.independentHighConfidenceMatches(preparedSource, descriptors, configuration.matcher)
    const independentCoverage = initialMetrics.flowPDF === 0
      ? 0
      : new Set(independentMatches.map((match) => match.pdfIndex)).size / initialMetrics.flowPDF
    const evidenceCoverage = Math.max(initialMetrics.coverage, independentCoverage)
    const evidenceHighCount = Math.max(initialMetrics.high, independentMatches.length)
    const structuralChangesEnabled = evidenceCoverage >= configuration.minimumPDFCoverageForStructuralChanges
      && evidenceHighCount >= configuration.minimumHighConfidenceMatchesForStructuralChanges
    diagnostics.push({
      kind: 'qualityGate',
      accepted: structuralChangesEnabled,
      sourceBlockIDs: [],
      pdfParagraphIDs: [],
      reason: `Matched flow PDF coverage ${evidenceCoverage.toFixed(3)} with ${evidenceHighCount} high-confidence matches.`
    })

    let documentChanged = false
    if (structuralChangesEnabled
      && repairReadingOrder(document, preparedSource, independentMatches, (value) => { diagnostics = [...diagnostics, ...value] })) {
      documentChanged = true
      descriptors = makeDescriptors(document)
      alignment = alignPrepared(preparedSource, descriptors, configuration.matcher)
      documentChanged = false
    }

    const source = preparedSource.blocks
    let locations = makeLocationIndex(document)

    // Find each paragraph by its stable debug ID so prior edits cannot invalidate indexes.
    const structuralMatches = alignment.matches
      .filter((match) => structuralChangesEnabled
        && confidenceRank(match.confidence) >= confidenceRank(configuration.minimumStructuralConfidence))
      .reverse()
    for (const match of structuralMatches) {
      const sourceBlocks = rangeOf(match.sourceRange).map((at) => source[at])
      const paragraphIDs = rangeOf(match.pdfRange).map((at) => alignment.pdfParagraphIDs[at])
      if (sourceBlocks.length === 1 && paragraphIDs.length > 1) {
        if (mergeParagraphs(document, paragraphIDs, locations, configuration)) {
          documentChanged = true
          locations = makeLocationIndex(document)
          diagnostics.push({
            kind: 'paragraphMerge', accepted: true,
            sourceBlockIDs: sourceBlocks.map((block) => block.id), pdfParagraphIDs: paragraphIDs,
            reason: 'High-confidence fragments were on one page, in one xobject, and in the same column.'
          })
        } else {
          diagnostics.push({
            kind: 'continuation', accepted: true,
            sourceBlockIDs: sourceBlocks.map((block) => block.id), pdfParagraphIDs: paragraphIDs,
            reason: 'Fragments cross a page, column, xobject, or unsafe geometric gap; geometry was preserved.'
          })
        }
      } else if (sourceBlocks.length > 1 && paragraphIDs.length === 1) {
        const didSplit = splitParagraph(document, paragraphIDs[0], locations, sourceBlocks)
        if (didSplit) {
          documentChanged = true
          locations = makeLocationIndex(document)
        }
        diagnostics.push({
          kind: 'paragraphSplit', accepted: didSplit,
          sourceBlockIDs: sourceBlocks.map((block) => block.id), pdfParagraphIDs: paragraphIDs,
          reason: didSplit
            ? 'A stable character boundary was found without splitting a formula.'
            : 'No safe composition boundary was available; the paragraph remains intact.'
        })
      }
    }

    if (documentChanged) {
      descriptors = makeDescriptors(document)
      alignment = alignPrepared(preparedSource, descriptors, configuration.matcher)
    }
    const contexts = applySemanticsAndBuildContexts(
      document, preparedSource, descriptors, alignment,
      configuration.minimumContextConfidence, (value) => { diagnostics = [...diagnostics, ...value] }
    )
    const finalMetrics = metrics(alignment, descriptors)
    return {
      paragraphContexts: contexts,
      report: {
        alignment,
        diagnostics,
        pdfParagraphCount: descriptors.length,
        matchedPDFParagraphCount: finalMetrics.matchedPDF,
        flowPDFParagraphCount: finalMetrics.flowPDF,
        matchedFlowPDFParagraphCount: finalMetrics.matchedFlowPDF,
        matchedPDFCoverage: finalMetrics.coverage,
        highConfidenceMatchCount: finalMetrics.high,
        mediumConfidenceMatchCount: finalMetrics.medium,
        lowConfidenceMatchCount: finalMetrics.low,
        structuralChangesEnabled,
        elapsedMilliseconds: (performance.now() - startedAt)
      }
    }
  }
}

function rangeOf(span: { start: number; end: number }): number[] {
  const out: number[] = []
  for (let index = span.start; index < span.end; index += 1) out.push(index)
  return out
}

function assignStableParagraphIDs(document: ILDocument): void {
  const reservedIDs = new Set<string>()
  for (const page of document.page ?? []) {
    for (const paragraph of page.pdf_paragraph ?? []) {
      if (paragraph.debug_id !== undefined) reservedIDs.add(paragraph.debug_id)
    }
  }
  const usedIDs = new Set<string>()
  for (const [pageIndex, page] of (document.page ?? []).entries()) {
    for (let paragraphIndex = 0; paragraphIndex < (page.pdf_paragraph ?? []).length; paragraphIndex += 1) {
      const paragraph = page.pdf_paragraph?.[paragraphIndex]
      if (!paragraph) continue
      const existingID = paragraph.debug_id
      if (existingID && !usedIDs.has(existingID)) {
        usedIDs.add(existingID)
        continue
      }
      const baseID = `semantic-p${pageIndex}-${paragraphIndex}`
      let candidateID = baseID
      let suffix = 1
      while (reservedIDs.has(candidateID) || usedIDs.has(candidateID)) {
        candidateID = `${baseID}-${suffix}`
        suffix += 1
      }
      paragraph.debug_id = candidateID
      usedIDs.add(candidateID)
    }
  }
}

function makeDescriptors(document: ILDocument): SemanticPDFParagraph[] {
  const descriptors: SemanticPDFParagraph[] = []
  for (const [pageIndex, page] of (document.page ?? []).entries()) {
    for (const [paragraphIndex, paragraph] of (page.pdf_paragraph ?? []).entries()) {
      if (paragraph.layout_label?.toLowerCase() === 'isolate_formula') continue
      const text = foundationTrim(paragraph.unicode ?? '')
      if (text.length === 0) continue
      descriptors.push({
        id: paragraph.debug_id ?? `semantic-p${pageIndex}-${paragraphIndex}`,
        pageIndex,
        paragraphIndex,
        text,
        layoutLabel: paragraph.layout_label ?? null
      })
    }
  }
  return descriptors
}

function repairReadingOrder(
  document: ILDocument,
  preparedSource: PreparedSource,
  independentMatches: SemanticIndependentMatch[],
  appendDiagnostics: (values: SemanticEnrichmentDiagnostic[]) => void
): boolean {
  const descriptors = makeDescriptors(document)
  const sourceByID = new Map<string, number>()
  for (const match of independentMatches) {
    sourceByID.set(descriptors[match.pdfIndex].id, match.sourceIndex)
  }
  const alignableSource = preparedSource.blocks
  let changed = false
  for (const page of document.page ?? []) {
    const paragraphs = page.pdf_paragraph ?? []
    const matchedSlots = paragraphs
      .map((_, index) => index)
      .filter((index) => sourceByID.has(paragraphs[index].debug_id ?? ''))
    if (matchedSlots.length <= 1) continue
    const original = matchedSlots.map((index) => paragraphs[index])
    const reordered = [...original].sort((lhs, rhs) =>
      (sourceByID.get(lhs.debug_id ?? '') ?? Number.MAX_SAFE_INTEGER)
      - (sourceByID.get(rhs.debug_id ?? '') ?? Number.MAX_SAFE_INTEGER))
    if (original.map((paragraph) => paragraph.debug_id).join('|') === reordered.map((paragraph) => paragraph.debug_id).join('|')) continue
    matchedSlots.forEach((slot, offset) => {
      paragraphs[slot] = reordered[offset]
    })
    changed = true
    appendDiagnostics([{
      kind: 'readingOrder', accepted: true,
      sourceBlockIDs: reordered.map((paragraph) => {
        const at = sourceByID.get(paragraph.debug_id ?? '')
        return at === undefined ? null : alignableSource[at].id
      }).filter((id): id is string => id !== null),
      pdfParagraphIDs: reordered.map((paragraph) => paragraph.debug_id ?? '').filter((id) => id.length > 0),
      reason: 'Mutually unique high-confidence matches established source reading order.'
    }])
  }
  return changed
}

function mergeParagraphs(
  document: ILDocument,
  ids: string[],
  locations: Map<string, Location>,
  configuration: SemanticHintEnricherConfiguration
): boolean {
  const resolvedLocations = ids.map((id) => locations.get(id)).filter((location): location is Location => location !== undefined)
  if (resolvedLocations.length !== ids.length || new Set(resolvedLocations.map((location) => location.page)).size !== 1) return false
  const pageIndex = resolvedLocations[0].page
  const orderedLocations = [...resolvedLocations].sort((lhs, rhs) => lhs.paragraph - rhs.paragraph)
  const paragraphs = orderedLocations.map((location) => document.page?.[location.page]?.pdf_paragraph?.[location.paragraph]) as ILPdfParagraph[]
  if (paragraphs.some((paragraph) => paragraph === undefined)) return false
  if (new Set(paragraphs.map((paragraph) => paragraph.xobj_id)).size !== 1) return false
  if (!paragraphsAreInSameColumn(paragraphs, configuration.minimumColumnOverlap, configuration.maximumMergeVerticalGap)) return false
  // The union box must not cover content between the fragments.
  const mergedIndexes = new Set(orderedLocations.map((location) => location.paragraph))
  const unionBox = union(paragraphs.map((paragraph) => paragraph.box)) ?? undefined
  const unionCoordinates = unionBox ? boxCoordinates(unionBox) : null
  if (!unionCoordinates) return false
  const others = document.page?.[pageIndex]?.pdf_paragraph ?? []
  for (let index = 0; index < others.length; index += 1) {
    if (mergedIndexes.has(index)) continue
    const other = boxCoordinates(others[index].box)
    if (other && boxesOverlap(unionCoordinates, other)) return false
  }

  const merged: ILPdfParagraph = { ...paragraphs[0] }
  merged.unicode = paragraphs.map((paragraph) => paragraph.unicode).filter((unicode): unicode is string => unicode !== undefined).join(' ')
  merged.pdf_paragraph_composition = paragraphs.flatMap((paragraph, offset) => {
    const values = [...(paragraph.pdf_paragraph_composition ?? [])]
    if (offset > 0) {
      const style = paragraph.pdf_style ?? merged.pdf_style
      if (style) values.unshift({ pdf_same_style_unicode_characters: { pdf_style: style, unicode: ' ' } })
    }
    return values
  })
  merged.box = union(paragraphs.map((paragraph) => paragraph.box)) ?? undefined
  const renderOrders = paragraphs.map((paragraph) => paragraph.render_order).filter((order): order is number => order !== undefined)
  merged.render_order = renderOrders.length > 0 ? Math.min(...renderOrders) : undefined
  const page = document.page?.[pageIndex]
  if (!page) return false
  page.pdf_paragraph = page.pdf_paragraph ?? []
  page.pdf_paragraph[orderedLocations[0].paragraph] = merged
  for (const location of [...orderedLocations].slice(1).reverse()) {
    page.pdf_paragraph?.splice(location.paragraph, 1)
  }
  return true
}

function splitParagraph(
  document: ILDocument,
  id: string,
  locations: Map<string, Location>,
  sourceBlocks: BabelDocSemanticBlock[]
): boolean {
  const location = locations.get(id)
  if (sourceBlocks.length <= 1 || !location) return false
  const paragraph = document.page?.[location.page]?.pdf_paragraph?.[location.paragraph]
  if (!paragraph) return false
  const compositions = paragraph.pdf_paragraph_composition ?? []
  const weights = sourceBlocks.map((block) => Math.max([...block.alignmentText].length, 1))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const characterCount = compositionCharacterCount(compositions)
  if (characterCount < sourceBlocks.length * 4) return false

  const safeOffsets = safeSplitOffsets(compositions)
  if (safeOffsets.length < sourceBlocks.length - 1) return false
  const anchoredTargets = sourceAnchoredSplitOffsets(compositionText(compositions), sourceBlocks)
  const targets: number[] = []
  let cumulative = 0
  for (let boundaryIndex = 0; boundaryIndex < weights.length - 1; boundaryIndex += 1) {
    cumulative += weights[boundaryIndex]
    const proportional = Math.max(1, Math.min(characterCount - 1, Math.floor(characterCount * cumulative / totalWeight)))
    const preferred = anchoredTargets?.[boundaryIndex] ?? proportional
    const minimumAllowed = (targets[targets.length - 1] ?? 0) + 1
    const remainingGroupCount = sourceBlocks.length - targets.length - 1
    const maximumAllowed = characterCount - remainingGroupCount
    const eligibleOffsets = safeOffsets.filter((offset) => offset >= minimumAllowed && offset <= maximumAllowed)
    let snapped: number | undefined
    for (const offset of eligibleOffsets) {
      if (snapped === undefined
        || Math.abs(offset - preferred) < Math.abs(snapped - preferred)
        || (Math.abs(offset - preferred) === Math.abs(snapped - preferred) && offset < snapped)) {
        snapped = offset
      }
    }
    if (snapped === undefined) return false
    targets.push(snapped)
  }
  const groups = splitCompositions(compositions, targets)
  if (!groups || groups.length !== sourceBlocks.length) return false

  const splitParagraphs = groups.map((group, index): ILPdfParagraph => ({
    ...paragraph,
    debug_id: `${id}-split-${index}`,
    pdf_paragraph_composition: group,
    unicode: foundationTrim(compositionText(group)),
    box: compositionBox(group) ?? paragraph.box
  }))
  const page = document.page?.[location.page]
  if (!page) return false
  page.pdf_paragraph = page.pdf_paragraph ?? []
  page.pdf_paragraph.splice(location.paragraph, 1, ...splitParagraphs)
  return true
}

function applySemanticsAndBuildContexts(
  document: ILDocument,
  preparedSource: PreparedSource,
  descriptors: SemanticPDFParagraph[],
  alignment: SemanticAlignmentResult,
  minimumConfidence: SemanticMatchConfidence,
  appendDiagnostics: (values: SemanticEnrichmentDiagnostic[]) => void
): Map<string, SemanticParagraphContext> {
  const source = preparedSource.blocks
  const descriptorsByID = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))
  const locations = makeLocationIndex(document)
  const result = new Map<string, SemanticParagraphContext>()
  for (const match of alignment.matches) {
    if (confidenceRank(match.confidence) < confidenceRank(minimumConfidence)) continue
    const blocks = rangeOf(match.sourceRange).map((at) => source[at])
    const paragraphDescriptors = rangeOf(match.pdfRange)
      .map((at) => descriptorsByID.get(alignment.pdfParagraphIDs[at]))
      .filter((descriptor): descriptor is SemanticPDFParagraph => descriptor !== undefined)
    const combinedText = blocks.map(contextText).join('\n\n')
    const template = blocks.map((block) => block.translationTemplate).join('\n\n')
    const continuationID = paragraphDescriptors.length > 1
      ? `continuation-${blocks.map((block) => block.id).join('-')}`
      : null
    const structuralMatch = confidenceRank(match.confidence) >= confidenceRank('medium')
    paragraphDescriptors.forEach((descriptor, fragmentIndex) => {
      const location = locations.get(descriptor.id)
      if (!location) return
      const primary = blocks[0]
      const paragraph = document.page?.[location.page]?.pdf_paragraph?.[location.paragraph]
      if (!paragraph) return
      const currentLabel = paragraph.layout_label ?? null
      if (structuralMatch) {
        const label = preferredLabel(primary.kind)
        if (label && currentLabel !== label && !labelCorrectionProtectedLabels.has(currentLabel ?? '')) {
          paragraph.layout_label = label
          appendDiagnostics([{
            kind: 'labelCorrection', accepted: true,
            sourceBlockIDs: blocks.map((block) => block.id), pdfParagraphIDs: [descriptor.id],
            reason: `LaTeX semantic role corrected the layout label to ${label}.`
          }])
        }
      }
      const page = document.page?.[location.page]
      const associated = structuralMatch && page
        ? associatedLayoutID(primary.kind, paragraph, page)
        : null
      if (associated !== null && associated !== undefined) {
        appendDiagnostics([{
          kind: primary.kind === 'tableCell' ? 'tableCellAssociation' : 'floatingObjectAssociation',
          accepted: true, sourceBlockIDs: blocks.map((block) => block.id),
          pdfParagraphIDs: [descriptor.id],
          reason: `Associated with nearest compatible page layout ${associated}.`
        }])
      }
      const previous = neighborContext(match.sourceRange, -1, preparedSource)
      const next = neighborContext(match.sourceRange, 1, preparedSource)
      const canOverride = match.confidence === 'high'
        && paragraphDescriptors.length === 1
        && blocks.every((block) => atomsCanBeRestored(block, descriptor.text))
      result.set(semanticAddressKey({ pageIndex: location.page, paragraphIndex: location.paragraph }), {
        sourceBlockIDs: blocks.map((block) => block.id),
        role: primary.kind,
        environment: blocks.map((block) => block.environment).find((value): value is string => value !== undefined && value !== null) ?? null,
        sectionPath: primary.sectionPath,
        previousSourceParagraph: previous ?? null,
        nextSourceParagraph: next ?? null,
        completeSourceText: combinedText,
        translationTemplate: canOverride ? template : null,
        atoms: blocks.flatMap((block) => block.atoms),
        matchConfidence: match.confidence,
        continuationGroupID: continuationID,
        fragmentIndex,
        fragmentCount: paragraphDescriptors.length,
        associatedLayoutID: associated ?? null
      })
    })
  }
  return result
}

/** Source context keeps protected atoms visible: math stays in the sentence. */
export function contextText(block: BabelDocSemanticBlock): string {
  if (block.atoms.length === 0) return block.alignmentText
  let text = block.translationTemplate
  for (const atom of block.atoms) {
    text = text.split(atom.token).join(atom.visibleText ?? atom.rawSource)
  }
  return text
}

/** Adjacent source context in alignment order; floats only see same-container siblings. */
function neighborContext(
  range: { start: number; end: number },
  offset: number,
  preparedSource: PreparedSource
): string | null {
  const source = preparedSource.blocks
  const anchor = offset < 0 ? range.start : range.end - 1
  const neighbor = anchor + offset
  if (neighbor < 0 || neighbor >= source.length) return null
  const anchorIsFlow = anchor < preparedSource.flowCount
  const neighborIsFlow = neighbor < preparedSource.flowCount
  if (anchorIsFlow !== neighborIsFlow) return null
  if (!anchorIsFlow) {
    const parentID = source[anchor].parentID
    if (!parentID || source[neighbor].parentID !== parentID) return null
  }
  return contextText(source[neighbor])
}

function preferredLabel(kind: BabelDocSemanticBlockKind): string | null {
  switch (kind) {
    case 'documentTitle': return 'doc_title'
    case 'sectionHeading': return 'paragraph_title'
    case 'figureCaption': return 'figure_caption'
    case 'tableCaption': return 'table_caption'
    case 'abstract': return 'abstract'
    case 'reference': return 'reference'
    case 'algorithm': case 'code': return 'code'
    default: return null
  }
}

/** Labels that select dedicated translation input recovery downstream. */
const labelCorrectionProtectedLabels = new Set([
  'wireless_table_cell', 'list_item', 'isolate_formula', 'code',
  TableOfContentsDotLeader.pageMarkerLayoutLabel
])

function associatedLayoutID(
  kind: BabelDocSemanticBlockKind,
  paragraph: ILPdfParagraph,
  page: ILPage
): number | null {
  let names: Set<string>
  switch (kind) {
    case 'figureCaption':
      names = new Set(['figure', 'figure_body'])
      break
    case 'tableCaption': case 'tableCell':
      names = new Set(['table', 'table_body'])
      break
    default:
      return null
  }
  const paragraphBox = boxCoordinates(paragraph.box)
  if (!paragraphBox) return null
  let best: { id: number; distance: number } | null = null
  for (const layout of page.page_layout ?? []) {
    const id = layout.id
    if (id === undefined || !names.has(layout.class_name?.toLowerCase() ?? '')) continue
    const box = boxCoordinates(layout.box)
    if (!box) continue
    const dx = Math.max(0, Math.max(box.x - paragraphBox.x2, paragraphBox.x - box.x2))
    const dy = Math.max(0, Math.max(box.y - paragraphBox.y2, paragraphBox.y - box.y2))
    const distance = Math.hypot(dx, dy)
    if (!best || distance < best.distance) best = { id, distance }
  }
  return best ? best.id : null
}

function atomsCanBeRestored(block: BabelDocSemanticBlock, pdfText: string): boolean {
  return block.atoms.every((atom: BabelDocSemanticAtom) => {
    switch (atom.kind) {
      case 'math': case 'citation': case 'reference':
        return true
      case 'url': case 'code': {
        const visible = atom.visibleText !== undefined && atom.visibleText !== null ? foundationTrim(atom.visibleText) : ''
        if (visible.length === 0) return false
        return pdfText.toLowerCase().includes(visible.toLowerCase())
      }
    }
  })
}

function makeLocationIndex(document: ILDocument): Map<string, Location> {
  const result = new Map<string, Location>()
  for (const [page, pageValue] of (document.page ?? []).entries()) {
    for (let paragraph = 0; paragraph < (pageValue.pdf_paragraph ?? []).length; paragraph += 1) {
      const id = pageValue.pdf_paragraph?.[paragraph]?.debug_id
      if (id !== undefined) result.set(id, { page, paragraph })
    }
  }
  return result
}

interface AlignmentMetrics {
  matchedPDF: number
  flowPDF: number
  matchedFlowPDF: number
  coverage: number
  high: number
  medium: number
  low: number
}

function metrics(alignment: SemanticAlignmentResult, descriptors: SemanticPDFParagraph[]): AlignmentMetrics {
  const matchedIDs = new Set(alignment.matches.flatMap((match) => rangeOf(match.pdfRange)).map((at) => alignment.pdfParagraphIDs[at]))
  const flowIDs = descriptors
    .filter((descriptor) => SemanticHintMatcher.isFlowLabel(descriptor.layoutLabel))
    .map((descriptor) => descriptor.id)
  const matchedFlow = flowIDs.filter((id) => matchedIDs.has(id)).length
  const coverage = flowIDs.length === 0 ? 0 : matchedFlow / flowIDs.length
  return {
    matchedPDF: matchedIDs.size,
    flowPDF: flowIDs.length,
    matchedFlowPDF: matchedFlow,
    coverage,
    high: alignment.matches.filter((match) => match.confidence === 'high').length,
    medium: alignment.matches.filter((match) => match.confidence === 'medium').length,
    low: alignment.matches.filter((match) => match.confidence === 'low').length
  }
}

function paragraphsAreInSameColumn(paragraphs: ILPdfParagraph[], minimumOverlap: number, maximumGap: number): boolean {
  const boxes = paragraphs.map((paragraph) => boxCoordinates(paragraph.box)).filter((box): box is NonNullable<ReturnType<typeof boxCoordinates>> => box !== null)
  if (boxes.length !== paragraphs.length) return false
  const ordered = [...boxes].sort((lhs, rhs) => rhs.y - lhs.y)
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const first = ordered[index]
    const second = ordered[index + 1]
    const overlap = Math.max(0, Math.min(first.x2, second.x2) - Math.max(first.x, second.x))
    const width = Math.max(1, Math.min(first.x2 - first.x, second.x2 - second.x))
    if (overlap / width < minimumOverlap) return false
    const gap = Math.max(0, first.y - second.y2)
    if (gap > maximumGap) return false
  }
  return true
}

/** True when `merged` covers a meaningful part of `other` (≥ 20% of its area). */
function boxesOverlap(
  merged: NonNullable<ReturnType<typeof boxCoordinates>>,
  other: NonNullable<ReturnType<typeof boxCoordinates>>
): boolean {
  const width = Math.min(merged.x2, other.x2) - Math.max(merged.x, other.x)
  const height = Math.min(merged.y2, other.y2) - Math.max(merged.y, other.y)
  if (width <= 0 || height <= 0) return false
  const otherArea = Math.max((other.x2 - other.x) * (other.y2 - other.y), 1)
  return width * height / otherArea >= 0.2
}

function union(boxes: Array<ILBox | undefined>): ILBox | undefined {
  const values = boxes
    .map((box) => (box ? boxCoordinates(box) : null))
    .filter((value): value is NonNullable<ReturnType<typeof boxCoordinates>> => value !== null)
  if (values.length === 0) return undefined
  return {
    x: Math.min(...values.map((value) => value.x)),
    y: Math.min(...values.map((value) => value.y)),
    x2: Math.max(...values.map((value) => value.x2)),
    y2: Math.max(...values.map((value) => value.y2))
  }
}

function confidenceRank(confidence: SemanticMatchConfidence): number {
  switch (confidence) {
    case 'rejected': return 0
    case 'low': return 1
    case 'medium': return 2
    case 'high': return 3
  }
}

function compositionCharacterCount(compositions: ILPdfParagraphComposition[]): number {
  return compositions.reduce((sum, composition) => sum + compositionCharacterCountSingle(composition), 0)
}

function compositionCharacterCountSingle(composition: ILPdfParagraphComposition): number {
  const textCount = [...compositionText([composition])].length
  // A formula must remain an indivisible unit even if its extracted text is empty.
  return composition.pdf_formula === undefined ? textCount : Math.max(textCount, 1)
}

const punctuationScalar = /\p{P}/u

function safeSplitOffsets(compositions: ILPdfParagraphComposition[]): number[] {
  const result = new Set<number>()
  let cursor = 0
  const total = compositionCharacterCount(compositions)
  for (const composition of compositions) {
    const text = compositionText([composition])
    const characters = [...text]
    if (composition.pdf_formula === undefined) {
      if (characters.length > 1) {
        for (let offset = 1; offset < characters.length; offset += 1) {
          const previous = characters[offset - 1]
          const next = characters[offset]
          if (whitespaceScalar.test(previous) || whitespaceScalar.test(next)
            || punctuationScalar.test(previous) || punctuationScalar.test(next)) {
            result.add(cursor + offset)
          }
        }
      }
      const charactersList = composition.pdf_line?.pdf_character ?? composition.pdf_same_style_characters?.pdf_character
      if (charactersList) {
        let inner = 0
        for (const character of charactersList.slice(0, -1)) {
          inner += [...(character.char_unicode ?? '')].length
          result.add(cursor + inner)
        }
      }
    }
    cursor += compositionCharacterCountSingle(composition)
    if (cursor < total) result.add(cursor)
  }
  return [...result].filter((offset) => offset > 0 && offset < total).sort((lhs, rhs) => lhs - rhs)
}

const whitespaceScalar = /\p{White_Space}/u
const letterOrNumberScalar = /[\p{L}\p{N}]/u

function compactCharactersWithSourceOffsets(text: string): { characters: string[]; sourceOffsets: number[] } {
  const characters: string[] = []
  const offsets: number[] = []
  for (const [offset, character] of [...text].entries()) {
    const normalized = character.normalize('NFKC').toLowerCase()
    for (const value of [...normalized]) {
      if (letterOrNumberScalar.test(value)) {
        characters.push(value)
        offsets.push(offset)
      }
    }
  }
  return { characters, sourceOffsets: offsets }
}

function compactAlignmentText(text: string): string[] {
  return compactCharactersWithSourceOffsets(text).characters
}

function firstSubsequence(needle: string[], haystack: string[], start: number): number | null {
  if (needle.length === 0 || start < 0 || haystack.length < needle.length) return null
  const maximum = haystack.length - needle.length
  if (start > maximum) return null
  for (let offset = start; offset <= maximum; offset += 1) {
    let equal = true
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        equal = false
        break
      }
    }
    if (equal) return offset
  }
  return null
}

function sourceAnchoredSplitOffsets(paragraphText: string, sourceBlocks: BabelDocSemanticBlock[]): number[] | null {
  const paragraph = compactCharactersWithSourceOffsets(paragraphText)
  if (paragraph.characters.length === 0) return null
  let searchStart = 0
  const result: number[] = []
  for (const block of sourceBlocks.slice(1)) {
    const anchor = compactAlignmentText(block.alignmentText).slice(0, 32)
    if (anchor.length < 8) return null
    const match = firstSubsequence(anchor, paragraph.characters, searchStart)
    if (match === null) return null
    result.push(paragraph.sourceOffsets[match])
    searchStart = match + anchor.length
  }
  return result
}

export function compositionText(compositions: ILPdfParagraphComposition[]): string {
  return compositions.map((composition) => {
    if (composition.pdf_line) {
      return (composition.pdf_line.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')
    }
    if (composition.pdf_formula) {
      return (composition.pdf_formula.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')
    }
    if (composition.pdf_same_style_characters) {
      return (composition.pdf_same_style_characters.pdf_character ?? []).map((character) => character.char_unicode ?? '').join('')
    }
    if (composition.pdf_character) return composition.pdf_character.char_unicode ?? ''
    return composition.pdf_same_style_unicode_characters?.unicode ?? ''
  }).join('')
}

function compositionBox(compositions: ILPdfParagraphComposition[]): ILBox | undefined {
  return union(compositions.map((composition) =>
    composition.pdf_line?.box
    ?? composition.pdf_formula?.box
    ?? composition.pdf_same_style_characters?.box
    ?? composition.pdf_character?.box))
}

function splitCompositions(compositions: ILPdfParagraphComposition[], offsets: number[]): ILPdfParagraphComposition[][] | null {
  if (offsets.length === 0) return [compositions]
  const groups: ILPdfParagraphComposition[][] = []
  let remaining = [...compositions]
  let consumed = 0
  for (const absoluteOffset of offsets) {
    const parts = splitCompositionArray(remaining, absoluteOffset - consumed)
    if (!parts) return null
    groups.push(parts[0])
    remaining = parts[1]
    consumed = absoluteOffset
  }
  groups.push(remaining)
  return groups.every((group) => group.length > 0) ? groups : null
}

function splitCompositionArray(
  compositions: ILPdfParagraphComposition[],
  offset: number
): [ILPdfParagraphComposition[], ILPdfParagraphComposition[]] | null {
  if (offset <= 0) return null
  let cursor = 0
  for (let index = 0; index < compositions.length; index += 1) {
    const composition = compositions[index]
    const count = compositionCharacterCountSingle(composition)
    if (cursor + count === offset) {
      if (index + 1 >= compositions.length) return null
      return [compositions.slice(0, index + 1), compositions.slice(index + 1)]
    }
    if (cursor < offset && offset < cursor + count) {
      if (composition.pdf_formula !== undefined) return null
      const pieces = splitCharacterComposition(composition, offset - cursor)
      if (!pieces) return null
      return [
        [...compositions.slice(0, index), pieces[0]],
        [pieces[1], ...compositions.slice(index + 1)]
      ]
    }
    cursor += count
  }
  return null
}

function splitCharacterComposition(
  composition: ILPdfParagraphComposition,
  offset: number
): [ILPdfParagraphComposition, ILPdfParagraphComposition] | null {
  if (composition.pdf_line) {
    const line = composition.pdf_line
    const characters = line.pdf_character ?? []
    const characterOffset = characterArrayBoundary(characters, offset)
    if (characterOffset === null) return null
    const leftCharacters = characters.slice(0, characterOffset)
    const rightCharacters = characters.slice(characterOffset)
    const left: ILPdfParagraphComposition = {
      pdf_line: { ...line, pdf_character: leftCharacters, box: unionBoxOf(leftCharacters) }
    }
    const right: ILPdfParagraphComposition = {
      pdf_line: { ...line, pdf_character: rightCharacters, box: unionBoxOf(rightCharacters) }
    }
    return [left, right]
  }
  if (composition.pdf_same_style_characters) {
    const values = composition.pdf_same_style_characters
    const characters = values.pdf_character ?? []
    const characterOffset = characterArrayBoundary(characters, offset)
    if (characterOffset === null) return null
    const leftCharacters = characters.slice(0, characterOffset)
    const rightCharacters = characters.slice(characterOffset)
    const left: ILPdfParagraphComposition = {
      pdf_same_style_characters: { ...values, pdf_character: leftCharacters, box: unionBoxOf(leftCharacters) }
    }
    const right: ILPdfParagraphComposition = {
      pdf_same_style_characters: { ...values, pdf_character: rightCharacters, box: unionBoxOf(rightCharacters) }
    }
    return [left, right]
  }
  if (composition.pdf_same_style_unicode_characters?.unicode !== undefined) {
    const value = composition.pdf_same_style_unicode_characters.unicode
    const boundary = Math.min(offset, [...value].length)
    const leftUnicode = [...value].slice(0, boundary).join('')
    const rightUnicode = [...value].slice(boundary).join('')
    return [
      { pdf_same_style_unicode_characters: { ...composition.pdf_same_style_unicode_characters, unicode: leftUnicode } },
      { pdf_same_style_unicode_characters: { ...composition.pdf_same_style_unicode_characters, unicode: rightUnicode } }
    ]
  }
  return null
}

function unionBoxOf(characters: ILPdfCharacter[]): ILBox | undefined {
  return union(characters.map((character) => character.box))
}

function characterArrayBoundary(characters: ILPdfCharacter[], offset: number): number | null {
  if (offset <= 0) return null
  let cursor = 0
  for (let index = 0; index < characters.length; index += 1) {
    cursor += [...(characters[index].char_unicode ?? '')].length
    if (cursor === offset) {
      return index + 1 < characters.length ? index + 1 : null
    }
    if (cursor > offset) return null
  }
  return null
}

export { pythonBool }
