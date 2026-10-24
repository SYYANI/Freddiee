// The full BabelDoc pipeline, ported from Swift NativeBabelDocPipeline:
// frontend → layout → paragraph → styles → semantic hints → translation →
// typesetting → source-preserving plan → backend, with stage progress.
import { extractFrontend } from './frontend'
import { loadPDFPages } from './documentLoader'
import { LayoutDetector, type LayoutDetectorConfiguration, type PageLayoutResult } from './layoutDetector'
import { LayoutParser } from './layoutParser'
import { ParagraphFinder } from './paragraphFinder'
import { StylesAndFormulas } from './stylesAndFormulas'
import {
  SemanticHintEnricher, type SemanticEnrichmentResult,
  type SemanticEnrichmentReport, type SemanticHintEnricherConfiguration
} from './semanticHintEnricher'
import { ILTranslator, type AsyncILTextTranslator, type ILTranslatorConfiguration, type ILTranslationReport } from './translator'
import { Typesetting, type TypesettingConfiguration, type TypesettingReport } from './typesetting'
import { makeSourceParagraphSnapshot, SourcePreservingPlanner, type SourcePreservingDocumentPlan, type SourceParagraphSnapshot } from './sourcePreservingPlan'
import { NativePDFBackend, type NativePDFBackendConfiguration, type NativePDFBackendReport, type NativePDFRenderingMode } from './pdfBackend'
import { babelDocWasm } from './wasmModule'
import { classificationFontNames, loadTargetFonts } from './targetFonts'
import { type BabelDocSemanticDocument, type SemanticParagraphContext } from './semanticHints'
import type { ILDocument } from './il'

export type BabelDocStage = 'frontend' | 'layout' | 'paragraph' | 'styles' | 'semantic' | 'translation' | 'typesetting' | 'backend'

export const stageOrder: BabelDocStage[] = ['frontend', 'layout', 'paragraph', 'styles', 'semantic', 'translation', 'typesetting', 'backend']

/** Swift NativeBabelDocStage raw values, used for progress events. */
export const stageDisplayNames: Record<BabelDocStage, string> = {
  frontend: 'Parse PDF',
  layout: 'Parse layout',
  paragraph: 'Find paragraphs',
  styles: 'Analyze styles and formulas',
  semantic: 'Apply LaTeX semantic hints',
  translation: 'Translate paragraphs',
  typesetting: 'Typeset translation',
  backend: 'Create PDF'
}

/** Helper-bridge stage names (ReadPaperBabelDocHelper.main.swift). */
export const stageBridgeNames: Record<BabelDocStage, string> = {
  frontend: 'ILCreater',
  layout: 'LayoutParser',
  paragraph: 'ParagraphFinder',
  styles: 'StylesAndFormulas',
  semantic: 'SemanticHintEnricher',
  translation: 'ILTranslator',
  typesetting: 'Typesetting',
  backend: 'PDFCreater'
}

export interface BabelDocProgress {
  stage: BabelDocStage
  stageCompleted: number
  stageTotal: number
  overallProgress: number
}

export type SemanticHintStatus = 'notProvided' | 'applied' | 'pdfFallback'

export interface BabelDocPipelineDiagnostics {
  semanticHintStatus: SemanticHintStatus
  semanticFallbackReason?: string
  semanticEnrichmentReport?: SemanticEnrichmentReport
  translationReport: ILTranslationReport
  backendReport?: NativePDFBackendReport
}

export interface BabelDocPipelineConfiguration {
  layoutModelPath: string
  targetLanguage: string
  targetFontDirectory?: string | null
  layoutConfidenceThreshold?: number
  layoutDetectorConfiguration?: Partial<LayoutDetectorConfiguration>
  onlyIncludeTranslatedPages: boolean
  documentTitle?: string | null
  glossary?: string | null
  semanticHints?: BabelDocSemanticDocument | null
  renderingMode: NativePDFRenderingMode
  maximumUnmatchedGlyphFraction?: number
  enricherConfiguration?: SemanticHintEnricherConfiguration
}

