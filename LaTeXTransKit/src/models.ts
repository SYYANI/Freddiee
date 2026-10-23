// Models/*.swift and Pipeline/PipelineProtocols.swift, PipelineEvent.swift, TranslationPipelineError.swift

export type TranslationProjectSource =
  | { kind: 'localDirectory'; path: string }
  | { kind: 'localArchive'; path: string }
  | { kind: 'arxiv'; identifier: string }

export interface TranslationRequest {
  source: TranslationProjectSource
  workspaceDirectory: string
  configuration: TranslationConfiguration
}

export interface PreparedProject {
  identifier: string
  sourceDirectory: string
  workspaceDirectory: string
}

export interface TranslationArtifact {
  projectDirectory: string
  pdfPath?: string
  compilation?: CompilationArtifact
  units: TranslatedLaTeXUnit[]
  validationIssues: ValidationIssue[]
}

// MARK: Configuration

export type TranslationLanguage = string

export const TranslationLanguages = {
  english: 'en',
  simplifiedChinese: 'zh-Hans',
  japanese: 'ja'
} as const

export type CompilationPolicy = 'sourceOnly' | 'pdfRequired'
export type ValidationFailurePolicy = 'fail' | 'continueWithIssues'

export interface TerminologyEntry {
  source: string
  target: string
}

export interface TranslationConfiguration {
  sourceLanguage: TranslationLanguage
  targetLanguage: TranslationLanguage
  maximumValidationRetries: number
  compilationPolicy: CompilationPolicy
  validationFailurePolicy: ValidationFailurePolicy
  maximumConcurrentTranslations: number
  previousContextUnitCount: number
  terminology: TerminologyEntry[]
  documentSummary?: string
}

export function translationConfiguration(options: Partial<TranslationConfiguration> = {}): TranslationConfiguration {
  return {
    sourceLanguage: options.sourceLanguage ?? TranslationLanguages.english,
    targetLanguage: options.targetLanguage ?? TranslationLanguages.simplifiedChinese,
    maximumValidationRetries: Math.max(0, options.maximumValidationRetries ?? 3),
    compilationPolicy: options.compilationPolicy ?? 'sourceOnly',
    validationFailurePolicy: options.validationFailurePolicy ?? 'fail',
    maximumConcurrentTranslations: Math.max(1, options.maximumConcurrentTranslations ?? 10),
    previousContextUnitCount: Math.max(0, options.previousContextUnitCount ?? 1),
    terminology: options.terminology ?? [],
    documentSummary: options.documentSummary
  }
}

// MARK: Validation

export type ValidationSeverity = 'warning' | 'error'

export interface ValidationIssue {
  id: string
  unitID: string
  severity: ValidationSeverity
  code: string
  message: string
}

/** Warning code for a unit that kept all of its source text. */
export const untranslatedUnitCode = 'untranslated-unit'
/** Warning code for a unit in which some slots kept their source text. */
export const partiallyTranslatedUnitCode = 'partially-translated-unit'

export function validationIssue(issue: Omit<ValidationIssue, 'id'> & { id?: string }): ValidationIssue {
  return { id: issue.id ?? `${issue.unitID}:${issue.code}`, unitID: issue.unitID, severity: issue.severity, code: issue.code, message: issue.message }
}

export interface TranslationContext {
  sourceLanguage: TranslationLanguage
  targetLanguage: TranslationLanguage
  attempt: number
  validationIssues: ValidationIssue[]
  previousTranslations: TranslatedLaTeXUnit[]
  terminology: TerminologyEntry[]
  documentSummary?: string
  maximumConcurrentTranslations: number
  previousContextUnitCount: number
}

