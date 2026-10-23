// Freddie's host for LaTeXTransKit: a port of read-paper's `LaTeXTranslationService.swift`
// (prompt client, arXiv acquisition, checkpoints, engine-compatibility rewriting, compilation
// diagnostics) and of the reader's `translateLaTeX()` flow that records the results.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { delimiter, dirname, extname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Attachment, TranslationEvent } from '../shared/types'
import type { Translator } from '../shared/i18n'
import { arxivQueryId, normalizeArxivIdentifier } from '../shared/identifiers'
import { atomicWriteFile } from '../electron/main/files'
import { browserHeaders } from '../electron/main/importer'
import { complete, requestFor, resolveRoute, type ResolvedRoute } from '../electron/main/llm'
import type { FreddieStore } from '../electron/main/store'
import type { SecretStore } from '../electron/main/secrets'
import {
  ArXivProjectPreparer, AutomaticTranslationArchiveReader, LaTeXCompilationError, LaTeXCompiler, LaTeXParserError,
  LaTeXTranslationPipeline, NodeLaTeXProcessRunner, ProjectPreparationError, PromptLaTeXDocumentSummarizer, PromptingLaTeXTranslator,
  ReconstructionError, ReferenceLanguagePreamblePolicy, RoutedProjectPreparer, StructuralLaTeXValidator, StructuredLaTeXParser,
  StructuredLaTeXReconstructor, TarGzipArchiveReaderError, TranslationLanguages, TranslationPipelineError, TranslationRuntimeError,
  ZipArchiveReaderError, checkCancellation, checkpointKey, isCancellation, parseJSON, partiallyTranslatedUnitCode, translationConfiguration,
  trimmed, untranslatedUnitCode,
  type ArXivProjectAcquiring, type CompilationAttempt, type LaTeXPreambleTransforming, type LaTeXProcessRequest, type LaTeXProcessResult,
  type LaTeXProcessRunning, type LaTeXProjectCompiling, type LaTeXProjectParsing, type LaTeXPromptCompleting, type LaTeXPromptRequest,
  type ParsedLaTeXProject, type PipelineEvent, type PipelineStage, type PreparedProject, type TerminologyEntry, type TranslationArtifact,
  type TranslationCheckpointStoring, type TranslationLanguage, type TranslationProjectSource, type ValidationIssue
} from './src'
import { compareStrings, doubleDescription, safeComponent, trimmedWhitespaces } from './src/text'
import { decodeUTF8, encodeSortedStringObject, isJSONObject } from './src/json'

export * from './src'

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

// MARK: Prompt client

export const latexPromptVersion = 'latextranskit-v1'

/** Matches the HTML translation prompt version that native Freddie folds into route identities. */
const academicPromptVersion = 'academic-v3'

/** The resource timeout of native Freddie's translation requests. */
const translationTimeoutMs = 600_000

/** Sends the kit's requests through a resolved provider route; the key never leaves the main process. */
export class FreddieLaTeXPromptClient implements LaTeXPromptCompleting {
  constructor(private readonly route: ResolvedRoute, private readonly t: Translator) {}

  async complete(request: LaTeXPromptRequest, signal?: AbortSignal): Promise<string> {
    const { route } = this
    const response = await complete(requestFor(route, request.messages, {
      defaultTemperature: request.temperature,
      maxTokens: route.maxTokens ?? request.maximumOutputTokens,
      signal,
      timeoutMs: translationTimeoutMs
    }))
    const text = trimmed(response.text)
    if (!text) throw new Error(this.t('The provider returned an empty response.'))
    return text
  }
}

/** Native Freddie's `LLMModelRouteSnapshot.translationCacheIdentity`. */
export function translationCacheIdentity(route: Pick<ResolvedRoute, 'modelName' | 'apiStyle' | 'temperature' | 'topP' | 'maxTokens' | 'thinkingMode' | 'reasoningEffort'>): string {
  return [
    `model=${route.modelName}`,
    `api=${route.apiStyle}`,
    `temperature=${route.temperature === undefined ? 'default' : doubleDescription(route.temperature)}`,
    `topP=${route.topP === undefined ? 'default' : doubleDescription(route.topP)}`,
    `maxTokens=${route.maxTokens === undefined ? 'default' : String(route.maxTokens)}`,
    `thinking=${route.thinkingMode ?? 'default'}`,
    `reasoning=${route.reasoningEffort ?? 'default'}`,
    `prompt=${academicPromptVersion}`
  ].join('|')
}

