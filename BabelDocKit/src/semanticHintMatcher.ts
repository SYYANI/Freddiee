// Semantic alignment between LaTeX source blocks and extracted PDF paragraphs,
// ported from Swift SemanticHintMatcher: flow beam search plus mutually unique
// float matching, token/trigram Dice with LCS order ratio and containment
// bonuses, dehyphenating normalization.
import {
  isSemanticBlockAlignable, validateSemanticDocument,
  type BabelDocSemanticBlock, type BabelDocSemanticBlockKind, type BabelDocSemanticDocument,
  type SemanticAlignmentMatch, type SemanticAlignmentResult, type SemanticMatchConfidence,
  type SemanticPDFParagraph
} from './semanticHints'

export interface SemanticHintMatcherConfiguration {
  maximumSourceSpan: number
  maximumPDFSpan: number
  maximumCandidateSourceStarts: number
  maximumCandidatesPerPDFStart: number
  maximumCachedSourceSpans: number
  beamWidth: number
  minimumAcceptedScore: number
  mediumConfidenceScore: number
  highConfidenceScore: number
  minimumAmbiguityMargin: number
  minimumInformativeTokensForHighConfidence: number
}

export const defaultMatcherConfiguration: SemanticHintMatcherConfiguration = {
  maximumSourceSpan: 3,
  maximumPDFSpan: 3,
  maximumCandidateSourceStarts: 48,
  maximumCandidatesPerPDFStart: 32,
  maximumCachedSourceSpans: 4096,
  beamWidth: 64,
  minimumAcceptedScore: 0.46,
  mediumConfidenceScore: 0.62,
  highConfidenceScore: 0.78,
  minimumAmbiguityMargin: 0.06,
  minimumInformativeTokensForHighConfidence: 3
}

export interface SemanticIndependentMatch {
  sourceIndex: number
  pdfIndex: number
  score: number
  confidence: SemanticMatchConfidence
}

export const semanticNonFlowLabelFragments = [
  'fallback_line', 'table', 'figure', 'caption', 'footnote', 'abandon', 'formula',
  'header', 'footer', 'page_number', 'code', 'algorithm'
]

/** Aligns a prepared source directly (Swift's internal align overload). */
export function alignPreparedBlocks(
  preparedSource: PreparedSource,
  pdfParagraphs: SemanticPDFParagraph[],
  configuration: SemanticHintMatcherConfiguration = defaultMatcherConfiguration
): SemanticAlignmentResult {
  return alignPrepared(preparedSource, pdfParagraphs, configuration).result
}

