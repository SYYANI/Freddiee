import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { TranslationEvent } from '../shared/types'
import type { Translator } from '../shared/i18n'
import { firstAttachment } from '../shared/library'
import { atomicWriteFile } from '../electron/main/files'
import { complete, requestFor, resolveRoute, type LLMMessage, type ResolvedRoute } from '../electron/main/llm'
import type { FreddieStore } from '../electron/main/store'
import type { SecretStore } from '../electron/main/secrets'
import {
  LatexError, RebuildError, RebuildPipeline, TesseractTextRecognizer, XeLaTeXCompiler, fractionCompleted, plainText,
  simplifiedChinese, verifyTeXInstallation, type RebuildCompletion, type RebuildCompletionRequest, type RebuildMessage,
  type RebuildModelClient, type RebuildProgressStage
} from './src'

export * from './src'

/** A vision model reasoning over several page images can think for minutes before answering. */
const scannedPageTimeoutMs = 30 * 60_000

/** Sends RebuildPDFKit's requests through a resolved provider route; the key never leaves the main process. */
export class FreddieRebuildModelClient implements RebuildModelClient {
  constructor(private readonly route: ResolvedRoute, private readonly signal?: AbortSignal) {}

  /** Endpoint, model and sampling settings; changing any of them re-requests cached pages. */
  get identity(): string {
    const { route } = this
    return [
      `url=${route.baseURL}`,
      `api=${route.apiStyle}`,
      `model=${route.modelName}`,
      `temperature=${route.temperature ?? 'default'}`,
      `topP=${route.topP ?? 'default'}`,
      `thinking=${route.thinkingMode ?? 'default'}`,
      `reasoning=${route.reasoningEffort ?? 'default'}`
    ].join('|')
  }

  async complete(request: RebuildCompletionRequest): Promise<RebuildCompletion> {
    const response = await complete(requestFor(this.route, request.messages.map(FreddieRebuildModelClient.message), {
      maxTokens: request.maxTokens, signal: this.signal, timeoutMs: scannedPageTimeoutMs
    }))
    const usage = response.usage
    return {
      text: response.text,
      usage: {
        prompt_tokens: usage?.inputTokens ?? 0,
        completion_tokens: usage?.outputTokens ?? 0,
        total_tokens: usage?.totalTokens ?? 0
      },
      // Providers that do not report a reason only answer when the model finished.
      finishReason: response.finishReason ?? 'stop'
    }
  }

  /** Text-only messages, such as earlier answers and corrections, stay plain strings. */
  static message(message: RebuildMessage): LLMMessage {
    const text = plainText(message)
    if (text !== undefined) return { role: message.role, content: text }
    return {
      role: message.role,
      content: message.parts.map((part) => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'image' as const, data: part.data, mediaType: 'image/jpeg' as const })
    }
  }
}

/** The last chosen page before any failed pages at the end of the run; undefined when none is left. */
export function lastRebuiltPage(pages: number[] | undefined, pageCount: number, failedPages: ReadonlySet<number>): number | undefined {
  let lastPage = Math.min(pages?.length ? Math.max(...pages) : pageCount, pageCount)
  while (lastPage > 0 && failedPages.has(lastPage)) lastPage -= 1
  return lastPage > 0 ? lastPage : undefined
}

const stageMessages: Record<RebuildProgressStage, string> = {
  rendering: 'Rendering scanned pages...',
  transcribing: 'Reading scanned pages with the vision model...',
  reviewing: 'Proofreading rebuilt pages against the scan...',
  translating: 'Translating rebuilt pages...',
  typesetting: 'Typesetting translated pages...',
  assembling: 'Assembling the translated PDF...'
}

function localizedError(error: RebuildError, t: Translator): Error {
  switch (error.reason.kind) {
    case 'unreadableInput': return new Error(t('The PDF could not be opened.'))
    case 'renderingFailed': return new Error(t('Page %d of the PDF could not be rendered.', error.reason.page))
    case 'noPagesRebuilt': return new Error(t('No page of the scan could be rebuilt. %@', error.reason.firstFailure))
    case 'outputNotWritten': return new Error(t('The translated PDF could not be saved.'))
    default: return error
  }
}

/** Keeps the first `count` pages, as a partial translation that the reader can continue. */
async function keepFirstPages(count: number, path: string, t: Translator): Promise<void> {
  try {
    const document = await PDFDocument.load(new Uint8Array(await readFile(path)), { ignoreEncryption: true, updateMetadata: false })
    while (document.getPageCount() > count) document.removePage(document.getPageCount() - 1)
    await atomicWriteFile(path, await document.save())
  } catch {
    throw new Error(t('The translated PDF could not be saved.'))
  }
}

/**
 * Translates a scanned PDF (or one with an unreliable text layer) by rebuilding each page with
 * RebuildPDFKit: a vision model transcribes the page as LaTeX, the text model translates it,
 * and XeLaTeX typesets it on the original page geometry. The result has the same pages as the
 * original, so it opens side by side like any translated PDF. The proofread transcription is
 * typeset too, as an alternative original with selectable text.
 *
 * Checkpoints live in the paper's `Resources/ScanRebuild` folder: an interrupted or repeated
 * run reuses every page already transcribed or translated.
 */