/** The identifier with its version: `2401.12345` and `2` give `2401.12345v2`. */
export function resolvingArxivIdentifier(id: string, version?: string): string {
  const identifier = trimmed(id)
  const rawVersion = version === undefined ? '' : trimmed(version)
  if (/v\p{Nd}+$/u.test(identifier) || !rawVersion) return identifier
  if (/^v\p{Nd}+$/u.test(rawVersion)) return identifier + rawVersion
  if (/^\p{Nd}+$/u.test(rawVersion)) return `${identifier}v${rawVersion}`
  return identifier
}

/** Native Freddie's glossary normalization: trimmed non-empty lines, at most 12,000 characters. */
export function normalizedGlossary(value: string | undefined): string {
  if (!value) return ''
  const lines = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(trimmedWhitespaces).filter(Boolean)
  return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(lines.join('\n')), (segment) => segment.segment).slice(0, 12_000).join('')
}

/** Glossary lines `source => target`, `source → target`, `source = target` or tab-separated. */
export function terminologyEntries(glossary: string): TerminologyEntry[] {
  return normalizedGlossary(glossary).split('\n').filter(Boolean).flatMap((line) => {
    for (const separator of ['=>', '→', '=', '\t']) {
      const parts = line.split(separator)
      if (parts.length !== 2) continue
      const source = trimmed(parts[0])
      const target = trimmed(parts[1])
      if (source && target) return [{ source, target }]
    }
    return []
  })
}

// MARK: arXiv source

export const maximumArchiveByteCount = 512 * 1_024 * 1_024

export class ArXivSourceError extends Error {}

/** Downloads the arXiv e-print into the workspace's `downloads` folder and reuses a plausible earlier download. */
export class FreddieArXivProjectAcquirer implements ArXivProjectAcquiring {
  constructor(private readonly t: Translator, private readonly fetcher: typeof fetch = fetch) {}