export function translationContext(context: Pick<TranslationContext, 'sourceLanguage' | 'targetLanguage' | 'attempt'> & Partial<TranslationContext>): TranslationContext {
  return {
    sourceLanguage: context.sourceLanguage,
    targetLanguage: context.targetLanguage,
    attempt: context.attempt,
    validationIssues: context.validationIssues ?? [],
    previousTranslations: context.previousTranslations ?? [],
    terminology: context.terminology ?? [],
    documentSummary: context.documentSummary,
    maximumConcurrentTranslations: Math.max(1, context.maximumConcurrentTranslations ?? 10),
    previousContextUnitCount: Math.max(0, context.previousContextUnitCount ?? 1)
  }
}

// MARK: Document

export type LaTeXUnitKind = 'document' | 'section' | 'caption' | 'environment'

export interface LaTeXUnit {
  id: string
  kind: LaTeXUnitKind
  source: string
  shouldTranslate: boolean
}

/**
 * How much of a unit's natural-language content the accepted model response covered:
 * every slot (`complete`), some slots with others kept as source (`partial`), or none.
 */
export type LaTeXTranslationCompleteness = 'complete' | 'partial' | 'untranslated'

export interface TranslatedLaTeXUnit {
  id: string
  kind: LaTeXUnitKind
  source: string
  translation: string
  completeness: LaTeXTranslationCompleteness
}

export interface ParsedLaTeXProject {
  mainFile: string
  units: LaTeXUnit[]
  inputs: LaTeXInputBoundary[]
  environments: LaTeXEnvironment[]
  captions: LaTeXCaption[]
  newCommands: LaTeXNewCommand[]
  sections: LaTeXSection[]
}

// The JSON names of these maps match the pinned LaTeXTrans reference artifacts.

export interface LaTeXInputBoundary {
  command: string
  begin: string
  end: string
  path: string
}

export interface LaTeXEnvironment {
  placeholder: string
  env_name: string
  content: string
  trans_content: string
  need_trans: boolean
}

export interface LaTeXCaption {
  placeholder: string
  cap_type: string
  content: string
  trans_content: string
}

export interface LaTeXNewCommand {
  placeholder: string
  name: string
  content: string
}

export interface LaTeXSection {
  section: string
  content: string
  trans_content: string
}

// MARK: Pipeline

export type PipelineStage = 'preparing' | 'parsing' | 'translating' | 'validating' | 'reconstructing' | 'compiling' | 'finished'

export interface PipelineEvent {
  stage: PipelineStage
  completedUnitCount?: number
  totalUnitCount?: number
  detail?: string
}

export interface TranslationProjectPreparing {
  prepare(request: TranslationRequest, signal?: AbortSignal): Promise<PreparedProject>
}

export interface LaTeXProjectParsing {
  parse(project: PreparedProject, signal?: AbortSignal): Promise<ParsedLaTeXProject>
}

export interface LaTeXUnitTranslating {
  translate(units: LaTeXUnit[], context: TranslationContext, signal?: AbortSignal): Promise<TranslatedLaTeXUnit[]>
}

export interface LaTeXTranslationValidating {
  validate(sourceUnits: LaTeXUnit[], translatedUnits: TranslatedLaTeXUnit[]): Promise<ValidationIssue[]>
}

export interface LaTeXProjectReconstructing {
  reconstruct(project: PreparedProject, parsedProject: ParsedLaTeXProject, translatedUnits: TranslatedLaTeXUnit[], configuration: TranslationConfiguration, signal?: AbortSignal): Promise<string>
}

export type LaTeXCompilerEngine = 'pdflatex' | 'xelatex' | 'lualatex'

export interface CompilationAttempt {
  engine: LaTeXCompilerEngine
  exitCode?: number
  succeeded: boolean
  durationMilliseconds: number
  logPaths: string[]
}

export interface CompilationArtifact {
  pdfPath: string
  logPaths: string[]
  attempts: CompilationAttempt[]
}

export interface LaTeXProjectCompiling {
  compile(projectDirectory: string, configuration: TranslationConfiguration, signal?: AbortSignal): Promise<CompilationArtifact>
}

// MARK: Errors

