import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PDFDocument as PDFLibDocument } from 'pdf-lib'
import { atomicWriteFile } from '../../electron/main/files'
import { RGBImage, splitRows } from './bitmap'
import { coverageTokens, coverageWarnings, lineInFigures, markupPlain, placeColumnBreaks, restoreVerticalGaps } from './coverage'
import { type LayoutSummary, documentLayouts } from './documentLayout'
import { LatexError, MarkupError, PageFailure, RebuildError, type RebuildStage, errorMessage, isCancellation } from './errors'
import { frameHints, prepareFigures, validateFigureRegions } from './figures'
import { type OcrLine, type PageLayout, type PageMeasure, measurePage } from './geometry'
import type { LineMode } from './lineBreaks'
import { PageMarkup, stripFences } from './markup'
import {
  CheckpointedModel, type RebuildMessage, type RebuildMessagePart, type RebuildModelClient, type RebuildUsage,
  addUsage, emptyUsage, sha256Hex, sortedJSON, textMessage
} from './model'
import { Pattern, PythonNumber, PythonText } from './pattern'
import { type PDFDocument, closePDF, openPDF, pageSize, renderPage } from './pdf'
import { RebuildPrompts } from './prompts'
import type { TranslationFitReport } from './translationLayout'
import { columnBottoms, fitTranslationLayout } from './translationLayout'
import { type RebuildTranslationTarget, alignTranslationParagraphs, columnsLevel, releaseColumnBreaks, translateMarkup } from './translation'
import type { TextRecognizing } from './textRecognition'
import type { TranslationTypography } from './texSource'
import { type CompileResult, type TeXCompiling, typesetPage } from './xelatex'

/** What to rebuild and how. */
export interface RebuildConfiguration {
  /** Page rendering resolution for the model and for measurement. */
  dpi: number
  /** Rounds of proofreading the rebuilt page against the scan; 0 skips proofreading. */
  reviewRounds: number
  maximumConcurrentPages: number
  /** 1-based pages to rebuild; undefined rebuilds every page. Other pages keep the original. */
  pages?: number[]
  /** Translate the rebuilt pages; undefined produces a clean rebuild of the original text. */
  translation?: RebuildTranslationTarget
  /** undefined uses `reflow` for translations and `keep` otherwise. */
  lineMode?: LineMode
  /** Ignore checkpoints. With a translation this only redoes the translation. */
  force: boolean
}

export function rebuildConfiguration(values: Partial<RebuildConfiguration> = {}): RebuildConfiguration {
  return { dpi: 240, reviewRounds: 1, maximumConcurrentPages: 4, force: false, ...values }
}

export type RebuildProgressStage = 'rendering' | 'transcribing' | 'reviewing' | 'translating' | 'typesetting' | 'assembling'

/**
 * Progress of a run. Work is counted in page steps: every chosen page is transcribed,
 * proofread when review rounds are enabled, translated when a translation is requested,
 * and typeset.
 */
export interface RebuildProgress {
  stage: RebuildProgressStage
  completedSteps: number
  totalSteps: number
  /** The page whose step just finished, if any. */
  page?: number
  /** The page's step was served from a checkpoint without calling the model. */
  fromCheckpoint: boolean
}

export function fractionCompleted(progress: RebuildProgress): number {
  return progress.totalSteps > 0 ? progress.completedSteps / progress.totalSteps : 0
}

/** What happened to one page. */
export interface RebuildPageReport {
  page: number
  edited: boolean
  review_rounds: number
  changes: string[]
  notes: string[]
  figures: string[]
  usage: RebuildUsage
  /** Why the original page was kept, when it was. */
  fallback?: string
  /** Why the page was typeset from its last validated markup without finishing its review. */
  review_failure?: string
  type_scale?: number
  warnings: string[]
  reduced_paragraphs: number[]
  /** How far the vertical gaps were narrowed to fit the page, when they were. */
  vertical_space_scale?: number
  body_size_pt?: number
  max_overfull_pt?: number
  translation_layout?: TranslationFitReport
}

export interface RebuildResult {
  output: string
  /**
   * The corrected transcription in the original language, when a translation run was asked
   * to assemble it (`sourceOutput`). Without a translation, `output` is that transcription.
   */
  sourceOutput?: string
  /** Pages typeset in `sourceOutput`; the others are the original pages. */
  sourceRebuiltPages: number[]
  /** Every page of the output, in order; the length of the input document. */
  pageCount: number
  chosenPages: number[]
  rebuiltPages: number[]
  /** Chosen pages that kept the original page, with the reason. */
  fallbacks: Map<number, string>
  usage: RebuildUsage
  reports: RebuildPageReport[]
  /** manifest.json with the layout and per-page reports. */
  manifest: string
}

/** One page's checkpoint: the model's draft, the current markup and how it got there. */
export interface PageState {
  key: string
  draft: string
  final: string
  rounds: number
  changes: string[]
  usage: RebuildUsage
  edited: boolean
  source_sha256?: string
  target?: string
}

function pageState(key: string, draft: string, final: string, usage = emptyUsage(), edited = false): PageState {
  return { key, draft, final, rounds: 0, changes: [], usage, edited }
}

function copyState(state: PageState): PageState {
  return { ...state, changes: [...state.changes], usage: { ...state.usage } }
}

const pad = (number: number): string => String(number).padStart(4, '0')
const sorted = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b)

/** Pages measured, selected or not, when only some pages are rebuilt. */
const layoutSampleCount = 8

/**
 * `layout_samples`: unselected pages, spread over the document, measured but not rebuilt.
 *
 * A few selected pages then share the document's text area and type size instead of
 * what one page alone suggests; a page that is mostly drawing has little text to measure.
 */
export function layoutSamples(pageCount: number, chosen: readonly number[]): number[] {
  const selected = new Set(chosen)
  const others: number[] = []
  for (let page = 1; page <= Math.max(1, pageCount); page += 1) if (!selected.has(page) && page <= pageCount) others.push(page)
  const wanted = Math.min(others.length, Math.max(0, layoutSampleCount - chosen.length))
  return Array.from({ length: wanted }, (_, index) => others[Math.trunc((2 * index + 1) * others.length / (2 * wanted))])
}

/** Counts finished page steps and reports progress to the host. */
class ProgressTracker {
  private completed = 0