  async acquireProject(identifier: string, workspaceDirectory: string, signal?: AbortSignal): Promise<TranslationProjectSource> {
    const queryID = arxivQueryId(normalizeArxivIdentifier(identifier))
    const downloads = join(workspaceDirectory, 'downloads')
    await mkdir(downloads, { recursive: true })
    const filename = `${queryID.replaceAll('/', '_')}.tar`
    const destination = join(downloads, filename)
    if (await exists(destination)) {
      if (await isPlausibleSourceArchive(destination)) return { kind: 'localArchive', path: destination }
      await rm(destination, { force: true })
    }

    const response = await this.fetcher(`https://export.arxiv.org/e-print/${queryID}`, { headers: browserHeaders('resource'), signal, redirect: 'follow' })
    if (!response.ok) throw new ArXivSourceError(this.t('arXiv returned an error (status %d). Please try again later.', response.status))
    const tooLarge = (): ArXivSourceError => new ArXivSourceError(this.t('The arXiv source archive exceeds the %lld-byte safety limit.', maximumArchiveByteCount))
    if (Number(response.headers.get('content-length') ?? 0) > maximumArchiveByteCount) throw tooLarge()
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') throw new ArXivSourceError(this.t('The arXiv source response is not a valid archive.'))
    checkCancellation(signal)

    const partial = join(downloads, `.${filename}.${randomUUID().toUpperCase()}.partial`)
    try {
      let received = 0
      const body = response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : Readable.from([])
      const limited = body.map((chunk: Buffer) => {
        received += chunk.length
        if (received > maximumArchiveByteCount) throw tooLarge()
        return chunk
      })
      await pipeline(limited, createWriteStream(partial), { signal })
      if (!(await isPlausibleSourceArchive(partial))) throw new ArXivSourceError(this.t('The arXiv source response is not a valid archive.'))
      await rename(partial, destination)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw error
    }
    return { kind: 'localArchive', path: destination }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A nonempty regular file within the size limit that is not an HTML error page. */
async function isPlausibleSourceArchive(path: string): Promise<boolean> {
  const attributes = await stat(path)
  if (!attributes.isFile() || attributes.size <= 0 || attributes.size > maximumArchiveByteCount) return false
  const handle = await open(path, 'r')
  try {
    const prefix = new Uint8Array(512)
    const { bytesRead } = await handle.read(prefix, 0, 512, 0)
    if (!bytesRead) return false
    const text = trimmed(new TextDecoder('utf-8', { ignoreBOM: true }).decode(prefix.subarray(0, bytesRead))).toLowerCase()
    return !text.startsWith('<!doctype html') && !text.startsWith('<html')
  } finally {
    await handle.close()
  }
}

// MARK: Checkpoints

/** Credential-free unit checkpoints in one JSON file, written atomically after each completed unit. */
export class FileLaTeXTranslationCheckpointStore implements TranslationCheckpointStoring {
  private translations?: Record<string, string>
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, string>> {
    if (this.translations) return this.translations
    let translations: Record<string, string> = {}
    try {
      const decoded = parseJSON(decodeUTF8(new Uint8Array(await readFile(this.path))) ?? '')
      if (isJSONObject(decoded) && Object.values(decoded).every((value) => typeof value === 'string')) translations = { ...decoded } as Record<string, string>
    } catch {
      // Start with no checkpoints.
    }
    this.translations ??= translations
    return this.translations
  }

  async translation(unitID: string, fingerprint: string): Promise<string | undefined> {
    const translations = await this.load()
    const key = checkpointKey(unitID, fingerprint)
    return Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : undefined
  }

  async saveTranslation(translation: string, unitID: string, fingerprint: string): Promise<void> {
    const translations = await this.load()
    translations[checkpointKey(unitID, fingerprint)] = translation
    // Writes are serialized so that a slower earlier write never replaces a newer file.
    const write = this.writes.then(() => atomicWriteFile(this.path, encodeSortedStringObject(translations, compareStrings)))
    this.writes = write.catch(() => undefined)
    await write
  }
}

// MARK: Engine compatibility

// NSRegularExpression multiline anchors: every line terminator ends a line.
const lineStart = '(?<=^|[\\n\\v\\f\\r\\u0085\\u2028\\u2029])'
const lineEnd = '(?=[\\n\\v\\f\\r\\u0085\\u2028\\u2029]|$)'
const linePattern = (body: string): RegExp => new RegExp(`${lineStart}${body}${lineEnd}`, 'gu')

const chineseWrapperFix = linePattern(String.raw`([ \t]*)\\providecommand\{\\chinese\}\{\}n\\renewcommand\{\\chinese\}([^\r\n]*)`)
const chineseDefinition = linePattern(String.raw`([ \t]*)\\newcommand[ \t]*(?:\{[ \t]*\\chinese[ \t]*\}|\\chinese)([^\r\n]*)`)
const pdfTeXAssignment = linePattern(String.raw`([ \t]*)\\(pdfoutput|pdfsuppresswarningpagegroup|pdfminorversion|pdfcompresslevel|pdfobjcompresslevel|pdfinclusioncopyfonts|pdfgentounicode)[ \t]*=[ \t]*([+-]?\p{Nd}+)([ \t]*(?:%[^\r\n]*)?)`)
const pdfTeXMapCommand = linePattern(String.raw`([ \t]*)(\\(pdfmapline|pdfmapfile|pdfglyphtounicode)[^%\r\n]*)([ \t]*(?:%[^\r\n]*)?)`)
const disableLigatures = linePattern(String.raw`([ \t]*)(\\DisableLigatures[^%\r\n]*)([ \t]*(?:%[^\r\n]*)?)`)
const inputencPackage = linePattern(String.raw`([ \t]*)(\\(?:usepackage|RequirePackage))[ \t]*(?:\[[^\]]*\])?[ \t]*\{inputenc\}([ \t]*(?:%[^\r\n]*)?)`)

/**
 * Makes pdfTeX-only source safe under XeLaTeX and LuaLaTeX: primitives and `inputenc` are
 * guarded, and a legacy `\chinese` text wrapper can be redefined over ctex's numeral command.
 */
export function normalizeEngineSpecificSource(source: string): string {
  const chineseOverride = (_match: string, indent: string, rest: string): string => `${indent}\\providecommand{\\chinese}{}\n${indent}\\renewcommand{\\chinese}${rest}`
  // Repairs projects from a short-lived rewrite that emitted a literal "n" for the newline.
  let result = source.replace(chineseWrapperFix, chineseOverride)
  result = result.replace(chineseDefinition, chineseOverride)
  result = result.replace(pdfTeXAssignment, (_match, indent: string, name: string, value: string, comment: string) => `${indent}\\ifdefined\\${name}\\${name}=${value}\\fi${comment}`)
  result = result.replace(pdfTeXMapCommand, (_match, indent: string, command: string, name: string, comment: string) => `${indent}\\ifdefined\\${name}${command}\\fi${comment}`)
  result = result.replace(disableLigatures, (_match, indent: string, command: string, comment: string) => `${indent}\\ifdefined\\pdftexversion${command}\\fi${comment}`)
  return result.replace(inputencPackage, (_match, indent: string, command: string, comment: string) => `${indent}\\ifdefined\\pdftexversion${command}[utf8]{inputenc}\\fi${comment}`)
}

export class EngineCompatibilityPreamblePolicy implements LaTeXPreambleTransforming {
  constructor(private readonly base: LaTeXPreambleTransforming = new ReferenceLanguagePreamblePolicy()) {}

  transform(source: string, targetLanguage: TranslationLanguage): string {
    return normalizeEngineSpecificSource(this.base.transform(source, targetLanguage))
  }
}

const sourceExtensions = new Set(['.tex', '.cls', '.sty', '.ltx', '.def', '.cfg'])

/** TeX sources and style files below `directory`, skipping hidden entries and symbolic links. */
async function projectSourceFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      checkCancellation(signal)
      if (entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) files.push(path)
    }
  }
  await visit(directory)
  return files
}

