// BabelDocKit: layout-preserving PDF translation for born-digital PDFs.
// A TypeScript port of the Swift BabelDoc pipeline (reWriteBabelDoc), with
// MuPDF compiled to WebAssembly and DocLayout-YOLO running on onnxruntime-node.
export {
  BabelDocRuntimeError, babeldocRuntimeDirectory, fontDirectory, layoutModelPath,
  runtimeManifest, verifyBabelDocRuntime
} from './src/runtime'
export type { RuntimeFileIssue, RuntimeManifest, RuntimeVerification } from './src/runtimeValidate'
export { describeRuntimeIssues, validateRuntimeDirectory } from './src/runtimeValidate'
export {
  BabelDocWasmError, babeldocWasmDirectory, loadBabelDocWasm, wasmManifest
} from './src/wasm'
export type { BabelDocWasmBundle, WasmManifest } from './src/wasm'
export { babelDocWasm, type BabelDocWasmModule, type RenderedPage } from './src/wasmModule'
export { extractFrontend, BabelDocFrontendError, type FrontendExtraction } from './src/frontend'
export { loadPDFPages, type DocumentPageInput, type LoadedDocumentInput } from './src/documentLoader'
export { makeModelInput, type ModelInput } from './src/imagePreprocessor'
export {
  BabelDocLayoutError, LayoutDetector, disposeLayoutSession,
  type LayoutDetection, type LayoutDetectorConfiguration, type PageLayoutResult
} from './src/layoutDetector'
export {
  BabelDocLayoutParseError, LayoutParser, makePageLayouts
} from './src/layoutParser'
export { LayoutHelper, type CharacterLayout } from './src/layoutHelper'
export {
  buildDocumentIntermediateLayer, type DocumentIntermediateLayer, type IntermediatePage,
  type LayoutClassCount, type PageContentAvailability, type PageDebugMetadata, type PageInputSnapshot
} from './src/documentIntermediateLayer'
export {
  ParagraphFinder, ParagraphFinderError, defaultParagraphFinderConfiguration,
  type ParagraphFinderConfiguration
} from './src/paragraphFinder'
export {
  LayoutContinuation, type MergedInput, type SemanticParagraphAddress
} from './src/layoutContinuation'
export { TableOfContentsDotLeader } from './src/tableOfContentsDotLeader'
export { TableParserCompatibility, type TableParserMode, type TableParserPageDetections } from './src/tableParserCompatibility'
export { CodeTextClassifier } from './src/codeTextClassifier'
export {
  classificationFontNames, createTargetFontMapper, loadTargetFonts, targetFontFamily,
  type TargetFont, type TargetFontFamilyKey, type TargetFontMapper
} from './src/targetFonts'
export {
  StylesAndFormulas, defaultStylesAndFormulasConfiguration,
  type StylesAndFormulasConfiguration
} from './src/stylesAndFormulas'
export {
  Typesetting, addressKey, defaultTypesettingConfiguration,
  type TypesettingConfiguration, type TypesettingPageReport, type TypesettingParagraphReport,
  type TypesettingReport, type TypesettingSourceUnit
} from './src/typesetting'
export {
  makeSourceParagraphSnapshot, SourcePreservingPlanner, userBoxToIL, userSpaceOffset, unionBoxes,
  type GlyphRole, type PlanGlyph, type PlanPlacement, type SourceGlyphAnchor,
  type SourceParagraphSnapshot, type SourcePreservingDocumentPlan, type SourcePreservingPagePlan
} from './src/sourcePreservingPlan'
export {
  NativePDFBackend, PDFContentStreamRenderer, defaultBackendConfiguration, pipelineRenderingMode,
  type BackendFallbackReason, type BackendOutcome, type BackendPageReport,
  type NativePDFBackendConfiguration, type NativePDFBackendReport, type NativePDFRenderingMode
} from './src/pdfBackend'
export { ensureWriterFontsLoaded, fontDirectory as writerFontDirectory } from './src/pdfBackendFonts'
export {
  defaultFormulaPlaceholderProvider, hasExactlyOneOfEachPlaceholder,
  type FormulaPlaceholder, type ILFormulaPlaceholderProviding, type TranslateInput
} from './src/translatorTypes'
export * from './src/il'
export { LetterboxTransform, PageCoordinateConverter, type FloatBox, type IntSize } from './src/geometry'
export { BabelDocModelMetadata } from './src/modelMetadata'
export {
  createPipeline, stageBridgeNames, stageDisplayNames, stageOrder, structuredDocumentVersion,
  type BabelDocPipelineConfiguration, type BabelDocPipelineDiagnostics,
  type BabelDocProgress, type BabelDocStage, type PipelineTranslateResult
} from './src/pipeline'
export {
  ILTranslationOutputError, defaultSystemPrompt, echoesPromptEnvelope, userPromptSections,
  type AsyncILTextTranslator, type ILTranslationContext, type ILTranslationReport
} from './src/translator'
export {
  semanticHintsSchemaVersion, validateSemanticDocument,
  type BabelDocSemanticBlock, type BabelDocSemanticBlockKind, type BabelDocSemanticDocument
} from './src/semanticHints'