/** Swift's `CancellationError`: work stopped because the caller cancelled it. */
export function checkCancellation(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
}

/** Swift's description of a `[String]`, such as `["a", "b"]`. */
export const arrayDescription = (values: string[]): string => `[${values.map((value) => JSON.stringify(value)).join(', ')}]`

const describeSource = (source: TranslationProjectSource): string => {
  switch (source.kind) {
    case 'localDirectory': return `localDirectory(${source.path})`
    case 'localArchive': return `localArchive(${source.path})`
    case 'arxiv': return `arxiv(identifier: "${source.identifier}")`
  }
}

export type TranslationPipelineErrorReason =
  | { kind: 'unsupportedSource'; source: TranslationProjectSource }
  | { kind: 'missingCompiler' }
  | { kind: 'invalidTranslationResponse'; expectedIDs: string[]; receivedIDs: string[] }
  | { kind: 'validationFailed'; issues: ValidationIssue[] }
  | { kind: 'invalidProject'; message: string }

export class TranslationPipelineError extends Error {
  constructor(readonly reason: TranslationPipelineErrorReason) {
    super(TranslationPipelineError.describe(reason))
    this.name = 'TranslationPipelineError'
  }

  private static describe(reason: TranslationPipelineErrorReason): string {
    switch (reason.kind) {
      case 'unsupportedSource': return `The project source is not supported by the configured preparer: ${describeSource(reason.source)}.`
      case 'missingCompiler': return 'PDF output was requested, but no LaTeX compiler was configured.'
      case 'invalidTranslationResponse': return `The translator returned an invalid unit set. Expected ${arrayDescription(reason.expectedIDs)}, received ${arrayDescription(reason.receivedIDs)}.`
      case 'validationFailed': return `LaTeX validation failed with ${reason.issues.length} issue(s).`
      case 'invalidProject': return reason.message
    }
  }
}

export type LaTeXParserErrorReason =
  | { kind: 'mainFileNotFound'; projectDirectory: string }
  | { kind: 'emptyMainFile'; path: string }
  | { kind: 'invalidUTF8'; path: string }
  | { kind: 'unsafePath'; path: string }
  | { kind: 'includeNotFound'; path: string }
  | { kind: 'recursiveInclude'; chain: string[] }
  | { kind: 'malformedCommand'; command: string; path: string }
  | { kind: 'includeDepthExceeded'; limit: number }
  | { kind: 'includedFileCountExceeded'; limit: number }
  | { kind: 'sourceCharacterLimitExceeded'; limit: number }

export class LaTeXParserError extends Error {
  constructor(readonly reason: LaTeXParserErrorReason) {
    super(LaTeXParserError.describe(reason))
    this.name = 'LaTeXParserError'
  }

  private static describe(reason: LaTeXParserErrorReason): string {
    switch (reason.kind) {
      case 'mainFileNotFound': return `No main TeX file was found in ${reason.projectDirectory}.`
      case 'emptyMainFile': return `The main TeX file is empty: ${reason.path}.`
      case 'invalidUTF8': return `The TeX file is not valid UTF-8: ${reason.path}.`
      case 'unsafePath': return `The LaTeX project contains an unsafe path: ${reason.path}.`
      case 'includeNotFound': return `An included TeX file was not found: ${reason.path}.`
      case 'recursiveInclude': return `A recursive LaTeX include was detected: ${reason.chain.join(' -> ')}.`
      case 'malformedCommand': return `The LaTeX command \\(${reason.command}) is malformed in ${reason.path}.`
      case 'includeDepthExceeded': return `The LaTeX include depth exceeds the limit of ${reason.limit}.`
      case 'includedFileCountExceeded': return `The LaTeX project includes more than ${reason.limit} TeX files.`
      case 'sourceCharacterLimitExceeded': return `The expanded LaTeX source exceeds the limit of ${reason.limit} characters.`
    }
  }
}