async function readUTF8Source(path: string): Promise<string | undefined> {
  try {
    return decodeUTF8(new Uint8Array(await readFile(path)))
  } catch {
    return undefined
  }
}

/** Applies the engine-compatibility rewriting to every source file and restores literal percent signs. */
export async function normalizeProject(projectDirectory: string, literalPercentMarker?: string, signal?: AbortSignal): Promise<void> {
  for (const file of await projectSourceFiles(projectDirectory, signal)) {
    const source = await readUTF8Source(file)
    if (source === undefined) continue
    let normalized = normalizeEngineSpecificSource(source)
    if (literalPercentMarker) normalized = normalized.split(literalPercentMarker).join('%')
    if (normalized !== source) await atomicWriteFile(file, normalized)
  }
}

const mintedPackage = new RegExp(String.raw`(\\(?:usepackage|RequirePackage)\p{White_Space}*\[)([^\]\r\n]*)(\]\p{White_Space}*\{minted\})`, 'gu')

/** Replaces minted's `frozencache` option, which fails without its cache, with `draft`. */
export function replacingFrozenMintedCacheOption(source: string): string {
  return source.replace(mintedPackage, (whole: string, _opening: string, options: string) => {
    const parts = options.split(',')
    const isFrozenCache = (option: string): boolean => trimmed(option).toLowerCase() === 'frozencache'
    if (!parts.some(isFrozenCache)) return whole
    return whole.replace(options, parts.map((option) => (isFrozenCache(option) ? 'draft' : option)).join(','))
  })
}

export async function enableDraftModeForFrozenMintedCaches(projectDirectory: string, signal?: AbortSignal): Promise<boolean> {
  let changed = false
  for (const file of await projectSourceFiles(projectDirectory, signal)) {
    const source = await readUTF8Source(file)
    if (source === undefined) continue
    const normalized = replacingFrozenMintedCacheOption(source)
    if (normalized === source) continue
    await atomicWriteFile(file, normalized)
    changed = true
  }
  return changed
}

const verbatimEnvironment = /\\begin\p{White_Space}*\{(minted\*?|lstlisting\*?|verbatim\*?)\}[\s\S]*?\\end\p{White_Space}*\{\1\}/gu

/**
 * The parser removes TeX comments before it finds protected environments, but a percent sign
 * inside `minted`, `lstlisting` or `verbatim` is data. It is replaced by a marker while the
 * project is parsed, and the marker is turned back into "%" in the reconstructed project.
 */
export class LiteralPercentPreservingLaTeXParser implements LaTeXProjectParsing {
  constructor(private readonly marker: string, private readonly base: LaTeXProjectParsing = new StructuredLaTeXParser()) {}

  async parse(project: PreparedProject, signal?: AbortSignal): Promise<ParsedLaTeXProject> {
    const snapshots: Array<{ path: string; source: string }> = []
    const restore = async (): Promise<void> => {
      for (const snapshot of snapshots) await atomicWriteFile(snapshot.path, snapshot.source)
    }
    try {
      for (const file of await projectSourceFiles(project.sourceDirectory, signal)) {
        const source = await readUTF8Source(file)
        if (source === undefined) continue
        const protectedSource = protectingLiteralPercents(source, this.marker)
        if (protectedSource === source) continue
        snapshots.push({ path: file, source })
        await atomicWriteFile(file, protectedSource)
      }
      const parsed = await this.base.parse(project, signal)
      await restore()
      return parsed
    } catch (error) {
      await restore().catch(() => undefined)
      throw error
    }
  }
}