  constructor(private readonly total: number, private readonly report: (progress: RebuildProgress) => void) {}

  advance(stage: RebuildProgressStage, page: number, cached: boolean): void {
    this.completed = Math.min(this.total, this.completed + 1)
    this.report({ stage, completedSteps: this.completed, totalSteps: this.total, page, fromCheckpoint: cached })
  }

  /** A page dropped out of the run; its remaining steps count as done. */
  skip(remainingSteps: number): void {
    this.completed = Math.min(this.total, this.completed + Math.max(0, remainingSteps))
  }

  announce(stage: RebuildProgressStage, page?: number): void {
    this.report({ stage, completedSteps: this.completed, totalSteps: this.total, page, fromCheckpoint: false })
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: PageFailure }

/** The pages of the input, their renderings and the shared compiler. */
class PageContext {
  private readonly cache = new Map<number, RGBImage>()

  constructor(
    readonly document: PDFDocument,
    readonly images: Map<number, string>,
    readonly pageSizes: Map<number, { width: number; height: number }>,
    readonly compiler: TeXCompiling,
    readonly work: string
  ) {}

  async image(number: number): Promise<RGBImage> {
    const cached = this.cache.get(number)
    if (cached) {
      this.cache.delete(number)
      this.cache.set(number, cached)
      return cached
    }
    const path = this.images.get(number)
    let image: RGBImage
    try {
      if (!path) throw new Error('missing')
      image = await RGBImage.decode(new Uint8Array(await readFile(path)))
    } catch {
      throw new RebuildError({ kind: 'renderingFailed', page: number })
    }
    this.cache.set(number, image)
    // A few decoded pages are kept: each stage looks at a page several times in a row.
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!)
    return image
  }

  /** `compile_page`: crop the figures and typeset one page into its build directory. */
  async compile(number: number, markup: PageMarkup, layout: PageLayout, mode: LineMode, directory?: string, typography?: TranslationTypography): Promise<CompileResult> {
    const build = join(directory ?? this.work, `build-${pad(number)}`)
    const figures = markup.figures.isEmpty
      ? []
      : await prepareFigures(markup, await this.image(number), await this.document.getPage(number), layout, build)
    return typesetPage({ directory: build, markup, layout, figures, lineMode: mode, compiler: this.compiler, typography })
  }
}

interface RequestedMarkup {
  markup?: PageMarkup
  usage: RebuildUsage
  summary: string
  longLines: string[]
  /** A review exhausted validation retries; keep the page that was already typeset. */
  rejection?: string
}

interface Drafted { state: PageState; fromCheckpoint: boolean }
interface Reviewed { state: PageState; fromCheckpoint: boolean; failure?: string }
interface Typeset { report?: RebuildPageReport; pdf?: string; sourcePDF?: string }

const changesPattern = new Pattern('<changes>(.*?)</changes>', { dotAll: true })
const bulletPattern = new Pattern(String.raw`^\s*-\s+`)

/**
 * Rebuilds scanned pages as typeset PDF pages, optionally translated.
 *
 * The steps follow the Python `rebuild-pdf` package: render each page, measure its text
 * area, have a vision model transcribe it as constrained LaTeX, proofread the typeset page
 * against the scan, translate the markup, typeset it with XeLaTeX on the original page
 * geometry and assemble a PDF with the same pages as the input. Every model answer and
 * page state is checkpointed under the artifacts directory, so an interrupted run resumes
 * without paying again. Pages that fail keep the original page and are reported.
 */
export class RebuildPipeline {
  readonly configuration: RebuildConfiguration

  constructor(readonly options: {
    transcriber: RebuildModelClient
    translator?: RebuildModelClient
    recognizer: TextRecognizing
    compiler: TeXCompiling
    configuration?: Partial<RebuildConfiguration>
    signal?: AbortSignal
  }) {
    this.configuration = rebuildConfiguration(options.configuration)
  }

  private get signal(): AbortSignal | undefined { return this.options.signal }

  // MARK: - Run

  /**
   * `sourceOutput`: with a translation, also assemble the corrected transcription (the
   * proofread original-language pages) here. Every transcribed page is typeset for it,
   * including pages whose translation failed.
   */
  async run(input: string, output: string, artifacts: string, sourceOutput?: string, progress: (progress: RebuildProgress) => void = () => undefined): Promise<RebuildResult> {
    await mkdir(artifacts, { recursive: true })
    let sourceData: Uint8Array
    let document: PDFDocument
    try {
      sourceData = new Uint8Array(await readFile(input))
      document = await openPDF(sourceData)
    } catch {
      throw new RebuildError({ kind: 'unreadableInput' })
    }
    try {
      if (document.numPages <= 0) throw new RebuildError({ kind: 'unreadableInput' })
      return await this.runDocument(input, sourceData, document, output, artifacts, sourceOutput, progress)
    } finally {
      await closePDF(document)
    }
  }