export const SemanticHintMatcher = {
  isFlowKind(kind: BabelDocSemanticBlockKind): boolean {
    switch (kind) {
      case 'figureCaption': case 'tableCaption': case 'caption': case 'footnote':
      case 'tableCell': case 'code': case 'algorithm': case 'figure': case 'table':
      case 'equation':
        return false
      default:
        return true
    }
  },

  isFlowLabel(label: string | null | undefined): boolean {
    const value = label?.toLowerCase()
    if (!value || value.length === 0) return true
    return !semanticNonFlowLabelFragments.some((fragment) => value.includes(fragment))
  },

  prepare(source: BabelDocSemanticDocument, _configuration: SemanticHintMatcherConfiguration): PreparedSource {
    validateSemanticDocument(source)
    const alignable = source.blocks.filter(isSemanticBlockAlignable)
    const flow = alignable.filter((block) => SemanticHintMatcher.isFlowKind(block.kind))
    const floating = alignable.filter((block) => !SemanticHintMatcher.isFlowKind(block.kind))
    return {
      blocks: [...flow, ...floating],
      flowCount: flow.length,
      flowIndex: new SourceIndex(flow),
      floatIndex: new SourceIndex(floating)
    }
  },

  align(
    source: BabelDocSemanticDocument,
    pdfParagraphs: SemanticPDFParagraph[],
    configuration: SemanticHintMatcherConfiguration = defaultMatcherConfiguration
  ): SemanticAlignmentResult {
    const prepared = SemanticHintMatcher.prepare(source, configuration)
    return alignPrepared(prepared, pdfParagraphs, configuration).result
  },

  independentHighConfidenceMatches(
    preparedSource: PreparedSource,
    pdfParagraphs: SemanticPDFParagraph[],
    configuration: SemanticHintMatcherConfiguration
  ): SemanticIndependentMatch[] {
    // Reading-order evidence is only meaningful for flow text; floats are
    // positioned by TeX and would reorder unrelated paragraphs.
    const source = preparedSource.blocks
    if (preparedSource.flowCount === 0) return []
    const floor = configuration.highConfidenceScore - similarityPruningMargin
    const proposed: SemanticIndependentMatch[] = []
    for (let pdfIndex = 0; pdfIndex < pdfParagraphs.length; pdfIndex += 1) {
      const paragraph = pdfParagraphs[pdfIndex]
      if (paragraph.layoutLabel?.toLowerCase() === 'isolate_formula') continue
      if (!SemanticHintMatcher.isFlowLabel(paragraph.layoutLabel)) continue
      const normalized = new NormalizedText(paragraph.text)
      if (normalized.compact.length === 0) continue
      if (informativeTokenCount(normalized) < configuration.minimumInformativeTokensForHighConfidence) continue
      const starts = preparedSource.flowIndex.candidateStarts(normalized, configuration.maximumCandidateSourceStarts)
      const orderedCandidates = starts
        .map((sourceIndex) => ({
          sourceIndex,
          value: scoreNormalized({
            source: preparedSource.flowIndex.normalized[sourceIndex],
            pdf: normalized,
            sourceKind: source[sourceIndex].kind,
            pdfLabel: paragraph.layoutLabel ?? null,
            floor
          })
        }))
        .sort((lhs, rhs) => (lhs.value !== rhs.value ? rhs.value - lhs.value : lhs.sourceIndex - rhs.sourceIndex))
      const best = orderedCandidates[0]
      if (!best || best.value < configuration.highConfidenceScore) continue
      if (orderedCandidates.length > 1 && best.value - orderedCandidates[1].value < configuration.minimumAmbiguityMargin) continue
      proposed.push({ sourceIndex: best.sourceIndex, pdfIndex, score: best.value, confidence: 'high' })
    }

    const grouped = new Map<number, SemanticIndependentMatch[]>()
    for (const match of proposed) {
      grouped.set(match.sourceIndex, [...(grouped.get(match.sourceIndex) ?? []), match])
    }
    return proposed.filter((match) => {
      const values = grouped.get(match.sourceIndex)
      if (!values) return false
      const ordered = [...values].sort((lhs, rhs) => (lhs.score !== rhs.score ? rhs.score - lhs.score : lhs.pdfIndex - rhs.pdfIndex))
      const strongest = ordered[0]
      return strongest.pdfIndex === match.pdfIndex
        && (ordered.length === 1 || strongest.score - ordered[1].score >= configuration.minimumAmbiguityMargin)
    })
  },

  confidence(score: number, configuration: SemanticHintMatcherConfiguration = defaultMatcherConfiguration): SemanticMatchConfidence {
    if (score >= configuration.highConfidenceScore) return 'high'
    if (score >= configuration.mediumConfidenceScore) return 'medium'
    if (score >= configuration.minimumAcceptedScore) return 'low'
    return 'rejected'
  }
}

export interface PreparedSource {
  blocks: BabelDocSemanticBlock[]
  flowCount: number
  flowIndex: SourceIndex
  floatIndex: SourceIndex
}

interface Span {
  start: number
  end: number
}

function spanKey(span: Span): string {
  return `${span.start}:${span.end}`
}

function overlaps(lhs: Span, rhs: Span): boolean {
  return lhs.start < rhs.end && rhs.start < lhs.end
}