export function protectingLiteralPercents(source: string, marker: string): string {
  if (!source.includes('%')) return source
  return source.replace(verbatimEnvironment, (environment) => environment.replaceAll('%', marker))
}

// MARK: Compilation

/** Runs latexmk from the chosen TeX installation, which also comes first on PATH for the engines it starts. */
export class ToolchainProcessRunner implements LaTeXProcessRunning {
  constructor(private readonly latexmkPath: string, private readonly runner: LaTeXProcessRunning = new NodeLaTeXProcessRunner()) {}

  run(request: LaTeXProcessRequest, signal?: AbortSignal): Promise<LaTeXProcessResult> {
    const args = request.arguments[0] === 'latexmk' ? request.arguments.slice(1) : request.arguments
    const environment = { ...(request.environment ?? process.env) }
    // Windows environment names are case-insensitive; reuse the existing spelling of Path.
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const existingPath = environment[pathKey] ?? ''
    const executableDirectory = dirname(this.latexmkPath)
    environment[pathKey] = existingPath ? `${executableDirectory}${delimiter}${existingPath}` : executableDirectory
    // Translated sources are untrusted: no shell escape, and paranoid file access.
    Object.assign(environment, { openin_any: 'p', openout_any: 'p', shell_escape: 'f' })
    return this.runner.run({ ...request, executable: this.latexmkPath, arguments: args, environment }, signal)
  }
}

/** Engines in native Freddie's order; the compiler moves XeLaTeX or LuaLaTeX first by language. */
export const compilerEngines = ['xelatex', 'pdflatex', 'lualatex'] as const