export const pipelineRenderingMode: NativePDFRenderingMode = 'source-preserving'

export interface PipelineTranslateResult {
  document: ILDocument
  pdf: Uint8Array
  diagnostics: BabelDocPipelineDiagnostics
}

export interface PipelineStages {
  /** Runs the PDF-only stages that precede semantic enrichment and translation. */
  structuredDocument(onProgress?: (progress: BabelDocProgress) => void): Promise<ILDocument>
  translateStructuredDocument(document: ILDocument, translator: AsyncILTextTranslator, onProgress?: (progress: BabelDocProgress) => void): Promise<PipelineTranslateResult>
  translatePDF(
    translator: AsyncILTextTranslator,
    onProgress?: (progress: BabelDocProgress) => void,
    onStructuredDocument?: (document: ILDocument) => void
  ): Promise<PipelineTranslateResult>
}

export function createPipeline(
  pdf: Uint8Array,
  pages: number[] | null,
  configuration: BabelDocPipelineConfiguration
): PipelineStages {
  const report = (onProgress: ((progress: BabelDocProgress) => void) | undefined, stage: BabelDocStage, completed: number, total: number): void => {
    if (!onProgress) return
    const stageIndex = stageOrder.indexOf(stage)
    const fraction = total > 0 ? completed / total : 1
    onProgress({
      stage,
      stageCompleted: completed,
      stageTotal: total,
      overallProgress: (stageIndex + fraction) / stageOrder.length * 100
    })
  }

  const runStructuredStages = async (
    onProgress?: (progress: BabelDocProgress) => void
  ): Promise<{ document: ILDocument; pageResults: PageLayoutResult[] }> => {
    report(onProgress, 'frontend', 0, 1)
    const extraction = await extractFrontend(pdf, pages ?? undefined)
    const document = extraction.document
    report(onProgress, 'frontend', 1, 1)

    const wasm = await babelDocWasm()
    const fonts = await loadTargetFonts(classificationFontNames, configuration.targetFontDirectory ?? 'BabelDocKit/runtime/fonts', wasm)
    const targetFonts = classificationFontNames.map((name) => fonts.get(name)).filter((font): font is NonNullable<typeof font> => font !== undefined)

    const detector = new LayoutDetector({
      modelPath: configuration.layoutModelPath,
      confidenceThreshold: configuration.layoutConfidenceThreshold
    })
    const totalPages = document.total_pages ?? document.page?.length ?? 0
    const selectedPages = pages ?? Array.from({ length: totalPages }, (_, index) => index + 1)
    const pageResults: PageLayoutResult[] = []
    report(onProgress, 'layout', 0, selectedPages.length)
    for (const [index, pageNumber] of selectedPages.entries()) {
      const loaded = await loadPDFPages(pdf, pageNumber, wasm)
      const page = loaded.pages[0]
      if (!page) throw new Error(`PDF page ${pageNumber} unavailable.`)
      pageResults.push(await detector.detect(page))
      report(onProgress, 'layout', index + 1, selectedPages.length)
    }
    LayoutParser.writeLayouts(document, pageResults)
    for (const page of document.page ?? []) LayoutParser.appendFallbackLines(page)

    report(onProgress, 'paragraph', 0, 1)
    ParagraphFinder.process(document)
    report(onProgress, 'paragraph', 1, 1)

    report(onProgress, 'styles', 0, 1)
    for (const page of document.page ?? []) {
      StylesAndFormulas.processPage(page, {
        skipFormulaOffsetCalculation: false,
        ocrWorkaround: false,
        removeNonFormulaLines: false,
        nonFormulaLineCoverageThreshold: 0.9,
        figureTableProtectionThreshold: 0.9,
        targetFontDirectory: configuration.targetFontDirectory
      }, targetFonts)
    }
    report(onProgress, 'styles', 1, 1)

    return { document, pageResults }
  }

  const runRemainingStages = async (
    document: ILDocument,
    translator: AsyncILTextTranslator,
    onProgress?: (progress: BabelDocProgress) => void
  ): Promise<PipelineTranslateResult> => {
    Typesetting.validateTargetLanguage(configuration.targetLanguage)
    let workingDocument = document
    report(onProgress, 'semantic', 0, 1)
    let semanticResult: SemanticEnrichmentResult | null = null
    let semanticStatus: SemanticHintStatus = 'notProvided'
    let semanticFallbackReason: string | undefined
    let semanticContexts = new Map<string, SemanticParagraphContext>()
    if (configuration.semanticHints) {
      try {
        const enrichedDocument = structuredClone(document)
        semanticResult = SemanticHintEnricher.process(enrichedDocument, configuration.semanticHints, configuration.enricherConfiguration)
        workingDocument = enrichedDocument
        semanticStatus = 'applied'
        semanticContexts = semanticResult.paragraphContexts
      } catch (error) {
        semanticStatus = 'pdfFallback'
        semanticFallbackReason = error instanceof Error ? error.message : String(error)
      }
    }
    report(onProgress, 'semantic', 1, 1)
    const sourceSnapshot = configuration.renderingMode === 'source-preserving'
      ? makeSourceParagraphSnapshot(workingDocument)
      : null

    const translationConfiguration: ILTranslatorConfiguration = {
      minimumTextLength: 5,
      documentTitle: configuration.documentTitle ?? null,
      glossary: configuration.glossary ?? null,
      semanticContexts
    }
    const translationReport = await ILTranslator.processAsync(
      workingDocument, translator, translationConfiguration,
      (completed, total) => report(onProgress, 'translation', completed, total))

    report(onProgress, 'typesetting', 0, 1)
    const failedAddresses = new Set(translationReport.failedParagraphAddresses)
    const typesettingReport = await Typesetting.process(workingDocument, {
      targetLanguage: configuration.targetLanguage,
      targetFontDirectory: configuration.targetFontDirectory,
      preservedParagraphAddresses: failedAddresses
    })
    report(onProgress, 'typesetting', 1, 1)

    report(onProgress, 'backend', 0, 1)
    const sourcePlan = sourceSnapshot
      ? SourcePreservingPlanner.makePlan(workingDocument, sourceSnapshot, typesettingReport)
      : null
    const backend = await NativePDFBackend.write(pdf, workingDocument, {
      renderingMode: configuration.renderingMode,
      skipForms: false,
      skipCurves: false,
      onlyIncludeTranslatedPages: configuration.onlyIncludeTranslatedPages,
      maximumUnmatchedGlyphFraction: configuration.maximumUnmatchedGlyphFraction ?? 0.01,
      targetFontDirectory: configuration.targetFontDirectory
    }, sourcePlan)
    report(onProgress, 'backend', 1, 1)

    return {
      document: workingDocument,
      pdf: backend.pdf,
      diagnostics: {
        semanticHintStatus: semanticStatus,
        semanticFallbackReason,
        semanticEnrichmentReport: semanticResult?.report,
        translationReport,
        backendReport: backend.report
      }
    }
  }

  return {
    async structuredDocument(onProgress?: (progress: BabelDocProgress) => void): Promise<ILDocument> {
      return (await runStructuredStages(onProgress)).document
    },

    async translateStructuredDocument(document: ILDocument, translator: AsyncILTextTranslator, onProgress?: (progress: BabelDocProgress) => void): Promise<PipelineTranslateResult> {
      return runRemainingStages(document, translator, onProgress)
    },

    async translatePDF(
      translator: AsyncILTextTranslator,
      onProgress?: (progress: BabelDocProgress) => void,
      onStructuredDocument?: (document: ILDocument) => void
    ): Promise<PipelineTranslateResult> {
      const { document } = await runStructuredStages(onProgress)
      onStructuredDocument?.(structuredClone(document))
      return runRemainingStages(document, translator, onProgress)
    }
  }
}