  private async runDocument(
    input: string, sourceData: Uint8Array, document: PDFDocument, output: string, artifacts: string,
    sourceOutput: string | undefined, progress: (progress: RebuildProgress) => void
  ): Promise<RebuildResult> {
    const { configuration } = this
    const pageCount = document.numPages
    const requested = configuration.pages ?? Array.from({ length: pageCount }, (_, index) => index + 1)
    const chosen = sorted(new Set(requested.filter((page) => page >= 1 && page <= pageCount)))
    if (!chosen.length) throw new RebuildError({ kind: 'unreadableInput' })
    const translation = configuration.translation
    const lineMode: LineMode = configuration.lineMode ?? (translation ? 'reflow' : 'keep')
    const sourceLineMode: LineMode = translation ? 'keep' : lineMode
    const sourceForce = configuration.force && !translation
    const sourceHash = sha256Hex(sourceData)
    const samples = layoutSamples(pageCount, chosen)
    const pageSizes = new Map<number, { width: number; height: number }>()
    for (const number of [...chosen, ...samples]) {
      try {
        pageSizes.set(number, pageSize(await document.getPage(number)))
      } catch {
        throw new RebuildError({ kind: 'unreadableInput' })
      }
    }

    const steps = 2 + (configuration.reviewRounds > 0 ? 1 : 0) + (translation ? 1 : 0)
    const tracker = new ProgressTracker(chosen.length * steps, progress)

    const images = await this.renderPages(document, chosen, samples, sourceHash, artifacts, sourceForce, tracker)
    const context = new PageContext(document, images, pageSizes, this.options.compiler, join(artifacts, 'typeset'))
    await mkdir(context.work, { recursive: true })
    const transcription = new CheckpointedModel(this.options.transcriber, join(artifacts, 'responses'), sourceForce, 32_768, this.signal)
    const identity = JSON.stringify({
      model: this.options.transcriber.identity, review: RebuildPrompts.review,
      transcribe: RebuildPrompts.transcribe, version: RebuildPrompts.typesetVersion
    })

    // 1. Recognize and measure each page, and the unselected pages that only share their text area.
    const lines = new Map<number, OcrLine[]>()
    const measures = new Map<number, PageMeasure>()
    const references = new Map<number, PageMeasure>()
    const states = new Map<number, PageState>()
    const failures = new Map<number, PageFailure>()
    const unreviewed = new Map<number, string>()
    await this.forEachPage(samples, 'transcribing', (number) => this.recognize(number, context), (number, outcome) => {
      if (outcome.ok) references.set(number, outcome.value.measure)
    })
    await this.forEachPage(chosen, 'transcribing', (number) => this.recognize(number, context), (number, outcome) => {
      if (outcome.ok) {
        lines.set(number, outcome.value.lines)
        measures.set(number, outcome.value.measure)
      } else {
        failures.set(number, outcome.failure)
        tracker.advance('transcribing', number, false)
        tracker.skip(steps - 1)
      }
    })
    // Every measured page shapes the shared measure, also one whose transcription fails.
    const allMeasures = new Map([...references, ...measures])

    // 2. Transcribe each page.
    await this.forEachPage(chosen.filter((page) => measures.has(page)), 'transcribing', (number) =>
      this.draft(number, lines.get(number)!, allMeasures, context, identity, transcription, sourceLineMode, sourceForce), (number, outcome) => {
      if (outcome.ok) {
        states.set(number, outcome.value.state)
        tracker.advance('transcribing', number, outcome.value.fromCheckpoint)
      } else {
        failures.set(number, outcome.failure)
        tracker.advance('transcribing', number, false)
        tracker.skip(steps - 1)
      }
    })
    const firstFailure = (): string => chosen.map((page) => failures.get(page)?.message).find((message) => message !== undefined) ?? ''
    if (!states.size) throw new RebuildError({ kind: 'noPagesRebuilt', firstFailure: firstFailure() })

    const currentLayouts = (): { layouts: Map<number, PageLayout>; summary: LayoutSummary } => {
      const pages = chosen.filter((page) => states.has(page))
      return documentLayouts(allMeasures, pages.map((page) => ({ page, markup: PageMarkup.parse(states.get(page)!.final) })))
    }
    await RebuildPipeline.settleColumnBreaks(states, lines, measures, context)
    let { layouts, summary } = currentLayouts()
    await RebuildPipeline.settleVerticalGaps(states, lines, measures, layouts, context)

    // 3. Proofread the typeset pages against the scan.
    if (configuration.reviewRounds > 0) {
      const layoutsSnapshot = layouts
      const startingStates = new Map(states)
      await this.forEachPage(chosen.filter((page) => states.has(page)), 'reviewing', (number) =>
        this.review(number, startingStates.get(number)!, layoutsSnapshot.get(number)!, allMeasures, lines.get(number) ?? [], context, transcription, sourceLineMode),
      (number, outcome) => {
        if (outcome.ok) {
          states.set(number, outcome.value.state)
          if (outcome.value.failure !== undefined) unreviewed.set(number, outcome.value.failure)
          else unreviewed.delete(number)
          tracker.advance('reviewing', number, outcome.value.fromCheckpoint)
        } else {
          failures.set(number, outcome.failure)
          states.delete(number)
          tracker.advance('reviewing', number, false)
          tracker.skip(steps - 2)
        }
      })
      if (!states.size) throw new RebuildError({ kind: 'noPagesRebuilt', firstFailure: firstFailure() })
      await RebuildPipeline.settleColumnBreaks(states, lines, measures, context)
      ;({ layouts, summary } = currentLayouts())
      await RebuildPipeline.settleVerticalGaps(states, lines, measures, layouts, context)
    }

    // 4. Translate the proofread markup.
    const reportDirectory = translation ? join(artifacts, 'translations', translation.code) : artifacts
    const outputWork = translation ? join(reportDirectory, 'typeset') : context.work
    await mkdir(outputWork, { recursive: true })
    let outputStates = new Map(states)
    if (translation) {
      const translator = this.options.translator
      if (!translator) throw new RebuildError({ kind: 'noPagesRebuilt', firstFailure: 'no translation model is configured' })
      const translating = new CheckpointedModel(translator, join(artifacts, 'responses'), configuration.force, 32_768, this.signal)
      outputStates = new Map()
      const layoutsSnapshot = layouts
      const sourceStates = new Map(states)
      await this.forEachPage(chosen.filter((page) => states.has(page)), 'translating', (number) =>
        this.translate(number, sourceStates.get(number)!, layoutsSnapshot.get(number)!, translation, context, outputWork, translating, lineMode),
      (number, outcome) => {
        if (outcome.ok) {
          outputStates.set(number, outcome.value.state)
          tracker.advance('translating', number, outcome.value.fromCheckpoint)
        } else {
          // The page is still typeset for the corrected transcription.
          failures.set(number, outcome.failure)
          tracker.advance('translating', number, false)
        }
      })
    }

    // 5. Typeset every transcribed page: the translation where there is one, and the
    //    corrected transcription that the translation is fitted against.
    const rendered = new Map<number, string>()
    const sourceRendered = new Map<number, string>()
    const reports = new Map<number, RebuildPageReport>()
    const layoutsSnapshot = layouts
    const sourceStates = new Map(states)
    const finalStates = new Map(outputStates)
    await this.forEachPage(chosen.filter((page) => sourceStates.has(page)), 'typesetting', (number) => this.typesetFinal(
      number, finalStates.get(number), sourceStates.get(number)!, layoutsSnapshot.get(number)!, measures.get(number),
      lines.get(number) ?? [], context, outputWork, lineMode, translation !== undefined
    ), (number, outcome) => {
      if (outcome.ok) {
        if (outcome.value.report) reports.set(number, outcome.value.report)
        if (outcome.value.pdf) rendered.set(number, outcome.value.pdf)
        if (outcome.value.sourcePDF) sourceRendered.set(number, outcome.value.sourcePDF)
      } else {
        failures.set(number, outcome.failure)
      }
      tracker.advance('typesetting', number, false)
    })
    for (const number of chosen) {
      if (reports.has(number)) continue
      const failure = failures.get(number) ?? new PageFailure('typesetting', 'the page was not processed')
      reports.set(number, {
        page: number, edited: false, review_rounds: states.get(number)?.rounds ?? 0, changes: [], notes: [], figures: [],
        usage: (outputStates.get(number) ?? states.get(number))?.usage ?? emptyUsage(),
        fallback: `${failure.stage}: ${failure.message}`, warnings: [], reduced_paragraphs: []
      })
    }
    for (const [number, failure] of unreviewed) {
      const report = reports.get(number)
      if (report) report.review_failure = failure
    }

    // 6. Assemble the output with the original pages wherever no rebuild exists.
    tracker.announce('assembling')
    await assemble(sourceData, output, rendered)
    const assembledSource = translation ? sourceOutput : undefined
    if (assembledSource) await assemble(sourceData, assembledSource, sourceRendered)

    const orderedReports = chosen.flatMap((page) => reports.has(page) ? [reports.get(page)!] : [])
    let usage = emptyUsage()
    for (const number of chosen) usage = addUsage(usage, (outputStates.get(number) ?? states.get(number))?.usage ?? emptyUsage())
    const manifest = join(reportDirectory, 'manifest.json')
    await writeJSON(manifest, {
      input, output, transcription_model: this.options.transcriber.identity,
      translation_model: translation ? this.options.translator?.identity : undefined, dpi: configuration.dpi,
      ocr: 'tesseract', line_breaks: lineMode, review_rounds: configuration.reviewRounds,
      typeset_version: RebuildPrompts.typesetVersion, source_sha256: sourceHash, pages: chosen, layout: summary,
      translate: translation?.code, source_output: assembledSource,
      source_pages: assembledSource ? sorted(sourceRendered.keys()) : undefined, usage, page_reports: orderedReports
    })
    const fallbacks = new Map<number, string>()
    for (const report of orderedReports) if (report.fallback !== undefined) fallbacks.set(report.page, report.fallback)
    await writeJSON(join(reportDirectory, 'status.json'), {
      pages: chosen, completed: sorted(rendered.keys()), stage: 'typeset',
      failed: Object.fromEntries([...fallbacks].map(([page, reason]) => [String(page), reason])),
      unreviewed: Object.fromEntries([...unreviewed].map(([page, reason]) => [String(page), reason]))
    })
    return {
      output, sourceOutput: assembledSource,
      sourceRebuiltPages: translation ? sorted(sourceRendered.keys()) : sorted(rendered.keys()),
      pageCount, chosenPages: chosen, rebuiltPages: sorted(rendered.keys()),
      fallbacks, usage, reports: orderedReports, manifest
    }
  }

