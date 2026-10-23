// Pipeline/LaTeXTranslationPipeline.swift
import {
  TranslationPipelineError, checkCancellation, partiallyTranslatedUnitCode, translationContext, untranslatedUnitCode, validationIssue,
  type CompilationArtifact, type LaTeXProjectCompiling, type LaTeXProjectParsing, type LaTeXProjectReconstructing,
  type LaTeXTranslationValidating, type LaTeXUnit, type LaTeXUnitTranslating, type PipelineEvent, type TranslatedLaTeXUnit,
  type TranslationArtifact, type TranslationContext, type TranslationProjectPreparing, type TranslationRequest, type ValidationIssue
} from './models'
import { sortedStrings } from './text'

export class LaTeXTranslationPipeline {
  constructor(private readonly components: {
    preparer: TranslationProjectPreparing
    parser: LaTeXProjectParsing
    translator: LaTeXUnitTranslating
    validator: LaTeXTranslationValidating
    reconstructor: LaTeXProjectReconstructing
    compiler?: LaTeXProjectCompiling
  }) {}

  async run(request: TranslationRequest, onEvent: (event: PipelineEvent) => void = () => {}, signal?: AbortSignal): Promise<TranslationArtifact> {
    const { preparer, parser, validator, reconstructor, compiler } = this.components
    const { configuration } = request
    checkCancellation(signal)
    onEvent({ stage: 'preparing' })
    const project = await preparer.prepare(request, signal)

    checkCancellation(signal)
    onEvent({ stage: 'parsing' })
    const parsedProject = await parser.parse(project, signal)
    const parsedUnitIDs = parsedProject.units.map((unit) => unit.id)
    if (new Set(parsedUnitIDs).size !== parsedUnitIDs.length) {
      throw new TranslationPipelineError({ kind: 'invalidProject', message: 'The parser returned duplicate LaTeX unit identifiers.' })
    }

    const translatableUnits = parsedProject.units.filter((unit) => unit.shouldTranslate)
    const translatedByID = new Map<string, TranslatedLaTeXUnit>(parsedProject.units
      .filter((unit) => !unit.shouldTranslate)
      .map((unit) => [unit.id, { id: unit.id, kind: unit.kind, source: unit.source, translation: unit.source, completeness: 'complete' }]))

    onEvent({ stage: 'translating', completedUnitCount: 0, totalUnitCount: translatableUnits.length })
    const initialContext = translationContext({
      sourceLanguage: configuration.sourceLanguage,
      targetLanguage: configuration.targetLanguage,
      attempt: 0,
      terminology: configuration.terminology,
      documentSummary: configuration.documentSummary,
      maximumConcurrentTranslations: configuration.maximumConcurrentTranslations,
      previousContextUnitCount: configuration.previousContextUnitCount
    })
    for (const translation of await this.translate(translatableUnits, initialContext, signal)) translatedByID.set(translation.id, translation)
    onEvent({ stage: 'translating', completedUnitCount: translatableUnits.length, totalUnitCount: translatableUnits.length })

    let orderedTranslations = orderedTranslationsFor(parsedProject.units, translatedByID)
    let issues: ValidationIssue[] = []
    let retry = 0

    for (;;) {
      checkCancellation(signal)
      onEvent({ stage: 'validating', detail: `attempt ${retry}` })
      issues = await validator.validate(parsedProject.units, orderedTranslations)

      const failingIDs = new Set(issues.filter((issue) => issue.severity === 'error').map((issue) => issue.unitID))
      if (failingIDs.size === 0 || retry >= configuration.maximumValidationRetries) break

      retry += 1
      const retryUnits = translatableUnits.filter((unit) => failingIDs.has(unit.id))
      const context = translationContext({
        sourceLanguage: configuration.sourceLanguage,
        targetLanguage: configuration.targetLanguage,
        attempt: retry,
        validationIssues: issues.filter((issue) => failingIDs.has(issue.unitID)),
        previousTranslations: orderedTranslations.filter((translation) => failingIDs.has(translation.id)),
        terminology: configuration.terminology,
        documentSummary: configuration.documentSummary,
        maximumConcurrentTranslations: configuration.maximumConcurrentTranslations,
        previousContextUnitCount: configuration.previousContextUnitCount
      })
      onEvent({ stage: 'translating', completedUnitCount: 0, totalUnitCount: retryUnits.length, detail: `validation retry ${retry}` })
      for (const translation of await this.translate(retryUnits, context, signal)) translatedByID.set(translation.id, translation)
      orderedTranslations = orderedTranslationsFor(parsedProject.units, translatedByID)
    }

    const remainingErrors = issues.filter((issue) => issue.severity === 'error')
    if (remainingErrors.length && configuration.validationFailurePolicy === 'fail') {
      throw new TranslationPipelineError({ kind: 'validationFailed', issues })
    }
    issues = [...issues, ...completenessWarnings(orderedTranslations)]

    checkCancellation(signal)
    onEvent({ stage: 'reconstructing' })
    const outputProject = await reconstructor.reconstruct(project, parsedProject, orderedTranslations, configuration, signal)

    let compilation: CompilationArtifact | undefined
    if (configuration.compilationPolicy === 'pdfRequired') {
      if (!compiler) throw new TranslationPipelineError({ kind: 'missingCompiler' })
      checkCancellation(signal)
      onEvent({ stage: 'compiling' })
      compilation = await compiler.compile(outputProject, configuration, signal)
    }

    onEvent({ stage: 'finished' })
    return { projectDirectory: outputProject, pdfPath: compilation?.pdfPath, compilation, units: orderedTranslations, validationIssues: issues }
  }