export async function runScannedTranslation(options: {
  paperId: string
  lastPage?: number
  store: FreddieStore
  secrets: SecretStore
  xelatexPath: string
  signal: AbortSignal
  emit: (event: TranslationEvent) => void
  t: Translator
}): Promise<void> {
  const { paperId, store, secrets, xelatexPath, signal, emit, t } = options
  if (store.database.settings.targetLanguage !== 'zh-CN') throw new Error(t('Scanned PDF translation currently translates into Simplified Chinese only. Change the target language in Settings.'))
  const attachment = firstAttachment(store.attachments(paperId), 'pdf')
  if (!attachment) throw new Error(t('No PDF attachment is available for this paper.'))
  const inputPath = store.attachmentPath(paperId, attachment.id)
  const transcriptionRoute = await resolveRoute('scanned', store, secrets, t)
  const translationRoute = await resolveRoute('pdf', store, secrets, t)
  const compiler = new XeLaTeXCompiler(xelatexPath, { signal })
  const artifacts = join(store.paperDirectory(paperId), 'Resources', 'ScanRebuild')
  await mkdir(artifacts, { recursive: true })

  emit({ paperId, kind: 'scan', type: 'status', message: t('Checking XeLaTeX...') })
  try {
    await verifyTeXInstallation(compiler, join(artifacts, 'tex-check'))
  } catch (error) {
    if (error instanceof LatexError) {
      throw new Error(process.platform === 'darwin'
        ? t('XeLaTeX is missing a package or font that scanned PDF translation needs. Install the full MacTeX, or add the package with tlmgr. %@', error.message)
        : t('XeLaTeX is missing a package or font that scanned PDF translation needs. Install the full TeX Live, or add the package with tlmgr or the MiKTeX Console. %@', error.message))
    }
    throw error
  }

  const translationsDirectory = join(store.paperDirectory(paperId), 'translations')
  await mkdir(translationsDirectory, { recursive: true })
  const output = join(translationsDirectory, 'scan-rebuild.zh.pdf')
  const sourceOutput = join(artifacts, 'transcription.pdf')
  const pages = options.lastPage ? Array.from({ length: options.lastPage }, (_, index) => index + 1) : undefined
  const recognizer = new TesseractTextRecognizer({ dpi: 240 })
  const pipeline = new RebuildPipeline({
    transcriber: new FreddieRebuildModelClient(transcriptionRoute, signal),
    translator: new FreddieRebuildModelClient(translationRoute, signal),
    recognizer,
    compiler,
    configuration: { maximumConcurrentPages: 4, pages, translation: simplifiedChinese },
    signal
  })
  let result
  try {
    result = await pipeline.run(inputPath, output, artifacts, sourceOutput, (update) => {
      if (signal.aborted) return
      const fraction = fractionCompleted(update)
      emit({
        paperId, kind: 'scan', type: 'progress',
        completed: update.totalSteps > 0 ? update.completedSteps : 0, total: Math.max(1, update.totalSteps),
        summary: `${Math.round(fraction * 100)}%`, message: t(stageMessages[update.stage])
      })
    })
  } catch (error) {
    if (error instanceof RebuildError) throw localizedError(error, t)
    throw error
  } finally {
    await recognizer.close().catch(() => undefined)
  }
  signal.throwIfAborted()

  // RebuildPDFKit fills the pages it did not rebuild with the scan. Past the last chosen
  // page, or on failed pages at the end, that would pass untranslated pages off as
  // translation, so the output ends at the last rebuilt page.
  const pageCount = result.pageCount
  const failedPages = new Set(result.fallbacks.keys())
  const lastPage = lastRebuiltPage(pages, pageCount, failedPages)
  if (lastPage === undefined) {
    const first = [...result.fallbacks].sort((a, b) => a[0] - b[0])[0]?.[1] ?? ''
    throw new Error(t('No page of the scan could be rebuilt. %@', first))
  }
  const translatedLastPage = lastPage < pageCount ? lastPage : undefined
  if (translatedLastPage !== undefined) await keepFirstPages(translatedLastPage, output, t)
  const fallbacks = [...result.fallbacks.keys()].filter((page) => page <= lastPage)
  const unfinished = [...result.fallbacks.keys()].filter((page) => page > lastPage).sort((a, b) => a - b)

  // A rerun rewrites the same files. Their records keep their IDs, so notes and annotations
  // made on them stay attached; the new date makes them the shown versions.
  const now = new Date().toISOString()
  const newest = (kind: 'translatedPDF' | 'resource') => store.attachments(paperId)
    .filter((item) => item.kind === kind && item.source === 'scanRebuild')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const existing = newest('translatedPDF')
  const existingSource = newest('resource')
  const filename = (path: string): string => relative(store.paperDirectory(paperId), path).split(sep).join('/')
  await store.batch(async () => {
    if (existing) await store.updateAttachment(paperId, existing.id, { filename: filename(output), translatedLastPage, createdAt: now })
    else await store.addAttachment({ id: randomUUID(), paperId, kind: 'translatedPDF', source: 'scanRebuild', filename: filename(output), translatedLastPage, createdAt: now })
    if (result.sourceRebuiltPages.length && result.sourceOutput) {
      if (existingSource) await store.updateAttachment(paperId, existingSource.id, { filename: filename(result.sourceOutput), createdAt: now })
      else await store.addAttachment({ id: randomUUID(), paperId, kind: 'resource', source: 'scanRebuild', filename: filename(result.sourceOutput), createdAt: now })
    } else if (existingSource) {
      await store.removeAttachment(paperId, existingSource.id)
    }
  })

  const messages: string[] = []
  if (fallbacks.length) messages.push(t('%d pages could not be rebuilt and show the scan. Translate the scanned PDF again to retry them; finished pages are reused.', fallbacks.length))
  if (unfinished.length) messages.push(t('Pages %@ could not be rebuilt and were not added to the translation. Continue translating to try them again.', unfinished.join(', ')))
  emit({ paperId, kind: 'scan', type: 'finished', message: messages.length ? messages.join(' ') : t('Scanned PDF translation completed.') })
}