function alignPrepared(
  preparedSource: PreparedSource,
  pdfParagraphs: SemanticPDFParagraph[],
  configuration: SemanticHintMatcherConfiguration
): { result: SemanticAlignmentResult; retainedCandidateCount: number } {
  const source = preparedSource.blocks
  const usable = pdfParagraphs.filter((paragraph) =>
    paragraph.text.trim().length > 0 && paragraph.layoutLabel?.toLowerCase() !== 'isolate_formula')
  // Alignment order mirrors the source side: flow paragraphs first, then floats.
  const flowPDF = usable.filter((paragraph) => SemanticHintMatcher.isFlowLabel(paragraph.layoutLabel))
  const pdf = [...flowPDF, ...usable.filter((paragraph) => !SemanticHintMatcher.isFlowLabel(paragraph.layoutLabel))]
  const flowSource = preparedSource.blocks.slice(0, preparedSource.flowCount)

  let matches: SemanticAlignmentMatch[] = []
  let retainedCandidateCount = 0
  const normalizedSpanCache = new Map<string, NormalizedText>()
  if (flowSource.length > 0 && flowPDF.length > 0) {
    const candidatesByPDFStart: Candidate[][] = []
    for (let pdfStart = 0; pdfStart < flowPDF.length; pdfStart += 1) {
      candidatesByPDFStart.push(candidates(pdfStart, flowSource, flowPDF, preparedSource.flowIndex, normalizedSpanCache, configuration))
    }
    retainedCandidateCount = candidatesByPDFStart.reduce((sum, list) => sum + list.length, 0)
    matches = beamAlignment(candidatesByPDFStart, flowPDF.length, configuration)
  }
  matches = [...matches, ...floatAlignment(preparedSource, pdf, new Set(matches.flatMap((match) => rangeOf(match.pdfRange))), configuration)]
  const matchedSources = new Set(matches.flatMap((match) => rangeOf(match.sourceRange)))
  const matchedPDF = new Set(matches.flatMap((match) => rangeOf(match.pdfRange)))
  return {
    result: {
      sourceBlockIDs: source.map((block) => block.id),
      pdfParagraphIDs: pdf.map((paragraph) => paragraph.id),
      matches,
      unmatchedSourceBlockIDs: source.map((_, index) => index).filter((index) => !matchedSources.has(index)).map((index) => source[index].id),
      unmatchedPDFParagraphIDs: pdf.map((_, index) => index).filter((index) => !matchedPDF.has(index)).map((index) => pdf[index].id)
    },
    retainedCandidateCount
  }
}

function rangeOf(span: { start: number; end: number }): number[] {
  const out: number[] = []
  for (let index = span.start; index < span.end; index += 1) out.push(index)
  return out
}

interface Candidate {
  sourceRange: Span
  pdfRange: Span
  score: number
  confidence: SemanticMatchConfidence
}