function logPriority(path: string): number {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  if (name === 'stderr.log') return 0
  if (name === 'stdout.log') return 2
  return extname(name) === '.log' ? 1 : 3
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

/** The most useful log of the last attempts: stderr, then the TeX log, then stdout, preferring nonempty ones. */
export async function preferredLogPath(attempts: CompilationAttempt[]): Promise<string | undefined> {
  const candidates = [...attempts].reverse().flatMap((attempt) => [...attempt.logPaths].sort((a, b) => logPriority(a) - logPriority(b)))
  for (const candidate of candidates) {
    if (((await fileSize(candidate)) ?? 0) > 0) return candidate
  }
  for (const candidate of candidates) {
    if ((await fileSize(candidate)) !== undefined) return candidate
  }
  return undefined
}

async function logsContain(attempts: CompilationAttempt[], byteLimit: number, test: (contents: string) => boolean): Promise<boolean> {
  for (const path of attempts.flatMap((attempt) => attempt.logPaths)) {
    try {
      const data = new Uint8Array(await readFile(path))
      if (data.length > byteLimit) continue
      const contents = decodeUTF8(data)
      if (contents !== undefined && test(contents)) return true
    } catch {
      // Unreadable logs say nothing.
    }
  }
  return false
}

export function indicatesMissingLatexmk(attempts: CompilationAttempt[]): Promise<boolean> {
  return logsContain(attempts, 64 * 1_024, (contents) => {
    const lowercased = contents.toLowerCase()
    return lowercased.includes('latexmk: no such file or directory') || lowercased.includes('latexmk: command not found')
  })
}

export function indicatesFrozenMintedCacheFailure(attempts: CompilationAttempt[]): Promise<boolean> {
  return logsContain(attempts, 2 * 1_024 * 1_024, (contents) => /Cannot\p{White_Space}+highlight\p{White_Space}+code\p{White_Space}*\(\p{White_Space}*frozencache\p{White_Space}*=\p{White_Space}*true\p{White_Space}*\)/iu.test(contents))
}

// MARK: Presentation

/** Localized messages for the kit's typed failures; other errors keep their own message. */
export function errorMessage(error: unknown, t: Translator): string {
  let description: string
  if (error instanceof ProjectPreparationError || error instanceof TarGzipArchiveReaderError || error instanceof ZipArchiveReaderError) {
    description = t('Could not prepare the arXiv LaTeX source.')
  } else if (error instanceof LaTeXParserError) {
    description = t('Could not parse the LaTeX source.')
  } else if (error instanceof TranslationRuntimeError) {
    description = t('The model returned an invalid LaTeX translation.')
  } else if (error instanceof ReconstructionError) {
    description = t('Could not reconstruct the translated LaTeX source.')
  } else if (error instanceof TranslationPipelineError) {
    switch (error.reason.kind) {
      case 'validationFailed': {
        const byUnit = new Map<string, Set<string>>()
        for (const issue of error.reason.issues.filter((item) => item.severity === 'error')) {
          byUnit.set(issue.unitID, (byUnit.get(issue.unitID) ?? new Set()).add(issue.code))
        }
        const affectedUnits = [...byUnit].map(([unitID, codes]) => {
          const list = [...codes].sort(compareStrings).join(', ')
          return list ? `${unitID} [${list}]` : unitID
        }).sort(compareStrings)
        description = affectedUnits.length
          ? t('The LaTeX translation failed structural validation: %@', affectedUnits.join('; '))
          : t('The LaTeX translation failed structural validation.')
        break
      }
      case 'invalidTranslationResponse':
        description = t('The model returned an invalid LaTeX translation.')
        break
      case 'missingCompiler':
        description = t('Could not compile the translated LaTeX source.')
        break
      case 'unsupportedSource':
      case 'invalidProject':
        description = t('Could not prepare the arXiv LaTeX source.')
        break
    }
  } else {
    return error instanceof Error ? error.message : String(error)
  }
  return t('Error: %@', description)
}

export interface LaTeXProgressUpdate {
  stage: PipelineStage
  completedUnits?: number
  totalUnits?: number
  fractionCompleted: number
}

/** Projects pipeline events onto one weighted progress fraction. */
export function progressUpdate(event: PipelineEvent): LaTeXProgressUpdate {
  const total = event.totalUnitCount
  const unitFraction = event.completedUnitCount !== undefined && total !== undefined && total > 0
    ? Math.min(Math.max(event.completedUnitCount / total, 0), 1)
    : 0
  const fractions: Record<PipelineStage, number> = {
    preparing: 0.03,
    parsing: 0.10,
    translating: 0.15 + 0.55 * unitFraction,
    validating: 0.74,
    reconstructing: 0.82,
    compiling: 0.92,
    finished: 1
  }
  return { stage: event.stage, completedUnits: event.completedUnitCount, totalUnits: event.totalUnitCount, fractionCompleted: fractions[event.stage] }
}

export function progressStatusMessage(stage: PipelineStage, t: Translator): string {
  switch (stage) {
    case 'preparing': return t('Preparing arXiv LaTeX source...')
    case 'parsing': return t('Parsing LaTeX source...')
    case 'translating': return t('Translating LaTeX source...')
    case 'validating': return t('Validating LaTeX translation...')
    case 'reconstructing': return t('Reconstructing translated LaTeX...')
    case 'compiling': return t('Compiling translated LaTeX...')
    case 'finished': return t('LaTeX translation completed.')
  }
}

/** Units that kept some or all source text; they are not checkpointed, so translating again retries them. */
export function incompleteUnitCount(issues: ValidationIssue[]): number {
  return new Set(issues.filter((issue) => issue.code === untranslatedUnitCode || issue.code === partiallyTranslatedUnitCode).map((issue) => issue.unitID)).size
}

// MARK: Service

export interface LaTeXTranslationRequest {
  paperDirectory: string
  arxivIdentifier: string
  targetLanguage: string
  maximumConcurrency: number
  glossary: string
  documentSummary?: string
  route: ResolvedRoute
}

export interface LaTeXTranslationOutput {
  artifact: TranslationArtifact
  pdfCompilationFailed: boolean
  failedCompilationAttempts: CompilationAttempt[]
}

export function kitTargetLanguage(code: string): TranslationLanguage {
  switch (code.toLowerCase()) {
    case 'en': return TranslationLanguages.english
    case 'ja': case 'ja-jp': return TranslationLanguages.japanese
    default: return TranslationLanguages.simplifiedChinese
  }
}

/** Cache identities live under `translations/latex/<target>/<identity>` in the paper folder, as in native Freddie. */
export function latexTranslationDirectory(paperDirectory: string, targetLanguage: string, cacheIdentity: string): string {
  return join(paperDirectory, 'translations', 'latex', safeComponent(targetLanguage, '-_', 'target'), sha256Hex(cacheIdentity).slice(0, 16))
}

export class LaTeXTranslationService {
  constructor(private readonly options: {
    t: Translator
    compiler?: LaTeXProjectCompiling
    acquirer?: ArXivProjectAcquiring
    client?: (route: ResolvedRoute) => LaTeXPromptCompleting
  }) {}

  /**
   * Translates the arXiv source and keeps the translated project even when it cannot be
   * compiled: the pipeline runs source-only, then the compiler is tried separately.
   */
  async translate(request: LaTeXTranslationRequest, onProgress: (update: LaTeXProgressUpdate) => void, signal?: AbortSignal): Promise<LaTeXTranslationOutput> {
    const { t, compiler } = this.options
    const glossary = normalizedGlossary(request.glossary)
    const cacheIdentity = [translationCacheIdentity(request.route), latexPromptVersion, request.targetLanguage, sha256Hex(glossary)].join('|')
    const workspace = latexTranslationDirectory(request.paperDirectory, request.targetLanguage, cacheIdentity)
    await mkdir(workspace, { recursive: true })
    const promptClient = this.options.client?.(request.route) ?? new FreddieLaTeXPromptClient(request.route, t)
    const translator = new PromptingLaTeXTranslator({
      client: promptClient,
      summarizer: new PromptLaTeXDocumentSummarizer(promptClient),
      checkpointStore: new FileLaTeXTranslationCheckpointStore(join(workspace, 'checkpoints.json'))
    })
    const preparer = new RoutedProjectPreparer({ arXiv: new ArXivProjectPreparer(this.options.acquirer ?? new FreddieArXivProjectAcquirer(t), new AutomaticTranslationArchiveReader()) })
    const literalPercentMarker = `READPAPERLITERALPERCENT${randomUUID().toUpperCase().replaceAll('-', '')}`
    const pipeline = new LaTeXTranslationPipeline({
      preparer,
      parser: new LiteralPercentPreservingLaTeXParser(literalPercentMarker),
      translator,
      validator: new StructuralLaTeXValidator(),
      reconstructor: new StructuredLaTeXReconstructor({ preamblePolicy: new EngineCompatibilityPreamblePolicy() })
    })
    const configuration = translationConfiguration({
      sourceLanguage: TranslationLanguages.english,
      targetLanguage: kitTargetLanguage(request.targetLanguage),
      maximumValidationRetries: 3,
      compilationPolicy: 'sourceOnly',
      validationFailurePolicy: 'fail',
      maximumConcurrentTranslations: Math.max(1, request.maximumConcurrency),
      previousContextUnitCount: 1,
      terminology: terminologyEntries(glossary),
      documentSummary: request.documentSummary === undefined ? undefined : trimmed(request.documentSummary)
    })
    const artifact = await pipeline.run({ source: { kind: 'arxiv', identifier: request.arxivIdentifier }, workspaceDirectory: workspace, configuration }, (event) => {
      if (event.stage !== 'finished') onProgress(progressUpdate(event))
    }, signal)
    await normalizeProject(artifact.projectDirectory, literalPercentMarker, signal)

    const finished = (output: LaTeXTranslationOutput): LaTeXTranslationOutput => {
      onProgress(progressUpdate({ stage: 'finished' }))
      return output
    }
    if (!compiler) return finished({ artifact, pdfCompilationFailed: false, failedCompilationAttempts: [] })

    onProgress(progressUpdate({ stage: 'compiling' }))
    const compiled = (compilation: Awaited<ReturnType<LaTeXProjectCompiling['compile']>>): LaTeXTranslationOutput => finished({
      artifact: { ...artifact, pdfPath: compilation.pdfPath, compilation },
      pdfCompilationFailed: false,
      failedCompilationAttempts: []
    })
    try {
      return compiled(await compiler.compile(artifact.projectDirectory, configuration, signal))
    } catch (error) {
      if (isCancellation(error, signal)) throw error
      if (!(error instanceof LaTeXCompilationError) || error.reason.kind !== 'allAttemptsFailed') {
        return finished({ artifact, pdfCompilationFailed: true, failedCompilationAttempts: [] })
      }
      const attempts = error.reason.attempts
      // A project that ships a frozen minted cache without the cache compiles in draft mode instead.
      if (await indicatesFrozenMintedCacheFailure(attempts) && await enableDraftModeForFrozenMintedCaches(artifact.projectDirectory, signal).catch(() => false)) {
        try {
          return compiled(await compiler.compile(artifact.projectDirectory, configuration, signal))
        } catch (retryError) {
          if (isCancellation(retryError, signal)) throw retryError
          if (retryError instanceof LaTeXCompilationError && retryError.reason.kind === 'allAttemptsFailed') {
            return finished({ artifact, pdfCompilationFailed: true, failedCompilationAttempts: [...attempts, ...retryError.reason.attempts] })
          }
        }
      }
      return finished({ artifact, pdfCompilationFailed: true, failedCompilationAttempts: attempts })
    }
  }
}

// MARK: Freddie

const relativeFilename = (root: string, path: string): string => relative(root, path).split(sep).join('/')

/**
 * Translates a paper's arXiv LaTeX source. The translated project is recorded as the paper's
 * LaTeX source resource even when it cannot be compiled; a compiled PDF becomes its translated
 * PDF. Checkpoints are keyed like native Freddie's, so a library imported from it resumes its runs.
 */
export async function runLatexTranslation(options: {
  paperId: string
  store: FreddieStore
  secrets: SecretStore
  latexmkPath: string
  signal: AbortSignal
  emit: (event: TranslationEvent) => void
  t: Translator
}): Promise<void> {
  const { paperId, store, secrets, latexmkPath, signal, emit, t } = options
  const paper = store.paper(paperId)
  if (!paper.arxivId) throw new Error(t('This paper has no arXiv source identifier.'))
  emit({ paperId, kind: 'latex', type: 'status', message: t('Preparing arXiv LaTeX source...') })
  const route = await resolveRoute('pdf', store, secrets, t)
  const settings = store.database.settings
  const paperDirectory = store.paperDirectory(paperId)
  const service = new LaTeXTranslationService({
    t,
    compiler: new LaTeXCompiler({ runner: new ToolchainProcessRunner(latexmkPath), engines: [...compilerEngines] })
  })

  let output: LaTeXTranslationOutput
  try {
    output = await service.translate({
      paperDirectory,
      arxivIdentifier: resolvingArxivIdentifier(paper.arxivId, paper.arxivVersion),
      targetLanguage: settings.targetLanguage,
      maximumConcurrency: settings.htmlTranslationConcurrency,
      glossary: settings.translationGlossary,
      documentSummary: paper.abstract,
      route
    }, (update) => {
      const summary = update.completedUnits !== undefined && update.totalUnits !== undefined && update.totalUnits > 0
        ? `${update.completedUnits}/${update.totalUnits}`
        : `${Math.round(update.fractionCompleted * 100)}%`
      emit({ paperId, kind: 'latex', type: 'progress', completed: update.fractionCompleted, total: 1, summary, message: progressStatusMessage(update.stage, t) })
    }, signal)
  } catch (error) {
    if (isCancellation(error, signal)) throw error
    throw new Error(errorMessage(error, t), { cause: error })
  }
  signal.throwIfAborted()

  const now = new Date().toISOString()
  const latest = (kind: Attachment['kind']): Attachment | undefined => store.attachments(paperId)
    .filter((item) => item.kind === kind && item.source === 'latexTrans')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const record = async (kind: Attachment['kind'], path: string): Promise<void> => {
    const filename = relativeFilename(paperDirectory, path)
    const existing = latest(kind)
    if (existing) await store.updateAttachment(paperId, existing.id, { filename, translatedLastPage: undefined, createdAt: now })
    else await store.addAttachment({ id: randomUUID(), paperId, kind, source: 'latexTrans', filename, createdAt: now })
  }
  const { artifact } = output
  await store.batch(async () => {
    await record('resource', artifact.projectDirectory)
    if (artifact.pdfPath) await record('translatedPDF', artifact.pdfPath)
  })

  const incompleteUnits = incompleteUnitCount(artifact.validationIssues)
  const incompleteMessage = incompleteUnits > 0
    ? t('LaTeX translation completed, but %lld units kept source text because the model returned invalid output. Translate again to retry them.', incompleteUnits)
    : undefined
  if (output.pdfCompilationFailed) {
    const message = await indicatesMissingLatexmk(output.failedCompilationAttempts)
      ? t('LaTeX source translation completed, but PDF compilation requires a TeX distribution that includes latexmk.')
      : t('LaTeX source translation completed, but PDF compilation failed.')
    emit({ paperId, kind: 'latex', type: 'failed', message, logPath: await preferredLogPath(output.failedCompilationAttempts) })
    return
  }
  emit({ paperId, kind: 'latex', type: 'finished', message: incompleteMessage ?? t('LaTeX translation completed.') })
}

/** The newest translated LaTeX project of a paper, to show in the file manager. */
export function latestLatexSourcePath(store: FreddieStore, paperId: string): string | undefined {
  const attachment = store.attachments(paperId)
    .filter((item) => item.kind === 'resource' && item.source === 'latexTrans')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return attachment ? store.attachmentPath(paperId, attachment.id) : undefined
}