  // MARK: - Stages

  private async renderPages(
    document: PDFDocument, chosen: number[], samples: number[], sourceHash: string, artifacts: string, force: boolean, tracker: ProgressTracker
  ): Promise<Map<number, string>> {
    const directory = join(artifacts, 'pages')
    await mkdir(directory, { recursive: true })
    const stampPath = join(artifacts, 'render-settings.json')
    const config = { dpi: this.configuration.dpi, source_sha256: sourceHash, version: 'pdfjs-render-v1' }
    let valid = new Set<number>()
    try {
      const previous = JSON.parse(await readFile(stampPath, 'utf8')) as { config?: typeof config; pages?: number[] }
      if (previous.config?.source_sha256 === config.source_sha256 && previous.config.dpi === config.dpi && previous.config.version === config.version) {
        valid = new Set(previous.pages ?? [])
      }
    } catch {
      // Render every page.
    }
    const images = new Map<number, string>()
    for (const number of sorted([...chosen, ...samples])) {
      this.signal?.throwIfAborted()
      const path = join(directory, `page-${pad(number)}.jpg`)
      if (force || !valid.has(number) || !(await readFile(path).then(() => true, () => false))) {
        let data: Uint8Array
        try {
          const image = await renderPage(await document.getPage(number), this.configuration.dpi)
          // Keep color and fine strokes: aggressive grayscale sharpening
          // damages punctuation before the model has a chance to read it.
          data = await image.autocontrasted(0.1).jpegData(94)
        } catch (error) {
          if (isCancellation(error, this.signal)) throw error
          throw new RebuildError({ kind: 'renderingFailed', page: number })
        }
        await atomicWriteFile(path, data)
      }
      images.set(number, path)
      if (!samples.includes(number)) tracker.announce('rendering', number)
    }
    await writeJSON(stampPath, { config, pages: sorted(new Set([...valid, ...chosen, ...samples])) })
    return images
  }

  /** Recognize the text lines of a page and measure its text area. */
  private async recognize(number: number, context: PageContext): Promise<{ lines: OcrLine[]; measure: PageMeasure }> {
    const image = await context.image(number)
    const lines = await this.options.recognizer.recognizeLines(image)
    const size = context.pageSizes.get(number)!
    return { lines, measure: measurePage(lines, { width: image.width, height: image.height }, size) }
  }