function candidates(
  pdfStart: number,
  source: BabelDocSemanticBlock[],
  pdf: SemanticPDFParagraph[],
  index: SourceIndex,
  normalizedSpanCache: Map<string, NormalizedText>,
  configuration: SemanticHintMatcherConfiguration
): Candidate[] {
  const values: Candidate[] = []
  const seen = new Set<string>()
  const normalizedPDFByEnd = new Map<number, NormalizedText>()
  const maximumFragmentEnd = Math.min(pdf.length, pdfStart + configuration.maximumPDFSpan)
  const pdfFragments: NormalizedText[] = []
  for (let end = pdfStart; end < maximumFragmentEnd; end += 1) {
    pdfFragments.push(new NormalizedText(pdf[end].text))
  }
  const floor = configuration.minimumAcceptedScore - similarityPruningMargin
  const maximumPDFEnd = Math.min(pdf.length, pdfStart + configuration.maximumPDFSpan)
  for (let pdfEnd = pdfStart + 1; pdfEnd <= maximumPDFEnd; pdfEnd += 1) {
    const pdfSpan = { start: pdfStart, end: pdfEnd }
    const pdfText = pdf.slice(pdfSpan.start, pdfSpan.end).map((paragraph) => paragraph.text).join(' ')
    const normalizedPDF = new NormalizedText(pdfText)
    normalizedPDFByEnd.set(pdfEnd, normalizedPDF)
    if (normalizedPDF.compact.length === 0) continue
    const anchors = index.candidateStarts(normalizedPDF, configuration.maximumCandidateSourceStarts)
    for (const anchor of anchors) {
      for (let sourceCount = 1; sourceCount <= configuration.maximumSourceSpan; sourceCount += 1) {
        if (sourceCount > 1 && pdfSpan.end - pdfSpan.start > 1) continue
        for (let offset = 0; offset < sourceCount; offset += 1) {
          const sourceStart = anchor - offset
          const sourceEnd = sourceStart + sourceCount
          if (sourceStart < 0 || sourceEnd > source.length) continue
          const key = `${sourceStart}:${sourceEnd}:${pdfStart}:${pdfEnd}`
          if (seen.has(key)) continue
          seen.add(key)
          const sourceSpan = { start: sourceStart, end: sourceEnd }
          let normalizedSource: NormalizedText
          if (sourceEnd - sourceSpan.start === 1) {
            normalizedSource = index.normalized[sourceStart]
          } else {
            const cached = normalizedSpanCache.get(spanKey(sourceSpan))
            if (cached) {
              normalizedSource = cached
            } else {
              normalizedSource = new NormalizedText(
                source.slice(sourceSpan.start, sourceSpan.end).map((block) => block.alignmentText).join(' '))
              if (normalizedSpanCache.size < configuration.maximumCachedSourceSpans) {
                normalizedSpanCache.set(spanKey(sourceSpan), normalizedSource)
              }
            }
          }
          // Every part of an n:1 or 1:n span must itself be explained by the other side.
          if (pdfSpan.end - pdfSpan.start > 1) {
            const fragments = pdfFragments.slice(0, pdfSpan.end - pdfSpan.start)
            if (!fragments.every((fragment) => trigramContainment(fragment, normalizedSource) >= minimumFragmentContainment)) continue
          }
          if (sourceEnd - sourceSpan.start > 1) {
            const explained = rangeOf(sourceSpan).every((at) =>
              trigramContainment(index.normalized[at], normalizedPDF) >= minimumFragmentContainment)
            if (!explained) continue
          }
          const value = scoreNormalized({
            source: normalizedSource,
            pdf: normalizedPDF,
            sourceKind: sourceCount === 1 ? source[sourceStart].kind : null,
            pdfLabel: pdfSpan.end - pdfSpan.start === 1 ? pdf[pdfStart].layoutLabel ?? null : null,
            containment: pdfSpan.end - pdfSpan.start > 1 ? 'pdfInSource' : sourceCount > 1 ? 'sourceInPDF' : 'either',
            floor
          })
          if (value < configuration.minimumAcceptedScore) continue
          values.push({
            sourceRange: sourceSpan,
            pdfRange: pdfSpan,
            score: value,
            confidence: SemanticHintMatcher.confidence(value, configuration)
          })
        }
      }
    }
  }
  const ranked = [...values].sort((lhs, rhs) => {
    if (lhs.score !== rhs.score) return rhs.score - lhs.score
    const lhsPDF = lhs.pdfRange.end - lhs.pdfRange.start
    const rhsPDF = rhs.pdfRange.end - rhs.pdfRange.start
    if (lhsPDF !== rhsPDF) return rhsPDF - lhsPDF
    const lhsSource = lhs.sourceRange.end - lhs.sourceRange.start
    const rhsSource = rhs.sourceRange.end - rhs.sourceRange.start
    if (lhsSource !== rhsSource) return rhsSource - lhsSource
    return lhs.sourceRange.start - rhs.sourceRange.start
  }).slice(0, configuration.maximumCandidatesPerPDFStart)
  return ranked.map((candidate) => {
    if (candidate.confidence !== 'high') return candidate
    // Only a disjoint source span is competing evidence.
    const alternative = ranked.find((other) =>
      other.pdfRange.start === candidate.pdfRange.start && other.pdfRange.end === candidate.pdfRange.end
      && !overlaps(other.sourceRange, candidate.sourceRange))
    const ambiguous = alternative !== undefined
      && candidate.score - alternative.score < configuration.minimumAmbiguityMargin
    const normalizedPDF = normalizedPDFByEnd.get(candidate.pdfRange.end)
      ?? new NormalizedText(pdf.slice(candidate.pdfRange.start, candidate.pdfRange.end).map((paragraph) => paragraph.text).join(' '))
    if (!ambiguous && informativeTokenCount(normalizedPDF) >= configuration.minimumInformativeTokensForHighConfidence) {
      return candidate
    }
    return { ...candidate, confidence: 'medium' as SemanticMatchConfidence }
  })
}

interface BeamState {
  sourceEnd: number
  score: number
  matchedPDFCount: number
  matches: SemanticAlignmentMatch[]
}

