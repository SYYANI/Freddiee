// Translation and semantic-hint parity: the fixtures record what the Swift
// pipeline produced with the deterministic ParityMockTranslator (placeholder
// preserving, with hash-driven validation retries and prompt echoes). The same
// mock runs here, so stage outputs and diagnostics counts must match exactly.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ILDocument } from '../BabelDocKit/src/il'
import type {
  AsyncILTextTranslator, ILTranslationContext, ILTranslationReport
} from '../BabelDocKit/src/translator'
import { ILTranslator, ILTranslationOutputError } from '../BabelDocKit/src/translator'
import { SemanticHintEnricher } from '../BabelDocKit/src/semanticHintEnricher'
import { makeSourceParagraphSnapshot } from '../BabelDocKit/src/sourcePreservingPlan'

const fixturesRoot = fileURLToPath(new URL('./fixtures/babeldoc', import.meta.url))

function deepEqualIL(wasm: unknown, swift: unknown, path = '$'): string | null {
  if (wasm === undefined) wasm = null
  if (swift === undefined) swift = null
  if (Array.isArray(wasm) && Array.isArray(swift)) {
    if (wasm.length !== swift.length) return `${path}: array length ${wasm.length} vs ${swift.length}`
    for (let index = 0; index < wasm.length; index += 1) {
      const difference = deepEqualIL(wasm[index], swift[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== null && swift !== null && typeof wasm === 'object' && typeof swift === 'object') {
    const keys = new Set([...Object.keys(wasm), ...Object.keys(swift)])
    for (const key of keys) {
      const difference = deepEqualIL((wasm as Record<string, unknown>)[key], (swift as Record<string, unknown>)[key], `${path}.${key}`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== swift && !(typeof wasm === 'number' && typeof swift === 'number' && Object.is(wasm, swift))) {
    return `${path}: ${JSON.stringify(wasm)} vs ${JSON.stringify(swift)}`
  }
  return null
}

/** Byte-for-byte mirror of the harness ParityMockTranslator. */
class MockTranslator implements AsyncILTextTranslator {
  readonly maximumConcurrentTranslations = 3

  formulaPlaceholder(id: number): string {
    return `[BABELDOC_FORMULA_${id}]`
  }

  private static encoder = new TextEncoder()

  private static fnv(text: string): number {
    let hash = 0x811c9dc5
    for (const byte of MockTranslator.encoder.encode(text)) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash >>> 0
  }

  async translate(text: string): Promise<string> {
    return this.translateWithContext(text, {})
  }

  async translateWithContext(text: string, context: ILTranslationContext): Promise<string> {
    const hash = MockTranslator.fnv(text)
    if (hash % 13 === 0
      && (context.previousSegment ?? '') === '' && (context.nextSegment ?? '') === '') {
      throw new ILTranslationOutputError()
    }
    const pieces = text.split(/(\[(?:BABELDOC_FORMULA|PROTECTED_SEMANTIC|PROTECTED)_\d+\])/g)
    let dropFirstToken = hash % 7 === 0
    if ((context.placeholderRetryAttempt ?? 0) > 0) {
      dropFirstToken = false
    }
    let dropped = false
    let output = ''
    for (const piece of pieces) {
      if (piece.length === 0) continue
      if (/^\[(?:BABELDOC_FORMULA|PROTECTED_SEMANTIC|PROTECTED)_\d+\]$/.test(piece)) {
        if (dropFirstToken && !dropped) {
          dropped = true
          continue
        }
        output += piece
      } else {
        output += `译${piece}`
      }
    }
    return output
  }
}

interface Fixture {
  name: string
  stage: (file: string) => unknown
  has: (file: string) => boolean
}

const fixtures: Fixture[] = []

beforeAll(() => {
  for (const name of readdirSync(fixturesRoot).sort()) {
    const directory = join(fixturesRoot, name)
    if (!existsSync(join(directory, 'manifest.json'))) continue
    fixtures.push({
      name,
      stage: (file) => JSON.parse(readFileSync(join(directory, file), 'utf8')),
      has: (file) => existsSync(join(directory, file))
    })
  }
})

/** Rebuilds the mock semantic hints exactly like synthesizeSemanticHints in the
 * harness: every paragraph at index % 3 == 1 (or % 3 == ordinal % 3) with at
 * least 12 characters becomes a block. */
function synthesizeSemanticHints(document: ILDocument): import('../BabelDocKit/src/semanticHints').BabelDocSemanticDocument {
  const blocks: Array<import('../BabelDocKit/src/semanticHints').BabelDocSemanticBlock> = []
  let ordinal = 0
  for (const [pageIndex, page] of (document.page ?? []).entries()) {
    for (const [paragraphIndex, paragraph] of (page.pdf_paragraph ?? []).entries()) {
      const text = (paragraph.unicode ?? '').trim()
      if (text.length === 0 || text.length < 12) continue
      const position = paragraphIndex
      if (!(position % 3 === ordinal % 3 || position % 3 === 1)) continue
      let kind: import('../BabelDocKit/src/semanticHints').BabelDocSemanticBlockKind = 'paragraph'
      switch (paragraph.layout_label) {
        case 'figure_caption': kind = 'figureCaption'; break
        case 'table_caption': kind = 'tableCaption'; break
        case 'abstract': kind = 'abstract'; break
        default: break
      }
      const compressed = text.replace(/\s+/g, ' ')
      blocks.push({
        id: `mock-${pageIndex}-${paragraphIndex}`,
        ordinal,
        kind,
        alignmentText: [...compressed].slice(0, 220).join(''),
        translationTemplate: compressed,
        rawSource: compressed,
        sectionPath: [{ level: 1, title: 'Introduction' }],
        headingLevel: null,
        environment: null,
        containerKind: null,
        parentID: null,
        atoms: []
      })
      ordinal += 1
    }
  }
  return { schemaVersion: 1, sourceIdentifier: 'parity-mock', blocks }
}

describe('babeldoc translation parity', () => {
  it('SemanticHintEnricher reproduces the Swift report, contexts and document', () => {
    for (const fixture of fixtures) {
      if (!fixture.has('055-il-after-semantic.json')) continue
      const document = fixture.stage('05-il-after-styles.json') as ILDocument
      const result = SemanticHintEnricher.process(document, synthesizeSemanticHints(document))
      const difference = deepEqualIL(document, fixture.stage('055-il-after-semantic.json'))
      expect(difference, `${fixture.name} IL: ${difference ?? ''}`).toBeNull()

      const mine = {
        pdfParagraphCount: result.report.pdfParagraphCount,
        matchedPDFParagraphCount: result.report.matchedPDFParagraphCount,
        flowPDFParagraphCount: result.report.flowPDFParagraphCount,
        matchedFlowPDFParagraphCount: result.report.matchedFlowPDFParagraphCount,
        matchedPDFCoverage: result.report.matchedPDFCoverage,
        highConfidenceMatchCount: result.report.highConfidenceMatchCount,
        mediumConfidenceMatchCount: result.report.mediumConfidenceMatchCount,
        lowConfidenceMatchCount: result.report.lowConfidenceMatchCount,
        structuralChangesEnabled: result.report.structuralChangesEnabled,
        diagnostics: result.report.diagnostics.map((diagnostic) => ({
          kind: diagnostic.kind,
          accepted: diagnostic.accepted,
          sourceBlockIDs: diagnostic.sourceBlockIDs,
          pdfParagraphIDs: diagnostic.pdfParagraphIDs
        })),
        matches: result.report.alignment.matches.map((match) => ({
          source: { start: match.sourceRange.start, end: match.sourceRange.end },
          pdf: { start: match.pdfRange.start, end: match.pdfRange.end },
          score: match.score,
          confidence: match.confidence
        }))
      }
      const differenceReport = deepEqualIL(mine, fixture.stage('055-semantic-report.json'))
      expect(differenceReport, `${fixture.name} report: ${differenceReport ?? ''}`).toBeNull()

      const contexts: Record<string, unknown> = {}
      for (const [key, context] of result.paragraphContexts) {
        contexts[key] = {
          sourceBlockIDs: context.sourceBlockIDs,
          role: context.role,
          environment: context.environment ?? null,
          sectionPath: context.sectionPath,
          previousSourceParagraph: context.previousSourceParagraph ?? null,
          nextSourceParagraph: context.nextSourceParagraph ?? null,
          completeSourceText: context.completeSourceText,
          translationTemplate: context.translationTemplate ?? null,
          atoms: context.atoms.length,
          matchConfidence: context.matchConfidence,
          continuationGroupID: context.continuationGroupID ?? null,
          fragmentIndex: context.fragmentIndex,
          fragmentCount: context.fragmentCount,
          associatedLayoutID: context.associatedLayoutID ?? null
        }
      }
      const differenceContexts = deepEqualIL(contexts, fixture.stage('055-semantic-contexts.json'))
      expect(differenceContexts, `${fixture.name} contexts: ${differenceContexts ?? ''}`).toBeNull()
    }
  })

  it('ILTranslator with the mock reproduces the Swift stage and diagnostics exactly', { timeout: 120_000 }, async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('065-il-after-translation.json')) continue
      const document = fixture.stage('055-il-after-semantic.json') as ILDocument
      const report = await ILTranslator.processAsync(document, new MockTranslator(), {
        minimumTextLength: 5,
        documentTitle: 'Parity Mock Paper',
        glossary: 'term\nglossary',
        semanticContexts: new Map()
      })
      const difference = deepEqualIL(document, fixture.stage('065-il-after-translation.json'))
      expect(difference, `${fixture.name} IL: ${difference ?? ''}`).toBeNull()

      const mine = normalizeReport(report)
      const differenceReport = deepEqualIL(mine, fixture.stage('065-translation-report.json'))
      expect(differenceReport, `${fixture.name} report: ${differenceReport ?? ''}`).toBeNull()
    }
  })

  it('the post-translation snapshot matches', () => {
    for (const fixture of fixtures) {
      if (!fixture.has('05-source-snapshot.json')) continue
      const document = fixture.stage('055-il-after-semantic.json') as ILDocument
      const snapshot = makeSourceParagraphSnapshot(document)
      const difference = deepEqualIL(snapshot, fixture.stage('05-source-snapshot.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })
})

function normalizeReport(report: ILTranslationReport): unknown {
  return {
    candidateCount: report.candidateCount,
    translatedCount: report.translatedCount,
    failedCount: report.failedCount,
    placeholderValidationFailureCount: report.placeholderValidationFailureCount,
    providerFailureCount: report.providerFailureCount,
    semanticFallbackCount: report.semanticFallbackCount,
    continuationGroupCount: report.continuationGroupCount,
    failedParagraphAddresses: report.failedParagraphAddresses
      .map((key) => {
        const [page, paragraph] = key.split(':')
        return { page: Number(page), paragraph: Number(paragraph) }
      })
      .sort((lhs, rhs) => (lhs.page !== rhs.page ? lhs.page - rhs.page : lhs.paragraph - rhs.paragraph))
  }
}