  private async draft(
    number: number, lines: OcrLine[], measures: Map<number, PageMeasure>, context: PageContext, identity: string,
    model: CheckpointedModel, lineMode: LineMode, force: boolean
  ): Promise<Drafted> {
    const imageData = new Uint8Array(await readFile(context.images.get(number)!))
    const image = await context.image(number)
    const key = sha256Hex(Buffer.concat([imageData, Buffer.from(identity, 'utf8')]))
    const statePath = stateFile(context.work, number)
    const markupPath = markupFile(context.work, number)
    const previous = force ? undefined : await readState(statePath)
    let state = previous?.key === key ? previous : undefined
    // Edited means "differs from what we last wrote", even when the cache key has since changed.
    const text = force ? undefined : await readFile(markupPath, 'utf8').catch(() => undefined)
    if (text !== undefined && (!previous || text !== previous.final)) {
      // A hand-corrected page wins over model output and is never sent for review.
      try {
        PageMarkup.parse(text)
      } catch (error) {
        if (error instanceof MarkupError) throw new PageFailure('transcribing', `the edited page-${pad(number)}.page.tex is invalid: ${error.message}`)
        throw error
      }
      const edited = state ? copyState(state) : pageState(key, text, text)
      edited.final = text
      edited.edited = true
      await saveState(edited, statePath, markupPath)
      return { state: edited, fromCheckpoint: true }
    }
    if (state) {
      await saveState(state, statePath, markupPath)
      return { state, fromCheckpoint: true }
    }
    // A candidate is checked in the document's text area, as the final page will be.
    const validate = async (markup: PageMarkup): Promise<string[]> => {
      validateFigureRegions(markup, image, lines)
      const single = documentLayouts(measures, [{ page: number, markup }])
      return (await context.compile(number, markup, single.layouts.get(number)!, lineMode)).longLines
    }
    const requested = await this.requestMarkup(model, `typeset-page-${pad(number)}`, number, 'transcribing',
      await RebuildPipeline.transcriptionMessages(number, image, lines), validate)
    const serialized = requested.markup!.serialize()
    state = pageState(key, serialized, serialized, requested.usage)
    await saveState(state, statePath, markupPath)
    return { state, fromCheckpoint: false }
  }

  private async review(
    number: number, initial: PageState, layout: PageLayout, measures: Map<number, PageMeasure>, lines: OcrLine[],
    context: PageContext, model: CheckpointedModel, lineMode: LineMode
  ): Promise<Reviewed> {
    const state = copyState(initial)
    let calledModel = false
    const rounds = this.configuration.reviewRounds
    while (!state.edited && state.rounds < rounds) {
      const markup = PageMarkup.parse(state.final)
      let result: CompileResult
      try {
        result = await context.compile(number, markup, layout, lineMode)
      } catch (error) {
        // The final pass reports it and keeps the scan; reviewing needs a rendering.
        if (error instanceof LatexError) break
        throw error
      }
      const source = await context.image(number)
      const rendered = await RebuildPipeline.render(result.pdf, source.width, source.height)
      const imageSize = { width: source.width, height: source.height }
      const warnings = [...coverageWarnings(markup, lines, imageSize), ...RebuildPipeline.longLineWarnings(result.longLines)]
      // Like the first draft, a candidate is checked in the document's text area.
      const validate = async (candidate: PageMarkup): Promise<string[]> => {
        validateFigureRegions(candidate, source, lines)
        const single = documentLayouts(measures, [{ page: number, markup: candidate }])
        return (await context.compile(number, candidate, single.layouts.get(number)!, lineMode)).longLines
      }
      let requested: RequestedMarkup
      try {
        requested = await this.requestMarkup(model, `review-page-${pad(number)}`, number, 'reviewing',
          await RebuildPipeline.reviewMessages(number, source, rendered, markup, warnings), validate, true)
      } catch (error) {
        if (isCancellation(error, this.signal)) throw error
        // The draft is already validated; a later run retries the missing rounds.
        return { state, fromCheckpoint: !calledModel, failure: `校对请求失败（第 ${state.rounds + 1} 轮）：${errorMessage(error)}；使用已验证的转写` }
      }
      calledModel = true
      state.usage = addUsage(state.usage, requested.usage)
      state.rounds += 1
      if (requested.rejection !== undefined) {
        state.changes.push(`校对结果被拒绝：${requested.rejection}；保留已验证的页面`)
      } else if (requested.markup) {
        let reason = RebuildPipeline.reviewRegression(markup, requested.markup, lines, imageSize)
        if (!reason && requested.longLines.length > result.longLines.length) reason = `${requested.longLines.length} 行疑似合并了多条印刷行`
        if (!reason) {
          state.final = requested.markup.serialize()
          state.changes.push(`校对修改（第 ${state.rounds} 轮）：${requested.summary || '（模型未列出修改项）'}`)
        } else {
          state.changes.push(`校对结果被拒绝：${reason}`)
        }
      } else {
        state.rounds = rounds
        state.changes.push('校对：与原稿一致，无需修改')
      }
      await saveState(state, stateFile(context.work, number), markupFile(context.work, number))
    }
    return { state, fromCheckpoint: !calledModel }
  }

  private async translate(
    number: number, sourceState: PageState, layout: PageLayout, target: RebuildTranslationTarget, context: PageContext,
    directory: string, model: CheckpointedModel, lineMode: LineMode
  ): Promise<Reviewed> {
    const source = PageMarkup.parse(sourceState.final)
    const text = source.serialize()
    const key = sha256Hex(JSON.stringify({ model: model.client.identity, prompt: target.prompt, source: text, target: target.code }))
    const statePath = stateFile(directory, number)
    const markupPath = markupFile(directory, number)
    const { force } = this.configuration
    const previous = force ? undefined : await readState(statePath)
    let state: PageState
    let fromCheckpoint = true
    const edited = force ? undefined : await readFile(markupPath, 'utf8').catch(() => undefined)
    if (edited !== undefined && (!previous || edited !== previous.final)) {
      try {
        PageMarkup.parse(edited)
      } catch (error) {
        if (error instanceof MarkupError) throw new PageFailure('translating', `the edited page-${pad(number)}.page.tex is invalid: ${error.message}`)
        throw error
      }
      state = previous ? copyState(previous) : pageState(key, edited, edited)
      state.key = key
      state.final = edited
      state.edited = true
    } else if (previous && previous.key === key) {
      state = previous
    } else {
      const translated = await translateMarkup(model, number, source, target, async (markup) => {
        await context.compile(number, markup, layout, lineMode, directory)
      })
      const final = translated.markup.serialize()
      state = pageState(key, final, final, translated.usage)
      fromCheckpoint = false
    }
    if (!state.edited) state.final = alignTranslationParagraphs(source, PageMarkup.parse(state.final)).serialize()
    state.source_sha256 = sha256Hex(text)
    state.target = target.code
    state.rounds = 0
    state.changes = []
    await saveState(state, statePath, markupPath)
    return { state, fromCheckpoint }
  }