function beamAlignment(candidatesByPDFStart: Candidate[][], pdfCount: number, configuration: SemanticHintMatcherConfiguration): SemanticAlignmentMatch[] {
  const beams: BeamState[][] = Array.from({ length: pdfCount + 1 }, () => [])
  beams[0] = [{ sourceEnd: 0, score: 0, matchedPDFCount: 0, matches: [] }]
  for (let pdfIndex = 0; pdfIndex < pdfCount; pdfIndex += 1) {
    const states = pruned(beams[pdfIndex], configuration.beamWidth)
    beams[pdfIndex] = []
    if (states.length === 0) continue
    for (const state of states) {
      const skipPenalty = state.matches.length === 0 ? 0 : 0.035
      beams[pdfIndex + 1].push({
        sourceEnd: state.sourceEnd,
        score: state.score - skipPenalty,
        matchedPDFCount: state.matchedPDFCount,
        matches: state.matches
      })
      for (const candidate of candidatesByPDFStart[pdfIndex]) {
        if (state.matches.length > 0 && candidate.sourceRange.start < state.sourceEnd) continue
        const gap = state.matches.length === 0 ? 0 : candidate.sourceRange.start - state.sourceEnd
        const gapPenalty = Math.min(gap * 0.0025, 0.12)
        // An exact multi-source span must not lose to a contained substring.
        const sourceSpanPenalty = candidate.score >= 0.995
          ? 0
          : Math.max(candidate.sourceRange.end - candidate.sourceRange.start - 1, 0) * 0.025
        const spanReward = candidate.score
          + (candidate.pdfRange.end - candidate.pdfRange.start - 1) * (2 * candidate.score - 1)
          - sourceSpanPenalty
        const match: SemanticAlignmentMatch = {
          sourceRange: { ...candidate.sourceRange },
          pdfRange: { ...candidate.pdfRange },
          score: candidate.score,
          confidence: candidate.confidence
        }
        beams[candidate.pdfRange.end].push({
          sourceEnd: candidate.sourceRange.end,
          score: state.score + spanReward - gapPenalty,
          matchedPDFCount: state.matchedPDFCount + (candidate.pdfRange.end - candidate.pdfRange.start),
          matches: [...state.matches, match]
        })
      }
    }
    beams[pdfIndex + 1] = pruned(beams[pdfIndex + 1], configuration.beamWidth)
  }
  const finalStates = pruned(beams[pdfCount], configuration.beamWidth)
  let best: BeamState | undefined
  for (const state of finalStates) {
    if (!best || stateRank(state) > stateRank(best)) best = state
  }
  return best ? best.matches : []
}

function pruned(states: BeamState[], width: number): BeamState[] {
  const bestByKey = new Map<string, BeamState>()
  for (const state of states) {
    const key = `${state.sourceEnd}:${state.matchedPDFCount}:${state.matches[state.matches.length - 1]?.pdfRange.end ?? 0}`
    const existing = bestByKey.get(key)
    if (existing && stateRank(existing) >= stateRank(state)) continue
    bestByKey.set(key, state)
  }
  return [...bestByKey.values()].sort((lhs, rhs) => {
    if (stateRank(lhs) !== stateRank(rhs)) return stateRank(rhs) - stateRank(lhs)
    if (lhs.sourceEnd !== rhs.sourceEnd) return lhs.sourceEnd - rhs.sourceEnd
    return rhs.matches.length - lhs.matches.length
  }).slice(0, width)
}

function stateRank(state: BeamState): number {
  return state.score + state.matchedPDFCount * 0.012
}

