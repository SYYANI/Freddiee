export { RGBImage } from './bitmap'
export { LatexError, MarkupError, PageFailure, RebuildError, type RebuildErrorReason, type RebuildStage } from './errors'
export type { OcrLine, PageLayout, PageMeasure } from './geometry'
export type { LineMode } from './lineBreaks'
export { PageMarkup } from './markup'
export {
  CheckpointedModel, type RebuildCompletion, type RebuildCompletionRequest, type RebuildMessage, type RebuildMessagePart,
  type RebuildModelClient, type RebuildUsage, plainText
} from './model'
export {
  RebuildPipeline, type RebuildConfiguration, type RebuildPageReport, type RebuildProgress, type RebuildProgressStage,
  type RebuildResult, fractionCompleted
} from './pipeline'
export { RebuildPrompts } from './prompts'
export { verifyTeXInstallation } from './texCheck'
export { TesseractTextRecognizer, type TextRecognizing } from './textRecognition'
export { type RebuildTranslationTarget, simplifiedChinese } from './translation'
export { type CompileResult, type TeXCompiling, XeLaTeXCompiler } from './xelatex'