  private async typesetFinal(
    number: number, state: PageState | undefined, source: PageState, layout: PageLayout, measure: PageMeasure | undefined,
    lines: OcrLine[], context: PageContext, directory: string, lineMode: LineMode, translated: boolean
  ): Promise<Typeset> {
    if (!translated) {
      const typeset = await this.typesetSourcePage(number, source, layout, lines, context, directory, lineMode)
      return { ...typeset, sourcePDF: typeset.pdf }
    }
    let reference: CompileResult
    try {
      reference = await context.compile(number, PageMarkup.parse(source.final), layout, 'keep')
    } catch (error) {
      if (!(error instanceof LatexError)) throw error
      if (!state) return {}
      const report = RebuildPipeline.report(number, state)
      report.fallback = `排版失败，保留原扫描页: ${error.message}`
      return { report }
    }
    if (!state) return { sourcePDF: reference.pdf }
    let markup = PageMarkup.parse(state.final)
    if (!state.edited && measure) markup = releaseColumnBreaks(markup, measure)
    const report = RebuildPipeline.report(number, state)
    try {
      const typography = { referenceSize: layout.size, referenceLeading: layout.leading }
      const fitted = await fitTranslationLayout(layout, markup, reference.bodyHeight, (candidate) =>
        context.compile(number, markup, candidate, lineMode, directory, typography))
      const result = fitted.result
      report.translation_layout = fitted.report
      report.warnings = result.overfull.length ? [RebuildPipeline.overfullWarning('译文', Math.max(...result.overfull))] : []
      const bottoms = fitted.report.column_bottoms_pt
      if (bottoms && measure && columnsLevel(measure) && Math.abs(bottoms[0] - bottoms[1]) > 0.15 * fitted.layout.textHeight) {
        report.warnings.push(`原稿两栏齐平，译文两栏底部相差 ${PythonNumber.fixed(Math.abs(bottoms[0] - bottoms[1]), 0)} pt；请检查分栏`)
      }
      RebuildPipeline.record(result, fitted.layout, report)
      return { report, pdf: result.pdf, sourcePDF: reference.pdf }
    } catch (error) {
      if (!(error instanceof LatexError)) throw error
      report.fallback = `排版失败，保留原扫描页: ${error.message}`
      return { report, sourcePDF: reference.pdf }
    }
  }

  /** The final page of a rebuild without translation. */
  private async typesetSourcePage(
    number: number, state: PageState, layout: PageLayout, lines: OcrLine[], context: PageContext, directory: string, lineMode: LineMode
  ): Promise<Typeset> {
    const markup = PageMarkup.parse(state.final)
    const report = RebuildPipeline.report(number, state)
    try {
      const result = await context.compile(number, markup, layout, lineMode, directory)
      const image = await context.image(number)
      report.warnings = [...coverageWarnings(markup, lines, { width: image.width, height: image.height }), ...RebuildPipeline.longLineWarnings(result.longLines)]
      const overfull = result.overfull.length ? Math.max(...result.overfull) : undefined
      if (overfull !== undefined && overfull > 2) report.warnings.push(RebuildPipeline.overfullWarning('原文', overfull))
      RebuildPipeline.record(result, layout, report)
      return { report, pdf: result.pdf }
    } catch (error) {
      if (!(error instanceof LatexError)) throw error
      report.fallback = `排版失败，保留原扫描页: ${error.message}`
      return { report }
    }
  }

  private static report(number: number, state: PageState): RebuildPageReport {
    const markup = PageMarkup.parse(state.final)
    return {
      page: number, edited: state.edited, review_rounds: state.rounds, changes: [...state.changes], notes: markup.notes,
      figures: [...markup.figures.keys].sort(), usage: state.usage, warnings: [], reduced_paragraphs: []
    }
  }

  private static record(result: CompileResult, layout: PageLayout, report: RebuildPageReport): void {
    report.type_scale = PythonNumber.round(result.scale, 3)
    report.reduced_paragraphs = sorted(new Set(result.paragraphSizes.factors))
    report.vertical_space_scale = result.spaceScale < 1 ? result.spaceScale : undefined
    report.body_size_pt = PythonNumber.round(layout.size * result.scale, 3)
    report.max_overfull_pt = PythonNumber.round(result.overfull.length ? Math.max(...result.overfull) : 0, 3)
  }

  // MARK: - Model requests

  /**
   * `_request_markup`: ask for page markup; send parse/LaTeX errors and merged-line problems back.
   *
   * Errors must be fixed; merged lines are asked about twice and then accepted, since
   * a page with a too-long line is still better than no page. An unusable review returns
   * its rejection reason and usage so the caller can keep the already validated page.
   * Provider errors and cancellation still propagate.
   *
   * Saved answers are tried first, so a validation fix reuses them; when they still fail,
   * the model is asked again, so running a failed page again really retries it.
   */
  async requestMarkup(
    model: CheckpointedModel, label: string, page: number, stage: RebuildStage, messages: RebuildMessage[],
    validate: (markup: PageMarkup) => Promise<string[]>, allowUnchanged = false
  ): Promise<RequestedMarkup> {
    const replayed = await model.hasCheckpoint(label, messages)
    try {
      return await this.requestMarkupAttempts(model, label, page, stage, messages, validate, allowUnchanged)
    } catch (error) {
      if (!(replayed && error instanceof RebuildError && error.reason.kind === 'unusableModelOutput')) throw error
      return this.requestMarkupAttempts(model.refreshing(), label, page, stage, messages, validate, allowUnchanged)
    }
  }