function floatAlignment(
  preparedSource: PreparedSource,
  pdf: SemanticPDFParagraph[],
  excludedPDFIndices: Set<number>,
  configuration: SemanticHintMatcherConfiguration
): SemanticAlignmentMatch[] {
  const offset = preparedSource.flowCount
  if (preparedSource.blocks.length <= offset) return []
  const floor = configuration.mediumConfidenceScore - similarityPruningMargin
  const proposals: Array<{ sourceIndex: number; pdfIndex: number; score: number }> = []
  for (let pdfIndex = 0; pdfIndex < pdf.length; pdfIndex += 1) {
    if (excludedPDFIndices.has(pdfIndex)) continue
    const paragraph = pdf[pdfIndex]
    const normalized = new NormalizedText(paragraph.text)
    if (informativeTokenCount(normalized) < configuration.minimumInformativeTokensForHighConfidence) continue
    const ranked = preparedSource.floatIndex
      .candidateStarts(normalized, configuration.maximumCandidateSourceStarts)
      .map((localIndex) => ({
        localIndex,
        value: scoreNormalized({
          source: preparedSource.floatIndex.normalized[localIndex],
          pdf: normalized,
          sourceKind: preparedSource.blocks[offset + localIndex].kind,
          pdfLabel: paragraph.layoutLabel ?? null,
          floor
        })
      }))
      .sort((lhs, rhs) => (lhs.value !== rhs.value ? rhs.value - lhs.value : lhs.localIndex - rhs.localIndex))
    const best = ranked[0]
    if (!best || best.value < configuration.mediumConfidenceScore) continue
    if (ranked.length > 1 && best.value - ranked[1].value < configuration.minimumAmbiguityMargin) continue
    proposals.push({ sourceIndex: offset + best.localIndex, pdfIndex, score: best.value })
  }

  const grouped = new Map<number, typeof proposals>()
  for (const proposal of proposals) {
    grouped.set(proposal.sourceIndex, [...(grouped.get(proposal.sourceIndex) ?? []), proposal])
  }
  const matches: SemanticAlignmentMatch[] = []
  for (const values of grouped.values()) {
    const ordered = [...values].sort((lhs, rhs) => (lhs.score !== rhs.score ? rhs.score - lhs.score : lhs.pdfIndex - rhs.pdfIndex))
    if (ordered.length > 1 && ordered[0].score - ordered[1].score < configuration.minimumAmbiguityMargin) continue
    const best = ordered[0]
    matches.push({
      sourceRange: { start: best.sourceIndex, end: best.sourceIndex + 1 },
      pdfRange: { start: best.pdfIndex, end: best.pdfIndex + 1 },
      score: best.score,
      confidence: SemanticHintMatcher.confidence(best.score, configuration)
    })
  }
  return matches.sort((lhs, rhs) => lhs.pdfRange.start - rhs.pdfRange.start)
}

function informativeTokenCount(text: NormalizedText): number {
  return text.tokens.filter((token) =>
    [...token].length >= 3 || /^[0-9]+$/.test(token)).length
}

/** Largest positive role bonus plus slack (see the Swift doc comment). */
const similarityPruningMargin = 0.1
const minimumFragmentContainment = 0.7

export function roleCompatibility(sourceKind: BabelDocSemanticBlockKind | null, pdfLabel: string | null): number {
  if (!sourceKind) return 0
  const label = pdfLabel?.toLowerCase() ?? ''
  switch (sourceKind) {
    case 'documentTitle':
      return ['doc_title', 'title', 'title_hybrid'].includes(label) ? 0.08 : -0.02
    case 'sectionHeading':
      return ['paragraph_title', 'title', 'title_hybrid'].includes(label) ? 0.07 : 0
    case 'figureCaption':
      if (label === 'figure_caption') return 0.09
      if (label === 'table_caption') return -0.14
      break
    case 'tableCaption':
      if (label === 'table_caption') return 0.09
      if (label === 'figure_caption') return -0.14
      break
    case 'caption':
      return label.includes('caption') ? 0.06 : 0
    case 'abstract':
      return label === 'abstract' ? 0.07 : 0
    case 'reference':
      return label.includes('reference') ? 0.06 : 0
    case 'listItem':
      return label.includes('list_item') ? 0.05 : 0
    case 'tableCell':
      return label.includes('table') ? 0.04 : 0
    case 'code':
    case 'algorithm':
      return label.includes('code') || label.includes('algorithm') ? 0.05 : 0
    default:
      break
  }
  return 0
}

interface ScoreInput {
  source: NormalizedText
  pdf: NormalizedText
  sourceKind: BabelDocSemanticBlockKind | null
  pdfLabel: string | null
  containment?: ContainmentDirection
  floor?: number
}

type ContainmentDirection = 'either' | 'pdfInSource' | 'sourceInPDF'

function scoreNormalized(input: ScoreInput): number {
  let value = similarityNormalized(input.source, input.pdf, input.containment ?? 'either', input.floor ?? 0)
  value += roleCompatibility(input.sourceKind, input.pdfLabel)
  return Math.min(Math.max(value, 0), 1)
}