  private async translate(units: LaTeXUnit[], context: TranslationContext, signal?: AbortSignal): Promise<TranslatedLaTeXUnit[]> {
    if (!units.length) return []
    const translations = await this.components.translator.translate(units, context, signal)
    const expectedIDs = new Set(units.map((unit) => unit.id))
    const receivedIDs = new Set(translations.map((translation) => translation.id))
    if (translations.length !== receivedIDs.size || !sameSet(expectedIDs, receivedIDs)) {
      throw new TranslationPipelineError({ kind: 'invalidTranslationResponse', expectedIDs: sortedStrings(expectedIDs), receivedIDs: sortedStrings(receivedIDs) })
    }
    return translations
  }
}

/**
 * Units whose model output was unusable keep source text; they are reported so the host can
 * tell the user that a rerun will retry them.
 */
export function completenessWarnings(units: TranslatedLaTeXUnit[]): ValidationIssue[] {
  return units.flatMap((unit): ValidationIssue[] => {
    switch (unit.completeness) {
      case 'complete': return []
      case 'partial': return [validationIssue({
        unitID: unit.id,
        severity: 'warning',
        code: partiallyTranslatedUnitCode,
        message: 'Some text in this unit kept its source language because the model output was unusable.'
      })]
      case 'untranslated': return [validationIssue({
        unitID: unit.id,
        severity: 'warning',
        code: untranslatedUnitCode,
        message: 'This unit kept its source text because every model response was unusable.'
      })]
    }
  })
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value))
}

function orderedTranslationsFor(units: LaTeXUnit[], translatedByID: Map<string, TranslatedLaTeXUnit>): TranslatedLaTeXUnit[] {
  const expectedIDs = new Set(units.map((unit) => unit.id))
  const receivedIDs = new Set(translatedByID.keys())
  const failure = (): TranslationPipelineError => new TranslationPipelineError({ kind: 'invalidTranslationResponse', expectedIDs: sortedStrings(expectedIDs), receivedIDs: sortedStrings(receivedIDs) })
  if (!sameSet(expectedIDs, receivedIDs)) throw failure()
  return units.map((unit) => {
    const translation = translatedByID.get(unit.id)
    if (!translation) throw failure()
    return translation
  })
}