  private async requestMarkupAttempts(
    model: CheckpointedModel, label: string, page: number, stage: RebuildStage, initial: RebuildMessage[],
    validate: (markup: PageMarkup) => Promise<string[]>, allowUnchanged: boolean
  ): Promise<RequestedMarkup> {
    const messages = [...initial]
    let usage = emptyUsage()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { text: raw, usage: spent } = await model.chat(label, messages)
      usage = addUsage(usage, spent)
      const changes = changesPattern.search(raw)?.at(1) ?? ''
      const summary = PythonText.splitLines(changes)
        .filter((line) => PythonText.strip(line, ' -'))
        .map((line) => PythonText.strip(bulletPattern.sub(line, '')))
        .join('\n')
      if (allowUnchanged && raw.includes('<unchanged/>') && !raw.includes('<page')) return { usage, summary, longLines: [] }
      let problem: string
      try {
        const markup = PageMarkup.parse(stripFences(raw))
        const longLines = await validate(markup)
        if (!longLines.length || attempt === 2) return { markup, usage, summary, longLines }
        problem = 'These source lines are far wider than any printed line, so each probably joins '
          + 'several printed lines, or a displayed formula is laid out wider than printed (such '
          + 'as a justification column added with &&). Put every printed line on its own source '
          + 'line, with justifications and equation numbers where they are printed:\n'
          + longLines.map((line) => `- ${line}`).join('\n')
      } catch (error) {
        if (!(error instanceof MarkupError || error instanceof LatexError)) throw error
        if (attempt === 2) {
          if (allowUnchanged) return { usage, summary, longLines: [], rejection: error.message }
          throw new RebuildError({ kind: 'unusableModelOutput', page, stage, detail: error.message })
        }
        problem = `The page markup could not be used: ${error.message}`
      }
      messages.push(textMessage('assistant', raw), textMessage('user', `${problem}\nFix this and return the complete corrected <page> markup.`))
    }
    throw new Error('unreachable')
  }

  /** `_transcription_messages`: the whole page for layout, full-resolution bands for reading, and the OCR draft. */
  static async transcriptionMessages(number: number, image: RGBImage, lines: readonly OcrLine[]): Promise<RebuildMessage[]> {
    const overview = image.thumbnail(1100, 1600)
    const parts = splitRows(image, image.height > image.width * 1.25 ? 3 : 2)
    const content: RebuildMessagePart[] = [
      { type: 'text', text: `Page ${number}. WHOLE PAGE, for layout and figure coordinates:` },
      { type: 'jpeg', data: await overview.jpegData(85) }
    ]
    const hints = frameHints(image)
    if (hints) content.push({ type: 'text', text: hints })
    for (const [index, part] of parts.entries()) {
      content.push({ type: 'text', text: `PART ${index + 1} of ${parts.length}: rows ${part.top}-${part.bottom} of ${image.height}, full resolution.` })
      content.push({ type: 'jpeg', data: await image.cropped(0, part.top, image.width, part.bottom).jpegData(92) })
    }
    content.push({ type: 'text', text: `Noisy OCR draft (unreliable; only for noticing every line):\n${lines.map((line) => line.text).join('\n')}` })
    content.push({ type: 'text', text: 'Return the <page> markup for this page.' })
    return [textMessage('system', RebuildPrompts.transcribe), { role: 'user', parts: content }]
  }

  /** `_review_messages`: matching bands of the scan and the rebuilt page, then the markup and warnings. */
  static async reviewMessages(number: number, source: RGBImage, rendered: RGBImage, markup: PageMarkup, warnings: readonly string[]): Promise<RebuildMessage[]> {
    const parts = splitRows(source, source.height > source.width * 1.25 ? 3 : 2)
    const content: RebuildMessagePart[] = [{ type: 'text', text: `Page ${number}.` }]
    for (const [index, part] of parts.entries()) {
      content.push({ type: 'text', text: `SOURCE region ${index + 1} of ${parts.length} (rows ${part.top}-${part.bottom}):` })
      content.push({ type: 'jpeg', data: await source.cropped(0, part.top, source.width, part.bottom).jpegData(92) })
      content.push({ type: 'text', text: `REBUILT region ${index + 1} of ${parts.length} (same rows):` })
      content.push({ type: 'jpeg', data: await rendered.cropped(0, part.top, rendered.width, part.bottom).jpegData(92) })
    }
    content.push({ type: 'text', text: `Current markup:\n${markup.serialize()}` })
    const shown = warnings.map((warning) => `- ${warning}`).join('\n')
    content.push({ type: 'text', text: `Automatic warnings:\n${shown || 'none'}` })
    return [textMessage('system', RebuildPrompts.review), { role: 'user', parts: content }]
  }

  /** `_review_regression`: refuse a proofreading pass that loses text instead of correcting it. */
  static reviewRegression(before: PageMarkup, after: PageMarkup, lines: readonly OcrLine[], imageSize?: { width: number; height: number }): string {
    const counts = (words: readonly string[]): Map<string, number> => {
      const result = new Map<string, number>()
      for (const word of words) result.set(word, (result.get(word) ?? 0) + 1)
      return result
    }
    const sum = (map: Map<string, number>): number => [...map.values()].reduce((total, value) => total + value, 0)
    const oldWords = counts(coverageTokens(markupPlain(before)))
    const newWords = counts(coverageTokens(markupPlain(after)))
    const old = sum(oldWords)
    const fresh = sum(newWords)
    const croppedWords = counts(lines.filter((line) => imageSize !== undefined
      && lineInFigures(line, after, imageSize) && !lineInFigures(line, before, imageSize)).flatMap((line) => coverageTokens(line.text)))
    let retained = 0
    for (const [word, count] of croppedWords) retained += Math.min(Math.max(0, (oldWords.get(word) ?? 0) - (newWords.get(word) ?? 0)), count)
    if (fresh + retained < old * 0.9) return `正文词数从 ${old} 降到 ${fresh}`
    const lost = coverageWarnings(after, lines, imageSize).length - coverageWarnings(before, lines, imageSize).length
    if (lost >= 2) return `新增 ${lost} 条疑似漏行`
    return ''
  }

  /** `_overfull_warning`. */
  static overfullWarning(content: string, overfull: number): string {
    return `${content}有内容超出栏宽，最大横向溢出 ${PythonNumber.fixed(overfull, 2)} pt；请检查公式、代码和标题`
  }

  static longLineWarnings(lines: readonly string[]): string[] {
    return lines.map((line) => 'source line far wider than a printed line, probably several printed lines merged '
      + `or a display set wider than printed: ${PythonText.repr(line)}`)
  }

  /** `_render`: the compiled page at the scan's pixel size. */
  static async render(pdf: string, width: number, height: number): Promise<RGBImage> {
    let image: RGBImage
    try {
      const document = await openPDF(new Uint8Array(await readFile(pdf)))
      try {
        const page = await document.getPage(1)
        image = await renderPage(page, 72 * width / pageSize(page).width)
      } finally {
        await closePDF(document)
      }
    } catch {
      throw new LatexError('the compiled page cannot be rendered')
    }
    return image.width === width && image.height === height ? image : image.resized(width, height)
  }

  /** `settle_column_breaks`: put each model-placed column break where the scan's columns split. */
  static async settleColumnBreaks(states: Map<number, PageState>, lines: Map<number, OcrLine[]>, measures: Map<number, PageMeasure>, context: PageContext): Promise<void> {
    for (const number of sorted(states.keys())) {
      const current = states.get(number)!
      const measure = measures.get(number)
      if (current.edited || !measure) continue
      const image = await context.image(number)
      const { markup, note } = placeColumnBreaks(PageMarkup.parse(current.final), lines.get(number) ?? [], measure, { width: image.width, height: image.height })
      if (note === undefined) continue
      const state = copyState(current)
      state.final = markup.serialize()
      state.changes.push(`本地修正：${note}`)
      states.set(number, state)
      await saveState(state, stateFile(context.work, number), markupFile(context.work, number))
    }
  }

  /** `settle_vertical_gaps`: give headings and title lines the space the scan leaves around them. */
  static async settleVerticalGaps(
    states: Map<number, PageState>, lines: Map<number, OcrLine[]>, measures: Map<number, PageMeasure>, layouts: Map<number, PageLayout>, context: PageContext
  ): Promise<void> {
    for (const number of sorted(states.keys())) {
      const current = states.get(number)!
      const measure = measures.get(number)
      const layout = layouts.get(number)
      if (current.edited || !measure || !layout) continue
      const { markup, note } = restoreVerticalGaps(PageMarkup.parse(current.final), lines.get(number) ?? [], measure, layout, await context.image(number))
      if (note === undefined) continue
      const state = copyState(current)
      state.final = markup.serialize()
      state.changes.push(`本地修正：${note}`)
      states.set(number, state)
      await saveState(state, stateFile(context.work, number), markupFile(context.work, number))
    }
  }

  // MARK: - Concurrency

  /**
   * Runs `body` for each page with at most `maximumConcurrentPages` at a time and reports each
   * outcome as it finishes. Page failures are collected; cancellation stops the run.
   */
  private async forEachPage<T>(
    pages: readonly number[], stage: RebuildStage, body: (page: number) => Promise<T>, completion: (page: number, outcome: Outcome<T>) => void
  ): Promise<void> {
    const limit = Math.max(1, this.configuration.maximumConcurrentPages)
    let next = 0
    let cancelled: unknown
    const worker = async (): Promise<void> => {
      while (next < pages.length && cancelled === undefined) {
        const number = pages[next]
        next += 1
        let outcome: Outcome<T>
        try {
          outcome = { ok: true, value: await body(number) }
        } catch (error) {
          if (isCancellation(error, this.signal)) {
            cancelled ??= error
            return
          }
          outcome = { ok: false, failure: error instanceof PageFailure ? error : new PageFailure(stage, errorMessage(error)) }
        }
        if (this.signal?.aborted) {
          cancelled ??= this.signal.reason
          return
        }
        completion(number, outcome)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, pages.length) }, worker))
    if (cancelled !== undefined) throw cancelled
    this.signal?.throwIfAborted()
  }
}