function similarityNormalized(
  source: NormalizedText,
  pdf: NormalizedText,
  containment: ContainmentDirection,
  floor: number
): number {
  if (source.compact.length === 0 || pdf.compact.length === 0) return 0
  if (source.compact === pdf.compact) return 1
  const lengthRatio = Math.min(source.compact.length, pdf.compact.length)
    / Math.max(source.compact.length, pdf.compact.length)
  const lengthFactor = 0.82 + 0.18 * lengthRatio
  const tokenDice = multisetDiceCounted2(counted(source.tokens), counted(pdf.tokens))
  const trigramDice = multisetDiceCounted2([...source.trigrams.entries()], [...pdf.trigrams.entries()])
  const shorter = source.compact.length <= pdf.compact.length ? source.compact : pdf.compact
  const longer = source.compact.length <= pdf.compact.length ? pdf.compact : source.compact
  const directionAllowed = containment === 'either'
    || (containment === 'pdfInSource' && pdf.compact.length <= source.compact.length)
    || (containment === 'sourceInPDF' && source.compact.length <= pdf.compact.length)
  const containmentScore = directionAllowed && shorter.length >= 8 && longer.includes(shorter)
    ? 0.72 + 0.28 * lengthRatio
    : 0
  // The token LCS ratio never exceeds the token Dice coefficient.
  const upperBound = (tokenDice * 0.60 + trigramDice * 0.40) * lengthFactor
  if (floor > 0 && Math.max(upperBound, containmentScore) < floor) {
    return Math.min(Math.max(upperBound, 0), 1)
  }
  const tokenOrder = tokenLCSRatio(source, pdf)
  let score = (tokenDice * 0.35 + tokenOrder * 0.25 + trigramDice * 0.40) * lengthFactor
  score = Math.max(score, containmentScore)
  return Math.min(Math.max(score, 0), 1)
}

/** Share of `part`'s character trigrams (with multiplicity) that also occur in `whole`. */
function trigramContainment(part: NormalizedText, whole: NormalizedText): number {
  let total = 0
  for (const count of part.trigrams.values()) total += count
  if (total <= 0) return 1
  let shared = 0
  for (const [key, count] of part.trigrams) {
    shared += Math.min(count, whole.trigrams.get(key) ?? 0)
  }
  return shared / total
}

function multisetDiceCounted2(lhs: Array<[string, number]>, rhs: Array<[string, number]>): number {
  const left = new Map(lhs)
  const right = new Map(rhs)
  let leftTotal = 0
  let rightTotal = 0
  for (const value of left.values()) leftTotal += value
  for (const value of right.values()) rightTotal += value
  if (leftTotal + rightTotal <= 0) return 0
  let overlap = 0
  for (const [key, value] of left) {
    overlap += Math.min(value, right.get(key) ?? 0)
  }
  return (2 * overlap) / (leftTotal + rightTotal)
}