// MARK: - Assembly and files

/** `_assemble`: the output has every input page; rebuilt pages replace the originals. */
async function assemble(sourceData: Uint8Array, output: string, rendered: Map<number, string>): Promise<void> {
  let source: PDFLibDocument
  try {
    source = await PDFLibDocument.load(sourceData, { ignoreEncryption: true, updateMetadata: false })
  } catch {
    throw new RebuildError({ kind: 'unreadableInput' })
  }
  try {
    const assembled = await PDFLibDocument.create({ updateMetadata: false })
    for (let index = 0; index < source.getPageCount(); index += 1) {
      const path = rendered.get(index + 1)
      let page
      if (path) {
        try {
          const rebuilt = await PDFLibDocument.load(new Uint8Array(await readFile(path)), { ignoreEncryption: true, updateMetadata: false })
          ;[page] = await assembled.copyPages(rebuilt, [0])
        } catch {
          page = undefined
        }
      }
      if (!page) [page] = await assembled.copyPages(source, [index])
      assembled.addPage(page)
    }
    const title = source.getTitle()
    const author = source.getAuthor()
    const subject = source.getSubject()
    const keywords = source.getKeywords()
    const creator = source.getCreator()
    if (title) assembled.setTitle(title)
    if (author) assembled.setAuthor(author)
    if (subject) assembled.setSubject(subject)
    if (keywords) assembled.setKeywords([keywords])
    if (creator) assembled.setCreator(creator)
    assembled.setProducer('RebuildPDFKit / vision LLM transcription typeset with XeLaTeX')
    await mkdir(dirname(output), { recursive: true })
    await atomicWriteFile(output, await assembled.save())
  } catch (error) {
    if (error instanceof RebuildError) throw error
    throw new RebuildError({ kind: 'outputNotWritten' })
  }
}

export function stateFile(directory: string, number: number): string {
  return join(directory, `page-${pad(number)}.json`)
}

export function markupFile(directory: string, number: number): string {
  return join(directory, `page-${pad(number)}.page.tex`)
}

export async function readState(path: string): Promise<PageState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PageState>
    if (typeof value.final !== 'string') return undefined
    const usage = value.usage && typeof value.usage === 'object' ? { ...emptyUsage(), ...value.usage } : emptyUsage()
    return {
      key: typeof value.key === 'string' ? value.key : '',
      draft: typeof value.draft === 'string' ? value.draft : '',
      final: value.final,
      rounds: typeof value.rounds === 'number' ? value.rounds : 0,
      changes: Array.isArray(value.changes) ? value.changes.filter((item): item is string => typeof item === 'string') : [],
      usage,
      edited: value.edited === true,
      source_sha256: typeof value.source_sha256 === 'string' ? value.source_sha256 : undefined,
      target: typeof value.target === 'string' ? value.target : undefined
    }
  } catch {
    return undefined
  }
}

async function saveState(state: PageState, statePath: string, markupPath: string): Promise<void> {
  await writeJSON(statePath, state)
  await atomicWriteFile(markupPath, state.final)
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, sortedJSON(value))
}