function tokenLCSRatio(lhs: NormalizedText, rhs: NormalizedText): number {
  if (lhs.tokens.length === 0 || rhs.tokens.length === 0) return 0
  if (lhs.tokens.length > 160 || rhs.tokens.length > 160) {
    return multisetDiceCounted2(counted(lhs.tokens), counted(rhs.tokens))
  }
  let previous = new Array<number>(rhs.tokens.length + 1).fill(0)
  let current = new Array<number>(rhs.tokens.length + 1).fill(0)
  for (let leftIndex = 0; leftIndex < lhs.tokens.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rhs.tokens.length; rightIndex += 1) {
      if (lhs.tokens[leftIndex] === rhs.tokens[rightIndex]) {
        current[rightIndex + 1] = previous[rightIndex] + 1
      } else {
        current[rightIndex + 1] = Math.max(current[rightIndex], previous[rightIndex + 1])
      }
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[rhs.tokens.length] / Math.max(lhs.tokens.length, rhs.tokens.length)
}

function counted(values: string[]): Array<[string, number]> {
  const map = new Map<string, number>()
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
  return [...map.entries()]
}

const letterScalar = /\p{L}/u
const lowercaseScalar = /\p{Ll}/u
const numberScalar = /\p{N}/u
const whitespaceScalar = /\p{White_Space}/u

export class NormalizedText {
  readonly visible: string
  readonly compact: string
  readonly tokens: string[]
  readonly trigrams: Map<string, number>

  constructor(source: string) {
    const compatible = source.normalize('NFKC').toLowerCase().replace(/\u00AD/g, '')
    const values = NormalizedText.tokensIn(compatible)
    this.tokens = values
    this.visible = values.join(' ')
    this.compact = values.join('')
    this.trigrams = NormalizedText.gramCounts(this.compact)
  }

  /** Tokenizes on letter/number scalars after dehyphenation
   * (`[\\p{L}]{3,}-\\s+([\\p{Ll}]{2,})`). */
  private static tokensIn(text: string): string[] {
    const scalars = [...text]
    const dehyphenated = NormalizedText.dehyphenatedScalars(scalars)
    const values: string[] = []
    let current: string[] = []
    const finish = (): void => {
      if (current.length > 0) {
        values.push(current.join(''))
        current = []
      }
    }
    for (const scalar of dehyphenated) {
      if (letterScalar.test(scalar) || numberScalar.test(scalar)) {
        current.push(scalar)
      } else {
        finish()
      }
    }
    finish()
    return values
  }

  private static dehyphenatedScalars(scalars: string[]): string[] {
    const result: string[] = []
    let index = 0
    while (index < scalars.length) {
      if (scalars[index] !== '-' || NormalizedText.trailingLetterCount(result) < 3) {
        result.push(scalars[index])
        index += 1
        continue
      }
      let next = index + 1
      const whitespaceStart = next
      while (next < scalars.length && whitespaceScalar.test(scalars[next])) next += 1
      if (next === whitespaceStart) {
        result.push(scalars[index])
        index += 1
        continue
      }
      let lowercaseEnd = next
      while (lowercaseEnd < scalars.length && lowercaseScalar.test(scalars[lowercaseEnd])) lowercaseEnd += 1
      if (lowercaseEnd - next < 2) {
        result.push(scalars[index])
        index += 1
        continue
      }
      index = next
    }
    return result
  }

  private static trailingLetterCount(scalars: string[]): number {
    let count = 0
    for (let index = scalars.length - 1; index >= 0; index -= 1) {
      if (!letterScalar.test(scalars[index])) break
      count += 1
    }
    return count
  }

  private static gramCounts(text: string): Map<string, number> {
    const characters = [...text]
    const result = new Map<string, number>()
    if (characters.length === 0) return result
    const width = Math.min(3, characters.length)
    if (characters.length === width) {
      result.set(text, 1)
      return result
    }
    for (let start = 0; start <= characters.length - width; start += 1) {
      const gram = characters.slice(start, start + width).join('')
      result.set(gram, (result.get(gram) ?? 0) + 1)
    }
    return result
  }
}

export class SourceIndex {
  readonly normalized: NormalizedText[]
  readonly tokenToSources: Map<string, number[]>
  readonly tokenDocumentFrequency: Map<string, number>

  constructor(blocks: BabelDocSemanticBlock[]) {
    this.normalized = blocks.map((block) => new NormalizedText(block.alignmentText))
    const inverted = new Map<string, number[]>()
    const frequency = new Map<string, number>()
    this.normalized.forEach((value, index) => {
      for (const token of new Set(value.tokens)) {
        inverted.set(token, [...(inverted.get(token) ?? []), index])
        frequency.set(token, (frequency.get(token) ?? 0) + 1)
      }
    })
    this.tokenToSources = inverted
    this.tokenDocumentFrequency = frequency
  }

  candidateStarts(text: NormalizedText, maximumCount: number): number[] {
    const weights = new Map<number, number>()
    const documentCount = Math.max(this.normalized.length, 1)
    for (const token of new Set(text.tokens)) {
      const sources = this.tokenToSources.get(token)
      if (!sources) continue
      const frequency = this.tokenDocumentFrequency.get(token) ?? 1
      const weight = Math.log(1 + documentCount / frequency)
      for (const source of sources) weights.set(source, (weights.get(source) ?? 0) + weight)
    }
    if (weights.size === 0 && text.compact.length > 0) {
      const exact: number[] = []
      for (let index = 0; index < this.normalized.length && exact.length < maximumCount; index += 1) {
        const compact = this.normalized[index].compact
        if (compact === text.compact || compact.includes(text.compact) || text.compact.includes(compact)) {
          exact.push(index)
        }
      }
      return exact
    }
    return [...weights.entries()]
      .sort((lhs, rhs) => (lhs[1] !== rhs[1] ? rhs[1] - lhs[1] : lhs[0] - rhs[0]))
      .slice(0, maximumCount)
      .map(([key]) => key)
  }
}
